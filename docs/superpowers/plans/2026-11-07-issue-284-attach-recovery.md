# Implementation Plan — Issue #284: attach UI 恢复预算与安全重评

Work from: /home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-284-attach-recovery-budget
Spec: docs/superpowers/specs/2026-11-07-issue-284-attach-recovery-design.md（v4-final, SHA-256 90a72c27…）
Base: main @ 6f7b2dc · branch issue-284-attach-recovery-budget
Conventions: tabs for indentation; node:test + assert/strict; conventional commits; TDD (red → green per task); never `git add -A`.

## 验收 ID ↔ Task 双向追溯

| 验收 ID | Tasks |
|---|---|
| A06（策略 unit） | T1（归纳表）、T2（谓词链） |
| A07（组件行为/预算） | T3（harness 骨架）、T4（预算 timer/fence） |
| A08（组件反例/锁存/sticky） | T5（锁存）、T6（装配与 wiring）、T3–T6 共用 harness |
| A09（geometry） | T8（integration 扩充） |
| A10（生命周期） | T4、T5 |
| A11（端到端/诊断） | T7（readyReason/诊断）、T8 |
| A12（verify 总量） | T9 |
| U1/U2（用户实测） | T10（试点准备，post-implementation pending） |

## T1 — `classifyProofStatus` 纯函数（A06：3.1.1 归纳表）

**Files**: new `src/core/attach-recovery.mjs`；new `test/attach-recovery.test.mjs`
**Steps**:
1. RED: `test/attach-recovery.test.mjs` 按 spec §3.1.1 逐行写断言——14 行基础表（unavailable/unknown 双形状 candidate-*、no-proof、no-output、trailing-*、output-gap 系、校验失败系、UI invalidateViewProof 系、未识别值）；sticky 优先规则（sticky=true 时除 covered 外全部 invalid：含 live S/A、no-proof、null、未识别）；null×sticky 两态；covered 清除 sticky。
2. GREEN: 实现 `classifyProofStatus(viewProof, stickyInvalid)`——签名 `(latestViewProof: object|null, stickyInvalid: boolean) => "none"|"missing"|"invalid"|"covered"`；sticky 优先判断在最前（除 `status==="covered"` 外一律 invalid）；reason 匹配用精确字符串表，任何未命中 → invalid（fail-closed）。
3. 导出 JSDoc（枚举来源锚定 attach-view-proof.mjs coverageFor 与 terminal-attach-client.mjs 校验 reason）。
**Verify**: `node --test test/attach-recovery.test.mjs`
**Refs**: A06（归纳表部分）

## T2 — `decideAttachPresentation` 降级链扩展（A06：谓词链）

**Files**: `src/core/pty-attach-render.mjs`；`test/attach-recovery.test.mjs`
**Steps**:
1. RED: 断言七条谓词各自反例（witnessLatched=false / baselineState 非 valid-content / frameState 非 complete 或 openSyncBlock / committedViewValid=false / 尺寸不匹配或 resizeIntentRequired / proofStatus=invalid / budgetElapsed=false / committedContentKind∈{boot,raw,partial,unknown}）→ 各自 wait 且 reason 命名谓词；candidate-open/aborted 双形状（经 proofStatus=missing）正向 → `publish-degraded/"committed-degraded"`；F 路径全过 → `publish/"complete"` 不等预算；proofStatus=covered 但其他门禁不满足 → wait 不降级；A/unavailable 不变为 covered（covered 只来自真实 F）；I1 独立断言（策略不写 proof——纯函数无副作用，断言返回值不含改写指令）。
2. GREEN: 新增输入 `witnessLatched/committedViewValid/committedViewSource/committedViewCols/Rows/committedContentKind/proofStatus/budgetElapsed`；在既有 F 链后加降级链；新 action `publish-degraded`；wait reason 沿用谓词命名。既有 F 路径行为与既有测试（`test/pty-attach-render-decision.test.mjs`）不变。
**Verify**: `node --test test/attach-recovery.test.mjs test/pty-attach-render-decision.test.mjs`
**Refs**: A06（谓词部分）

## T3 — 组件 harness 骨架（A07/A08/A10 测试载体）

