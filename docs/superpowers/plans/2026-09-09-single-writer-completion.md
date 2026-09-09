# Single-Writer Completion (PR #2, issue #91 Phase 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 迁移 PR #1 白名单中的全部剩余 writeState/writeStatus 直写点到 View State Coordinator，使架构边界白名单清零到仅剩「设计内豁免」，A7 完全闭合；同时关闭 PR #1 遗留的 pty-runner `markRowFailed` 无 manual-fence 残留风险。

**Architecture:** 扩展 `src/core/state-commands.mjs` 的命令种类（lifecycle 命令显式建类 + 元数据/镜像合并为 `patch_fields` 通用命令），coordinator 支持「非 journal 的瞬时命令」（run_progress 热路径），各 runner/service/dashboard 的剩余站点逐个迁移。读侧 revision 一致性 enforcement 明确留给 PR #3（需要所有写者先打戳）。

**Tech Stack:** Node.js ESM、node:net JSONL、现有 coordinator/journal/client（PR #1 已建）。

**Spec:** `docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md`（D3 + 验收 A7 + 根治条件 1/2/5 写侧）；本 plan 不覆盖读侧 enforcement（PR #3）。

## 设计决策（本 plan 锁定）

1. **新命令种类**（加入 `STATE_COMMAND_KINDS`，决策层每个有显式分支）：
   - lifecycle（改 semanticState/processState/currentRunId）：`mark_queued`、`run_started`、`run_progress`、`reconcile_finalize`、`host_run_failed`、`archive_view`、`adopt_session`、`sync_foreground`、`plan_ready`、`followup_started`
   - 元数据/镜像合并：`patch_fields`，带 per-source 字段白名单 + 通用守卫
2. **`run_progress` 是瞬时命令，不进 journal**：进度写是周期性快照（250ms 节流），被下一拍自愈；journal 化会让 journal 无界膨胀（4 条/秒/run），违背 GC 设计。模糊失败（timeout/reset）→ 跳过 + debug 级 diagnostic，等下一拍。落地仍打 materializedRevision（单调性由 boot counter 的 views 扫描保证）。
3. **`host_run_failed` 必须带 manual fence**（通用守卫已覆盖非 user 来源）——这关闭 PR #1 遗留的 pty-runner markRowFailed 残留风险（手动完成后宿主迟到崩溃不再能把行翻成 failed）。
4. **永久豁免**（边界测试白名单的终态）：(a) 各 runner 的 `coordinator_disabled` 遗留分支（显式 debug 逃生门，文档化）；(b) `store.mjs` createView bootstrap（不可能竞争：新 viewId 是随机生成的，不存在其他知情的写者）。豁免理由写进白名单条目；A7 的「清零」含义 = 无未治理写点，不是字面零条目。
5. **dashboard.ts 热重载兼容回退直接删除**（旧 service 对象不跨重启存活，窗口是瞬时的）。
6. **M2 summary 分歧**：coordinator 的 mark_completed 保持「保留现有 summary」（PR #1 裁决），本 PR 不改；如用户反馈再议。

## Global Constraints

- 所有 runner 进程 plain ESM `.mjs`，不依赖 jiti。
- Commit message 英文 conventional commits；`git add <file>` 显式 stage，禁止 `-A`。
- 测试 `node --test`；隔离必须同时设 `AGENT_BOARD_ROOT` + `PI_CODING_AGENT_DIR`；coordinator 一律用 tracked fixture（test-support/ensure-coordinator-helper.mjs，带 readiness wait + finally kill）。
- 可测性硬约束：决策层保持纯函数；新命令的守卫逻辑在 state-commands.mjs 内，不碰 I/O。
- 模糊结果（timeout/connection_reset）不回退直写；只有 `coordinator_disabled` 走 legacy 分支。
- 工作区：`$WT = /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-91-single-writer-completion`，全部用绝对路径 + `git -C $WT`。

## 验收映射

| Task | 验收 ID | 说明 |
|---|---|---|
| Task 1 | A7 基础 | 决策层新命令种类 + 守卫（纯函数） |
| Task 2 | A7/A7b | coordinator 支持瞬时命令 + patch_fields + host_run_failed |
| Task 3 | A7 | job-runner 全量迁移（含热路径 run_progress） |
| Task 4 | A7 | state-runner 镜像迁移 |
| Task 5 | A7 + PR#1 残留风险 #2 | pty-runner markRowFailed → host_run_failed（带 fence） |
| Task 6 | A7 | service.mjs 全量迁移 |
| Task 7 | A7 | dashboard 回退删除 |
| Task 8 | A7 闭合 | 边界测试白名单 → 设计内豁免；justification 更新 |
| Task 9 | 对账 | 全量回归 + 验收对账 |

