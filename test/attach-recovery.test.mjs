// Issue #284: attach recovery policy units. classifyProofStatus implements the
// spec §3.1.1 induction table; the decideAttachPresentation tests below cover the
// §3.1 committed-degraded predicate chain. Issue #288 T1 adds the
// classifyProofInvalidFamily cap-floor eligibility table and the predicate 5
// three-state split on deadlineState + capRecoverable.
import assert from "node:assert/strict";
import test from "node:test";

import { classifyProofInvalidFamily, classifyProofStatus, sanitizeViewProofEnumPair } from "../src/core/attach-recovery.mjs";
import { decideAttachPresentation } from "../src/core/pty-attach-render.mjs";

/** Coverage shape helper matching coverageFor/unknownViewProof/invalidateViewProof output. */
const shape = (status, reason, extra = {}) => ({
	status,
	reason,
	proof: null,
	throughSeq: null,
	cursorVisible: null,
	...extra,
});

test("284 T1 §3.1.1 base table: no proof object classifies as none", () => {
	assert.equal(classifyProofStatus(null, false), "none");
});

test("284 T1 §3.1.1 base table: covered shapes classify as covered", () => {
	assert.equal(classifyProofStatus(shape("covered", "exact-proof"), false), "covered");
	assert.equal(classifyProofStatus(shape("covered", "safe-trailing"), false), "covered");
});

test("284 T1 §3.1.1 base table: snapshot coverageFor candidate shapes classify as missing", () => {
	assert.equal(classifyProofStatus(shape("unavailable", "candidate-open"), false), "missing");
	assert.equal(classifyProofStatus(shape("unavailable", "candidate-aborted"), false), "missing");
});

test("284 T1 §3.1.1 base table: live record candidate shapes classify as missing", () => {
	// Live S/A records arrive as unknown+candidate-* via invalidateViewProof
	// (src/ui/pty-attach.ts:1319/1326), not as coverageFor's unavailable shape.
	assert.equal(classifyProofStatus(shape("unknown", "candidate-open"), false), "missing");
	assert.equal(classifyProofStatus(shape("unknown", "candidate-aborted"), false), "missing");
});

test("284 T1 §3.1.1 base table: never-proven shapes classify as missing", () => {
	assert.equal(classifyProofStatus(shape("unknown", "no-proof"), false), "missing");
	assert.equal(classifyProofStatus(shape("unknown", "no-output"), false), "missing");
});

test("284 T1 §3.1.1 base table: covered-then-degraded trailing shapes classify as invalid", () => {
	assert.equal(classifyProofStatus(shape("unavailable", "trailing-pending"), false), "invalid");
	assert.equal(classifyProofStatus(shape("unavailable", "trailing-unsafe"), false), "invalid");
});

test("284 T1 §3.1.1 base table: coverageFor window/continuity reasons classify as invalid", () => {
	for (const reason of [
		"output-gap",
		"journal-gap",
		"journal-evicted",
		"proof-evicted",
		"snapshot-seq-future",
		"snapshot-before-window",
		"invalid-snapshot-seq",
	]) {
		assert.equal(classifyProofStatus(shape("unknown", reason), false), "invalid", reason);
	}
});

test("284 T1 §3.1.1 base table: client validation reasons classify as invalid", () => {
	// terminal-attach-client.mjs replaces unsanitizable/future/dropped payloads
	// with unknownViewProof(...) using exactly these reasons.
	for (const reason of ["invalid-view-proof", "view-proof-future", "records-dropped", "proof-output-gap"]) {
		assert.equal(classifyProofStatus(shape("unknown", reason), false), "invalid", reason);
	}
});

test("284 T1 §3.1.1 base table: UI invalidateViewProof reasons classify as invalid", () => {
	assert.equal(classifyProofStatus(shape("unknown", "view-proof-replay-gap"), false), "invalid");
	// noteViewProofOutput emits the exact pending form and a dynamic
	// view-proof-trailing-<reason> form; the prefix covers both.
	assert.equal(classifyProofStatus(shape("unknown", "view-proof-trailing-pending"), false), "invalid");
	assert.equal(classifyProofStatus(shape("unknown", "view-proof-trailing-unsafe"), false), "invalid");
	assert.equal(classifyProofStatus(shape("unknown", "view-proof-trailing-osc-open"), false), "invalid");
});