**Files**: new `test-support/attach-recovery-scenario.ts`；new `test/attach-recovery-component.test.mjs`
**Steps**:
1. 参照 `test-support/pty-attach-parser-replacement-scenario.ts` 的 `--experimental-transform-types` 子进程模式：真实 xterm headless + PtyAttachComponent 私有状态驱动 + **注入 now()/scheduler**（构造器新接缝按 T4 落地，此处先定义协议：scenario 通过工厂参数传入 fake clock 与 timer 队列）。
2. scenario 提供事件原语：connect/hello/snapshotReady（含 viewProof 形状参数：unavailable/unknown 双形状）、output chunk（seq 递增）、S/A/F record（真实 `viewProofRecord` 路径）、capability enable/disable（enabled:true/false）、geometry、reconnect（connectionToken 递增 + startAttachSettle 重入）、advanceClock(ms)（推进 fake timer 队列）。
3. RED→GREEN: harness 冒烟用例——注入 clock 下 legacy settle 行为不变（对照基线）；`npm test` 能枚举新文件（run-tests.mjs 自动发现）。
**Verify**: `node --test test/attach-recovery-component.test.mjs`；`npm test` 枚举确认
**Refs**: A07/A08/A10（载体）

## T4 — 预算 timer、独立 fence、注入接缝（A07 预算生命周期 + A10）

**Files**: `src/ui/pty-attach.ts`；`test/attach-recovery-component.test.mjs`
**Steps**:
1. 组件构造器增加可注入 `now()`（默认 Date.now）与 scheduler（默认全局 setTimeout/clearTimeout）；`ATTACH_RECOVERY_BUDGET_MS = 250` 常量。
2. attach 首次启动时 arm 预算一次（按 attachStartedAt remaining）；**独立 fence**：回调只校验 `attaching && !closed && budgetArmed`，不用 attachWaitToken；`finishAttachTransition`/detach/dispose 清理；重连/`startAttachSettle` 重入不重 arm 不延长。
3. RED→GREEN（harness，注入 clock）: quiet 场景 249ms 不发布、250ms 到期回调置 budgetElapsed 并 evaluateAttachReady → committed-degraded 发布；t<250ms 重连后预算仍在原 deadline 到期（不延长）；重连后旧连接回调不能发布（I3 身份防栏）。每 25ms 完整帧持续输出不重置预算、预算后下一 sync close 发布最近已提交帧；预算后才提交快照 → commitCommittedView 钩子立即重评。
**Verify**: `node --test test/attach-recovery-component.test.mjs`
**Refs**: A07（预算生命周期全部）、A10（armed-once、清理）

## T5 — witnessLatched 与三层失效（A08/A10：锁存层）

**Files**: `src/ui/pty-attach.ts`；`test/attach-recovery-component.test.mjs`
**Steps**:
1. `witnessLatched`：本次 attach 首次 `frameWitnessAvailable=true` 置位；已锁存时 capability loss（enabled:false）**不**调 `restoreLegacyDeadlines()`、不清锁存、不清 `deadlineState` 语义（committed 路径继续）；未锁存（legacy/无 witness）行为完全不变。
2. 三层失效：同组件 reconnect 保留锁存、旧 view/proof 失效需新快照；resnapshot/reset/baseline 更换只失效旧 view/proof（凭新身份重建）不清锁存；detach/dispose 清理。
3. RED→GREEN: loss 后仍 committed 路径；loss → resnapshot → 新身份快照/合法闭合帧 → 继续 committed 更新（成对）；loss 后无闭合帧保留旧提交（成对）；reconnect 保留锁存（A10）；legacy 分支不受锁存影响；降级后 selection/copy 与显示来源一致、childInputReady 不被提前放行、首次副作用至多一次。
**Verify**: `node --test test/attach-recovery-component.test.mjs`
**Refs**: A08（锁存序列）、A10（同组件重连）

## T6 — proofStatus/sticky/committedContentKind 装配与 evaluateAttachReady wiring（A08：失败事实层 + 汇合点）

**Files**: `src/ui/pty-attach.ts`；`test/attach-recovery-component.test.mjs`
**Steps**:
1. `proofInvalidatedThisBaseline` sticky 事实：classifyProofStatus 结果为 invalid 时置位（绑当前 baseline/视图身份）；清除仅凭当前 baseline covered 或 baseline 身份更换。capability loss 置空 latestViewProof 不清除。
2. `commitCommittedView` 记录 `source`（"snapshot" | "sync-close"）与来源尺寸（committedViewCols/Rows）；`committedContentKind` 装配：校验完整非空快照或本地完整解析闭合 → "complete"，否则 "unknown"（不产出 boot/raw/partial）。
3. `evaluateAttachReady` 装配新输入（witnessLatched/committedViewValid/source/尺寸/committedContentKind/proofStatus/classify 结果/budgetElapsed）并调扩展后策略；**删除 `handleAttachHardTimeout` 的 idle-downgrade 特判块**（cap 只置 deadlineState=expired 诊断后 evaluateAttachReady）；`commitCommittedView` 成功后的重评钩子。
4. RED→GREEN: 同 baseline invalid→live S/A 到达、invalid→no-proof 到达、invalid→loss（null）三种清洗反例均不发布（预算与 cap 都到也不发）；随后 covered 或 baseline 更换才恢复；empty/占位 baseline → wait；covered 又失效不绕过；producer 未完但合成 snapshot 闭合 → 只 committed-degraded 非 proof-ready，后续完成可更新。
**Verify**: `node --test test/attach-recovery.test.mjs test/attach-recovery-component.test.mjs`
**Refs**: A08（sticky/装配/反例）

