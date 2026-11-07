// Issue #284: attach recovery policy units. classifyProofStatus implements the
// spec §3.1.1 induction table; the decideAttachPresentation tests below cover the
// §3.1 committed-degraded predicate chain.
import assert from "node:assert/strict";
import test from "node:test";

import { classifyProofStatus } from "../src/core/attach-recovery.mjs";

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
