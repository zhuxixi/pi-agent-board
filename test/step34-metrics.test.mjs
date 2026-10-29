import assert from "node:assert/strict";
import test from "node:test";
import { ceilQuantile, extractBQ, extractC, extractG, extractLG, extractRReconnectWithRx, extractRRestart, extractS, extractT, summarizeFormal, wilson95 } from "../test-support/formal-measurement/step34-metrics.mjs";

const childEvents = [
	{ event: "command", step: 2, monoNs: "1000000000" },
	{ event: "stdout-write", frame: "F1", phase: "closed", monoNs: "1005000000" },
];
const actions = [
	{ type: "child-command", at: 100, detail: { step: 2 } },
	{ type: "primary-F1-commit-observed", at: 150 },
];
const obs = [{ boundaryParsedAt: 300 }, { boundaryParsedAt: 330 }];

test("ceil quantile and Wilson known values", () => {
	assert.equal(ceilQuantile([1, 2, 3, 4], 0.5), 2);
	assert.equal(ceilQuantile([1, 2], 0.95), 2);
	assert.equal(ceilQuantile([1, Infinity], 0.5), 1);
	assert.equal(wilson95(100, 100).low.toFixed(3), "0.963");
});

test("B/Q total uses summary.totalEntryMs and correctness", () => {
	assert.deepEqual(extractBQ({ totalEntryMs: 42, ok: true, correctness: { all: true } }).latencyMs, 42);
	assert.equal(extractBQ({ totalEntryMs: "UNKNOWN", ok: true, correctness: { all: true } }).latencyMs, Infinity);
});

test("S aligns child closed write to parent command then commit", () => {
	const result = extractS({ ok: true, finalTarget: { frameId: "F1", committed: true } }, actions, childEvents);
	assert.equal(result.latencyMs, 45);
	assert.equal(result.correct, true);
	assert.equal(extractS({ ok: true, finalTarget: { frameId: "F1", committed: true } }, [], []).latencyMs, Infinity);
});

test("L/G totals use mount to first content; G secondary uses target frame", () => {
	const summary = { ok: true, analysis: { firstContentFrameIndex: 1, firstContentHasTailAndInput: true }, declared: { targetFrame: { id: "F1", rows: ["TARGET"] } } };
	assert.equal(extractLG(summary, [{ type: "attach-mounted", at: 200 }], obs).latencyMs, 130);
	const targetObs = [{ boundaryParsedAt: 300, grid: [{ text: " chrome" }, { text: "TARGET" }, { text: " footer" }] }, { boundaryParsedAt: 330 }];
	const g = extractG(summary, [{ type: "attach-mounted", at: 200 }, ...actions], targetObs, childEvents);
	assert.equal(g.latencyMs, 100);
	assert.equal(g.secondaryLatencyMs, 195);
});

test("C uses publishAt-completeFrameAt and startup fields", () => {
	assert.equal(extractC({ ok: true, contractOk: true, completeFrameAt: 800, publishAt: 800 }).latencyMs, 0);
	assert.equal(extractC({ ok: true, contractOk: true }).latencyMs, Infinity);
});

test("R reconnect and restart use restored output receipt to commit", () => {
	const reconnect = extractRReconnectWithRx({ f1Committed: true, windowAnalysis: { ok: true, firstF1Index: 1 } }, obs, [{ at: 280, msg: { type: "output", data: "F1 HEADER" } }]);
	assert.equal(reconnect.latencyMs, 50);
	const restart = extractRRestart({ gen2Committed: true, gen2Proof: { observedAt: 350, literalMatched: true } }, [{ at: 300, msg: { type: "output", data: "gen-2 F0 HEADER" } }]);
	assert.equal(restart.latencyMs, 50);
});

test("T extracts initial and theme timing; missing is UNMEASURED", () => {
	const summary = { ok: true, themeCompletion: "completed", actions: [{ type: "attach-mounted", at: 100 }], postFirstContentCommits: [{ identity: "t0-complete", boundaryParsedAt: 150 }], reply: { injectedAt: 160 }, themeRedraw: { boundaryParsedAt: 190 } };
	const t = extractT(summary);
	assert.equal(t.latencyMs, 50);
	assert.equal(t.secondaryLatencyMs, 30);
	assert.equal(extractT({ ok: true }).latencyMs, Infinity);
});

test("summaries reject UNMEASURED and compute timely/product/Wilson", () => {
	const records = [
		{ classification: "product", correct: true, latency: 50 },
		{ classification: "product", correct: true, latency: 150 },
		{ classification: "infrastructure", correct: false, latency: null },
	];
	const s = summarizeFormal(records, { latency: (r) => r.latency === null ? null : r.latency, thresholdMs: 100, maxMs: 500 });
	assert.equal(s.unmeasured, 1);
	assert.equal(s.passes, false);
	assert.equal(s.p95, Infinity);
});
