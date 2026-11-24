# Issue #305 B/Q Instrumentation Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip the two 200 ms real-budget tests only under coverage instrumentation, keep them running everywhere else, and mechanically prove both directions.

**Architecture:** One pure predicate (`underCoverageInstrumentation`, verbatim `NODE_V8_COVERAGE !== undefined` like the perf gate) consumed by conditional string skips on B/Q; a unit+static guard file pins the truth table, the skip shape, the four core assertions, and the in-file 200 ms rationale; an integration guard spawns the target file twice (scrubbed env vs instrumented env) and parses TAP.

**Tech Stack:** Node.js 22/24, `node:test`, `assert/strict`, ESM, child-process spawn, mkdtemp temp dirs.

## Global Constraints

- Work only in this worktree; never edit the main checkout.
- Test-only: no `src/`, `runner/`, `.github/workflows/ci.yml`, dependency, or test-name changes; no threshold changes.
- The predicate must be exactly `env.NODE_V8_COVERAGE !== undefined` (verbatim parity with `test-support/perf-gate.mjs:15`).
- Skips must be conditional strings citing `issue #305`, exactly `{ skip: underCoverageInstrumentation() ? "<reason>" : undefined }` on each of B and Q.
- The four core assertions (`fastAndCorrect`, `target200ms.met`, `completeLiteralGrid`, `cleanup.ok`) must remain untouched in B and Q.
- Runtime guard spawns must scrub `NODE_TEST_CONTEXT`, construct both env directions explicitly, only parse `ok`/`not ok` result rows, and match the skip reason with `/issue \\?#305/` (double backslash — optional literal backslash).
- TDD for all new behavior; no budget widening anywhere.
- Conventional commits, staged by file name, never `git add -A`.

---

### Task 1: Pure instrumentation predicate with truth-table tests

