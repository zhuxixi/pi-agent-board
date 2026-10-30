import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen } from "@earendil-works/pi-tui/dist/tui-alt-screen.js";
import { AttachPresentationObserver, asTerminal, validateAttachPresentation } from "../test-support/attach-presentation-fixture.ts";

// Issue #222 steps 12+13 (spec A10): capture contract of the independent
// terminal presentation observer. Step 12 is the replaceable Terminal and its
// metadata record; step 13 is the synchronized/ordinary visibility boundary
// semantics. The observer replaces `Terminal` for the REAL pi-tui
// Tui/TuiAltScreen, forwards every Terminal.write byte unchanged and in order
// into an independent @xterm/headless terminal, and snapshots the grid/cursor
// at synchronized-update (`?2026h`/`?2026l`) closing boundaries — inside the
// public parser CSI hook, before later bytes can overwrite the frame.
//
// The observer tests at the top of this file pin the capture surface only and
// guarantee the recorded frames keep enough immutable, append-only truth for
// an oracle. The step-14 battery appended at the end consumes that history
// with independently specified screens (loading→target pass; injected
// old-log, mismatched-frame-ID, blank and extra-cursor states failing).

const OPEN = "\x1b[?2026h";
const CLOSE = "\x1b[?2026l";

function makeObserver(opts = {}) {
	const observer = new AttachPresentationObserver({ cols: 40, rows: 10, ...opts });
	return observer;
}

async function feed(observer, chunks) {
	for (const chunk of chunks) observer.write(chunk);
	await observer.whenIdle();
}

function frames(observer) {
	return observer.observations.filter((o) => o.kind === "frame");
}

function kinds(observer) {
	return observer.observations.map((o) => o.kind);
}

