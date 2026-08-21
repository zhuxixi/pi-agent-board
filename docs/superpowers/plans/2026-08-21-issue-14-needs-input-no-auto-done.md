# Issue #14: Needs-input While Running + No Auto-Done Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 运行中（alive）session 的文本提问归类 `needs_input`；auto-state 永不自动归类 `completed`（开关可回退）。

**Architecture:** 纯函数级改动。`events.mjs` `reduceEvent()` 的 `message_end` 分支按 `detectNeedsInput` 结果设 semanticState；`auto-state.mjs` 内新增 `autoStateDoneDisabled(env)` 开关（`AGENT_BOARD_AUTO_STATE_NO_DONE`，默认禁用自动 done），启发式与模型分类统一降级为 `in_progress`；`applyAutoState*` 增加 completed guard 保护手动标记。

**Tech Stack:** Node.js (>=20), node:test, plain .mjs modules, JSDoc typedefs（无 TypeScript 构建）。

## Global Constraints

- 所有测试用 `node --test`，断言库 `node:assert/strict`（与现有 test/*.test.mjs 一致）。
- 不改 UI 显示/分组/排序；不改 detached 回复路径；不改 alive guard。
- 环境变量名：`AGENT_BOARD_AUTO_STATE_NO_DONE`（默认未设置 = 禁用自动 done；`0`/`false`/`off`/`no` = 恢复自动 done）。
- 复用 `isOff()` 语义（`/^(0|false|off|no)$/i`）。
- 所有改动在 worktree `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-14-needs-input-no-auto-done` 内，禁止碰 main checkout。

---

### Task 1: 运行中文本提问 → needs_input（events.mjs）

**Files:**
- Modify: `src/core/events.mjs`（`reduceEvent()` 的 `message_end` 分支，约 L121-139）
- Test: `test/events.test.mjs`（新增 2 用例）

**Interfaces:**
- Consumes: `detectNeedsInput(text)` → `{ needsInput: boolean, question: string|null }`（`src/core/heuristics.mjs` 已有，勿改）。
- Produces: 运行中 `status.semanticState` 可为 `"needs_input"`；`projectViewState().needsInput` 联动（已有逻辑，勿改）。

- [ ] **Step 1: 写失败测试（在 `test("message_end assistant updates preview and detects question"` 用例之后追加）**

```js
test("message_end text ending with a question moves alive run to needs_input", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	reduceEvent(
		s,
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Should I continue with option A?" }] } },
		2000,
	);
	assert.equal(s.semanticState, "needs_input");
	assert.match(s.question, /option A/);
	assert.equal(projectViewState(s, 2100).needsInput, true);
});

test("alive run returns to working after a following message without a question", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	reduceEvent(
		s,
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Which target should I use?" }] } },
		2000,
	);
	assert.equal(s.semanticState, "needs_input");
	reduceEvent(
		s,
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Proceeding with the default target." }] } },
		2500,
	);
	assert.equal(s.semanticState, "working");
	assert.equal(s.question, null);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-14-needs-input-no-auto-done && node --test test/events.test.mjs`
Expected: 2 个新用例 FAIL（`assert.equal(s.semanticState, "needs_input")` 实际为 `"working"`）。

- [ ] **Step 3: 最小实现（`src/core/events.mjs` `message_end` 分支）**

将现有：

```js
			if (msg?.role === "assistant") {
				status.turns += 1;
				if (msg.model && !status.model) status.model = msg.model;
				if (msg.stopReason) status.stopReason = msg.stopReason;
				if (msg.errorMessage) status.error = msg.errorMessage;
				else if (msg.stopReason === "stop") status.error = null;
				const text = assistantText(msg);
				if (text) {
					// Store the full latest text (truncated) so peek shows meaningful output;
					// deriveSummary() condenses it to a first sentence for the row.
					status.latestAssistantPreview = truncate(text, PREVIEW_MAX);
					const nb = detectNeedsInput(text);
					status.question = nb.question;
				}
				status.semanticState = "working";
				preservePendingQuestion(status);
```

改为：

```js
			if (msg?.role === "assistant") {
				status.turns += 1;
				if (msg.model && !status.model) status.model = msg.model;
				if (msg.stopReason) status.stopReason = msg.stopReason;
				if (msg.errorMessage) status.error = msg.errorMessage;
				else if (msg.stopReason === "stop") status.error = null;
				const text = assistantText(msg);
				let nb = { needsInput: false, question: null };
				if (text) {
					// Store the full latest text (truncated) so peek shows meaningful output;
					// deriveSummary() condenses it to a first sentence for the row.
					status.latestAssistantPreview = truncate(text, PREVIEW_MAX);
					nb = detectNeedsInput(text);
					status.question = nb.question;
				}
				status.semanticState = nb.needsInput ? "needs_input" : "working";
				preservePendingQuestion(status);
```

注意：`preservePendingQuestion(status)` 保持在最后一行，保证 pending question 优先语义不变。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/events.test.mjs`
Expected: 全部 PASS（含既有 "interactive ask_questions waits for input" 与 "interactive questions remain visible across parallel activity until each call ends" 回归绿）。

- [ ] **Step 5: Commit**

```bash
cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-14-needs-input-no-auto-done
git add test/events.test.mjs src/core/events.mjs
git commit -m "feat: classify running text questions as needs_input (issue #14)"
```

---

### Task 2: heuristicAutoState 永不自动 done + env 开关（auto-state.mjs）

**Files:**
- Modify: `src/core/auto-state.mjs`（新增 `autoStateDoneDisabled()`；改 `heuristicAutoState()`）
- Test: `test/auto-state.test.mjs`（更新 1 断言 + 新增 1 用例）

**Interfaces:**
- Produces: `export function autoStateDoneDisabled(env = process.env) → boolean`（默认 true；`AGENT_BOARD_AUTO_STATE_NO_DONE` 为 `0/false/off/no` 时返回 false）。
- `heuristicAutoState(latestAssistantText, opts)` 的 `opts` 新增可选 `env`（默认 `process.env`）。既有调用点不传 env，行为自动跟随进程环境。

- [ ] **Step 1: 写失败测试**

在 `test/auto-state.test.mjs` 顶部 import 行追加 `autoStateDoneDisabled`：

```js
import { applyAutoStateToStatus, autoStateDoneDisabled, autoStateFromModelOrHeuristic, heuristicAutoState, parseAutoStateModelOutput } from "../src/core/auto-state.mjs";
```

将既有断言：

```js
test("heuristicAutoState detects done and in-progress turns", () => {
	assert.equal(heuristicAutoState("Done. Fixed the bug and tests pass.").kind, "done");
	assert.equal(heuristicAutoState("I updated one file. Next step is to add tests.").kind, "in_progress");
});
```

改为（默认不再 done）：

```js
test("heuristicAutoState detects done and in-progress turns", () => {
	assert.equal(heuristicAutoState("Done. Fixed the bug and tests pass.").kind, "in_progress");
	assert.equal(heuristicAutoState("I updated one file. Next step is to add tests.").kind, "in_progress");
});

test("heuristicAutoState restores done classification when auto-done flag is off", () => {
	assert.equal(
		heuristicAutoState("Done. Fixed the bug and tests pass.", { env: { AGENT_BOARD_AUTO_STATE_NO_DONE: "0" } }).kind,
		"done",
	);
	assert.equal(autoStateDoneDisabled({}), true);
	assert.equal(autoStateDoneDisabled({ AGENT_BOARD_AUTO_STATE_NO_DONE: "0" }), false);
	assert.equal(autoStateDoneDisabled({ AGENT_BOARD_AUTO_STATE_NO_DONE: "off" }), false);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --test test/auto-state.test.mjs`
Expected: `heuristicAutoState detects done and in-progress turns` FAIL（实际 `"done"` 不等于 `"in_progress"`）；新增用例 FAIL（`autoStateDoneDisabled` 未导出）。

- [ ] **Step 3: 最小实现（`src/core/auto-state.mjs`）**

在 `autoStateModel()` 函数之后、`isOff()` 之前插入：

```js
/**
 * Whether automatic `done` classification is disabled.
 * Default (env unset): disabled — completed is only ever set by the user.
 * Set AGENT_BOARD_AUTO_STATE_NO_DONE to 0/false/off/no to restore auto-done.
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 */
export function autoStateDoneDisabled(env = process.env) {
	const raw = env.AGENT_BOARD_AUTO_STATE_NO_DONE;
	if (typeof raw !== "string" || !raw.trim()) return true;
	return !isOff(raw);
}
```

`heuristicAutoState` 的 done 分支（现有代码）：

```js
	const lower = text.toLowerCase();
	const pending = hasPendingSignal(lower);
	const done = hasDoneSignal(lower);
	if (done && !pending) {
		return makeClassification("done", {
			source: "heuristic",
			confidence: hasStrongDoneSignal(lower) ? "high" : "medium",
			reason: "Assistant reported the work is complete",
			now: opts.now,
			lastAgentActivityAt: opts.lastAgentActivityAt ?? null,
			latestAssistantText: text,
		});
	}
