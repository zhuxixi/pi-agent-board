# Six console.log harness exits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the last six `console.log(JSON.stringify(result)); process.exit(code)` harnesses to `exitAfterStdout`, widen the static guard to cover `console.log`/`console.info`, and pin the exit-code/newline contracts the guard alone cannot prove.

**Architecture:** No product code changes. Three layers: (1) the AST predicate in the guard test learns that `console.log`/`console.info` write the same `process.stdout`; (2) six call sites switch to the existing `exitAfterStdout` helper, keeping the text and exit-code expressions verbatim; (3) integration/unit assertions pin the behaviors the guard cannot see — conditional exit codes, the trailing newline, and `FORMAL_BASELINE_REPO` blank handling.

**Tech Stack:** Node 22/24, `node:test` + `assert/strict`, TypeScript compiler API for the AST guard, `--experimental-transform-types` for scenario harnesses.

Spec: `docs/superpowers/specs/2026-11-09-issue-273-harness-console-log-exit-design.md`（验收 ID A1–A9 均引用自此）。

## Global Constraints

- Tabs for indentation; English comments and commit subjects (`feat`/`fix`/`test`/`docs`/`chore`).
- Do not touch `src/**` or `runner/**`; this issue is test-support only.
- Preserve the written text and exit-code expression at every conversion point; only the exit timing changes.
- `npm run verify` is the only complete gate (typecheck + perf + tests + coverage + pack:dry).
- `git add <file>` per file; never `git add -A`.

---

### Task 1: Widen the guard predicate and migrate its self-test samples (A1)

**Files:**
- Modify: `test/scenario-stdout-flush.test.mjs`（样本表、`writesStdout` 谓词、函数注释）
- Modify: `test-support/stdout-flush.mjs:10-15`（只改注释，不改运行时代码）

**Interfaces:**
- Produces: `writesStdout(statement)` 现在覆盖 `process.stdout.write(...)` 与 `console.log(...)` / `console.info(...)`；`findUnguardedStdoutExits(sourceText, fileName)` 签名不变。
- Consumes: 无。

- [ ] **Step 1: Write the failing samples first**

在 `test/scenario-stdout-flush.test.mjs` 的 `violations` 数组加入：

```js
["console.log then exit", `console.log("x");\nprocess.exit(0);`],
["console.info then exit", `console.info("x");\nprocess.exit(0);`],
["conditional console.log then exit", `if (ready) console.log(x);\nprocess.exit(1);`],
```

从 `accepted` 数组删除 `["console.log then exit", ...]`，并加入：

```js
["console.error then exit", `console.error("x");\nprocess.exit(0);`],
```

- [ ] **Step 2: Run the self-test and watch it fail**

Run: `node --test test/scenario-stdout-flush.test.mjs`
Expected: FAIL —— 三条新违例样本返回 `[]`（`must flag: console.log then exit` 等）。

- [ ] **Step 3: Implement the predicate**

在 `isStdoutReceiver` 之后加：

```js
const CONSOLE_STDOUT_METHODS = new Set(["log", "info"]);
const isConsoleIdentifier = (node) => ts.isIdentifier(node) && node.text === "console";
const writesConsole = (statement) =>
	ts.isExpressionStatement(statement) &&
	ts.isCallExpression(statement.expression) &&
	ts.isPropertyAccessExpression(statement.expression.expression) &&
	CONSOLE_STDOUT_METHODS.has(statement.expression.expression.name.text) &&
	isConsoleIdentifier(statement.expression.expression.expression);
```

把 `writesStdout` 改为：

```js
const writesStdout = (statement) =>
	isCallStatement(statement, "write", isStdoutReceiver) || writesConsole(statement);
```

同步函数注释：谓词覆盖 `process.stdout.write` 与 `console.log`/`console.info`（同一 stdout 通道）；
`console.error`（stderr）、`console.debug`、别名写法仍不覆盖。

同步 `test-support/stdout-flush.mjs:10-15` 的注释：守卫覆盖 `process.stdout.write(...)` 与
`console.log`/`console.info(...)`；其余边界保持不变。运行时代码零改动。

- [ ] **Step 4: Run the self-test — samples pass, directory scan now fails on six real offenders**

