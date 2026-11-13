import assert from "node:assert/strict";
import test from "node:test";
import xtermHeadless from "@xterm/headless";
// @xterm/headless is CommonJS; named import from ESM fails, so destructure.
const { Terminal } = /** @type {any} */ (xtermHeadless);
import {
	createAttachOutputRenderScheduler,
	detectCursorDesync,
	isPtyCursorHidden,
	nextAttachRender,
	projectPtyCursor,
	resizeIntentEvidenceFromRecords,
	shouldScheduleAttachRenderForMessage,
} from "../src/core/pty-attach-render.mjs";

test("nextAttachRender forces exactly the first attach paint by default", () => {
	assert.deepEqual(nextAttachRender(true), { force: true, firstPaint: false });
	assert.deepEqual(nextAttachRender(false), { force: false, firstPaint: false });
});

test("nextAttachRender preserves explicit hard resets after first paint", () => {
	assert.deepEqual(nextAttachRender(false, true), { force: true, firstPaint: false });
	assert.deepEqual(nextAttachRender(true, true), { force: true, firstPaint: false });
});

test("shouldScheduleAttachRenderForMessage skips immediate repaint for PTY output", () => {
	assert.equal(shouldScheduleAttachRenderForMessage("output"), false);
	assert.equal(shouldScheduleAttachRenderForMessage("hello"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("status"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("error"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("exit"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("unknown"), false);
});

test("attach output scheduler coalesces parser callback bursts", async () => {
	let renders = 0;
	const scheduler = createAttachOutputRenderScheduler(() => renders++, 15);
	for (let i = 0; i < 20; i++) scheduler.request();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(renders, 1);

	scheduler.request();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(renders, 2);
	scheduler.dispose();
});

test("attach output scheduler cancels a pending repaint when disposed", async () => {
	let renders = 0;
	const scheduler = createAttachOutputRenderScheduler(() => renders++, 15);
	scheduler.request();
	scheduler.dispose();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(renders, 0);
});

test("projectPtyCursor maps a fresh session (baseY 0) to the absolute buffer row", () => {
	const buf = { baseY: 0, cursorX: 1, cursorY: 5 };
	assert.deepEqual(projectPtyCursor(buf, 0, 36), { row: 5, col: 1 });
});

test("projectPtyCursor returns an ABSOLUTE row once scrollback exists", () => {
	// Regression: a start-relative row (cursorY) never matches the absolute buffer
	// indices used by the projection loop, so the PTY-cursor block and the
	// CURSOR_MARKER (hardware cursor positioning for IME) silently disappeared
	// for any session with scrollback.
	const buf = { baseY: 249, cursorX: 0, cursorY: 32 };
	assert.deepEqual(projectPtyCursor(buf, 249, 36), { row: 281, col: 0 });
});

test("projectPtyCursor returns null when the cursor is outside the projected window", () => {
	const buf = { baseY: 249, cursorX: 0, cursorY: 32 };
	// Window scrolled up into history: cursor sits below it.
	assert.equal(projectPtyCursor(buf, 100, 36), null);
	// Window starts past the cursor.
	assert.equal(projectPtyCursor(buf, 282, 36), null);
});

test("projectPtyCursor tolerates missing or negative cursor coordinates", () => {
	assert.equal(projectPtyCursor({ baseY: 0 }, 0, 36), null);
	assert.equal(projectPtyCursor({ baseY: 0, cursorX: -1, cursorY: 3 }, 0, 36), null);
	assert.equal(projectPtyCursor({ baseY: 0, cursorX: 0, cursorY: -2 }, 0, 36), null);
});

// --- issue #11: runtime desync classifier ---

function fakeDesyncBuf(cells) {
	// cells: array of { inverse: boolean, width: number } | null (null = no cell at x)
	return {
		getLine(row) {
			if (row !== 0) return undefined;
			return {
				length: cells.length,
				getCell(x) {
					const c = cells[x];
					if (!c) return undefined;
					return { isInverse: () => c.inverse, getWidth: () => c.width };
				},
			};
		},
	};
}

test("detectCursorDesync: null cursor (viewport-scrolled) is unknown", () => {
	assert.equal(detectCursorDesync(fakeDesyncBuf([]), null), "unknown");
});

test("detectCursorDesync: cursor on an inverse cell is aligned", () => {
	const buf = fakeDesyncBuf([{ inverse: false, width: 1 }, { inverse: true, width: 1 }]);
	assert.equal(detectCursorDesync(buf, { row: 0, col: 1 }), "aligned");
});

test("detectCursorDesync: cursor on a non-inverse cell is misaligned", () => {
	const buf = fakeDesyncBuf([{ inverse: true, width: 1 }, { inverse: false, width: 1 }]);
	assert.equal(detectCursorDesync(buf, { row: 0, col: 1 }), "misaligned");
});

test("detectCursorDesync: cursor past line end falls back to the last inverse cell (aligned)", () => {
	const buf = fakeDesyncBuf([{ inverse: false, width: 1 }, { inverse: true, width: 1 }]);
	assert.equal(detectCursorDesync(buf, { row: 0, col: 99 }), "aligned");
});

test("detectCursorDesync: cursor on a width-0 CJK continuation falls back to the leading wide cell", () => {
	// "你" occupies cols 0-1: col 0 width 2 inverse, col 1 width 0 (continuation)
	const buf = fakeDesyncBuf([{ inverse: true, width: 2 }, { inverse: false, width: 0 }, { inverse: false, width: 1 }]);
	assert.equal(detectCursorDesync(buf, { row: 0, col: 1 }), "aligned");
});

test("detectCursorDesync: fully empty line (no cells, no inverse) is misaligned", () => {
	const buf = fakeDesyncBuf([]);
	assert.equal(detectCursorDesync(buf, { row: 0, col: 0 }), "misaligned");
});

test("detectCursorDesync: missing buffer line is unknown", () => {
	assert.equal(detectCursorDesync(fakeDesyncBuf([{ inverse: true, width: 1 }]), { row: 5, col: 0 }), "unknown");
});

test("isPtyCursorHidden tracks the child terminal's DECTCEM state", async () => {
	const term = new Terminal({ cols: 40, rows: 10 });
	assert.equal(isPtyCursorHidden(term), false, "a fresh terminal reports a visible cursor");
	await new Promise((resolve) => term.write("\x1b[?25l", resolve));
	assert.equal(isPtyCursorHidden(term), true, "?25l must read as hidden");
	await new Promise((resolve) => term.write("\x1b[?25h", resolve));
	assert.equal(isPtyCursorHidden(term), false, "?25h must read as visible again");
});

test("isPtyCursorHidden falls back to visible for unknown terminal shapes", () => {
	assert.equal(isPtyCursorHidden(undefined), false);
	assert.equal(isPtyCursorHidden(null), false);
	assert.equal(isPtyCursorHidden({}), false);
	assert.equal(isPtyCursorHidden({ _core: {} }), false);
	assert.equal(isPtyCursorHidden({ _core: { coreService: {} } }), false);
	assert.equal(isPtyCursorHidden({ _core: { coreService: { isCursorHidden: false } } }), false);
	assert.equal(isPtyCursorHidden({ _core: { coreService: { isCursorHidden: undefined } } }), false);
	assert.equal(isPtyCursorHidden({ _core: { coreService: { isCursorHidden: "true" } } }), false);
	assert.equal(
		isPtyCursorHidden({
			get _core() {
				throw new Error("upstream shape change");
			},
		}),
		false,
		"a throwing accessor must degrade to visible, not break the projection",
	);
});

// --- issue #294 A1a: the single-source intent-evidence predicate ---

const INTENT = { required: true, geometryRevision: 1, intentId: 1, cols: 100, rows: 30 };
const MATCH = (seq) => ({
	marker: "F", seq, frameId: seq,
	metadata: { protocol: 1, cols: 100, rows: 30, mode: "fullscreen", rendererEpoch: 1, sessionEpoch: 1, focusPresent: true, overlayPresent: false, intentId: 1, geometryRevision: 1 },
});

test("A1a: a fully matching F yields evidence with its seq (highest wins)", () => {
	assert.deepEqual(resizeIntentEvidenceFromRecords(INTENT, [MATCH(2)]), { satisfied: true, proofSeq: 2 });
	assert.deepEqual(resizeIntentEvidenceFromRecords(INTENT, [{ marker: "S", seq: 1, frameId: 1 }, MATCH(2), MATCH(5)]), { satisfied: true, proofSeq: 5 });
});

test("A1a: a non-required intent is vacuously satisfied without evidence", () => {
	assert.deepEqual(resizeIntentEvidenceFromRecords({ ...INTENT, required: false }, []), { satisfied: true, proofSeq: null });
});

test("A1a: anything short of a full match fails closed", () => {
	const notEvidence = [
		[{ marker: "S", seq: 2, frameId: 2 }],
		[{ marker: "A", seq: 2, frameId: 2, reason: "stop" }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, geometryRevision: 0 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, intentId: 0 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, intentId: 2 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, cols: 140 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, rows: 40 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, protocol: 2 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, extra: 1 } }],
		[{ ...MATCH(2), metadata: { ...MATCH(2).metadata, cols: 1.5 } }],
		[{ ...MATCH(2), seq: 0 }],
		[{ ...MATCH(2), seq: 1.5 }],
		[],
		"not-an-array",
		[null],
	];
	for (const records of notEvidence) {
		assert.deepEqual(resizeIntentEvidenceFromRecords(INTENT, records), { satisfied: false, proofSeq: null }, `records=${JSON.stringify(records)}`);
	}
	assert.deepEqual(resizeIntentEvidenceFromRecords(null, [MATCH(2)]), { satisfied: false, proofSeq: null });
});
