# Runner Architecture Hardening — PR #1: View State Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 detached View State Coordinator，作为 `state.json`/`status.json` 的唯一逻辑写者，根治 #46 类 stale-write 覆盖（spec D3）。

**Architecture:** 新增一个 board-root 级 detached 协调器进程（复用 pty-runner 的 detached spawn + JSONL socket + issue #70 的 token-fenced lease 模式），所有语义状态 mutation 变成带 `commandId`/`runId`/`expectedRevision` 的命令，经 durable journal 串行应用后物化。人工完成建立 manual fence，迟到的 auto-state/finalization 结果被拒绝。

**Tech Stack:** Node.js (ESM, plain `.mjs` runners), node:net JSONL socket, 现有 `src/core/locks.mjs`（owned lease）、`src/core/atomic.mjs`（原子写）、`src/core/store.mjs`。

**Spec:** `docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md`（D3 节 + 验收 A7/A7b/A8 + 根治条件 1/2/5）

## Scope：本 plan 只覆盖 PR #1

本 spec 是分阶段 epic。本 plan 实现 **Phase 1（现有行为回归锁定）+ Phase 2a（Coordinator 基础设施 + 三类优先 mutation：markCompleted / auto-state / run finalization）**。后续 PR（不在本 plan）：

- PR #2（Phase 2b）：迁移剩余 writeState/writeStatus 调用点（job-runner 热路径、service 其余站点），白名单清零，A7 完全闭合。
- PR #3+（Phase 3–6）：canonical terminal model、attach snapshot/subscribe、控制命令生命周期、删除 `childInputLooksEmpty()`。

**为什么三类优先 mutation 足以闭合 #46**：`markCompleted` 在 run 活跃时被 `isAgentBusy` 拒绝（该守卫保留并移入 coordinator），所以竞争只发生在 run 结束后的异步写者（job-runner post-exit pass、state-runner 分类器）与手动完成之间。迁移这三类即关闭 #46 窗口；during-run 热路径（250ms 节流写）不与 markCompleted 竞争，留到 PR #2。

## Global Constraints

- 所有新 runner 进程必须是 plain ESM `.mjs`，不得依赖 Pi 的 jiti loader（参照 `runner/job-runner.mjs` 头注释）。
- Commit message 用英文，conventional commits 格式。
- 测试用 `node --test`；隔离环境必须同时设 `AGENT_BOARD_ROOT` 和 `PI_CODING_AGENT_DIR`（paths.mjs defaultRoot 不随后者，KB 已知坑）。
- 每个 task 结束提交一次；`git add <file>` 按文件 stage，禁止 `git add -A`。
- 所有文件操作使用 worktree 绝对路径，git 操作使用 `git -C $WT`。
- `$WT = /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-91-harden-runner-architecture`
- 可测性硬约束（spec §9）：决策函数必须是纯函数，不碰 fs/socket；journal/socket/materialize 副作用全部集中在 coordinator 进程壳内。

## Acceptance 映射（spec §7）

| Task | 验收 ID | 说明 |
|---|---|---|
| Task 1 | U2 回归基线（现状锁定） | 锁定 PR #1 之前的行为，供后续阶段对比 |
| Task 2 | A8（决策层） | stale rejection / manual fence 纯函数 |
| Task 3 | A7b（持久化层） | journal append/replay/GC |
| Task 4 | A7b（failover） | coordinator 进程、lease、重启重放 |
| Task 5 | A7b enabler | client ensure/spawn/send |
| Task 6 | A8（markCompleted 路径） | service.completeView → command |
| Task 7 | A8（auto-state 路径） | state-runner + job-runner heuristic → command |
| Task 8 | A8（finalization 路径） | job-runner finalize → command |
| Task 9 | A7（含白名单） | 架构边界静态测试 |
| Task 10 | A7 revision 子项 | materializedRevision + legacy 接管 |

A1–A6、A9、A11、U1/U3 属于后续阶段，本 plan 无对应 task（epic 拆分，已在 spec §8 声明）。

---

### Task 1: 回归基线锁定（Phase 1）

**Files:**
- Test: `test/control-baseline.test.mjs`（新建）

**Interfaces:**
- Consumes: 现有 `runner/pty-runner.mjs` 的 JSONL socket 协议、`test/pty-runner.integration.test.mjs` 的 `waitFor`/`send` 测试夹具模式。
- Produces: 基线测试文件，锁定「resize 无 ack」「无 requestId 的 input 无 ack」「hello 含 editorEmpty」三个现状行为。

