// Issue #222 step 23b2c1: pure §4 presentation decision + source identity comparison.
import assert from "node:assert/strict";
import test from "node:test";

import { canPublishAttachView, decideAttachPresentation } from "../src/core/pty-attach-render.mjs";

const PARSER = { id: "parser-1" };
const ID = {
	connectionToken: "conn-1",
	baselineToken: "baseline-1",
	generation: "gen-1",
	parser: PARSER,
	geometryRevision: 2,
	targetCols: 80,
	targetRows: 24,
	closed: false,
};
const META = {
	protocol: 1,
	cols: 80,
	rows: 24,
	mode: "fullscreen",
	rendererEpoch: 1,
	sessionEpoch: 1,
	focusPresent: true,
	overlayPresent: false,
	intentId: 0,
	geometryRevision: 2,
};
const COVERED = {
	status: "covered",
	reason: "safe-trailing",
	proof: { marker: "F", seq: 9, frameId: 1, sessionEpoch: 1, metadata: META },
	throughSeq: 10,
	cursorVisible: true,
};

function view(over = {}) {
	return {
		closed: false,
		mode: "protocol",
		baselineState: "valid-content",
		localParseComplete: true,
		frameState: "complete",
		openSyncBlock: false,
		openCandidate: false,
		contentAvailable: true,
		contentKind: "complete",
		localSeq: 10,
		viewProof: COVERED,
		viewIdentity: ID,
		currentIdentity: ID,
		targetCols: 80,
		targetRows: 24,
		geometryRevision: 2,
		requiredGeometryRevision: 2,
		resizeIntentRequired: false,
		resizeIntentSatisfied: false,
		intentId: 0,
		deadlineState: "pending",
		...over,
	};
}

const decide = (over = {}) => decideAttachPresentation(view(over));

test("23b2c1 decision: exact identity is required on every axis", () => {
	assert.equal(canPublishAttachView(ID, ID), true);
	for (const [name, changed] of [
		["connectionToken", { ...ID, connectionToken: "old-conn" }],
		["baselineToken", { ...ID, baselineToken: "old-baseline" }],
		["generation", { ...ID, generation: "old-gen" }],
		["parser", { ...ID, parser: { id: "parser-old" } }],
		["geometryRevision", { ...ID, geometryRevision: 1 }],
		["targetCols", { ...ID, targetCols: 81 }],
		["targetRows", { ...ID, targetRows: 25 }],
		["closed", { ...ID, closed: true }],
	]) {
		assert.equal(canPublishAttachView(changed, ID), false, `${name} mismatch must reject`);
	}
	assert.equal(canPublishAttachView({ ...ID, connectionToken: "" }, ID), false);
	assert.equal(canPublishAttachView({ ...ID, parser: null }, ID), false);
	assert.equal(canPublishAttachView(null, ID), false);
	assert.equal(canPublishAttachView(ID, undefined), false);
});

test("23b2c1 decision: a fully current complete view publishes", () => {
	assert.deepEqual(decide(), { action: "publish", reason: "complete" });
});

test("23b2c1 fix1 RED: coverage throughSeq must equal localSeq exactly", () => {
	assert.deepEqual(decide({ viewProof: { ...COVERED, throughSeq: 12 } }), { action: "wait", reason: "view-proof-future" });
	assert.deepEqual(decide({ viewProof: { ...COVERED, throughSeq: 9 } }), { action: "wait", reason: "view-proof-behind" });
});

test("23b2c1 fix1 RED: covered proof geometry must match the current target", () => {
	const targetId = { ...ID, targetCols: 100, targetRows: 30 };
	assert.deepEqual(
		decide({ targetCols: 100, targetRows: 30, viewIdentity: targetId, currentIdentity: targetId }),
		{ action: "wait", reason: "proof-geometry-mismatch" },
	);
});

test("23b2c1 fix1 RED: required resize intent must be carried by the proof", () => {
	assert.deepEqual(decide({ resizeIntentRequired: true, resizeIntentSatisfied: true, intentId: 7 }), {
		action: "wait",
		reason: "resize-intent",
	});
});

