import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-frame-overflow-scenario.ts");

// Production topology (issue #205, A4–A7): a real runner snapshot whose 65-row
// frame is taller than the attach's 38-row body. Hydrating that frame scrolls 27
// rows into the attach-local xterm, which the old wheel spent 27 notches on
// before forwarding. The floor (baseY minus the runner-vouched scrollback count)
// is what makes the first notch reach the hosted session — and the reason the
// frame must be served unchanged: a runner that re-captured at the attach size
// would collapse `attachBaseY === 27` and the topology pin with it.
test("a snapshot frame taller than the attach viewport forwards the first wheel notch", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 90_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.runnerScrollback, 0, "topology pin: the runner snapshot carries no scrollback");
	assert.equal(parsed.attachBaseY, 27, "topology pin: a 65-row frame in a 38-row terminal scrolls 27 rows");
	assert.equal(parsed.historyFloor, 27);
	assert.equal(parsed.bodyHeight, 38);
	assert.equal(parsed.bottomViewportTop, 27);
	assert.equal(parsed.scrollableHistoryLines, 0);
	assert.equal(parsed.firstForwardAt, 1, "the first notch must reach the child");
	assert.equal(parsed.firstForwardData, "\x1b[<64;4;3M");
	assert.equal(parsed.viewportTop, null, "follow-bottom is preserved");
	assert.equal(parsed.realHistoryCase.scrollable, 0, "overflowing hydration disables local history rather than skipping rows");
	assert.equal(parsed.realHistoryCase.firstForwardAt, 1, "the wheel forwards instead of traversing manufactured rows");
	assert.equal(parsed.resetCase.historyFloor, 0, "empty/resnapshot resets the floor");
	assert.equal(parsed.resetCase.baseY, 0, "the empty baseline really cleared the buffer");
	assert.equal(parsed.resizeCase.historyFloor, parsed.resizeCase.baseY, "resize re-bases the floor on the new baseY");
	assert.equal(parsed.resizeCase.scrollableHistoryLines, 0);
	assert.equal(
		parsed.missingFieldCase.historyFloor,
		parsed.missingFieldCase.attachBaseY,
		"a runner without scrollbackLines disables local history instead of NaN",
	);
	assert.equal(parsed.missingFieldCase.firstForwardAt, 1);
	assert.ok(parsed.tuiDispatch.overlayLayouts >= 1, "the attach overlay must be laid out full-screen");
	assert.ok(parsed.tuiDispatch.handleMouseCalls >= 1, "the wheel must reach the overlay component through the real dispatcher");
	assert.equal(parsed.tuiDispatch.firstForwardAt, 1);
});