**Files:**
- Create: `test-support/instrumentation-gate.mjs`
- Create: `test/instrumentation-gate.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: named export `underCoverageInstrumentation(env = process.env)` returning boolean — Task 2 imports it in the target file and the runtime guard.

**Acceptance IDs:** A1.

- [ ] **Step 1: Write the failing tests**

Create `test/instrumentation-gate.test.mjs` (tabs for indentation), containing ONLY the truth-table tests in this task — static guards arrive in Task 2:

```js
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
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/instrumentation-gate.test.mjs`
Expected: module-resolution failure for `../test-support/instrumentation-gate.mjs`.

- [ ] **Step 3: Implement the predicate**

Create `test-support/instrumentation-gate.mjs`:

```js
/**
 * Instrumentation gate (issue #305).
 *
 * True when the process tree runs under coverage instrumentation: c8 sets
 * NODE_V8_COVERAGE for the whole tree (children included), inflating measured
 * latency ~2.5–6× (issue #121's measurement). Absolute real-time budgets are
 * therefore only decided in plain runs. The predicate is verbatim the one the
 * perf gate uses (test-support/perf-gate.mjs, scripts/run-perf-gate.mjs).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function underCoverageInstrumentation(env = process.env) {
	return env.NODE_V8_COVERAGE !== undefined;
}
```

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/instrumentation-gate.test.mjs`
Expected: 2 pass / 0 fail.

- [ ] **Step 5: Commit**

```bash
git add test-support/instrumentation-gate.mjs test/instrumentation-gate.test.mjs
git commit -m "test: add the instrumentation predicate (issue #305)"
```

---

### Task 2: Conditional skips, static pins, and the dual-direction TAP guard

**Files:**
- Modify: `test/attach-entry-22.test.mjs`
- Modify: `test/instrumentation-gate.test.mjs`
- Create: `test/attach-entry-22-instrumentation.test.mjs`

**Interfaces:**
- Consumes: `underCoverageInstrumentation` from Task 1; existing `runCli`/scenario plumbing in the target file (untouched).
- Produces: A2/A3/A8 static pins and the A4 runtime guard. No production interface changes.

**Acceptance IDs:** A2, A3, A4, A5, A6, A8 (A7 is CI-only after the PR gate; U1 is post-merge).

- [ ] **Step 1: Add the failing static guards**

Extend `test/instrumentation-gate.test.mjs` with imports and helpers:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGET = "test/attach-entry-22.test.mjs";
const read = (rel) => readFileSync(join(PACKAGE_ROOT, rel), "utf8");
```

Add three guards (reuse `testCaseBody` from `test-support/test-source-scan.mjs` — B and Q are top-level cases):

```js
import { testCaseBody } from "../test-support/test-source-scan.mjs";

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
```

- [ ] **Step 2: Write the failing runtime guard**

Create `test/attach-entry-22-instrumentation.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGET = "test/attach-entry-22.test.mjs";
const CASE_B = "step 22/24 B: 25 ms continuous real-entry modern publish";
const CASE_Q = "step 22/24 Q: nonempty-then-quiet real-entry modern publish";

function runTarget(env) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--test", TARGET], {
			cwd: PACKAGE_ROOT,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
}

function resultRows(stdout) {
	return stdout.split(/\r?\n/)
		// `# Subtest:` headers carry the same names; only result rows are outcomes.
		.filter((line) => /^(?:not )?ok \d+ - /.test(line));
}

test("A4: B/Q run clean and skip only under instrumentation", { timeout: 120_000 }, async () => { // budget: spawns the 4-case file twice (~20s clean + ~1s skipped); 2 min = 6x headroom
	const { NODE_TEST_CONTEXT, ...base } = process.env;

	const clean = await runTarget(base);
	assert.equal(clean.signal, null, clean.stderr);
	assert.equal(clean.code, 0, `clean run failed\n${clean.stdout}\n${clean.stderr}`);
	for (const name of [CASE_B, CASE_Q]) {
		const row = resultRows(clean.stdout).find((line) => line.includes(name));
		assert.ok(row, `clean TAP row missing for ${name}\n${clean.stdout}`);
		assert.match(row, /^ok \d+ - /);
		assert.doesNotMatch(row, /# SKIP/i);
	}

	const covDir = mkdtempSync(join(tmpdir(), "issue305-cov-"));
	try {
		const instrumented = await runTarget({ ...base, NODE_V8_COVERAGE: covDir });
		assert.equal(instrumented.signal, null, instrumented.stderr);
		assert.equal(instrumented.code, 0, `instrumented run failed\n${instrumented.stdout}\n${instrumented.stderr}`);
		for (const name of [CASE_B, CASE_Q]) {
			const row = resultRows(instrumented.stdout).find((line) => line.includes(name));
			assert.ok(row, `instrumented TAP row missing for ${name}\n${instrumented.stdout}`);
			// Node's TAP escapes "#" as "\#" in skip directives; "\\?" = optional literal backslash.
			assert.match(row, /^ok \d+ - .*# SKIP issue \\?#305/);
		}
	} finally {
		rmSync(covDir, { recursive: true, force: true });
	}
});
```

- [ ] **Step 3: Verify RED before the target edit**

Run:

```bash
node --test test/instrumentation-gate.test.mjs
node --test test/attach-entry-22-instrumentation.test.mjs
```

Expected: A2 fails (no skip wiring yet); A3/A8 may fail on the missing header note (A3 may pass if assertions exist); the runtime guard fails on the instrumented direction (no `# SKIP issue #305` rows). A1 still passes.

- [ ] **Step 4: Implement the target-file changes**

In `test/attach-entry-22.test.mjs`:

1. Add the import:

```js
import { underCoverageInstrumentation } from "../test-support/instrumentation-gate.mjs";
```

2. Extend the file-header comment block (below the existing issue-#222 note) with the rationale:

```js
// issue #305: the 200 ms publish target is a product-derived hot-attach budget;
// one trial is a witness, not a distribution. It is only decided in plain runs —
// coverage instrumentation (NODE_V8_COVERAGE) inflates latency 2.5–6× (issue #121),
// so B/Q skip with a reason under c8 and keep running everywhere else.
```

3. Add the exact conditional option as the second argument of each of the two tests, without renaming them:

```js
{ skip: underCoverageInstrumentation() ? "issue #305: real-time budget is invalid under coverage instrumentation (NODE_V8_COVERAGE); asserted in plain runs" : undefined }
```

4. Touch nothing else — `runCli`, assertions, timeouts unchanged.

- [ ] **Step 5: Verify GREEN at every focused layer**

Run:

```bash
node --test test/instrumentation-gate.test.mjs
node --test test/attach-entry-22-instrumentation.test.mjs
node --test test/attach-entry-22.test.mjs
node --test test/budget-audit.test.mjs
node --test test/frame-witness-quarantine.test.mjs
```

Expected: all exit 0. The plain target run shows B/Q as `ok` (not SKIP); the guard proves both directions.

- [ ] **Step 6: Coverage-phase check and full gate**

Run:

```bash
npm run test:coverage
npm run verify
```

Expected: both exit 0. In the coverage run, B/Q appear as skipped with the issue #305 reason; All files thresholds stay ≥ 85/80/70. Record the suite wall-clock increase in the report (spec D3 promised ~+20 s per phase, measured at implementation).

- [ ] **Step 7: Commit**

```bash
git add test/attach-entry-22.test.mjs test/instrumentation-gate.test.mjs test/attach-entry-22-instrumentation.test.mjs
git commit -m "test: skip B/Q real-time budgets under instrumentation (issue #305)"
```

## Acceptance Traceability

| ID | Owning task | Evidence |
|---|---|---|
| A1 | Task 1 | Truth table incl. empty-string and default-env cases |
| A2 | Task 2 | Static pin of the conditional skip on both tests |
| A3 | Task 2 | Four core assertions pinned per case |
| A4 | Task 2 | Runtime dual-direction TAP proof |
| A5 | Task 2 | `npm run test:coverage` thresholds hold with B/Q skipped |
| A6 | Task 2 | `node --test test/budget-audit.test.mjs` + `npm run verify` |
| A8 | Task 2 | Header rationale pinned (200 ms, issue #305, witness) |
| A7 | After PR authorization | CI dual matrix; Coverage-step logs show the skip |
| U1 | After merge | ≥5 main runs, family zero-hit; plain-run contention reds go to #306 |