test("23b2c4: a resized target publishes only with the exact intent/revision; stale geometry waits", () => {
	const resizedMeta = { ...META, intentId: 2, geometryRevision: 2 };
	const resizedCovered = {
		...COVERED,
		proof: { ...COVERED.proof, sessionEpoch: 1, metadata: resizedMeta },
	};
	const publishable = {
		viewProof: resizedCovered,
		resizeIntentRequired: true,
		resizeIntentSatisfied: true,
		intentId: 2,
		requiredGeometryRevision: 2,
	};
	assert.deepEqual(decide(publishable), { action: "publish", reason: "complete" });
	assert.deepEqual(decide({ ...publishable, viewProof: { ...resizedCovered, proof: { ...resizedCovered.proof, metadata: { ...resizedMeta, intentId: 1 } } } }), {
		action: "wait",
		reason: "resize-intent",
	});
	assert.deepEqual(decide({ ...publishable, viewProof: { ...resizedCovered, proof: { ...resizedCovered.proof, metadata: { ...resizedMeta, geometryRevision: 1 } } } }), {
		action: "wait",
		reason: "geometry-revision",
	});
	assert.deepEqual(decide({ ...publishable, resizeIntentSatisfied: false }), { action: "wait", reason: "resize-intent" });
	assert.deepEqual(decide({ ...publishable, viewIdentity: { ...ID, geometryRevision: 1 } }), { action: "wait", reason: "identity-mismatch" });
});

test("23b2c1 fix1 RED: unknown or partial content kinds never publish", () => {
	assert.deepEqual(decide({ contentKind: "partial" }), { action: "wait", reason: "content-kind-unknown" });
});

test("23b2c1 fix1 RED: covered proof.seq cannot exceed throughSeq", () => {
	assert.deepEqual(
		decide({ viewProof: { ...COVERED, proof: { ...COVERED.proof, seq: 11 } } }),
		{ action: "wait", reason: "view-proof-invalid" },
	);
});

test("23b2c1 decision: closed and legacy are independent of proof facts", () => {
	assert.deepEqual(decide({ closed: true, viewProof: null }), { action: "closed", reason: "closed" });
	assert.deepEqual(decide({ mode: "legacy", viewProof: null }), { action: "legacy", reason: "legacy-mode" });
	assert.deepEqual(decide({ mode: "undecided" }), { action: "wait", reason: "mode-undecided" });
	assert.deepEqual(decide({ mode: "raw" }), { action: "wait", reason: "mode-raw" });
});

test("23b2c1 decision: baseline and local parse gates wait", () => {
	for (const [over, reason] of [
		[{ baselineState: "unverified" }, "baseline-unverified"],
		[{ baselineState: "hydrating" }, "baseline-hydrating"],
		[{ baselineState: "undecided" }, "baseline-unknown"],
		[{ localParseComplete: false }, "local-parse-incomplete"],
		[{ frameState: "open" }, "sync-open"],
		[{ frameState: "unknown" }, "frame-incomplete"],
		[{ openSyncBlock: true }, "sync-open"],
		[{ openCandidate: true }, "candidate-open"],
		[{ contentAvailable: false }, "content-missing"],
		[{ contentKind: "boot" }, "boot-content"],
		[{ contentKind: "raw" }, "raw-content"],
	]) {
		assert.deepEqual(decide(over), { action: "wait", reason }, JSON.stringify(over));
	}
});

test("23b2c1 decision: proof must be covered through the local seq", () => {
	for (const [over, reason] of [
		[{ viewProof: null }, "view-proof-missing"],
		[{ viewProof: { ...COVERED, status: "unknown", proof: null } }, "view-proof-unknown"],
		[{ viewProof: { ...COVERED, status: "unavailable", proof: null } }, "view-proof-unavailable"],
		[{ viewProof: { ...COVERED, throughSeq: 9 } }, "view-proof-behind"],
		[{ viewProof: { ...COVERED, proof: null } }, "view-proof-missing"],
		[{ localSeq: 10.5 }, "view-proof-behind"],
	]) {
		assert.deepEqual(decide(over), { action: "wait", reason }, JSON.stringify(over));
	}
});

test("23b2c1 decision: identity, geometry and resize-intent gates", () => {
	assert.deepEqual(decide({ currentIdentity: { ...ID, connectionToken: "old" } }), { action: "wait", reason: "identity-mismatch" });
	assert.deepEqual(decide({ targetCols: undefined }), { action: "wait", reason: "geometry-unknown" });
	assert.deepEqual(decide({ requiredGeometryRevision: 3 }), { action: "wait", reason: "geometry-revision" });
	assert.deepEqual(decide({ resizeIntentRequired: true, resizeIntentSatisfied: false }), { action: "wait", reason: "resize-intent" });
	assert.deepEqual(decide({ resizeIntentRequired: true, resizeIntentSatisfied: true, intentId: 0 }), { action: "wait", reason: "resize-intent" });
	const intentOne = { ...COVERED, proof: { ...COVERED.proof, metadata: { ...META, intentId: 1 } } };
	assert.deepEqual(decide({ resizeIntentRequired: true, resizeIntentSatisfied: true, intentId: 1, viewProof: intentOne }), {
		action: "publish",
		reason: "complete",
	});
	assert.deepEqual(decide({ resizeIntentRequired: false, intentId: 0 }), { action: "publish", reason: "complete" });
});