A8 已在 PR #1 闭合（本 PR 不破坏其测试）；根治条件 5 的读侧在 PR #3。

---

### Task 1: 决策层扩展——新命令种类与守卫（纯函数）

**Files:**
- Modify: `src/core/state-commands.mjs`
- Test: `test/state-commands.test.mjs`

**Interfaces:**
- Consumes: 现有 `validateCommand`/`decideStateTransition` 结构、守卫顺序（unknown_view → revision_conflict → stale_run → manual_fence → kind 分支）。
- Produces（后续 task 依赖的精确契约）:
  - `STATE_COMMAND_KINDS` 扩展为 13 种（现有 3 种 + 新增 10 种）
  - `TRANSIENT_KINDS` = `["run_progress"]`（coordinator 据此跳过 journal）
  - `PATCHABLE_FIELDS` per source 白名单：
    - `job-runner`/`state-runner`: `["review","evidenceSummary"]`（镜像）+ status 侧 `evidenceSummary`
    - `service`: `["lastVisitedAt"]`（markVisited 经此）
  - 每个新 kind 的守卫（决策层分支，全部纯函数）：

| kind | 额外守卫（通用守卫之外） | mutate 语义 |
|---|---|---|
| `mark_queued` | 无 | state: {currentRunId: payload.runId, semanticState:"queued", processState:"alive", summary:"Queued", needsInput:false, hasError:false, question:null, pendingQuestions:[], error:null, autoState:null} |
| `run_started` | runId 必须等于 payload.runId | status 新建字段补丁（createRunStatus 形状由调用方算好放在 payload.status）；state: {processState:"alive", semanticState:"working", currentRunId} |
| `run_progress` | `state.currentRunId === command.runId && state.processState === "alive"`，否则 reject "stale_run"（活跃性语义） | payload.statusPatch 稀疏合并 status；state 侧由 coordinator 用 projectViewState(statusClone) 重算（委托，不复制规则） |
| `reconcile_finalize` | `state.processState === "alive"`（否则 no_change） | payload: {semanticState: "failed"\|"idle", reason}；state: {semanticState, processState:"exited", error?}；currentRunId 对应 status 存在则同步 finalize 字段 |
| `host_run_failed` | 无（通用 manual_fence 即 PR#1 残留风险 #2 的关闭点） | state: {semanticState:"failed", processState:"exited", error: payload.error ?? null}；status 同理（currentRunId 匹配时） |
| `archive_view` | busy 时 allow（archive 的 busy 分支原本就写 stopped） | state: {semanticState:"stopped", processState:"exited", needsInput:false, hasError:false, question:null, pendingQuestions:[], error:null, autoState:null, summary:"Stopped"} |
| `adopt_session` | `processState !== "alive"`（否则 reject "busy"） | state: {semanticState:"idle", processState:"exited", summary:"Backgrounded session"} |
| `sync_foreground` | 无 | payload.projection（service 侧 projectViewState 已算好，currentRunId 强制 null 由本分支保证）稀疏合并 state |
| `plan_ready` | `processState === "alive"`（否则 no_change） | state: {needsInput:true, question: payload.question ?? null}；status 侧 recordPlanReady 对应字段 |
| `followup_started` | 无 | payload.statusPatch → status；state 侧 projectViewState 重算 |
| `patch_fields` | 字段白名单（`PATCHABLE_FIELDS[command.source]`，越界字段 reject "field_not_allowed"）；payload.runId 存在时 stale_run 通用守卫生效 | payload.state/payload.status 稀疏合并（仅限白名单字段） |

- [ ] **Step 1: 写失败测试**——每种新 kind 至少 1 个 happy-path + 1 个守卫测试；`patch_fields` 越界字段拒绝测试；`run_progress` 的 stale/alive 守卫测试；`host_run_failed` 的 manual_fence 测试（复用现有 manualCompletedState fixture 模式）。
- [ ] **Step 2: 运行确认失败** → **Step 3: 实现** → **Step 4: PASS** → **Step 5: Commit**

```bash
git -C $WT add src/core/state-commands.mjs test/state-commands.test.mjs
git -C $WT commit -m "feat(core): extend state commands with lifecycle kinds and patch_fields (issue #91)"
```

---

### Task 2: Coordinator 支持瞬时命令与新 kinds

