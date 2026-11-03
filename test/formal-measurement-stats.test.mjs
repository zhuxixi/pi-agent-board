import assert from "node:assert/strict";
import test from "node:test";
import { ceilQuantile, infrastructureRate, summarizeCell, wilson95 } from "../test-support/formal-measurement/stats.mjs";

const trial = (over = {}) => ({ version: "candidate", cellId: "B", trialIndex: 0, warmup: false, readyLatencyMs: 100, correct: true, infrastructureError: null, ...over });

test("ceil(p*n) quantiles include +∞ and reject empty inputs", () => {
	assert.equal(ceilQuantile([5, 1, 4, 2, 3], 0.5), 3);
	assert.equal(ceilQuantile([1, 2, 3, 4], 0.95), 4);
	assert.equal(ceilQuantile([1, Infinity, 3], 0.5), 3);
	assert.equal(ceilQuantile([1, Infinity], 0.95), Infinity);
	assert.throws(() => ceilQuantile([], 0.5));
});

test("Wilson 95 intervals for 100/100 and 30/30", () => {
	assert.equal(wilson95(100, 100).low.toFixed(3), "0.963");
	assert.equal(wilson95(30, 30).low.toFixed(3), "0.886");
});

test("infrastructure >5% invalidates without deleting trials", () => {
	const trials = Array.from({ length: 20 }, (_, i) => trial({ infrastructureError: i < 2 ? "x" : null, trialIndex: i }));
	assert.equal(infrastructureRate(trials).invalid, true);
	const kept = summarizeCell({ version: "candidate", cellId: "B", trials, thresholdMs: 200, maxMs: 500 });
	assert.equal(kept.n, 20);
	assert.equal(kept.infra.infra, 2);
	assert.equal(kept.passes, false);
});

test("summarizeCell stays per version/cell, excludes warmups and timestamps +∞", () => {
	const trials = [
		trial({ warmup: true, readyLatencyMs: 1 }),
		trial({ trialIndex: 1, readyLatencyMs: 100 }),
		trial({ trialIndex: 2, readyLatencyMs: 200 }),
		trial({ trialIndex: 3, readyLatencyMs: Infinity }),
		trial({ version: "baseline", trialIndex: 4, readyLatencyMs: 900 }),
		trial({ cellId: "Q", trialIndex: 5, readyLatencyMs: 900 }),
	];
	const result = summarizeCell({ version: "candidate", cellId: "B", trials, thresholdMs: 200, maxMs: 500 });
	assert.equal(result.n, 3);
	assert.equal(result.p50, 200);
	assert.equal(result.p95, Infinity);
	assert.equal(result.max, Infinity);
	assert.equal(result.passes, false);
});
