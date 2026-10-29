// Issue #222 step 23a adapter fix1 (task-23a-adapter-fix1-dispositions.md): pure tests
// for `src/core/attach-frame-proof.mjs` — ordered token stream grammar, exact cursor /
// visibility / erase classification, S boundary insertion, sampling and focus
// invalidation, fail-closed validation and marker limits.
//
// Every reviewer counterexample from df6ccbe7 has a named negative here.
import assert from "node:assert/strict";
import test from "node:test";

import {
	FRAME_WITNESS_PROTOCOL,
	FrameCandidateEvaluator,
	MAX_FRAME_MARKER_BYTES,
	decodeFrameMarker,
	encodeFrameMarkerA,
	encodeFrameMarkerF,
	encodeFrameMarkerS,
	encodeFrameMetadataBase64,
	isValidFrameWitnessToken,
	publishedFrameDecisions,
	scanTerminalOps,
	scanWrite,
	validateFrameMetadata,
} from "../src/core/attach-frame-proof.mjs";

const OPEN = "\u001b[?2026h";
const CLOSE = "\u001b[?2026l";
const CUP = "\u001b[1;1H";
const HIDE = "\u001b[?25l";
const SHOW = "\u001b[?25h";
const TOKEN = "abcdefghijklmnopqrstuv";
const FULL = `${OPEN}${CUP}text${CLOSE}`;
const FACT = { focusPresent: true, focusIdentity: { id: "editor" }, mode: "fullscreen", overlayPresent: false };
const META = {
	protocol: FRAME_WITNESS_PROTOCOL,
	cols: 80,
	rows: 24,
	mode: "fullscreen",
	rendererEpoch: 1,
	sessionEpoch: 0,
	focusPresent: true,
	overlayPresent: false,
	intentId: 0,
	geometryRevision: 0,
};

function evaluator(mode = "fullscreen", extra = {}) {
	return new FrameCandidateEvaluator({ mode, ...extra });
}

function kinds(list) {
	return list.map((entry) => entry.kind);
}

/** Run one write and its completion check (the reporter does exactly this). */
function write(e, text, fact = FACT) {
	const result = e.op({ kind: "write", text });
	return { ...result, decisions: [...result.decisions, ...e.finishWrite(fact)] };
}

function openCandidate(e, { cols = 80, rows = 24, fact = FACT } = {}) {
	e.sizeRead("columns", cols);
	e.sizeRead("rows", rows);
	e.sentinel(fact);
}

// ---------------------------------------------------------------------------
// Ordered token stream
// ---------------------------------------------------------------------------

test("fix1 scanner: tokens are ordered with offsets and exact finals", () => {
	const text = `a${OPEN}b${CUP}c${HIDE}d${CLOSE}e`;
	const tokens = scanTerminalOps(text);
	assert.deepEqual(
		tokens.map((token) => token.kind),
		["text", "sync-open", "text", "cursor-position", "text", "cursor-visibility", "text", "sync-close", "text"],
	);
	assert.equal(text.slice(tokens[1].offset, tokens[1].offset + OPEN.length), OPEN);
	assert.equal(text.slice(tokens[3].offset, tokens[3].offset + CUP.length), CUP);
	// Erase finals are their own kind, never cursor evidence.
	assert.deepEqual(scanTerminalOps("\u001b[2J\u001b[K\u001b[3X").map((token) => token.kind), ["erase", "erase", "erase"]);
	// An unterminated escape is a PENDING TAIL carried to the next write, not a token.
	const pendingCsi = scanWrite("\u001b[?2026", null);
	assert.equal(pendingCsi.pending.kind, "csi");
	assert.equal(pendingCsi.tokens.filter((token) => token.kind !== "text").length, 0);
	assert.equal(scanWrite("\u001b]0;title", null).pending.kind, "osc");
	assert.equal(scanWrite(`${OPEN}\u001b`, null).pending.kind, "esc");
	// An invalid final keeps the sequence PENDING (bounded); it never silently becomes
	// an ordinary token.
	assert.equal(scanWrite("\u001b[1;2\u0001", null).pending.kind, "csi");
	assert.equal(scanWrite("\u001b[1;2\u0001", null).tokens.filter((token) => token.kind !== "text").length, 0);
	// OSC/DCS with a real terminator are classified, never cursor evidence.
	assert.deepEqual(scanTerminalOps("\u001b]0;x\u0007").map((token) => token.kind), ["allowed-control"]);
	assert.deepEqual(scanTerminalOps("\u001bP1$r\u001b\\").map((token) => token.kind), ["unknown-control"]);
});

