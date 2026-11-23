# Issue #95 Legacy Marker-Failure Quarantine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Temporarily skip only the legacy half of the marker-failure integration case, preserve and instrument the owned half, and mechanically prove both outcomes.

**Architecture:** Keep the quarantine and postmortem wiring in the existing integration file. Put source-scanning primitives in a pure `test-support/` module, use a static guard for source invariants, and use one separate integration guard that parses real TAP output.

**Tech Stack:** Node.js 22/24, `node:test`, `assert/strict`, ESM, child-process spawn, repository test-support helpers.

## Global Constraints

- Work only in this worktree; never edit the main checkout.
- Test-only: do not change `runner/`, `src/`, `.github/workflows/ci.yml`, dependencies, or test case names.
- Preserve `waitFor` defaults `timeoutMs = 15000` and `intervalMs: 25`; preserve the target case's 15000/5000 waits.
- Use exactly the conditional form `skip: legacy ? "issue #95: temporary quarantine for CI wall-clock contention; restore after process-phase serialization" : undefined`.
- Use a named `const capture = () => formatPostmortem(capturePostmortem(root, viewId, null));` and pass bare `capture` as the final argument, without a trailing comma after it.
- Do not import one test file from another. Pure scanners live in `test-support/test-source-scan.mjs`.
- The PR says `Refs #95`, never `Fixes #95`; this slice does not close the umbrella issue.
- Follow red-green TDD for the new scanner and quarantine behavior. Preservation guards for assertions that already exist may be green at baseline, but the new skip/capture/default-value guards must fail before the target edit.
- Every commit is a conventional commit and stages files by name, never `git add -A`.

---

### Task 1: Pure source scanner and migration

**Files:**
- Create: `test-support/test-source-scan.mjs`
- Create: `test/frame-witness-quarantine.test.mjs`
- Modify: `test/wait-capture-wiring.test.mjs`

**Interfaces:**
- Consumes: existing `testCaseBody(source, marker)` and `waitForCalls(body)` implementations in `test/wait-capture-wiring.test.mjs`.
- Produces: `testCaseBody(source, marker)`, `waitForCalls(body)`, and `indentedTestCaseBody(source, marker)` as named exports from `test-support/test-source-scan.mjs`.

**Acceptance IDs:** A1; A6 for the unchanged five wiring tests.

- [ ] **Step 1: Write the failing scanner tests**

Create `test/frame-witness-quarantine.test.mjs` with these tests, using tabs for indentation:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { indentedTestCaseBody } from "../test-support/test-source-scan.mjs";

const SAMPLE = [
	"for (const legacy of [false, true]) {",
	"\ttest(`one`, async () => {",
	"\t\tconst value = 1;",
	"\t});",
	"\ttest(`two`, async () => {",
	"\t\tconst value = 2;",
	"\t});",
	"}",
	"",
].join("\n");