- [ ] **Step 1: 跑现有四组基线套件并记录结果**

```bash
cd $WT && node --test test/pty-attach-detach-gate.test.mjs test/editor-state-reporter.test.mjs test/host-input.test.mjs test/host-owner-store.test.mjs 2>&1 | tail -20
```

Expected: 全部 PASS。若有失败，停下来修基线，不要继续。

- [ ] **Step 2: 写基线测试——锁定 D4 之前的 fire-and-forget 现状**

新建 `test/control-baseline.test.mjs`，复用 `test/pty-runner.integration.test.mjs` 的 host 启动夹具模式（参考该文件 505-570 行的 editor_state 路由测试）：

```js
import test from "node:test";
import assert from "node:assert/strict";
// 夹具：createView + 启动 fake-child pty-runner（参照 test/pty-runner.integration.test.mjs 的 beforeEach 模式）

test("baseline: resize command receives no ack (pre-D4 fire-and-forget)", async (t) => {
	// 连接 control socket，发 {"type":"resize","cols":100,"rows":30}
	// 收集 500ms 内所有下行消息
	// assert: 不存在 {type:"ack"} 或 {type:"resize_ack"} 消息
});

test("baseline: UI keystroke input without requestId receives no input_ack", async (t) => {
	// 发 {"type":"input","data":"x"}（无 requestId）
	// assert: 500ms 内无 input_ack
});

test("baseline: hello reply carries editorEmpty field", async (t) => {
	// 发 {"type":"hello","clientId":"t","wantOutput":true}
	// assert: 收到 hello 且 "editorEmpty" in msg
});
```

- [ ] **Step 3: 运行新基线测试确认 PASS**

```bash
cd $WT && node --test test/control-baseline.test.mjs
```

Expected: 3/3 PASS（它们锁定的是现状，不是新行为）。

- [ ] **Step 4: Commit**

```bash
git -C $WT add test/control-baseline.test.mjs
git -C $WT commit -m "test: lock pre-hardening control-socket baseline behavior (issue #91)"
```

---

### Task 2: 命令决策纯函数模块 `src/core/state-commands.mjs`

**Files:**
- Create: `src/core/state-commands.mjs`
- Test: `test/state-commands.test.mjs`

**Interfaces:**
- Consumes: `isManualCompletion` from `src/core/auto-state.mjs`；`ViewState`/`RunStatus` typedefs from `src/core/types.mjs`。
- Produces（后续 task 依赖的精确签名）:
  - `STATE_COMMAND_KINDS` — `["mark_completed","auto_state_classified","run_finalized"]`（PR #1 范围）
  - `COMMAND_SOURCES` — `["dashboard-user","service","job-runner","state-runner"]`
  - `validateCommand(raw)` → `{ ok: true, command } | { ok: false, error }`
  - `decideStateTransition(command, currentState, currentStatus)` → `{ action: "apply", mutate: { state?, status? }, reason } | { action: "reject", reason }`（纯函数，返回的 mutate 是字段补丁对象，不做 I/O）
  - reject reasons: `"stale_run" | "manual_fence" | "revision_conflict" | "busy" | "unknown_view"`

- [ ] **Step 1: 写失败测试**

