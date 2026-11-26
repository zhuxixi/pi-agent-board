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

// A3 pins the exact on-disk `assert.equal(...)` shapes, tab-indented at line
// start and ending in `);`: an identifier that merely survives in a
// `t.diagnostic(...)` line or a comment must not keep the guard green after
// its assertion was deleted. B and Q share these forms except the
// fastAndCorrect message suffix ("hot-attach" is B-only).
const CORE_ASSERTION_PINS = [
	/^\tassert\.equal\(tr\.fastAndCorrect, true, "the qualified complete frame publishes within the 200 ms(?: hot-attach)? target"\);$/m,
	/^\tassert\.equal\(tr\.target200ms\.met, true\);$/m,
	/^\tassert\.equal\(tr\.correctness\.completeLiteralGrid, true\);$/m,
	/^\tassert\.equal\(tr\.cleanup\.ok, true, "cleanup\.ok reflects the ordered sequence"\);$/m,
];

test("A3: exclusion did not become removal — the core assertions stay", () => {
	for (const marker of ['test("step 22/24 B:', 'test("step 22/24 Q:']) {
		const body = testCaseBody(read(TARGET), marker);
		for (const pin of CORE_ASSERTION_PINS) assert.match(body, pin);
	}
});

// A8 pins the rationale wording of the issue #305 header block, restricted to
// the source prefix before the first top-level `test(`: skip strings, assertion
// messages, and the older issue #222 header must not satisfy the guard by
// coincidence when the rationale block itself is deleted.
const HEADER_RATIONALE_PINS = [
	/200 ms/,
	/issue #305/,
	/one trial is a witness, not a distribution/,
	/only decided in plain runs/,
];

const headerBeforeFirstTopLevelTest = (source) => {
	const first = source.search(/^test\(/m);
	assert.notEqual(first, -1, "no top-level test( found to bound the header");
	return source.slice(0, first);
};

test("A8: the 200 ms budget rationale is documented in the header", () => {
	const header = headerBeforeFirstTopLevelTest(read(TARGET));
	for (const pin of HEADER_RATIONALE_PINS) assert.match(header, pin);
});

// RED self-proof fixtures (synthetic source samples as plain strings): each
// models the exact fail-open regression found in review, proving here that the
// guards above fail closed instead of only claiming it in review prose.

// A3 regression: the fastAndCorrect assertion line deleted while the identifier
// survives in the diagnostic line — what kept the old identifier-anywhere guard
// green.
const BODY_WITH_FAST_AND_CORRECT_ASSERTION_DELETED = [
	'\tconst tr = r.parsed;',
	'\tt.diagnostic(`B: total=${tr.totalEntryMs.toFixed(1)}ms fastAndCorrect=${tr.fastAndCorrect}`);',
	'\tassert.equal(tr.target200ms.met, true);',
	'\tassert.equal(tr.correctness.completeLiteralGrid, true);',
	'\tassert.equal(tr.cleanup.ok, true, "cleanup.ok reflects the ordered sequence");',
	'});',
].join("\n");

// A3 regression: the assertion commented out — the line-anchored pin must not
// be satisfiable by a `//` line.
const COMMENTED_OUT_FAST_AND_CORRECT_ASSERTION = '//\tassert.equal(tr.fastAndCorrect, true, "the qualified complete frame publishes within the 200 ms hot-attach target");';

// A8 regression: the pre-change header with the issue #305 rationale block
// gone — `witness` still occurs in the issue #222 wording that was always there.
const HEADER_WITHOUT_ISSUE_305_RATIONALE = [
	'import test from "node:test";',
	'',
	'// Issue #222 step 22 (task-22-brief.md): the OLD-SOURCE real-entry baseline for',
	'// the two missing cells only — B (25 ms continuous) and Q (nonempty then quiet)',
	'// — through the accepted step-18 real-entry topology and observer. The baseline',
	'// now publishes through the modern complete-frame gate; one trial is a witness,',
	'// never a distribution or P95.',
	'',
].join("\n");

test("A3 self-proof: the pins fail closed on a deleted or commented-out assertion", () => {
	// The old identifier-anywhere guard stayed green on this body.
	assert.match(BODY_WITH_FAST_AND_CORRECT_ASSERTION_DELETED, /fastAndCorrect/);
	// The line-anchored pin does not.
	assert.doesNotMatch(BODY_WITH_FAST_AND_CORRECT_ASSERTION_DELETED, CORE_ASSERTION_PINS[0]);
	assert.doesNotMatch(COMMENTED_OUT_FAST_AND_CORRECT_ASSERTION, CORE_ASSERTION_PINS[0]);
});

test("A8 self-proof: the header guard fails closed without the rationale block", () => {
	// The old whole-file guard stayed green: `witness` survives in the
	// pre-existing header, and `200 ms`/`issue #305` lived in the test bodies.
	assert.match(HEADER_WITHOUT_ISSUE_305_RATIONALE, /witness/i);
	// The prefix-restricted pins do not match.
	for (const pin of HEADER_RATIONALE_PINS) {
		assert.doesNotMatch(HEADER_WITHOUT_ISSUE_305_RATIONALE, pin);
	}
});
