import assert from "node:assert/strict";
import test from "node:test";

import { underCoverageInstrumentation } from "../test-support/instrumentation-gate.mjs";

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