```js
// test/state-commands.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { validateCommand, decideStateTransition } from "../src/core/state-commands.mjs";

const baseCmd = {
	type: "state_command", commandId: "cmd-1", viewId: "v1", runId: "r1",
	source: "state-runner", expectedRevision: null, kind: "auto_state_classified",
	payload: { classification: { version: 1, kind: "done", semanticState: "completed",
		confidence: "high", source: "model", reason: "x", question: null,
		classifiedAt: 1, lastAgentActivityAt: null, textHash: "h" } },
};
const manualCompletedState = { viewId: "v1", currentRunId: "r1", semanticState: "completed",
	processState: "exited", autoState: null, updatedAt: 1 };

test("validateCommand rejects missing commandId", () => {
	assert.equal(validateCommand({ ...baseCmd, commandId: "" }).ok, false);
});

test("auto_state_classified rejected when manual fence active", () => {
	const d = decideStateTransition(baseCmd, manualCompletedState, null);
	assert.deepEqual(d, { action: "reject", reason: "manual_fence" });
});

test("auto_state_classified rejected for stale runId", () => {
	const d = decideStateTransition(baseCmd, { ...manualCompletedState, currentRunId: "r2", semanticState: "idle", autoState: {} }, null);
	assert.equal(d.action, "reject");
	assert.equal(d.reason, "stale_run");
});

test("mark_completed rejected while agent busy", () => {
	const cmd = { ...baseCmd, source: "dashboard-user", kind: "mark_completed", payload: {} };
	const d = decideStateTransition(cmd, { ...manualCompletedState, semanticState: "working", processState: "alive" }, null);
	assert.equal(d.action, "reject");
	assert.equal(d.reason, "busy");
});

test("mark_completed applies and clears autoState (fence signal)", () => {
	const cmd = { ...baseCmd, source: "dashboard-user", kind: "mark_completed", payload: {} };
	const d = decideStateTransition(cmd, { ...manualCompletedState, semanticState: "idle", autoState: { source: "model" } }, null);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.semanticState, "completed");
	assert.equal(d.mutate.state.autoState, null);
});

test("revision_conflict when expectedRevision mismatches", () => {
	const cmd = { ...baseCmd, expectedRevision: 5 };
	const d = decideStateTransition(cmd, { ...manualCompletedState, materializedRevision: 7 }, null);
	assert.deepEqual(d, { action: "reject", reason: "revision_conflict" });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd $WT && node --test test/state-commands.test.mjs
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/core/state-commands.mjs`**

核心结构（完整实现，含 JSDoc 类型标注）：

```js
/**
 * Pure decision layer for View State Coordinator commands (issue #91, spec D3).
 * No fs/net I/O — the coordinator shell owns all side effects.
 */
import { isManualCompletion } from "./auto-state.mjs";

export const STATE_COMMAND_KINDS = Object.freeze(["mark_completed", "auto_state_classified", "run_finalized"]);
export const COMMAND_SOURCES = Object.freeze(["dashboard-user", "service", "job-runner", "state-runner"]);

/** @param {any} raw @returns {{ ok: true, command: object } | { ok: false, error: string }} */
export function validateCommand(raw) {
	if (!raw || raw.type !== "state_command") return { ok: false, error: "bad_type" };
	if (typeof raw.commandId !== "string" || !raw.commandId) return { ok: false, error: "missing_commandId" };
	if (typeof raw.viewId !== "string" || !raw.viewId) return { ok: false, error: "missing_viewId" };
	if (!STATE_COMMAND_KINDS.includes(raw.kind)) return { ok: false, error: "unknown_kind" };
	if (!COMMAND_SOURCES.includes(raw.source)) return { ok: false, error: "unknown_source" };
	if (raw.expectedRevision != null && typeof raw.expectedRevision !== "number") return { ok: false, error: "bad_expectedRevision" };
	return { ok: true, command: raw };
}

/**
 * @param {object} command @param {object|null} currentState @param {object|null} currentStatus
 * @returns {{ action: "apply", mutate: { state?: object, status?: object }, reason: string }
 *          | { action: "reject", reason: string }}
 */
export function decideStateTransition(command, currentState, currentStatus) {
	if (!currentState) return { action: "reject", reason: "unknown_view" };
	if (command.expectedRevision != null && command.expectedRevision !== (currentState.materializedRevision ?? 0)) {
		return { action: "reject", reason: "revision_conflict" };
	}
	if (command.runId && currentState.currentRunId && command.runId !== currentState.currentRunId) {
		return { action: "reject", reason: "stale_run" };
	}
	if (command.source !== "dashboard-user" && isManualCompletion(currentState)) {
		return { action: "reject", reason: "manual_fence" };
	}
	switch (command.kind) {
		case "mark_completed": {
			if (currentState.processState === "alive") return { action: "reject", reason: "busy" };
			return { action: "apply", reason: "manual_completion", mutate: {
				state: { semanticState: "completed", processState: "exited", needsInput: false,
					hasError: false, question: null, pendingQuestions: [], error: null, autoState: null },
				status: { autoState: null },
			} };
		}
		case "auto_state_classified": {
			// 复用 applyAutoStateToViewState/applyAutoStateToStatus 的守卫（processState/semanticState/manual），
			// 在本函数内把 classification 展开为 state/status 字段补丁，summary/question 逻辑与
			// auto-state.mjs 保持一致（委托给它计算补丁，不在此复制规则）。
			// ... 实现时调用 applyAutoStateToViewState 于副本上并 diff 出补丁。
			break;
		}
		case "run_finalized": {
			// payload: { endedAt, exitCode, semanticState, summary, latestAssistantPreview, ... }
			// 仅在 currentState.processState === "alive" 且 runId 匹配时 apply；
			// 补丁写入 processState:"exited"、endedAt 相关字段与 payload 提供的终态字段。
			break;
		}
	}
	// （完整 switch 的两个 case 分支在实现时按上面注释展开，保持纯函数）
}
```