test("23b2c1 decision: empty baseline needs a later fully complete live view", () => {
	assert.deepEqual(decide({ baselineState: "valid-empty", localSeq: 0, contentAvailable: false }), {
		action: "wait",
		reason: "empty-baseline-needs-live-complete",
	});
	assert.deepEqual(decide({ baselineState: "valid-empty", localSeq: 10 }), { action: "publish", reason: "complete" });
	assert.deepEqual(decide({ baselineState: "valid-empty", localSeq: 10, contentKind: "boot" }), { action: "wait", reason: "boot-content" });
});

test("23b2c1 decision: expired deadline only renames waits and never upgrades incomplete views", () => {
	assert.deepEqual(decide({ deadlineState: "expired" }), { action: "publish", reason: "complete" });
	assert.deepEqual(decide({ deadlineState: "expired", frameState: "open" }), {
		action: "wait",
		reason: "deadline-expired:sync-open",
	});
	assert.deepEqual(decide({ deadlineState: "expired", viewProof: null }), {
		action: "wait",
		reason: "deadline-expired:view-proof-missing",
	});
});

// Issue #294 A1b: the intent-evidence / ordinary-head alternative.
const ORD_HEAD = { ...META, intentId: 0, geometryRevision: 0 };
const ordCovered = () => ({
	...COVERED,
	proof: { ...COVERED.proof, metadata: ORD_HEAD },
	throughSeq: 10,
});
const armed = (over = {}) => view({
	resizeIntentRequired: true,
	resizeIntentSatisfied: true,
	resizeIntentProofSeq: 9,
	intentId: 7,
	viewProof: ordCovered(),
	...over,
});

test("A1b: fresh evidence + ordinary 0/0 head at target dims publishes", () => {
	assert.deepEqual(decide(armed()), { action: "publish", reason: "complete" });
});

test("A1b: no evidence / not satisfied keeps the original waits", () => {
	// Fixtures use a rev-matching head (META carries geometryRevision 2 =
	// required): per the spec §3 gate order the earlier geometry gate only
	// releases a rev-0 ordinary head when fresh evidence exists, so with no
	// evidence the intent gate is what names the original wait here.
	assert.deepEqual(decide(armed({ viewProof: COVERED, resizeIntentProofSeq: undefined })), { action: "wait", reason: "resize-intent" });
	assert.deepEqual(decide(armed({ viewProof: COVERED, resizeIntentSatisfied: false })), { action: "wait", reason: "resize-intent" });
	assert.deepEqual(decide(view({ resizeIntentRequired: true, resizeIntentSatisfied: false, intentId: 7 })), { action: "wait", reason: "resize-intent" });
	// Ordinary (0/0) head + no evidence fails closed to the earlier gate.
	assert.deepEqual(decide(armed({ resizeIntentProofSeq: undefined })), { action: "wait", reason: "geometry-revision" });
});

test("A1b: stale evidence (proofSeq > throughSeq) keeps waiting on the head checks", () => {
	assert.deepEqual(decide(armed({ viewProof: ordCovered() , resizeIntentProofSeq: 11 })), { action: "wait", reason: "geometry-revision" });
});

test("A1b: a wrong-non-zero head is NOT ordinary — gates stay even with valid evidence", () => {
	assert.deepEqual(decide(armed({ viewProof: { ...ordCovered(), proof: { ...ordCovered().proof, metadata: { ...ORD_HEAD, geometryRevision: 5 } } } })), { action: "wait", reason: "geometry-revision" });
	// Rev-matching wrong-intent head: the geometry gate passes, so the intent gate names the wait.
	assert.deepEqual(decide(armed({ viewProof: { ...COVERED, proof: { ...COVERED.proof, metadata: { ...META, intentId: 3 } } } })), { action: "wait", reason: "resize-intent" });
});

test("A1b: a wrong-size ordinary head still waits on proof-geometry-mismatch", () => {
	assert.deepEqual(decide(armed({ viewProof: { ...ordCovered(), proof: { ...ordCovered().proof, metadata: { ...ORD_HEAD, cols: 140 } } } })), { action: "wait", reason: "proof-geometry-mismatch" });
});

test("A1b: a head carrying the intent itself keeps the original publish path", () => {
	const intentMeta = { ...META, intentId: 7, geometryRevision: 2 };
	assert.deepEqual(decide(armed({ viewProof: { ...COVERED, proof: { ...COVERED.proof, metadata: intentMeta } } })), { action: "publish", reason: "complete" });
});