Run: `node --test test/scenario-stdout-flush.test.mjs`
Expected: 样本用例 PASS；全目录扫描用例 **FAIL**，并列出恰好 6 行
（`pty-attach-frame-overflow-scenario.ts:378`、`pty-attach-mouse-mode-scenario.ts:94`、
`pty-attach-wheel-scenario.ts:187`、`pty-attach-selection-mirror-scenario.ts:260`、
`attach-idle-socket-driver.ts:221`、`attach-idle-candidate-open-harness.mjs:75`）。

这条红就是 A2 的「放宽后守卫确实会咬人」证据，记录在实现评论里。

- [ ] **Step 5: Commit**

```bash
git add test/scenario-stdout-flush.test.mjs test-support/stdout-flush.mjs
git commit -m "test: guard console.log stdout writes before exit (issue #273)"
```

---

### Task 2: Convert the six call sites (A2)

**Files:**
- Modify: `test-support/pty-attach-frame-overflow-scenario.ts:378-379`
- Modify: `test-support/pty-attach-mouse-mode-scenario.ts:94-95`
- Modify: `test-support/pty-attach-wheel-scenario.ts:187-188`
- Modify: `test-support/pty-attach-selection-mirror-scenario.ts:260-261`
- Modify: `test-support/attach-idle-socket-driver.ts:221-222`
- Modify: `test-support/attach-idle-candidate-open-harness.mjs:75-76`

**Interfaces:**
- Consumes: `exitAfterStdout(text, code = 0)`（`test-support/stdout-flush.mjs`，既有）。
- Produces: 六个夹具仍打印一行 JSON + `\n`，退出码表达式不变。

- [ ] **Step 1: Convert the four fixed-code scenarios**

每个文件在现有相对导入区加入 `import { exitAfterStdout } from "./stdout-flush.mjs";`，
把

```ts
console.log(JSON.stringify(result));
process.exit(0);
```

换成

```ts
exitAfterStdout(JSON.stringify(result) + "\n", 0);
```

四个文件：`pty-attach-frame-overflow-scenario.ts`、`pty-attach-mouse-mode-scenario.ts`、
`pty-attach-wheel-scenario.ts`、`pty-attach-selection-mirror-scenario.ts`。

- [ ] **Step 2: Convert the two conditional-code harnesses**

`attach-idle-socket-driver.ts` 与 `attach-idle-candidate-open-harness.mjs` 同样加导入，把

```ts
console.log(JSON.stringify(result));
process.exit(result.settledMs !== null && result.showsContent ? 0 : 1);
```

换成

```ts
exitAfterStdout(JSON.stringify(result) + "\n", result.settledMs !== null && result.showsContent ? 0 : 1);
```

- [ ] **Step 3: Run the guard test — scan is green**

Run: `node --test test/scenario-stdout-flush.test.mjs`
Expected: PASS，`offenders` 为空。

- [ ] **Step 4: Run the four consumer suites**

Run: `node --test test/pty-attach-frame-overflow.test.mjs test/pty-attach-mouse-mode.test.mjs test/pty-attach-wheel.test.mjs test/pty-attach-selection-mirror.test.mjs`
Expected: 全部 PASS，无 `Unterminated string`。

- [ ] **Step 5: Commit**

```bash
git add test-support/pty-attach-frame-overflow-scenario.ts test-support/pty-attach-mouse-mode-scenario.ts test-support/pty-attach-wheel-scenario.ts test-support/pty-attach-selection-mirror-scenario.ts test-support/attach-idle-socket-driver.ts test-support/attach-idle-candidate-open-harness.mjs
git commit -m "fix(test): drain stdout for the six console.log harness exits (issue #273)"
```

---

### Task 3: Pin exit codes and the trailing newline (A3, A4, A5)

**Files:**
- Modify: `test/attach-frame-witness.integration.test.mjs`（成功用例约 448 行、hard-invalid 用例约 815 行）
- Modify: `test/scenario-stdout-flush.test.mjs`（文件末尾新增两路 smoke）
- Modify: `test/pty-attach-frame-overflow.test.mjs:18-22`
- Modify: `test/pty-attach-mouse-mode.test.mjs:18-22`
- Modify: `test/pty-attach-wheel.test.mjs:19-23`
- Modify: `test/pty-attach-selection-mirror.test.mjs:18-22`

**Interfaces:**
- Consumes: 六个夹具的 stdout/退出码（Task 2 的产物）。
- Produces: 无新导出；只加断言。