注意：`auto_state_classified` 分支**必须**复用 `applyAutoStateToViewState` / `applyAutoStateToStatus`（在 state/status 的深拷贝上调用，然后提取变化字段作为补丁），不得复制其规则——保持单一事实来源。

- [ ] **Step 4: 运行测试确认 PASS**

```bash
cd $WT && node --test test/state-commands.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/core/state-commands.mjs test/state-commands.test.mjs
git -C $WT commit -m "feat(core): pure decision layer for view-state commands (issue #91)"
```

---

### Task 3: Coordinator journal 持久化层 `src/core/coordinator-journal.mjs`

**Files:**
- Create: `src/core/coordinator-journal.mjs`
- Test: `test/coordinator-journal.test.mjs`

**Interfaces:**
- Consumes: `appendJsonl`/`readJsonl`/`atomicWriteJson` from `src/core/atomic.mjs`。
- Produces:
  - `journalPath(root)` → `<root>/state-journal.jsonl`
  - `checkpointPath(root)` → `<root>/state-journal.checkpoint.json`
  - `appendCommand(root, record, fs?)` — 追加 `{ command, result, materializedRevision, at }` 并 `fsync`（用 `openSync`/`fsyncSync`/`closeSync`，参照 `src/core/screen-log.mjs` 的 fs 注入模式）
  - `readJournal(root, fs?)` → 全部记录数组（容忍尾行损坏——参照 `readJsonl` 的 skip-corrupt 语义）
  - `findProcessedCommand(root, commandId, fs?)` → 已处理结果或 null（重启幂等：已处理 commandId 返回原结果）
  - `readCheckpoint(root, fs?)` / `writeCheckpoint(root, { materializedRevision, journalBytes }, fs?)`
  - `gcJournal(root, fs?)` — 仅当 checkpoint 写成功后，截断 journal 中 `journalBytes` 之前的内容

- [ ] **Step 1: 写失败测试**（注入内存 fake fs，参照 `test/` 中 screen-log 相关测试的 fs 注入模式；无现成模式则用 `node:fs` 真实临时目录 + `t.after` 清理）

```js
test("append + read round-trips records with increasing revisions", () => { /* 3 条记录，revision 1/2/3 */ });
test("findProcessedCommand returns the original result for a processed commandId", () => { /* 幂等语义 */ });
test("readJournal skips a corrupt tail line", () => { /* 尾部写半行 JSON */ });
test("gcJournal truncates only after checkpoint write succeeds", () => { /* 先 gc（无 checkpoint）→ 不截断；写 checkpoint → gc → 截断 */ });
```

- [ ] **Step 2: 运行确认失败** → **Step 3: 实现** → **Step 4: 确认 PASS** → **Step 5: Commit**

```bash
git -C $WT add src/core/coordinator-journal.mjs test/coordinator-journal.test.mjs
git -C $WT commit -m "feat(core): durable command journal with checkpoint GC (issue #91)"
```

---

### Task 4: Coordinator 进程 `runner/state-coordinator.mjs`