**Files:**
- Modify: `runner/state-coordinator.mjs`
- Test: `test/state-coordinator.integration.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `TRANSIENT_KINDS` 与新 kinds。
- Produces:
  - 瞬时命令（`TRANSIENT_KINDS`）路径：validate → dedupe 不需要（无 commandId 幂等语义——run_progress 无需 commandId 去重，client 可省略 commandId）→ decide → 直接物化（仍打 materializedRevision、仍 under view lock）→ 返回结果。**不写 journal、不进 processed 集合**。
  - `run_progress` 的 revision bump 照常（单调性由全局 counter 保证；boot 时 views 扫描已覆盖）。
  - 其余新 kinds 走正常 journaled 路径。

- [ ] **Step 1: 失败测试**：run_progress 瞬时命令 applied 且 journal 行数不增长；host_run_failed applied；mark_queued applied；并发 run_progress 不交错（同一 view 两客户端连发）。
- [ ] **Step 2–5: 失败 → 实现 → PASS → Commit**

```bash
git -C $WT add runner/state-coordinator.mjs test/state-coordinator.integration.test.mjs
git -C $WT commit -m "feat(runner): transient run_progress and new lifecycle kinds in coordinator (issue #91)"
```

---

### Task 3: job-runner 全量迁移（含热路径）

**Files:**
- Modify: `runner/job-runner.mjs`
- Test: `test/runner.integration.test.mjs`

**Interfaces:**
- Consumes: Task 1-2 的命令；`sendStateCommand`。
- Produces:
  - boot bootstrap（L65/69、L95）→ `run_started` 命令
  - `persist()` 热路径（L103-112 及 125/201/217 调用点）→ `run_progress` 瞬时命令（fire-and-forget：不等结果、失败 debug 级忽略——下一拍自愈；**这是本 PR 唯一允许 fire-and-forget 的命令**，理由：周期性快照 + 下一拍覆盖）
  - `refreshEvidenceMirrors`（L152/157）→ `patch_fields`（review/evidenceSummary）
  - plan-ready（L382）→ `plan_ready`；follow-up bootstrap（L408-409）→ `followup_started`
  - post-exit summary persist（maybeModelSummary 尾部的 persistUnlessManual(true)）→ `patch_fields`（summary/latestAssistantPreview；manual fence 由通用守卫保证）
  - `coordinator_disabled` 分支保留为设计内豁免（不迁移，但保持现状可用）
  - **迁移完成后 runner/job-runner.mjs 不再 import writeState/writeStatus**（coordinator_disabled 分支改为调 legacy helper——见下）

**关键设计点（防回归）：** coordinator_disabled 分支需要直写能力。方案：把 PR #1 之前的直写逻辑收进 `runner/job-runner-legacy.mjs`（新文件，只有 disabled 分支 import 它），使 job-runner.mjs 本身不再 import write 函数——边界测试白名单条目从 job-runner.mjs 移到 job-runner-legacy.mjs（justification：disabled 逃生门）。

- [ ] **Step 1: 失败测试**：run_progress 经 coordinator 的集成测试（runner 活跃期间 state.json 由 coordinator 物化、journal 不增长）；#46 回归与既有 runner.integration 用例保持绿。
- [ ] **Step 2–5: 失败 → 实现 → PASS → Commit**

```bash
git -C $WT add runner/job-runner.mjs runner/job-runner-legacy.mjs test/runner.integration.test.mjs
git -C $WT commit -m "refactor(runner): migrate job-runner writes to coordinator incl. transient run_progress (issue #91)"
```

---

### Task 4: state-runner 镜像迁移

**Files:**
- Modify: `runner/state-runner.mjs`（镜像写 → `patch_fields`）；disabled 分支同样收进 legacy helper 或直接保留（该文件小，保留 disabled 分支并更新白名单 justification 即可，不必拆文件）
- Test: `test/state-coordinator.integration.test.mjs`（state-runner 真实进程用例更新断言）

- [ ] **Step 1–5: TDD 循环 → Commit**

```bash
git -C $WT add runner/state-runner.mjs test/state-coordinator.integration.test.mjs
git -C $WT commit -m "refactor(runner): migrate state-runner evidence mirrors to patch_fields (issue #91)"
```

---

### Task 5: pty-runner markRowFailed → host_run_failed（关闭残留风险 #2）

**Files:**
- Modify: `runner/pty-runner.mjs`（markRowFailed，~L1021-1048）
- Test: `test/pty-runner.integration.test.mjs`

**Interfaces:**
- markRowFailed 改为发送 `host_run_failed` 命令（source "pty-runner"——需加入 COMMAND_SOURCES）；payload `{ error, exitCode? }`。
- 手动完成的行不再能被迟到崩溃翻成 failed（通用 manual_fence 守卫）；这是本 task 的核心回归测试。
- pty-runner 是 detached 进程，coordinator-client 是 plain ESM 可 import。
- 模糊结果处理：warn diagnostic + 继续（崩溃路径不能因此卡住退出）；coordinator_disabled → 保留 legacy 直写（收进 legacy helper 或保留原位并更新白名单 justification）。

- [ ] **Step 1: 失败测试**（核心回归）：手动 completed 的行 + 宿主迟到崩溃 → state.json 保持 completed（fence 拒绝 host_run_failed）；无 fence 时正常 failed。
- [ ] **Step 2–5: TDD → Commit**

```bash
git -C $WT add runner/pty-runner.mjs test/pty-runner.integration.test.mjs
git -C $WT commit -m "fix(runner): route host crash finalization through fenced host_run_failed command (issue #91)"
```

---

### Task 6: service.mjs 全量迁移

**Files:**
- Modify: `src/runtime/service.mjs`
- Test: `test/service.test.mjs`

**迁移映射（站点 → 命令）：**
- L423 markQueued → `mark_queued`
- L433 markVisited → `patch_fields`（lastVisitedAt；metadata，但统一走 coordinator 保持边界干净）
- L524 archiveView 的 state 部分 → `archive_view`（meta.archived 直写保留——meta.json 是文档化例外）
- L606 writeForegroundState → `sync_foreground`
- L1602/1629 adoptSession → `adopt_session`
- L1855/1864/1873 reconcile 终态 → `reconcile_finalize`
- `completeViewDirect`（coordinator_disabled 分支）保留为设计内豁免——收进 `src/runtime/service-legacy.mjs` 或原位保留并更新白名单 justification（择实现复杂度低者；service.mjs 很大，原位保留 + justification 更新更简单）
- 全部迁移后 service.mjs 的直接 writeState/writeStatus 调用点只剩 disabled 分支

- [ ] **Step 1–5: TDD → Commit**（现有 service 测试全部保持绿；reconcile 相关用例更新为 coordinator 断言）

```bash
git -C $WT add src/runtime/service.mjs test/service.test.mjs
git -C $WT commit -m "refactor(service): migrate remaining state writes to coordinator commands (issue #91)"
```

---

### Task 7: dashboard.ts 兼容回退删除

**Files:**
- Modify: `src/ui/dashboard.ts`（删除 ~L981-1020 的 stale-service-object 回退；markCompleted 调用统一走新 async 路径）
- Test: `test/service.test.mjs` / dashboard 相关测试保持绿

- [ ] **Step 1–5: TDD → Commit**

```bash
git -C $WT add src/ui/dashboard.ts
git -C $WT commit -m "refactor(dashboard): drop pre-coordinator markCompleted compat fallback (issue #91)"
```

---

### Task 8: 边界测试白名单 → 设计内豁免（A7 闭合）

**Files:**
- Modify: `test/architecture-writer-boundary.test.mjs`

**终态白名单（每项带永久 justification）：**
- `runner/job-runner-legacy.mjs`（或 state-runner/pty-runner 的 disabled 原位分支）——「coordinator_disabled 逃生门，设计内豁免」
- `src/runtime/service.mjs`——仅当 disabled 分支原位保留时；若收进 service-legacy.mjs 则换成该文件
- `src/core/store.mjs`——「createView bootstrap 不可能竞争（新 viewId 随机生成，无其他写者知情），永久豁免」
- 其余条目全部删除；测试断言白名单外零 importer。
- 更新文件头注释：从「PR #2 迁移并删除条目」改为「设计内豁免清单」。
- 顺手修 PR #1 的 deferred minor：non-rotting 检查对 importer 条目改用 import-level 正则（mention-level 只留给 store.mjs）。

- [ ] **Step 1–5: TDD → Commit**

```bash
git -C $WT add test/architecture-writer-boundary.test.mjs
git -C $WT commit -m "test(arch): shrink writer allowlist to designed exceptions only (issue #91)"
```

---

### Task 9: 全量回归 + 验收对账

- [ ] `node --test test/*.test.mjs` 全绿 + `npm run typecheck` + 零泄漏进程检查
- [ ] 验收对账写入 PR 描述：A7 ✅（豁免清单版）；A8 不回归；根治条件 1/2 写侧闭合；根治条件 5 读侧 → PR #3
- [ ] PR 描述诚实声明：读侧 revision 一致性未启用；coordinator 不可用时 mutation fail-closed（mark-done 显示原始 reason）

## Self-Review 记录

- Spec 覆盖：D3 写侧全覆盖；读侧 enforcement 明确 PR #3（spec §8 分阶段允许）。
- 与 PR #1 的接口一致性：`TRANSIENT_KINDS`/`PATCHABLE_FIELDS`/新 kind 名在 Task 1 定义、Task 2-6 消费，名称在 Global Constraints 与各 task Interface 块一致。
- 占位符：无 TBD；Task 6 的「原位保留 vs 收进 legacy 文件」给了明确的取舍指引（实现复杂度低者）。