test("284 T1 §3.1.1 fail-closed: unrecognized status or reason classifies as invalid", () => {
	assert.equal(classifyProofStatus(shape("covered", "made-up-reason"), false), "invalid");
	assert.equal(classifyProofStatus(shape("unavailable", "made-up-reason"), false), "invalid");
	assert.equal(classifyProofStatus(shape("unknown", "made-up-reason"), false), "invalid");
	assert.equal(classifyProofStatus(shape("future-status", "candidate-open"), false), "invalid");
	assert.equal(classifyProofStatus(shape("unknown", undefined), false), "invalid");
	assert.equal(classifyProofStatus({}, false), "invalid");
});

test("284 T1 §3.1.1 fail-closed: non-object proof payloads classify as invalid", () => {
	assert.equal(classifyProofStatus("covered", false), "invalid");
	assert.equal(classifyProofStatus(42, false), "invalid");
	assert.equal(classifyProofStatus([shape("covered", "exact-proof")], false), "invalid");
});

test("284 T1 §3.1.1 sticky priority: only covered escapes the sticky failure fact", () => {
	assert.equal(classifyProofStatus(shape("covered", "exact-proof"), true), "covered");
	assert.equal(classifyProofStatus(shape("covered", "safe-trailing"), true), "covered");
});

test("284 T1 §3.1.1 sticky priority: live candidate shapes do not wash the sticky fact", () => {
	assert.equal(classifyProofStatus(shape("unavailable", "candidate-open"), true), "invalid");
	assert.equal(classifyProofStatus(shape("unavailable", "candidate-aborted"), true), "invalid");
	assert.equal(classifyProofStatus(shape("unknown", "candidate-open"), true), "invalid");
	assert.equal(classifyProofStatus(shape("unknown", "candidate-aborted"), true), "invalid");
});

test("284 T1 §3.1.1 sticky priority: never-proven shapes do not wash the sticky fact", () => {
	assert.equal(classifyProofStatus(shape("unknown", "no-proof"), true), "invalid");
	assert.equal(classifyProofStatus(shape("unknown", "no-output"), true), "invalid");
});

test("284 T1 §3.1.1 sticky priority: capability loss (null proof) keeps the sticky fact", () => {
	assert.equal(classifyProofStatus(null, true), "invalid");
});

test("284 T1 §3.1.1 sticky priority: trailing/window/validation shapes keep the sticky fact", () => {
	assert.equal(classifyProofStatus(shape("unavailable", "trailing-pending"), true), "invalid");
	assert.equal(classifyProofStatus(shape("unknown", "output-gap"), true), "invalid");
	assert.equal(classifyProofStatus(shape("unknown", "view-proof-replay-gap"), true), "invalid");
});

test("284 T1 §3.1.1 sticky priority: unrecognized values stay invalid under sticky", () => {
	assert.equal(classifyProofStatus(shape("future-status", "whatever"), true), "invalid");
	assert.equal(classifyProofStatus("junk", true), "invalid");
});

test("284 T1 §3.1.1 null proof: both sticky states", () => {
	assert.equal(classifyProofStatus(null, false), "none");
	assert.equal(classifyProofStatus(null, true), "invalid");
});

// --- classifyProofInvalidFamily (issue #288 D1: cap-floor eligibility) ---

test("288 T1 D1 trailing family: runner snapshot trailing shapes classify as trailing", () => {
	// coverageFor arrival shape: unavailable + trailing-pending/trailing-unsafe.
	assert.equal(classifyProofInvalidFamily(shape("unavailable", "trailing-pending")), "trailing");
	assert.equal(classifyProofInvalidFamily(shape("unavailable", "trailing-unsafe")), "trailing");
});

test("288 T1 D1 trailing family: UI noteViewProofOutput pending and identifier forms classify as trailing", () => {
	// UI arrival shape: unknown + view-proof-trailing-pending and the dynamic
	// view-proof-trailing-<identifier> form (live output and post-F replay via
	// invalidateViewProof).
	assert.equal(classifyProofInvalidFamily(shape("unknown", "view-proof-trailing-pending")), "trailing");
	assert.equal(classifyProofInvalidFamily(shape("unknown", "view-proof-trailing-unsafe")), "trailing");
	assert.equal(classifyProofInvalidFamily(shape("unknown", "view-proof-trailing-csi-unknown")), "trailing");
	assert.equal(classifyProofInvalidFamily(shape("unknown", "view-proof-trailing-osc-42")), "trailing");
});