**Files:**
- Create: `runner/state-coordinator.mjs`
- Modify: `src/core/paths.mjs`（加 `coordinatorEndpointPathFor(platform, root)`：POSIX → `<root>/coordinator.sock`，win32 → `\\.\pipe\agent-board-coordinator-<sha256(root).slice(0,16)>`，参照 `hostEndpointPathFor` 83 行）
- Test: `test/state-coordinator.integration.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `validateCommand`/`decideStateTransition`；Task 3 的 journal 函数；`src/core/store.mjs` 的 `readState`/`readStatus`/`writeState`/`writeStatus`（coordinator 是唯一合法 import 方）；`acquireOwnedViewLock` from `src/core/locks.mjs`（168 行）。
- Produces:
  - 进程入口：`node runner/state-coordinator.mjs <root>`（argv 直接传 root，不写 config 文件——coordinator 无 per-view 配置）
  - socket 协议（JSONL，server 模式参照 `runner/pty-runner.mjs` 的 `net.createServer` + 行缓冲模式）：
    - 上行 `{"type":"state_command", ...}`（Task 2 定义）
    - 下行 `{"type":"state_command_result","commandId":"...","status":"applied"|"rejected","reason":string|null,"materializedRevision":number}`
    - 上行 `{"type":"ping"}` → 下行 `{"type":"pong","instanceId":"...","startedAt":...}`（ensureCoordinator 探活用）
  - 环境变量 `AGENT_BOARD_COORDINATOR=off` 时进程立即退出（测试/降级用）

**行为规格（实现依据，逐条对应）：**

1. 启动时先抢 lease：`acquireOwnedViewLock(root, "_coordinator", "state-coordinator", { ... })`；抢不到 → 打印到 stderr 并 `process.exit(0)`（另一个 coordinator 已是 owner，幂等退出）。
2. 启动时 replay journal：`findProcessedCommand` 依赖的已处理集合载入内存；对每条 journal 记录检查对应 view 的 state/status 是否已物化到该 `materializedRevision`——未物化则补写（修复崩溃窗口：journal 已写但物化未完成）。
3. 每个 view 的 legacy 接管：首次处理某 view 的命令时，若 `state.json` 无 `materializedRevision` 字段，先写 `materializedRevision: 1` 再应用命令（A7 revision 子项 + spec 的 legacy 迁移规则）。
4. 命令循环：`validateCommand` → 已在已处理集合 → 直接返回原结果（不重复副作用）→ 否则 `decideStateTransition` → apply 则 `appendCommand` + fsync → 物化 state（和 currentRunId 匹配的 status，如果存在且 runId 匹配）→ 写时给两份文件都打同一个 `materializedRevision` → 返回结果。
5. `state.json` 与 status 的 revision 一致性只对 `currentRunId` 对应的 status 生效；无 currentRunId 或 status 文件不存在时只写 state.json（spec 根治条件 5 的适用范围）。
6. materialize 用 `withFileLockSync`（locks.mjs 38 行）包裹每个 view 的写对，减少崩溃时的半物化窗口；coordinator 重启 replay 兜底（行为 2）。
7. socket cleanup：正常退出/SIGTERM 时删除自己的 socket 文件（仅当 dev/ino 匹配自己 bind 的——参照 pty-runner 的 per-instance endpoint cleanup 语义）。

- [ ] **Step 1: 写失败 integration 测试**

```js
// test/state-coordinator.integration.test.mjs
// 夹具：mkdtemp 隔离 root（设 AGENT_BOARD_ROOT + PI_CODING_AGENT_DIR），
// spawn process.execPath runner/state-coordinator.mjs <root>，
// 用 net.createConnection 连 socket 收发 JSONL（参照 test/pty-runner.integration.test.mjs 模式）。

test("coordinator applies mark_completed and materializes state with revision", async () => {
	// createView 造 v1（idle）→ 发 mark_completed 命令
	// assert: result.status === "applied"，state.json 含 semanticState completed + materializedRevision ≥ 1
});

test("duplicate commandId returns the original result without re-applying", async () => {
	// 同一 commandId 发两次 mark_completed
	// assert: 两次 result 相同；state.json 的 updatedAt 未第二次变化（可用 journal 行数断言只 append 一次）
});

test("stale auto_state_classified after manual completion is rejected", async () => {
	// mark_completed 应用后，发 state-runner 来源的 auto_state_classified
	// assert: status "rejected", reason "manual_fence"（A8 核心场景）
});

test("coordinator restart replays journal and stays idempotent", async () => {
	// kill coordinator（SIGTERM）→ 重新 spawn → 重发已处理 commandId
	// assert: 返回原结果，无重复副作用（A7b 核心场景）
});

