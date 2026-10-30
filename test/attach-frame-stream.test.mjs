// Issue #222 step 23b1 (task-23b1-brief.md): pure FW-03 tests for the runner-side DCS
// frame-marker stream parser. Covers chunk/merge/split boundaries, strip semantics,
// S→F/A identity and order, token/frameId/oversize validation, unknown DCS handling,
// bounded pending tails and non-ASCII prefixes.
import assert from "node:assert/strict";
import test from "node:test";

import { createFrameStreamParser, MAX_PENDING_MARKER_TAIL } from "../src/core/attach-frame-stream.mjs";
import { FRAME_WITNESS_PROTOCOL, encodeFrameMarkerA, encodeFrameMarkerF, encodeFrameMarkerS } from "../src/core/attach-frame-proof.mjs";

const TOKEN = "runner-token-0123456789abcdef";
const OTHER_TOKEN = "runner-token-zyxwvutsrqponmlk";
const S = (frameId, extra = {}) => encodeFrameMarkerS({ token: TOKEN, frameId, intentId: 0, sampledCols: 80, ...extra });
const F = (frameId, metadata = {}) =>
	encodeFrameMarkerF({
		token: TOKEN,
		frameId,
		metadata: {
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
			...metadata,
		},
	});
const A = (frameId, reason = "stop") => encodeFrameMarkerA({ token: TOKEN, frameId, reason });

function parser() {
	return createFrameStreamParser({ token: TOKEN, instanceId: "inst-1", sessionEpoch: 3 });
}

function outputs(parts) {
	return parts.filter((part) => part.kind === "output").map((part) => part.data);
}

function proofs(parts) {
	return parts.filter((part) => part.kind === "proof").map((part) => part.proof);
}

test("23b2b stream: S yields an additive candidate part; proof history stays F/A only", () => {
	const p = parser();
	const opened = p.push(`a${S(7)}`);
	const candidate = opened.find((part) => part.kind === "candidate");
	assert.equal(candidate !== undefined, true);
	assert.deepEqual(candidate.candidate, { marker: "S", frameId: 7, seq: null, sessionEpoch: 3, intentId: 0, sampledCols: 80 });
	assert.deepEqual(proofs(opened), [], "S is not stored as a proof");
	assert.equal(p.snapshot().proofs.length, 0);
	const closed = p.push(`b${F(7)}`);
	assert.deepEqual(proofs(closed).map((proof) => [proof.marker, proof.frameId]), [["F", 7]]);
	assert.equal(p.snapshot().proofs.length, 1, "accepted F/A proof semantics stay intact");
});

test("23b1 stream: markers are stripped and ordinary output is split at exact boundaries", () => {
	const p = parser();
	const parts = p.push(`hello${S(1)}world${F(1)}tail`);
	assert.deepEqual(outputs(parts), ["hello", "world", "tail"], "no marker bytes reach the output segments");
	assert.deepEqual(proofs(parts).map((proof) => [proof.marker, proof.frameId, proof.seq]), [["F", 1, null]]);
	assert.equal(proofs(parts)[0].metadata.cols, 80);
	assert.equal(proofs(parts)[0].sessionEpoch, 3);
	// A chunk that is only a marker yields no output segment at all.
	assert.deepEqual(outputs(p.push(S(2))), []);
});

test("23b1 stream: a marker split across arbitrary chunks completes exactly once", () => {
	const p = parser();
	const marker = S(1);
	const parts = [];
	for (const character of marker) parts.push(...p.push(character));
	assert.deepEqual(outputs(parts), [], "a partial marker never leaks bytes");
	assert.deepEqual(proofs(parts), []);
	const rest = p.push(`after${F(1)}`);
	assert.deepEqual(outputs(rest), ["after"]);
	assert.deepEqual(proofs(rest).map((proof) => proof.marker), ["F"]);
});

test("23b1 stream: coalesced chunk with two frames keeps S/F order and identity", () => {
	const p = parser();
	const parts = p.push(`${S(1)}a${F(1)}${S(2)}b${F(2)}`);
	assert.deepEqual(outputs(parts), ["a", "b"]);
	assert.deepEqual(proofs(parts).map((proof) => [proof.marker, proof.frameId]), [["F", 1], ["F", 2]]);
	assert.equal(p.snapshot().markers, 4);
});

