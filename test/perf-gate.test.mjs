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

// A2: the entry script refuses loudly under instrumentation — nonzero exit,
// a clear message, and no measurement output. Setting AGENT_BOARD_PERF_GATE=1
// too proves the instrumentation check dominates the opt-in.
const ENTRY_SCRIPT = fileURLToPath(new URL("../scripts/run-perf-gate.mjs", import.meta.url));

test("run-perf-gate.mjs refuses when NODE_V8_COVERAGE is set", () => {
	const r = spawnSync(process.execPath, [ENTRY_SCRIPT], {
		env: { ...process.env, NODE_V8_COVERAGE: "/tmp/perf-gate-a2", AGENT_BOARD_PERF_GATE: "1" },
		encoding: "utf8",
	});
	assert.notEqual(r.status, 0);
	assert.match(r.stderr + r.stdout, /coverage instrumentation|NODE_V8_COVERAGE/);
	assert.doesNotMatch(r.stdout, /burst:|paced:/);
});