test("second coordinator instance exits immediately (lease held)", async () => {
	// 第一个持有 lease 时 spawn 第二个 → assert 第二个进程在 2s 内退出且 state 未被破坏
});
```

- [ ] **Step 2: 运行确认失败**（`runner/state-coordinator.mjs` 不存在）

- [ ] **Step 3: 实现**（进程骨架参照 `runner/state-runner.mjs` 的简洁度 + `runner/pty-runner.mjs` 的 socket server 模式；决策/持久化全部委托 Task 2/3 的模块，进程壳只做 socket、lease、调用顺序）

- [ ] **Step 4: 运行测试确认 5/5 PASS**

```bash
cd $WT && node --test test/state-coordinator.integration.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git -C $WT add runner/state-coordinator.mjs src/core/paths.mjs test/state-coordinator.integration.test.mjs
git -C $WT commit -m "feat(runner): detached view-state coordinator with lease, journal replay, idempotent commands (issue #91)"
```

---

### Task 5: Coordinator client `src/core/coordinator-client.mjs`

**Files:**
- Create: `src/core/coordinator-client.mjs`
- Modify: `src/core/launch.mjs`（加 `launchCoordinator(root, opts)`，模式照抄 `launchAutoState`（114 行）但 argv 为 `[coordinatorScript, root]`，不写 config 文件）
- Test: `test/coordinator-client.test.mjs`

**Interfaces:**
- Consumes: `coordinatorEndpointPathFor`（Task 4）、`launchCoordinator`、Task 2 的命令形状。
- Produces:
  - `sendStateCommand(root, command, opts?)` → `Promise<{ status: "applied"|"rejected", reason: string|null, materializedRevision: number }>`；内部：构造 commandId（`newRunId()` 复用 `src/core/ids.mjs`）→ `ensureCoordinator` → 连接 socket → 发送 → 等待匹配 commandId 的 result（超时 5s → `{ status: "rejected", reason: "timeout" }`）
  - `ensureCoordinator(root, opts?)` — probe socket（`{"type":"ping"}`，1s 超时）；失败则 `launchCoordinator` 并轮询 pong（10s 上限，100ms 间隔）；重复调用幂等（多个 client 并发 ensure 只应最终有一个 owner——由 Task 4 的 lease 保证，client 不需要自己的锁）
  - 降级：`AGENT_BOARD_COORDINATOR=off` 时 `sendStateCommand` 返回 `{ status: "rejected", reason: "coordinator_disabled" }`，调用方回退到旧直写路径（PR #1 期间保留的兼容逃生门）

- [ ] **Step 1: 写失败测试**（fake socket server 夹具：测试文件内 `net.createServer` 起临时 socket，断言 client 的消息形状与超时行为；ensureCoordinator 的 spawn 路径用真 coordinator + 隔离 root 测一个 happy path）

- [ ] **Step 2–5: 失败 → 实现 → PASS → Commit**

```bash
git -C $WT add src/core/coordinator-client.mjs src/core/launch.mjs test/coordinator-client.test.mjs
git -C $WT commit -m "feat(core): coordinator client with ensure/spawn and idempotent command send (issue #91)"
```

---

### Task 6: 迁移 markCompleted（A8 路径一）

**Files:**
- Modify: `src/runtime/service.mjs`（`completeView`，约 405-425 行）

**Interfaces:**
- Consumes: Task 5 的 `sendStateCommand`。
- Produces: `completeView(viewId)` 改为发送 `{ kind: "mark_completed", source: "dashboard-user", viewId, runId: state.currentRunId, expectedRevision: null, payload: {} }`；`isAgentBusy` 的前置 UI 检查保留（快速反馈），但权威判断在 coordinator。

- [ ] **Step 1: 写失败测试**

修改/新增 `test/service.test.mjs` 用例（该文件已有 completeView 相关测试，找到它们）：

```js
test("completeView goes through the coordinator command path", async () => {
	// 隔离 root + 起真 coordinator；service.createService({ root, ... }) 
	// completeView 一个 idle view
	// assert: journal 中存在 kind=mark_completed 的记录（而不是只检查 state.json）
});
```

现有 `completeView` 测试需保持通过（行为兼容：返回值形状 `{ ok, error? }` 不变；coordinator rejected(busy) 映射为原错误文案 `"Wait for the active run to finish before marking done"`）。

- [ ] **Step 2–5: 失败 → 实现 → PASS → Commit**

```bash
git -C $WT add src/runtime/service.mjs test/service.test.mjs
git -C $WT commit -m "refactor(service): route markCompleted through view-state coordinator (issue #91)"
```

---

### Task 7: 迁移 auto-state 写入（A8 路径二）

**Files:**
- Modify: `runner/state-runner.mjs`（54-63 行的 writeStatus/writeState）
- Modify: `runner/job-runner.mjs` 的 `persistUnlessManual`/heuristic auto-state 路径（121-123、225-237、265、290、380、406、444 行的 `isManualCompletion` 守卫区域中属于 auto-state 分类结果写入的部分）
- Test: `test/state-coordinator.integration.test.mjs`（追加端到端用例）

**Interfaces:**
- Consumes: Task 5 的 `sendStateCommand`。
- Produces: state-runner 与 job-runner 的分类结果写入改为 `{ kind: "auto_state_classified", source: "state-runner"|"job-runner", viewId, runId, expectedRevision: null, payload: { classification } }`；`applyAutoStateToViewState/Status` 的调用移到 coordinator 决策层（Task 2 已完成）；runner 本地的 `isManualCompletion` 预检查**保留**（避免无意义命令），但作为优化而非正确性依赖。

- [ ] **Step 1: 写失败测试（A8 端到端）**

```js
test("A8: manual completion fences a late model classification (end-to-end)", async () => {
	// 隔离 root；起 coordinator；createView + 造一个 exited run 的 status
	// 1. dashboard 路径 mark_completed（sendStateCommand, source dashboard-user）
	// 2. 模拟 state-runner 迟到：sendStateCommand(auto_state_classified, source state-runner)
	// assert: 第二条 rejected(manual_fence)；state.json 仍是 completed 且 autoState 为 null
	// kill coordinator 重启 → 再发一次同样的迟到命令 → 仍 rejected（journal 重放后 fence 仍在）
});
```

- [ ] **Step 2–5: 失败 → 实现 → PASS → Commit**

```bash
git -C $WT add runner/state-runner.mjs runner/job-runner.mjs test/state-coordinator.integration.test.mjs
git -C $WT commit -m "refactor(runner): route auto-state classification through coordinator (issue #91)"
```

---

### Task 8: 迁移 run finalization（A8 路径三）

**Files:**
- Modify: `runner/job-runner.mjs`（`finalizeRun` 周边：约 279、305-306 行的终态 writeState/writeStatus）
- Modify: `src/runtime/service.mjs` 的 reconcile/final-state 写入（383-393、420-423、453、535、1497、1524、1745-1763 行中**仅与 run 终态相关的站点**；逐站点判断，属于 view 元数据/visited 等非终态语义的站点留在白名单，PR #2 迁移）
- Test: `test/runner.integration.test.mjs`（更新现有 #46 回归测试 `runner does not clobber a manual completion made during post-exit model passes`，约 339 行，断言路径从「直写 state.json」改为「coordinator journal 存在记录且 state.json 由 coordinator 物化」）

**Interfaces:**
- Consumes: Task 5 的 `sendStateCommand`；Task 2 的 `run_finalized` 分支。
- Produces: `run_finalized` 命令 payload：`{ endedAt, exitCode, semanticState, summary, latestAssistantPreview, lastAgentActivityAt }`；job-runner 的退出路径不再直接写终态，改为发命令并等待 applied（5s 超时，超时则落 diagnostic 并退出—— coordinator 重启后会从 journal 补物化，见 Task 4 行为 2）。

- [ ] **Step 1: 更新 #46 回归测试为 coordinator 断言** → **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: PASS** → **Step 5: Commit**

```bash
git -C $WT add runner/job-runner.mjs src/runtime/service.mjs test/runner.integration.test.mjs
git -C $WT commit -m "refactor(runner): route run finalization through coordinator (issue #91)"
```

---

### Task 9: 架构边界静态测试（A7，含白名单）

**Files:**
- Create: `test/architecture-writer-boundary.test.mjs`

**Interfaces:**
- Consumes: `node:fs` 读源码文件。
- Produces: 静态扫描测试 + 白名单常量（测试文件顶部，每项附 justification 注释）。

- [ ] **Step 1: 写测试（一次写好，先失败）**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// PR #1 白名单：尚未迁移的既有写入点，PR #2 清零。
// 每项必须附 justification；新增条目视为架构倒退，必须 CR 讨论。
const WRITE_STATE_ALLOWLIST = new Map([
	["src/runtime/service.mjs", "PR #1: 非终态站点（markVisited/adopt/reconcile 元数据）待 PR #2 迁移"],
	["src/core/store.mjs", "createView bootstrap 初始化写；coordinator 接管前的建行路径，PR #2 迁移"],
	["runner/job-runner.mjs", "PR #1: during-run 热路径节流写（250ms）待 PR #2 迁移；与 markCompleted 无竞争（busy 守卫）"],
]);
const ALLOWED_WRITER_MODULES = new Set(["runner/state-coordinator.mjs"]);

test("only the coordinator imports writeState/writeStatus in production code (allowlisted exceptions)", () => {
	const files = ["src", "runner", "index.ts"].flatMap(function walk(p) { /* 递归收集 .mjs/.ts */ });
	for (const file of files) {
		const src = readFileSync(file, "utf8");
		if (!/import \{[^}]*write(State|Status)/.test(src)) continue;
		if (ALLOWED_WRITER_MODULES.has(file)) continue;
		const justification = WRITE_STATE_ALLOWLIST.get(file);
		assert.ok(justification, `${file} imports writeState/writeStatus without an allowlist justification`);
	}
});

test("allowlist does not shrink silently (update the map when migrating)", () => {
	// 断言白名单中的文件确实仍含写入 import——迁移完成后必须同步删条目，否则白名单腐化
	for (const [file] of WRITE_STATE_ALLOWLIST) {
		const src = readFileSync(file, "utf8");
		assert.ok(/write(State|Status)/.test(src), `${file} no longer writes — remove its allowlist entry`);
	}
});
```

