import assert from "node:assert/strict";
import test from "node:test";
import {
	endsWithSyncEnd,
	installImeCursorCoalesce,
	isPureCursorParking,
	mergeIntoSyncBlock,
	wrapTerminalWrites,
} from "../src/core/ime-cursor-coalesce.mjs";

const ESC = String.fromCharCode(27);
const SYNC_BEGIN = ESC + "[?2026h";
const SYNC_END = ESC + "[?2026l";
const HIDE = ESC + "[?25l";
const SHOW = ESC + "[?25h";

/** The exact frame shape pi-tui's doRender() produces for a rendered frame. */
function piTuiFrameWrites(content) {
	return [
		SYNC_BEGIN + content + SYNC_END, // diff write
		ESC + "[37B" + ESC + "[8G", // positionHardwareCursor park
	];
	// third write (?25l) goes through hideCursor(), not write()
}

function makeFakeTerminal() {
	const writes = [];
	return {
		writes,
		write(data) {
			writes.push(data);
		},
		hideCursor() {
			writes.push(HIDE);
		},
		showCursor() {
			writes.push(SHOW);
		},
	};
}

const tick = () => new Promise((resolve) => process.nextTick(resolve));

test("endsWithSyncEnd matches frame writes and nothing else", () => {
	assert.equal(endsWithSyncEnd(SYNC_BEGIN + "x" + SYNC_END), true);
	assert.equal(endsWithSyncEnd(SYNC_END), true);
	// sync-end in the middle (two blocks in one write) is NOT held
	assert.equal(endsWithSyncEnd(SYNC_BEGIN + "a" + SYNC_END + SYNC_BEGIN + "b"), false);
	assert.equal(endsWithSyncEnd("plain"), false);
	assert.equal(endsWithSyncEnd(undefined), false);
});

test("isPureCursorParking accepts only park/hide sequences", () => {
	assert.equal(isPureCursorParking(ESC + "[37B" + ESC + "[8G"), true);
	assert.equal(isPureCursorParking(ESC + "[5A"), true);
	assert.equal(isPureCursorParking(ESC + "[1G"), true);
	assert.equal(isPureCursorParking(ESC + "[B"), true); // default n=1
	assert.equal(isPureCursorParking(HIDE), true);
	assert.equal(isPureCursorParking(SHOW), true);
	assert.equal(isPureCursorParking(ESC + "[8G" + HIDE), true);
	// anything else must flush, never merge
	assert.equal(isPureCursorParking(ESC + "[2K"), false); // line clear
	assert.equal(isPureCursorParking(ESC + "[10;5H"), false); // absolute position
	assert.equal(isPureCursorParking(ESC + "]52;c;AAA" + ESC + "\\"), false); // OSC52
	assert.equal(isPureCursorParking("content"), false);
	assert.equal(isPureCursorParking(""), false);
});

test("mergeIntoSyncBlock inserts seq before the trailing sync end", () => {
	const frame = SYNC_BEGIN + "hello" + SYNC_END;
	assert.deepEqual(mergeIntoSyncBlock(frame, ESC + "[8G"), SYNC_BEGIN + "hello" + ESC + "[8G" + SYNC_END);
});

test("wrapTerminalWrites folds a full pi-tui frame burst into one write", async () => {
	const terminal = makeFakeTerminal();
	const uninstall = wrapTerminalWrites(terminal);
	const [diff, park] = piTuiFrameWrites("frame-content");
	terminal.write(diff);
	terminal.write(park);
	terminal.hideCursor();
	await tick();

	// One write, byte order preserved, park+hide INSIDE the sync block.
	assert.equal(terminal.writes.length, 1);
	assert.deepEqual(terminal.writes[0], SYNC_BEGIN + "frame-content" + park + HIDE + SYNC_END);
	uninstall();
});

test("row-only park (rowDelta 0, no A/B) still merges", async () => {
	const terminal = makeFakeTerminal();
	const uninstall = wrapTerminalWrites(terminal);
	terminal.write(SYNC_BEGIN + "x" + SYNC_END);
	terminal.write(ESC + "[13G"); // only column set
	terminal.hideCursor();
	await tick();
	assert.equal(terminal.writes.length, 1);
	assert.deepEqual(terminal.writes[0], SYNC_BEGIN + "x" + ESC + "[13G" + HIDE + SYNC_END);
	uninstall();
});