```

改为：

```js
	const lower = text.toLowerCase();
	const pending = hasPendingSignal(lower);
	const done = hasDoneSignal(lower);
	const env = opts.env ?? process.env;
	if (done && !pending && !autoStateDoneDisabled(env)) {
		return makeClassification("done", {
			source: "heuristic",
			confidence: hasStrongDoneSignal(lower) ? "high" : "medium",
			reason: "Assistant reported the work is complete",
			now: opts.now,
			lastAgentActivityAt: opts.lastAgentActivityAt ?? null,
			latestAssistantText: text,
		});
	}
	if (done && !pending) {
		// Auto-done disabled: completion signals stay out of the completed bucket;
		// the user marks completed manually from the dashboard.
		return makeClassification("in_progress", {
			source: "heuristic",
			confidence: hasStrongDoneSignal(lower) ? "medium" : "low",
			reason: "Assistant reported completion but auto-done is disabled",
			now: opts.now,
			lastAgentActivityAt: opts.lastAgentActivityAt ?? null,
			latestAssistantText: text,
		});
	}
```

同时更新 `heuristicAutoState` 的 JSDoc opts 行：`@param {{ now?: number, lastAgentActivityAt?: number|null, env?: NodeJS.ProcessEnv|Record<string,string|undefined> }} [opts]`。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/auto-state.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add test/auto-state.test.mjs src/core/auto-state.mjs
git commit -m "feat: disable auto-done in heuristic classifier by default (issue #14)"
```