test("23b1 stream: F without S, duplicate F, duplicate S and regressing frameId are protocol errors", () => {
	const noS = parser();
	assert.deepEqual(proofs(noS.push(F(1))), []);
	assert.match(noS.snapshot().diagnostics.at(-1).reason, /close-without-open-s/);

	const duplicateF = parser();
	duplicateF.push(`${S(1)}x${F(1)}${F(1)}`);
	assert.equal(proofs(duplicateF.push("")).length, 0);
	assert.match(duplicateF.snapshot().diagnostics.at(-1).reason, /close-without-open-s|duplicate/);

	const duplicateS = parser();
	const dup = duplicateS.push(`${S(1)}${S(1)}`);
	assert.deepEqual(proofs(dup), []);
	assert.match(duplicateS.snapshot().diagnostics.at(-1).reason, /s-with-open-candidate|duplicate/);

	const regress = parser();
	regress.push(`${S(2)}x${F(2)}${S(1)}`);
	assert.match(regress.snapshot().diagnostics.at(-1).reason, /frameid-regression/);
});

test("23b1 stream: a wrong-token marker is dropped and never proves", () => {
	const p = parser();
	const foreign = encodeFrameMarkerS({ token: OTHER_TOKEN, frameId: 1, intentId: 0, sampledCols: 80 });
	const parts = p.push(`a${foreign}${encodeFrameMarkerF({ token: OTHER_TOKEN, frameId: 1, metadata: { protocol: 1, cols: 80, rows: 24, mode: "regular", rendererEpoch: 1, sessionEpoch: 0, focusPresent: true, overlayPresent: false, intentId: 0, geometryRevision: 0 } })}b`);
	assert.deepEqual(outputs(parts), ["a", "b"], "foreign marker bytes are stripped");
	assert.deepEqual(proofs(parts), []);
	assert.equal(p.snapshot().diagnostics.filter((entry) => entry.reason === "marker-wrong-token").length, 2);
});

test("23b1 stream: oversize and invalid markers are bounded diagnostics, never proof", () => {
	const p = parser();
	const oversize = `\u001bP> agent-board-frame/1 ; ${TOKEN} ; A ; 1 ; ${"x".repeat(MAX_PENDING_MARKER_TAIL)}\u001b\\`;
	const parts = p.push(`a${oversize}b`);
	assert.deepEqual(outputs(parts), ["a", "b"]);
	assert.deepEqual(proofs(parts), []);
	assert.match(p.snapshot().diagnostics.at(-1).reason, /marker-oversize|marker-invalid|marker-tail-oversize/);
	assert.ok(p.snapshot().diagnostics.length <= 64, "diagnostics stay bounded");
});

test("23b1 stream: unknown non-marker DCS preserves legacy output unchanged", () => {
	const p = parser();
	const dcs = "\u001bP1$r0m\u001b\\";
	const parts = p.push(`a${dcs}b`);
	assert.equal(outputs(parts).join(""), `a${dcs}b`, "an unrelated DCS is ordinary output");
	assert.deepEqual(proofs(parts), []);
	assert.deepEqual(p.snapshot().diagnostics, []);
});

test("23b1 stream: A closes a frame with its reason; F and A are mutually exclusive per frame", () => {
	const p = parser();
	p.push(S(1));
	const parts = p.push(A(1, "incomplete-at-fence"));
	assert.deepEqual(proofs(parts).map((proof) => [proof.marker, proof.frameId, proof.reason]), [["A", 1, "incomplete-at-fence"]]);
	// A second close for the same frame is a protocol error, not a proof.
	assert.deepEqual(proofs(p.push(F(1))), []);
	assert.match(p.snapshot().diagnostics.at(-1).reason, /close-without-open-s/);
});

test("23b1 stream: a pending partial marker at finish is invalid; an open candidate at end is reported", () => {
	const p = parser();
	p.push(`a${S(1).slice(0, 12)}`);
	const finished = p.finish("child-exit");
	assert.match(finished.diagnostics.at(-1).reason, /pending-marker-at-end/);
	assert.deepEqual(finished.proofs, []);
	const open = parser();
	open.push(`a${S(1)}b`);
	const openFinish = open.finish("child-exit");
	assert.match(openFinish.diagnostics.at(-1).reason, /open-candidate-at-end/);
});

