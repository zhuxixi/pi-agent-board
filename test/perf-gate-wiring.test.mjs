import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// A5: the perf-gate wiring is a contract — deleting the CI step, moving it
// after the parallel suite, or retargeting the npm scripts must fail loudly
// here instead of silently un-guarding the perf assertions (spec §7).
const CI = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("ci.yml: perf gate step exists and runs before Unit tests", () => {
	const perfIdx = CI.indexOf("npm run test:perf");
	const unitIdx = CI.indexOf("- name: Unit tests");
	assert.ok(perfIdx > -1, "ci.yml wires `npm run test:perf`");
	assert.ok(unitIdx > -1, "ci.yml still has the Unit tests step");
	assert.ok(perfIdx < unitIdx, "perf gate runs before Unit tests (quietest machine window)");
});

test("package.json: default globs unchanged, test:perf wired, verify ordered", () => {
	assert.equal(PKG.scripts.test, "node --test test/*.test.mjs");
	assert.equal(PKG.scripts["test:coverage"], "c8 node --test test/*.test.mjs");
	assert.equal(PKG.scripts["test:perf"], "node scripts/run-perf-gate.mjs");
	const order = PKG.scripts.verify.split("&&").map((s) => s.trim());
	const idx = (needle) => order.findIndex((s) => s === needle);
	assert.ok(idx("npm run test:perf") > idx("npm run typecheck"), "perf runs after typecheck");
	assert.ok(idx("npm run test:perf") < idx("npm test"), "perf runs before the parallel suite");
	assert.ok(idx("npm run test:perf") < idx("npm run test:coverage"), "perf runs before coverage");
});
