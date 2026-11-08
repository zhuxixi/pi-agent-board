# Issue #288 Spec — cap 地板降级：trailing-unsafe 锁死的解锁出口

Drafted: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-08T17:40:00+08:00
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-08T18:20:00+08:00（round-1 复核 R1-G1/G2/G3 接受修订，R1-D1/D2/D3 接受细化）
Base: main @ a439b36（#284/#285 已合并）
Status: v2-final（round-2 收敛：0 真缺口；收敛后吸收 R2-D1 细化：§0 总述限缩为 trailing-only 条件地板）

## 0. 关系与继承

本 spec 修复 #284 引入的回归（#288）：idle fullscreen 会话 reattach 因 `trailing-unsafe` proof 被归为 sticky invalid 而永久锁死。**全部继承 #284 spec v4-final 的不变量 I1–I6、归纳表与谓词语义**；本 spec 只做两处增量：D1 cap 地板降级、D2 等待态诊断落盘。trailing-only 条件下的 cap 出口由此恢复：对「trailing 家族失败、且其余六条降级谓词均满足」的 committed view，最坏约 2500ms 必能进入；hard 族、identity/geometry 失败、未闭合帧等仍按既有门禁等待（见 §3 I8 与 §4 非目标）。

## 1. 要解决的问题

现场与根因见 issue #288（live 探针证据：`unavailable + trailing-unsafe / csi-unknown`，proof 停在 seq 142，nvim idle 无 F，用户被锁在 attach 门外）。锁死链：恢复需要 F → F 需要子进程动 → 子进程动需要用户输入 → 输入需要 attach 成功。#284 把 trailing-* 归为 sticky invalid 在「连续性存疑」意义上正确，但没给这个家族留任何时间性出口——#263 教训（降级出口必须保留）被违反。

**trailing 失效的两种真实到达形状（R1-G2）**：runner 快照内 `coverageFor` 产生的 `unavailable + trailing-pending/trailing-unsafe`，与 UI 本地路径产生的 `unknown + view-proof-trailing-pending` / `unknown + view-proof-trailing-<reason>`（`noteViewProofOutput` 的 live 输出与 F 后 replay 产生）。cap 地板必须同时覆盖两者，否则第二条生产路径仍会锁死。

## 2. 修复设计

### D1：cap 地板降级（策略层 + 组件装配）

**新纯函数** `classifyProofInvalidFamily(viewProof) -> "trailing" | "hard" | null`（null = 输入非 invalid 形状）：

- trailing 家族（可被 cap 恢复）：`unavailable + trailing-pending / trailing-unsafe`（runner 快照形状）；`unknown + view-proof-trailing-pending`；`unknown + view-proof-trailing-<identifier>`（identifier 仅接受小写字母数字与连字符的严格形式——畸形值不进 trailing，防任意字节借前缀）。
- hard 家族（cap 不可恢复）：其余一切 invalid 归类（output-gap/journal-*/proof-evicted/snapshot-*/invalid-view-proof/view-proof-future/records-dropped/proof-output-gap/view-proof-replay-gap/未识别值）。
- fail-closed：未识别值 → `"hard"`。

**hard 占优的 baseline 锁存（R1-G1）**：组件维护 `proofHardInvalidatedThisBaseline`（绑定当前 baselineToken）：当前 baseline 上任何一次 `classifyProofInvalidFamily === "hard"` 的 invalid 分类即置位；**hard 占优——置位后即使后续形状变为 trailing/non-covered/loss 也不复位**；清除条件与 sticky 相同：仅 F 路径策略 publish 或 baseline 身份更换。策略新输入 `capRecoverable := !proofHardInvalidatedThisBaseline`（组件装配的布尔事实）。

**策略扩展**：`decideAttachPresentation` 新增可选输入 `capRecoverable`；谓词 5 修改为：

```text
deadlineState !== "expired" 时（现状不变）：
    proofStatus ∈ {none, missing} 才通过；invalid → wait "proof-status-invalid"
deadlineState === "expired" 时（cap 地板）：
    proofStatus ∈ {none, missing} ∪ {invalid ∧ capRecoverable === true} 通过；
    invalid ∧ capRecoverable !== true → wait "proof-status-invalid"
```

