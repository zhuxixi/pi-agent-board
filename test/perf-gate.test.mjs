import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { perfGateDecision } from "../test-support/perf-gate.mjs";

// A1: truth table over the full domain —
// AGENT_BOARD_PERF_GATE ∈ {unset, "1", "0", other} × NODE_V8_COVERAGE ∈ {unset, set}.
const CASES = [
	// [gate, coverage, expectedRun, reasonSubstring]
	[undefined, undefined, false, "AGENT_BOARD_PERF_GATE=1"],
	[undefined, "/tmp/x", false, "AGENT_BOARD_PERF_GATE=1"],
	["1", undefined, true, ""],
	["1", "/tmp/x", false, "coverage instrumentation"],
	["0", undefined, false, "AGENT_BOARD_PERF_GATE=1"],
	["0", "/tmp/x", false, "AGENT_BOARD_PERF_GATE=1"],
	["yes", undefined, false, "AGENT_BOARD_PERF_GATE=1"],
	["yes", "/tmp/x", false, "AGENT_BOARD_PERF_GATE=1"],
];

for (const [gate, coverage, expectedRun, reasonSubstring] of CASES) {
	test(`gate=${JSON.stringify(gate)} coverage=${coverage ?? "unset"} → run=${expectedRun}`, () => {
		const env = {};
		if (gate !== undefined) env.AGENT_BOARD_PERF_GATE = gate;
		if (coverage !== undefined) env.NODE_V8_COVERAGE = coverage;
		const d = perfGateDecision(env);
		assert.equal(d.run, expectedRun);
		if (expectedRun) assert.equal(d.reason, "");
		else assert.ok(
			d.reason.includes(reasonSubstring),
			`reason ${JSON.stringify(d.reason)} must contain ${JSON.stringify(reasonSubstring)}`,
		);
	});
}