注：第二个测试在 PR #2 迁移完成时会失败，迫使迁移者删白名单条目——这是设计意图（白名单只许缩不许腐）。

- [ ] **Step 2–5: 失败 → 调整到当前真实白名单 → PASS → Commit**

```bash
git -C $WT add test/architecture-writer-boundary.test.mjs
git -C $WT commit -m "test(arch): writer-boundary static test with shrinking allowlist (issue #91)"
```

---

### Task 10: materializedRevision 字段与 legacy 接管

**Files:**
- Modify: `src/core/types.mjs`（`ViewState`/`RunStatus` typedef 加 `@property {number} [materializedRevision]`）
- Modify: `src/runtime/service.mjs`（`loadRow`/读侧：容忍缺失 revision 字段——不强制 reconcile，读取兼容逻辑保留到 PR #2 再启用 revision 一致性检查）
- Test: `test/state-coordinator.integration.test.mjs`（追加用例）

- [ ] **Step 1: 写失败测试**

```js
test("legacy view without materializedRevision gets revision 1 on first coordinator touch", async () => {
	// createView 造行（无 revision）→ 发任意命令 → assert state.json.materializedRevision === 1（或 2，若接管与应用分开计）
});
```

- [ ] **Step 2–5: 失败 → 实现 → PASS → Commit**

