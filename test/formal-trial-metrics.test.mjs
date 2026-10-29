import assert from "node:assert/strict";
import test from "node:test";
import { extractTrialMetrics } from "../test-support/formal-measurement/trial-metrics.mjs";

const observation = { observationStartMs: 10, observationEndMs: 3011, observationActualMs: 3001, observationCompletion: "completed" };

test("entry B/Q top-level shape extracts timeline, continuity and actual observation", () => {
	const m = extractTrialMetrics({
		ok: true,
		totalEntryMs: 37,
		observationStartMs: 10, observationEndMs: 3011, observationActualMs: 3001, observationCompletion: "completed",
		timeline: { select: 1, overlayMounted: 2, connected: 3, snapshotValidated: 4, snapshotParsed: 5, childFrameComplete: { state: "observed" }, renderRequested: 6, terminalCommitted: 7 },
		correctness: { completeLiteralGrid: true, resizeCommands: [] },
		detach: { result: { action: "detached" } },
	});
	assert.equal(m.readyLatencyMs, 37);
	assert.equal(m.select, 1);
	assert.equal(m.overlay, 2);
	assert.equal(m.snapshotValidated, 4);
	assert.equal(m.childFrameComplete, "observed");
	assert.equal(m.terminalCommitted, 7);
	assert.equal(m.observationActualMs, 3001);
	assert.equal(m.correct, true);
	assert.equal(m.outputUsable, true);
	assert.equal(m.inputUsable, true);
});

test("S trial shape extracts observation and final target metrics", () => {
	const m = extractTrialMetrics({ ok: true, trials: [{ ok: true, observationStartMs: 20, observationEndMs: 3025, observationActualMs: 3005, observationCompletion: "completed", finalTarget: { committed: true } }] });
	assert.equal(m.observationActualMs, 3005);
	assert.equal(m.correct, true);
	assert.equal(m.readyLatencyMs, "UNKNOWN");
});

test("matrix L/G shape extracts resize and observation from trial", () => {
	const m = extractTrialMetrics({ ok: true, trials: [{ ok: true, resizeSizes: [{ cols: 80, rows: 22 }], observation, frameFailures: [] }] });
	assert.deepEqual(m.resizeSizes, [{ cols: 80, rows: 22 }]);
	assert.equal(m.observationCompletion, "completed");
	assert.equal(m.frameFailures.length, 0);
});

test("cold C/A5 evidence shape extracts observation and publish metrics", () => {
	const m = extractTrialMetrics({ ok: true, trials: [{ ok: true, evidence: { observation, publishedInBudget: true, completeness: true } }] });
	assert.equal(m.observationActualMs, 3001);
	assert.equal(m.observationStartMs, 10);
});

test("R reconnect/restart shape extracts recovery completion and observation", () => {
	const m = extractTrialMetrics({ ok: true, trials: [{ ok: true, observation, recoveryCompletion: "completed", evidence: {} }] });
	assert.equal(m.recoveryCompletion, "completed");
	assert.equal(m.observationActualMs, 3001);
});

test("U legacy evidence shape extracts observation", () => {
	const m = extractTrialMetrics({ ok: true, trials: [{ ok: true, evidence: { observation, fullLiteralMatched: true } }] });
	assert.equal(m.observationActualMs, 3001);
	assert.equal(m.observationCompletion, "completed");
});

test("D lifecycle shape exposes its bounded post-close observation", () => {
	const m = extractTrialMetrics({ ok: true, trials: [{ ok: true, observation: { observationStartMs: 100, observationEndMs: 401, observationActualMs: 301, observationCompletion: "completed" } }] });
	assert.equal(m.observationActualMs, 301);
	assert.equal(m.observationCompletion, "completed");
});