（expired 语义下 wait reason 沿用既有 `wait` helper 的 `deadline-expired:` 前缀规则——expired 分支的 hard-invalid 拒绝 reason 为 `deadline-expired:proof-status-invalid`，pending 分支为 `proof-status-invalid`，与既有组件断言的前缀约定一致，R1-D3。）

其余六条谓词（witnessLatched / baseline / 本地帧闭合+committedView / 尺寸+intent / budgetElapsed / committedContentKind）与优先级完全不变；budgetElapsed 在 cap 时必然已 true。cap-floor 走 `publish-degraded/"committed-degraded"`——readyReason 枚举不扩，靠同一条 settle 诊断记录的 `deadlineState:"expired"` + `proofStatus:"invalid"` 区分于预算降级。

**sticky 与 hard 锁存都不因 cap-floor 清除**：cap-floor 的 publish-degraded 不清除 `proofInvalidatedBaselineToken`、不清除 `proofHardInvalidatedThisBaseline`（只有 F 路径 publish 清除）。同 attach 周期内两个失败事实语义完全不变——R2-G3 的清洗绕过不因 cap 放宽重开，hard 失败也不能借后续 trailing 形状洗白（R1-G1）。

**identity/geometry 防栏不变**：`committedViewValid`（I3 身份）、尺寸谓词（§8.5 反例）在 cap 地板同样生效。

### D2：等待态诊断落盘（组件层）

**共享快照构造器（R1-D2）**：抽取 `buildAttachRecoveryFacts()`（#284 settle 诊断的枚举白名单、token 排除逻辑原样复用），两个薄包装分别发出：
- `attach_settle_ready`（现状）：facts + code/message + readyReason（非空）；
- `attach_wait_expired`（新）：facts + `details.phase: "budget" | "cap"`，**不含 readyReason**（等待态无该字段）；`onDiagnostic` 联合类型相应扩展。

两个触发点：预算到期回调（置 budgetElapsed 后，phase="budget"）；cap 到期（`handleAttachHardTimeout` protocol 分支的 `deadlineState="expired"` 赋值处，phase="cap"）。事件经现有 `onDiagnostic` 管道落 `views/<id>/diagnostics.jsonl`。等待中的 attach 从此有盘上证据。

## 3. 不变量（增量）

- **I7（cap 地板不洗任何失败事实）**：deadlineState=expired 只放宽谓词 5 的通过集；sticky 与 hard 锁存的置位/清除规则不变；cap-floor 发布后两者保持。
- **I8（hard 占优，R1-G1）**：当前 baseline 一旦出现 hard invalid，cap-floor 禁止直至 F publish 或 baseline 更换；纯 trailing-only 序列（含两种到达形状）才可被 cap 放行。hard 族 invalid 在 cap 后仍永久等待——那些形态下 committed view 的连续性疑点不能用时间消除；若它们也锁死用户，按 #288 的排查模式单独立案。
- **I9（trailing 家族的严格标识符）**：`view-proof-trailing-<identifier>` 只在接受小写字母数字与连字符时归 trailing；任何畸形/未识别值按 hard fail-closed。
- 继承 #284 I1–I6 全部。

## 4. 非目标

- 不改 250ms 预算路径的任何语义（missing 族照旧 250ms 降级）。
- 不识别 `csi-unknown` 的具体 CSI（trailing 扫描器 hygiene，后续单独处理）。
- 不为 hard 族 invalid 增加时间出口（I8）。
- 不改 legacy 分支、协议层、runner/reporter 语义（本修复纯 UI/策略层）。

## 5. 验收矩阵与可测性拆分