---

### Task 3: 模型输出 done 降级 + prompt 两态化（auto-state.mjs）

**Files:**
- Modify: `src/core/auto-state.mjs`（`parseAutoStateModelOutput()`、`buildAutoStatePrompt()`）
- Test: `test/auto-state.test.mjs`（更新 1 断言 + 新增 1 用例）

**Interfaces:**
- `parseAutoStateModelOutput(raw, opts)` 的 `opts` 新增可选 `env`；`buildAutoStatePrompt(latestAssistantText, env = process.env)` 新增第二参数（既有调用点不传，兼容）。
- 调用点（`runner/job-runner.mjs`、`runner/state-runner.mjs`）无需改动。

- [ ] **Step 1: 写失败测试**

将既有断言：

```js
test("parseAutoStateModelOutput normalizes model JSON", () => {
	const c = parseAutoStateModelOutput('{"state":"done","confidence":"high","reason":"tests passed","question":null}', {
		latestAssistantText: "Done. Tests passed.",
		lastAgentActivityAt: 42,
	});
	assert.equal(c.kind, "done");
	assert.equal(c.semanticState, "completed");
```

改为：

```js
test("parseAutoStateModelOutput normalizes model JSON", () => {
	const c = parseAutoStateModelOutput('{"state":"done","confidence":"high","reason":"tests passed","question":null}', {
		latestAssistantText: "Done. Tests passed.",
		lastAgentActivityAt: 42,
	});
	assert.equal(c.kind, "in_progress");
	assert.equal(c.semanticState, "idle");
	assert.match(c.reason, /auto-done is disabled/i);
```

（其余 `source/confidence/lastAgentActivityAt` 断言保留。）

在文件末尾追加：

```js
test("parseAutoStateModelOutput keeps done when auto-done flag is off", () => {
	const c = parseAutoStateModelOutput('{"state":"done","confidence":"high","reason":"tests passed","question":null}', {
		latestAssistantText: "Done. Tests passed.",
		lastAgentActivityAt: 42,
		env: { AGENT_BOARD_AUTO_STATE_NO_DONE: "0" },
	});
	assert.equal(c.kind, "done");
	assert.equal(c.semanticState, "completed");
});

test("buildAutoStatePrompt omits done option by default and restores it when flag off", () => {
	assert.ok(!/^- done:/m.test(buildAutoStatePrompt("Fix the bug.")));
	assert.ok(/^- done:/m.test(buildAutoStatePrompt("Fix the bug.", { AGENT_BOARD_AUTO_STATE_NO_DONE: "0" })));
});
```

（import 行追加 `buildAutoStatePrompt`。）

- [ ] **Step 2: 运行测试验证失败**

Run: `node --test test/auto-state.test.mjs`
Expected: 3 个用例 FAIL（kind 为 `"done"` 而非 `"in_progress"`；prompt 仍含 done 行）。

- [ ] **Step 3: 最小实现**

`buildAutoStatePrompt` 现有实现：