test("fix1 negative: an erase is never cursor evidence, so a clear-only fullscreen write cannot prove", () => {
	const e = evaluator("fullscreen");
	openCandidate(e);
	const result = write(e, `${OPEN}\u001b[2J${CLOSE}`);
	assert.equal(kinds(result.decisions).includes("S"), false, "no cursor operation => no proof");
	assert.match(result.decisions.at(-1).reason, /fullscreen-frame-without-cursor/);
	assert.equal(publishedFrameDecisions(e.decisions).length, 0);
});

test("fix1 negative: a cursor-relevant unknown control is not silently accepted", () => {
	const e = evaluator("fullscreen");
	openCandidate(e);
	const result = write(e, `${OPEN}\u001b[999z${CLOSE}`);
	assert.equal(kinds(result.decisions).includes("S"), false);
	assert.match(result.decisions.at(-1).reason, /unknown-control/);
	// An invalid final never becomes an ordinary token: it stays a BOUNDED pending tail and
	// abandoning it aborts the candidate.
	const broken = evaluator("fullscreen");
	openCandidate(broken);
	const incomplete = broken.op({ kind: "write", text: `${OPEN}${CUP}text\u001b[1;2\u0001` });
	assert.equal(kinds(incomplete.decisions).includes("S"), false, "an incomplete escape cannot prove");
	const abandoned = broken.fence();
	assert.match(abandoned.at(-1).reason, /^pending-escape-abandoned/);
});

test("fix1: S is inserted exactly before THIS frame's OPEN, after a previous CLOSE in the same write", () => {
	const e = evaluator("regular");
	openCandidate(e, { fact: { ...FACT, mode: "regular" } });
	const previousClose = `${CLOSE}\u001b[2A\u001b[1G`;
	const text = `${previousClose}${OPEN}content`;
	const result = e.op({ kind: "write", text });
	assert.deepEqual(kinds(result.decisions), ["S"]);
	assert.equal(result.insertions.length, 1);
	const offset = result.insertions[0].offset;
	assert.equal(text.slice(offset, offset + OPEN.length), OPEN, "the insertion offset is the new frame's OPEN");
	const previousCloseIndex = text.indexOf(CLOSE);
	assert.ok(offset > previousCloseIndex, "S never precedes the previous frame's CLOSE");
	assert.equal(offset, text.lastIndexOf(OPEN));
});

test("fix1 negative: the next frame's OPEN is not a parking write (no false regular F)", () => {
	const e = evaluator("regular");
	openCandidate(e, { fact: { ...FACT, mode: "regular" } });
	write(e, `${OPEN}content`, { ...FACT, mode: "regular" });
	// CLOSE, then the NEXT frame's OPEN, then a visibility operation.
	e.op({ kind: "write", text: CLOSE });
	const crossed = e.op({ kind: "write", text: `${OPEN}next` });
	assert.equal(kinds(crossed.decisions).includes("F"), false);
	assert.match(crossed.decisions.at(-1).reason, /park-open-crossed/);
	assert.equal(publishedFrameDecisions(e.decisions).filter((entry) => entry.kind === "F").length, 0);
});

test("fix2: a CLOSE split across TWO op() calls completes (no malformed, no lost state)", () => {
	const e = evaluator("regular");
	openCandidate(e, { fact: { ...FACT, mode: "regular" } });
	write(e, `${OPEN}content`, { ...FACT, mode: "regular" });
	// REAL two-op split: the writer cuts the CSI mid-sequence.
	const firstHalf = e.op({ kind: "write", text: "\u001b[?202" });
	assert.deepEqual(firstHalf.decisions, [], "an unterminated escape is pending, not malformed");
	const secondHalf = e.op({ kind: "write", text: "6l" });
	assert.deepEqual(secondHalf.decisions, [], "the completed CLOSE is accepted");
	// Park strictly after the CLOSE, then visibility.
	e.op({ kind: "write", text: "\u001b[3A\u001b[1G" });
	const finish = e.op({ kind: "write", text: HIDE });
	const final = [...finish.decisions, ...e.finishWrite({ ...FACT, mode: "regular" })];
	assert.deepEqual(kinds(final), ["F"], "the split CLOSE still allows the regular F");
	assert.equal(final[0].reason, "regular-open-close-park-and-visibility");
});

