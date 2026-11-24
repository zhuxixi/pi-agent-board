import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { underCoverageInstrumentation } from "../test-support/instrumentation-gate.mjs";
import { testCaseBody } from "../test-support/test-source-scan.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGET = "test/attach-entry-22.test.mjs";
const read = (rel) => readFileSync(join(PACKAGE_ROOT, rel), "utf8");

test("A1: the instrumentation predicate matches the perf-gate verdict shape", () => {
	assert.equal(underCoverageInstrumentation({}), false);
	assert.equal(underCoverageInstrumentation({ NODE_V8_COVERAGE: undefined }), false);
	assert.equal(underCoverageInstrumentation({ NODE_V8_COVERAGE: "/tmp/cov" }), true);
	// Empty string still counts as "set": the predicate is `!== undefined`, not a truthy check.
	assert.equal(underCoverageInstrumentation({ NODE_V8_COVERAGE: "" }), true);
});

test("A1: the default parameter reads the real process env", () => {
	assert.equal(underCoverageInstrumentation(), process.env.NODE_V8_COVERAGE !== undefined);
});

test("A2: B and Q carry the conditional issue #305 skip", () => {
	for (const marker of ['test("step 22/24 B:', 'test("step 22/24 Q:']) {
		const body = testCaseBody(read(TARGET), marker);
		assert.match(body, /skip:\s*underCoverageInstrumentation\(\)\s*\?\s*"issue #305[^"]*"\s*:\s*undefined/);
	}
});

test("A3: exclusion did not become removal — the core assertions stay", () => {
	const b = testCaseBody(read(TARGET), 'test("step 22/24 B:');
	const q = testCaseBody(read(TARGET), 'test("step 22/24 Q:');
	for (const body of [b, q]) {
		assert.match(body, /fastAndCorrect/);
		assert.match(body, /target200ms\.met/);
		assert.match(body, /completeLiteralGrid/);
		assert.match(body, /cleanup\.ok/);
	}
});

test("A8: the 200 ms budget rationale is documented in the header", () => {
	assert.match(read(TARGET), /200 ms/i);
	assert.match(read(TARGET), /issue #305/);
	assert.match(read(TARGET), /witness/i);
});