```js
export function buildAutoStatePrompt(latestAssistantText) {
	const text = truncate(String(latestAssistantText || "").trim(), 6000);
	return `Classify the LAST assistant response for a coding-agent dashboard.\n\nChoose exactly one state:\n- needs_input: the assistant asks the user for a decision, clarification, approval, credentials, or is blocked waiting for the user.\n- in_progress: work is partial, next steps remain, verification is pending/failed, or the assistant says it will continue later.\n- done: the requested work is complete, final answer given, no user input required.\n\nReturn ONLY minified JSON with this shape:\n{"state":"needs_input|in_progress|done","confidence":"high|medium|low","reason":"short reason <=18 words","question":"user-facing question or null"}\n\nLast assistant response:\n${text}`;
}
```

改为：

```js
export function buildAutoStatePrompt(latestAssistantText, env = process.env) {
	const text = truncate(String(latestAssistantText || "").trim(), 6000);
	const doneLine = autoStateDoneDisabled(env)
		? ""
		: "- done: the requested work is complete, final answer given, no user input required.\n";
	const doneNote = autoStateDoneDisabled(env)
		? "The user marks completed manually in the dashboard, so completion signals (done/completed/finished) must be classified as in_progress.\n"
		: "";
	const states = autoStateDoneDisabled(env) ? "needs_input|in_progress" : "needs_input|in_progress|done";
	return `Classify the LAST assistant response for a coding-agent dashboard.\n\nChoose exactly one state:\n- needs_input: the assistant asks the user for a decision, clarification, approval, credentials, or is blocked waiting for the user.\n- in_progress: work is partial, next steps remain, verification is pending/failed, or the assistant says it will continue later.\n${doneLine}${doneNote}\nReturn ONLY minified JSON with this shape:\n{"state":"${states}","confidence":"high|medium|low","reason":"short reason <=18 words","question":"user-facing question or null"}\n\nLast assistant response:\n${text}`;
}
```

`parseAutoStateModelOutput` 现有代码：

```js
	const obj = extractJsonObject(raw);
	if (!obj) return null;
	const kind = normalizeKind(obj.state ?? obj.kind ?? obj.status);
	if (!kind) return null;
```

改为：

```js
	const obj = extractJsonObject(raw);
	if (!obj) return null;
	let kind = normalizeKind(obj.state ?? obj.kind ?? obj.status);
	if (!kind) return null;
	if (kind === "done" && autoStateDoneDisabled(opts.env ?? process.env)) {
		kind = "in_progress";
	}
```

并在 `makeClassification(kind, {...})` 的调用中把 reason 兜底交给 `defaultReason(kind)`（已有逻辑），另在 opts 里透传降级提示：把

```js
	return makeClassification(kind, {
		source: "model",
		confidence,
		reason: cleanReason(obj.reason) || defaultReason(kind),
```

改为：

```js
	return makeClassification(kind, {
		source: "model",
		confidence,
		reason: kind === "in_progress" && autoStateDoneDisabled(opts.env ?? process.env)
			? "Model reported done but auto-done is disabled"
			: cleanReason(obj.reason) || defaultReason(kind),
```