test("fix2: an allowed OSC split across two writes completes without aborting", () => {
	const e = evaluator("regular");
	openCandidate(e, { fact: { ...FACT, mode: "regular" } });
	const first = e.op({ kind: "write", text: `${OPEN}\u001b]0;ti` });
	assert.equal(kinds(first.decisions).includes("A"), false, "the pending OSC does not abort");
	assert.deepEqual(kinds(first.decisions), ["S"], "the OPEN itself still proves S");
	const second = e.op({ kind: "write", text: "tle\u0007" });
	assert.deepEqual(second.decisions, [], "the completed OSC 0 title is an allowed control");
	e.op({ kind: "write", text: CLOSE });
	e.op({ kind: "write", text: CUP });
	const fin = e.op({ kind: "write", text: HIDE });
	const final = [...fin.decisions, ...e.finishWrite({ ...FACT, mode: "regular" })];
	assert.deepEqual(kinds(final), ["F"]);
});

test("fix2 negative: a sync OPEN split across writes is rejected (S cannot be retroactive)", () => {
	const e = evaluator("fullscreen");
	openCandidate(e);
	const first = e.op({ kind: "write", text: "\u001b[?202" });
	assert.equal(kinds(first.decisions).includes("S"), false, "the pending OPEN half proves nothing");
	const second = e.op({ kind: "write", text: "6h" });
	assert.equal(second.decisions.at(-1).kind, "none");
	assert.match(second.decisions.at(-1).reason, /split-sync-open-unsupported/);
	assert.equal(e.openFrameId, null);
	assert.equal(publishedFrameDecisions(e.decisions).length, 0, "no retroactive S for a split OPEN");
});

test("fix2: an abandoned pending tail aborts at the fence, and a pending tail is bounded", () => {
	const e = evaluator("fullscreen");
	openCandidate(e);
	e.op({ kind: "write", text: "\u001b[?202" });
	const fenced = e.fence();
	assert.match(fenced.at(-1).reason, /^pending-escape-abandoned/);
	assert.equal(e.openFrameId, null);

	const overflow = evaluator("fullscreen");
	openCandidate(overflow);
	const huge = `\u001b]${"x".repeat(5000)}`;
	const result = overflow.op({ kind: "write", text: huge });
	assert.match(result.decisions.at(-1).reason, /^pending-escape-overflow/);
});

test("fix2: only the §5 no-grid controls are accepted inside a candidate (every family)", () => {
	const allowed = [
		["bracketed-paste", "\u001b[?2004h"],
		["color-scheme", "\u001b[?2031l"],
		["cell-size-query", "\u001b[16t"],
		["device-attributes", "\u001b[c"],
		["keyboard-protocol-push", "\u001b[>7u"],
		["keyboard-protocol-query", "\u001b[?u"],
		["modify-other-keys", "\u001b[>4;2m"],
		["keyboard-protocol-pop", "\u001b[<u"],
		["sgr", "\u001b[38;5;174m"],
		["osc-title", "\u001b]0;pi\u0007"],
		["osc-progress", "\u001b]9;4;3\u0007"],
		["osc-program-status", "\u001b]7501;busy\u001b\\"],
		["osc-palette-query", "\u001b]11;?\u0007"],
	];
	for (const [family, sequence] of allowed) {
		const e = evaluator("fullscreen");
		openCandidate(e);
		const result = e.op({ kind: "write", text: `${OPEN}${sequence}${CUP}x${CLOSE}` });
		assert.equal(kinds(result.decisions).includes("S"), true, `${family} is accepted`);
		const finished = e.finishWrite(FACT);
		assert.deepEqual(kinds(finished), ["F"], `${family} still allows the F`);
	}
	// A completed split allowed control is also accepted (regular: the OPEN write stays whole).
	const split = evaluator("regular");
	openCandidate(split, { fact: { ...FACT, mode: "regular" } });
	split.op({ kind: "write", text: `${OPEN}content\u001b[?20` });
	const rest = split.op({ kind: "write", text: `04h${CUP}x` });
	assert.deepEqual(rest.decisions, [], "the completed split control is allowed");
	split.op({ kind: "write", text: CLOSE });
	split.op({ kind: "write", text: CUP });
	const fin = split.op({ kind: "write", text: HIDE });
	assert.deepEqual(kinds([...fin.decisions, ...split.finishWrite({ ...FACT, mode: "regular" })]), ["F"]);
});