| ID | 功能点 | 层级与命令 | 通过标准 |
|---|---|---|---|
| A1 | D1 纯函数与策略：`classifyProofInvalidFamily` 逐形状断言（unavailable+trailing-pending/unsafe→trailing；unknown+view-proof-trailing-pending→trailing；unknown+view-proof-trailing-\<合法标识符\>→trailing；**畸形前缀值（大写/特殊字符/空）→hard**；全部 hard reason→hard；未识别值→hard；非 invalid 输入→null）。谓词 5 三态：pending 时 invalid 全 wait（reason=proof-status-invalid）；expired 时 invalid∧capRecoverable=true 通过、invalid∧capRecoverable≠true → wait（reason=**deadline-expired:**proof-status-invalid）；其余六谓词不因 cap 放宽 | unit，`node --test test/attach-recovery.test.mjs` | 反例全 wait 且 reason（含前缀）精确；cap 放宽仅 trailing-only |
| A2 | D1/D2 组件（注入 clock）：**trailing-only 序列**（快照形状与 UI live 形状各一：covered→live unsafe 输出（真实 noteViewProofOutput 路径）→idle→250ms 预算不发布→2500ms cap→publish-degraded、readyReason=committed-degraded、sticky 仍置位、hard 锁存未置位）；**hard 占优序列**：hard→trailing、trailing→hard、hard→loss/S/no-proof——cap 后均不发布；covered F publish 后两锁存清除、恢复正常降级 | 组件 harness，`node --test test/attach-recovery.test.mjs test/attach-recovery-component.test.mjs` | 预算拦、cap 放行 trailing-only、hard 占优全反例、sticky/hard 锁存语义 |
| A3 | D1 集成（真实双 main + 真实 socket）：trailing-only 锁死形态（至少一种 UI 到达形状）→ **settle ≤4000ms（外部 wall-clock，=2500ms cap + 1500ms 调度余量）**、断言 `deadlineState=expired ∧ budgetElapsed=true`、readyReason=committed-degraded、proofStatus=invalid；对照场景（candidate-open）**<1500ms 且 deadlineState=pending** 不回归 | integration，`node --test test/attach-frame-witness.integration.test.mjs`（扩充 driver 注入 trailing 形状） | 锁死形态 cap 内必然 settle；预算快路径不回归 |
| A4 | D2 诊断：budget 与 cap 两个 `attach_wait_expired` 事件按相位落盘、字段枚举白名单、无 readyReason 字段、无 token/屏幕文本；**budget→cap→settle 顺序断言**；settle 事件照旧 | 组件 harness + 集成（命令同 A2/A3） | 两相位事件齐、顺序正确、字段合规 |
| A5 | 回归总量：`npm run verify` 全过；#284 全部既有断言（预算语义、sticky 序列、锁存、geometry、既有 deadline-expired 前缀断言）不回归 | `npm run verify`（实施 worktree） | 全过 |
| U1 | 用户实测（**可执行前提，R1-G3**）：A5 全过后执行；**加载修复版 UI**——以实施 worktree 的绝对 `index.ts` 为 extensionEntry 启动隔离 pi（`--no-extensions --no-mcp --extension <绝对路径>`）或安装后 reload/重启，记录实际 SHA 与入口；本修复纯 UI/策略层不改 runner——复用原 a439b36 runner 现场（原 nvim 会话）或同 SHA 隔离 runner 均可，须记录选择了哪种；执行 #288 复现步骤（nvim idle→Alt+H→reattach）；检查 `~/.pi/agent/agent-board/views/<id>/diagnostics.jsonl` 出现 budget/cap 两相位 `attach_wait_expired` 与随后的 `attach_settle_ready`。加载前提未满足时 U1 标记待执行 | 用户实测 | 最坏 ~2.5s 进入、画面为 detach 前 committed view、诊断链齐全 |

**可测性拆分（硬约束）**：① `classifyProofInvalidFamily` 独立纯函数、独立单测（A1）；② hard 锁存/capRecoverable 装配为组件职责，经 harness 读数断言（A2），不进策略；③ `buildAttachRecoveryFacts` 共享构造器纯函数化，settle/wait 为薄包装（A4），不复制白名单逻辑；④ 组件/集成层只测时序与落盘。不得把①③耦合进组件。

## 6. 实施边界

- 允许改动：`src/core/attach-recovery.mjs`（新纯函数）、`src/core/pty-attach-render.mjs`（谓词 5 + `capRecoverable` 输入）、`src/ui/pty-attach.ts`（hard 锁存装配、共享 facts 构造器抽取、两处 wait 事件）、上述测试与 driver 扩充。
- 既有断言不改写（A5 守住 #284 语义与 deadline-expired 前缀约定）；spec 与 plan 落 worktree；commit 按纯函数/策略/组件/测试分层。