并更新 `parseAutoStateModelOutput` 的 JSDoc：`opts` 增加 `env?: NodeJS.ProcessEnv|Record<string,string|undefined>`。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/auto-state.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add test/auto-state.test.mjs src/core/auto-state.mjs
git commit -m "feat: downgrade model done output and two-state prompt when auto-done disabled (issue #14)"
```

---

### Task 4: applyAutoState* completed guard（保护手动标记）

**Files:**
- Modify: `src/core/auto-state.mjs`（`applyAutoStateToStatus()`、`applyAutoStateToViewState()`）
- Test: `test/auto-state.test.mjs`（新增 1 用例）

**Interfaces:**
- 不变更签名。行为：`semanticState === "completed"` 时直接 `return false`（与 failed/stopped 同列）。

- [ ] **Step 1: 写失败测试**

追加：

```js
test("applyAutoStateToStatus never overwrites a manually completed row", () => {
	const status = {
		processState: "exited",
		semanticState: "completed",
		currentTool: null,
		question: null,
		error: null,
		latestAssistantPreview: "Done. Fixed the bug and tests pass.",
		summary: "Done.",
	};
	const changed = applyAutoStateToStatus(status, heuristicAutoState(status.latestAssistantPreview), 100);
	assert.equal(changed, false);
	assert.equal(status.semanticState, "completed");
	assert.equal(status.autoState, undefined);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --test test/auto-state.test.mjs`
Expected: 新用例 FAIL（`changed` 为 `true`，semanticState 被改为 `"idle"`）。

- [ ] **Step 3: 最小实现**

`applyAutoStateToStatus` 的 guard 行：

```js
	if (!classification || status.processState === "alive") return false;
	if (status.semanticState === "failed" || status.semanticState === "stopped") return false;
```

改为：

```js
	if (!classification || status.processState === "alive") return false;
	if (status.semanticState === "failed" || status.semanticState === "stopped" || status.semanticState === "completed") return false;
```

`applyAutoStateToViewState` 的 guard 行做同样修改（`failed`/`stopped` 之后追加 `|| state.semanticState === "completed"`）。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test test/auto-state.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add test/auto-state.test.mjs src/core/auto-state.mjs
git commit -m "fix: never overwrite manual completed state in auto-state (issue #14)"
```

---

### Task 5: 集成测试同步 + 全量验证 + 收尾 commit

**Files:**
- Modify: `test/runner.integration.test.mjs`（L45-80、L114-126 两处 completed 断言）
- Test: 同文件新增 1 用例（默认无自动 done）

**Interfaces:**
- fake worker 由 `process.env.FAKE_PI_MODE = "completed"` 驱动；job-runner 子进程继承父进程 env，所以 `AGENT_BOARD_AUTO_STATE_NO_DONE` 在 spawn 前设置即可生效。

- [ ] **Step 1: 更新既有断言（两处）**

`test("runner auto-classifies a completed fake worker and writes durable artifacts"` 用例（L45-80）的 env 设置块：

```js
	const root = mkdtempSync(join(tmpdir(), "agentview-run-"));
	const env = { ...process.env };
	process.env.FAKE_PI_MODE = "completed";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
```

改为：

```js
	const root = mkdtempSync(join(tmpdir(), "agentview-run-"));
	const env = { ...process.env };
	process.env.FAKE_PI_MODE = "completed";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	process.env.AGENT_BOARD_AUTO_STATE_NO_DONE = "0";
```

其 finally 块在 `delete process.env.AGENT_BOARD_SUMMARY_MODEL;` 之后追加：

```js
		delete process.env.AGENT_BOARD_AUTO_STATE_NO_DONE;
```

`test("runner protects dash-prefixed prompts passed via argv"` 用例（L114-126）同样：`process.env.AGENT_BOARD_SUMMARY_MODEL = "off";` 之后追加 `process.env.AGENT_BOARD_AUTO_STATE_NO_DONE = "0";`，finally 块同步 delete。

- [ ] **Step 2: 新增默认行为用例（在 "runner protects dash-prefixed prompts" 用例之后追加）**

```js
test("runner keeps a completed fake worker idle when auto-done is disabled", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-nodone-"));
	process.env.FAKE_PI_MODE = "completed";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	delete process.env.AGENT_BOARD_AUTO_STATE_NO_DONE;
	try {
		const meta = createView(root, { id: "view_1", name: "fix", cwd: root });
		const config = makeConfig(root, "view_1", "run_1", meta.sessionFile, root, "fix the bug");
		const st = readState(root, "view_1");
		st.currentRunId = "run_1";
		const { writeState } = await import("../src/core/store.mjs");
		writeState(root, st);
		const { pid } = launchRun(root, config, { runnerScript: RUNNER });
		assert.ok(pid && pid > 0, "runner spawned");
		const status = await waitFor(() => {
			const s = readStatus(root, "view_1", "run_1");
			return s && s.endedAt ? s : null;
		});
		assert.ok(status, "status reached terminal state");
		assert.equal(status.semanticState, "idle");
		assert.equal(status.processState, "exited");
		assert.equal(status.autoState?.kind, "in_progress");
	} finally {
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 3: 运行集成测试**

Run: `node --test test/runner.integration.test.mjs`
Expected: 全部 PASS。若个别用例因 pre-existing flaky（并行全量偶发）失败，单文件重跑确认。

- [ ] **Step 4: 全量验证**

Run: `npm run verify`（= typecheck + test + pack:dry）
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add test/runner.integration.test.mjs
git commit -m "test: keep auto-done off by default in runner integration (issue #14)"
```

---

## Self-Review（对照 spec）

1. **Spec coverage**：变更 1（events.mjs）→ Task 1；变更 2 启发式 → Task 2；模型降级+prompt → Task 3；completed guard → Task 4；测试同步+全量验证 → Task 5；开关回退 → Task 2/3 测试均有 env-off 断言。✅
2. **Placeholder scan**：已把 Task 5 的省略注释落实为具体代码（Step 1/2 完整代码块）。其余任务无 TBD/TODO/省略。✅
3. **Type consistency**：`autoStateDoneDisabled(env)` 在各任务签名一致；`heuristicAutoState` opts.env、`parseAutoStateModelOutput` opts.env、`buildAutoStatePrompt(text, env)` 一致。✅