test("fix2 negative: a grid/scroll/unknown control inside a candidate aborts (never F)", () => {
	for (const sequence of ["\u001b[r", "\u001b[s", "\u001b[u", "\u001b M", "\u001b[?1049h", "\u001bP1$r\u001b\\"]) {
		const e = evaluator("fullscreen");
		openCandidate(e);
		const result = e.op({ kind: "write", text: `${OPEN}${sequence}${CUP}x${CLOSE}` });
		assert.equal(kinds(result.decisions).includes("S"), false, `${JSON.stringify(sequence)} must not prove`);
		assert.match(result.decisions.at(-1).reason, /^unknown-control/, `${JSON.stringify(sequence)} aborts as unknown-control`);
		assert.equal(e.finishWrite(FACT).length, 0, "no F after an unknown control");
	}
});

test("fix2: parking must be strictly after the CLOSE (CUP;CLOSE negative, CLOSE;CUP positive)", () => {
	const before = evaluator("regular");
	openCandidate(before, { fact: { ...FACT, mode: "regular" } });
	write(before, `${OPEN}content`, { ...FACT, mode: "regular" });
	// Same write: cursor THEN close — the cursor is before the close, so it is not parking.
	before.op({ kind: "write", text: `${CUP}${CLOSE}` });
	const after = before.op({ kind: "write", text: HIDE });
	assert.equal(kinds(after.decisions).includes("F"), false, "a pre-CLOSE cursor is not parking");
	before.fence();
	assert.equal(publishedFrameDecisions(before.decisions).filter((entry) => entry.kind === "F").length, 0);

	const ordered = evaluator("regular");
	openCandidate(ordered, { fact: { ...FACT, mode: "regular" } });
	write(ordered, `${OPEN}content`, { ...FACT, mode: "regular" });
	// Same write: close THEN cursor — this is real parking.
	const parked = ordered.op({ kind: "write", text: `${CLOSE}${CUP}` });
	assert.deepEqual(parked.decisions, []);
	const fin = ordered.op({ kind: "write", text: HIDE });
	const final = [...fin.decisions, ...ordered.finishWrite({ ...FACT, mode: "regular" })];
	assert.deepEqual(kinds(final), ["F"]);
});

test("fix2: insertion offsets are UTF-16 code units — multibyte text before OPEN splits correctly", () => {
	const e = evaluator("regular");
	openCandidate(e, { fact: { ...FACT, mode: "regular" } });
	const prefix = "中文🙂";
	const text = `${prefix}${OPEN}content`;
	const result = e.op({ kind: "write", text });
	assert.equal(result.insertions.length, 1);
	const offset = result.insertions[0].offset;
	assert.equal(offset, prefix.length, "the offset is a code-unit index, not a byte count");
	assert.equal(Buffer.byteLength(prefix, "utf8"), 10, "the same prefix is 10 bytes, proving the units differ");
	assert.equal(text.slice(offset, offset + OPEN.length), OPEN);
	assert.equal(text.slice(0, offset), prefix, "splitting preserves the multibyte prefix byte-for-byte");
});

// ---------------------------------------------------------------------------
// Sampling + focus invalidation
// ---------------------------------------------------------------------------

test("fix1 negative: a completed new size pair invalidates the old candidate (no stale-geometry F)", () => {
	const e = evaluator("fullscreen");
	e.sizeRead("columns", 80);
	e.sizeRead("rows", 24);
	e.sentinel(FACT);
	e.sizeRead("columns", 100);
	const resampled = e.sizeRead("rows", 24);
	assert.ok(resampled.some((entry) => /resampled-before-s/.test(entry.reason)), "the stale candidate is invalidated before the new one opens");
	const newCandidate = e.decisions.filter((entry) => entry.kind === "candidate").at(-1);
	assert.equal(newCandidate.frameId, 2, "a fresh candidate opens with a new id");
	const stale = write(e, FULL);
	assert.equal(kinds(stale.decisions).includes("S"), false, "the old geometry cannot be proven by the new frame");
});

