# Implementation Plan — Issue #288: cap 地板降级（trailing-unsafe 锁死修复）

Work from: /home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-288-cap-floor-downgrade
Spec: docs/superpowers/specs/2026-11-08-issue-288-cap-floor-design.md（v2-final）
Base: main @ a439b36 · branch issue-288-cap-floor-downgrade
Conventions: tabs; node:test + assert/strict; conventional commits; TDD; never `git add -A`.

## 验收 ID ↔ Task 追溯

| 验收 ID | Tasks |
|---|---|
| A1（unit：家族函数 + 谓词三态） | T1 |
| A2（组件：trailing-only 放行 + hard 占优 + 双锁存） | T2 |
| A3（集成：≤4000ms cap settle + 对照） | T3 |
| A4（诊断：两相位 + 顺序） | T2（构造器与事件）、T3（集成断言） |
| A5（verify 总量） | T3 |
| U1（用户实测） | T4（试点提示，post-implementation pending） |

## T1 — `classifyProofInvalidFamily` 纯函数 + 谓词 5 cap 分支（A1）

**Files**: `src/core/attach-recovery.mjs`（新纯函数）、`src/core/pty-attach-render.mjs`（谓词 5 + `capRecoverable` 输入 + JSDoc）、`test/attach-recovery.test.mjs`
**Steps（TDD）**:
1. RED：A1 全部断言——家族函数逐形状（unavailable+trailing-pending/unsafe→trailing；unknown+view-proof-trailing-pending→trailing；unknown+view-proof-trailing-\<小写字母数字连字符\>→trailing；**畸形前缀**（大写/特殊字符/空 identifier/纯前缀）→hard；全部 hard reason（output-gap/journal-gap/journal-evicted/proof-evicted/snapshot-seq-future/snapshot-before-window/invalid-snapshot-seq/invalid-view-proof/view-proof-future/records-dropped/proof-output-gap/view-proof-replay-gap）→hard；未识别值→hard；非 invalid 输入（covered/missing 形状、null）→null）。谓词三态：pending 时 invalid（trailing 与 hard 皆）→ wait `proof-status-invalid`；expired 时 `invalid ∧ capRecoverable===true` → 通过谓词 5（后续谓词照常，全过 → publish-degraded）；`invalid ∧ capRecoverable!==true` → wait **`deadline-expired:proof-status-invalid`**；`capRecoverable` 缺省（undefined）时 expired invalid → 同 hard 拒绝（fail-closed）；其余六谓词不因 cap 放宽（各一反例）。
2. GREEN：实现家族函数（精确字符串表 + 严格 identifier 正则 `^[a-z0-9-]+$`）；谓词 5 按 spec §D1 分支。
**Verify**: `node --test test/attach-recovery.test.mjs`

## T2 — 组件 hard 锁存 + capRecoverable 装配 + 等待态诊断（A2、A4 构造器部分）

**Files**: `src/ui/pty-attach.ts`（`proofHardInvalidatedThisBaseline` 锁存、装配、`buildAttachRecoveryFacts` 抽取 + settle/wait 薄包装、budget/cap 两触发点、onDiagnostic 联合类型）、`test-support/attach-recovery-scenario.ts`（读数扩展：hardInvalidated、capRecoverable、wait 事件采集）、`test/attach-recovery-component.test.mjs`
**Steps（TDD）**:
1. RED→GREEN：hard 锁存生命周期（分类 invalid∧family=hard → 置位绑定 baselineToken；trailing/loss/S/no-proof 到达不清除；F 路径 publish 清除；baseline 更换重置）；`capRecoverable = !hardInvalidated` 装配进 `evaluateAttachReady` 的事实。
2. RED→GREEN（A2 序列，注入 clock）：**trailing-only**（快照形状 + UI live 形状各一：covered→真实 noteViewProofOutput unsafe 输出→idle→250ms 预算不发布→2500ms cap→publish-degraded、readyReason=committed-degraded、sticky 置位、hard 锁存未置位）；**hard 占优**（hard→trailing、trailing→hard、hard→loss、hard→S、hard→no-proof——cap 后均不发布）；covered F publish 后双锁存清除、恢复正常降级。
3. RED→GREEN（A4 构造器）：抽取 `buildAttachRecoveryFacts()`（现 settle 诊断的白名单/token 排除逻辑原样迁移）；`attach_wait_expired` 薄包装（`details.phase: "budget"|"cap"`，无 readyReason 字段）；budget 回调与 cap handler 两触发点发事件；组件测试断言 **budget→cap→settle 事件顺序**、字段枚举白名单、无 token。
**Verify**: `node --test test/attach-recovery.test.mjs test/attach-recovery-component.test.mjs`

## T3 — 集成 + verify 总量（A3、A4 集成断言、A5）

**Files**: `test/attach-frame-witness.integration.test.mjs`、`test-support/attach-idle-socket-driver.ts`
**Steps**:
1. RED→GREEN（A3）：双 main、真实 socket、注入 trailing-only 形状（至少一种 UI 到达形状）→ settle **≤4000ms（外部 wall-clock）**、断言 settle 诊断 `deadlineState=expired ∧ budgetElapsed=true`、readyReason=committed-degraded、proofStatus=invalid；对照场景（candidate-open）**<1500ms 且 deadlineState=pending**。确定性 poll、不注入时钟、不放宽容差（A3 的 4000ms 是设计内余量）。
2. A4 集成断言：diagnostics.jsonl（或 driver 采集）出现 budget/cap 两相位 `attach_wait_expired` + `attach_settle_ready` 顺序。
3. A5：`npm run verify` 全过；#284 既有断言零改写零回归（含 deadline-expired 前缀断言）。
**Verify**: `node --test test/attach-frame-witness.integration.test.mjs` + `npm run verify`

## T4 — U1 试点提示（pending）

PR body 注明 U1 步骤（spec §5 U1：A5 后、修复版 UI 加载方式与 SHA 记录、runner 复用策略、diagnostics 检查路径）；合并后提醒用户执行，未执行不得宣称验收完成。

## 提交粒度

T1 `feat: add proof invalid family classifier and cap-floor policy branch` → T2 `feat: latch hard proof invalidation and emit attach wait diagnostics` → T3 `test: assert cap-floor settle on real sockets across dual mains`。
