// Issue #222 step 23b2a (task-23b2a-brief.md): pure FW-06 tests for the attach view-proof
// tracker and the exhaustive §5 post-F safe-trailing classifier. Covers every allowlisted
// control family plus negative lookalikes, arbitrary splits/coalescing, pending/malformed/
// overflow tails, DECTCEM vs cursor movement, post-F OSC 8, ordered proof/snapshot coverage,
// same-seq proofs, candidate opening/abort, gaps, eviction and bounded metadata.
import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_EVENTS_PER_SEQ,
	MAX_PROOFS_PER_SEQ,
	MAX_VIEW_PROOF_JOURNAL,
	createSafeTrailingClassifier,
	createViewProofTracker,
} from "../src/core/attach-view-proof.mjs";
import { FRAME_WITNESS_PROTOCOL, encodeFrameMarkerA, encodeFrameMarkerF, encodeFrameMarkerS } from "../src/core/attach-frame-proof.mjs";
import { createFrameStreamParser } from "../src/core/attach-frame-stream.mjs";

const ESC = "\u001b";
const BEL = "\u0007";
const PASTE_ON = `${ESC}[?2004h`;
const PASTE_OFF = `${ESC}[?2004l`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const TITLE = `${ESC}]0;agent-board${BEL}`;
const PROGRESS = `${ESC}]9;4;3;50${BEL}`;
const PALETTE_QUERY = `${ESC}]4;1;?${BEL}`;
const META = {
	protocol: 1,
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
const TOKEN = "runner-token-0123456789abcdef";
const PARSER_META = { ...META, sessionEpoch: 3 };
const S = (frameId) => encodeFrameMarkerS({ token: TOKEN, frameId, intentId: 0, sampledCols: 80 });
const F = (frameId) => encodeFrameMarkerF({ token: TOKEN, frameId, metadata: PARSER_META });
const A = (frameId, reason = "stop") => encodeFrameMarkerA({ token: TOKEN, frameId, reason });

function parserProofs(markers) {
	const parser = createFrameStreamParser({ token: TOKEN, instanceId: "inst-23b2a-fix1", sessionEpoch: 3 });
	return parser.push(markers);
}

function freshClassifier(options = {}) {
	return createSafeTrailingClassifier(options);
}

function tracker(options = {}) {
	return createViewProofTracker(options);
}

function feedSafe(t, seq, text = PASTE_ON) {
	const result = t.feedOutput(seq, text);
	assert.equal(result.status, "safe", `seq ${seq} should classify safe: ${result.reason}`);
	return result;
}

function recordProof(t, seq, frameId, extra = {}) {
	const opened = t.openCandidate({ seq, frameId, sessionEpoch: META.sessionEpoch });
	assert.equal(opened.status, "ok", `open ${seq}/${frameId}: ${opened.reason}`);
	const completed = t.completeProof({ seq, frameId, metadata: META, ...extra });
	assert.equal(completed.status, "ok", `complete ${seq}/${frameId}: ${completed.reason}`);
	return completed.proof;
}

// ---------------------------------------------------------------------------
// Safe-trailing classifier: exhaustive allowlist
// ---------------------------------------------------------------------------

test("23b2a classifier: every allowlisted §5 control form is safe", () => {
	const cases = [
		["bracketed paste on", `${ESC}[?2004h`],
		["bracketed paste off", `${ESC}[?2004l`],
		["color scheme on", `${ESC}[?2031h`],
		["color scheme off", `${ESC}[?2031l`],
		["cell-size query", `${ESC}[16t`],
		["device attributes", `${ESC}[c`],
		["keyboard protocol push", `${ESC}[>7u`],
		["keyboard protocol query", `${ESC}[?u`],
		["modifyOtherKeys 0", `${ESC}[>4;0m`],
		["modifyOtherKeys 2", `${ESC}[>4;2m`],
		["keyboard protocol pop", `${ESC}[<u`],
		["DECTCEM hide", `${ESC}[?25l`],
		["DECTCEM show", `${ESC}[?25h`],
		["OSC title BEL", `${ESC}]0;title${BEL}`],
		["OSC title ST", `${ESC}]0;title${ESC}\\`],
		["OSC progress", `${ESC}]9;4;3;50${BEL}`],
		["OSC program status", `${ESC}]7501;busy${BEL}`],
		["OSC 10 query", `${ESC}]10;?${BEL}`],
		["OSC 11 query", `${ESC}]11;?${BEL}`],
		["OSC 4 query", `${ESC}]4;1;?${BEL}`],
	];
	for (const [name, sequence] of cases) {
		const classifier = freshClassifier();
		const result = classifier.push(sequence);
		assert.equal(result.status, "safe", `${name} must be safe`);
		assert.equal(result.reason, null);
		assert.equal(result.events.length, 1, `${name} must produce one classified event`);
		assert.equal(result.events[0].family.length > 0, true);
	}
});

test("23b2a classifier: safe controls keep their bounded input/theme/query meaning", () => {
	const classifier = freshClassifier();
	const result = classifier.push(`${PASTE_ON}${TITLE}${PROGRESS}${PALETTE_QUERY}${ESC}[?2031h${ESC}[>7u${ESC}[?u${ESC}[<u`);
	assert.equal(result.status, "safe");
	assert.deepEqual(
		result.events.map((event) => event.family),
		["bracketed-paste", "osc-title", "osc-progress", "osc-palette-query", "color-scheme", "keyboard-protocol-push", "keyboard-protocol-query", "keyboard-protocol-pop"],
	);
	assert.equal(result.metadata.bracketedPaste, true);
	assert.equal(result.metadata.colorSchemeNotifications, true);
	assert.equal(result.metadata.keyboardProtocolPushes, 1);
	assert.equal(result.metadata.keyboardProtocolQueries, 1);
	assert.equal(result.metadata.keyboardProtocolPops, 1);
	assert.equal(result.metadata.titles, 1);
	assert.deepEqual(result.metadata.progress, { state: 3, percent: 50 });
	assert.equal(result.metadata.paletteQueries, 1);
	assert.equal(result.events[1].bytes, "agent-board".length);
	assert.equal(result.events[3].query, "4;1;?");
});

test("23b2a classifier: DECTCEM updates visibility only", () => {
	const classifier = freshClassifier();
	const hidden = classifier.push(HIDE);
	assert.equal(hidden.status, "safe");
	assert.equal(hidden.cursorVisible, false);
	const shown = classifier.push(SHOW);
	assert.equal(shown.status, "safe");
	assert.equal(shown.cursorVisible, true);
	assert.equal(classifier.state().cursorVisible, true);
});

test("23b2a classifier: non-allowlisted controls, text and bare bytes are unsafe", () => {
	const cases = [
		["cursor up", `${ESC}[2A`],
		["cursor backward", `${ESC}[5D`],
		["cursor column", `${ESC}[3G`],
		["cursor line", `${ESC}[10d`],
		["cursor position", `${ESC}[1;2H`],
		["erase display", `${ESC}[2J`],
		["erase line", `${ESC}[K`],
		["erase chars", `${ESC}[2X`],
		["sync open", `${ESC}[?2026h`],
		["sync close", `${ESC}[?2026l`],
		["alternate screen", `${ESC}[?1049h`],
		["normal screen", `${ESC}[?1047l`],
		["application cursor", `${ESC}[?1h`],
		["mouse tracking", `${ESC}[?1000h`],
		["mouse SGR", `${ESC}[?1006h`],
		["plain SGR is not allowlisted", `${ESC}[1m`],
		["unknown CSI", `${ESC}[999z`],
		["OSC 52 clipboard", `${ESC}]52;c;Zm9v${BEL}`],
		["OSC 8 open", `${ESC}]8;;https://example.test${BEL}`],
		["OSC 8 close", `${ESC}]8;;${BEL}`],
		["OSC 4 setter", `${ESC}]4;1;rgb:1111/2222/3333${BEL}`],
		["OSC 10 setter", `${ESC}]10;rgb:1111/2222/3333${BEL}`],
		["OSC 11 setter", `${ESC}]11;rgb:1111/2222/3333${BEL}`],
		["ordinary text", "hello"],
		["bare BEL", BEL],
		["ESC 7", `${ESC}7`],
		["ESC reverse index", `${ESC}M`],
		["DCS", `${ESC}P1$r0m${ESC}\\`],
		["SOS", `${ESC}Xabc${ESC}\\`],
		["PM", `${ESC}^abc${ESC}\\`],
		["APC", `${ESC}_abc${ESC}\\`],
	];
	for (const [name, sequence] of cases) {
		const classifier = freshClassifier();
		const result = classifier.push(sequence);
		assert.equal(result.status, "unsafe", `${name} must be unsafe`);
		assert.equal(typeof result.reason, "string");
		assert.equal(result.reason.length > 0, true);
	}
});

// ---------------------------------------------------------------------------
// Streaming boundaries, pending tails and boundedness
// ---------------------------------------------------------------------------

test("23b2a classifier: every split position of a CSI resumes without a false safe verdict", () => {
	const sequence = `${ESC}[?2004h`;
	for (let split = 1; split < sequence.length; split += 1) {
		const classifier = freshClassifier();
		const first = classifier.push(sequence.slice(0, split));
		assert.equal(first.status, "pending", `split ${split} must be pending, not safe`);
		const second = classifier.push(sequence.slice(split));
		assert.equal(second.status, "safe", `split ${split} must complete safely`);
		assert.equal(second.events[0].family, "bracketed-paste");
	}
});

test("23b2a classifier: every split position of OSC BEL and OSC ST resumes", () => {
	for (const sequence of [`${ESC}]0;title${BEL}`, `${ESC}]0;title${ESC}\\`]) {
		for (let split = 1; split < sequence.length; split += 1) {
			const classifier = freshClassifier();
			assert.equal(classifier.push(sequence.slice(0, split)).status, "pending", `split ${split} pending`);
			const completed = classifier.push(sequence.slice(split));
			assert.equal(completed.status, "safe", `split ${split} complete`);
			assert.equal(completed.events[0].family, "osc-title");
		}
	}
});

test("23b2a classifier: a sequence fed one character at a time stays pending until the terminator", () => {
	const classifier = freshClassifier();
	const sequence = `${ESC}]0;title${ESC}\\`;
	for (const character of sequence.slice(0, -1)) assert.equal(classifier.push(character).status, "pending");
	const completed = classifier.push(sequence.at(-1));
	assert.equal(completed.status, "safe");
	assert.equal(completed.events[0].family, "osc-title");
});

test("23b2a classifier: coalesced safe sequences stay safe and safe+unsafe becomes unsafe", () => {
	const safe = freshClassifier().push(`${PASTE_ON}${TITLE}${ESC}[16t`);
	assert.equal(safe.status, "safe");
	assert.equal(safe.events.length, 3);

	const mixed = freshClassifier().push(`${PASTE_ON}${TITLE}hello`);
	assert.equal(mixed.status, "unsafe");
	assert.equal(mixed.reason, "bare-byte");
});

test("23b2a classifier: a pending suffix is not confirmed safe and later resolves or invalidates", () => {
	const resolved = freshClassifier();
	assert.equal(resolved.push(`${ESC}[?200`).status, "pending");
	assert.equal(resolved.push("4h").status, "safe");

	const invalidated = freshClassifier();
	assert.equal(invalidated.push(`${ESC}[?200`).status, "pending");
	const bad = invalidated.push("x");
	assert.equal(bad.status, "unsafe");
	assert.equal(bad.reason, "csi-unknown");
});

test("23b2a classifier: malformed and oversize tails fail closed and stay unsafe", () => {
	const malformedCsi = freshClassifier().push(`${ESC}[1${BEL}`);
	assert.equal(malformedCsi.status, "unsafe");
	assert.equal(malformedCsi.reason, "csi-malformed");

	const malformedOsc = freshClassifier().push(`${ESC}]0;title${ESC}X`);
	assert.equal(malformedOsc.status, "unsafe");
	assert.equal(malformedOsc.reason, "osc-malformed");

	const bounded = freshClassifier({ maxPending: 32 });
	const overflow = bounded.push(`${ESC}]0;${"a".repeat(40)}`);
	assert.equal(overflow.status, "unsafe");
	assert.equal(overflow.reason, "pending-overflow");
	assert.equal(overflow.pendingBytes, 0);

	const completeOversize = freshClassifier({ maxPending: 32 }).push(`${ESC}]0;${"a".repeat(40)}${BEL}`);
	assert.equal(completeOversize.status, "unsafe");
	assert.equal(completeOversize.reason, "sequence-oversize");

	const sticky = freshClassifier();
	assert.equal(sticky.push("text").status, "unsafe");
	const afterSafe = sticky.push(`${PASTE_ON}${TITLE}`);
	assert.equal(afterSafe.status, "unsafe");
	assert.equal(afterSafe.reason, "bare-byte");
});

// ---------------------------------------------------------------------------
// Proof tracker: exact and trailing coverage
// ---------------------------------------------------------------------------

test("23b2a tracker: exact proof covers the snapshot at proof.seq, not frameId", () => {
	const t = tracker();
	feedSafe(t, 1);
	const proof = recordProof(t, 1, 42, { metadata: META, cursorVisible: true });
	assert.equal(proof.marker, "F");
	assert.equal(proof.seq, 1);
	const coverage = t.coverageFor(1);
	assert.equal(coverage.status, "covered");
	assert.equal(coverage.reason, "exact-proof");
	assert.equal(coverage.proof.seq, 1);
	assert.equal(coverage.proof.frameId, 42);
	assert.equal(coverage.proof.metadata.cols, 80);
	assert.equal(coverage.throughSeq, 1);
	assert.equal(coverage.cursorVisible, true);
});

test("23b2a fix1 F1: actual 23b1 parser F shape is accepted with nested metadata intact", () => {
	const parts = parserProofs(`${S(1)}frame${F(1)}`);
	const actual = parts.find((part) => part.kind === "proof").proof;
	actual.seq = 1;
	const t = tracker();
	feedSafe(t, 1);
	assert.equal(t.openCandidate({ seq: 1, frameId: actual.frameId, sessionEpoch: actual.sessionEpoch }).status, "ok");
	const completed = t.completeProof(actual);
	assert.equal(completed.status, "ok", completed.reason);
	assert.equal(completed.proof.marker, "F");
	assert.equal(completed.proof.frameId, 1);
	assert.equal(completed.proof.seq, 1);
	assert.equal(completed.proof.sessionEpoch, 3);
	assert.deepEqual(completed.proof.metadata, {
		protocol: FRAME_WITNESS_PROTOCOL,
		cols: 80,
		rows: 24,
		mode: "fullscreen",
		rendererEpoch: 1,
		sessionEpoch: 3,
		focusPresent: true,
		overlayPresent: false,
		intentId: 0,
		geometryRevision: 0,
	});
	assert.equal(t.coverageFor(1).status, "covered");
});

test("23b2a fix1 F1: actual parser A is rejected as a proof, never covered, but can abort", () => {
	const parts = parserProofs(`${S(1)}frame${A(1, "resize")}`);
	const actual = parts.find((part) => part.kind === "proof").proof;
	actual.seq = 1;
	const t = tracker();
	feedSafe(t, 1);
	assert.equal(t.openCandidate({ seq: 1, frameId: actual.frameId, sessionEpoch: actual.sessionEpoch }).status, "ok");
	const rejected = t.completeProof(actual);
	assert.equal(rejected.status, "protocol-error");
	assert.equal(rejected.reason, "proof-reason");
	assert.equal(t.coverageFor(1).status, "unavailable");
	assert.equal(t.coverageFor(1).proof, null);
	assert.equal(t.snapshot().currentProof, null);
	assert.equal(t.abortCandidate(actual).status, "ok");
	assert.equal(t.coverageFor(1).reason, "candidate-aborted");
});

test("23b2a fix1 F1: flattened host summary is rejected instead of silently dropping identity", () => {
	const flattened = {
		marker: "F",
		frameId: 1,
		seq: 1,
		sessionEpoch: 3,
		cols: 80,
		rows: 24,
		mode: "fullscreen",
		intentId: 0,
		geometryRevision: 0,
	};
	const t = tracker();
	feedSafe(t, 1);
	assert.equal(t.openCandidate({ seq: 1, frameId: 1, sessionEpoch: 3 }).status, "ok");
	const rejected = t.completeProof(flattened);
	assert.equal(rejected.status, "protocol-error");
	assert.equal(rejected.reason, "proof-unexpected-field:cols");
	assert.equal(t.coverageFor(1).status, "unavailable");
});

test("23b2a fix1 F1: missing, null and invalid nested metadata are protocol errors", () => {
	const t = tracker();
	feedSafe(t, 1);
	assert.equal(t.openCandidate({ seq: 1, frameId: 1 }).status, "ok");
	assert.equal(t.completeProof({ marker: "F", seq: 1, frameId: 1 }).reason, "proof-metadata-missing");
	assert.equal(t.completeProof({ marker: "F", seq: 1, frameId: 1, metadata: null }).reason, "proof-metadata-missing");
	assert.equal(t.completeProof({ marker: "F", seq: 1, frameId: 1, metadata: { ...META, cols: 0 } }).reason, "proof-metadata:cols");
	assert.equal(t.completeProof({ marker: "F", seq: 1, frameId: 1, metadata: { ...META, protocol: 2 } }).reason, "proof-metadata:protocol");
});

test("23b2a fix1 F1: marker, kind, abort reason and conflicting identity are rejected", () => {
	const t = tracker();
	feedSafe(t, 1);
	assert.equal(t.openCandidate({ seq: 1, frameId: 1 }).status, "ok");
	assert.equal(t.completeProof({ marker: "A", seq: 1, frameId: 1, metadata: META }).reason, "proof-marker");
	assert.equal(t.completeProof({ marker: "S", seq: 1, frameId: 1, metadata: META }).reason, "proof-marker");
	assert.equal(t.completeProof({ kind: "A", seq: 1, frameId: 1, metadata: META }).reason, "proof-kind");
	assert.equal(t.completeProof({ kind: "S", seq: 1, frameId: 1, metadata: META }).reason, "proof-kind");
	assert.equal(t.completeProof({ marker: "F", kind: "A", seq: 1, frameId: 1, metadata: META }).reason, "proof-kind");
	assert.equal(t.completeProof({ marker: "F", seq: 1, frameId: 1, metadata: META, reason: "stop" }).reason, "proof-reason");
	assert.equal(t.completeProof({ marker: "F", seq: 1, frameId: 1, sessionEpoch: 8, metadata: META }).reason, "proof-session-epoch-conflict");
	assert.equal(t.completeProof({ marker: "F", seq: 1, frameId: 1, protocol: 1, metadata: META }).reason, "proof-unexpected-field:protocol");
	assert.equal(t.completeProof({ marker: "F", seq: 1, frameId: 1, metadata: META }).status, "ok");
});

test("23b2a tracker: a proof older than the snapshot is covered only by safe trailing controls", () => {
	const t = tracker();
	feedSafe(t, 1);
	recordProof(t, 1, 1);
	feedSafe(t, 2, HIDE);
	feedSafe(t, 3, SHOW);
	const coverage = t.coverageFor(3);
	assert.equal(coverage.status, "covered");
	assert.equal(coverage.reason, "safe-trailing");
	assert.equal(coverage.proof.seq, 1);
	assert.equal(coverage.throughSeq, 3);
	assert.equal(coverage.cursorVisible, true);
});

test("23b2a tracker: a pending trailing tail is unavailable until the split sequence resolves safely", () => {
	const t = tracker();
	feedSafe(t, 1);
	recordProof(t, 1, 1);
	const pending = t.feedOutput(2, `${ESC}[?200`);
	assert.equal(pending.status, "pending");
	const blocked = t.coverageFor(2);
	assert.equal(blocked.status, "unavailable");
	assert.equal(blocked.reason, "trailing-pending");
	assert.equal(blocked.detail, "incomplete-escape");
	assert.equal(blocked.pendingBytes > 0, true);
	assert.equal(blocked.throughSeq, 1);
	feedSafe(t, 3, "4h");
	const covered = t.coverageFor(3);
	assert.equal(covered.status, "covered");
	assert.equal(covered.reason, "safe-trailing");
	assert.equal(covered.throughSeq, 3);
	assert.equal(t.replay(2, 2).entries[0].status, "safe", "the split sequence resolves its original segment");
});

test("23b2a tracker: a pending tail that turns unsafe invalidates all segments of the split sequence", () => {
	const t = tracker();
	feedSafe(t, 1);
	recordProof(t, 1, 1);
	t.feedOutput(2, `${ESC}[?200`);
	t.feedOutput(3, "hello");
	const coverage = t.coverageFor(3);
	assert.equal(coverage.status, "unavailable");
	assert.equal(coverage.reason, "trailing-unsafe");
	assert.equal(t.replay(2, 3).entries[0].status, "unsafe");
	assert.equal(t.replay(2, 3).entries[1].status, "unsafe");
});

test("23b2a tracker: multiple proofs at one seq keep production order and the newest wins coverage", () => {
	const t = tracker();
	feedSafe(t, 1);
	recordProof(t, 1, 1);
	recordProof(t, 1, 2);
	const coverage = t.coverageFor(1);
	assert.equal(coverage.status, "covered");
	assert.equal(coverage.proof.frameId, 2);
	assert.equal(coverage.throughSeq, 1, "same-seq proofs never invent output bytes");
	const replay = t.replay(1, 1);
	assert.equal(replay.status, "ok");
	assert.deepEqual(replay.entries[0].proofs.map((proof) => proof.frameId), [1, 2]);
	assert.equal(t.snapshot().currentProof.frameId, 2);
});

test("23b2a tracker: DECTCEM preserves coverage while cursor movement invalidates it", () => {
	const t = tracker();
	feedSafe(t, 1);
	recordProof(t, 1, 1);
	feedSafe(t, 2, HIDE);
	assert.equal(t.coverageFor(2).status, "covered");
	assert.equal(t.coverageFor(2).cursorVisible, false);
	feedSafe(t, 3, SHOW);
	assert.equal(t.coverageFor(3).status, "covered");
	assert.equal(t.coverageFor(3).cursorVisible, true);
	const moved = t.feedOutput(4, `${ESC}[2A`);
	assert.equal(moved.status, "unsafe");
	const invalidated = t.coverageFor(4);
	assert.equal(invalidated.status, "unavailable");
	assert.equal(invalidated.reason, "trailing-unsafe");
	assert.equal(invalidated.throughSeq, 3);
});

test("23b2a tracker: post-F OSC 8, including a paired hyperlink, invalidates coverage", () => {
	for (const osc8 of [`${ESC}]8;;https://example.test${BEL}`, `${ESC}]8;;${BEL}`, `${ESC}]8;;url${BEL}${ESC}]8;;${BEL}`]) {
		const t = tracker();
		feedSafe(t, 1);
		recordProof(t, 1, 1);
		t.feedOutput(2, osc8);
		const coverage = t.coverageFor(2);
		assert.equal(coverage.status, "unavailable");
		assert.equal(coverage.reason, "trailing-unsafe");
	}
});

test("23b2a tracker: text, erase and sync mode after F invalidate current coverage", () => {
	for (const unsafe of ["text", `${ESC}[2J`, `${ESC}[?2026h`]) {
		const t = tracker();
		feedSafe(t, 1);
		recordProof(t, 1, 1);
		t.feedOutput(2, unsafe);
		const coverage = t.coverageFor(2);
		assert.equal(coverage.status, "unavailable");
		assert.equal(coverage.reason, "trailing-unsafe");
	}
});

test("23b2a tracker: a later valid proof recovers after unsafe trailing output", () => {
	const t = tracker();
	feedSafe(t, 1);
	recordProof(t, 1, 1);
	t.feedOutput(2, "text");
	assert.equal(t.coverageFor(2).status, "unavailable");
	recordProof(t, 2, 2);
	const recovered = t.coverageFor(2);
	assert.equal(recovered.status, "covered");
	assert.equal(recovered.reason, "exact-proof");
	assert.equal(recovered.proof.frameId, 2);
	feedSafe(t, 3, HIDE);
	assert.equal(t.coverageFor(3).status, "covered");
	assert.equal(t.coverageFor(3).cursorVisible, false);
});

test("23b2a tracker: missing and future facts stay UNKNOWN", () => {
	const noProof = tracker();
	feedSafe(noProof, 1);
	assert.deepEqual(noProof.coverageFor(1), { status: "unknown", reason: "no-proof", proof: null, throughSeq: null, cursorVisible: null });

	const t = tracker();
	feedSafe(t, 1);
	assert.equal(t.coverageFor(2).reason, "snapshot-seq-future");
	assert.equal(t.coverageFor(0).reason, "invalid-snapshot-seq");
	assert.equal(tracker().coverageFor(1).reason, "no-output");

	const baseline = tracker();
	feedSafe(baseline, 5);
	assert.equal(baseline.coverageFor(1).reason, "snapshot-before-window");
});

// ---------------------------------------------------------------------------
// Proof tracker: candidate lifecycle and protocol errors
// ---------------------------------------------------------------------------

test("23b2a tracker: an open candidate makes current coverage unavailable but keeps previousComplete separate", () => {
	const t = tracker();
	feedSafe(t, 1);
	recordProof(t, 1, 1);
	feedSafe(t, 2, HIDE);
	assert.equal(t.openCandidate({ seq: 2, frameId: 2 }).status, "ok");
	const open = t.coverageFor(2);
	assert.equal(open.status, "unavailable");
	assert.equal(open.reason, "candidate-open");
	assert.equal(open.proof, null, "the previous proof is never presented as current");
	assert.equal(open.previousComplete.seq, 1);
	assert.equal(open.previousComplete.frameId, 1);
	assert.equal(t.snapshot().currentProof, null, "the snapshot never presents a previous proof as current");
	assert.equal(t.snapshot().previousComplete.seq, 1);
	assert.equal(t.abortCandidate({ seq: 2, frameId: 2, reason: "resize" }).status, "ok");
	const aborted = t.coverageFor(2);
	assert.equal(aborted.status, "unavailable");
	assert.equal(aborted.reason, "candidate-aborted");
	assert.equal(aborted.proof, null);
	assert.equal(aborted.previousComplete.seq, 1);
});

test("23b2a tracker: future, regressed and malformed ordering is a protocol error", () => {
	const output = tracker();
	feedSafe(output, 1);
	assert.equal(output.feedOutput(1, PASTE_ON).reason, "output-seq-regressed");
	assert.equal(output.feedOutput(0, PASTE_ON).reason, "invalid-output-seq");
	assert.equal(output.feedOutput(2, 42).reason, "invalid-output-data");

	const futureCandidate = tracker();
	feedSafe(futureCandidate, 1);
	assert.equal(futureCandidate.openCandidate({ seq: 2, frameId: 1 }).reason, "candidate-seq-future");

	const futureProof = tracker();
	feedSafe(futureProof, 1);
	assert.equal(futureProof.openCandidate({ seq: 1, frameId: 1 }).status, "ok");
	assert.equal(futureProof.completeProof({ seq: 2, frameId: 1, metadata: META }).reason, "proof-seq-future");

	const regressedCandidate = tracker();
	feedSafe(regressedCandidate, 1);
	feedSafe(regressedCandidate, 2);
	recordProof(regressedCandidate, 2, 2);
	assert.equal(regressedCandidate.openCandidate({ seq: 1, frameId: 3 }).reason, "candidate-seq-regressed");
});

test("23b2a tracker: malformed candidate/proof identity and mismatched epochs are rejected", () => {
	const t = tracker();
	feedSafe(t, 1);
	assert.equal(t.openCandidate({ seq: 1, frameId: 0 }).reason, "candidate-frame-id");
	assert.equal(t.openCandidate({ seq: 0, frameId: 1 }).reason, "candidate-seq");
	assert.equal(t.openCandidate({ seq: 1, frameId: 1, sessionEpoch: -1 }).reason, "candidate-session-epoch");
	assert.equal(t.completeProof({ seq: 1, frameId: "1", metadata: META }).reason, "proof-frame-id");
	assert.equal(t.completeProof({ seq: 1, frameId: 1, cursorVisible: "yes", metadata: META }).reason, "proof-cursor-visible");
	assert.equal(t.completeProof({ seq: 1, frameId: 1, metadata: { ...META, cols: 0 } }).reason, "proof-metadata:cols");
	assert.equal(t.openCandidate({ seq: 1, frameId: 1, sessionEpoch: 7 }).status, "ok");
	assert.equal(t.completeProof({ seq: 1, frameId: 1, sessionEpoch: 8, metadata: { ...META, sessionEpoch: 8 } }).reason, "proof-session-epoch-mismatch");
});

test("23b2a tracker: duplicate open, frame mismatch and proof without candidate are protocol errors", () => {
	const t = tracker();
	feedSafe(t, 1);
	feedSafe(t, 2);
	assert.equal(t.completeProof({ seq: 2, frameId: 1, metadata: META }).reason, "proof-without-candidate");
	assert.equal(t.openCandidate({ seq: 1, frameId: 1 }).status, "ok");
	assert.equal(t.openCandidate({ seq: 1, frameId: 2 }).reason, "candidate-already-open");
	assert.equal(t.abortCandidate({ seq: 1, frameId: 9 }).reason, "abort-frame-mismatch");
	assert.equal(t.abortCandidate({ seq: 1, frameId: 1 }).status, "ok");
	assert.equal(t.abortCandidate({ seq: 1, frameId: 1 }).reason, "abort-without-candidate");
	assert.equal(t.openCandidate({ seq: 2, frameId: 2 }).status, "ok");
	assert.equal(t.completeProof({ seq: 2, frameId: 1, metadata: META }).reason, "proof-frame-mismatch");
	assert.equal(t.completeProof({ seq: 1, frameId: 2, metadata: META }).reason, "proof-seq-before-candidate");
});

// ---------------------------------------------------------------------------
// Replay, gaps, eviction and boundedness
// ---------------------------------------------------------------------------

test("23b2a tracker: an output gap is explicit and never guessed", () => {
	const t = tracker();
	feedSafe(t, 1);
	const gap = t.feedOutput(3, PASTE_ON);
	assert.equal(gap.status, "protocol-error");
	assert.equal(gap.reason, "output-gap");
	assert.equal(gap.expected, 2);
	assert.equal(t.coverageFor(3).status, "unknown");
	assert.equal(t.coverageFor(3).reason, "output-gap");
	const replay = t.replay(1, 3);
	assert.equal(replay.status, "gap");
	assert.equal(replay.missingSeq, 2);
	assert.equal(replay.droppedProofs, 0);
	assert.equal(replay.droppedEvents, 0);
	assert.deepEqual(replay.entries, []);
});

test("23b2a tracker: bounded journal reports eviction instead of stitching old and new", () => {
	const t = tracker({ maxJournal: 3 });
	feedSafe(t, 1);
	recordProof(t, 1, 1);
	for (let seq = 2; seq <= 5; seq += 1) feedSafe(t, seq);
	const state = t.snapshot();
	assert.equal(state.journal.size, 3);
	assert.equal(state.journal.earliestSeq, 3);
	assert.equal(state.journal.droppedSegments, 2);
	assert.equal(state.journal.droppedProofs, 1);
	assert.equal(t.replay(1, 2).status, "evicted");
	assert.equal(t.replay(1, 2).droppedEvents, 0);
	assert.equal(t.replay(3, 5).status, "ok");
	assert.equal(t.replay(3, 5).droppedProofs, 1);
	assert.equal(t.replay(3, 5).droppedEvents, 0);
	assert.deepEqual(t.replay(3, 5).entries.map((entry) => entry.seq), [3, 4, 5]);
	const oldCoverage = t.coverageFor(5);
	assert.equal(oldCoverage.status, "unknown");
	assert.equal(oldCoverage.reason, "journal-evicted");
	assert.equal(t.coverageFor(1).status, "covered", "an exact retained proof still covers its own seq");
});

test("23b2a fix2 F2: eviction counts retained proofs once, not per-entry drops again", () => {
	const t = tracker({ maxJournal: 4 });
	feedSafe(t, 1);
	for (let frameId = 1; frameId <= 20; frameId += 1) {
		assert.equal(t.openCandidate({ seq: 1, frameId, sessionEpoch: META.sessionEpoch }).status, "ok");
		assert.equal(t.completeProof({ seq: 1, frameId, metadata: META }).status, "ok");
	}
	const before = t.replay(1, 1);
	assert.equal(before.status, "ok");
	assert.equal(before.entries[0].proofs.length, MAX_PROOFS_PER_SEQ);
	assert.equal(before.entries[0].droppedProofs, 4, "4 of 20 same-seq proofs were truncated");
	assert.equal(before.droppedProofs, 4, "lifetime truncation count before eviction");

	for (let seq = 2; seq <= 5; seq += 1) feedSafe(t, seq);
	const state = t.snapshot();
	assert.equal(state.journal.size, 4);
	assert.equal(state.journal.earliestSeq, 2);
	assert.equal(state.journal.droppedSegments, 1);
	assert.equal(state.journal.droppedProofs, 20, "16 evicted retained proofs + 4 earlier truncated proofs, counted once");
	assert.equal(state.journal.droppedEvents, 0);
	assert.equal(t.replay(1, 1).status, "evicted");
	assert.equal(t.replay(1, 1).droppedProofs, 20);

	const retainedRange = t.replay(2, 5);
	assert.equal(retainedRange.status, "ok");
	assert.equal(retainedRange.droppedProofs, 20, "aggregate is LIFETIME even for a fully retained range");
	assert.equal(retainedRange.droppedEvents, 0);
	for (const entry of retainedRange.entries) {
		assert.equal(entry.droppedProofs, 0, "per-entry drops are RANGE-LOCAL");
		assert.equal(entry.droppedEvents, 0);
	}
	assert.equal(t.coverageFor(1).status, "covered", "the exact current proof remains usable");
});

test("23b2a tracker: replay returns ordered classifications and proofs without output copies", () => {
	const t = tracker();
	feedSafe(t, 1);
	recordProof(t, 1, 1);
	feedSafe(t, 2, HIDE);
	const replay = t.replay(1, 2);
	assert.equal(replay.status, "ok");
	assert.equal(replay.droppedProofs, 0);
	assert.equal(replay.droppedEvents, 0);
	assert.equal(replay.entries[0].proofs[0].seq, 1);
	assert.equal(replay.entries[0].proofs[0].frameId, 1);
	assert.equal(replay.entries[0].droppedProofs, 0);
	assert.equal(replay.entries[0].droppedEvents, 0);
	assert.equal(replay.entries[1].status, "safe");
	assert.equal(replay.entries[1].events[0].family, "dectcem");
	for (const entry of replay.entries) {
		assert.equal(Object.hasOwn(entry, "data"), false);
		assert.equal(Object.hasOwn(entry, "raw"), false);
	}
});

test("23b2a tracker: metadata is bounded and no title/program text is retained", () => {
	const secret = "secret-title-do-not-store";
	const t = tracker();
	const result = t.feedOutput(1, `${ESC}]0;${secret}${BEL}${PROGRESS}${PALETTE_QUERY}`);
	assert.equal(result.status, "safe");
	assert.equal(result.metadata.titles, 1);
	assert.equal(result.metadata.progress.percent, 50);
	assert.equal(result.metadata.paletteQueries, 1);
	assert.deepEqual(result.events.map((event) => event.family), ["osc-title", "osc-progress", "osc-palette-query"]);
	assert.equal(result.events[0].bytes, secret.length);
	const serialized = JSON.stringify({ replay: t.replay(1, 1), state: t.snapshot() });
	assert.equal(serialized.includes(secret), false, "no output text is retained in journal or snapshot");
});

test("23b2a tracker: a later proof starts a new trailing window without erasing safe control metadata", () => {
	const t = tracker();
	feedSafe(t, 1, `${TITLE}${PASTE_ON}`);
	recordProof(t, 1, 1);
	const state = t.snapshot();
	assert.equal(state.classifier.status, "safe");
	assert.equal(state.classifier.metadata.titles, 1);
	assert.equal(state.classifier.metadata.bracketedPaste, true);
	feedSafe(t, 2, HIDE);
	assert.equal(t.coverageFor(2).status, "covered");
	assert.equal(t.coverageFor(2).cursorVisible, false);
});

test("23b2a fix1 F2: per-entry and aggregate droppedEvents are surfaced on replay", () => {
	const t = tracker();
	const result = t.feedOutput(1, PASTE_ON.repeat(MAX_EVENTS_PER_SEQ + 1));
	assert.equal(result.status, "safe");
	assert.equal(result.events.length, MAX_EVENTS_PER_SEQ);
	assert.equal(result.droppedEvents, 1);
	const replay = t.replay(1, 1);
	assert.equal(replay.status, "ok");
	assert.equal(replay.entries[0].droppedEvents, 1);
	assert.equal(replay.entries[0].droppedProofs, 0);
	assert.equal(replay.droppedEvents, 1);
	assert.equal(replay.droppedProofs, 0);
});

test("23b2a fix1 F3: maxPending and pendingBytes are UTF-8 bytes, not code units", () => {
	const pending = freshClassifier().push(`${ESC}]0;é`);
	assert.equal(pending.status, "pending");
	assert.equal(pending.pendingBytes, 6, "ESC ] 0 ; = 4 bytes plus é = 2 bytes");

	const csiPending = freshClassifier().push(`${ESC}[?20`);
	assert.equal(csiPending.status, "pending");
	assert.equal(csiPending.pendingBytes, 5);

	const completeOscOversize = freshClassifier({ maxPending: 16 }).push(`${ESC}]0;${"é".repeat(8)}${BEL}`);
	assert.equal(completeOscOversize.status, "unsafe");
	assert.equal(completeOscOversize.reason, "sequence-oversize", "18 body bytes exceed 16 even though the string is 10 code units");

	const pendingOscOverflow = freshClassifier({ maxPending: 16 }).push(`${ESC}]0;${"é".repeat(8)}`);
	assert.equal(pendingOscOverflow.status, "unsafe");
	assert.equal(pendingOscOverflow.reason, "pending-overflow", "20 pending bytes exceed 16 even though the string is 12 code units");

	const split = freshClassifier({ maxPending: 16 });
	assert.equal(split.push(`${ESC}]0;${"é".repeat(5)}`).status, "pending");
	const splitOverflow = split.push("éé");
	assert.equal(splitOverflow.status, "unsafe");
	assert.equal(splitOverflow.reason, "pending-overflow");

	const completeCsiOversize = freshClassifier({ maxPending: 16 }).push(`${ESC}[${"1".repeat(20)}H`);
	assert.equal(completeCsiOversize.status, "unsafe");
	assert.equal(completeCsiOversize.reason, "sequence-oversize");
});

test("23b2a fix1 F4: replay distinguishes invalid, future, before-window and empty ranges", () => {
	assert.equal(tracker().replay(1, 1).reason, "no-output");

	const t = tracker();
	feedSafe(t, 1);
	feedSafe(t, 2);
	assert.equal(t.replay(0, 1).reason, "invalid-range");
	assert.equal(t.replay(2, 1).reason, "invalid-range");
	assert.equal(t.replay(1, 3).reason, "future-range");
	assert.equal(t.replay(1, 3).droppedProofs, 0);
	assert.equal(t.replay(1, 3).droppedEvents, 0);

	const baseline = tracker();
	feedSafe(baseline, 5);
	assert.equal(baseline.replay(1, 5).reason, "before-window");
	assert.equal(baseline.replay(5, 5).status, "ok");
});

test("23b2a fix1 F4: classifier reset starts a clean window and applies visibility", () => {
	const classifier = freshClassifier();
	assert.equal(classifier.push(`${TITLE}text`).status, "unsafe");
	classifier.reset({ cursorVisible: true });
	const reset = classifier.state();
	assert.equal(reset.status, "safe");
	assert.equal(reset.reason, null);
	assert.equal(reset.pendingBytes, 0);
	assert.equal(reset.cursorVisible, true);
	assert.equal(reset.metadata.titles, 1, "reset does not erase a previously set title fact");
	assert.equal(classifier.push(HIDE).cursorVisible, false);
	classifier.reset();
	assert.equal(classifier.state().cursorVisible, null, "missing visibility after reset stays UNKNOWN");
});

test("23b2a tracker: the journal and per-seq proof list stay bounded", () => {
	const t = tracker();
	for (let seq = 1; seq <= MAX_VIEW_PROOF_JOURNAL + 44; seq += 1) feedSafe(t, seq);
	const state = t.snapshot();
	assert.equal(state.journal.size, MAX_VIEW_PROOF_JOURNAL);
	assert.equal(state.journal.droppedSegments, 44);

	const sameSeq = tracker();
	feedSafe(sameSeq, 1);
	for (let frameId = 1; frameId <= MAX_PROOFS_PER_SEQ + 3; frameId += 1) {
		assert.equal(sameSeq.openCandidate({ seq: 1, frameId }).status, "ok");
		assert.equal(sameSeq.completeProof({ seq: 1, frameId, metadata: META }).status, "ok");
	}
	const entry = sameSeq.replay(1, 1).entries[0];
	const replay = sameSeq.replay(1, 1);
	assert.equal(entry.proofs.length, MAX_PROOFS_PER_SEQ, "19 same-seq proofs cannot look complete");
	assert.equal(entry.droppedProofs, 3);
	assert.equal(replay.droppedProofs, 3);
	assert.equal(replay.droppedEvents, 0);
	assert.equal(sameSeq.snapshot().journal.droppedProofs, 3);
	assert.equal(sameSeq.coverageFor(1).proof.frameId, MAX_PROOFS_PER_SEQ + 3, "newest same-seq proof still wins coverage");
});