test("fix1 negative: half-pairs never create a candidate", () => {
	const e = evaluator("fullscreen");
	e.sizeRead("columns", 80);
	e.sizeRead("columns", 90);
	assert.equal(e.openFrameId, null);
	assert.equal(e.decisions.filter((entry) => entry.kind === "candidate").length, 0);
});

test("fix1 negative: focus identity changed at completion aborts instead of publishing F", () => {
	const e = evaluator("fullscreen");
	const factA = { ...FACT, focusIdentity: { id: "a" } };
	openCandidate(e, { fact: factA });
	const written = e.op({ kind: "write", text: FULL });
	assert.equal(kinds(written.decisions).includes("S"), true);
	const finished = e.finishWrite({ ...factA, focusIdentity: { id: "b" } });
	assert.deepEqual(kinds(finished), ["A"]);
	assert.equal(finished[0].reason, "focus-changed-at-completion");
});

test("fix1 negative: focus missing at completion aborts, and overlay/mode changes abort", () => {
	const missing = evaluator("fullscreen");
	openCandidate(missing);
	missing.op({ kind: "write", text: FULL });
	assert.equal(missing.finishWrite({ ...FACT, focusPresent: false }).at(-1).reason, "focus-missing-at-completion");

	const overlay = evaluator("fullscreen");
	openCandidate(overlay);
	overlay.op({ kind: "write", text: FULL });
	assert.equal(overlay.finishWrite({ ...FACT, overlayPresent: true }).at(-1).reason, "overlay-changed-at-completion");
});

// ---------------------------------------------------------------------------
// Validation fail-closed
// ---------------------------------------------------------------------------

test("fix1 validation: frameId and sampledCols must be >= 1 in encode and decode", () => {
	assert.throws(() => encodeFrameMarkerS({ token: TOKEN, frameId: 0, sampledCols: 80 }), />= 1/);
	assert.throws(() => encodeFrameMarkerS({ token: TOKEN, frameId: 1, sampledCols: 0 }), />= 1/);
	assert.throws(() => encodeFrameMarkerF({ token: TOKEN, frameId: 0, metadata: META }));
	assert.throws(() => encodeFrameMarkerA({ token: TOKEN, frameId: 0, reason: "stop" }));
	const zeroId = `\u001bP> agent-board-frame/1 ; ${TOKEN} ; S ; 0 ; 0 ; 80\u001b\\`;
	const zeroCols = `\u001bP> agent-board-frame/1 ; ${TOKEN} ; S ; 1 ; 0 ; 0\u001b\\`;
	assert.equal(decodeFrameMarker(zeroId), null);
	assert.equal(decodeFrameMarker(zeroCols), null);
	// intentId/geometryRevision may legitimately be 0.
	assert.equal(decodeFrameMarker(encodeFrameMarkerS({ token: TOKEN, frameId: 1, intentId: 0, sampledCols: 80 }))?.intentId, 0);
});

test("fix1 validation: decode rejects oversize markers and overlong reasons", () => {
	const oversize = `\u001bP> agent-board-frame/1 ; ${TOKEN} ; A ; 1 ; ${"a".repeat(MAX_FRAME_MARKER_BYTES)}\u001b\\`;
	assert.ok(Buffer.byteLength(oversize) > MAX_FRAME_MARKER_BYTES);
	assert.equal(decodeFrameMarker(oversize), null);
	assert.throws(() => encodeFrameMarkerA({ token: TOKEN, frameId: 1, reason: `a-${"b".repeat(80)}` }));
	assert.equal(decodeFrameMarker(`\u001bP> agent-board-frame/1 ; ${TOKEN} ; A ; 1 ; ${"x".repeat(80)}\u001b\\`), null);
});

