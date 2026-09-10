# Reader Consistency & Residual Convergence (PR #3, issue #91) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭 spec 根治条件 5 的读侧（revision 一致性 enforcement）+ 收敛 PR #2 已知残留（coordinator 硬宕窗口的无 status 文件行）+ 合并后卫生波。完成后 **D3「状态所有权」弧线全部闭合**（写侧 PR #1/#2、读侧本 PR）。

**Architecture:** 三个小面：(1) 决策层让 `run_progress` 在「行存活 + runId 匹配 + status 文件缺失」时从 beat 的全量 patch 自举（部分反转 F2 守卫——F2 防的是稀疏 patch 物化 undefined，而 beat 的 patch 是全量的，且硬宕残留正是需要自愈的场景）；(2) reconcile 作为唯一组合读者，读侧做 revision mismatch 检测——不一致则丢弃组合、踢 ensureCoordinator（boot replay 修复）、记 diagnostic；(3) 卫生波（.catch、双击窗口、JSDoc、warn 措辞、void+catch pass）。

**Tech Stack:** 既有 coordinator/journal/client/决策层（PR #1/#2 已建并稳定）。

**Spec:** `docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md`（根治条件 5；§5 降级条款）。

## 设计决策（本 plan 锁定）

1. **run_progress bootstrap 是 F2 的部分反转，有边界**：F2 的 `!currentStatus → stale_run` 改为——行 `processState === "alive" && currentRunId === command.runId` 时从 patch 自举（决策层校验 patch 携带 `processState`/`semanticState`/`runId` 一致性后才自举；稀疏或身份不符仍 stale_run）。coordinator 的 `STATUS_BOOTSTRAP_KINDS` 增加 `run_progress`。理由：beat 是 runner 内存中权威状态的全量快照；硬宕残留（mark_queued applied 但 run_started 丢失）下，coordinator 恢复后第一条 beat 即自愈。
2. **读侧 mismatch 的语义**：reconcile 读 `s.currentRunId` 对应 status 时，若 `state.materializedRevision != null && status?.materializedRevision != null && 二者不等` → 视为不一致：跳过本行投影（不拼）、`appendDiagnostic(code: "state_status_revision_desync")`、异步 `ensureCoordinator(root)`（boot replay 从 journal 修复半物化对）、不计入 fixed。**legacy 行（任一侧无 revision）不检查**——与 spec 的 legacy 迁移条款一致。
3. **mismatch 只可能来自 coordinator 崩溃窗口**（写侧已全部在 view lock 内配对打戳）；活着的 coordinator 不会产生 mismatch。所以修复路径 = ensureCoordinator spawn → boot replay，无需新命令 kind。
4. **双击窗口修复选「同步清理」**：`submitDispatch` 在发起异步 dispatch 前**同步**清 `this.launch`/input/mode（不等 .then），消除 coordinator 冷启动 round-trip 期间的重复提交窗口；.catch 兜底 fs 类异常。
5. **decided-rejection warn 措辞**：job-runner/state-runner 中对 `manual_fence`/`stale_run`/`no_change` 等**确定性拒绝**的分支不再使用「outcome unknown … replay will recover」句式——改为 info 级 `*_skipped` 或措辞明确的 warn（确定性拒绝已 journal，无恢复语义）。

## Global Constraints

- 所有 runner 进程 plain ESM `.mjs`。
- Commit message 英文 conventional commits；`git add <file>` 显式 stage，禁止 `-A`。
- 测试 `node --test`；隔离必须同时设 `AGENT_BOARD_ROOT` + `PI_CODING_AGENT_DIR`；coordinator 一律 tracked fixture（`test-support/ensure-coordinator-helper.mjs`，readiness wait + finally kill）。
- 决策层保持纯函数。
- 模糊结果（timeout/connection_reset）不回退直写；只有 `coordinator_disabled` 走 legacy 分支。
- **大 task 时间纪律**：分阶段提交工作增量，保持树常绿（吸取 PR #2 三次超时教训）。
- `$WT = /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-91-reader-consistency`；全部绝对路径 + `git -C $WT`。

## 验收映射

| Task | 验收目标 | 说明 |
|---|---|---|
| Task 1 | 根治条件 5 残留收敛（决策层） | run_progress bootstrap 守卫 + 纯函数测试 |
| Task 2 | 残留收敛（端到端） | 硬宕场景：beat 自举 → finalize 收敛 |
| Task 3 | **根治条件 5 读侧闭合** | reconcile mismatch 检测 + 修复踢 + diagnostic |
| Task 4 | 卫生波 | .catch / 双击窗口 / JSDoc / warn 措辞 / void+catch |
| Task 5 | 对账 | 全量回归 + 根治条件 1/2/5 全闭合声明 |

---

### Task 1: 决策层——run_progress 缺失 status 时的自举分支

**Files:**
- Modify: `src/core/state-commands.mjs`
- Test: `test/state-commands.test.mjs`

**Interfaces:**
- Consumes: 现有 `run_progress` 分支（~L358：`if (!currentStatus) return reject("stale_run")`）、`applyStatusProjection`。
- Produces（Task 2 依赖）:
  - run_progress 分支新语义：
    - `currentStatus == null` 且 `currentState.processState === "alive" && currentState.currentRunId === command.runId`：校验 `payload.statusPatch` 为自举合格（含 `processState`、`semanticState` 字段且 `statusPatch.runId === command.runId`）→ 以 patch 自身为基座走 applyStatusProjection（基座 = patch 本身，非 `{}`），mutate.status 为全量 patch；
    - `currentStatus == null` 且行不存活或 runId 不匹配：维持 `stale_run` 拒绝（F2 原语义）；
    - `currentStatus != null`：原逻辑不变（liveness 守卫 + 投影）。
  - 更新 F2 的既有测试（`run_progress` 缺 status → stale_run）为分场景：行不匹配仍拒；行匹配 → 自举 applied。