```bash
git -C $WT add src/core/types.mjs src/runtime/service.mjs test/state-coordinator.integration.test.mjs
git -C $WT commit -m "feat(core): materializedRevision field with legacy adoption (issue #91)"
```

---

### Task 11: 全量回归 + PR 准备

- [ ] **Step 1: 跑全量测试**

```bash
cd $WT && node --test test/ 2>&1 | tail -30
```

Expected: 全 PASS。flaky 参照仓库历史处理（本仓有 deflake 传统，见 git log 的 deflake commits）。

- [ ] **Step 2: 验收逐项对账**（github-issue-driven step 9）

| 验收 ID | 本 PR 状态 | 证据 |
|---|---|---|
| A7 | 部分（白名单内站点未迁移） | Task 9 测试通过，白名单仅 3 项且均有 justification |
| A7b | ✅ | Task 4 的 restart/failover 用例 |
| A8 | ✅ | Task 6/7/8 + 端到端用例 |
| 其余 | pending（后续阶段） | spec §8 分阶段声明 |

- [ ] **Step 3: 本地快速 CR**（requesting-code-review 或 pi workflow code-review）

## Self-Review 记录

- Spec 覆盖：本 plan 只覆盖 D3 + Phase 1；D1/D2/D4/D5 属于后续 PR（spec §8 已声明分阶段，scope 节再次声明）。
- 占位符扫描：无 TBD/TODO；Task 2 的 `auto_state_classified`/`run_finalized` 分支给了实现策略（委托 auto-state.mjs 后 diff 补丁），非空泛占位。
- 类型一致性：`commandId`/`materializedRevision`/`state_command`/`state_command_result`/`decideStateTransition`/`sendStateCommand`/`ensureCoordinator`/`launchCoordinator`/`coordinatorEndpointPathFor` 在 task 间一致。