## T7 — readyReason 与诊断扩充（A11 诊断部分）

**Files**: `src/ui/pty-attach.ts`；`test/attach-recovery-component.test.mjs`
**Steps**:
1. `finishAttachTransition` 增加来源参数；`readyReason: complete|committed-degraded|legacy-settle|legacy-cap` 记录；`notReadyReason` 语义不变。
2. 诊断记录新增 `budgetDeadline`、`readyReason`、`witnessLatched`、committedView 身份/实际尺寸/来源、proofStatus 与 sticky-invalid（只记数值与有限枚举）。
3. RED→GREEN: 各 readyReason 值在对应路径记录正确（F 路径 complete、降级 committed-degraded、legacy 两分支）；诊断不含 token/屏幕文本/密钥。
**Verify**: `node --test test/attach-recovery-component.test.mjs`
**Refs**: A11（诊断）、D5

## T8 — 集成：A09 geometry + A11 端到端 + 改写 legacy-cap 用例

**Files**: `test/attach-frame-witness.integration.test.mjs`；`test-support/attach-idle-socket-driver.ts`；`test/attach-recovery-component.test.mjs`（A09 组件侧）
**Steps**:
1. **改写** `:306`「S-then-idle … at the legacy cap」为预算断言：真实双 main、受控 S 后 quiet（真实 coverage 即 live unknown+candidate-open）→ 首屏 <1500ms（外部 wall-clock settledMs，不注入时钟不放宽容差；flaky 靠确定性等待条件 poll 至 settle）、readyReason=committed-degraded、断言未等 2500ms（hard timeout 未触发即已 settle）；healthy F 用例在预算前完成且 readyReason=complete。至少一条经真实 viewProofRecord S 驱动。
2. 扩充 `attach-idle-socket-driver.ts`：记录各层状态、时间与 readyReason；持续完整帧无 F 场景（预算后下一闭合帧发布）。
3. A09：same-size 零 resize/新 intent；错尺寸/错 intent/revision 的 F、A、loss、全部 timer 不解除 gate；真实 target F 才解除；源快照旧尺寸而 identity 已标当前 target 的反例不发布。
4. empty/错代/解析未完等既有反例**保留**（按新语义核对断言文案）。
**Verify**: `node --test test/attach-frame-witness.integration.test.mjs test/pty-attach-parser-replacement.test.mjs test/attach-recovery-component.test.mjs`
**Refs**: A09、A11（全部）

## T9 — 回归总量（A12）

**Steps**: 在 worktree 执行 `npm run verify`（typecheck、perf gate、tests、coverage lines85/funcs80/branches70、pack:dry）；检查 legacy 无 witness/无协议、observer 不支持、no-resize、host/runner generation、leaked coordinators 既有断言仍在；#227 Kitty 回归与 #275 快速路径不回归；`attach-entry-22.test.mjs`（忙场景）确认不受影响（如受影响按 spec §6 原则改写并在 PR 说明）。
**Verify**: `npm run verify` 全绿
**Refs**: A12

## T10 — U1/U2 试点准备（post-implementation，pending）

**Steps**: 产出试点脚本/说明（worktree 绝对路径 extensionEntry/runner、隔离 PI_CODING_AGENT_DIR/board root/socket、三类样本采集：新建首次 attach / 同尺寸 reattach / 不同尺寸首次 attach，≥10+10 样本、P50/P95、readyReason 分布）；U1/U2 标记 **pending** 直至用户执行——自动化绿灯与 U1/U2 互不替代。
**Refs**: U1、U2

## Task 顺序与提交粒度

T1 → T2 →（T3 → T4 → T5 → T6 → T7 组件线，其中 T3 先行）→ T8 → T9 → T10。每 task 一个 conventional commit（`test:`/`feat:`/`fix:` 前缀 + `(#284)` 尾缀留待 PR squash 前统一处理——按仓例 commit message 不带 issue 号，PR 标题带）。中途 `git status --short` 检查无意外文件；只 `git add <明确文件>`。