test("288 T1 D1 I9: malformed trailing-prefix values are hard, never trailing", () => {
	for (const reason of [
		"view-proof-trailing-Pending", // uppercase suffix
		"view-proof-trailing-", // empty suffix
		"view-proof-trailing-<script>alert(1)</script>", // special characters
		"view-proof-trailing", // pure prefix without the trailing dash
		"", // empty reason on the prefix-y arrival shape
	]) {
		assert.equal(classifyProofStatus(shape("unknown", reason), false), "invalid", reason);
		assert.equal(classifyProofInvalidFamily(shape("unknown", reason)), "hard", reason);
	}
});

test("288 T1 D1 hard family: every other invalid-classification reason is hard", () => {
	for (const reason of [
		"output-gap",
		"journal-gap",
		"journal-evicted",
		"proof-evicted",
		"snapshot-seq-future",
		"snapshot-before-window",
		"invalid-snapshot-seq",
		"invalid-view-proof",
		"view-proof-future",
		"records-dropped",
		"proof-output-gap",
		"view-proof-replay-gap",
	]) {
		assert.equal(classifyProofInvalidFamily(shape("unknown", reason)), "hard", reason);
	}
});

test("288 T1 D1 fail-closed: unrecognized statuses, reasons, and non-object payloads are hard", () => {
	assert.equal(classifyProofInvalidFamily(shape("covered", "made-up-reason")), "hard");
	assert.equal(classifyProofInvalidFamily(shape("unavailable", "made-up-reason")), "hard");
	assert.equal(classifyProofInvalidFamily(shape("future-status", "candidate-open")), "hard");
	assert.equal(classifyProofInvalidFamily("junk"), "hard");
	assert.equal(classifyProofInvalidFamily(42), "hard");
	assert.equal(classifyProofInvalidFamily([shape("covered", "exact-proof")]), "hard");
});

test("288 T1 D1: non-invalid shapes return null (not a family)", () => {
	assert.equal(classifyProofInvalidFamily(null), null);
	assert.equal(classifyProofInvalidFamily(undefined), null);
	assert.equal(classifyProofInvalidFamily(shape("covered", "exact-proof")), null);
	assert.equal(classifyProofInvalidFamily(shape("covered", "safe-trailing")), null);
	assert.equal(classifyProofInvalidFamily(shape("unavailable", "candidate-open")), null);
	assert.equal(classifyProofInvalidFamily(shape("unavailable", "candidate-aborted")), null);
	assert.equal(classifyProofInvalidFamily(shape("unknown", "candidate-open")), null);
	assert.equal(classifyProofInvalidFamily(shape("unknown", "candidate-aborted")), null);
	assert.equal(classifyProofInvalidFamily(shape("unknown", "no-proof")), null);
	assert.equal(classifyProofInvalidFamily(shape("unknown", "no-output")), null);
});

// --- sanitizeViewProofEnumPair (settle-diagnostics hygiene, review fix) ---

test("284 review: recognized producer pairs pass the diagnostic whitelist verbatim", () => {
	assert.deepEqual(sanitizeViewProofEnumPair(shape("covered", "exact-proof")), { status: "covered", reason: "exact-proof" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("covered", "safe-trailing")), { status: "covered", reason: "safe-trailing" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unavailable", "candidate-open")), { status: "unavailable", reason: "candidate-open" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", "candidate-open")), { status: "unknown", reason: "candidate-open" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", "no-proof")), { status: "unknown", reason: "no-proof" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", "output-gap")), { status: "unknown", reason: "output-gap" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", "reporter-replaced")), { status: "unknown", reason: "reporter-replaced" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", "reporter-close")), { status: "unknown", reason: "reporter-close" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", "new-empty-baseline")), { status: "unknown", reason: "new-empty-baseline" });
});

test("284 review: the dynamic trailing family passes only in identifier form", () => {
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", "view-proof-trailing-pending")), { status: "unknown", reason: "view-proof-trailing-pending" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", "view-proof-trailing-osc-malformed")), { status: "unknown", reason: "view-proof-trailing-osc-malformed" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", "view-proof-trailing-SCREEN † TEXT")), { status: "unrecognized", reason: "unrecognized" }, "arbitrary bytes cannot ride the prefix");
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", "View-Proof-Trailing-pending")), { status: "unrecognized", reason: "unrecognized" });
});