- [ ] **Step 1: Add the driver success-path assertions**

在 `test/attach-frame-witness.integration.test.mjs` 的「the proven frame settles the attach」用例，
`spawnSync` 之后、现有 `attaching` 断言之前加：

```js
assert.equal(driver.status, 0, `the settled driver must exit 0; stderr:\n${(driver.stderr ?? "").slice(-300)}`);
assert.ok(driver.stdout.endsWith("\n"), "the result channel keeps console.log's trailing newline");
```

- [ ] **Step 2: Add the driver failure-path assertions**

在 hard-invalid 用例的 `assert.equal(exited, true, ...)` 之后加：

```js
assert.equal(driver.exitCode, 1, "an unsettled driver must exit 1, not a constant 0");
assert.ok(driverOut.endsWith("\n"), "the failure path also keeps console.log's trailing newline");
```

- [ ] **Step 3: Add the orphan-harness smoke**

在 `test/scenario-stdout-flush.test.mjs` 末尾加：

```js
const CANDIDATE_OPEN_HARNESS = fileURLToPath(new URL("../test-support/attach-idle-candidate-open-harness.mjs", import.meta.url));

const runCandidateOpenHarness = (env) => spawnSync(
	process.execPath,
	["--experimental-transform-types", CANDIDATE_OPEN_HARNESS],
	{ encoding: "utf8", timeout: 5000, env: { ...process.env, ...env } },
);

test("stdout-flush: the orphan candidate-open harness prints one JSON line and keeps its own exit code", () => {
	const settled = runCandidateOpenHarness({});
	assert.equal(settled.status, 0, `default run must exit 0; stderr:\n${settled.stderr}`);
	assert.ok(settled.stdout.endsWith("\n"), "the result channel keeps console.log's trailing newline");
	const settledResult = JSON.parse(settled.stdout.trim());
	assert.notEqual(settledResult.settledMs, null, "the default run settles");

	const timedOut = runCandidateOpenHarness({ HARNESS_TIMEOUT_MS: "0" });
	assert.equal(timedOut.status, 1, `a zero timeout must exit 1; stderr:\n${timedOut.stderr}`);
	assert.ok(timedOut.stdout.endsWith("\n"), "the failure path also keeps the trailing newline");
	const timedOutResult = JSON.parse(timedOut.stdout.trim());
	assert.equal(timedOutResult.settledMs, null, "a zero timeout never settles");
});
```

（`spawnSync`、`fileURLToPath` 已在该文件顶部导入，无需新增 import。）

- [ ] **Step 4: Add the four consumer newline assertions**

四个文件都在 `const out = execFileSync(...)` 之后、`JSON.parse` 之前加同一行：

```js
assert.ok(out.endsWith("\n"), "the result channel keeps console.log's trailing newline");
```

- [ ] **Step 5: Run the touched suites**

Run: `node --test test/scenario-stdout-flush.test.mjs test/attach-frame-witness.integration.test.mjs test/pty-attach-frame-overflow.test.mjs test/pty-attach-mouse-mode.test.mjs test/pty-attach-wheel.test.mjs test/pty-attach-selection-mirror.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add test/attach-frame-witness.integration.test.mjs test/scenario-stdout-flush.test.mjs test/pty-attach-frame-overflow.test.mjs test/pty-attach-mouse-mode.test.mjs test/pty-attach-wheel.test.mjs test/pty-attach-selection-mirror.test.mjs
git commit -m "test: pin harness exit codes and trailing newline (issue #273)"
```

---

### Task 4: `resolveBaselineRepo` for blank `FORMAL_BASELINE_REPO` (A7)

**Files:**
- Modify: `test-support/formal-measurement/formal-plan.mjs`（新增导出，`node:path` 导入补 `resolve`）
- Modify: `test-support/formal-measurement/formal-runner.mjs:20-22`
- Test: `test/formal-runner-plan.test.mjs`

**Interfaces:**
- Produces: `resolveBaselineRepo(envValue, repo) => string` —— 不直接读 `process.env`/`process.cwd`；
  `undefined` / 空串 / 纯空白回落 `<repo>/../issue-222-attach-baseline`；非空值走 `resolve(envValue)`。
- Consumes: 无。

- [ ] **Step 1: Write the failing test**

`test/formal-runner-plan.test.mjs` 顶部 import 改为：

