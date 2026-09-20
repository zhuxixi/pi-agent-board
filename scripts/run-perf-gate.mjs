#!/usr/bin/env node
/**
 * Authoritative entry for the A11 perf gate (issue #121).
 *
 * Loudly refuses under coverage instrumentation: c8 sets NODE_V8_COVERAGE
 * for its whole process tree, and instrumented latency measurements are
 * invalid (2.5–6× inflation). Silently skipping here would manufacture a
 * fake-green gate, so refusal is a nonzero exit with an explicit message.
 *
 * This script is the side-effect layer only — no decision logic, no
 * measurement. The pure gate decision lives in test-support/perf-gate.mjs
 * and serves the test file; do not merge the layers (spec §3.2/§4).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.NODE_V8_COVERAGE !== undefined) {
	console.error(
		"run-perf-gate: refusing to measure under coverage instrumentation " +
			"(NODE_V8_COVERAGE is set). Perf assertions are only valid without c8; " +
			"run `npm run test:perf` directly, outside any coverage wrapper.",
	);
	process.exit(1);
}

const perfTest = fileURLToPath(new URL("../test/terminal-model-perf.test.mjs", import.meta.url));
// No --test-concurrency=1: the flag requires Node 21+ but package.json
// declares engines >=20, and it is a no-op while the gate runs a single
// file (spec D3, revised 2026-09-20). Re-add it when a second perf file
// lands — parallel measurement across files must stay impossible.
const child = spawn(
	process.execPath,
	["--test", perfTest],
	{ stdio: "inherit", env: { ...process.env, AGENT_BOARD_PERF_GATE: "1" } },
);
child.on("error", (err) => {
	console.error(`run-perf-gate: failed to spawn the perf suite: ${err.message}`);
	process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