test("fix1 validation: an invalid intent enters a refusing state instead of coercing to 0", () => {
	const e = evaluator("fullscreen");
	const refused = e.setIntent({ intentId: "x", geometryRevision: 1, cols: 80, rows: 24 });
	assert.equal(refused.ok, false);
	assert.equal(e.intentRefused, true);
	openCandidate(e);
	const blocked = write(e, FULL);
	assert.equal(kinds(blocked.decisions).includes("S"), false);
	assert.match(blocked.decisions.at(-1).reason, /intent-invalid/);
	// A valid intent clears the refusal and proof resumes.
	assert.equal(e.setIntent({ intentId: 4, geometryRevision: 1, cols: 80, rows: 24 }).ok, true);
	openCandidate(e);
	assert.equal(kinds(write(e, FULL).decisions).includes("S"), true);
	// Explicit clear returns to the ordinary intent.
	assert.equal(e.setIntent(null).ok, true);
	assert.equal(e.intentRefused, false);
});

test("fix1 validation: one-sided/invalid dims and unknown intent fields are refused", () => {
	for (const bad of [
		{ intentId: 1, geometryRevision: 0, cols: 80 },
		{ intentId: 1, geometryRevision: 0, cols: 0, rows: 24 },
		{ intentId: -1, geometryRevision: 0, cols: 80, rows: 24 },
		{ intentId: 1, geometryRevision: 0, cols: 80, rows: 24, extra: true },
	]) {
		const e = evaluator("fullscreen");
		assert.equal(e.setIntent(bad).ok, false, JSON.stringify(bad));
		assert.equal(e.intentRefused, true);
	}
});

test("fix1 validation: metadata still fails closed and metadata stays base64url", () => {
	assert.equal(validateFrameMetadata({ ...META, extra: 1 }).ok, false);
	assert.equal(validateFrameMetadata({ ...META, cols: 0 }).ok, false);
	const encoded = encodeFrameMetadataBase64(META);
	assert.match(encoded, /^[A-Za-z0-9_-]+$/);
	assert.equal(encoded.includes("="), false);
});

// ---------------------------------------------------------------------------
// Preserved grammar guarantees
// ---------------------------------------------------------------------------

test("fix1 preserved: strict origin rule, first-size lock, BOOT/no-sync rejection, frameId carry", () => {
	const origin = evaluator("fullscreen");
	origin.sizeRead("columns", 80);
	origin.sizeRead("rows", 24);
	assert.match(origin.op({ kind: "write", text: "\u001b[?1049h" }).decisions.at(-1).reason, /before-fresh-sentinel/);
	origin.sentinel(FACT);
	assert.equal(kinds(write(origin, FULL).decisions).includes("S"), false, "a later sentinel cannot revive the pair");

	const locked = evaluator("fullscreen");
	locked.sizeRead("columns", 80);
	locked.sizeRead("rows", 24);
	locked.sizeRead("columns", 132);
	const candidate = locked.decisions.find((entry) => entry.kind === "candidate");
	assert.equal(candidate.frameId, 1);
	locked.sentinel(FACT);
	assert.equal(kinds(write(locked, FULL).decisions).includes("S"), true);

	const counter = { value: 0 };
	const first = new FrameCandidateEvaluator({ mode: "fullscreen", frameIdCounter: counter });
	openCandidate(first);
	first.op({ kind: "write", text: FULL });
	first.finishWrite(FACT);
	first.stop();
	const second = new FrameCandidateEvaluator({ mode: "regular", rendererEpoch: 2, frameIdCounter: counter });
	openCandidate(second, { fact: { ...FACT, mode: "regular" } });
	second.op({ kind: "write", text: `${OPEN}x` });
	const ids = [...first.decisions, ...second.decisions].filter((entry) => entry.kind === "candidate").map((entry) => entry.frameId);
	assert.deepEqual(ids, [1, 2]);
});

test("fix1 preserved: stop aborts an emitted S, marker calls never enter accounting", () => {
	const e = evaluator("regular");
	openCandidate(e, { fact: { ...FACT, mode: "regular" } });
	e.op({ kind: "write", text: `${OPEN}x` });
	e.stop();
	assert.deepEqual(publishedFrameDecisions(e.decisions).map((entry) => entry.kind), ["S", "A"]);
	const marker = evaluator("fullscreen");
	openCandidate(marker);
	const before = marker.decisions.length;
	assert.equal(marker.markerWrite("S"), true);
	assert.equal(marker.decisions.length, before);
	assert.equal(isValidFrameWitnessToken(TOKEN), true);
});

