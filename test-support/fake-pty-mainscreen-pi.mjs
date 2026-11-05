#!/usr/bin/env node
// Issue #222 step 19 (task-19-brief.md), evidence chain 2: the "regular
// renderer cursor tail" fixture child. This child owns a REAL
// TuiMainScreen + REAL ProcessTerminal and a REAL focusable component that
// emits CURSOR_MARKER at a fixed (row 4, col 11) position. The renderer's
// real doRender emits `CSI ? 2026 h` … `CSI ? 2026 l` (synchronized OPEN →
// body → CLOSE) as one flush, then `positionHardwareCursor` writes the
// parking move and the final hideCursor AFTER the CLOSE. The child records
// every process.stdout.write (index, data, sha256) and emits one independent
// `frameComplete` event ONLY after the required final cursor operation (the
// post-CLOSE hide) has been observed in its own captured stream. This is
// fixture truth, not a production ready flag.
//
// Env: FAKE_PTY_EVENTS_PATH (required, JSONL events file); COLUMNS/LINES
// drive ProcessTerminal geometry (the child is spawned with piped stdio, so
// process.stdout.columns/rows are undefined and ProcessTerminal falls back to
// the env values). The child never reads stdin for this chain.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { CURSOR_MARKER, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";

const eventsPath = process.env.FAKE_PTY_EVENTS_PATH ?? "";
if (!eventsPath) {
	process.stderr.write("mainscreen-fixture: FAKE_PTY_EVENTS_PATH is required\n");
	process.exit(2);
}

const COLS = Number(process.env.COLUMNS ?? 80);
const ROWS = Number(process.env.LINES ?? 24);

const clockNow = () => ({ monoNs: process.hrtime.bigint().toString(), wallMs: Date.now() });
const logEvent = (event) => {
	appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
};
const sha256 = (data) => createHash("sha256").update(data, "utf8").digest("hex");

// Capture every real ProcessTerminal write (log-and-delegate to stdout). The
// parent reads the same bytes over the pipe; this local capture is the
// child's own write-index/hash truth.
const capturedWrites = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (data, ...args) {
	capturedWrites.push({ index: capturedWrites.length, data: String(data) });
	return originalWrite(data, ...args);
};

/** The literal regular-surface frame. Cursor parks at (11, 4) — right after
 *  "MAIN INPUT " on the last row, before the ">" prompt. */
const MAIN_ROWS = ["MAIN HEADER", "MAIN BODY one", "MAIN BODY two", "MAIN TAIL", "MAIN INPUT >"];
const CURSOR = { x: 11, y: 4 };

/** REAL focusable component carrying CURSOR_MARKER at the declared cursor. */
const component = {
	focused: false,
	render(_width) {
		return [
			"MAIN HEADER",
			"MAIN BODY one",
			"MAIN BODY two",
			"MAIN TAIL",
			`MAIN INPUT ${CURSOR_MARKER}>`,
		];
	},
	invalidate() {},
};

const terminal = new ProcessTerminal();
const tui = new TuiMainScreen(terminal, false);
tui.addChild(component);
tui.setFocus(component);

logEvent({
	event: "start",
	fixture: "fake-pty-mainscreen-pi.mjs",
	pid: process.pid,
	cols: COLS,
	rows: ROWS,
	cursor: CURSOR,
	rows: MAIN_ROWS,
	clock: clockNow(),
});

// Drive the REAL start (requestRender schedules the first render on the real
// scheduler) and wait, bounded, until our own captured stream shows the
// synchronized CLOSE followed by the final hideCursor write.
tui.start();

const findFrameComplete = () => {
	const closeIdx = capturedWrites.findIndex((w) => w.data.includes("\x1b[?2026l"));
	if (closeIdx === -1) return null;
	const tailParkingIdx = capturedWrites.findIndex((w, i) => i > closeIdx && /\x1b\[\d+G/.test(w.data));
	const tailHideIdx = capturedWrites.findIndex((w, i) => i > closeIdx && w.data.includes("\x1b[?25l"));
	if (tailHideIdx === -1) return null;
	return { closeIdx, tailParkingIdx, tailHideIdx };
};

let frameComplete = null;
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
	frameComplete = findFrameComplete();
	if (frameComplete) break;
	await new Promise((resolve) => setTimeout(resolve, 5));
}
if (!frameComplete) {
	logEvent({ event: "frameComplete-unobserved", ...clockNow() });
	process.stderr.write("mainscreen-fixture: frame close + cursor tail were never observed in the captured stream\n");
	process.exit(3);
}

const frameBytes = capturedWrites[frameComplete.closeIdx].data;
logEvent({
	event: "frameComplete",
	frameId: "MAIN",
	sampledDims: { cols: terminal.columns, rows: terminal.rows },
	closeWriteIndex: frameComplete.closeIdx,
	tailParkingWriteIndex: frameComplete.tailParkingIdx,
	tailHideWriteIndex: frameComplete.tailHideIdx,
	tailParkingBytes: frameComplete.tailParkingIdx === -1 ? null : capturedWrites[frameComplete.tailParkingIdx].data,
	tailHideBytes: capturedWrites[frameComplete.tailHideIdx].data,
	frameBytesSha256: sha256(frameBytes),
	frameBytesLength: frameBytes.length,
	cursor: CURSOR,
	clock: clockNow(),
});

// Flush the captured cursor tail through the pipe before exiting so the parent
// observes the complete byte stream (same flush pattern as the accepted
// controlled-frames child).
process.stdout.write("", () => process.exit(0));