test("284 review: unrecognized pairs, statuses, and shapes map to the finite unrecognized enum", () => {
	assert.deepEqual(sanitizeViewProofEnumPair(shape("covered", "made-up-reason")), { status: "unrecognized", reason: "unrecognized" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", "made-up-reason")), { status: "unrecognized", reason: "unrecognized" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("future-status", "candidate-open")), { status: "unrecognized", reason: "unrecognized" });
	assert.deepEqual(sanitizeViewProofEnumPair(shape("unknown", undefined)), { status: "unrecognized", reason: "unrecognized" }, "a missing reason is not a recognized enum");
	assert.deepEqual(sanitizeViewProofEnumPair(shape("covered", 42)), { status: "unrecognized", reason: "unrecognized" });
	assert.deepEqual(sanitizeViewProofEnumPair({}), { status: "unrecognized", reason: "unrecognized" });
	assert.deepEqual(sanitizeViewProofEnumPair("junk"), { status: "unrecognized", reason: "unrecognized" });
	assert.deepEqual(sanitizeViewProofEnumPair([shape("covered", "exact-proof")]), { status: "unrecognized", reason: "unrecognized" });
});

test("284 review: a missing proof object whitelists to null (capability-absent shape)", () => {
	assert.equal(sanitizeViewProofEnumPair(null), null);
	assert.equal(sanitizeViewProofEnumPair(undefined), null);
});

// --- decideAttachPresentation committed-degraded chain (spec §3.1) ---

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

/** Protocol view whose F path fails (never-proven output) but whose recovery facts pass. */
function recoveryView(over = {}) {
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
		viewProof: shape("unknown", "no-proof"),
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
		witnessLatched: true,
		committedViewValid: true,
		committedViewSource: "snapshot",
		committedViewCols: 80,
		committedViewRows: 24,
		committedContentKind: "complete",
		proofStatus: "missing",
		budgetElapsed: true,
		...over,
	};
}

const decideRecovery = (over = {}) => decideAttachPresentation(recoveryView(over));

test("284 T2 §3.1: all seven degraded predicates pass -> publish-degraded (I1: result carries no proof rewriting)", () => {
	// deepStrictEqual rejects extra keys, so this also asserts the policy never
	// returns proof/marker/seq rewriting instructions.
	assert.deepEqual(decideRecovery(), { action: "publish-degraded", reason: "committed-degraded" });
	assert.deepEqual(decideRecovery({ proofStatus: "none" }), { action: "publish-degraded", reason: "committed-degraded" });
	assert.deepEqual(decideRecovery({ committedViewSource: "sync-close" }), { action: "publish-degraded", reason: "committed-degraded" });
});

test("284 T2 §3.1 predicate 1: protocol mode with an unlatched witness waits", () => {
	assert.deepEqual(decideRecovery({ witnessLatched: false }), { action: "wait", reason: "witness-not-latched" });
	assert.deepEqual(decideRecovery({ witnessLatched: undefined }), { action: "wait", reason: "witness-not-latched" });
});

test("284 T2 §3.1 predicate 2: degradation needs a valid-content baseline and complete local parse", () => {
	for (const [over, reason] of [
		[{ baselineState: "unverified" }, "baseline-unverified"],
		[{ baselineState: "hydrating" }, "baseline-hydrating"],
		[{ baselineState: "undecided" }, "baseline-unknown"],
		[{ baselineState: "valid-empty" }, "baseline-empty"],
		[{ localParseComplete: false }, "local-parse-incomplete"],
	]) {
		assert.deepEqual(decideRecovery(over), { action: "wait", reason }, JSON.stringify(over));
	}
});

test("284 T2 §3.1 predicate 3: open local sync frames and missing committed views wait", () => {
	for (const [over, reason] of [
		[{ frameState: "open" }, "sync-open"],
		[{ frameState: "unknown" }, "frame-incomplete"],
		[{ openSyncBlock: true }, "sync-open"],
		[{ committedViewValid: false }, "committed-view-invalid"],
		[{ committedViewValid: undefined }, "committed-view-missing"],
	]) {
		assert.deepEqual(decideRecovery(over), { action: "wait", reason }, JSON.stringify(over));
	}
});

test("284 T2 §3.1 predicate 4: committed geometry must match the target with no pending resize intent", () => {
	for (const [over, reason] of [
		[{ committedViewCols: 100 }, "committed-geometry-mismatch"],
		[{ committedViewRows: 30 }, "committed-geometry-mismatch"],
		[{ committedViewCols: undefined }, "committed-geometry-mismatch"],
		[{ committedViewRows: undefined }, "committed-geometry-mismatch"],
		[{ resizeIntentRequired: true, resizeIntentSatisfied: true, intentId: 7 }, "resize-intent"],
	]) {
		assert.deepEqual(decideRecovery(over), { action: "wait", reason }, JSON.stringify(over));
	}
});

test("284 T2 §3.1 predicate 5: only missing proof status may degrade; invalid and covered wait", () => {
	for (const [over, reason] of [
		[{ proofStatus: "invalid" }, "proof-status-invalid"],
		[{ proofStatus: "covered" }, "proof-status-covered"],
		[{ proofStatus: "garbage" }, "proof-status-invalid"],
		[{ proofStatus: undefined }, "proof-status-invalid"],
	]) {
		assert.deepEqual(decideRecovery(over), { action: "wait", reason }, JSON.stringify(over));
	}
});

test("284 T2 §3.1 predicate 6: the recovery budget must have elapsed", () => {
	assert.deepEqual(decideRecovery({ budgetElapsed: false }), { action: "wait", reason: "recovery-budget-pending" });
	assert.deepEqual(decideRecovery({ budgetElapsed: undefined }), { action: "wait", reason: "recovery-budget-pending" });
});

test("284 T2 §3.1 predicate 7: committed content must be locally complete", () => {
	for (const kind of ["boot", "raw", "partial", "unknown"]) {
		assert.deepEqual(decideRecovery({ committedContentKind: kind }), { action: "wait", reason: `content-kind-${kind}` }, kind);
	}
	assert.deepEqual(decideRecovery({ committedContentKind: undefined }), { action: "wait", reason: "content-kind-unknown" });
});

test("284 T2 §3.1: runner candidate shapes in both arrival shapes degrade via missing proof", () => {
	for (const viewProof of [
		shape("unavailable", "candidate-open"),
		shape("unavailable", "candidate-aborted"),
		shape("unknown", "candidate-open"),
		shape("unknown", "candidate-aborted"),
	]) {
		assert.equal(classifyProofStatus(viewProof, false), "missing");
		// openCandidate mirrors the live S/A record fact; the degraded chain
		// deliberately does not gate on it (spec §0 R1-G1).
		assert.deepEqual(decideRecovery({ viewProof, openCandidate: true, proofStatus: "missing" }), {
			action: "publish-degraded",
			reason: "committed-degraded",
		});
	}
});

test("284 T2 §3.1: a fully covered F path publishes complete without waiting for the budget", () => {
	assert.deepEqual(decideRecovery({ viewProof: COVERED, proofStatus: "covered", budgetElapsed: false }), {
		action: "publish",
		reason: "complete",
	});
});

test("284 T2 §3.1: covered proof status with a mismatched committed geometry waits, never degrades", () => {
	const wideCovered = { ...COVERED, proof: { ...COVERED.proof, metadata: { ...META, cols: 100 } } };
	assert.deepEqual(decideRecovery({ viewProof: wideCovered, proofStatus: "covered", committedViewCols: 100 }), {
		action: "wait",
		reason: "committed-geometry-mismatch",
	});
});

test("284 T2 §3.1: a sticky invalid classification keeps the degraded path waiting", () => {
	const viewProof = shape("unknown", "output-gap");
	assert.equal(classifyProofStatus(viewProof, true), "invalid");
	assert.deepEqual(decideRecovery({ viewProof, proofStatus: "invalid" }), { action: "wait", reason: "proof-status-invalid" });
});

test("284 T2 §3.1: expired deadlines only rename degraded waits and never upgrade them", () => {
	assert.deepEqual(decideRecovery({ deadlineState: "expired", budgetElapsed: false }), {
		action: "wait",
		reason: "deadline-expired:recovery-budget-pending",
	});
	assert.deepEqual(decideRecovery({ deadlineState: "expired" }), { action: "publish-degraded", reason: "committed-degraded" });
});

test("284 T2 §3.1: states without recovery inputs keep the exact F-path behavior", () => {
	const legacy = recoveryView();
	for (const key of [
		"witnessLatched",
		"committedViewValid",
		"committedViewSource",
		"committedViewCols",
		"committedViewRows",
		"committedContentKind",
		"proofStatus",
		"budgetElapsed",
	]) {
		delete legacy[key];
	}
	assert.deepEqual(decideAttachPresentation(legacy), { action: "wait", reason: "view-proof-unknown" });
	assert.deepEqual(decideAttachPresentation({ ...legacy, frameState: "open" }), { action: "wait", reason: "sync-open" });
});

// --- issue #288 T1: predicate 5 cap floor (spec D1) ---

test("288 T1 predicate 5: pending deadlines keep invalid proof status waiting, capRecoverable cannot relax it", () => {
	// The policy sees only proofStatus + capRecoverable; the trailing/hard
	// family of the underlying shape is irrelevant to this predicate.
	assert.deepEqual(decideRecovery({ viewProof: shape("unavailable", "trailing-unsafe"), proofStatus: "invalid" }), {
		action: "wait",
		reason: "proof-status-invalid",
	});
	assert.deepEqual(decideRecovery({ viewProof: shape("unknown", "output-gap"), proofStatus: "invalid" }), {
		action: "wait",
		reason: "proof-status-invalid",
	});
	assert.deepEqual(decideRecovery({ deadlineState: "pending", proofStatus: "invalid" }), { action: "wait", reason: "proof-status-invalid" });
	assert.deepEqual(decideRecovery({ deadlineState: undefined, proofStatus: "invalid", capRecoverable: true }), {
		action: "wait",
		reason: "proof-status-invalid",
	});
});

test("288 T1 predicate 5: expired deadline admits invalid proof status only when capRecoverable is exactly true", () => {
	assert.deepEqual(decideRecovery({ deadlineState: "expired", proofStatus: "invalid", capRecoverable: true }), {
		action: "publish-degraded",
		reason: "committed-degraded",
	});
});

test("288 T1 predicate 5: expired deadline with invalid proof and capRecoverable not true fails closed", () => {
	assert.deepEqual(decideRecovery({ deadlineState: "expired", proofStatus: "invalid", capRecoverable: false }), {
		action: "wait",
		reason: "deadline-expired:proof-status-invalid",
	});
	// Undefined capRecoverable (pre-#288 callers) fails closed the same way.
	assert.deepEqual(decideRecovery({ deadlineState: "expired", proofStatus: "invalid" }), {
		action: "wait",
		reason: "deadline-expired:proof-status-invalid",
	});
	// The cap floor admits exactly "invalid": garbage proof statuses stay out.
	assert.deepEqual(decideRecovery({ deadlineState: "expired", proofStatus: "garbage", capRecoverable: true }), {
		action: "wait",
		reason: "deadline-expired:proof-status-invalid",
	});
});

test("288 T1 predicate 5: covered proof status is never admitted by the cap floor", () => {
	assert.deepEqual(decideRecovery({ deadlineState: "expired", proofStatus: "covered", capRecoverable: true }), {
		action: "wait",
		reason: "deadline-expired:proof-status-covered",
	});
});

test("288 T1: the other six degraded predicates do not relax under expired deadlines with capRecoverable", () => {
	const cap = { deadlineState: "expired", proofStatus: "invalid", capRecoverable: true };
	for (const [over, reason] of [
		[{ witnessLatched: false }, "deadline-expired:witness-not-latched"],
		[{ baselineState: "unverified" }, "deadline-expired:baseline-unverified"],
		[{ committedViewValid: false }, "deadline-expired:committed-view-invalid"],
		[{ committedViewCols: 100 }, "deadline-expired:committed-geometry-mismatch"],
		[{ budgetElapsed: false }, "deadline-expired:recovery-budget-pending"],
		[{ committedContentKind: "partial" }, "deadline-expired:content-kind-partial"],
	]) {
		assert.deepEqual(decideRecovery({ ...cap, ...over }), { action: "wait", reason }, JSON.stringify(over));
	}
});

test("288 T1: supplying capRecoverable alone opts into the degraded chain", () => {
	const state = recoveryView();
	for (const key of [
		"witnessLatched",
		"committedViewValid",
		"committedViewSource",
		"committedViewCols",
		"committedViewRows",
		"committedContentKind",
		"proofStatus",
		"budgetElapsed",
	]) {
		delete state[key];
	}
	// Without capRecoverable the F-path wait stands unchanged (#284 behavior).
	assert.deepEqual(decideAttachPresentation(state), { action: "wait", reason: "view-proof-unknown" });
	// With capRecoverable supplied, the degraded chain engages and names its own wait.
	assert.deepEqual(decideAttachPresentation({ ...state, capRecoverable: true }), { action: "wait", reason: "witness-not-latched" });
});