async function waitFor(predicate, timeoutMs, label) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for: ${label}`);
}

test("observer records raw writes unchanged, in order, with monotonic receipt times", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	const chunks = ["abc", OPEN, "x", CLOSE];
	await feed(observer, chunks);
	assert.deepEqual(observer.writes.map((w) => w.data), chunks, "every write must be kept byte-exact and in receipt order");
	assert.deepEqual(observer.writes.map((w) => w.index), [0, 1, 2, 3]);
	for (let i = 1; i < observer.writes.length; i++) {
		assert.ok(observer.writes[i].receivedAt >= observer.writes[i - 1].receivedAt, "receipt times must be monotonic non-decreasing");
	}
});

test("observer assembles a synchronized block spanning multiple writes into one frame", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, [OPEN, "\x1b[Hline one\r\n", "line two", CLOSE]);
	const seen = frames(observer);
	assert.equal(seen.length, 1, "one open/close pair must yield exactly one frame, however many writes it spanned");
	assert.equal(seen[0].openWriteIndex, 0);
	assert.equal(seen[0].closeWriteIndex, 3);
	assert.equal(seen[0].grid[0].text, "line one");
	assert.equal(seen[0].grid[1].text, "line two");
	// Exact window contract: the bare OPEN leaves a conservative entry window
	// (the pre-block visible state) and the bare CLOSE leaves a write-end
	// window; the frame sits between them in stream order.
	assert.deepEqual(kinds(observer), ["unframed", "frame", "unframed"]);
});

test("observer preserves an unframed prefix before OPEN at the entry boundary", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	// Parent counterexample: one write carrying visible unframed bytes ahead of
	// the block, then a block that erases them. Without an entry-boundary copy
	// the prefix vanishes from every observation (false negative for old-log
	// oracles).
	await feed(observer, [`OLD_LOG${OPEN}\x1b[2J\x1b[HGOOD${CLOSE}`]);
	const seen = frames(observer);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].grid[0].text, "GOOD");
	const entryWindows = observer.observations.filter((o) => o.kind === "unframed" && o.note === "sync-entry");
	assert.equal(entryWindows.length, 1, "an outside→inside open transition must snapshot the last pre-block visible state");
	assert.equal(entryWindows[0].grid[0].text, "OLD_LOG", "bytes parsed before OPEN could be visible and must survive the block's later erase");
});

test("observer never advertises an unfinished synchronized block as visible", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, [`${OPEN}\x1b[HCOMPLETE${CLOSE}`]);
	await feed(observer, [`${OPEN}\x1b[HUPPER_ONLY`]);
	const allText = observer.observations.flatMap((o) => o.grid.map((r) => r.text));
	assert.ok(
		allText.every((text) => !text.includes("UPPER_ONLY")),
		"bytes inside an unclosed block must not appear in any observation (they are not yet a visible state)",
	);
	const last = observer.observations[observer.observations.length - 1];
	assert.equal(last.kind, "unframed");
	assert.equal(last.grid[0].text, "COMPLETE", "the newest observation stays the last completed state");
});

test("observer keeps the completed state when one write closes a block and opens a partial next one", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, [OPEN, "\x1b[H1111", `${CLOSE}${OPEN}\x1b[H2222`]);
	const seen = frames(observer);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].grid[0].text, "1111");
	const allText = observer.observations.flatMap((o) => o.grid.map((r) => r.text));
	assert.ok(allText.every((text) => !text.includes("2222")), "partial bytes of the next block are not a visible observation");
	const last = observer.observations[observer.observations.length - 1];
	assert.equal(last.grid[0].text, "1111", "the completed frame stays the newest observable state");
});

test("observer closes a frame whose CSI delimiter is split across writes", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, [OPEN, "\x1b[HAAA", "\x1b[?20", "26l"]);
	const seen = frames(observer);
	assert.equal(seen.length, 1, "a delimiter split across writes must still close the frame exactly once");
	assert.equal(seen[0].openWriteIndex, 0);
	assert.equal(seen[0].closeWriteIndex, 3, "the close is attributed to the write that delivered the final byte");
	assert.equal(seen[0].grid[0].text, "AAA");
});

test("observer keeps two complete synchronized blocks in one write as two ordered frames", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	// Both blocks rewrite the same cell: the first frame's snapshot must already
	// be taken when the second block's bytes land, or it would read "BBBB".
	await feed(observer, [`${OPEN}\x1b[HAAAA${CLOSE}${OPEN}\x1b[HBBBB${CLOSE}`]);
	const seen = frames(observer);
	assert.equal(seen.length, 2, "two complete blocks in one write are two frames, never one merged frame");
	assert.equal(seen[0].openWriteIndex, 0);
	assert.equal(seen[0].closeWriteIndex, 0);
	assert.equal(seen[1].openWriteIndex, 0);
	assert.equal(seen[1].closeWriteIndex, 0);
	assert.equal(seen[0].grid[0].text, "AAAA", "the closing boundary must snapshot before later bytes overwrite the grid");
	assert.equal(seen[1].grid[0].text, "BBBB");
});

test("observer treats close-then-open within one write as separate frame boundaries", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, [OPEN, "\x1b[H1111", `${CLOSE}${OPEN}`, "\x1b[5;1H2222", CLOSE]);
	const seen = frames(observer);
	assert.equal(seen.length, 2, "a close immediately followed by an open in one write still ends the old frame and starts a new one");
	assert.equal(seen[0].openWriteIndex, 0);
	assert.equal(seen[0].closeWriteIndex, 2);
	assert.equal(seen[0].grid[0].text, "1111");
	assert.equal(seen[1].openWriteIndex, 2);
	assert.equal(seen[1].closeWriteIndex, 4);
	assert.equal(seen[1].grid[0].text, "1111", "the second frame inherits rows the new block did not touch");
	assert.equal(seen[1].grid[4].text, "2222");
});

test("observer retains unframed writes before, around, and after synchronized blocks", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, ["before\r\n", `${OPEN}\x1b[3;1Hinside${CLOSE}after`, "tail"]);
	const seen = frames(observer);
	assert.equal(seen.length, 1);
	const windows = observer.observations.filter((o) => o.kind === "unframed");
	assert.equal(windows.length, 4, "each write with time outside a block leaves one potential-visibility window, and each block entry adds one conservative pre-block window");
	assert.equal(windows[0].grid[0].text, "before", "content before the first block must stay observable");
	assert.equal(windows[1].grid[0].text, "before", "the block entry snapshots the last pre-block visible state");
	assert.equal(windows[1].note, "sync-entry", "the conservative entry window is explicitly identified");
	assert.equal(seen[0].grid[2].text, "inside", "the frame itself shows only block content");
	assert.equal(windows[2].grid[2].text, "insideafter", "bytes after a close in the same write are unframed, not part of the frame");
	assert.equal(windows[3].grid[2].text, "insideaftertail", "ordinary unframed writes after the block stay observable");
	assert.deepEqual(kinds(observer), ["unframed", "unframed", "frame", "unframed", "unframed"]);
});

test("observer captures immutable cells, attributes, and cursor at the closing boundary", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, [`${OPEN}\x1b[2;5H\x1b[7mX\x1b[0m\x1b[?25l${CLOSE}`]);
	const seen = frames(observer);
	assert.equal(seen.length, 1);
	const frame = seen[0];
	assert.equal(frame.grid[1].cells[4].chars, "X");
	assert.ok(frame.grid[1].cells[4].inverse, "inverse-video cells are recorded as raw attribute data (never as a cursor verdict)");
	assert.deepEqual(
		{ x: frame.cursor.x, y: frame.cursor.y, absoluteY: frame.cursor.absoluteY, visible: frame.cursor.visible },
		{ x: 5, y: 1, absoluteY: 1, visible: false },
		"cursor position (viewport-relative and absolute) and DECTCEM visibility at the boundary",
	);
	assert.ok(Object.isFrozen(frame) && Object.isFrozen(frame.grid) && Object.isFrozen(frame.grid[1].cells), "frames are immutable");
	// A later frame overwriting the same cell must not mutate the earlier record.
	await feed(observer, [`${OPEN}\x1b[2;5HY${CLOSE}`]);
	assert.equal(frame.grid[1].cells[4].chars, "X", "later writes can never rewrite an earlier frame's snapshot");
	assert.equal(frames(observer)[1].grid[1].cells[4].chars, "Y");
});

test("observer applies hideCursor/showCursor in stream order without rewriting queued frames", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	// ProcessTerminal.hideCursor/showCursor emit DECTCEM sequences
	// (terminal.js:440-445) and the real TUI calls them around frames
	// (tui.js:487/565/612), so the observer must reproduce that effect —
	// ordered with pending writes, identified as control-derived, and never
	// retroactively applied to an earlier queued frame.
	observer.write(`${OPEN}\x1b[Hframe0${CLOSE}`);
	observer.hideCursor(); // queued behind frame0's write: cannot reach back into it
	observer.write(`${OPEN}\x1b[Hframe1${CLOSE}`);
	observer.showCursor();
	observer.write(`${OPEN}\x1b[Hframe2${CLOSE}`);
	await observer.whenIdle();
	const seen = frames(observer);
	assert.equal(seen.length, 3);
	assert.equal(seen[0].cursor.visible, true, "a control queued after a write must not mutate that write's frame");
	assert.equal(seen[1].cursor.visible, false, "hideCursor reproduces the DECTCEM reset in stream order");
	assert.equal(seen[2].cursor.visible, true, "showCursor restores visibility in stream order");
	const hide = observer.controls.find((c) => c.method === "hideCursor");
	assert.equal(hide?.emitted, "\x1b[?25l", "control-derived bytes are identified as controls, not caller writes");
	assert.deepEqual(
		observer.writes.map((w) => w.data),
		[`${OPEN}\x1b[Hframe0${CLOSE}`, `${OPEN}\x1b[Hframe1${CLOSE}`, `${OPEN}\x1b[Hframe2${CLOSE}`],
		"caller writes keep their exact bytes and order; control injections never masquerade as caller writes",
	);
});

test("observer never invents frame identity for unmatched or duplicate boundaries", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, [CLOSE]);
	assert.equal(frames(observer).length, 0, "a close without an open is an idempotent reset, not a committed frame");
	let windows = observer.observations.filter((o) => o.kind === "unframed");
	assert.equal(windows.length, 1);
	assert.equal(windows[0].note, "unmatched-close", "the unmatched close is identified as an unframed effect");
	await feed(observer, [`${OPEN}\x1b[HX${CLOSE}`, CLOSE]);
	assert.equal(frames(observer).length, 1, "a duplicate close after a matched block adds no frame");
	windows = observer.observations.filter((o) => o.kind === "unframed");
	assert.equal(windows[windows.length - 1].note, "unmatched-close");
	await feed(observer, [OPEN, "\x1b[3;1HA", OPEN, "B", CLOSE]);
	const seen = frames(observer);
	assert.equal(seen.length, 2);
	assert.equal(seen[1].openWriteIndex, 3, "a repeated OPEN is a mode set; the frame keeps its original opening identity");
	assert.equal(seen[1].closeWriteIndex, 7);
	assert.equal(seen[1].grid[2].text, "AB");
});

test("observer honors every decoded private-mode parameter in parameter order", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	// xterm applies ALL parameters of a private-mode set/reset; the observer
	// must see 2026 and 25 wherever they appear in the parameter list. DECSET
	// ?25h shows the cursor, DECRST ?25l hides it, so parameter order decides
	// whether a visibility change applies before or after a close boundary.
	await feed(observer, ["\x1b[?25;2026hGOOD\x1b[?25;2026l"]);
	const seen = frames(observer);
	assert.equal(seen.length, 1, "a block opened/closed via multi-parameter private modes is still a frame");
	assert.equal(seen[0].grid[0].text, "GOOD");
	assert.equal(seen[0].cursor.visible, false, "the hide-cursor reset precedes the close parameter and applies at the boundary");
	await feed(observer, ["\x1b[?25h", `\x1b[?2026hBLAH\x1b[?2026;25l`, `${OPEN}\x1b[HNEXT${CLOSE}`]);
	const all = frames(observer);
	assert.equal(all.length, 3);
	assert.equal(all[1].cursor.visible, true, "when the close parameter precedes the hide-cursor reset, the boundary keeps the previous visibility");
	assert.equal(all[2].cursor.visible, false, "the trailing hide-cursor reset still takes effect after the boundary");
});

test("observer preserves default parsing behavior behind its observational handlers", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	// SGR bold+inverse, SGR reset and CUP all flow through the SAME CSI channel
	// the observer hooks; if the hook swallowed defaults these would not apply.
	await feed(observer, [`${OPEN}\x1b[1m\x1b[7mB\x1b[0m\x1b[3;10H${CLOSE}`]);
	const seen = frames(observer);
	assert.equal(seen.length, 1);
	const cell = seen[0].grid[0].cells[0];
	assert.equal(cell.chars, "B");
	assert.ok(cell.bold, "SGR bold must still apply (default handler ran after the observer returned false)");
	assert.ok(cell.inverse, "SGR inverse must still apply");
	assert.equal(seen[0].cursor.x, 9, "CUP must still position the cursor (1-based 3;10 → 0-based row 2 col 9)");
	assert.equal(seen[0].cursor.y, 2);
	assert.equal(seen[0].cursor.visible, true, "cursor visibility defaults to visible when no DECTCEM reset was observed");
});

test("observer never lets a later good frame erase or mutate an earlier anomalous one", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	// A blank frame (an anomaly a step-14 oracle must flag) followed by a good
	// frame: the anomalous record must survive intact and append-only.
	await feed(observer, [`${OPEN}${CLOSE}`]);
	assert.equal(frames(observer).length, 1);
	const blankBefore = JSON.stringify(frames(observer)[0]);
	await feed(observer, [`${OPEN}\x1b[HGOOD${CLOSE}`]);
	const seen = frames(observer);
	assert.equal(seen.length, 2, "frames are append-only; a good frame cannot replace an earlier one");
	assert.equal(seen[0].grid[0].text, "", "the blank frame stays on record as blank");
	assert.equal(JSON.stringify(seen[0]), blankBefore, "the earlier frame record is byte-identical after later writes");
	assert.equal(seen[1].grid[0].text, "GOOD");
});

test("observer watches the REAL TuiAltScreen scheduling through the replaceable terminal", async (t) => {
	const observer = makeObserver({ cols: 40, rows: 10 });
	// asTerminal is the fixture's compile-time pi-tui Terminal conformance guard.
	const tui = new TuiAltScreen(asTerminal(observer), false, undefined, {});
	t.after(() => {
		try {
			tui.stop();
		} catch {
			/* best-effort teardown */
		}
		observer.dispose();
	});
	const component = {
		render: (width) => [`hello observer ${width}`],
		invalidate() {},
	};
	tui.setLayoutRoot(component);
	// start() drives the real pipeline: beforeTerminalStart writes (unframed),
	// then requestRender → nextTick → render timer → doRender → terminal.write.
	// No requestRender shim and no component.render() call is involved here.
	tui.start();
	await waitFor(() => frames(observer).length >= 1, 3000, "first frame from real TUI scheduling");
	const firstFrames = frames(observer);
	assert.equal(firstFrames[0].openWriteIndex, firstFrames[0].closeWriteIndex, "the real TUI emits each frame as one atomic synchronized write");
	assert.ok(
		firstFrames.some((f) => f.grid.some((row) => row.text.includes("hello observer 40"))),
		"the component's real rendered line must appear in an observed frame",
	);
	const firstWindow = observer.observations[0];
	assert.equal(firstWindow.kind, "unframed", "the alt-screen enter bytes precede the first frame as an unframed observation");
	const snapshotBefore = JSON.stringify(firstFrames[0]);
	// A second natural scheduling cycle appends a frame and leaves history intact.
	tui.requestRender();
	await waitFor(() => frames(observer).length >= 2, 3000, "second frame after requestRender()");
	assert.ok(frames(observer).length >= 2);
	assert.equal(JSON.stringify(frames(observer)[0]), snapshotBefore, "re-renders append; they never rewrite observed history");
	for (let i = 1; i < observer.writes.length; i++) {
		assert.ok(observer.writes[i].receivedAt >= observer.writes[i - 1].receivedAt, "receipt times stay monotonic across real scheduling");
	}
});

// ---------------------------------------------------------------------------
// Issue #222 step 14 (spec A10): independent presentation-oracle battery.
//
// Controlled child screens are fed through the REAL observer above; the
// captured history is then compared with expected complete screens defined
// literally in this file (row text, frame/source IDs, cursor coordinates and
// visibility, and inverse-video cell attributes). The expected grids are never
// derived from the captured bytes and no candidate readiness flag is read.
// ---------------------------------------------------------------------------

const STEP14_SCREEN_ROWS = 10;
const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const cup = (x, y) => `\x1b[${y + 1};${x + 1}H`;

function padRows(rows) {
	return Array.from({ length: STEP14_SCREEN_ROWS }, (_, y) => rows[y] ?? "");
}

/** Render one complete screen with absolute CUP writes, then park the cursor. */
function renderScreenBody(rows, inverseSpans, cursor, options = {}) {
	let body = CLEAR_SCREEN;
	for (let y = 0; y < rows.length; y++) {
		if (rows[y] !== "") body += cup(0, y) + rows[y];
	}
	for (const span of inverseSpans) {
		body += cup(span.x, span.y) + "\x1b[7m" + rows[span.y].slice(span.x, span.x + span.text.length) + "\x1b[0m";
	}
	body += HIDE_CURSOR;
	if (options.cursorVisible) body += SHOW_CURSOR;
	if (cursor) body += cup(cursor.x, cursor.y);
	return body;
}

function synchronizedFrame(body) {
	return `${OPEN}${body}${CLOSE}`;
}

const LOADING_ROWS = ["Loading session...", "waiting for first frame"];
const LOADING_CURSOR = { x: 0, y: 0, visible: false };
const LOADING_BODY = renderScreenBody(LOADING_ROWS, [], LOADING_CURSOR);

const TARGET_ROWS = [
	"F1 HISTORY old reply",
	"F1 HISTORY second reply",
	"",
	"",
	"",
	"F1 TAIL assistant answer",
	"",
	"F1 INPUT > hello world",
	"",
	"",
];
const TARGET_CURSOR = { x: 10, y: 7, visible: false };
const TARGET_SELECTION_SPAN = { x: 3, y: 5, text: "TAIL" };
const TARGET_SOFTWARE_CURSOR_SPAN = { x: 10, y: 7, text: " " };
const TARGET_INVERSE_SPANS = [TARGET_SELECTION_SPAN, TARGET_SOFTWARE_CURSOR_SPAN];
const TARGET_BODY = renderScreenBody(TARGET_ROWS, TARGET_INVERSE_SPANS, TARGET_CURSOR);

const INITIAL_SCREEN = {
	name: "initial-empty",
	rows: padRows([]),
	cursor: { x: 0, y: 0, visible: true },
	inverseCells: [],
};
const LOADING_SCREEN = {
	name: "loading",
	rows: padRows(LOADING_ROWS),
	cursor: { ...LOADING_CURSOR },
	inverseCells: [],
	loading: true,
};
const TARGET_SCREEN = {
	name: "target",
	rows: padRows(TARGET_ROWS),
	rowFrameIds: ["F1", "F1", null, null, null, "F1", null, "F1", null, null],
	cursor: { ...TARGET_CURSOR },
	inverseCells: [
		{ x: 3, y: 5 },
		{ x: 4, y: 5 },
		{ x: 5, y: 5 },
		{ x: 6, y: 5 },
		{ x: 10, y: 7 },
	],
};
const PRESENTATION = {
	screens: [INITIAL_SCREEN, LOADING_SCREEN, TARGET_SCREEN],
	frameIds: ["F1", "F2"],
};

function inverseCellsOf(observation) {
	const points = [];
	for (let y = 0; y < observation.grid.length; y++) {
		for (let x = 0; x < observation.grid[y].cells.length; x++) {
			const cell = observation.grid[y].cells[x];
			if (cell.inverse && cell.width !== 0) points.push({ x, y });
		}
	}
	return points;
}

test("step 14: loading then complete target passes the independent checker", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, [synchronizedFrame(LOADING_BODY), synchronizedFrame(TARGET_BODY)]);
	const captured = frames(observer);
	assert.equal(captured.length, 2, "both controlled screens must be captured as complete frames");
	assert.equal(captured[0].grid[0].text, LOADING_ROWS[0]);
	assert.equal(captured[1].grid[7].text, TARGET_ROWS[7]);
	assert.deepEqual(validateAttachPresentation(observer.observations, PRESENTATION), [], "the allowed loading and target screens must pass");
});

test("step 14: a visible old-log state between loading and target is detected", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, [synchronizedFrame(LOADING_BODY), "OLD LOG 2024 stale line", synchronizedFrame(TARGET_BODY)]);
	const captured = frames(observer);
	assert.equal(captured.length, 2);
	const targetFrame = captured[1];
	const failures = validateAttachPresentation(observer.observations, PRESENTATION);
	assert.equal(failures.length, 2, "the unframed old-log write and the following block's entry window must both be reported");
	for (const failure of failures) {
		assert.equal(failure.category, "loading-artifact", "an artifact on the allowed loading screen is an explicit failure, not a substring exemption");
		assert.equal(failure.expected.screen, "loading");
		assert.ok(failure.index < targetFrame.index, "failures belong to observations before the following good target frame");
	}
	assert.equal(failures[0].actual.row, 0);
	assert.equal(failures[0].actual.text, "OLD LOG 2024 stale line");
});

test("step 14: close-bad/open-good in one write keeps the bad frame detectable", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	const oldLogBody = renderScreenBody(["OLD LOG 2024 stale line"], [], LOADING_CURSOR);
	await feed(observer, [synchronizedFrame(LOADING_BODY), synchronizedFrame(oldLogBody) + synchronizedFrame(TARGET_BODY)]);
	const captured = frames(observer);
	assert.equal(captured.length, 3);
	assert.deepEqual(
		captured.map((frame) => frame.grid[0].text),
		[LOADING_ROWS[0], "OLD LOG 2024 stale line", TARGET_ROWS[0]],
		"each close boundary snapshots the grid before later bytes in the same write overwrite row 0",
	);
	const failures = validateAttachPresentation(observer.observations, PRESENTATION);
	const badFrame = captured[1];
	const badFailure = failures.find((failure) => failure.index === badFrame.index);
	assert.ok(badFailure, "the bad frame captured inside the shared write must be reported");
	assert.equal(badFailure.category, "loading-artifact");
	assert.equal(badFailure.actual.kind, "frame");
	assert.equal(badFailure.actual.text, "OLD LOG 2024 stale line");
	assert.ok(failures.every((failure) => failure.index < captured[2].index), "the following good target frame passes");
});

test("step 14: upper and lower regions with different frame IDs are detected", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	const mixedRows = TARGET_ROWS.slice();
	mixedRows[5] = "F2 TAIL assistant answer";
	const mixedBody = renderScreenBody(mixedRows, TARGET_INVERSE_SPANS, TARGET_CURSOR);
	await feed(observer, [synchronizedFrame(LOADING_BODY), synchronizedFrame(TARGET_BODY), synchronizedFrame(mixedBody), synchronizedFrame(TARGET_BODY)]);
	const captured = frames(observer);
	assert.equal(captured.length, 4);
	const mixedFrame = captured[2];
	const failures = validateAttachPresentation(observer.observations, PRESENTATION);
	const mixedFailures = failures.filter((failure) => failure.index >= mixedFrame.index && failure.index < captured[3].index);
	assert.equal(mixedFailures.length, 3, "the mixed frame, its write-end window, and the next block's sync-entry window all fail");
	for (const failure of mixedFailures) {
		assert.equal(failure.category, "mixed-frame-id");
		assert.equal(failure.expected.screen, "target");
		assert.equal(failure.expected.row, 5);
		assert.equal(failure.expected.frameId, "F1");
		assert.equal(failure.actual.row, 5);
		assert.equal(failure.actual.frameId, "F2");
		assert.equal(failure.actual.text, "F2 TAIL assistant answer");
	}
	assert.ok(failures.every((failure) => failure.index < captured[3].index), "the following good target frame passes");
});

test("step 14: a blank working state after loading is detected", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	const blankBody = `${CLEAR_SCREEN}${HIDE_CURSOR}${cup(0, 0)}`;
	await feed(observer, [synchronizedFrame(LOADING_BODY), synchronizedFrame(blankBody), synchronizedFrame(TARGET_BODY)]);
	const captured = frames(observer);
	assert.equal(captured.length, 3);
	assert.ok(captured[1].grid.every((row) => row.text === ""), "the injected state is a complete blank screen");
	const failures = validateAttachPresentation(observer.observations, PRESENTATION);
	assert.equal(failures.length, 3, "the blank frame, its write-end window, and the next block's sync-entry window all fail");
	for (const failure of failures) {
		assert.equal(failure.category, "blank-screen");
		assert.equal(failure.expected.screen, "loading");
		assert.ok(failure.actual.rows.every((text) => text === ""));
	}
	assert.ok(failures.every((failure) => failure.index < captured[2].index));
});

test("step 14: an unexpected software-cursor-style inverse cell is detected without text changes", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	const extraCursorSpan = { x: 16, y: 7, text: " " };
	const badBody = renderScreenBody(TARGET_ROWS, [...TARGET_INVERSE_SPANS, extraCursorSpan], TARGET_CURSOR);
	await feed(observer, [synchronizedFrame(LOADING_BODY), synchronizedFrame(badBody), synchronizedFrame(TARGET_BODY)]);
	const captured = frames(observer);
	assert.deepEqual(captured[1].grid.map((row) => row.text), padRows(TARGET_ROWS), "the injected cursor cell must not change any text");
	assert.deepEqual(inverseCellsOf(captured[1]), [
		{ x: 3, y: 5 },
		{ x: 4, y: 5 },
		{ x: 5, y: 5 },
		{ x: 6, y: 5 },
		{ x: 10, y: 7 },
		{ x: 16, y: 7 },
	]);
	const failures = validateAttachPresentation(observer.observations, PRESENTATION);
	assert.equal(failures.length, 3, "the bad frame and the two windows that exposed it all fail");
	for (const failure of failures) {
		assert.equal(failure.category, "inverse-cells", "cursor-style artifacts are judged from cell attributes, not text");
		assert.deepEqual(failure.actual.extraInverseCells, [{ x: 16, y: 7 }]);
		assert.deepEqual(failure.actual.missingInverseCells, []);
	}
	assert.ok(failures.every((failure) => failure.index < captured[2].index));
});

test("step 14: a visible hardware cursor is detected when the software cursor is the allowed one", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	const badBody = renderScreenBody(TARGET_ROWS, TARGET_INVERSE_SPANS, TARGET_CURSOR, { cursorVisible: true });
	await feed(observer, [synchronizedFrame(LOADING_BODY), synchronizedFrame(badBody), synchronizedFrame(TARGET_BODY)]);
	const captured = frames(observer);
	assert.equal(captured[1].cursor.visible, true);
	assert.equal(captured[1].cursor.x, TARGET_CURSOR.x);
	assert.equal(captured[1].cursor.y, TARGET_CURSOR.y);
	const failures = validateAttachPresentation(observer.observations, PRESENTATION);
	assert.equal(failures.length, 3, "the bad frame and the two windows that exposed it all fail");
	for (const failure of failures) {
		assert.equal(failure.category, "hardware-cursor");
		assert.deepEqual(failure.expected.cursor, TARGET_CURSOR);
		assert.equal(failure.actual.cursor.visible, true);
	}
	assert.ok(failures.every((failure) => failure.index < captured[2].index));
});

test("step 14: legitimate inverse selection cells are pinned presentation, not cursor verdicts", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, [synchronizedFrame(LOADING_BODY), synchronizedFrame(TARGET_BODY)]);
	const targetFrame = frames(observer)[1];
	assert.deepEqual(inverseCellsOf(targetFrame), PRESENTATION.screens[2].inverseCells.map((cell) => ({ ...cell })));
	assert.deepEqual(validateAttachPresentation(observer.observations, PRESENTATION), [], "declared selection cells plus the software cursor are a valid positive control");
	// The same capture with the selection cells omitted from the expectation
	// exposes them as extra inverse cells: the oracle compares the whole set and
	// never silently equates inverse video with a cursor of its own choosing.
	const sparseExpectation = {
		...PRESENTATION,
		screens: [INITIAL_SCREEN, LOADING_SCREEN, { ...TARGET_SCREEN, inverseCells: [{ x: 10, y: 7 }] }],
	};
	const failures = validateAttachPresentation(observer.observations, sparseExpectation);
	assert.ok(failures.length > 0);
	for (const failure of failures) {
		assert.equal(failure.category, "inverse-cells");
		assert.deepEqual(failure.actual.extraInverseCells, [
			{ x: 3, y: 5 },
			{ x: 4, y: 5 },
			{ x: 5, y: 5 },
			{ x: 6, y: 5 },
		]);
	}
});

test("step 14: sync-entry and unmatched-close windows are validated, never skipped", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	const oldLogBody = renderScreenBody(["OLD LOG 2024 stale line"], [], LOADING_CURSOR);
	await feed(observer, [synchronizedFrame(LOADING_BODY), synchronizedFrame(oldLogBody) + synchronizedFrame(TARGET_BODY)]);
	const syncEntry = observer.observations.find((observation) => observation.kind === "unframed" && observation.note === "sync-entry" && observation.grid[0].text === "OLD LOG 2024 stale line");
	assert.ok(syncEntry, "the entry window of the good block must expose the preceding bad state");
	let failures = validateAttachPresentation(observer.observations, PRESENTATION);
	assert.ok(
		failures.some((failure) => failure.index === syncEntry.index && failure.actual.note === "sync-entry"),
		"a sync-entry note is diagnostic context, not proof that the observation was invisible",
	);
	await feed(observer, [`STALE CLOSE LINE${CLOSE}`, synchronizedFrame(TARGET_BODY)]);
	const unmatchedClose = observer.observations.find((observation) => observation.note === "unmatched-close");
	assert.ok(unmatchedClose, "the write with an unmatched close must leave an observed window");
	failures = validateAttachPresentation(observer.observations, PRESENTATION);
	const unmatchedFailure = failures.find((failure) => failure.index === unmatchedClose.index);
	assert.ok(unmatchedFailure, "an unmatched-close observation is a real visible state and must be checked");
	assert.equal(unmatchedFailure.category, "row-mismatch");
	assert.equal(unmatchedFailure.actual.note, "unmatched-close");
	assert.ok(unmatchedFailure.actual.text.includes("STALE CLOSE LINE"));
});

test("step 14: later good frames never erase earlier failures", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	const oldLogBody = renderScreenBody(["OLD LOG 2024 stale line"], [], LOADING_CURSOR);
	await feed(observer, [synchronizedFrame(LOADING_BODY), synchronizedFrame(oldLogBody)]);
	const badFrame = frames(observer)[1];
	const before = validateAttachPresentation(observer.observations, PRESENTATION);
	assert.equal(before.length, 2, "the bad frame and its write-end window are both reported");
	assert.equal(before[0].index, badFrame.index);
	assert.equal(before[0].category, "loading-artifact");
	const historyCount = observer.observations.length;
	const historyBefore = JSON.stringify(observer.observations);
	await feed(observer, [synchronizedFrame(TARGET_BODY)]);
	const after = validateAttachPresentation(observer.observations, PRESENTATION);
	assert.ok(after.length > before.length, "the sync-entry window before the recovery target is checked as well");
	assert.deepEqual(
		after.filter((failure) => failure.index === badFrame.index),
		[before[0]],
		"the earlier failure keeps its category and observation index after later good output",
	);
	assert.equal(JSON.stringify(observer.observations.slice(0, historyCount)), historyBefore, "later writes append; earlier captured records stay byte-identical");
	assert.deepEqual(JSON.parse(JSON.stringify(after)), after, "failures are serializable");
	assert.deepEqual(validateAttachPresentation(observer.observations, PRESENTATION), after, "validation is deterministic");
});

test("step 14: a regression to an already-passed screen is reported as stale", async (t) => {
	const observer = makeObserver();
	t.after(() => observer.dispose());
	await feed(observer, [
		synchronizedFrame(LOADING_BODY),
		synchronizedFrame(TARGET_BODY),
		synchronizedFrame(LOADING_BODY),
		synchronizedFrame(TARGET_BODY),
	]);
	const captured = frames(observer);
	assert.equal(captured.length, 4);
	const failures = validateAttachPresentation(observer.observations, PRESENTATION);
	const staleFrame = captured[2];
	const staleFailures = failures.filter((failure) => failure.index >= staleFrame.index && failure.index < captured[3].index);
	assert.equal(staleFailures.length, 3, "the stale frame, its write-end window, and the next block's sync-entry window all fail");
	for (const failure of staleFailures) {
		assert.equal(failure.category, "stale-screen");
		assert.equal(failure.expected.screen, "target");
		assert.equal(failure.actual.screen, "loading");
	}
	assert.ok(failures.every((failure) => failure.index < captured[3].index), "the following good target frame passes");
});

// Step-15 producer section imports. They live in the appended section (valid
// top-level ESM, hoisted) so the accepted step-14 byte prefix above stays
// identical to baselines/step14.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import xtermHeadless from "@xterm/headless";

// ---------------------------------------------------------------------------
// Issue #222 step 15 producer: controlled fullscreen child contract tests.
//
// These tests pin the PRODUCER side of the step-15 handoff: an additive
// FAKE_PTY_STREAM_MODE="controlled-frames" mode of test-support/fake-pty-pi.mjs
// that owns literal frame identities F0/F1/F2 on an 80x22 work area, seeds a
// complete F0, and advances a fixed script only through framed stdin commands
// (RS 0x1E + JSON + LF). Each test spawns a real owned subprocess, feeds its
// actual stdout bytes through the accepted AttachPresentationObserver AND an
// independent raw @xterm/headless terminal (the raw terminal reads the live
// grid while a synchronized frame is still open; the observer only records
// closed frames). Expected rows/cursor are literal constants defined here —
// never derived from captured grids — and the child's per-write event log is
// audited against the exact received byte stream via sha256. No candidate
// readiness flag is read; raw-mode availability is never reported as
// production readiness.
// ---------------------------------------------------------------------------

const PRODUCER_COLS = 80;
const PRODUCER_ROWS = 22;
// The complete literal screen the child must paint for frame <id>; upper half
// is rows 0..10, lower half rows 11..21. Independently defined here; the
// producer report publishes the same literals for the integration owner.
const producerRows = (id) => [
	`${id} HEADER controlled work area`,
	`${id} UPPER reply history one`,
	`${id} UPPER reply history two`,
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	`${id} MIDDLE divider`,
	`${id} LOWER reply history three`,
	`${id} LOWER reply history four`,
	"",
	"",
	"",
	"",
	"",
	"",
	`${id} TAIL assistant final answer`,
	"",
	`${id} INPUT >`,
];
// Explicit cursor state every screen write must leave: hidden hardware cursor
// parked on the cell right after the INPUT prompt (row text is right-trimmed).
const PRODUCER_CURSOR = { x: 10, y: 21, visible: false };
const PRODUCER_RS = "\x1e";
const producerCommand = (obj) => `${PRODUCER_RS}${JSON.stringify(obj)}\n`;

// Owned-child cleanup: EVERY spawned child (including invalid-config spawns
// and assertion/error paths) is registered for bounded teardown immediately
// after spawn. A child that already exited is a no-op; a live child is
// SIGKILLed and its exit awaited with a bound so the test process can always
// end. Only children this file spawned are touched — never broad pkill.
function registerOwnedChild(t, child) {
	t.after(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill("SIGKILL");
		} catch {
			/* already exited */
		}
		await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), new Promise((resolveExit) => setTimeout(resolveExit, 2000))]);
	});
}

function spawnControlledChild(t, script) {
	const dir = mkdtempSync(join(tmpdir(), "step15-producer-"));
	const eventsPath = join(dir, "events.jsonl");
	const child = spawn(process.execPath, [resolve("test-support/fake-pty-pi.mjs")], {
		env: {
			...process.env,
			FAKE_PTY_STREAM_MODE: "controlled-frames",
			FAKE_PTY_CONTROLLED_SCRIPT: script,
			FAKE_PTY_EVENTS_PATH: eventsPath,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	registerOwnedChild(t, child);
	const observer = new AttachPresentationObserver({ cols: PRODUCER_COLS, rows: PRODUCER_ROWS });
	const raw = new xtermHeadless.Terminal({ cols: PRODUCER_COLS, rows: PRODUCER_ROWS, allowProposedApi: true });
	let stdoutAll = "";
	let stderrAll = "";
	let rawChain = Promise.resolve();
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutAll += chunk;
		observer.write(chunk);
		rawChain = rawChain.then(() => new Promise((resolveRaw) => raw.write(chunk, resolveRaw)));
	});
	child.stderr.on("data", (chunk) => {
		stderrAll += chunk;
	});
	t.after(() => {
		observer.dispose();
		raw.dispose();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		child,
		observer,
		raw,
		eventsPath,
		dir,
		stdout: () => stdoutAll,
		stderr: () => stderrAll,
		whenRawIdle: () => rawChain,
		send: (obj) => child.stdin.write(producerCommand(obj)),
		sendRaw: (bytes) => child.stdin.write(bytes),
	};
}

function readProducerEvents(eventsPath) {
	try {
		return readFileSync(eventsPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function producerWrites(events) {
	return events.filter((event) => event.event === "stdout-write");
}

// Re-slice the exact received byte stream at the child-logged write
// boundaries: every logged sha256 must match its slice and the slices must
// partition the stream completely. This is the raw-byte identity audit behind
// the same-write and split-delimiter claims; it never trusts the log alone.
function auditProducerWrites(events, stream) {
	const buffer = Buffer.from(stream, "utf8");
	const slices = [];
	let offset = 0;
	for (const write of producerWrites(events)) {
		const slice = buffer.subarray(offset, offset + write.bytes);
		assert.equal(
			createHash("sha256").update(slice).digest("hex"),
			write.sha256,
			`stdout-write ${write.writeIndex} (step ${write.step}) must match the received bytes at the logged boundary`,
		);
		slices.push(slice.toString("utf8"));
		offset += write.bytes;
	}
	assert.equal(offset, buffer.length, "the logged write boundaries must account for every received byte");
	return slices;
}

function rawRows(raw) {
	const rows = [];
	for (let y = 0; y < PRODUCER_ROWS; y++) rows.push(raw.buffer.active.getLine(y)?.translateToString(true) ?? "");
	return rows;
}

function producerFrameRows(frame) {
	return frame.grid.map((row) => row.text);
}

function producerFrameCursor(frame) {
	return { x: frame.cursor.x, y: frame.cursor.y, visible: frame.cursor.visible };
}

function waitForChildExit(child, timeoutMs, label) {
	return new Promise((resolveExit, rejectExit) => {
		if (child.exitCode !== null) {
			resolveExit(child.exitCode);
			return;
		}
		const timer = setTimeout(() => rejectExit(new Error(`timed out waiting for: ${label}`)), timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolveExit(code);
		});
	});
}

async function settleProducer(h) {
	await h.observer.whenIdle();
	await h.whenRawIdle();
}

async function waitForProducerWrite(h, step, label) {
	await waitFor(() => producerWrites(readProducerEvents(h.eventsPath)).some((write) => write.step === step), 5000, label);
	await settleProducer(h);
}

test("step 15 producer: plain variant seeds a complete F0 and closes F1 in two commanded halves", async (t) => {
	const h = spawnControlledChild(t, "plain");
	await waitFor(() => frames(h.observer).length >= 1, 5000, "controlled F0 seed frame");
	await settleProducer(h);
	const seed = frames(h.observer)[0];
	assert.deepEqual(producerFrameRows(seed), producerRows("F0"), "the seed is the complete literal F0 screen");
	assert.deepEqual(producerFrameCursor(seed), PRODUCER_CURSOR, "the seed leaves the explicit hidden cursor at the INPUT row");
	assert.deepEqual(rawRows(h.raw), producerRows("F0"), "the live grid agrees with the closed seed frame");

	// Step 1 opens a synchronized F1 frame and replaces only the upper half;
	// the parent controls the hold — no child timer may complete the frame.
	h.send({ cmd: "step", step: 1 });
	await waitForProducerWrite(h, 1, "plain step 1 (open F1 upper half)");
	await new Promise((resolveHold) => setTimeout(resolveHold, 120)); // parent-controlled >40ms hold
	assert.equal(frames(h.observer).length, 1, "an open frame must never surface as a complete observation");
	const mixed = rawRows(h.raw);
	assert.equal(mixed[0], "F1 HEADER controlled work area", "upper half already shows F1 while the frame is open");
	assert.equal(mixed[10], "F1 MIDDLE divider");
	assert.equal(mixed[11], "F0 LOWER reply history three", "lower half still shows F0 while the frame is open");
	assert.equal(mixed[19], "F0 TAIL assistant final answer");
	assert.equal(mixed[21], "F0 INPUT >");

	// Step 2 replaces the lower half and closes F1.
	h.send({ cmd: "step", step: 2 });
	await waitFor(() => frames(h.observer).length >= 2, 5000, "closed F1 frame");
	await settleProducer(h);
	const closed = frames(h.observer)[1];
	assert.deepEqual(producerFrameRows(closed), producerRows("F1"), "the closed target is the complete literal F1 screen");
	assert.deepEqual(producerFrameCursor(closed), PRODUCER_CURSOR);
	assert.deepEqual(rawRows(h.raw), producerRows("F1"));

	h.send({ cmd: "exit" });
	assert.equal(await waitForChildExit(h.child, 5000, "plain child exit"), 0);
	assert.ok(!h.stdout().includes(PRODUCER_RS), "control bytes must never be echoed into the work area");
	assert.ok(!h.stdout().includes('"cmd"'), "command payloads must never be echoed into the work area");
	const events = readProducerEvents(h.eventsPath);
	assert.deepEqual(
		events.filter((event) => ["start", "command", "stdout-write", "exit"].includes(event.event)).map((event) => `${event.event}:${event.step ?? ""}`),
		["start:", "stdout-write:0", "command:1", "stdout-write:1", "command:2", "stdout-write:2", "command:", "exit:"],
		"events are ordered: seed, then each command strictly before its write, then exit",
	);
	assert.deepEqual(
		producerWrites(events).map((write) => [write.writeIndex, write.phase]),
		[
			[0, "seed"],
			[1, "open"],
			[2, "closed"],
		],
		"write indices are monotonic and phases identify the open/closed boundary",
	);
	auditProducerWrites(events, h.stdout());
});

test("step 15 producer: same-write variant closes F1 and opens F2 inside one actual stdout write", async (t) => {
	const h = spawnControlledChild(t, "same-write");
	await waitFor(() => frames(h.observer).length >= 1, 5000, "controlled F0 seed frame");
	h.send({ cmd: "step", step: 1 });
	await waitForProducerWrite(h, 1, "same-write step 1 (open F1 upper half)");
	assert.equal(frames(h.observer).length, 1, "F1 upper half is open and must not be observable as complete");

	h.send({ cmd: "step", step: 2 });
	await waitFor(() => frames(h.observer).length >= 2, 5000, "F1 closed by the same-write step");
	await settleProducer(h);
	const closedF1 = frames(h.observer)[1];
	assert.deepEqual(producerFrameRows(closedF1), producerRows("F1"), "the same write still closes a complete literal F1");
	assert.equal(frames(h.observer).length, 2, "F2 stays open until the later finish command");
	const mixed = rawRows(h.raw);
	assert.equal(mixed[0], "F2 HEADER controlled work area", "the same write already painted F2's upper half");
	assert.equal(mixed[10], "F2 MIDDLE divider");
	assert.equal(mixed[11], "F1 LOWER reply history three", "F1's lower half remains visible under the open F2");
	assert.equal(mixed[19], "F1 TAIL assistant final answer");

	h.send({ cmd: "step", step: 3 });
	await waitFor(() => frames(h.observer).length >= 3, 5000, "closed F2 frame");
	await settleProducer(h);
	assert.deepEqual(producerFrameRows(frames(h.observer)[2]), producerRows("F2"), "the later command finishes and closes F2");
	assert.deepEqual(producerFrameCursor(frames(h.observer)[2]), PRODUCER_CURSOR);

	h.send({ cmd: "exit" });
	assert.equal(await waitForChildExit(h.child, 5000, "same-write child exit"), 0);
	const events = readProducerEvents(h.eventsPath);
	const slices = auditProducerWrites(events, h.stdout());
	const writes = producerWrites(events);
	const sameWrite = slices[writes.findIndex((write) => write.step === 2)];
	assert.ok(sameWrite.includes(`${CLOSE}${OPEN}`), "CLOSE and OPEN are adjacent inside ONE actual stdout.write");
	assert.ok(sameWrite.indexOf("F1 LOWER reply history three") < sameWrite.indexOf(`${CLOSE}${OPEN}`), "F1's lower half is finished before the close");
	assert.ok(sameWrite.indexOf(`${CLOSE}${OPEN}`) < sameWrite.indexOf("F2 HEADER controlled work area"), "F2's upper half follows the re-open in the same write");
	assert.equal(writes.find((write) => write.step === 2).phase, "close-open", "the event log identifies the same-write step explicitly");
	assert.ok(!h.stdout().includes(PRODUCER_RS) && !h.stdout().includes('"cmd"'), "no control echo");
});

test("step 15 producer: split variant delivers OPEN and CLOSE CSI fragments as separate commandable writes", async (t) => {
	const h = spawnControlledChild(t, "split");
	await waitFor(() => frames(h.observer).length >= 1, 5000, "controlled F0 seed frame");
	await settleProducer(h);
	assert.deepEqual(rawRows(h.raw), producerRows("F0"));

	// Step 1: first OPEN fragment only — the parser must hold it without any
	// visible effect, proving fragments arrive as independent writes.
	h.send({ cmd: "step", step: 1 });
	await waitForProducerWrite(h, 1, "split step 1 (OPEN fragment 1)");
	assert.equal(frames(h.observer).length, 1, "an incomplete OPEN fragment is not a frame");
	assert.deepEqual(rawRows(h.raw), producerRows("F0"), "an incomplete CSI must not alter the grid");

	// Step 2 completes the OPEN and writes F1's upper half: the meaningful hold.
	h.send({ cmd: "step", step: 2 });
	await waitForProducerWrite(h, 2, "split step 2 (OPEN fragment 2 + F1 upper half)");
	await new Promise((resolveHold) => setTimeout(resolveHold, 120)); // parent-controlled >40ms hold
	assert.equal(frames(h.observer).length, 1, "the frame is open and must stay unobservable during the hold");
	const mixed = rawRows(h.raw);
	assert.equal(mixed[0], "F1 HEADER controlled work area");
	assert.equal(mixed[19], "F0 TAIL assistant final answer", "F0 lower half is still visible during the hold");

	// Step 3 writes F1's lower half plus the first CLOSE fragment: the grid is
	// complete F1 but the frame is STILL not closed.
	h.send({ cmd: "step", step: 3 });
	await waitForProducerWrite(h, 3, "split step 3 (F1 lower half + CLOSE fragment 1)");
	assert.equal(frames(h.observer).length, 1, "a split CLOSE fragment must not close the frame");
	assert.deepEqual(rawRows(h.raw), producerRows("F1"), "the live grid is already the complete F1 screen");

	// Step 4 completes the CLOSE delimiter.
	h.send({ cmd: "step", step: 4 });
	await waitFor(() => frames(h.observer).length >= 2, 5000, "F1 closed by the completing CLOSE fragment");
	await settleProducer(h);
	assert.deepEqual(producerFrameRows(frames(h.observer)[1]), producerRows("F1"));
	assert.deepEqual(producerFrameCursor(frames(h.observer)[1]), PRODUCER_CURSOR);

	h.send({ cmd: "exit" });
	assert.equal(await waitForChildExit(h.child, 5000, "split child exit"), 0);
	const events = readProducerEvents(h.eventsPath);
	const slices = auditProducerWrites(events, h.stdout());
	assert.equal(slices[1], "\x1b[?202", "OPEN fragment 1 is exactly its own received write");
	assert.ok(slices[2].startsWith("6h"), "OPEN fragment 2 completes the delimiter at the start of its write");
	assert.ok(slices[3].endsWith("\x1b[?202"), "CLOSE fragment 1 trails F1's lower half in its own write");
	assert.equal(slices[4], "6l", "CLOSE fragment 2 completes the delimiter as its own received write");
	const phases = producerWrites(events).map((write) => write.phase);
	assert.deepEqual(phases, ["seed", "open-fragment-1", "open", "close-fragment-1", "closed"], "the event log identifies every fragment phase");
	assert.ok(!h.stdout().includes(PRODUCER_RS) && !h.stdout().includes('"cmd"'), "no control echo");
});

test("step 15 producer: control parser survives fragmented/coalesced commands and ignores terminal replies", async (t) => {
	const h = spawnControlledChild(t, "plain");
	await waitFor(() => frames(h.observer).length >= 1, 5000, "controlled F0 seed frame");

	// An unrelated terminal reply (cursor-position report) is logged as ignored
	// input and produces no output and no script advance.
	h.sendRaw("\x1b[1;1R");
	await waitFor(() => readProducerEvents(h.eventsPath).some((event) => event.event === "input-ignored"), 5000, "ignored terminal reply event");
	assert.equal(producerWrites(readProducerEvents(h.eventsPath)).length, 1, "terminal replies must not produce output");

	// A fragmented command fires only once its LF arrives.
	h.sendRaw(`${PRODUCER_RS}{"cmd":"step",`);
	await new Promise((resolveHold) => setTimeout(resolveHold, 80));
	assert.equal(producerWrites(readProducerEvents(h.eventsPath)).length, 1, "a fragmented command must not fire before its framing LF");
	h.sendRaw(`"step":1}\n`);
	await waitForProducerWrite(h, 1, "step 1 fired by the completing fragment");

	// A duplicate/out-of-order command is rejected and re-emits nothing.
	h.send({ cmd: "step", step: 1 });
	await waitFor(() => readProducerEvents(h.eventsPath).some((event) => event.event === "command-rejected"), 5000, "duplicate step rejection");
	assert.equal(
		producerWrites(readProducerEvents(h.eventsPath)).filter((write) => write.step === 1).length,
		1,
		"a rejected duplicate must not re-emit step 1 output",
	);

	// Coalesced commands in one stdin write execute strictly in order.
	h.sendRaw(producerCommand({ cmd: "step", step: 2 }) + producerCommand({ cmd: "exit" }));
	assert.equal(await waitForChildExit(h.child, 5000, "coalesced step+exit child exit"), 0);
	await settleProducer(h);
	assert.equal(frames(h.observer).length, 2, "coalesced step 2 closed F1 before the exit ran");
	assert.deepEqual(producerFrameRows(frames(h.observer)[1]), producerRows("F1"));
	const events = readProducerEvents(h.eventsPath);
	assert.deepEqual(
		events.filter((event) => ["command", "stdout-write", "exit"].includes(event.event)).map((event) => `${event.event}:${event.step ?? ""}`),
		["stdout-write:0", "command:1", "stdout-write:1", "command:2", "stdout-write:2", "command:", "exit:"],
		"coalesced commands run in order; each command strictly precedes its write",
	);
	auditProducerWrites(events, h.stdout());
	assert.ok(!h.stdout().includes(PRODUCER_RS) && !h.stdout().includes('"cmd"'), "no control echo");
});

test("step 15 producer: invalid or missing producer configuration exits nonzero with no stdout", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "step15-producer-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// One bounded owned-child config probe: collects stdout/stderr, waits for
	// either rejection or first emitted bytes, closes a wrongly-accepted child
	// through the normal exit command (registerOwnedChild backstops it), then
	// pins exit 2, zero stdout and a useful stderr line.
	const runConfigCase = async (env, label, stderrNeedle) => {
		const child = spawn(process.execPath, [resolve("test-support/fake-pty-pi.mjs")], {
			env: { ...process.env, FAKE_PTY_STREAM_MODE: "controlled-frames", ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		registerOwnedChild(t, child);
		let out = "";
		let err = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		const exited = waitForChildExit(child, 5000, label);
		await Promise.race([exited, new Promise((resolveData) => child.stdout.once("data", resolveData))]);
		if (child.exitCode === null) child.stdin.write(producerCommand({ cmd: "exit" }));
		assert.equal(await exited, 2, `${label}: invalid configuration must fail explicitly`);
		assert.equal(out, "", `${label}: configuration failure writes no banner, seed, or partial frame`);
		assert.ok(err.includes(stderrNeedle), `${label}: stderr must name the rejected configuration (got ${JSON.stringify(err)})`);
	};
	// Unknown script name.
	await runConfigCase(
		{ FAKE_PTY_CONTROLLED_SCRIPT: "bogus", FAKE_PTY_EVENTS_PATH: join(dir, "bogus.jsonl") },
		"bogus-script child exit",
		'unknown FAKE_PTY_CONTROLLED_SCRIPT "bogus"',
	);
	// P15-CONFIG-1: inherited Object.prototype property names are not own
	// scripts and must be rejected exactly like unknown names.
	for (const inherited of ["toString", "constructor", "__proto__"]) {
		await runConfigCase(
			{ FAKE_PTY_CONTROLLED_SCRIPT: inherited, FAKE_PTY_EVENTS_PATH: join(dir, `inherited-${inherited}.jsonl`) },
			`inherited-name ${inherited} child exit`,
			`unknown FAKE_PTY_CONTROLLED_SCRIPT "${inherited}"`,
		);
	}
	// Missing per-trial event log path.
	await runConfigCase({ FAKE_PTY_CONTROLLED_SCRIPT: "plain" }, "missing-events-path child exit", "FAKE_PTY_EVENTS_PATH is required");
});

// Step-15 integration section imports. They live in the appended section
// (valid top-level ESM, hoisted) so the accepted step-14 byte prefix and the
// step-15 producer section above stay identical to
// handoffs/step15-producer-parentfix1.
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Issue #222 step 15 integration (task-15-integration-brief.md): REAL-runner
// half-frame diagnostic, case S. A new test-support scenario owns an
// independent temp root, a REAL pty-runner hosting the accepted
// controlled-frames child, a REAL PtyAttachComponent mounted on a REAL
// TuiAltScreen whose terminal is the accepted AttachPresentationObserver, and
// a second raw subscribe/capture client on the same runner endpoint. Per
// controlled variant (plain open/hold/close, same-write CLOSE+OPEN, split
// OPEN/CLOSE fragments) the unfinished frame is held >40ms while capture,
// status (a real get_status response on the actual component socket) and the
// naturally scheduled loading ticker are exercised separately; output-driven
// 40ms, settle and first-paint render requests are traced in every trial.
//
// These tests pin the HARNESS contract (seed proof, required target commits,
// close ordering, chrome accounting, attribution completeness, owned cleanup,
// CLI surface), never a reproduction outcome: REPRODUCED / NOT_REPRODUCED /
// INCONCLUSIVE / INFRASTRUCTURE_FAILURE are data reported by the scenario, and
// a reproduced half-frame is diagnostic evidence, not a test failure.
// ---------------------------------------------------------------------------

const S15_ROOT = fileURLToPath(new URL("../", import.meta.url));
const S15_SCENARIO = join(S15_ROOT, "test-support", "pty-attach-ready-scenario.ts");
// Hashes accepted in task-15-producer-acceptance.md (handoffs/step15-producer-parentfix1/).
// Step-16 compatibility exception 1 (task-16-brief.md): fakePtyChild tracks
// the ADDITIVE step-16 producer evolution (new resize/cold/theme scripts plus
// the P16-DRAFT-ROWS editor-literal fix, plus the A5-continuation cold-ONLY
// stdin-raw-at-start observation gated on FAKE_PTY_CONTROLLED_SCRIPT==="cold"
// — plain/same-write/split/theme bytes, commands and events are untouched by
// that footer addition; the cold producer contract test passed after it, see
// task-16-a5-cold-producer.log). Earlier proof for the step16 scripts: the
// five step-15 producer contract tests passed unchanged against the then-new
// producer (task-16-recovery1-focused-tests.log, EXIT=0). The accepted
// b5d5848c... source remains in the immutable handoff.
const S15_ACCEPTED_HASHES = {
	fakePtyChild: "5d36706648ff67d6bf2b37a443f3246153dd691176bbb2455b30b165de0564b8",
	observerFixture: "4ee53b9622e34cb5212d8eaa952c403452383373ecae45d334cfa9a7c3b6aa38",
};
const S15_VERDICTS = new Set(["REPRODUCED", "NOT_REPRODUCED", "INCONCLUSIVE", "INFRASTRUCTURE_FAILURE"]);
const S15_VARIANTS = ["plain", "same-write", "split"];
const S15_ENTRIES = ["ticker", "status", "capture"];

function s15RunScenario(args, timeoutMs = 300_000) {
	return spawnSync(process.execPath, ["--experimental-transform-types", S15_SCENARIO, ...args], {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 64 * 1024 * 1024,
	});
}

test("step 15 integration: work-area projection maps body/cursor coordinates mechanically and never mutates the original observation", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	// A synthetic 24-row observation: header row 0, body rows 1..22, footer row 23.
	const grid = [{ text: "HDR", cells: [] }];
	for (let i = 0; i < 22; i++) grid.push({ text: `B${String(i).padStart(2, "0")}`, cells: [] });
	grid.push({ text: "FTR", cells: [] });
	const observation = Object.freeze({
		index: 0,
		kind: "frame",
		openWriteIndex: 0,
		closeWriteIndex: 0,
		openParsedAt: 1,
		boundaryParsedAt: 2,
		note: null,
		cols: 80,
		rows: 24,
		baseY: 0,
		cursor: Object.freeze({ x: 10, y: 22, absoluteY: 22, visible: false }),
		grid: Object.freeze(grid),
	});
	const projected = scenario.projectObservationToWorkArea(observation);
	assert.equal(projected.grid.length, PRODUCER_ROWS, "the projection drops exactly the two chrome rows");
	assert.equal(projected.grid[0].text, "B00", "body row 0 is screen row 1");
	assert.equal(projected.grid[21].text, "B21", "body row 21 is screen row 22");
	assert.deepEqual(
		{ x: projected.cursor.x, y: projected.cursor.y, visible: projected.cursor.visible },
		{ x: 10, y: 21, visible: false },
		"the cursor is re-based into work-area coordinates",
	);
	assert.equal(projected.rows, PRODUCER_ROWS);
	assert.equal(observation.grid.length, 24, "the original observation is untouched");
	// The producer contract's right-trim read convention, applied mechanically
	// to observed rows (the runner's hydrate frame pads rows to full width).
	assert.deepEqual(scenario.rtrimRows(["abc   ", "", "  \t "]), ["abc", "", ""]);
	assert.equal(observation.cursor.y, 22, "the original cursor is untouched");
	// Chrome accounting: header must be one of the declared status variants and
	// the footer the literal divider; anything else is a violation, never a
	// silent exemption.
	assert.deepEqual(
		scenario.checkChromeRows(observation),
		["header", "footer"],
		"the synthetic chrome rows are not the declared literals and must be reported by row role",
	);
	const good = {
		...observation,
		grid: [
			{ text: scenario.HEADER_BY_STATUS.attached, cells: [] },
			...grid.slice(1, 23),
			{ text: scenario.FOOTER_ROW, cells: [] },
		],
	};
	assert.deepEqual(scenario.checkChromeRows(good), [], "the declared header/footer literals pass the chrome check");
});

test("step 15 integration: loading-banner expectations are pinned to literal spinner/detail/chrome rows", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	// The spinner set is an explicit enumeration of the production SPINNER
	// constant (pty-attach.ts), pinned as literals here.
	assert.deepEqual(scenario.SPINNERS, ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
	const attached = scenario.loadingBodyRows({ spinner: "⠋", detail: scenario.LOADING_DETAILS.attached });
	assert.deepEqual(attached, [
		"", "", "", "", "", "", "", "", "",
		" ".repeat(32) + '⠋ Loading "s15"…',
		" ".repeat(17) + "Attached · waiting for the session to render…",
		"",
		" ".repeat(28) + "Ctrl+←/Ctrl+\\ to detach",
		"", "", "", "", "", "", "", "", "",
	], "the attached-phase loading body is the literal centered banner on the 22-row work area");
	assert.equal(attached.length, PRODUCER_ROWS);
	const starting = scenario.loadingBodyRows({ spinner: "⠇", detail: scenario.LOADING_DETAILS.starting0 });
	assert.equal(starting[10], " ".repeat(25) + "Starting the session host… 0s");
	assert.equal(starting[9], " ".repeat(32) + '⠇ Loading "s15"…');
	// The declared chrome literals are pinned too (identity theme, width 80).
	assert.equal(scenario.HEADER_BY_STATUS.attached, " s15 attached · opens links · drag selects+copies · Ctrl+←/Ctrl+\\ detach");
	assert.equal(scenario.HEADER_BY_STATUS.connecting, " s15 connecting · opens links · drag selects+copies · Ctrl+←/Ctrl+\\ detach");
	assert.equal(scenario.FOOTER_ROW, "─".repeat(80));
});

test("step 15 integration: scenario CLI rejects unsupported case, clock and repeat explicitly", () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "s15-cli-"));
	try {
		for (const args of [
			["--case", "T", "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir],
			["--case", "S", "--repeat", "2", "--clock", "real", "--artifact-dir", artifactDir],
			["--case", "S", "--repeat", "1", "--clock", "fake", "--artifact-dir", artifactDir],
			["--case", "S", "--repeat", "1", "--clock", "real"],
		]) {
			const res = s15RunScenario(args, 30_000);
			assert.equal(res.status, 2, `unsupported arguments must exit 2 explicitly (${args.join(" ")}); stderr: ${res.stderr}`);
			assert.ok((res.stderr ?? "").length > 0, "the rejection must name the problem on stderr");
			assert.equal((res.stdout ?? "").trim(), "", "a rejected invocation must not print a dummy success result");
		}
	} finally {
		rmSync(artifactDir, { recursive: true, force: true });
	}
});

test("step 15 integration: case S real-runner battery proves seeds, targets, ordering, attribution and owned cleanup", (t) => {
	const artifactDir = mkdtempSync(join(tmpdir(), "s15-battery-"));
	// Recovery1 hazard fix: a FAILED diagnostic trace is evidence — preserve
	// the artifact directory unless every assertion below passed. The failure
	// message prints the retained path. (Correction of the first appended
	// version, which removed the directory unconditionally; documented in
	// task-15-integration-checkpoint1-report.md.)
	let batteryPassed = false;
	t.after(() => {
		if (batteryPassed) rmSync(artifactDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	});
	const res = s15RunScenario(["--case", "S", "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir]);
	assert.equal(res.error, undefined, `scenario spawn error: ${res.error}`);
	assert.equal(res.status, 0, `scenario must exit 0 (harness completed, regardless of reproduction)\nstdout tail:\n${(res.stdout ?? "").slice(-2000)}\nstderr tail:\n${(res.stderr ?? "").slice(-4000)}`);
	const line = res.stdout.trim().split("\n").filter(Boolean).pop();
	const result = JSON.parse(line);
	assert.equal(result.ok, true, `battery-level harness error: ${result.error}`);
	assert.equal(result.caseId, "S");
	assert.equal(result.repeat, 1);
	assert.equal(result.clock, "real");
	// The integration consumed the ACCEPTED producer child and observer/oracle.
	assert.equal(result.environment.hashes.fakePtyChild, S15_ACCEPTED_HASHES.fakePtyChild, "the controlled child must be the accepted parentfix1 producer");
	assert.equal(result.environment.hashes.observerFixture, S15_ACCEPTED_HASHES.observerFixture, "the observer/oracle must be the accepted step-14 fixture");
	// P15-HEAD-1: the recorded checkout identity must be the ACTUAL invoking
	// checkout — validated independently here — never a pinned historical
	// constant (the historical d41a16b run keeps its identity in its immutable
	// retained records).
	assert.match(result.environment.head, /^[0-9a-f]{40}$/, "the diagnostic must record a checkout identity");
	const invokingHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: S15_ROOT, encoding: "utf8" }).trim();
	assert.equal(result.environment.head, invokingHead, "the recorded checkout identity must equal the actual invoking checkout");

	assert.equal(result.trials.length, 9, "every variant x entry combination is attempted exactly once");
	const trials = new Map(result.trials.map((trial) => [`${trial.variant}/${trial.entry}`, trial]));
	for (const variant of S15_VARIANTS) {
		for (const entry of S15_ENTRIES) {
			assert.ok(trials.has(`${variant}/${entry}`), `missing trial ${variant}/${entry}`);
		}
	}
	for (const trial of result.trials) {
		const label = `${trial.variant}/${trial.entry}`;
		// Screens and preconditions were declared BEFORE the trial ran.
		assert.ok(trial.declared.screens.length > 0, `${label}: expectation screens must be declared up front`);
		assert.ok(Array.isArray(trial.declared.preconditions) && trial.declared.preconditions.length > 0, `${label}: preconditions must be declared up front`);
		// The complete F0 seed is proven for every trial through the real runner.
		assert.equal(trial.f0SeedProof.ok, true, `${label}: the child's complete F0 seed must be proven (${trial.f0SeedProof.detail})`);
		// Required final target: plain/split close F1, same-write closes F2.
		const targetId = trial.variant === "same-write" ? "F2" : "F1";
		assert.equal(trial.finalTarget.frameId, targetId, `${label}: required final target`);
		assert.equal(trial.finalTarget.committed, true, `${label}: the required final target must be committed on the real terminal`);
		assert.deepEqual(trial.finalTarget.rows, producerRows(targetId), `${label}: the committed target rows are the literal producer contract`);
		// Recovery1 hazard fix: the outer hardware cursor and the child's logical
		// cursor are separate facts. The checkpoint trace recorded the ACTUAL
		// outer cursor; the test requires it to be recorded as data and pins the
		// child's logical cursor from the producer contract — it never equates
		// the hidden child cursor with the outer parked cursor. (Correction of
		// the first appended version, which asserted cursor === PRODUCER_CURSOR;
		// documented in task-15-integration-checkpoint1-report.md.)
		assert.equal(typeof trial.finalTarget.outerCursor?.x, "number", `${label}: the actual outer cursor at the target commit must be recorded`);
		assert.equal(typeof trial.finalTarget.outerCursor?.visible, "boolean", `${label}: the actual outer cursor visibility must be recorded`);
		assert.deepEqual(trial.finalTarget.childLogicalCursor, PRODUCER_CURSOR, `${label}: the child's logical cursor is the producer contract, recorded as a separate fact`);
		// Source-frame/close ordering and raw stream identity.
		assert.equal(trial.closeOrdering.ok, true, `${label}: ${trial.closeOrdering.detail}`);
		assert.equal(trial.streamAudit.ok, true, `${label}: the received byte stream must match the child write log exactly`);
		assert.equal(trial.noControlEcho, true, `${label}: control bytes must never be echoed into the work area`);
		if (trial.variant === "same-write") {
			assert.equal(trial.closeOrdering.closeOpenAdjacency, true, `${label}: CLOSE+OPEN must be adjacent inside one actual child write`);
		}
		if (trial.variant === "split") {
			assert.equal(trial.closeOrdering.fragmentIdentity, true, `${label}: OPEN/CLOSE fragments must be the exact literal fragment writes`);
		}
		// Every open-frame hold was actually longer than 40ms on the parent clock.
		assert.ok(trial.holds.length > 0, `${label}: at least one open-frame hold was exercised`);
		for (const hold of trial.holds) {
			assert.ok(hold.actualMs > 40, `${label}: hold after ${hold.after} lasted ${hold.actualMs}ms, must exceed 40ms`);
		}
		// Chrome was accounted for everywhere; no body artifact was suppressed.
		assert.deepEqual(trial.chromeViolations, [], `${label}: every observation's header/footer rows must be the declared literals`);
		// Every oracle failure carries an entry attribution (or an explicit
		// ambiguity with competing candidates); later good frames never erased
		// an earlier failure.
		for (const failure of trial.oracleFailures) {
			assert.ok(typeof failure.attribution === "string" && failure.attribution.length > 0, `${label}: failure at observation ${failure.index} has no attribution`);
			if (failure.attribution === "ambiguous") {
				assert.ok(failure.candidates.length >= 2, `${label}: ambiguous attribution must list the competing entries`);
			}
		}
		// A REPRODUCED verdict must carry a committed bad frame, never only a
		// conservative window re-exposure (sync-entry/write-end notes).
		for (const [hypothesis, record] of Object.entries(trial.verdicts)) {
			if (record.verdict === "REPRODUCED" && hypothesis !== "capture-hydrate") {
				assert.ok(record.badSubmissions > 0, `${label}: ${hypothesis} REPRODUCED must count committed bad frames`);
			}
		}
		assert.equal(trial.firstBad !== null, trial.oracleFailures.length > 0, `${label}: firstBad is present exactly when the oracle flagged an observation`);
		// Verdicts: only the four allowed outcomes, and the trial's named entry
		// was actually evaluated.
		assert.ok(Object.keys(trial.verdicts).length > 0, `${label}: at least one hypothesis verdict was recorded`);
		for (const [hypothesis, record] of Object.entries(trial.verdicts)) {
			assert.ok(S15_VERDICTS.has(record.verdict), `${label}: ${hypothesis} verdict ${record.verdict} is not one of the four allowed outcomes`);
		}
		// Hypothesis ids: ticker -> loading-ticker (the natural attaching ticker),
		// status -> status, capture -> capture-readonly + capture-hydrate.
		const named = trial.entry === "capture" ? ["capture-readonly", "capture-hydrate"] : trial.entry === "ticker" ? ["loading-ticker"] : [trial.entry];
		for (const hypothesis of named) {
			assert.ok(trial.verdicts[hypothesis], `${label}: the named entry hypothesis ${hypothesis} must be evaluated`);
		}
		// Teardown windows are checked under their own predeclared contract.
		assert.deepEqual(trial.teardownViolations, [], `${label}: teardown observations must only carry final-target/chrome content`);
		assert.deepEqual(trial.artifactErrors, [], `${label}: no artifact copy/write failures`);
		// Raw truth is on disk: immutable observations, render requests, child
		// events, probe protocol messages, declared expectation and analysis.
		for (const name of ["observations.json", "requests.json", "child-events.jsonl", "probe-messages.json", "expectation.json", "analysis.json"]) {
			assert.ok(existsSync(join(trial.artifactDir, name)), `${label}: missing raw artifact ${name}`);
		}
		// Owned cleanup: runner and child dead, per-trial store root removed.
		assert.equal(trial.cleanup.ok, true, `${label}: owned cleanup incomplete (${JSON.stringify(trial.cleanup)})`);
		// Step 17 fix1 (review disposition I-2): the S seam reuses the corrected
		// shared cleanup helper. The runner CLEARS host.json's childPid when the
		// child exits (runner/pty-runner.mjs:360), so on the natural path the
		// child pid is legitimately UNKNOWN at teardown: the corrected helper
		// records null where the old local killOwned laundered exactly this
		// situation into childAliveAfter=false (false known-dead). Termination
		// proof on this path is the host-observed exit, not a pid probe.
		assert.equal(trial.cleanup.childPid, null, `${label}: the runner clears childPid at exit — UNKNOWN, never false known-dead`);
		assert.equal(trial.cleanup.childAliveAfter, null, `${label}: an unknown child pid stays UNKNOWN (the corrected-helper signature)`);
		assert.equal(trial.cleanup.childExited, true, `${label}: termination proof is the host-observed exit`);
		assert.equal(typeof trial.cleanup.runnerPid, "number", `${label}: the shared helper records the known runner pid`);
		assert.equal(trial.cleanup.runnerAliveAfter, false, `${label}: the runner's real exit status is provably not alive`);
		assert.equal(trial.cleanup.runnerExitSignal, null, `${label}: natural exit — no signal terminated the runner`);
		assert.deepEqual(trial.cleanup.forcedKills, [], `${label}: natural path — no forced kills`);
		assert.ok("childExitCode" in trial.cleanup, `${label}: the S-specific childExitCode field is preserved`);
	}
	// Capture trials additionally record the mid-open capture content (data
	// origin) separately from the render trigger.
	for (const variant of S15_VARIANTS) {
		const trial = trials.get(`${variant}/capture`);
		assert.equal(trial.capture.performed, true, `${variant}/capture: the mid-open subscribe/capture actually ran`);
		assert.equal(trial.capture.rows.length, PRODUCER_ROWS, `${variant}/capture: the captured frame content was recorded as work-area rows`);
		assert.equal(trial.captureHydrate.attempted, true, `${variant}/capture: the fresh-attach hydrate subcase actually ran`);
	}
	batteryPassed = true;
});

// ---------------------------------------------------------------------------
// Step-15 integration CONTINUATION (task-15-integration-continuation-brief.md):
// focused regressions for the checkpoint-1 parent review findings on the
// unaccepted harness. Each test names the harness gap it pins:
//  F1: an invalid blank ACTIVE frame must fail — the optional teardown blank
//      no longer lives in the active expectation (parent pure counterexample:
//      reordering bootstrap blank after the F1 target used to pass).
//  F2: active frame screens enforce the source-grounded hidden outer hardware
//      cursor — a visible one must fail (parent's second pure counterexample).
//  F3: the work-area projection re-bases cursor.y AND cursor.absoluteY.
//  F4: teardown observations are validated under their own predeclared
//      contract (only final-target/chrome/blank content), never excluded from
//      checking and never part of the active expectation.
// ---------------------------------------------------------------------------

// Build one synthetic WORK-AREA observation (22 rows) with literal text rows,
// a cursor, and no cells (no inverse content). Independent of any capture.
function s15Obs(index, rows, cursor, kind = "frame") {
	return {
		index,
		kind,
		openWriteIndex: 0,
		closeWriteIndex: 0,
		openParsedAt: index,
		boundaryParsedAt: index,
		note: null,
		cols: PRODUCER_COLS,
		rows: PRODUCER_ROWS,
		baseY: 0,
		cursor,
		grid: Array.from({ length: PRODUCER_ROWS }, (_, y) => ({ text: rows[y] ?? "", cells: [] })),
	};
}

const S15_BLANK_CURSOR = { x: 0, y: 0, absoluteY: 0, visible: true };
const S15_OUTER_TARGET_CURSOR = { x: 10, y: 21, absoluteY: 21, visible: false };

test("step 15 integration continuation: an invalid blank ACTIVE frame after the completed target is rejected", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const expectation = scenario.buildExpectation("plain");
	assert.ok(
		!expectation.screens.some((screen) => screen.name === "teardown-normal-buffer"),
		"the ACTIVE expectation must not contain an optional teardown blank escape",
	);
	const active = [
		s15Obs(0, [], S15_BLANK_CURSOR), // bootstrap blank (allowed, first)
		s15Obs(1, producerRows("F0"), S15_OUTER_TARGET_CURSOR),
		s15Obs(2, producerRows("F1"), S15_OUTER_TARGET_CURSOR),
		s15Obs(3, [], S15_BLANK_CURSOR), // invalid blank while ACTIVE: must fail
	];
	const failures = scenario.validateActiveObservations(active, expectation);
	assert.ok(failures.length > 0, "a blank frame after the completed target must be rejected");
	assert.equal(failures[0].index, 3);
	assert.equal(failures[0].category, "blank-screen");
});

test("step 15 integration continuation: active frames enforce the hidden outer hardware cursor while coordinates stay recorded data", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const expectation = scenario.buildExpectation("plain");
	const visibleCursor = { x: 10, y: 21, absoluteY: 21, visible: true };
	const active = [
		s15Obs(0, [], S15_BLANK_CURSOR),
		s15Obs(1, producerRows("F0"), S15_OUTER_TARGET_CURSOR),
		s15Obs(2, producerRows("F1"), visibleCursor), // visible hardware cursor: must fail
	];
	const failures = scenario.validateActiveObservations(active, expectation);
	assert.ok(failures.length > 0, "a visible outer hardware cursor on an active frame must be rejected");
	assert.equal(failures[0].index, 2);
	assert.equal(failures[0].category, "hardware-cursor");
});

test("step 15 integration continuation: work-area projection re-bases cursor y and absoluteY", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const observation = {
		index: 0,
		kind: "frame",
		openWriteIndex: 0,
		closeWriteIndex: 0,
		openParsedAt: 0,
		boundaryParsedAt: 0,
		note: null,
		cols: 80,
		rows: 24,
		baseY: 0,
		cursor: { x: 10, y: 22, absoluteY: 22, visible: false },
		grid: Array.from({ length: 24 }, (_, y) => ({ text: y === 0 ? scenario.HEADER_BY_STATUS.attached : y === 23 ? scenario.FOOTER_ROW : `row${y}`, cells: [] })),
	};
	const projected = scenario.projectObservationToWorkArea(observation);
	assert.deepEqual(projected.cursor, { x: 10, y: 21, absoluteY: 21, visible: false }, "both cursor coordinates are re-based into the work area");
	assert.equal(observation.cursor.absoluteY, 22, "the original observation is untouched");
});

test("step 15 integration continuation: teardown observations are checked against a predeclared contract, not excluded", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const contract = scenario.buildTeardownContract("F1");
	// Legitimate teardown: content from the already-committed final target and
	// declared chrome only (cursor visibility unconstrained at teardown).
	const allowed = s15Obs(0, producerRows("F1"), { x: 0, y: 21, absoluteY: 21, visible: true });
	assert.deepEqual(scenario.validateTeardownObservations([allowed], contract), [], "final-target content at teardown is legitimate");
	const foreign = s15Obs(1, ["UNDECLARED TEARDOWN CONTENT"], S15_BLANK_CURSOR);
	const violations = scenario.validateTeardownObservations([allowed, foreign], contract);
	assert.equal(violations.length, 1, "new content appearing only at teardown must be flagged");
	assert.equal(violations[0].index, 1);
});

// ---------------------------------------------------------------------------
// Step-15 integration parentfix2 (task-15-integration-parentfix2-brief.md):
// focused regressions for P15-CAUSAL-1 (receive-call identity for
// socket-control render requests, replacing the nearest-message time
// heuristic). These exercise the REAL exported analyzer/wrapper, not a copy.
// ---------------------------------------------------------------------------

test("step 15 integration parentfix2: coalesced status+error in one receive keeps both eligible controls as candidates", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	// The parent's pure witness shape: production onSocketData consumed a
	// coalesced status AND error in ONE receive callback and requested one
	// render after the loop; both controls are eligible causes.
	const contexts = [{ receiveId: 7, at: 100, text: `${JSON.stringify({ type: "status" })}\n${JSON.stringify({ type: "error", message: "synthetic" })}\n` }];
	const requests = [{ seq: 0, at: 100, force: false, scheduled: true, entry: "socket-control", receiveId: 7, stack: "synthetic onSocketData" }];
	const rxMessages = [
		{ at: 100, type: "status", msg: { type: "status" }, chunkIndex: 0 },
		{ at: 100, type: "error", msg: { type: "error", message: "synthetic" }, chunkIndex: 0 },
	];
	const linked = scenario.attributeSocketRequests(requests, { receiveContexts: contexts, rxMessages });
	assert.equal(linked[0].entry, "ambiguous", "two eligible controls in one receive must stay ambiguous, not a sole last-message conviction");
	assert.deepEqual(new Set(linked[0].candidates), new Set(["status", "error-broadcast"]));
	assert.deepEqual(linked[0].messageTypes, ["status", "error"], "every consumed eligible control is retained in order");
});

test("step 15 integration parentfix2: a fragmented message is consumed by the receive that completes its frame", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	// A status line split across two data events: production processes it only
	// when the LF arrives, so a request in the FIRST receive consumed nothing.
	const contexts = [
		{ receiveId: 1, at: 100, text: '{"type":"sta' },
		{ receiveId: 2, at: 105, text: 'tus","synthetic":true}\n' },
	];
	const boundaries = scenario.receiveContextMessages(contexts);
	const msgs1 = boundaries.get(1) ?? [];
	const msgs2 = boundaries.get(2) ?? [];
	assert.equal(msgs1.length, 0, "an incomplete line is not a consumed message");
	assert.equal(msgs2.length, 1);
	assert.equal(msgs2[0].type, "status");
	assert.equal(msgs2[0].fragmented, true, "the message began in an earlier receive");
	const requests = [
		{ seq: 0, at: 100, force: false, scheduled: true, entry: "socket-control", receiveId: 1, stack: "synthetic" },
		{ seq: 1, at: 105, force: false, scheduled: true, entry: "socket-control", receiveId: 2, stack: "synthetic" },
	];
	const linked = scenario.attributeSocketRequests(requests, { receiveContexts: contexts, rxMessages: [] });
	assert.equal(linked[0].entry, "unknown", "a receive that consumed no eligible control cannot acquire a cause");
	assert.equal(linked[1].entry, "status");
});

test("step 15 integration parentfix2: an unlinked request near a status receive stays unknown (no nearest-message fallback)", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	// A request whose stack shows the receive path but which carries NO receive
	// context identity (harness gap) must not inherit a nearby status message.
	const requests = [{ seq: 0, at: 100, force: false, scheduled: true, entry: "socket-control", receiveId: null, stack: "synthetic onSocketData" }];
	const rxMessages = [{ at: 99.5, type: "status", msg: { type: "status" }, chunkIndex: 0 }];
	const linked = scenario.attributeSocketRequests(requests, { receiveContexts: [], rxMessages });
	assert.equal(linked[0].entry, "unknown", "missing receive context is unknown, never a time-heuristic guess");
});

test("step 15 integration parentfix2: the receive-context wrapper delegates unchanged and always restores context", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const calls = [];
	const fake = {
		marker: "THIS",
		onSocketData(text) {
			calls.push([this.marker, text]);
			if (text === "boom") throw new Error("synthetic throw");
			return `ret:${text}`;
		},
	};
	const contexts = [];
	const state = scenario.installReceiveContextLogger(fake, contexts);
	const returned = fake.onSocketData("hello");
	assert.equal(returned, "ret:hello", "the original return value passes through");
	assert.deepEqual(calls, [["THIS", "hello"]], "the original this/arguments are preserved");
	assert.equal(state.currentId, null, "context is restored after a normal call");
	assert.throws(() => fake.onSocketData("boom"), /synthetic throw/, "the original throw propagates unchanged");
	assert.equal(state.currentId, null, "context is restored even when the handler throws");
	assert.equal(contexts.length, 2, "every receive call is logged with its exact text");
	assert.equal(contexts[0].text, "hello");
	assert.equal(contexts[1].receiveId, 2);
});

// ---------------------------------------------------------------------------
// Issue #222 step 16 recovery1 (task-16-recovery1-brief.md): producer
// contract regressions for the additive "cold"/"theme"/"resize" scripts and
// the new tx-logger helper. Everything below the accepted 44-test section;
// no earlier test, hash pin or expectation is weakened.
// ---------------------------------------------------------------------------

test("step 16 producer: cold script emits no seed and closes the declared 22-row E1 editor contract on command", async (t) => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	// Declared independent contract (task-16-brief.md): 22 rows, TAIL at index
	// 19, INPUT at index 21, hidden cursor parked at (10,21).
	const literal = scenario.s16EditorRowsText("E1");
	assert.equal(literal.length, PRODUCER_ROWS, "the declared editor contract spans the full 22-row work area");
	assert.equal(literal[19], "E1 TAIL assistant final answer", "TAIL is row 19");
	assert.equal(literal[21], "E1 INPUT >", "INPUT is row 21");
	const h = spawnControlledChild(t, "cold");
	// No seed: the child must be silent until commanded (empty baseline).
	await new Promise((resolveHold) => setTimeout(resolveHold, 200));
	assert.equal(h.stdout(), "", "cold script emits no seed frame");
	assert.equal(frames(h.observer).length, 0, "no frame exists before any command");

	h.send({ cmd: "step", step: 1 });
	await waitForProducerWrite(h, 1, "cold step 1 (boot text)");
	assert.ok(h.stdout().includes("fake pi boot: core ready\r\n"), "boot text is unframed plain output");
	assert.equal(frames(h.observer).length, 0, "boot text never forms a synchronized frame");

	h.send({ cmd: "step", step: 2 });
	await waitForProducerWrite(h, 2, "cold step 2 (input-mode enable)");
	assert.ok(h.stdout().includes("\x1b[?1049h\x1b[?2004h"), "alt-screen + bracketed-paste enable, no editor content");
	assert.equal(frames(h.observer).length, 0, "mode enable is not a frame");

	h.send({ cmd: "step", step: 3 });
	await waitForProducerWrite(h, 3, "cold step 3 (open editor upper half)");
	assert.equal(frames(h.observer).length, 0, "an open editor frame must not be observable as complete");
	const mixed = rawRows(h.raw);
	assert.equal(mixed[0], "E1 HEADER controlled cold editor", "upper half parsed while the frame is open");
	assert.equal(mixed[11], "", "lower half is still unpainted while the frame is open");

	h.send({ cmd: "step", step: 4 });
	await waitFor(() => frames(h.observer).length >= 1, 5000, "closed E1 editor frame");
	await settleProducer(h);
	const closed = frames(h.observer)[0];
	assert.deepEqual(producerFrameRows(closed), literal, "the closed editor is the complete declared 22-row E1 contract");
	assert.deepEqual(producerFrameCursor(closed), PRODUCER_CURSOR, "hidden cursor parked after the INPUT prompt");
	assert.deepEqual(rawRows(h.raw), literal, "the live grid agrees with the closed editor frame");

	h.send({ cmd: "exit" });
	assert.equal(await waitForChildExit(h.child, 5000, "cold child exit"), 0);
	const events = readProducerEvents(h.eventsPath);
	assert.deepEqual(
		events.filter((event) => ["command", "stdout-write", "exit"].includes(event.event)).map((event) => `${event.event}:${event.step ?? ""}`),
		["command:1", "stdout-write:1", "command:2", "stdout-write:2", "command:3", "stdout-write:3", "command:4", "stdout-write:4", "command:", "exit:"],
		"cold events: no seed write; each command strictly precedes its write; then exit",
	);
	assert.deepEqual(
		producerWrites(events).map((write) => write.phase),
		["boot", "input-mode", "open", "closed"],
		"phase identities are explicit",
	);
	auditProducerWrites(events, h.stdout());
	assert.ok(!h.stdout().includes(PRODUCER_RS) && !h.stdout().includes('"cmd"'), "no control echo");
});

test("step 16 producer: theme script seeds T0 with bracketed paste and repaints once per real 997 report", async (t) => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const t0Literal = scenario.s16ThemeRowsText("T0", "pending");
	const t1Literal = scenario.s16ThemeRowsText("T1", "dark applied");
	const h = spawnControlledChild(t, "theme");
	await waitFor(() => frames(h.observer).length >= 1, 5000, "theme T0 seed frame");
	await settleProducer(h);
	assert.deepEqual(producerFrameRows(frames(h.observer)[0]), t0Literal, "the seed is the complete literal T0 surface");
	assert.ok(h.stdout().includes("\x1b[?2004h"), "the seed enables bracketed paste so the attach's live-bytes readiness scan can observe it");

	// A real color-scheme report on stdin (CSI ? 997 ; 1 n = dark) triggers
	// exactly one child-originated complete repaint.
	h.sendRaw("\x1b[?997;1n");
	await waitFor(() => frames(h.observer).length >= 2, 5000, "T1 repaint after the 997 report");
	await settleProducer(h);
	assert.deepEqual(producerFrameRows(frames(h.observer)[1]), t1Literal, "the repaint is the literal T1 dark-applied surface");
	const events = readProducerEvents(h.eventsPath);
	assert.equal(events.filter((event) => event.event === "theme-report").length, 1, "exactly one theme-report event");
	assert.equal(events.find((event) => event.event === "theme-report").scheme, "dark");
	assert.equal(producerWrites(events).filter((write) => write.phase === "theme-repaint").length, 1, "exactly one repaint write");
	// A step command is rejected (the theme script advances on reports only).
	h.send({ cmd: "step", step: 1 });
	await waitFor(() => readProducerEvents(h.eventsPath).some((event) => event.event === "command-rejected"), 5000, "theme step rejection");
	assert.equal(producerWrites(readProducerEvents(h.eventsPath)).filter((write) => write.phase === "theme-repaint").length, 1, "a rejected step repaints nothing");

	h.send({ cmd: "exit" });
	assert.equal(await waitForChildExit(h.child, 5000, "theme child exit"), 0);
	auditProducerWrites(readProducerEvents(h.eventsPath), h.stdout());
	assert.ok(!h.stdout().includes(PRODUCER_RS) && !h.stdout().includes('"cmd"'), "no control echo");
});

test("step 16 producer: resize script refuses to run without observable PTY dimensions", async (t) => {
	// Plain pipes expose no process.stdout.columns/rows: an honest refusal
	// (exit 3, no stdout) proves dims are genuinely observed, never invented.
	const dir = mkdtempSync(join(tmpdir(), "step16-resize-refusal-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const child = spawn(process.execPath, [resolve("test-support/fake-pty-pi.mjs")], {
		env: {
			...process.env,
			FAKE_PTY_STREAM_MODE: "controlled-frames",
			FAKE_PTY_CONTROLLED_SCRIPT: "resize",
			FAKE_PTY_EVENTS_PATH: join(dir, "events.jsonl"),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	registerOwnedChild(t, child);
	let out = "";
	let err = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		out += chunk;
	});
	child.stderr.on("data", (chunk) => {
		err += chunk;
	});
	assert.equal(await waitForChildExit(child, 5000, "resize refusal exit"), 3, "missing PTY dimensions fail explicitly");
	assert.equal(out, "", "a refused geometry child writes no seed or partial frame");
	assert.ok(err.includes("observable dimensions"), `stderr must name the missing observation (got ${JSON.stringify(err)})`);
});

test("step 16 recovery: the tx logger wraps the current socket immediately and restores it on detach", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const calls = [];
	const fakeSocket = {
		write(...args) {
			calls.push(args);
			return "ORIGINAL-RETURN";
		},
	};
	const original = fakeSocket.write;
	const txLog = [];
	const detach = scenario.attachSocketTxLogger({ socket: fakeSocket }, txLog);
	try {
		const returned = fakeSocket.write("FIRST-LINE\n");
		assert.equal(returned, "ORIGINAL-RETURN", "the original return value passes through");
		assert.equal(txLog.length, 1, "the already-present socket is observed immediately, not after the first poll interval");
		assert.equal(txLog[0].data, "FIRST-LINE\n");
		assert.deepEqual(calls, [["FIRST-LINE\n"]], "the original write received the unchanged arguments");
	} finally {
		detach();
	}
	assert.equal(fakeSocket.write, original, "detach restores the original socket.write");
	fakeSocket.write("AFTER-DETACH\n");
	assert.equal(txLog.length, 1, "nothing is logged after detach");
});

// ---------------------------------------------------------------------------
// Issue #222 step 16 conditionfix1 (task-16-conditionfix1-brief.md): pure
// behavioral regressions for the exported analyzeA4Predicates seam
// (P16-COND-1/P16-CAUSE-1). Tri-state verdicts: REFUTED only with a retained
// counterexample witness, CONSISTENT only with resolved non-refuting
// witnesses (never a sufficiency proof), UNKNOWN for missing/ambiguous
// evidence. Synthetic plain-data inputs only; no runner, child or clock
// conversion. Geometry correctness and frame-ID occurrence are separate;
// inner timestamps and outer commit timestamps are never conflated into a
// causal identity.
// ---------------------------------------------------------------------------

const S16C_SHA = {
	open: "aa".repeat(32),
	close: "bb".repeat(32),
	g2: "cc".repeat(32),
	other: "dd".repeat(32),
};

function s16cInput(overrides = {}) {
	return {
		ack: { at: 100, commandId: "c-1", cols: 80, rows: 22 },
		innerLog: [],
		childWrites: [],
		targetGeometry: { cols: 80, rows: 22 },
		targetFrameId: "G2",
		outerFrames: [],
		targetLiteralRows: ["TARGET-ROW"],
		targetCommitIndex: null,
		...overrides,
	};
}

/** The attempt3-shaped retained trace (ordered inner log + child writes). */
function s16cAttempt3Like() {
	return s16cInput({
		innerLog: [
			{ kind: "enqueue", at: 550.5, bytes: 3814, sha256: S16C_SHA.other }, // runner-synthesized hydrate, no child write
			{ kind: "csi-close", at: 553.2, matched: false },
			{ kind: "drain", at: 553.2, sha256: S16C_SHA.other },
			{ kind: "enqueue", at: 560.8, bytes: 339, sha256: S16C_SHA.open },
			{ kind: "csi-open", at: 562.0, alreadyOpen: false },
			{ kind: "drain", at: 562.1, sha256: S16C_SHA.open }, // drains with the sync block still OPEN
			{ kind: "enqueue", at: 816.1, bytes: 326, sha256: S16C_SHA.close },
			{ kind: "csi-close", at: 819.5, matched: true },
			{ kind: "drain", at: 819.5, sha256: S16C_SHA.close },
			{ kind: "enqueue", at: 1062.5, bytes: 505, sha256: S16C_SHA.g2 },
			{ kind: "csi-open", at: 1064.1, alreadyOpen: false },
			{ kind: "csi-close", at: 1064.2, matched: true },
			{ kind: "drain", at: 1064.3, sha256: S16C_SHA.g2 },
		],
		childWrites: [
			{ writeIndex: 1, frame: "G1", phase: "open-stale", bytes: 339, sha256: S16C_SHA.open, dimsUsed: { cols: 120, rows: 28, basis: "stale-seed" } },
			{ writeIndex: 2, frame: "G1", phase: "closed-stale", bytes: 326, sha256: S16C_SHA.close, dimsUsed: { cols: 120, rows: 28, basis: "stale-seed" } },
			{ writeIndex: 3, frame: "G2", phase: "closed-live", bytes: 505, sha256: S16C_SHA.g2, dimsUsed: { cols: 80, rows: 22, basis: "live-pty" } },
		],
	});
}

test("step 16 conditionfix: missing close/open/drain evidence is UNKNOWN, never a verdict", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const result = scenario.analyzeA4Predicates(s16cInput());
	assert.equal(result.predicates[0].verdict, "UNKNOWN", "no matched close after the ack is not a refutation");
	assert.equal(result.predicates[1].verdict, "UNKNOWN", "no post-ack open is not positive evidence");
	assert.equal(result.predicates[2].verdict, "UNKNOWN", "no post-ack drain is not a constant false");
	const noAck = scenario.analyzeA4Predicates(s16cInput({ ack: null, innerLog: s16cAttempt3Like().innerLog, childWrites: s16cAttempt3Like().childWrites }));
	for (const p of noAck.predicates) {
		assert.equal(p.verdict, "UNKNOWN", `${p.id}: without an applied-ack anchor every verdict is UNKNOWN`);
		assert.equal(p.evidence.reason, "no-applied-ack-anchor");
	}
});

test("step 16 conditionfix: a complete target-geometry frame with a different frame id is not rejected", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const result = scenario.analyzeA4Predicates(
		s16cInput({
			innerLog: [
				{ kind: "enqueue", at: 150, bytes: 100, sha256: S16C_SHA.other },
				{ kind: "csi-open", at: 155, alreadyOpen: false },
				{ kind: "csi-close", at: 160, matched: true },
				{ kind: "drain", at: 161, sha256: S16C_SHA.other },
			],
			childWrites: [{ writeIndex: 9, frame: "G9", phase: "closed-live", bytes: 100, sha256: S16C_SHA.other, dimsUsed: { cols: 80, rows: 22, basis: "live-pty" } }],
		}),
	);
	assert.equal(result.predicates[0].verdict, "CONSISTENT", "a target-geometry close must not be rejected merely for differing from the future G2 frame id");
	assert.equal(result.predicates[0].evidence.witnesses[0].frame, "G9");
	assert.equal(result.predicates[0].evidence.witnesses[0].geometryMatch, true);
	assert.equal(result.predicates[1].verdict, "CONSISTENT");
	assert.equal(result.predicates[2].verdict, "CONSISTENT", "the only drain completed a fully closed frame");
	for (const p of result.predicates) {
		assert.match(p.evidence.note, /not a sufficiency proof/, `${p.id}: CONSISTENT never claims universal sufficiency`);
	}
});

test("step 16 conditionfix: the retained stale-geometry trace refutes via unique byte identity, with per-witness separation", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const result = scenario.analyzeA4Predicates(s16cAttempt3Like());
	const [p1, p2, p3] = result.predicates;
	assert.equal(p1.verdict, "REFUTED");
	assert.equal(p1.evidence.counterexample.writeSha256, S16C_SHA.close, "the refuting close is identified by the retained write sha, not by temporal proximity");
	assert.deepEqual(p1.evidence.counterexample.dimsUsed, { cols: 120, rows: 28, basis: "stale-seed" });
	assert.deepEqual(p1.evidence.counterexample.geometryMismatch, { expected: { cols: 80, rows: 22 }, actual: { cols: 120, rows: 28 } });
	assert.equal(p1.evidence.counterexample.closeAt, 819.5);
	assert.ok(p1.evidence.witnesses.some((w) => w.frame === "G2" && w.role === "consistent"), "the later live-geometry G2 close is reported as a separate consistent witness");
	assert.equal(p2.verdict, "REFUTED");
	assert.equal(p2.evidence.counterexample.writeSha256, S16C_SHA.open);
	assert.equal(p2.evidence.counterexample.openAt, 562.0);
	assert.equal(p3.verdict, "REFUTED");
	assert.equal(p3.evidence.counterexample.writeSha256, S16C_SHA.open);
	assert.equal(p3.evidence.counterexample.drainAt, 562.1);
	assert.equal(p3.evidence.counterexample.syncOpenAtDrain, true, "the G1-open write drained while its frame was still open — a drain cannot attest a complete redraw");
	// P16-CAUSE-1: no temporal outer-frame selection remains in the evidence.
	for (const p of result.predicates) {
		assert.ok(!("closeFrameIndex" in p.evidence) && !("closeFrameRows" in p.evidence), `${p.id}: no nearest-after outer frame is donated as causal identity`);
	}
	// The incorrect outer grids stay as separate factual records with unknown
	// causal identity and their own commit timestamps.
	const facts = result.outerCommitFacts;
	assert.ok(Array.isArray(facts) && facts.length === 0, "this synthetic input carries no outer frames");
});

test("step 16 conditionfix: outer commit facts keep actual timestamps and unknown causal identity", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const input = s16cAttempt3Like();
	input.outerFrames = [
		{ index: 23, boundaryParsedAt: 817.9, rows: ["MIXED G1/G0 GRID"] },
		{ index: 26, boundaryParsedAt: 866.7, rows: ["STALE G1 GRID"] },
		{ index: 32, boundaryParsedAt: 1110.1, rows: ["TARGET-ROW"] },
	];
	input.targetCommitIndex = 32;
	const result = scenario.analyzeA4Predicates(input);
	assert.deepEqual(
		result.outerCommitFacts.map((f) => [f.index, f.boundaryParsedAt, f.matchesTargetLiteral, f.causalIdentity]),
		[
			[23, 817.9, false, "unknown"],
			[26, 866.7, false, "unknown"],
		],
		"pre-target outer commits are factual records with their own times; no inner close is named as their cause",
	);
});

test("step 16 conditionfix: uninstrumented parse boundaries and inconsistent logs stay UNKNOWN", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	// A matched close parsed while no enqueue is pending (e.g. the constructor
	// screen.log replay predates instrumentation): identity unknown.
	const uninstrumented = scenario.analyzeA4Predicates(
		s16cInput({ innerLog: [{ kind: "csi-close", at: 200, matched: true }] }),
	);
	assert.equal(uninstrumented.predicates[0].verdict, "UNKNOWN");
	assert.equal(uninstrumented.predicates[0].evidence.identityStatus, "unknown-uninstrumented");
	assert.ok(uninstrumented.innerIdentity.unknownBoundaryCount >= 1);
	// A drain whose sha does not match the front enqueue makes the whole log
	// inconsistent: no identity-based verdict may survive it.
	const inconsistent = scenario.analyzeA4Predicates(
		s16cInput({
			innerLog: [
				{ kind: "enqueue", at: 150, bytes: 10, sha256: S16C_SHA.open },
				{ kind: "drain", at: 160, sha256: S16C_SHA.close }, // mismatch
				{ kind: "enqueue", at: 170, bytes: 10, sha256: S16C_SHA.g2 },
				{ kind: "csi-close", at: 180, matched: true },
				{ kind: "drain", at: 181, sha256: S16C_SHA.g2 },
			],
			childWrites: [{ writeIndex: 3, frame: "G2", phase: "closed-live", bytes: 10, sha256: S16C_SHA.g2, dimsUsed: { cols: 80, rows: 22, basis: "live-pty" } }],
		}),
	);
	assert.equal(inconsistent.innerIdentity.logConsistent, false);
	for (const p of inconsistent.predicates) {
		assert.equal(p.verdict, "UNKNOWN", `${p.id}: an inconsistent inner log donates no identity`);
		assert.equal(p.evidence.reason, "inner-log-inconsistent");
	}
});

// ---------------------------------------------------------------------------
// Issue #222 step 16 A5 continuation (task-16-a5-continuation-brief.md):
// P16-EDGE-1 narrow guards on the pure A4 seam, proven by the parent's
// executed pure edge probes (task-16-conditionfix1-parent-edge-probes.json,
// synthetic — NOT trials). Guard 1: conflicting duplicate child hashes are
// ambiguous, never last-wins. Guard 2: P3 includes geometry (a closed STALE
// frame is a counterexample, not CONSISTENT). Guard 3: syncOpenAtDrain is
// the actual ordered observed state across writes, not per-write counts.
// ---------------------------------------------------------------------------

test("step 16 a5-guard: conflicting duplicate child hashes are ambiguous in either order", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const dupSha = "ab".repeat(32);
	const stale = { writeIndex: 1, frame: "G1", phase: "closed-stale", bytes: 10, sha256: dupSha, dimsUsed: { cols: 120, rows: 28, basis: "stale-seed" } };
	const live = { writeIndex: 2, frame: "G2", phase: "closed-live", bytes: 10, sha256: dupSha, dimsUsed: { cols: 80, rows: 22, basis: "live-pty" } };
	const innerLog = [
		{ kind: "enqueue", at: 150, bytes: 10, sha256: dupSha },
		{ kind: "csi-open", at: 155, alreadyOpen: false },
		{ kind: "csi-close", at: 160, matched: true },
		{ kind: "drain", at: 161, sha256: dupSha },
	];
	for (const childWrites of [
		[stale, live],
		[live, stale],
	]) {
		const result = scenario.analyzeA4Predicates(s16cInput({ innerLog, childWrites }));
		for (const p of result.predicates) {
			assert.equal(p.verdict, "UNKNOWN", `${p.id}: a conflicting duplicate hash must not pick a source in either order`);
		}
		const witness = result.predicates[0].evidence.witnesses?.[0] ?? result.predicates[0].evidence;
		assert.equal(witness.identityStatus ?? result.predicates[0].evidence.identityStatus, "ambiguous-hash");
		assert.equal((witness.candidates ?? []).length ?? 0, 2, "both conflicting candidates are retained");
	}
});

test("step 16 a5-guard: a closed STALE-geometry frame drain refutes P3 (geometry participates)", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const staleSha = "cd".repeat(32);
	const result = scenario.analyzeA4Predicates(
		s16cInput({
			innerLog: [
				{ kind: "enqueue", at: 150, bytes: 10, sha256: staleSha },
				{ kind: "csi-open", at: 155, alreadyOpen: false },
				{ kind: "csi-close", at: 160, matched: true },
				{ kind: "drain", at: 161, sha256: staleSha },
			],
			childWrites: [{ writeIndex: 2, frame: "G1", phase: "closed-stale", bytes: 10, sha256: staleSha, dimsUsed: { cols: 120, rows: 28, basis: "stale-seed" } }],
		}),
	);
	const p3 = result.predicates[2];
	assert.equal(p3.verdict, "REFUTED", "a completely closed but stale-geometry write still refutes the target-size drain predicate");
	assert.equal(p3.evidence.counterexample.writeSha256, staleSha);
	assert.deepEqual(p3.evidence.counterexample.geometryMismatch, { expected: { cols: 80, rows: 22 }, actual: { cols: 120, rows: 28 } });
});

test("step 16 a5-guard: a same-write close-then-open leaves the parser open at drain (ordered cross-write state)", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const openSha = "ef".repeat(32);
	const closeOpenSha = "ab".repeat(32);
	const result = scenario.analyzeA4Predicates(
		s16cInput({
			ack: { at: 100, commandId: "c-1", cols: 80, rows: 22 },
			innerLog: [
				// Pre-ack: a write opens a frame and drains WITHOUT closing it — the
				// parser stays open ACROSS the write boundary.
				{ kind: "enqueue", at: 60, bytes: 10, sha256: openSha },
				{ kind: "csi-open", at: 62, alreadyOpen: false },
				{ kind: "drain", at: 63, sha256: openSha },
				// Post-ack: one write closes the old frame and opens the next.
				{ kind: "enqueue", at: 150, bytes: 10, sha256: closeOpenSha },
				{ kind: "csi-close", at: 155, matched: true },
				{ kind: "csi-open", at: 156, alreadyOpen: false },
				{ kind: "drain", at: 160, sha256: closeOpenSha },
			],
			childWrites: [
				{ writeIndex: 1, frame: "G1", phase: "open", bytes: 10, sha256: openSha, dimsUsed: { cols: 80, rows: 22, basis: "live-pty" } },
				{ writeIndex: 2, frame: "G1>G2", phase: "close-open", bytes: 10, sha256: closeOpenSha, dimsUsed: { cols: 80, rows: 22, basis: "live-pty" } },
			],
		}),
	);
	const p3 = result.predicates[2];
	assert.equal(p3.verdict, "REFUTED", "a drain while the parser is actually inside a sync block refutes the complete-redraw predicate");
	assert.equal(p3.evidence.counterexample.writeSha256, closeOpenSha);
	assert.equal(p3.evidence.counterexample.syncOpenAtDrain, true, "ordered state (close then open), not equal per-write counts");
	assert.equal(p3.evidence.counterexample.matchedClosesInWrite, 1, "the write DID close the old frame — per-write counts alone would hide the open state");
});

test("step 16 a5-guard: a complete target-geometry drain stays CONSISTENT (guards do not over-refute)", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const goodSha = "aa".repeat(32);
	const result = scenario.analyzeA4Predicates(
		s16cInput({
			innerLog: [
				{ kind: "enqueue", at: 150, bytes: 10, sha256: goodSha },
				{ kind: "csi-open", at: 155, alreadyOpen: false },
				{ kind: "csi-close", at: 160, matched: true },
				{ kind: "drain", at: 161, sha256: goodSha },
			],
			childWrites: [{ writeIndex: 3, frame: "G2", phase: "closed-live", bytes: 10, sha256: goodSha, dimsUsed: { cols: 80, rows: 22, basis: "live-pty" } }],
		}),
	);
	assert.equal(result.predicates[2].verdict, "CONSISTENT");
	assert.match(result.predicates[2].evidence.note, /not a sufficiency proof/);
});

test("step 16 theme-final: the CLI wires A4/A5/T timings while a genuinely unsupported case stays rejected", () => {
	// Compatibility exception (task-16-theme-final-brief.md): T-on-time/T-late
	// are now SUPPORTED, so the previous version's T-on-time rejection input is
	// obsolete. "Q" is genuinely unsupported; the exit-2/stderr/no-stdout
	// assertions are unchanged. Spawn-level check (parseCli exits the process).
	const artifactDir = mkdtempSync(join(tmpdir(), "s16t-cli-"));
	try {
		const rejected = s15RunScenario(["--case", "Q", "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir], 30_000);
		assert.equal(rejected.status, 2, "a genuinely unsupported case must stay rejected");
		assert.match(rejected.stderr ?? "", /unsupported --case/);
		assert.equal((rejected.stdout ?? "").trim(), "", "a rejected invocation prints no dummy success");
	} finally {
		rmSync(artifactDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Issue #222 step 16 theme-final: the stage-correct coverage helper. Stage
// boundaries come from the EXACT observer write containing EXIT_ALT_SCREEN;
// stop-stage observations must equal the source-grounded full 24-row layout
// (22 content rows + footer at 22 + blank 23, visible cursor (0,23)) — and
// the shifted stop layout must never be tolerated in the ACTIVE stage.
// ---------------------------------------------------------------------------

function s16tObs(index, rows24, cursor, closeWriteIndex, kind = "frame") {
	return {
		index,
		kind,
		openWriteIndex: closeWriteIndex,
		closeWriteIndex,
		openParsedAt: index,
		boundaryParsedAt: index,
		note: null,
		cols: 80,
		rows: 24,
		baseY: 0,
		cursor,
		grid: Array.from({ length: 24 }, (_, y) => ({ text: rows24[y] ?? "", cells: [] })),
	};
}

test("step 16 theme-final: staged analysis separates active oracle from the source-grounded stop layout", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const content = scenario.s16EditorRowsText("E1");
	// Active observation: full chrome + literal content at the work area.
	const activeRows = [scenario.HEADER_BY_STATUS.attached, ...content, scenario.FOOTER_ROW];
	const activeObs = s16tObs(0, activeRows, { x: 10, y: 22, absoluteY: 22, visible: false }, 5);
	// Stop-stage observation: document scrolled up one row by the final CRLF,
	// cursor visible at (0,23) — the source-grounded default-stop layout.
	const stopRows = [...content, scenario.FOOTER_ROW, ""];
	const stopObs = s16tObs(1, stopRows, { x: 0, y: 23, absoluteY: 23, visible: true }, 20);
	// The stop write's own sync-entry window: pre-stop content with the stop
	// sequence's showCursor already queued — rows must still be the final
	// content, the cursor is stop-contract data (visible here).
	const stopEntryObs = { ...s16tObs(2, activeRows, { x: 10, y: 22, absoluteY: 22, visible: true }, 14, "unframed"), note: "sync-entry", openWriteIndex: -1, closeWriteIndex: 20 };
	const writes = [
		{ index: 5, data: "ordinary frame write" },
		{ index: 20, data: "\x1b[?2026h\x1b[?1049l...\x1b[0m\x1b[7C\r\n\x1b[?25h\x1b[?2026l" },
	];
	const result = scenario.analyzeStagedObservations({
		observations: [activeObs, stopEntryObs, stopObs],
		writes,
		finalContentRows: content,
		activeExpectation: scenario.s16Expectation([scenario.s16ContentScreen("e1-complete", content, ["E1"], scenario.S16_SURFACE_CURSOR)], ["E1"]),
	});
	assert.deepEqual(result.stopWriteIndices, [20], "the stage boundary is the exact EXIT_ALT_SCREEN write");
	assert.equal(result.observationCounts.active, 1);
	assert.equal(result.observationCounts.stopEntry, 1, "the stop write's sync-entry window is its own stage");
	assert.equal(result.observationCounts.stopStage, 1);
	assert.equal(result.stopStage.violations.length, 0, "the source-grounded stop layout passes with cursor included");
	assert.equal(result.stopEntry.violations.length, 0, "the stop-entry window keeps the final-content rows; its visible cursor is stop-contract data");
	assert.equal(result.stopEntry.results[0].actualCursor.visible, true);
	assert.equal(result.activeFailures.length, 0, "a clean active stage passes the ordered oracle");
	// A shifted stop layout must NEVER pass while attached: the same rows in an
	// ACTIVE frame (no stop write yet) fail the active oracle/chrome contract.
	const shiftedActive = scenario.analyzeStagedObservations({
		observations: [s16tObs(0, stopRows, { x: 0, y: 23, absoluteY: 23, visible: true }, 5)],
		writes: [{ index: 5, data: "ordinary frame write" }],
		finalContentRows: content,
		activeExpectation: scenario.s16Expectation([scenario.s16ContentScreen("e1-complete", content, ["E1"], scenario.S16_SURFACE_CURSOR)], ["E1"]),
	});
	assert.ok(shiftedActive.activeFailures.length > 0 || shiftedActive.chromeViolations.length > 0, "the shifted stop layout is rejected while attached");
});

// ---------------------------------------------------------------------------
// Issue #222 step 17 (task-17-brief.md): SDD Task-3 FOUNDATION ONLY.
//
// (a) The accepted step-16 cleanup defect (task-16-acceptance.md "cleanup
// corner"): killOwnedDiagProcesses recorded childAliveAfter=false /
// runnerAliveAfter=false when the child/runner pid was UNKNOWN — false
// known-dead evidence. The fixed helper records UNKNOWN (null) for missing
// or unknown pids, signals ONLY an owned handle with a known pid, and
// distinguishes known pid, exit status/signal, forced cleanup and root
// ownership. The tests below drive the exported helper ONLY through injected
// liveness/process seams: no test here probes or signals a real pid, and no
// wall-clock wait is taken (the sleep seam resolves immediately).
// (b) Deterministic foundation coverage pinned for the first time: the
// controlled fixture's generation identity (distinct literal identity per
// generation carried in the HISTORY/TAIL/INPUT marker rows) and the
// planted-poison non-vacuity check (a "poison never visible" scan is
// meaningful only when the plant is PROVEN).
// ---------------------------------------------------------------------------

// A fake owned runner handle: records kill calls, lets the test decide the
// exit outcome. Never a real child process.
function s17FakeRunner(opts = {}) {
	// Explicit sentinel handling: `pid: undefined` must stay undefined (the
	// spawn-failure shape); defaults apply only when the key is absent.
	const pid = "pid" in opts ? opts.pid : 1234;
	const exitCode = "exitCode" in opts ? opts.exitCode : null;
	const signalCode = "signalCode" in opts ? opts.signalCode : null;
	const onKill = "onKill" in opts ? opts.onKill : null;
	const runner = {
		pid,
		exitCode,
		signalCode,
		killCalls: [],
		exitHandlers: [],
		kill(signal) {
			runner.killCalls.push(signal);
			if (onKill) onKill(runner);
			return true;
		},
		once(event, cb) {
			if (event === "exit") runner.exitHandlers.push(cb);
			return runner;
		},
		emitExit() {
			for (const cb of runner.exitHandlers.splice(0)) cb();
		},
	};
	return runner;
}

// Deterministic seam bundle: liveness is an explicit pid->boolean map the
// test owns; kill calls are recorded; sleep resolves immediately.
function s17Seams({ alive = {}, readChildPid = () => null } = {}) {
	const state = { alive: new Map(Object.entries(alive).map(([pid, isAlive]) => [Number(pid), isAlive])) };
	const calls = { isAlive: [], kill: [] };
	return {
		calls,
		state,
		seams: {
			isAlive(pid) {
				calls.isAlive.push(pid);
				assert.equal(typeof pid, "number", "liveness probes must always carry a real numeric pid");
				return state.alive.get(pid) === true;
			},
			kill(pid, signal) {
				calls.kill.push([pid, signal]);
				assert.equal(typeof pid, "number", "only a known numeric pid may be signalled");
			},
			readChildPid,
			async sleep() {},
		},
	};
}

test("step 17 cleanup: unknown child pid and absent runner are UNKNOWN, never known-dead", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const { calls, seams } = s17Seams({ readChildPid: () => null }); // host.json missing/unreadable
	const cleanup = scenario.createDiagCleanup();
	await scenario.killOwnedDiagProcesses(null, "/nonexistent-root", "v-unknown", cleanup, seams);
	assert.equal(cleanup.childPid, null, "no child pid could be read");
	assert.equal(cleanup.childAliveAfter, null, "an unknown child pid is UNKNOWN, never recorded known-dead");
	assert.equal(cleanup.runnerPid, null, "there is no runner handle");
	assert.equal(cleanup.runnerAliveAfter, null, "an absent runner handle is UNKNOWN, never recorded known-dead");
	assert.deepEqual(cleanup.forcedKills, [], "nothing owned-and-known exists to kill");
	assert.deepEqual(calls.kill, [], "no pid was signalled");
	assert.deepEqual(calls.isAlive, [], "no pid was even probed");
	// A host-observed natural exit remains valid termination evidence even when
	// the pid is unknown; UNKNOWN liveness alone must never yield ok.
	const exited = scenario.createDiagCleanup();
	exited.childExited = true;
	exited.runnerExited = true;
	exited.rootRemoved = true;
	assert.equal(scenario.diagCleanupOk(exited), true, "host-reported exits + removed root prove cleanup");
	assert.equal(scenario.diagCleanupOk(cleanup), false, "UNKNOWN liveness (null) never counts as terminated, root not removed here");
	cleanup.rootRemoved = true;
	assert.equal(scenario.diagCleanupOk(cleanup), false, "UNKNOWN liveness blocks ok even with the root removed");
});

test("step 17 cleanup: only the known owned child pid is signalled, and known-dead is recorded only after the kill", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const { calls, state, seams } = s17Seams({ alive: { 4242: true }, readChildPid: () => 4242 });
	const cleanup = scenario.createDiagCleanup();
	const runner = s17FakeRunner({ pid: 5151, exitCode: 0 }); // runner already exited naturally
	await scenario.killOwnedDiagProcesses(runner, "/nonexistent-root", "v-known-child", cleanup, {
		...seams,
		kill(pid, signal) {
			seams.kill(pid, signal);
			state.alive.set(pid, false); // the kill actually took effect
		},
	});
	assert.equal(cleanup.childPid, 4242, "the owned host record's pid is the only child identity used");
	assert.deepEqual(calls.kill, [[4242, "SIGKILL"]], "exactly the known owned child pid is signalled, with SIGKILL only");
	assert.deepEqual(cleanup.forcedKills, ["child:4242"], "forced cleanup names the owned child pid");
	assert.equal(cleanup.childAliveAfter, false, "known-dead is recorded only after the actual kill took effect");
	assert.equal(runner.killCalls.length, 0, "an already-exited runner is never signalled");
	assert.deepEqual(cleanup.forcedKills.filter((entry) => entry.startsWith("runner:")), [], "no runner forced kill");
});

test("step 17 cleanup: a spawn-failed runner handle (no pid) is UNKNOWN and never signalled", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const { calls, seams } = s17Seams({ readChildPid: () => null });
	// Spawn failure shape: the handle exists but has no pid and no exit status.
	const runner = s17FakeRunner({ pid: undefined });
	const cleanup = scenario.createDiagCleanup();
	await scenario.killOwnedDiagProcesses(runner, "/nonexistent-root", "v-spawn-failed", cleanup, seams);
	assert.equal(cleanup.runnerPid, null, "a pidless handle has no known pid");
	assert.equal(cleanup.runnerAliveAfter, null, "an unknown runner pid cannot be proved dead");
	assert.deepEqual(runner.killCalls, [], "a pidless handle is never signalled");
	assert.deepEqual(cleanup.forcedKills, [], "no bogus 'runner:undefined' forced-kill record");
	assert.deepEqual(calls.isAlive, [], "an unknown pid is never probed");
});

test("step 17 cleanup: a naturally exited runner keeps its real exit status and is provably not alive", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const { calls, seams } = s17Seams({ readChildPid: () => 4242 });
	const runner = s17FakeRunner({ pid: 5151, exitCode: 0, signalCode: null });
	const cleanup = scenario.createDiagCleanup();
	cleanup.childExited = true; // the ordered-exit path observed the child exit
	await scenario.killOwnedDiagProcesses(runner, "/nonexistent-root", "v-natural-exit", cleanup, seams);
	assert.equal(cleanup.childAliveAfter, false, "a known child pid that no longer exists is provably not alive");
	assert.equal(cleanup.runnerPid, 5151);
	assert.equal(cleanup.runnerAliveAfter, false, "a runner with a real exit status is provably not alive");
	assert.equal(cleanup.runnerExited, true, "the observed exit status is recorded");
	assert.equal(cleanup.runnerExitCode, 0, "the real exit code is preserved");
	assert.equal(cleanup.runnerExitSignal, null, "no signal terminated it");
	assert.deepEqual(cleanup.forcedKills, [], "natural completion needs no forced cleanup");
	assert.deepEqual(runner.killCalls, [], "no kill was attempted");
	assert.deepEqual(calls.isAlive, [4242, 4242], "only the known child pid is probed (kill check + post-check); the exited runner needs no probe");
	cleanup.rootRemoved = true;
	assert.equal(scenario.diagCleanupOk(cleanup), true, "natural completion + removed root is a clean cleanup");
});

test("step 17 cleanup: a forced runner kill records the SIGKILL signal; a survivor stays recorded ALIVE", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	// (a) The kill takes effect: exit fires with the SIGKILL signal.
	{
		const { state, seams } = s17Seams({ alive: { 4242: false, 5151: true }, readChildPid: () => 4242 });
		const runner = s17FakeRunner({
			pid: 5151,
			onKill: (r) => {
				r.signalCode = "SIGKILL";
				state.alive.set(5151, false);
				setImmediate(() => r.emitExit());
			},
		});
		const cleanup = scenario.createDiagCleanup();
		await scenario.killOwnedDiagProcesses(runner, "/nonexistent-root", "v-forced-ok", cleanup, seams);
		assert.deepEqual(runner.killCalls, ["SIGKILL"]);
		assert.deepEqual(cleanup.forcedKills, ["runner:5151"], "the forced cleanup names the owned runner pid");
		assert.equal(cleanup.runnerAliveAfter, false, "the killed runner is provably not alive");
		assert.equal(cleanup.runnerExited, true);
		assert.equal(cleanup.runnerExitSignal, "SIGKILL", "the forced cleanup is distinguished from a natural exit");
	}
	// (b) The kill does NOT take effect: the process survives — recorded ALIVE,
	// never laundered into known-dead.
	{
		const { seams } = s17Seams({ alive: { 4242: false, 5151: true }, readChildPid: () => 4242 });
		const runner = s17FakeRunner({ pid: 5151 }); // kill is a no-op; exit never fires
		const cleanup = scenario.createDiagCleanup();
		await scenario.killOwnedDiagProcesses(runner, "/nonexistent-root", "v-forced-survivor", cleanup, seams);
		assert.deepEqual(cleanup.forcedKills, ["runner:5151"], "the attempted forced cleanup is still recorded");
		assert.equal(cleanup.runnerAliveAfter, true, "a surviving runner is recorded ALIVE — forced cleanup failed");
		assert.equal(cleanup.runnerExited, false);
		cleanup.rootRemoved = true;
		assert.equal(scenario.diagCleanupOk(cleanup), false, "a surviving owned process means cleanup is NOT ok");
	}
});

test("step 17 cleanup: diagCleanupOk requires proven termination and root disposition", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const base = scenario.createDiagCleanup();
	assert.equal(scenario.diagCleanupOk(base), false, "nothing proven, nothing removed: not ok");
	// Proven-dead liveness (false) is valid termination evidence.
	const provenDead = { ...base, childAliveAfter: false, runnerAliveAfter: false, rootRemoved: true };
	assert.equal(scenario.diagCleanupOk(provenDead), true);
	// Exit observation is valid termination evidence.
	const exited = { ...base, childExited: true, runnerExited: true, rootRetainedForEvidence: true };
	assert.equal(scenario.diagCleanupOk(exited), true, "a root retained for evidence is an explicit disposition");
	// UNKNOWN (null) liveness without an exit observation never terminates.
	assert.equal(scenario.diagCleanupOk({ ...base, childAliveAfter: null, runnerAliveAfter: false, rootRemoved: true }), false);
	assert.equal(scenario.diagCleanupOk({ ...base, childAliveAfter: false, runnerAliveAfter: null, rootRemoved: true }), false);
	// ALIVE processes never terminate.
	assert.equal(scenario.diagCleanupOk({ ...base, childAliveAfter: true, runnerAliveAfter: false, rootRemoved: true }), false);
	// Root disposition is required.
	assert.equal(scenario.diagCleanupOk({ ...base, childAliveAfter: false, runnerAliveAfter: false }), false);
});

test("step 17 poison: planted-poison evidence is PROVEN only with a matched plant readback and a surviving retained log", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	const planted = scenario.S16_POISON_TEXT;
	// Plant landed (readback matched) and the planted text survives in the
	// retained log (append + front-truncate semantics: present at the end means
	// present continuously since planting, including at attach-mount time).
	const proven = scenario.evaluatePoisonPlant({ plantedText: planted, plantReadback: planted, retainedLog: `prefix\n${planted}suffix\n` });
	assert.equal(proven.verdict, "PROVEN");
	assert.equal(proven.plantReadbackMatched, true);
	assert.equal(proven.presentInRetainedLog, true);
	assert.equal(typeof proven.retainedLogSha256, "string");
	// Append-raced readback (review M3 correction): the runner appended child
	// output AFTER the plant write but BEFORE the readback. The plant as a
	// PREFIX of the readback still proves the plant landed — exact equality
	// would falsely report NOT_PROVEN here.
	const raced = scenario.evaluatePoisonPlant({ plantedText: planted, plantReadback: `${planted}fake pi boot: core ready\r\n`, retainedLog: `x${planted}y` });
	assert.equal(raced.plantReadbackMatched, true, "a readback carrying the plant as a prefix is a matched plant");
	assert.equal(raced.verdict, "PROVEN");
	// The plant write itself did not land: any "never visible" scan is vacuous.
	assert.equal(scenario.evaluatePoisonPlant({ plantedText: planted, plantReadback: "garbage", retainedLog: planted }).verdict, "NOT_PROVEN");
	// A readback that LOST the plant prefix (front-truncated or replaced) is
	// not a proven plant, even when some planted bytes survive later.
	assert.equal(scenario.evaluatePoisonPlant({ plantedText: planted, plantReadback: "ON line two\r\n", retainedLog: planted }).verdict, "NOT_PROVEN");
	// The bounded log moved past the planted text: mount-time presence can
	// neither be proven nor disproven from the retained evidence.
	const lost = scenario.evaluatePoisonPlant({ plantedText: planted, plantReadback: planted, retainedLog: "later output only\n" });
	assert.equal(lost.verdict, "UNKNOWN");
	assert.equal(lost.presentInRetainedLog, false);
	// Missing readback or missing retained log: UNKNOWN, never PROVEN.
	assert.equal(scenario.evaluatePoisonPlant({ plantedText: planted, plantReadback: null, retainedLog: planted }).verdict, "UNKNOWN");
	assert.equal(scenario.evaluatePoisonPlant({ plantedText: planted, plantReadback: planted, retainedLog: null }).verdict, "UNKNOWN");
});

test("step 17 foundation: controlled-fixture generations carry distinct literal identity in the HISTORY/TAIL/INPUT marker rows", async () => {
	const scenario = await import("../test-support/pty-attach-ready-scenario.ts");
	// Identity-token rows of the producer contract: HEADER, UPPER history one/
	// two, MIDDLE, LOWER history three/four, TAIL, INPUT (0-based 0,1,2,10,11,
	// 12,19,21). Every other row is blank. The frame/generation token is VISIBLE
	// content, so a consumer distinguishes generations from the grid alone.
	const IDENTITY_ROWS = [0, 1, 2, 10, 11, 12, 19, 21];
	for (const id of ["F0", "F1", "F2"]) {
		const rows = scenario.producerRowsText(id);
		assert.equal(rows.length, 22, "the producer contract spans the full 22-row work area");
		assert.deepEqual(
			rows.map((row) => row.includes(id)),
			Array.from({ length: 22 }, (_, y) => IDENTITY_ROWS.includes(y)),
			`${id}: the generation token occupies exactly the declared identity rows`,
		);
		assert.ok(rows[1].includes("reply history") && rows[19].includes("TAIL") && rows[21].includes("INPUT >"), `${id}: HISTORY/TAIL/INPUT markers are literal content`);
	}
	// Different generations never collide: every pair of fixture literals —
	// across the S frames, the geometry generations, the cold editor and the
	// theme surface — is distinct as content.
	const literals = {
		F0: scenario.producerRowsText("F0"),
		F1: scenario.producerRowsText("F1"),
		F2: scenario.producerRowsText("F2"),
		E1: scenario.s16EditorRowsText("E1"),
		T0: scenario.s16ThemeRowsText("T0", "pending"),
		G2: scenario.s16GeometryRowsText("G2", 80, 22),
	};
	const keys = Object.keys(literals);
	for (let i = 0; i < keys.length; i++) {
		for (let j = i + 1; j < keys.length; j++) {
			assert.notDeepEqual(literals[keys[i]], literals[keys[j]], `${keys[i]} and ${keys[j]} must be distinguishable generations`);
		}
	}
	// Same-geometry generation separation: G0 (seed generation) and G1 (stale
	// generation) at the SAME 120x28 geometry differ ONLY by the generation
	// token — geometry alone cannot stand in for generation identity.
	const g0 = scenario.s16GeometryRowsText("G0", 120, 28);
	const g1 = scenario.s16GeometryRowsText("G1", 120, 28);
	assert.notDeepEqual(g0, g1, "same-size generations are distinct content");
	assert.equal(g0.length, g1.length);
	for (let y = 0; y < g0.length; y++) {
		assert.equal(g0[y].replaceAll("G0", "#GEN#"), g1[y].replaceAll("G1", "#GEN#"), `row ${y}: G0/G1 differ only by the generation token`);
	}
});

// ---------------------------------------------------------------------------
// Issue #222 step 17 fix1 (task-17-review-dispositions.md, ruling I-1): the
// dedicated SESSION-GENERATION fixture child
// (test-support/fake-pty-generation-pi.mjs). The accepted step-15/16 producer
// (fake-pty-pi.mjs) is byte-pinned and carries no session-generation token;
// this NEW child adds one, independent of the frame id: every content row of
// the literal 80x22 grid carries `<generation> <frame-id>` in the declared
// HEADER/UPPER-history/MIDDLE/LOWER-history/TAIL/INPUT marker rows, the
// hidden cursor parks on the cell right after the INPUT prompt, and EVERY
// child event is stamped with the generation. The literal contract below is
// defined independently here — never derived from fixture or scenario code.
// ---------------------------------------------------------------------------

const GEN_COLS = 80;
const GEN_ROWS = 22;
const generationRows = (gen, id) => [
	`${gen} ${id} HEADER controlled generation surface`,
	`${gen} ${id} UPPER reply history one`,
	`${gen} ${id} UPPER reply history two`,
	"",
	"",
	"",
	"",
	"",
	"",
	"",
	`${gen} ${id} MIDDLE divider`,
	`${gen} ${id} LOWER reply history three`,
	`${gen} ${id} LOWER reply history four`,
	"",
	"",
	"",
	"",
	"",
	"",
	`${gen} ${id} TAIL assistant final answer`,
	"",
	`${gen} ${id} INPUT >`,
];
// Explicit cursor contract: hidden, parked on the cell right after the
// `<gen> <id> INPUT >` prompt (row text is right-trimmed when read).
const generationCursor = (gen, id) => ({ x: `${gen} ${id} INPUT >`.length, y: 21, visible: false });

function spawnGenerationChild(t, generation) {
	const dir = mkdtempSync(join(tmpdir(), "step17-gen-"));
	const eventsPath = join(dir, "events.jsonl");
	const child = spawn(process.execPath, [resolve("test-support/fake-pty-generation-pi.mjs")], {
		env: { ...process.env, FAKE_PTY_GENERATION: generation, FAKE_PTY_EVENTS_PATH: eventsPath },
		stdio: ["pipe", "pipe", "pipe"],
	});
	registerOwnedChild(t, child);
	const observer = new AttachPresentationObserver({ cols: GEN_COLS, rows: GEN_ROWS });
	const raw = new xtermHeadless.Terminal({ cols: GEN_COLS, rows: GEN_ROWS, allowProposedApi: true });
	let stdoutAll = "";
	let stderrAll = "";
	let rawChain = Promise.resolve();
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutAll += chunk;
		observer.write(chunk);
		rawChain = rawChain.then(() => new Promise((resolveRaw) => raw.write(chunk, resolveRaw)));
	});
	child.stderr.on("data", (chunk) => {
		stderrAll += chunk;
	});
	t.after(() => {
		observer.dispose();
		raw.dispose();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		child,
		observer,
		raw,
		eventsPath,
		dir,
		stdout: () => stdoutAll,
		stderr: () => stderrAll,
		whenRawIdle: () => rawChain,
		send: (obj) => child.stdin.write(producerCommand(obj)),
		sendRaw: (bytes) => child.stdin.write(bytes),
	};
}

test("step 17 fix1 producer: the generation fixture seeds F0, advances to F1 on command, and stamps every event with its session generation", async (t) => {
	const h = spawnGenerationChild(t, "gen-1");
	await waitFor(() => frames(h.observer).length >= 1, 5000, "generation F0 seed frame");
	await settleProducer(h);
	assert.deepEqual(producerFrameRows(frames(h.observer)[0]), generationRows("gen-1", "F0"), "the seed is the complete literal gen-1 F0 surface");
	assert.deepEqual(producerFrameCursor(frames(h.observer)[0]), generationCursor("gen-1", "F0"), "hidden cursor parked after the INPUT prompt");
	assert.deepEqual(rawRows(h.raw), generationRows("gen-1", "F0"), "the live raw grid agrees with the closed seed frame");
	assert.ok(h.stdout().includes("\x1b[?1049h"), "the seed enters the alternate screen like a real fullscreen child");

	h.send({ cmd: "step", step: 1 });
	await waitFor(() => frames(h.observer).length >= 2, 5000, "generation F1 frame");
	await settleProducer(h);
	assert.deepEqual(producerFrameRows(frames(h.observer)[1]), generationRows("gen-1", "F1"), "the commanded frame is the literal gen-1 F1 surface");
	assert.deepEqual(producerFrameCursor(frames(h.observer)[1]), generationCursor("gen-1", "F1"));

	// A duplicate/out-of-order step is rejected and paints nothing.
	h.send({ cmd: "step", step: 1 });
	await waitFor(() => readProducerEvents(h.eventsPath).some((event) => event.event === "command-rejected"), 5000, "duplicate step rejection");
	assert.equal(producerWrites(readProducerEvents(h.eventsPath)).length, 2, "a rejected command repaints nothing");

	h.send({ cmd: "exit" });
	assert.equal(await waitForChildExit(h.child, 5000, "generation child exit"), 0);
	const events = readProducerEvents(h.eventsPath);
	const start = events.find((event) => event.event === "start");
	assert.equal(start.generation, "gen-1", "the start event carries the session generation token");
	assert.ok(events.length > 0 && events.every((event) => event.generation === "gen-1"), "EVERY event carries the session generation token");
	assert.deepEqual(
		producerWrites(events).map((write) => `${write.frame}:${write.phase}`),
		["F0:seed", "F1:closed"],
		"frame ids are frame-local — the generation token is a separate dimension",
	);
	auditProducerWrites(events, h.stdout());
	assert.ok(!h.stdout().includes(PRODUCER_RS) && !h.stdout().includes('"cmd"'), "no control echo");
});

test("step 17 fix1 producer: two generation instances share frame ids but never share content or event identity", async (t) => {
	const h1 = spawnGenerationChild(t, "gen-1");
	const h2 = spawnGenerationChild(t, "gen-2");
	await waitFor(() => frames(h1.observer).length >= 1 && frames(h2.observer).length >= 1, 5000, "both generation seeds");
	await settleProducer(h1);
	await settleProducer(h2);
	const rows1 = producerFrameRows(frames(h1.observer)[0]);
	const rows2 = producerFrameRows(frames(h2.observer)[0]);
	assert.notDeepEqual(rows1, rows2, "same frame id F0 in different generations: distinct content");
	assert.ok(rows1.some((row) => row.includes("gen-1")) && rows1.every((row) => !row.includes("gen-2")), "gen-1 content carries only the gen-1 token");
	assert.ok(rows2.some((row) => row.includes("gen-2")) && rows2.every((row) => !row.includes("gen-1")), "gen-2 content carries only the gen-2 token");
	for (let y = 0; y < GEN_ROWS; y++) {
		assert.equal(rows1[y].replaceAll("gen-1", "#GEN#"), rows2[y].replaceAll("gen-2", "#GEN#"), `row ${y}: generations differ only by the generation token`);
	}
	h1.send({ cmd: "exit" });
	h2.send({ cmd: "exit" });
	assert.equal(await waitForChildExit(h1.child, 5000, "gen-1 exit"), 0);
	assert.equal(await waitForChildExit(h2.child, 5000, "gen-2 exit"), 0);
	const events1 = readProducerEvents(h1.eventsPath);
	const events2 = readProducerEvents(h2.eventsPath);
	assert.ok(events1.length > 0 && events1.every((event) => event.generation === "gen-1"), "gen-1 events carry gen-1 only");
	assert.ok(events2.length > 0 && events2.every((event) => event.generation === "gen-2"), "gen-2 events carry gen-2 only");
});

test("step 17 fix1 producer: missing or malformed generation configuration exits nonzero with no stdout", async (t) => {
	for (const env of [{}, { FAKE_PTY_GENERATION: "BAD GEN!" }]) {
		const dir = mkdtempSync(join(tmpdir(), "step17-gen-badcfg-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const child = spawn(process.execPath, [resolve("test-support/fake-pty-generation-pi.mjs")], {
			env: { ...process.env, ...env, FAKE_PTY_EVENTS_PATH: join(dir, "events.jsonl") },
			stdio: ["pipe", "pipe", "pipe"],
		});
		registerOwnedChild(t, child);
		let out = "";
		let err = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		assert.equal(await waitForChildExit(child, 5000, `generation refusal exit (${JSON.stringify(env)})`), 2, "invalid generation config fails explicitly");
		assert.equal(out, "", "a refused generation child writes no seed or partial frame");
		assert.ok(/generation/i.test(err), `stderr must name the generation problem (got ${JSON.stringify(err)})`);
	}
});

// ---------------------------------------------------------------------------
// Issue #222 step 18 (task-18-brief.md): REAL attach-entry timing smoke, case
// ENTRY. The NEW test-support/attach-ready-entry-scenario.ts drives the REAL
// production command path (`dashboardAttachLoop` + a REAL `createService`
// with real default `launchHostProcess` and real `resolveAttachTarget`) on an
// owned runner/socket/root; stage1 is the REAL DashboardComponent and stage2
// the REAL PtyAttachComponent mounted through the REAL TuiAltScreen overlay,
// both observed by the accepted AttachPresentationObserver. Total entry is
// measured from the user's attach action (`select`) to the first independently
// observed current-generation F0 outer frame (`terminalCommitted`), with the
// resolver and overlay recorded separately on one parent-monotonic clock.
// The entry is UNMEASURED (measured:false) — never a fabricated pass — if the
// real entry cannot be driven.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";

const ENTRY_SCENARIO = join(S15_ROOT, "test-support", "attach-ready-entry-scenario.ts");
// Accepted generation fixture + observer hashes (task-17-acceptance.md and the
// accepted step-14 observer). The entry trial must consume the accepted child
// and observer/oracle.
const ENTRY_ACCEPTED_HASHES = {
	generationFixture: "40757d23504a846ef9ab45cfc1650f2d67eaed0eafbf7524cda7df7ac7adf70f",
	observerFixture: "4ee53b9622e34cb5212d8eaa952c403452383373ecae45d334cfa9a7c3b6aa38",
};

function entryRunScenario(args, timeoutMs = 180_000) {
	return spawnSync(process.execPath, ["--experimental-transform-types", ENTRY_SCENARIO, ...args], {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 64 * 1024 * 1024,
	});
}

test("step 18 entry: scenario CLI rejects unsupported case, clock and repeat explicitly", () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "s18-cli-"));
	try {
		for (const args of [
			["--case", "S", "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir],
			["--case", "ENTRY", "--repeat", "2", "--clock", "real", "--artifact-dir", artifactDir],
			["--case", "ENTRY", "--repeat", "1", "--clock", "fake", "--artifact-dir", artifactDir],
			["--case", "ENTRY", "--repeat", "1", "--clock", "real"],
		]) {
			const res = entryRunScenario(args, 30_000);
			assert.equal(res.status, 2, `unsupported arguments must exit 2 explicitly (${args.join(" ")}); stderr: ${res.stderr}`);
			assert.ok((res.stderr ?? "").length > 0, "the rejection must name the problem on stderr");
			assert.equal((res.stdout ?? "").trim(), "", "a rejected invocation must not print a dummy success result");
		}
	} finally {
		rmSync(artifactDir, { recursive: true, force: true });
	}
});

test("step 18 entry: pure helpers trim/project/rowsEqual/inverse cells mechanically without mutating the observation", async () => {
	const scenario = await import("../test-support/attach-ready-entry-scenario.ts");
	assert.deepEqual(scenario.rtrimRows(["abc   ", "", "  \t "]), ["abc", "", ""]);
	assert.equal(scenario.rowsEqual(["a", "b"], ["a", "b"]), true);
	assert.equal(scenario.rowsEqual(["a"], ["a", "b"]), false);
	const obs = {
		kind: "frame",
		grid: Array.from({ length: 24 }, (_, y) => ({ text: y === 0 ? "HDR" : y === 23 ? "FTR" : `row${y}`, cells: [{ inverse: y === 1 && false, width: 1 }] })),
	};
	obs.grid[2] = { text: "row2", cells: [{ inverse: true, width: 1 }, { inverse: true, width: 0 }] };
	assert.deepEqual(scenario.inverseCellsOf(obs), [{ x: 0, y: 2 }], "width-0 continuation cells are not double-counted");
	assert.equal(scenario.ENTRY_F0_ROWS[19].includes("TAIL"), true, "the declared F0 baseline carries the literal TAIL row");
	assert.equal(scenario.ENTRY_F0_ROWS[21].includes("INPUT >"), true, "the declared F0 baseline carries the literal INPUT row");
});

test("step 18 entry: real attach-entry timing is measured as one witness through the real resolver/overlay", (t) => {
	// Exclusive path: the scenario refuses an existing artifact dir, so hand it
	// a fresh NON-existent subdir under the owned root (same contract as the S
	// battery trials). The owned root is removed on pass and retained on fail.
	const artifactRoot = mkdtempSync(join(tmpdir(), "s18-entry-"));
	const artifactDir = join(artifactRoot, "trial");
	let passed = false;
	t.after(() => {
		if (passed) rmSync(artifactRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	});
	const res = entryRunScenario(["--case", "ENTRY", "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir]);
	assert.equal(res.error, undefined, `scenario spawn error: ${res.error}`);
	assert.equal(res.status, 0, `scenario must exit 0 (harness completed, regardless of UNMEASURED)\nstdout tail:\n${(res.stdout ?? "").slice(-2000)}\nstderr tail:\n${(res.stderr ?? "").slice(-4000)}`);
	const line = (res.stdout ?? "").trim().split("\n").filter(Boolean).pop();
	const result = JSON.parse(line);
	assert.equal(result.ok, true, `trial-level harness error: ${result.error}`);
	assert.equal(result.caseId, "ENTRY");
	assert.equal(result.repeat, 1);
	assert.equal(result.clock, "real");
	// The trial consumed the accepted generation fixture child and observer/oracle.
	assert.equal(result.environment.hashes.generationFixture, ENTRY_ACCEPTED_HASHES.generationFixture, "the child must be the accepted session-generation fixture");
	assert.equal(result.environment.hashes.observerFixture, ENTRY_ACCEPTED_HASHES.observerFixture, "the observer/oracle must be the accepted step-14 fixture");
	// Prewarm/root/seed proof is excluded and proven before select.
	assert.equal(result.prewarm.ok, true, `baseline seed proof must succeed before select (${JSON.stringify(result.prewarm)})`);
	// The real entry must actually be driven and measured; UNMEASURED is a data
	// outcome the scenario records, never a silent pass.
	assert.equal(result.measured, true, `the real entry must be measured; got UNMEASURED (${JSON.stringify(result.error)})`);
	assert.equal(typeof result.totalEntryMs, "number", "totalEntryMs must be a number when measured");
	assert.ok(result.totalEntryMs >= 0, "totalEntryMs must be non-negative");
	assert.equal(typeof result.componentMs, "number", "componentMs must be a number when measured");
	assert.ok(result.componentMs >= 0 && result.componentMs <= result.totalEntryMs, "componentMs must sit within total entry");
	assert.equal(typeof result.resolverMs, "number", "resolver duration must be a number");
	assert.equal(result.resolverCalls, 1, "the real resolver must be called exactly once during the measured attach");
	// Ordering: select <= resolverStart <= resolverEnd <= overlayFactoryStart
	// <= overlayMounted <= terminalCommitted (explicit factory ordering).
	for (const [edge, ok] of Object.entries(result.ordering)) {
		assert.equal(ok, true, `ordering edge ${edge} must hold`);
	}
	// Corrected snapshot field semantics (I1): snapshotValidated is the protocol
	// snapshotReady RECEIPT (the client already validated); snapshotParsed is the
	// local parser term.write write-callback for the EXACT snapshot frame data —
	// a number only when that exact callback is observed, never snapshotBegin.
	assert.equal(typeof result.timeline.snapshotBeginReceived, "number", "snapshotBegin receipt must be a number (separate field)");
	assert.equal(typeof result.timeline.snapshotValidated, "number", "snapshotReady receipt must be a number");
	assert.equal(typeof result.timeline.snapshotParsed, "number", "local snapshot-frame parser drain must be a number when observed");
	assert.ok(result.timeline.snapshotParsed >= result.timeline.snapshotValidated, "local parse completion must follow the snapshotReady receipt");
	assert.ok(result.snapshotTiming && typeof result.snapshotTiming.snapshotParsed === "string", "the corrected snapshot semantics must be self-documented in the raw record");
	// The resolved socket identity must equal the attach component's endpoint.
	assert.equal(result.endpoint.matches, true, "the resolved socket path must equal the attach component's endpoint");
	// Same-size 80x22 attach must issue ZERO resize.
	assert.equal(result.zeroResize, true, "same-size attach must issue zero resize");
	assert.deepEqual(result.resizeCommands, [], "no resize commands may be sent");
	// First content is the current-generation literal F0 with TAIL/INPUT, no
	// old-generation content.
	assert.equal(result.firstContent.isCurrentGenerationF0, true, "first content must be the current-generation literal F0");
	assert.equal(result.firstContent.hasTailInput, true, "first content must carry the literal TAIL and INPUT rows");
	assert.equal(result.firstContent.oldGenerationSeen, false, "no old-generation content may appear");
	// Real detach (unconditional Ctrl+\) produced the detached result.
	assert.equal(result.detach.driven, true, "detach must be driven through the real input path");
	assert.equal(result.detach.result?.action, "detached", `detach must finish detached, got ${JSON.stringify(result.detach.result)}`);
	// Owned cleanup recorded known/UNKNOWN pids and a root disposition.
	assert.ok("childPid" in result.cleanup && "runnerPid" in result.cleanup, "cleanup must record child/runner pids (known or UNKNOWN)");
	assert.ok(result.cleanup.rootRemoved || result.cleanup.rootRetainedForEvidence, "the owned root must have an explicit disposition");
	assert.equal(result.artifactErrors.length, 0, "no artifact copy/write failures");
	passed = true;
});

test("step 18 entry: a second invocation against an existing artifact path refuses (exit 2) before any real run and preserves the original artifact", () => {
	// Exclusivity contract (M2): the CLI must refuse an already-existing artifact
	// dir with exit 2 + stderr + no stdout BEFORE spawning a trial, and leave the
	// existing artifact byte-identical. A sentinel stands in for a prior artifact
	// so this test does not add another real-run performance cost.
	const artifactRoot = mkdtempSync(join(tmpdir(), "s18-excl-"));
	const artifactDir = join(artifactRoot, "existing");
	try {
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "sentinel.txt"), "ORIGINAL-ARTIFACT\n");
		const res = entryRunScenario(["--case", "ENTRY", "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir], 30_000);
		assert.equal(res.status, 2, `an existing artifact path must refuse with exit 2 (stderr: ${res.stderr})`);
		assert.ok((res.stderr ?? "").includes("overwrite refused"), "the refusal must name the overwrite contract on stderr");
		assert.equal((res.stdout ?? "").trim(), "", "a refused second invocation must print no dummy success result");
		assert.equal(readFileSync(join(artifactDir, "sentinel.txt"), "utf8"), "ORIGINAL-ARTIFACT\n", "the original artifact must be preserved byte-identical");
		assert.equal(existsSync(join(artifactDir, "summary.json")), false, "no trial may run into the existing artifact dir");
	} finally {
		rmSync(artifactRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
});

// ---------------------------------------------------------------------------
// Issue #222 step 19 (task-19-brief.md): deterministic catch-up, parse
// queues, cursor tails, active selection and deliberate upscroll. Four
// independent evidence chains:
//   1. attach-ready-catchup-scenario.ts — REAL terminal model/subscription/
//      client + real xterm parser; rawSend feeds F1/F2 synchronously on the
//      actual snapshot_begin (post-DTO catch-up, no timer, no hand-emitted
//      snapshotReady).
//   2. attach-ready-interactions-scenario.ts case MAINSCREEN — REAL
//      TuiMainScreen + ProcessTerminal cursor tail (fixture fake-pty-
//      mainscreen-pi.mjs).
//   3. ... case SELECTION — REAL TuiAltScreen + SelectList overlay through the
//      real showOverlay path, real arrow input (fake-pty-interactive-pi.mjs).
//   4. ... case SCROLL — REAL fullscreen ScrollView, real wheel-up input then
//      append without jumping to bottom (fake-pty-interactive-pi.mjs).
// ---------------------------------------------------------------------------

import { createTerminalAttachClient } from "../src/core/terminal-attach-client.mjs";

const S19_CATCHUP_SCENARIO = join(S15_ROOT, "test-support", "attach-ready-catchup-scenario.ts");
const S19_INTERACTIONS_SCENARIO = join(S15_ROOT, "test-support", "attach-ready-interactions-scenario.ts");

function s19RunScenario(scenarioPath, args, timeoutMs = 180_000) {
	return spawnSync(process.execPath, ["--experimental-transform-types", scenarioPath, ...args], {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 64 * 1024 * 1024,
	});
}

test("step 19 catchup: scenario CLI rejects unsupported case, clock and repeat explicitly", () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "s19-catchup-cli-"));
	try {
		for (const args of [
			["--case", "MAINSCREEN", "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir],
			["--case", "CATCHUP", "--repeat", "2", "--clock", "real", "--artifact-dir", artifactDir],
			["--case", "CATCHUP", "--repeat", "1", "--clock", "fake", "--artifact-dir", artifactDir],
			["--case", "CATCHUP", "--repeat", "1", "--clock", "real"],
		]) {
			const res = s19RunScenario(S19_CATCHUP_SCENARIO, args, 30_000);
			assert.equal(res.status, 2, `unsupported arguments must exit 2 (${args.join(" ")}); stderr: ${res.stderr}`);
			assert.ok((res.stderr ?? "").length > 0, "rejection must name the problem on stderr");
			assert.equal((res.stdout ?? "").trim(), "", "a rejected invocation must print no dummy success");
		}
	} finally {
		rmSync(artifactDir, { recursive: true, force: true });
	}
});

test("step 19 catchup: pure helpers frame/literal/queue indexing are mechanical", async () => {
	const scenario = await import("../test-support/attach-ready-catchup-scenario.ts");
	assert.deepEqual(scenario.rtrimRows(["a   ", "b", ""]), ["a", "b", ""]);
	assert.equal(scenario.rowsEqual(["a", "b"], ["a", "b"]), true);
	assert.equal(scenario.rowsEqual(["a"], ["a", "b"]), false);
	assert.equal(scenario.frameIdOf("x F0 HEADER y"), "F0");
	assert.equal(scenario.frameIdOf("x F2 HEADER y"), "F2");
	assert.equal(scenario.frameIdOf("no marker"), null);
	assert.equal(scenario.literalRows("F2")[0], "F2 HEADER");
	assert.equal(scenario.literalRows("F2").length, scenario.CATCHUP_ROWS);
	assert.deepEqual(scenario.queueIndexOf([{ kind: "write-enqueue", frameId: "F1" }, { kind: "write-drain", frameId: "F1" }], "write-drain", "F1"), 1);
	assert.equal(scenario.queueIndexOf([], "write-drain", "F1"), -1);
});

test("step 19 catchup: REAL model/subscription/client prove snapshotReady before catch-up with exact seq/wire/parser-queue and final grid F2", (t) => {
	const artifactRoot = mkdtempSync(join(tmpdir(), "s19-catchup-"));
	const artifactDir = join(artifactRoot, "trial");
	let passed = false;
	t.after(() => {
		if (passed) rmSync(artifactRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	});
	const res = s19RunScenario(S19_CATCHUP_SCENARIO, ["--case", "CATCHUP", "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir]);
	assert.equal(res.error, undefined, `scenario spawn error: ${res.error}`);
	assert.equal(res.status, 0, `scenario must exit 0\nstdout: ${(res.stdout ?? "").slice(-1500)}\nstderr: ${(res.stderr ?? "").slice(-3000)}`);
	const result = JSON.parse((res.stdout ?? "").trim().split("\n").filter(Boolean).pop());
	assert.equal(result.ok, true, `trial harness error: ${result.error}`);
	assert.equal(result.caseId, "CATCHUP");
	// Wire/event/parser-queue evidence (the four required assertion families).
	assert.equal(result.verdict.snapshotSeqBelongsToF0, true, "snapshot_begin.snapshotSeq must belong to F0");
	assert.equal(result.verdict.frameIsF0, true, "snapshot_frame must repaint the literal F0 grid");
	assert.equal(result.verdict.outputSeqsExact, true, "catch-up outputs must carry the exact subsequent seq values");
	assert.equal(result.verdict.outputDataExact, true, "catch-up outputs must carry the exact fed bytes");
	assert.equal(result.verdict.endNextSeqFollowsF2, true, "snapshot_end.nextSeq must follow F2");
	assert.equal(result.verdict.snapshotReadyBeforeCatchup, true, "the client must emit snapshotReady BEFORE the F1/F2 outputs");
	assert.equal(result.verdict.noDuplicateNoReorderNoDrop, true, "no duplication/reordering/dropped flush");
	assert.equal(result.verdict.parserQueue.snapshotFrameParsedBeforeCatchupEnqueue, true, "snapshot-frame parser callback must be separate from catch-up callbacks");
	assert.equal(result.verdict.parserQueue.multipleWritesRetainQueueOrder, true, "multiple parser writes must retain their true FIFO order");
	assert.equal(result.verdict.finalGridIsF2, true, "the independent final grid must be F2 (not F0/F1)");
	assert.equal(result.verdict.finalGridNotF0, true);
	assert.equal(result.verdict.finalGridNotF1, true);
	passed = true;
});

/** A scripted REAL client: start(), then feed messages; report sent/emitted. */
function s19ScriptedClient(script) {
	const sent = [];
	const events = [];
	const client = createTerminalAttachClient({
		send: (msg) => sent.push(msg),
		emit: (event, payload) => events.push({ event, payload }),
		forceLegacy: false,
		clientId: "s19-client",
	});
	client.start();
	for (const msg of script) client.handleMessage(msg);
	return { sent, events, mode: client.getMode(), lastSeq: client.getLastSeq() };
}

test("step 19 catchup negative: a missing snapshot frame is rejected with a fresh subscribe", () => {
	const r = s19ScriptedClient([
		{ type: "snapshot_begin", snapshotSeq: 1, cols: 80, rows: 6 },
		{ type: "snapshot_end", nextSeq: 2 },
	]);
	assert.ok(r.events.some((e) => e.event === "resubscribing"), "missing frame must trigger a resubscribe");
	assert.equal(r.sent.filter((m) => m.type === "subscribe_terminal").length, 2, "the client must send a fresh subscribe");
	assert.ok(!r.events.some((e) => e.event === "snapshotReady"), "never emit snapshotReady for an unverified window");
});

test("step 19 catchup negative: duplicated and out-of-order catch-up flush are rejected", () => {
	// Out-of-order: seq 3 while the flush expects 2 (gap).
	const gap = s19ScriptedClient([
		{ type: "snapshot_begin", snapshotSeq: 1, cols: 80, rows: 6 },
		{ type: "snapshot_frame", frameVersion: 1, data: "F0" },
		{ type: "output", seq: 3, data: "F2" },
	]);
	assert.ok(gap.events.some((e) => e.event === "resubscribing"), "an out-of-order flush must be rejected");
	assert.ok(!gap.events.some((e) => e.event === "snapshotReady"), "no snapshotReady on a gap");

	// Duplicated: seq 2 twice (the second is a duplicate, not the expected 3).
	const dup = s19ScriptedClient([
		{ type: "snapshot_begin", snapshotSeq: 1, cols: 80, rows: 6 },
		{ type: "snapshot_frame", frameVersion: 1, data: "F0" },
		{ type: "output", seq: 2, data: "F1" },
		{ type: "output", seq: 2, data: "F1" },
	]);
	assert.ok(dup.events.some((e) => e.event === "resubscribing"), "a duplicated flush seq must be rejected");
	assert.ok(!dup.events.some((e) => e.event === "snapshotReady"), "no snapshotReady on a duplicated flush");
});

test("step 19 interactions: scenario CLI rejects unsupported case, clock and repeat explicitly", () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "s19-interactions-cli-"));
	try {
		for (const args of [
			["--case", "CATCHUP", "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir],
			["--case", "SELECTION", "--repeat", "2", "--clock", "real", "--artifact-dir", artifactDir],
			["--case", "SELECTION", "--repeat", "1", "--clock", "fake", "--artifact-dir", artifactDir],
			["--case", "SELECTION", "--repeat", "1", "--clock", "real"],
		]) {
			const res = s19RunScenario(S19_INTERACTIONS_SCENARIO, args, 30_000);
			assert.equal(res.status, 2, `unsupported arguments must exit 2 (${args.join(" ")}); stderr: ${res.stderr}`);
			assert.ok((res.stderr ?? "").length > 0, "rejection must name the problem on stderr");
			assert.equal((res.stdout ?? "").trim(), "", "a rejected invocation must print no dummy success");
		}
	} finally {
		rmSync(artifactDir, { recursive: true, force: true });
	}
});

function s19RunInteraction(caseId, t, assertions) {
	const artifactRoot = mkdtempSync(join(tmpdir(), `s19-${caseId.toLowerCase()}-`));
	const artifactDir = join(artifactRoot, "trial");
	let passed = false;
	t.after(() => {
		if (passed) rmSync(artifactRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	});
	const res = s19RunScenario(S19_INTERACTIONS_SCENARIO, ["--case", caseId, "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir]);
	assert.equal(res.error, undefined, `scenario spawn error: ${res.error}`);
	assert.equal(res.status, 0, `scenario must exit 0\nstdout: ${(res.stdout ?? "").slice(-1500)}\nstderr: ${(res.stderr ?? "").slice(-3000)}`);
	const result = JSON.parse((res.stdout ?? "").trim().split("\n").filter(Boolean).pop());
	assert.equal(result.ok, true, `trial harness error: ${result.error}`);
	assert.equal(result.caseId, caseId);
	assertions(result);
	passed = true;
}

test("step 19 mainscreen: REAL TuiMainScreen cursor tail follows sync CLOSE with the literal grid/cursor, empty inverse set and blank rows", (t) => {
	s19RunInteraction("MAINSCREEN", t, (result) => {
		assert.equal(result.evidence.frameMatchesLiteral, true, "the outer grid must be the literal MAIN frame");
		assert.equal(result.evidence.blankRowsBelowInput, true, "all rows below MAIN INPUT must be blank");
		assert.equal(result.evidence.frameInverseCellsEmpty, true, "the complete frame must have an empty inverse-cell set (no software cursor)");
		assert.deepEqual(result.evidence.frameInverseCells, [], "no inverse cell anywhere in the literal frame");
		assert.equal(result.evidence.noExtraCursor, true, "noExtraCursor is the inverse-cell check (never a row-text comparison)");
		assert.equal(result.evidence.cursorTailFollowsClose, true, "the cursor parking + hide tail must follow the sync CLOSE");
		assert.equal(result.evidence.outerCursorMatches, true, "the outer cursor must park at (11,4) hidden");
		assert.equal(result.evidence.frameCompletePresent, true, "the child's independent frameComplete fixture truth must be present");
		assert.equal(result.evidence.frameComplete.frameId, "MAIN");
		assert.equal(result.childExit.exitCode, 0, "the fixture child must exit cleanly");
		assert.equal(result.childExit.killed, false, "the child must not be force-killed");
	});
});

test("step 19 mainscreen negative: an extra inverse cell on the literal frame is rejected", async () => {
	const scenario = await import("../test-support/attach-ready-interactions-scenario.ts");
	// A synthetic observation with an inverse cell in the body (a stray
	// software cursor) must NOT count as an empty inverse set.
	const obs = {
		grid: Array.from({ length: 24 }, (_, y) => ({
			text: y === 0 ? "MAIN HEADER" : "",
			cells: Array.from({ length: 80 }, (_, x) => ({ inverse: y === 4 && x === 11, width: 1 })),
		})),
	};
	assert.deepEqual(scenario.inverseCellsOf(obs), [{ x: 11, y: 4 }], "the extra inverse cell must be detected");
	assert.equal(scenario.inverseCellsOf(obs).length === 0, false, "a frame with an inverse cell must be rejected (not empty)");
});

test("step 19 selection: REAL attach input chain drives SelectList (tx input bytes + selection semantics + real detach)", (t) => {
	s19RunInteraction("SELECTION", t, (result) => {
		assert.equal(result.evidence.initialSelectionRendered, true, "the overlay must render the initial active option");
		assert.equal(result.evidence.selectionChangedToBeta, true, "down arrow must move the rendered selection to Beta");
		assert.equal(result.evidence.selectionChangedToGamma, true, "down arrow must move the rendered selection to Gamma");
		assert.equal(result.evidence.selectionEventSequenceMatches, true, "getSelectedItem() must track the real arrow input");
		assert.equal(result.evidence.focusKeptOnSelectList, true, "focus must stay on the SelectList (never replaced by an editor)");
		assert.equal(result.evidence.downArrowTxDelivered, true, "the {type:'input'} tx bytes must be delivered on the component socket");
		assert.equal(result.evidence.detachTxDelivered, true, "the real outer detach must reach the component");
		assert.equal(result.diagTrial.ok, true, "the diag trial harness must complete");
		assert.deepEqual(result.diagTrial.artifactErrors, [], "no artifact errors");
		assert.equal(result.diagTrial.cleanup.ok, true, "owned cleanup must be proven ok");
		assert.deepEqual(result.diagTrial.teardownViolations, [], "no teardown violations");
	});
});

test("step 19 scroll: REAL attach input chain drives ScrollView (synthesized wheel tx + upscroll/append/scrollToEnd)", (t) => {
	s19RunInteraction("SCROLL", t, (result) => {
		assert.equal(result.evidence.initialFollowsEnd, true, "the scroll view must start following end");
		assert.equal(result.evidence.wheelUpscroll, true, "wheel-up must disable follow-end and move the viewport up");
		assert.equal(result.evidence.postAppendNoJump, true, "appending must NOT jump the upscrolled viewport to the newest bottom");
		assert.equal(result.evidence.scrollToEndRestored, true, "scrollToEnd must restore follow-end");
		assert.equal(result.evidence.wheelTxDelivered, true, "the synthesized {type:'input'} wheel reports must be delivered on the component socket");
		assert.equal(result.evidence.detachTxDelivered, true, "the real outer detach must reach the component");
		assert.equal(result.evidence.outerGridShowsChildContent, true, "the child's screen must hydrate on the outer attach surface");
		assert.equal(result.evidence.outerGridShowsUpscrollTop, true, "the outer grid must show the wheel-up top row (R2)");
		assert.equal(result.evidence.outerGridShowsScrollToEndTop, true, "the outer grid must show the scroll-to-end top row");
		assert.equal(result.diagTrial.ok, true, "the diag trial harness must complete");
		assert.deepEqual(result.diagTrial.artifactErrors, [], "no artifact errors");
		assert.equal(result.diagTrial.cleanup.ok, true, "owned cleanup must be proven ok");
		assert.deepEqual(result.diagTrial.teardownViolations, [], "no teardown violations");
	});
});

test("step 19 component-only: SELECTION-COMPONENT and SCROLL-COMPONENT are relabeled direct-stdin supporting evidence (not attach)", (t) => {
	s19RunInteraction("SELECTION-COMPONENT", t, (result) => {
		assert.equal(result.evidence.componentOnly, true, "the component-only case must be labeled as such");
		assert.equal(result.evidence.selectionEventSequenceMatches, true);
		assert.equal(result.evidence.focusKeptOnSelectList, true);
	});
	s19RunInteraction("SCROLL-COMPONENT", t, (result) => {
		assert.equal(result.evidence.componentOnly, true, "the component-only case must be labeled as such");
		assert.equal(result.evidence.wheelUpscroll, true);
		assert.equal(result.evidence.postAppendNoJump, true);
		assert.equal(result.evidence.scrollToEndRestored, true);
	});
});

test("step 19 fix2: attachOkFromDiag gates on cleanup.ok and teardown violations (pure predicate)", async () => {
	const scenario = await import("../test-support/attach-ready-interactions-scenario.ts");
	const goodEvidence = { a: true, b: true };
	const base = { ok: true, artifactErrors: [], teardownViolations: [], cleanup: { ok: true } };
	assert.equal(scenario.attachOkFromDiag(base, goodEvidence), true, "a clean diag trial with true evidence is ok");
	assert.equal(scenario.attachOkFromDiag({ ...base, ok: false }, goodEvidence), false, "harness failure must fail the attach ok");
	assert.equal(scenario.attachOkFromDiag({ ...base, artifactErrors: ["x"] }, goodEvidence), false, "artifact errors must fail the attach ok");
	assert.equal(scenario.attachOkFromDiag({ ...base, cleanup: { ok: false } }, goodEvidence), false, "unproven cleanup must fail the attach ok");
	assert.equal(scenario.attachOkFromDiag({ ...base, teardownViolations: [{}] }, goodEvidence), false, "a teardown violation must fail the attach ok");
	assert.equal(scenario.attachOkFromDiag(base, { a: true, b: false }), false, "a false evidence boolean must fail the attach ok");
});

test("step 19 fix2: driveAttachInput requires a NEW matching tx count (repeated input cannot reuse an earlier message)", async () => {
	const scenario = await import("../test-support/attach-ready-interactions-scenario.ts");
	// A synthetic handle whose txMessages() returns the SAME pre-existing
	// arrow forever: the count never increases, so driveAttachInput must time
	// out (a repeated input cannot pass from an earlier message).
	const neverIncreasing = {
		txMessages: () => [{ type: "input", msg: { data: "\x1b[B" } }],
		primary: { observer: { inputHandler: () => {} } },
	};
	await assert.rejects(
		() => scenario.driveAttachInput(neverIncreasing, "\x1b[B", (m) => m.type === "input" && m.msg.data === "\x1b[B", "never", 200),
		/timed out/,
		"a pre-existing matching tx must NOT satisfy the wait",
	);
	// A synthetic handle whose txMessages() grows by one arrow after the input
	// is driven: the count increases, so driveAttachInput resolves.
	let count = 0;
	const increasing = {
		txMessages: () => Array.from({ length: count }, () => ({ type: "input", msg: { data: "\x1b[B" } })),
		primary: { observer: { inputHandler: () => { count += 1; } } },
	};
	await scenario.driveAttachInput(increasing, "\x1b[B", (m) => m.type === "input" && m.msg.data === "\x1b[B", "increasing", 5000);
	assert.equal(count, 1, "one real input must have been driven");
});

test("step 19 fix2: attach trials preserve withDiagTrial summary.json and write a distinct summary-attach.json", (t) => {
	const artifactRoot = mkdtempSync(join(tmpdir(), "s19-fix2-summary-"));
	const artifactDir = join(artifactRoot, "trial");
	let passed = false;
	t.after(() => {
		if (passed) rmSync(artifactRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	});
	const res = s19RunScenario(S19_INTERACTIONS_SCENARIO, ["--case", "SELECTION", "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir]);
	assert.equal(res.error, undefined, `scenario spawn error: ${res.error}`);
	assert.equal(res.status, 0, `scenario must exit 0\nstderr: ${(res.stderr ?? "").slice(-2000)}`);
	// Both files must exist: summary.json is the withDiagTrial ORIGINAL (holds/
	// cleanup/teardownViolations, no composite wrapper); summary-attach.json is
	// the composite attach result (has the diagTrial wrapper + evidence).
	assert.equal(existsSync(join(artifactDir, "summary.json")), true, "withDiagTrial summary.json must be preserved");
	assert.equal(existsSync(join(artifactDir, "summary-attach.json")), true, "the composite must be written to summary-attach.json");
	const original = JSON.parse(readFileSync(join(artifactDir, "summary.json"), "utf8"));
	const composite = JSON.parse(readFileSync(join(artifactDir, "summary-attach.json"), "utf8"));
	assert.ok("holds" in original && "cleanup" in original && "teardownViolations" in original, "summary.json is the withDiagTrial original (harness fields present)");
	assert.equal("diagTrial" in original, false, "the original summary.json must NOT be overwritten by the composite");
	assert.ok("diagTrial" in composite && "evidence" in composite, "summary-attach.json is the composite attach result");
	assert.equal(composite.caseId, "SELECTION");
	passed = true;
});