// ---------------------------------------------------------------------------
// fix2 scope clarification: OSC 8 inside a frame is an ANNOTATION (parent-approved)
// ---------------------------------------------------------------------------

test("fix2 annotation: paired OSC 8 inside a frame is allowed and never counts as parking/visibility", () => {
	const e = evaluator("fullscreen");
	openCandidate(e);
	const result = e.op({ kind: "write", text: `${OPEN}\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007${CUP}x${CLOSE}` });
	assert.deepEqual(kinds(result.decisions), ["S"], "the annotation neither blocks nor proves");
	assert.deepEqual(kinds(e.finishWrite(FACT)), ["F"], "a balanced annotation still allows F");
	// A balanced OSC 8 cannot stand in for cursor evidence.
	const cursorless = evaluator("fullscreen");
	openCandidate(cursorless);
	cursorless.op({ kind: "write", text: `${OPEN}\u001b]8;;u\u0007link\u001b]8;;\u0007text${CLOSE}` });
	assert.equal(kinds(cursorless.finishWrite(FACT)).includes("F"), false, "an annotation is not cursor evidence");
});

test("fix2 annotation negative: OSC 8 after this candidate's CLOSE invalidates and is not parking", () => {
	const full = evaluator("fullscreen");
	openCandidate(full);
	full.op({ kind: "write", text: `${OPEN}${CUP}x${CLOSE}` });
	const afterClose = full.op({ kind: "write", text: "\u001b]8;;https://example.test\u0007" });
	assert.equal(afterClose.decisions.at(-1).reason, "annotation-after-close");
	assert.equal(full.openFrameId, null);
	assert.equal(full.finishWrite(FACT).length, 0, "no F after a post-CLOSE annotation");

	const regular = evaluator("regular");
	openCandidate(regular, { fact: { ...FACT, mode: "regular" } });
	write(regular, `${OPEN}content`, { ...FACT, mode: "regular" });
	regular.op({ kind: "write", text: CLOSE });
	const postClose = regular.op({ kind: "write", text: "\u001b]8;;u\u0007" });
	assert.equal(postClose.decisions.at(-1).reason, "annotation-after-close", "post-CLOSE annotation is not parking");
	assert.equal(publishedFrameDecisions(regular.decisions).filter((entry) => entry.kind === "F").length, 0);
});

test("fix2 annotation negative: an unclosed OSC 8 at frame end aborts, and a malformed one is unknown", () => {
	const unclosed = evaluator("fullscreen");
	openCandidate(unclosed);
	unclosed.op({ kind: "write", text: `${OPEN}\u001b]8;;https://example.test\u0007link${CUP}x${CLOSE}` });
	const finished = unclosed.finishWrite(FACT);
	assert.deepEqual(kinds(finished), ["A"]);
	assert.equal(finished[0].reason, "unclosed-annotation");

	const malformed = evaluator("fullscreen");
	openCandidate(malformed);
	const bad = malformed.op({ kind: "write", text: `${OPEN}\u001b]8;oops\u0007${CUP}x${CLOSE}` });
	assert.equal(kinds(bad.decisions).includes("S"), false);
	assert.match(bad.decisions.at(-1).reason, /^unknown-control/);
});

test("fix2 annotation: an OSC 8 split across writes completes as an annotation (split-tail)", () => {
	const e = evaluator("regular");
	openCandidate(e, { fact: { ...FACT, mode: "regular" } });
	e.op({ kind: "write", text: `${OPEN}text\u001b]8;;ur` });
	const completed = e.op({ kind: "write", text: `l\u0007link\u001b]8;;` });
	assert.deepEqual(completed.decisions, [], "the completed split open annotation is allowed");
	const closedAnnotation = e.op({ kind: "write", text: "\u0007" });
	assert.deepEqual(closedAnnotation.decisions, [], "the split closing annotation is allowed");
	e.op({ kind: "write", text: CLOSE });
	e.op({ kind: "write", text: CUP });
	const fin = e.op({ kind: "write", text: HIDE });
	assert.deepEqual(kinds([...fin.decisions, ...e.finishWrite({ ...FACT, mode: "regular" })]), ["F"]);
});