```js
import { resolve } from "node:path";
import { buildFormalPlan, classifyTrial, FORMAL_TOTAL, WARMUP_TOTAL, expectedPath, resolveBaselineRepo } from "../test-support/formal-measurement/formal-plan.mjs";
```

文件末尾加：

```js
test("FORMAL_BASELINE_REPO: unset, empty and blank resolve to the default baseline", () => {
	const repo = "/repo/candidate";
	assert.equal(resolveBaselineRepo(undefined, repo), "/repo/issue-222-attach-baseline");
	assert.equal(resolveBaselineRepo("", repo), "/repo/issue-222-attach-baseline");
	assert.equal(resolveBaselineRepo("   ", repo), "/repo/issue-222-attach-baseline");
	assert.equal(resolveBaselineRepo("/baseline/abs", repo), "/baseline/abs");
	assert.equal(resolveBaselineRepo("sibling", repo), resolve("sibling"), "relative values keep the path.resolve cwd semantics");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/formal-runner-plan.test.mjs`
Expected: FAIL —— `resolveBaselineRepo is not a function`（或 import 报 undefined）。

- [ ] **Step 3: Implement the helper and wire the runner**

`formal-plan.mjs` 的 `node:path` 导入改为 `import { basename, join, resolve } from "node:path";`，并加：

```js
// An empty or whitespace-only FORMAL_BASELINE_REPO is an unset variable, not
// the process cwd: resolve("") would silently re-root baseline hashing at the
// candidate repo.
export function resolveBaselineRepo(envValue, repo) {
	return typeof envValue === "string" && envValue.trim() !== ""
		? resolve(envValue)
		: resolve(repo, "../issue-222-attach-baseline");
}
```

`formal-runner.mjs:20-22` 整段替换为：

```js
const baselineRepo = resolveBaselineRepo(process.env.FORMAL_BASELINE_REPO, repo);
```

并在其导入区加入 `resolveBaselineRepo`（与现有 `formal-plan.mjs` 导入合并）：

```js
import { buildFormalPlan, buildReplacementPlan, classifyTrial, resolveBaselineRepo } from "./formal-plan.mjs";
```

- [ ] **Step 4: Run the test — green, and the existing dry-run integration stays green**

Run: `node --test test/formal-runner-plan.test.mjs test/scenario-stdout-flush.test.mjs`
Expected: 全部 PASS（后者含真实 dry-run，证明非空值分支未被改坏）。

- [ ] **Step 5: Commit**

```bash
git add test-support/formal-measurement/formal-plan.mjs test-support/formal-measurement/formal-runner.mjs test/formal-runner-plan.test.mjs
git commit -m "fix(test): treat a blank FORMAL_BASELINE_REPO as unset (issue #273)"
```

---

### Task 5: Full gate (A8) and acceptance reconciliation

**Files:**
- Modify: 无（只在失败时回到对应 task）

**Interfaces:**
- Consumes: Task 1–4 的全部产物。
- Produces: `npm run verify` 的完整结果，作为 A8 证据。

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`
Expected: typecheck + perf gate + tests + coverage（lines 85 / funcs 80 / branches 70）+ `pack:dry` 全部通过，exit 0。

- [ ] **Step 2: Reconcile the acceptance matrix**

逐条记录实际命令与结果：

| ID | 证据 |
|---|---|
| A1 | `node --test test/scenario-stdout-flush.test.mjs`（样本） |
| A2 | 同文件全目录扫描 `offenders === []`；Task 1 Step 4 的六处红 |
| A3 | `node --test test/attach-frame-witness.integration.test.mjs` |
| A4 | 同 A1 文件的两路 smoke |
| A5 | 四个场景测试 + 各自 `endsWith("\n")` 断言 |
| A6 | 同 A1 文件的 256 KiB probe |
| A7 | `node --test test/formal-runner-plan.test.mjs` |
| A8 | `npm run verify` 输出 |

- [ ] **Step 3: Commit any plan/spec corrections found during implementation**

```bash
git add docs/superpowers/plans/2026-11-09-issue-273-harness-console-log-exit.md
git commit -m "docs: correct the issue #273 plan after implementation"
```

A9（PR 上 `Test (Node 22)` / `Test (Node 24)`）在步 9 完成后记录，不在本 plan 的本地步骤内。