test("frame without park write flushes unchanged (cursorPos null path)", async () => {
	const terminal = makeFakeTerminal();
	const uninstall = wrapTerminalWrites(terminal);
	const diff = SYNC_BEGIN + "no-marker" + SYNC_END;
	terminal.write(diff);
	terminal.hideCursor(); // positionHardwareCursor(null) only hides
	await tick();
	assert.equal(terminal.writes.length, 1);
	// hide folds into the held frame's block (mode set before frame end — equivalent)
	assert.deepEqual(terminal.writes[0], SYNC_BEGIN + "no-marker" + HIDE + SYNC_END);
	uninstall();
});

test("non-parking write between frame and park flushes frame unchanged (passthrough)", async () => {
	const terminal = makeFakeTerminal();
	const uninstall = wrapTerminalWrites(terminal);
	const diff = SYNC_BEGIN + "x" + SYNC_END;
	const other = ESC + "]11;?" + String.fromCharCode(7); // e.g. an OSC query
	terminal.write(diff);
	terminal.write(other); // not a park burst -> flush first, then emit
	terminal.write(ESC + "[8G"); // nothing held anymore -> plain passthrough
	await tick();
	assert.deepEqual(terminal.writes, [diff, other, ESC + "[8G"]);
	uninstall();
});

test("hide/showCursor pass through when no frame is held", () => {
	const terminal = makeFakeTerminal();
	const uninstall = wrapTerminalWrites(terminal);
	terminal.hideCursor();
	terminal.showCursor();
	assert.deepEqual(terminal.writes, [HIDE, SHOW]);
	uninstall();
});

test("uninstall flushes pending frame and restores original methods", async () => {
	const terminal = makeFakeTerminal();
	const uninstall = wrapTerminalWrites(terminal);
	const diff = SYNC_BEGIN + "held" + SYNC_END;
	terminal.write(diff);
	uninstall(); // must flush the held frame unwrapped
	assert.deepEqual(terminal.writes, [diff]);

	terminal.write("after");
	terminal.hideCursor();
	assert.deepEqual(terminal.writes, [diff, "after", HIDE]);

	// idempotent
	uninstall();
	assert.deepEqual(terminal.writes, [diff, "after", HIDE]);
});

test("overlapping installs share one wrapper; teardown only at the last uninstall", async () => {
	const terminal = makeFakeTerminal();
	const uninstallA = wrapTerminalWrites(terminal);
	const uninstallB = wrapTerminalWrites(terminal);
	const [diff, park] = piTuiFrameWrites("frame");
	terminal.write(diff);
	terminal.write(park);
	terminal.hideCursor();
	uninstallA(); // one caller gone; the OTHER handle must keep the patch alive
	await tick();
	// CR round 1 issue-1 regression: coalescing must survive a partial uninstall.
	assert.deepEqual(terminal.writes, [SYNC_BEGIN + "frame" + park + HIDE + SYNC_END]);

	// second burst still coalesces while B holds the patch
	terminal.write(diff);
	terminal.write(park);
	terminal.hideCursor();
	await tick();
	assert.equal(terminal.writes.length, 2);
	assert.deepEqual(terminal.writes[1], SYNC_BEGIN + "frame" + park + HIDE + SYNC_END);

	uninstallB(); // last handle -> teardown
	terminal.write(SYNC_BEGIN + "raw" + SYNC_END);
	assert.deepEqual(terminal.writes.slice(-1), [SYNC_BEGIN + "raw" + SYNC_END]);

	// both handles stay idempotent after teardown
	uninstallA();
	uninstallB();
	terminal.hideCursor();
	assert.deepEqual(terminal.writes.slice(-2), [SYNC_BEGIN + "raw" + SYNC_END, HIDE]);
});

test("empty and non-string writes pass straight through", () => {
	const terminal = makeFakeTerminal();
	const uninstall = wrapTerminalWrites(terminal);
	terminal.write("");
	terminal.write(undefined);
	assert.deepEqual(terminal.writes, ["", undefined]);
	uninstall();
});

test("installImeCursorCoalesce returns null on bad shapes and honors the kill switch", () => {
	assert.equal(installImeCursorCoalesce({ terminal: null }), null);
	assert.equal(installImeCursorCoalesce({ terminal: { write() {} } }), null); // no hideCursor
	assert.equal(installImeCursorCoalesce(null), null);

	const good = { terminal: makeFakeTerminal() };
	const prev = process.env.AGENT_BOARD_IME_FIX;
	process.env.AGENT_BOARD_IME_FIX = "0";
	try {
		assert.equal(installImeCursorCoalesce(good), null);
	} finally {
		if (prev === undefined) delete process.env.AGENT_BOARD_IME_FIX;
		else process.env.AGENT_BOARD_IME_FIX = prev;
	}
	const uninstall = installImeCursorCoalesce(good);
	assert.equal(typeof uninstall, "function");
	uninstall();
});