- [ ] **Step 1: 失败测试**——三个场景（自举 applied + 全量 status patch；行 exited → stale_run；patch 稀疏缺 processState → stale_run）
- [ ] **Step 2–5: 失败 → 实现 → PASS → Commit**（`feat(core): run_progress bootstraps a missing status from its full patch (issue #91)`）

---

### Task 2: Coordinator——bootstrap kinds 扩展 + 硬宕残留端到端

**Files:**
- Modify: `runner/state-coordinator.mjs`（`STATUS_BOOTSTRAP_KINDS` 增加 `"run_progress"`）
- Test: `test/state-coordinator.integration.test.mjs`

**Interfaces:**
- 端到端回归测试（残留关闭证明）：`mark_queued` applied → **不发 run_started**（模拟硬宕窗口错过）→ 发一条 `run_progress` beat（全量 patch）→ 断言 status 文件自举创建（含 revision 戳）+ state 投影 applied → 再发 `run_finalized` → 断言 applied（此前会 stale_run 拒绝）。全程 journal 只有 mark_queued + run_finalized（beat 不落 journal）。
- 既有 F2 集成测试同步更新。
- [ ] **Step 1–5: TDD → Commit**（`feat(runner): beats bootstrap missing status, closing the hard-down window (issue #91)`）

---

### Task 3: 读侧 revision 一致性（reconcile enforcement）

**Files:**
- Create: `src/core/status-consistency.mjs`（纯函数 helper）
- Modify: `src/runtime/service.mjs`（reconcile 组合读处）
- Test: `test/status-consistency.test.mjs` + `test/service.test.mjs`

**Interfaces:**
- Produces:
  - `statusRevisionDesynced(state, status)` → boolean：`state?.materializedRevision != null && status?.materializedRevision != null && state.materializedRevision !== status.materializedRevision`（legacy 任一侧缺失 → false，不检查）。
  - reconcile（~L2022 读 status 处）集成：desynced → `appendDiagnostic(code: "state_status_revision_desync", level: "warn")` + `void ensureCoordinator(root).catch(() => {})`（异步踢修复；boot replay 修复半物化对）+ `continue`（跳过本行，不计 fixed，不拼状态）。
  - `ensureCoordinator` 需从 `src/core/coordinator-client.mjs` 导出（检查是否已导出；PR #1 Task 5 建过，确认签名）。
- 测试：纯函数表驱动（desync/一致/legacy 侧缺失/双侧缺失）；service 集成（手动构造半物化对——state 戳 N+1、status 戳 N——reconcile 跳过该行 + diagnostic 落盘 + 不计入 fixed；coordinator spawn 后可另行验证修复，不强求同测试内）。
- [ ] **Step 1–5: TDD → Commit**（`feat(core): reader-side revision consistency enforcement in reconcile (issue #91)`）

---

### Task 4: 卫生波

**Files:**
- Modify: `src/ui/dashboard.ts`、`src/runtime/service.mjs`、`runner/job-runner.mjs`、`runner/state-runner.mjs`（措辞）+ 相关调用点（void+catch pass）

**清单（每项独立可验证）：**
1. `submitDispatch`（dashboard.ts ~L844+）：发起异步 dispatch 前**同步**清 `this.launch`/输入/mode；`.then` 链尾加 `.catch`（notice "Dispatch failed"）。
2. JSDoc：`launchForView` `@returns` → Promise 形状；`startHostUnderLease` `@returns` 修正。
3. decided-rejection 措辞：job-runner 的 run_started/finalize 处 `manual_fence`/`stale_run` 分支改 info 级 skipped diagnostic（或明确措辞 warn，不再用 "outcome unknown … replay will recover"）；state-runner 同类分支对齐。
4. void+catch pass：13 处 `markVisited?.()`、7 处 `service.reconcile()` 调用点加 `void …catch(() => {})`（仅吞 fs 类异常；调用点文件：dashboard.ts、attach-flow.ts、agent-board.ts、index.ts）。
- [ ] **验证**：受影响套件 + typecheck → Commit（`chore: post-merge hygiene wave — catch guards, dispatch double-submit window, honest diagnostics (issue #91)`）

---

### Task 5: 全量回归 + 验收对账

- [ ] `node --test test/*.test.mjs` 全绿 + `npm run typecheck` + 零测试进程泄漏（按 root 路径区分生产 coordinator）
- [ ] 对账写入 PR 描述：**根治条件 1/2/5 全闭合**（D3 弧线完成）；3/4/6 属 Phase 3-6；已知残留清单更新（硬宕窗口已关，剩「coordinator 永不回来」= 既有 fail-closed 语义）

## Self-Review 记录

- Spec 覆盖：根治条件 5 读侧 + §5 降级；不越界到 Phase 3-6。
- 接口一致性：`statusRevisionDesynced`/bootstrap 分支语义/`STATUS_BOOTSTRAP_KINDS` 在 Task 1/2/3 间一致。
- 无占位符；每个 hygiene 项独立可验证。