test("23b1 stream: non-ASCII prefixes split correctly and keep byte-exact segments", () => {
	const p = parser();
	const prefix = "中文🙂";
	const parts = p.push(`${prefix}${S(1)}${prefix}${F(1)}尾`);
	assert.deepEqual(outputs(parts), [prefix, prefix, "尾"]);
	assert.equal(Buffer.from(outputs(parts)[0]).equals(Buffer.from(prefix, "utf8")), true);
});

test("23b1 stream: an interleaved S/F sequence across chunks never yields a proof before its S", () => {
	const p = parser();
	const partsA = p.push(`${S(1)}text`);
	const partsB = p.push(F(1).slice(0, 20));
	const partsC = p.push(`${F(1).slice(20)}more`);
	assert.deepEqual(proofs([...partsA, ...partsB]), []);
	assert.deepEqual(proofs(partsC).map((proof) => proof.frameId), [1]);
	assert.deepEqual(outputs(partsC), ["more"]);
});

test("23b1 stream: a marker-family lookalike without a valid body is dropped, not forwarded", () => {
	const p = parser();
	const parts = p.push(`a\u001bP> agent-board-frame/1 ; garbage\u001b\\b`);
	assert.deepEqual(outputs(parts), ["a", "b"]);
	assert.deepEqual(proofs(parts), []);
	assert.equal(p.snapshot().diagnostics.length > 0, true);
});

// fix1 (F5/F8/F9): stored proofs, seq on the same object, caps, trailing-byte finish.
test("23b1 fix1: accepted proofs are stored and the SAME object receives the runner seq", () => {
	const p = parser();
	p.push(S(1));
	const parts = p.push(`x${F(1)}`);
	const proofPart = parts.find((part) => part.kind === "proof");
	assert.equal(proofPart !== undefined, true);
	proofPart.proof.seq = 42; // the runner assigns the preceding ordinary segment's seq
	const snapshot = p.snapshot();
	assert.equal(snapshot.proofs.length, 1, "snapshot reports the actual proof");
	assert.equal(snapshot.proofs[0].seq, 42, "the stored proof is the same object");
	assert.equal(snapshot.proofs[0].frameId, 1);
	const finished = p.finish("child-exit");
	assert.equal(finished.proofs.length, 1);
	assert.equal(finished.proofs[0].seq, 42);
});

test("23b1 fix1: proof history and finished-id caps expose dropped counts", () => {
	const p = parser();
	for (let index = 1; index <= 300; index += 1) {
		p.push(S(index));
		p.push(F(index));
	}
	const snapshot = p.snapshot();
	assert.equal(snapshot.proofs.length, 256, "proof history is bounded");
	assert.equal(snapshot.droppedProofs, 44, "dropped proofs are counted, never silent");
	assert.ok(snapshot.droppedFinishedIds >= 0);
});

test("23b1 fix1: finish returns a trailing ordinary byte instead of dropping it", () => {
	const p = parser();
	p.push("abc\u001b");
	const finished = p.finish("child-exit");
	assert.equal(finished.trailing, "\u001b", "a lone trailing ESC is ordinary output, not lost");
	assert.equal(finished.diagnostics.some((entry) => entry.reason === "pending-marker-at-end"), false);

	const marker = parser();
	marker.push(`abc${S(1).slice(0, 10)}`);
	const markerFinished = marker.finish("child-exit");
	assert.equal(markerFinished.trailing, "", "a pending marker-family tail is never forwarded");
	assert.equal(markerFinished.diagnostics.some((entry) => entry.reason === "pending-marker-at-end"), true);
});

test("23b1 fix1: a regressed marker is diagnostic and later valid frames still prove (regression-then-recovery)", () => {
	const p = parser();
	p.push(`${S(2)}a${F(2)}`);
	p.push(`${S(1)}`); // regression: dropped, never a proof
	const recovered = p.push(`${S(3)}b${F(3)}`);
	assert.deepEqual(recovered.filter((part) => part.kind === "proof").map((part) => part.proof.frameId), [3]);
	assert.equal(p.snapshot().diagnostics.some((entry) => entry.reason === "marker-frameid-regression"), true);
	assert.equal(p.snapshot().proofs.filter((proof) => proof.frameId === 1).length, 0);
});
