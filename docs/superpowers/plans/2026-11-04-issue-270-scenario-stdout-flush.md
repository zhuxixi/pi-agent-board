# Scenario stdout flush before exit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `test-support` harness wait for stdout to drain before `process.exit`, so a large JSON result can no longer be truncated at the 64 KiB pipe buffer and turn every PR's CI red.

**Architecture:** One shared helper (`writeThenExit` + the `exitAfterStdout` binding) replaces 18 hand-written `write(); exit();` pairs. A static guard test parses `test-support/**` with the TypeScript compiler API and fails if the shape ever comes back; its detector is a pure function covered by synthetic positive/negative samples.

**Tech Stack:** Node 22/24 (ESM, `node:test`), TypeScript compiler API (`typescript@^5.9.3`, already a devDependency) for the guard, `node:child_process` for the slow-reader integration test.

**Spec:** `docs/superpowers/specs/2026-11-04-issue-270-scenario-stdout-flush-design.md` (issue #270)

## Global Constraints

- Indentation is **tabs**; code comments and commit messages are **English** (repo `AGENTS.md`).
- Conventional commit subjects: `feat`/`fix`/`test`/`docs`/`chore`, with `(issue #270)` appended.
- **Never modify** `test-support/fake-pty-pi.mjs` or `test-support/fake-pty-generation-pi.mjs`: their sha256 is pinned by `S15_ACCEPTED_HASHES.fakePtyChild` / `ENTRY_ACCEPTED_HASHES.generationFixture` (`test/pty-attach-ready.test.mjs:1159,2594`).
- Stage files individually (`git add <path>`); never `git add -A`.
- Work only inside the worktree `/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-270-scenario-stdout-flush`.
- New test files must be named `*.test.mjs` under `test/` — `scripts/run-tests.mjs:348-349` discovers exactly that pattern.
- `test-support/**` is excluded from coverage (`.c8rc.json`), so the helper needs no coverage-driven contortions.

## Review Focus

- **Broken pipe (EPIPE):** the reader closes stdout while the harness is still writing. Expected: exit with the caller's code, not an uncaught `error` event. Pinned by Task 1's error-branch test.
- **Write callback vs. timer/child handles:** several fixtures keep the event loop alive with `setInterval` or child processes, so natural drain-then-exit must stay an explicit `exit`. Pinned by Task 4/A4 running the existing suites.
- **Payloads just above 64 KiB:** the boundary is the kernel pipe buffer, not the payload size. Pinned by Task 2 (256 KiB through a deliberately stalled reader).
- **Guard false positives:** `.then` writing and `.catch` exiting are *not* adjacency, and `console.*` is out of scope. Pinned by Task 3's negative samples.
- **Guard false negatives after the sweep:** a new `write(); exit();` must fail the suite. Pinned by Task 3's positive samples plus the directory scan.

---

### Task 1: Shared flush helper + its unit tests

**Files:**
- Create: `test-support/stdout-flush.mjs`
- Test: `test/scenario-stdout-flush.test.mjs`

**Interfaces:**
- Produces:
  - `writeThenExit(stream: Writable, text: string, code: number, exit: (code: number) => void): void`
  - `exitAfterStdout(text: string, code?: number): void` (defaults to `0`)

- [ ] **Step 1: Write the failing test**

Create `test/scenario-stdout-flush.test.mjs`:

```js
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { writeThenExit } from "../test-support/stdout-flush.mjs";

/** Minimal stand-in for a writable: records bytes, then either calls back or fails. */
class FakeStream extends EventEmitter {
	constructor({ failSync = false } = {}) {
		super();
		this.written = "";
		this.failSync = failSync;
	}

	write(text, callback) {
		if (this.failSync) throw new Error("write failed synchronously");
		this.written += text;
		this.callback = callback;
		return true;
	}
}

test("stdout-flush: exit runs once after the write callback fires", () => {
	const stream = new FakeStream();
	const exits = [];
	writeThenExit(stream, "payload\n", 0, (code) => exits.push(code));
	assert.equal(stream.written, "payload\n");
	assert.deepEqual(exits, [], "exit must wait for the write callback");
	stream.callback();
	assert.deepEqual(exits, [0]);
});

test("stdout-flush: a broken pipe still exits with the caller's code, exactly once", () => {
	const stream = new FakeStream();
	const exits = [];
	writeThenExit(stream, "payload\n", 3, (code) => exits.push(code));
	stream.emit("error", new Error("EPIPE"));
	stream.callback();
	assert.deepEqual(exits, [3], "the error path exits once and the late callback is ignored");
});

test("stdout-flush: a synchronous write throw still exits with the caller's code", () => {
	const stream = new FakeStream({ failSync: true });
	const exits = [];
	writeThenExit(stream, "payload\n", 1, (code) => exits.push(code));
	assert.deepEqual(exits, [1]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/scenario-stdout-flush.test.mjs`
Expected: FAIL — `Cannot find module '../test-support/stdout-flush.mjs'`.

- [ ] **Step 3: Write the helper**

Create `test-support/stdout-flush.mjs`:

```js
/**
 * Write `text` to `stream`, then call `exit(code)` once the write has drained.
 *
 * A bare `stream.write(text); exit(code)` tears the process down while the
 * kernel pipe still holds a partial payload: everything past the 64 KiB pipe
 * buffer is lost and the exit code still says 0. Issue #270 hit this with a
 * ~143 KB battery result truncated at exactly 65536 bytes, which turned every
 * PR's CI red while passing locally.
 *
 * `stream` and `exit` are injected so the three paths — flushed, broken pipe,
 * synchronous write error — are unit-testable without spawning a child. Only
 * statement-adjacent `process.stdout.write(...)` followed by `process.exit(...)`
 * is guarded; a write inside `try` with the exit in `finally` is out of scope.
 *
 * @param {import("node:stream").Writable} stream
 * @param {string} text
 * @param {number} code exit status the caller already decided on
 * @param {(code: number) => void} exit
 */
export function writeThenExit(stream, text, code, exit) {
	let settled = false;
	const finish = () => {
		if (settled) return;
		settled = true;
		exit(code);
	};
	stream.once("error", finish);
	try {
		stream.write(text, finish);
	} catch {
		finish();
	}
}

/**
 * Bind {@link writeThenExit} to the real process. Use this instead of
 * `process.stdout.write(...); process.exit(...)` in every test-support harness.
 *
 * @param {string} text
 * @param {number} [code]
 */
export function exitAfterStdout(text, code = 0) {
	writeThenExit(process.stdout, text, code, (status) => process.exit(status));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/scenario-stdout-flush.test.mjs`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add test-support/stdout-flush.mjs test/scenario-stdout-flush.test.mjs
git commit -F - <<'EOF'
feat(test): flush stdout before exiting a test-support harness (issue #270)
EOF
```

---

### Task 2: Probe fixture + slow-reader integration test

**Files:**
- Create: `test-support/stdout-flush-probe.mjs`
- Modify: `test/scenario-stdout-flush.test.mjs` (append one test)

**Interfaces:**
- Consumes: `exitAfterStdout` from Task 1.
- Produces: `test-support/stdout-flush-probe.mjs` accepting `--bytes N` (default `262144`), writing `{"payload":"x"*N}\n` and exiting through the helper.

- [ ] **Step 1: Write the failing test**

Append to `test/scenario-stdout-flush.test.mjs` (add the imports at the top of the file):

```js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
```

```js
const PROBE = fileURLToPath(new URL("../test-support/stdout-flush-probe.mjs", import.meta.url));

/**
 * Spawn the probe with stdout on a pipe and attach the reader only after
 * `delayMs`. While nobody reads, the kernel pipe buffer (64 KiB) fills and the
 * child's write goes pending — the exact condition that truncated issue #270.
 * The delay is not a timing assertion: the 256 KiB payload cannot fit either way.
 */
function runProbeWithSlowReader(bytes, delayMs = 250) {
	return new Promise((settle, fail) => {
		const child = spawn(process.execPath, [PROBE, "--bytes", String(bytes)], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks = [];
		let stderr = "";
		// No stdout listener yet: the stream stays paused, nobody reads the pipe, and
		// the kernel buffer (64 KiB) fills — the issue #270 condition. Do NOT add
		// `child.stdout.pause()` here: an explicit pause() sets flowing = false and the
		// delayed `.on("data")` below would never resume the stream (the test hangs).
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", fail);
		child.on("close", (code) => settle({ code, stdout: Buffer.concat(chunks).toString("utf8"), stderr }));
		setTimeout(() => child.stdout.on("data", (chunk) => chunks.push(chunk)), delayMs).unref();
	});
}

test("stdout-flush: a 256 KiB result survives a reader that starts late", async () => {
	const result = await runProbeWithSlowReader(262144);
	assert.equal(result.code, 0, `probe must exit 0; stderr:\n${result.stderr}`);
	const parsed = JSON.parse(result.stdout);
	assert.equal(parsed.payload.length, 262144, "every byte of the payload must reach the reader");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/scenario-stdout-flush.test.mjs`
Expected: FAIL — the probe file does not exist (`Cannot find module .../stdout-flush-probe.mjs`, exit code 1).

- [ ] **Step 3: Write the probe**

Create `test-support/stdout-flush-probe.mjs`:

```js
#!/usr/bin/env node
/**
 * Executable fixture for the stdout-flush integration test (issue #270).
 * Writes a JSON result comfortably past the 64 KiB pipe buffer, then exits
 * through the shared helper so the payload is fully drained first.
 */
import { exitAfterStdout } from "./stdout-flush.mjs";

const index = process.argv.indexOf("--bytes");
const bytes = index === -1 ? 262144 : Number(process.argv[index + 1]);
exitAfterStdout(`${JSON.stringify({ payload: "x".repeat(bytes) })}\n`, 0);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/scenario-stdout-flush.test.mjs`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Prove the test has teeth (manual, no committed change)**

Back up the probe, swap in the old shape, confirm the new test fails, then restore:

```bash
cp test-support/stdout-flush-probe.mjs /tmp/stdout-flush-probe.bak
# edit the last line of test-support/stdout-flush-probe.mjs to:
#   process.stdout.write(`${JSON.stringify({ payload: "x".repeat(bytes) })}\n`);
#   process.exit(0);
node --test test/scenario-stdout-flush.test.mjs
```
Expected: FAIL with `Unexpected end of JSON input` (empty stdout) or a payload shorter than 262144. Then:

```bash
cp /tmp/stdout-flush-probe.bak test-support/stdout-flush-probe.mjs
node --test test/scenario-stdout-flush.test.mjs
```
Expected: PASS again. Leave no backup file inside the worktree.

- [ ] **Step 6: Commit**

```bash
git add test-support/stdout-flush-probe.mjs test/scenario-stdout-flush.test.mjs
git commit -F - <<'EOF'
test: prove a slow reader no longer truncates harness results (issue #270)
EOF
```

---

### Task 3: Static guard (red first) + detector self-tests

**Files:**
- Modify: `test/scenario-stdout-flush.test.mjs` (append detector + 2 tests)

**Interfaces:**
- Produces: `findUnguardedStdoutExits(sourceText: string, fileName: string): {file: string, line: number}[]` inside the test file.

- [ ] **Step 1: Write the failing guard**

Append to `test/scenario-stdout-flush.test.mjs` (add these imports at the top):

```js
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
```

```js
const TEST_SUPPORT_ROOT = fileURLToPath(new URL("../test-support/", import.meta.url));

const isPropertyAccessOn = (node, name, receiver) =>
	ts.isPropertyAccessExpression(node) && node.name.text === name && receiver(node.expression);
const isProcessIdentifier = (node) => ts.isIdentifier(node) && node.text === "process";
const isStdoutReceiver = (node) => isPropertyAccessOn(node, "stdout", isProcessIdentifier);
const isCallStatement = (statement, property, receiver) =>
	ts.isExpressionStatement(statement) &&
	ts.isCallExpression(statement.expression) &&
	isPropertyAccessOn(statement.expression.expression, property, receiver);
const writesStdout = (statement) => isCallStatement(statement, "write", isStdoutReceiver);
const exitsProcess = (statement) => isCallStatement(statement, "exit", isProcessIdentifier);

/** Unwrap `if`/block so `if (ready) process.stdout.write(x)` counts as a write. */
function containsStatement(statement, predicate) {
	if (predicate(statement)) return true;
	if (ts.isIfStatement(statement)) {
		return containsStatement(statement.thenStatement, predicate) ||
			(statement.elseStatement !== undefined && containsStatement(statement.elseStatement, predicate));
	}
	if (ts.isBlock(statement)) return statement.statements.some((child) => containsStatement(child, predicate));
	return false;
}

/**
 * List every statement pair where one writes `process.stdout` and the next one
 * calls `process.exit`. `console.*` is deliberately not matched: those payloads
 * are short human-readable lines, and the spec keeps them out of scope.
 * A write inside `try` with the exit in `finally` is not covered.
 */
export function findUnguardedStdoutExits(sourceText, fileName) {
	const file = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
	const found = [];
	const visit = (node) => {
		if (node.statements !== undefined) {
			for (let index = 0; index + 1 < node.statements.length; index += 1) {
				const previous = node.statements[index];
				const next = node.statements[index + 1];
				// Two sibling conditionals are independent paths, never one drain-then-exit
				// sequence: `if (dryRun) { write; exit; } if (guard) { …; exit(2); }` would
				// otherwise pair the two outer ifs. A real pair inside their blocks is found
				// by the recursion into each block.
				if (ts.isIfStatement(previous) && ts.isIfStatement(next)) continue;
				if (containsStatement(previous, writesStdout) && containsStatement(next, exitsProcess)) {
					const { line } = file.getLineAndCharacterOfPosition(previous.getStart(file));
					found.push({ file: fileName, line: line + 1 });
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

function testSupportFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...testSupportFiles(path));
		else if (/\.(ts|mjs|js)$/.test(entry.name)) files.push(path);
	}
	return files;
}

test("stdout-flush: the detector flags the shape and accepts the guards", () => {
	const violations = [
		["plain write then exit", `process.stdout.write("x");\nprocess.exit(0);`],
		["conditional write then exit", `if (ready) process.stdout.write(carry);\nprocess.exit(1);`],
		["block-wrapped write then exit", `if (ready) { process.stdout.write(token); }\nprocess.exit(0);`],
	];
	for (const [label, source] of violations) {
		assert.equal(findUnguardedStdoutExits(source, "sample.mjs").length, 1, `must flag: ${label}`);
	}
	const accepted = [
		["write with an exit callback", `process.stdout.write("x", () => process.exit(0));`],
		["shared helper", `exitAfterStdout("x", 0);`],
		["console.log then exit", `console.log("x");\nprocess.exit(0);`],
		["then writes, catch exits", `run().then((r) => { process.stdout.write(JSON.stringify(r)); }).catch(() => { process.exit(1); });`],
		["flush, then conditional helper exit", `process.stdout.write("echo:hi\\n");\nif (exiting) exitAfterStdout("", 0);`],
		["sibling conditionals never pair", `if (dryRun) { process.stdout.write("x"); }\nif (approved !== "1") { process.exit(2); }`],
	];
	for (const [label, source] of accepted) {
		assert.deepEqual(findUnguardedStdoutExits(source, "sample.mjs"), [], `must accept: ${label}`);
	}
});

test("stdout-flush: no test-support file writes stdout immediately before process.exit", () => {
	const offenders = [];
	for (const path of testSupportFiles(TEST_SUPPORT_ROOT)) {
		offenders.push(...findUnguardedStdoutExits(readFileSync(path, "utf8"), relative(TEST_SUPPORT_ROOT, path)));
	}
	assert.deepEqual(
		offenders,
		[],
		`write-then-exit must go through exitAfterStdout():\n${offenders.map((entry) => `${entry.file}:${entry.line}`).join("\n")}`,
	);
});
```

- [ ] **Step 2: Run the guard to verify it fails on the real tree**

Run: `node --test test/scenario-stdout-flush.test.mjs`
Expected: detector self-test PASSES; the directory scan FAILS listing exactly these 18 locations:

```
attach-entry-22-scenario.ts:1382  attach-ready-catchup-scenario.ts:368
attach-ready-entry-scenario.ts:1070  attach-ready-interactions-scenario.ts:656
ensure-host-helper.mjs:44  fake-pty-frame-wrapper.mjs:137  fake-pty-frame-wrapper.mjs:143
fake-slow-start-pi.mjs:34  formal-measurement/formal-runner.mjs:24
formal-measurement/preflight.mjs:135  pi23a-production-smoke-runner.mjs:317
pi23a-smoke-runner.mjs:452  pty-attach-20b-scenario.ts:4010
pty-attach-21b-scenario.ts:1389  pty-attach-matrix-scenario.ts:1222
pty-attach-parser-replacement-scenario.ts:808  pty-attach-ready-scenario.ts:4452
pty-attach-timing-scenario.ts:1653
```

If the list differs, stop and reconcile the detector with `research/01-reproduction-and-inventory.md` §3 — do **not** weaken the detector to make it pass.

- [ ] **Step 3: Commit the red guard**

```bash
git add test/scenario-stdout-flush.test.mjs
git commit -F - <<'EOF'
test: guard test-support against write-then-exit truncation (issue #270)
EOF
```

---

### Task 4: Replace all 18 write-then-exit sites

**Files (modify):**
- 10 scenarios: `pty-attach-ready-scenario.ts:4452`, `attach-entry-22-scenario.ts:1382`, `attach-ready-catchup-scenario.ts:368`, `attach-ready-entry-scenario.ts:1070`, `attach-ready-interactions-scenario.ts:656`, `pty-attach-20b-scenario.ts:4010`, `pty-attach-21b-scenario.ts:1389`, `pty-attach-matrix-scenario.ts:1222`, `pty-attach-timing-scenario.ts:1653`, `pty-attach-parser-replacement-scenario.ts:808`
- `ensure-host-helper.mjs:44`, `pi23a-smoke-runner.mjs:452`, `pi23a-production-smoke-runner.mjs:317`, `formal-measurement/formal-runner.mjs:24`, `formal-measurement/preflight.mjs:135`
- Special recipes: `fake-pty-frame-wrapper.mjs:137,143`, `fake-slow-start-pi.mjs:34-35`

**Interfaces:**
- Consumes: `exitAfterStdout(text, code?)` from Task 1.
- Produces: nothing new; the guard from Task 3 goes green.

- [ ] **Step 1: Mechanical replacement (15 sites)**

In each of the files listed above (except the three special-recipe lines), replace the two-statement pair with one call, keeping the payload expression and the exit code expression **verbatim**:

```diff
-			process.stdout.write(JSON.stringify(result) + "\n");
-			process.exit(0);
+			exitAfterStdout(JSON.stringify(result) + "\n", 0);
```

Variants keep their own code expression, e.g. `pty-attach-20b-scenario.ts`:

```diff
-			process.stdout.write(JSON.stringify(result) + "\n");
-			process.exit(typeof result.exitCode === "number" ? result.exitCode : 0);
+			exitAfterStdout(JSON.stringify(result) + "\n", typeof result.exitCode === "number" ? result.exitCode : 0);
```

and `pty-attach-parser-replacement-scenario.ts`, which uses a template literal:

```diff
-		process.stdout.write(`${JSON.stringify(result)}\n`);
-		process.exit(result.ok ? 0 : 1);
+		exitAfterStdout(`${JSON.stringify(result)}\n`, result.ok ? 0 : 1);
```

Add the import next to the other relative imports in each file:

```js
import { exitAfterStdout } from "./stdout-flush.mjs";
```

For `formal-measurement/formal-runner.mjs` and `formal-measurement/preflight.mjs` the import path is `"../stdout-flush.mjs"`.

- [ ] **Step 2: Special recipe — `fake-pty-frame-wrapper.mjs` (2 sites)**

```diff
 		inner.onExit(({ exitCode }) => {
-			if (tokenReady && carry.length > 0) process.stdout.write(carry);
-			process.exit(exitCode ?? 0);
+			exitAfterStdout(tokenReady && carry.length > 0 ? carry : "", exitCode ?? 0);
 		});
 	} else {
 		inner.stdout.on("data", onInnerData);
 		inner.on("exit", (code) => {
-			if (tokenReady && carry.length > 0) process.stdout.write(carry);
-			process.exit(code ?? 0);
+			exitAfterStdout(tokenReady && carry.length > 0 ? carry : "", code ?? 0);
 		});
```

- [ ] **Step 3: Special recipe — `fake-slow-start-pi.mjs` (1 site)**

Keep the write where it is; only the conditional exit changes. This fixture must keep echoing non-exit input (the resize-before-ready test waits for `echo:still-alive` before sending `exit\r`):

```diff
 	process.stdout.write(`echo:${visible}\n`);
-	if (text.includes("exit")) process.exit(0);
+	if (text.includes("exit")) exitAfterStdout("", 0);
```

- [ ] **Step 4: Run the guard and the new tests**

Run: `node --test test/scenario-stdout-flush.test.mjs`
Expected: PASS — 6 tests (3 unit + 1 integration + 2 guard), 0 failures, no offenders listed.

- [ ] **Step 5: Run the s15 battery suite**

Run: `node --test test/pty-attach-ready.test.mjs`
Expected: PASS — 88 tests, 0 failures, including `step 15 integration: case S real-runner battery …`.

- [ ] **Step 6: Commit**

```bash
git add test-support/pty-attach-ready-scenario.ts test-support/attach-entry-22-scenario.ts \
  test-support/attach-ready-catchup-scenario.ts test-support/attach-ready-entry-scenario.ts \
  test-support/attach-ready-interactions-scenario.ts test-support/pty-attach-20b-scenario.ts \
  test-support/pty-attach-21b-scenario.ts test-support/pty-attach-matrix-scenario.ts \
  test-support/pty-attach-timing-scenario.ts test-support/pty-attach-parser-replacement-scenario.ts \
  test-support/ensure-host-helper.mjs test-support/pi23a-smoke-runner.mjs \
  test-support/pi23a-production-smoke-runner.mjs test-support/formal-measurement/formal-runner.mjs \
  test-support/formal-measurement/preflight.mjs test-support/fake-pty-frame-wrapper.mjs \
  test-support/fake-slow-start-pi.mjs
git commit -F - <<'EOF'
fix(test): drain stdout before exiting every test-support harness (issue #270)
EOF
```

---

### Task 5: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Run the repository gate**

Run: `npm run verify`
Expected: PASS — typecheck, perf gate, full test suite, coverage (lines 85 / funcs 80 / branches 70), `pack:dry`.

- [ ] **Step 2: Record the evidence**

Save the command output summary (test counts, coverage numbers) for the PR description and the issue comment. If the perf gate or a real-process suite is flaky, re-run that suite once in isolation before treating it as a regression; if it fails twice, stop and report.

- [ ] **Step 3: Commit only if the gate required a fix**

If `npm run verify` failed for a real reason, fix it, re-run the gate, and commit exactly the touched files with a subject naming the failure (for example `fix(test): keep the fixture alive until the child exits (issue #270)`). Stage each path explicitly; no `git add -A`.

---

### Task 6: PR, Zima CR, and CI

**Files:** none.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin issue-270-scenario-stdout-flush
```

- [ ] **Step 2: Open the PR**

The body must state the scope expansion from spec §4 (issue acceptance named `test-support/*-scenario.ts`; this PR clears all `test-support/**`), the root cause with the 65536-byte evidence, and the verification evidence from Task 5. No `## Testing` placeholders.

```bash
gh pr create --repo zhuxixi/pi-agent-board --base main --head issue-270-scenario-stdout-flush \
  --title "fix(test): drain stdout before exiting test-support harnesses (issue #270)" --body-file <path>
```

- [ ] **Step 3: Trigger Zima CR and wait for convergence**

```bash
gh pr edit <N> --add-label zima:needs-review
```
Then follow `zima-pr-monitor`: read `pi-cr-meta` / `cc-cr-meta`, fix blocking findings in the worktree, re-push, re-label, converge. On this machine the CR job is picked up by the 7700K host via the label — do **not** run `zima pjob run` or `zima pjob ps` here.

- [ ] **Step 4: Watch CI**

```bash
gh pr checks <N> --watch
```
Expected: `Test (Node 22)` and `Test (Node 24)` both pass — this is acceptance A6 and the whole point of the issue.

- [ ] **Step 5: Stop before merge**

Merge requires explicit user approval (`authorization.md` → `Merge: requires-explicit-user-approval`). Report CR convergence + CI status and wait.