test("A1: indentedTestCaseBody stops at the matching indented case boundary", () => {
	const body = indentedTestCaseBody(SAMPLE, "\ttest(`one`");
	assert.match(body, /const value = 1/);
	assert.doesNotMatch(body, /test\(`two`/);
	assert.ok(body.endsWith("\n\t});"));
});

test("A1: indentedTestCaseBody fails closed on an absent marker or closing boundary", () => {
	assert.throws(() => indentedTestCaseBody(SAMPLE, "\ttest(`missing`"), /case not found/);
	assert.throws(() => indentedTestCaseBody("\ttest(`open`, async () => {", "\ttest(`open`"), /case end not found/);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/frame-witness-quarantine.test.mjs`

Expected: failure resolving `../test-support/test-source-scan.mjs`, because the module does not exist yet.

- [ ] **Step 3: Move the existing scanners and implement the indented scanner**

Create `test-support/test-source-scan.mjs`. Move `testCaseBody` and `waitForCalls` verbatim from `test/wait-capture-wiring.test.mjs`, including their JSDoc, and add:

```js
/**
 * Return the source of one tab-indented `test("<marker>", …)` case.
 * Missing markers and closing boundaries throw so an empty scan cannot pass.
 * @param {string} source
 * @param {string} marker
 * @returns {string}
 */
export function indentedTestCaseBody(source, marker) {
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `case not found: ${marker}`);
	assert.ok(start === 0 || source[start - 1] === "\n", `marker is not at line start: ${marker}`);
	const close = source.indexOf("\n\t});", start);
	assert.notEqual(close, -1, `case end not found: ${marker}`);
	return source.slice(start, close + 5);
}
```

The new module imports `assert` from `node:assert/strict`. Change `test/wait-capture-wiring.test.mjs` to import `testCaseBody` and `waitForCalls` from `../test-support/test-source-scan.mjs`; remove those two definitions from the test file and leave all five tests unchanged.

- [ ] **Step 4: Verify GREEN and migration regression**

Run:

```bash
node --test test/frame-witness-quarantine.test.mjs
node --test test/wait-capture-wiring.test.mjs
```

Expected: two scanner tests pass; all five existing wiring tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add test-support/test-source-scan.mjs test/frame-witness-quarantine.test.mjs test/wait-capture-wiring.test.mjs
git commit -m "test: add an indented test-case scanner (issue #95)"
```

---

### Task 2: Conditional quarantine, postmortem wiring, and TAP proof

**Files:**
- Modify: `test/frame-witness-quarantine.test.mjs`
- Create: `test/frame-witness-quarantine-tap.test.mjs`
- Modify: `test/attach-frame-witness.integration.test.mjs`

**Interfaces:**
- Consumes: `indentedTestCaseBody` and `waitForCalls` from Task 1; existing `capturePostmortem`, `formatPostmortem`, and `waitForWithPostmortem` from `test-support/flake-postmortem.mjs`.
- Produces: static guards for A2–A5 and a real TAP guard for A7. No production interface changes.

**Acceptance IDs:** A2, A3, A4, A5, A6, A7. A8 is CI-only after the PR gate; U1/U2 are post-merge or later restoration checks, not implementation steps.

- [ ] **Step 1: Add the failing static guards**

Extend `test/frame-witness-quarantine.test.mjs` with filesystem reads and the two scanner imports:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { indentedTestCaseBody, waitForCalls } from "../test-support/test-source-scan.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGET = "test/attach-frame-witness.integration.test.mjs";
const read = (rel) => readFileSync(join(PACKAGE_ROOT, rel), "utf8");
const targetCase = () => indentedTestCaseBody(read(TARGET), "\ttest(`internal marker failure revokes capability");
```

Add four guards:

```js
test("A2: the shared wait keeps its 15000 ms default and 25 ms interval", () => {
	const source = read(TARGET);
	assert.match(source, /async function waitFor\(predicate, timeoutMs = 15000, capture = null\)/);
	assert.match(source, /waitForWithPostmortem\(predicate, \{ timeoutMs, intervalMs: 25, capture \}\)/);
});

test("A3: both marker-failure waits carry the named postmortem capture", () => {
	const calls = waitForCalls(targetCase());
	assert.equal(calls.length, 2);
	for (const args of calls) assert.match(args, /,\s*capture\s*$/);
});

test("A4: only the legacy branch carries the temporary issue #95 skip", () => {
	const body = targetCase();
	assert.match(body, /skip:\s*legacy\s*\?\s*"issue #95[^"]*"\s*:\s*undefined/);
	assert.match(body, /temporary quarantine/);
	assert.match(body, /restore after process-phase serialization/);
});

test("A5: both capability-loss assertions remain in the parameterized case", () => {
	const body = targetCase();
	assert.match(body, /msg\.status\?\.frameWitness\?\.enabled === false/);
	assert.match(body, /readHost\(root, viewId\)\?\.frameWitness\?\.enabled === false/);
});
```

- [ ] **Step 2: Write the failing TAP guard**

Create `test/frame-witness-quarantine-tap.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGET = "test/attach-frame-witness.integration.test.mjs";
const CASE_NAME = "internal marker failure revokes capability via onUnavailable";

function runTargetFile() {
	// An inherited NODE_TEST_CONTEXT makes this nested `node --test` skip files
	// as a recursive run; scrub it so the guard measures the real target file.
	const { NODE_TEST_CONTEXT, ...parentEnv } = process.env;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--test", "--test-reporter=tap", TARGET], {
			cwd: PACKAGE_ROOT,
			env: parentEnv,
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

test("A7: TAP runs owned and skips only legacy with the issue reason", { timeout: 240_000 }, async () => { // budget: spawns the whole 29-case file; 4 min = 5.3x the 45.08s local measurement
	const result = await runTargetFile();
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.code, 0, `target file failed\n${result.stdout}\n${result.stderr}`);
	const rows = result.stdout
		.split(/\r?\n/)
		// Exclude `# Subtest:` headers, which carry the same case name as result rows.
		.filter((line) => /^(?:not )?ok \d+ - /.test(line) && line.includes(CASE_NAME));
	const owned = rows.find((line) => line.includes("(owned main)"));
	const legacy = rows.find((line) => line.includes("(legacy main)"));
	assert.ok(owned, `owned TAP row missing\n${result.stdout}`);
	assert.match(owned, /^ok \d+ - /);
	assert.doesNotMatch(owned, /# SKIP/i);
	assert.ok(legacy, `legacy TAP row missing\n${result.stdout}`);
	assert.match(legacy, /^ok \d+ - .*# SKIP issue \\?#95/);
});
```

- [ ] **Step 3: Verify RED for the new behavior**

Run:

```bash
node --test test/frame-witness-quarantine.test.mjs
node --test test/frame-witness-quarantine-tap.test.mjs
```

Expected before the target edit: A2/A3/A4 fail because the optional capture and conditional skip are absent; A5 may pass because it preserves existing assertions. The TAP guard fails because legacy has no `# SKIP issue #95` row and owned is not yet the sole running half.

- [ ] **Step 4: Implement the minimal target-file changes**

In `test/attach-frame-witness.integration.test.mjs`:

1. Add this import:

```js
import { capturePostmortem, formatPostmortem, waitForWithPostmortem } from "../test-support/flake-postmortem.mjs";
```

2. Replace only the local wait helper with:

```js
async function waitFor(predicate, timeoutMs = 15000, capture = null) {
	return waitForWithPostmortem(predicate, { timeoutMs, intervalMs: 25, capture });
}
```

3. Add the exact conditional option to the existing parameterized test, without renaming it:

```js
{ skip: legacy ? "issue #95: temporary quarantine for CI wall-clock contention; restore after process-phase serialization" : undefined }
```

4. Immediately after `startHost(...)` in that case, add:

```js
const capture = () => formatPostmortem(capturePostmortem(root, viewId, null));
```

5. Pass `15000, capture` to the first wait and `5000, capture` to the second. Use bare `capture` as the final argument with no trailing comma after it. Leave both capability-loss assertions unchanged.

- [ ] **Step 5: Verify GREEN at every focused layer**

Run:

```bash
node --test test/frame-witness-quarantine.test.mjs
node --test test/wait-capture-wiring.test.mjs
node --test test/flake-postmortem.test.mjs
node --test test/attach-frame-witness.integration.test.mjs
node --test test/frame-witness-quarantine-tap.test.mjs
node --test test/budget-audit.test.mjs
```

Expected: all commands exit 0. The target file reports 29 tests, 28 pass, 1 skipped, 0 fail; the TAP guard independently proves owned `ok` without SKIP and legacy `ok … # SKIP issue #95`.

- [ ] **Step 6: Run the repository-wide acceptance gate**

Run: `npm run verify`

Expected: exit 0, including typecheck, opt-in perf gate, full tests, c8 coverage thresholds (lines 85 / funcs 80 / branches 70), and package dry-run. If a failure is outside this diff, record its exact signature and do not weaken unrelated tests to obtain green.

- [ ] **Step 7: Commit Task 2**

```bash
git add test/attach-frame-witness.integration.test.mjs test/frame-witness-quarantine.test.mjs test/frame-witness-quarantine-tap.test.mjs
git commit -m "test: quarantine the legacy marker-failure case (issue #95)"
```

## Implementation Amendments

Task 2 exposed three factual defects in the original A7 sample before the target edit. The controller approved all three without changing scope: scrub inherited `NODE_TEST_CONTEXT`, parse only TAP result rows rather than `# Subtest:` headers, and tolerate Node's escaped `\#95` skip reason. The sample above now matches the tested implementation.

## Acceptance Traceability

| Acceptance ID | Owning task | Evidence |
|---|---|---|
| A1 | Task 1 | Scanner truth table and fail-closed errors |
| A2 | Task 2 | Static default-value guard and target-file run |
| A3 | Task 2 | Two waits end in bare `capture` |
| A4 | Task 2 | Conditional-skip source guard |
| A5 | Task 2 | Both original assertions pinned by source guard |
| A6 | Tasks 1–2 | Existing wiring tests plus `npm run verify` |
| A7 | Task 2 | Real TAP parse: owned non-SKIP, legacy SKIP with issue reason |
| A8 | After PR authorization | Required Node 22 and Node 24 checks |
| U1 | After merge | Observe at least five main runs for this signature |
| U2 | When process-phase serialization lands | Revert quarantine and update the guards |
