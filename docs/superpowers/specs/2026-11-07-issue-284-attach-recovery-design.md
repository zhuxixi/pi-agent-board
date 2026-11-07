# Issue #284 Spec — attach UI 恢复预算与安全重评（路径 B）

Drafted: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-07T22:05:00+08:00
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-07T22:40:00+08:00（round-1 复核 R1-G1/G2/G3 接受修订，R1-D1 接受细化）
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-07T23:10:00+08:00（round-2 复核 R2-G1/G2/G3/G4 接受修订，R2-D1/D2 接受细化）
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-07T23:45:00+08:00（round-3 复核 R3-G1/G2 接受修订，R3-D1 接受措辞修正）
Base: main @ 6f7b2dc（#282/#283 已合并；#267 spec v4 SHA-256 9bc4d0f2… 为设计基线）
Status: v4-final（round-4 收敛：0 真缺口；收敛后吸收 R4-D1/D2 两处非阻塞细化：枚举补 unknown、live S/A 行号锚点 1319/1326）

## 0. 本 spec 与 #267 spec v4 的关系

本 spec 是 #267 路径 B 的独立实施设计，继承父 spec v4 的 D3/D4/D5 与验收矩阵 A06–A12+U1/U2，并按 #284 调研（`research/report.md`，main @ 6f7b2dc）把设计锚定到实际代码：**纯策略函数 `decideAttachPresentation`（`src/core/pty-attach-render.mjs:182`）、事实装配 `evaluateAttachReady()`（`src/ui/pty-attach.ts:1371`）、committed view 机制、以及 #265 的 cap 时 idle-downgrade 特判块都已存在**。本 spec 的改动是在这些既有结构上的增量，不是从零新建。父 spec §3（协议语义）、§6（U1/U2 步骤）、§8（风险反思）继续有效，本 spec 不重复，只做增量引用与锚定。

**降级语义的关键澄清（R1-G1）**：父 spec D3 条件 5 明确允许降级的 coverage 形态包括 candidate-open、candidate-aborted、缺少 witness 证据与已显式丢失 witness——即「runner 协议候选未结束」是**可降级**状态；必须继续等待的是「本地同步帧未闭合」（frameState/openSyncBlock）与「传输/解析/身份校验失败」（proofStatus=invalid）。两者在本 spec 中由不同谓词表达，不得混用。candidate-open/aborted 有**两种真实到达形状**（R2-G1）：快照内 `coverageFor` 产生的 `unavailable+candidate-*`，与 live 记录 `noteViewProofRecord`→`invalidateViewProof` 产生的 `unknown+candidate-*`——归纳表两者都归 missing。

## 1. 要解决的问题

#265 恢复了 F 门禁（busy attach P95 2541.6→54.1ms）并在 2500ms cap 提供了 idle downgrade，但降级出口太晚：**普通（非 fullscreen）会话的同尺寸 attach——子进程有输出、committed view 已安全、但不存在也不会有覆盖 F——仍要等满 `ATTACH_HARD_TIMEOUT_MS=2500` 才揭示**（`handleAttachHardTimeout` :1120-1140 特判块）。这是 #267 跟踪的 ~2500ms 残留的主要形态。

次要问题：capability loss（`frameWitness.enabled:false`，#280 后成为真实撤销路径）当前触发 `restoreLegacyDeadlines()` 回退 legacy 等待策略（:2349-2354），与现代协议的安全呈现路径不一致；且 `finishAttachTransition()` 将 `notReadyReason` 置 null，publish 时不区分「F 证明就绪」与「预算降级」，诊断无法回答「这次 attach 为什么显示了」。

## 2. 不变量（继承 + 新增）

继承父 spec §3 全部协议不变量（S/F 同 write 可能、A 非证明、openFrameId 仅协议层、geometry 门禁需真实目标 F、S 必须在 write 的 OPEN 偏移内联等——#280 已实现协议侧）。新增 UI 侧不变量：

- **I1（降级不伪造证明）**：`committed-degraded` 发布永不把 `latestViewProof.status` 改成 covered，永不写入 proof/marker/seq；它只发布已存在的 committed view。
- **I2（单次副作用）**：attach 转换副作用（`finishAttachTransition` 中的 color bridge、first-attach hooks 等）至多执行一次，降级路径与 F 路径共用同一入口。
- **I3（身份防栏）**：任何发布（含降级）必须通过 `canPublishAttachView(viewIdentity, currentIdentity)`；过期 token/callback、换代 baseline、reset 后的旧 view 一律拒绝。
- **I4（输入门禁不受降级影响）**：`childInputReady`、child 生命周期、selection/copy 视图来源、首 attach 副作用的既有门禁不因 committed-degraded 提前放行。
- **I5（预算不重置、不降低门禁）**：恢复预算从 attach 开始一次性计时，普通输出与重连（`startAttachSettle` 重入）不重置不延长；预算到期只新增「可降级」这一条出路，**不放宽 F 路径的任何既有门禁**——boot/raw/启动占位等内容等级拒绝是两条路径共享的前置门禁（见 3.1 谓词 7）。
- **I6（锁存与视图失效分层，R1-G3 + R2-D1 修订）**：失效分三层。**锁存层**：`witnessLatched`（本 attach 曾观察到 witness 能力）属于组件实例，只在 detach/dispose/新建 UI 组件时消失——同组件内的 socket/connection 重连**保留锁存**（重连不重置锁存，但旧 view/proof 失效）。**视图层**：baseline 替换、reset、resnapshot、connection 换代失效旧 view/旧 proof（凭新身份的新快照或合法闭合帧重建），不影响锁存。**失败事实层**：当前 baseline 的 invalid 分类（连续性/身份/校验失败）是 sticky 事实，capability loss 置空 `latestViewProof` 不抹掉它（见 3.1.1）。

## 3. 修复设计

### D3（修订版）：250ms 恢复预算 + 策略化的降级发布

**3.1 策略函数扩展（`decideAttachPresentation`，src/core/pty-attach-render.mjs）**

在既有谓词链（F 门禁 → `publish/"complete"`）之后、返回 wait 之前，新增降级谓词链。新增输入（全部为事实，策略保持纯函数）：

```text
witnessLatched?: boolean        // 本次 attach 曾观察到 witness 能力（见 3.3）
committedViewValid?: boolean    // committedView 非空且 canPublishAttachView 通过
committedViewSource?: "snapshot" | "sync-close" | "none"
committedViewCols/Rows?: number // committed view 的实际来源尺寸
committedContentKind?: "complete" | "boot" | "raw" | "partial" | "unknown"   // R2-G4 新增、R4-D1 补 unknown，见谓词 7
proofStatus?: "none" | "missing" | "invalid" | "covered"   // 见 3.1.1 归纳表
budgetElapsed?: boolean         // 恢复预算已到（timer 事实，非策略计时）
```

降级谓词链（全部满足才 `publish-degraded/"committed-degraded"`，任一不满足返回带具体原因的 wait）：

1. `mode === "protocol" && witnessLatched === true`；
2. `baselineState === "valid-content"`（empty baseline 保持等待）且 `localParseComplete === true`；
3. `frameState === "complete" && openSyncBlock !== true && committedViewValid === true`——本地 parser 事实（在途 write、未闭合本地同步帧必须等待）；**runner 协议候选状态不在此谓词**（candidate-open/aborted 经 proofStatus 走 3.1.1 的可降级分类，R1-G1 修订）；
4. `committedViewCols === targetCols && committedViewRows === targetRows && resizeIntentRequired !== true`（实际来源尺寸匹配；不能凭 identity 写入了 target 就推定源快照是目标尺寸——父 spec §8.5 反例）；
5. `proofStatus === "none" || proofStatus === "missing"`——仅「缺证据」可降级；`"invalid"`（传输/解析/身份校验失败，含 sticky invalid，见 3.1.1）必须继续等待（父 spec D3 条件 3 的区分）；
6. `budgetElapsed === true`；
7. `committedContentKind === "complete"`（R2-G4 新增、R3-G2 修订语义）——**本谓词的 "complete" 指本地闭合完整性，不声称语义级 boot/raw 识别**（无 F 时不可判定，见 §4 非目标）。可判定的生产装配规则：`commitCommittedView` 在提交时记录来源 `source`（"snapshot" | "sync-close"，新事实字段）；snapshot 来源（校验完整、非空、hydration 完成的快照）或 sync-close 来源（本地完整解析闭合的同步帧）→ "complete"；无法建立本地闭合完整性 → "unknown" → wait（fail-closed）；boot/raw/partial 保留为策略级防御值，当前生产装配不产出，未来出现可观测判定时再接入。与 F 路径的 boot-content/raw-content 拒绝构成两条路径共享的前置门禁（I5）。

优先级固定：F 路径谓词全过 → `publish/"complete"`（不等预算）；否则降级链全过 → `publish-degraded/"committed-degraded"`；否则 wait（reason 保留首个失败谓词）。每个拒绝原因必须在 A06/A08 有反例（可测性拆分见 §5）。

**3.1.1 proofStatus 归纳表（R1-G2 新增、R2-G1/G3、R3-G1 修订；新纯函数，独立单测）**

输入 `(latestViewProof, stickyInvalid)`，输出四分类。`classifyProofStatus(viewProof, stickyInvalid)` 为纯函数，与策略同层待新增。

**sticky 优先规则（R3-G1）**：`stickyInvalid === true` 时，**除 `status=covered` 外的任何输入——包括 candidate-open/aborted（双形状）、no-proof、no-output、null、以及一切未识别值——一律归 `invalid`**。sticky 不可被同 baseline 的后续非 covered 状态清洗。**清除条件只有两个**：当前 baseline 身份上出现 covered（真实 F 恢复），或 baseline 身份更换（resnapshot 接受新快照后凭新身份重新评估）。任何 invalid 分类（含未识别值 fail-closed）置 sticky（绑当前 baseline/视图身份）；capability loss 置空 latestViewProof 不清除（归纳表 null 行）。

非 sticky 时的基础分类表：

| 输入 | 归类 | 依据 |
|---|---|---|
| `null` 且 `stickyInvalid === false`（capability 撤销置空、初始未收到，且当前 baseline 无未恢复失败） | `none` | 父 spec：已显式丢失 witness / 缺少证据可降级 |
| `null` 且 `stickyInvalid === true` | `invalid` | R2-G3：loss 不能抹掉未恢复的失败事实，否则旧失败借降级绕过恢复（父 spec D3 条件 5 后半） |
| `status=covered`（exact-proof / safe-trailing） | `covered`（且清除 sticky） | F 健康路径；唯一恢复出口 |
| `unavailable + candidate-open`（快照内 coverageFor 形状） | `missing` | 父 spec 明确可降级 |
| `unavailable + candidate-aborted`（快照内 coverageFor 形状） | `missing` | 父 spec 明确可降级 |
| `unknown + candidate-open`（live 记录 `noteViewProofRecord(S)`→`invalidateViewProof` 形状，pty-attach.ts:1319） | `missing` | R2-G1：live S 的真实形状，同为「候选未结束」的可恢复状态 |
| `unknown + candidate-aborted`（live 记录 `noteViewProofRecord(A)` 形状，pty-attach.ts:1326） | `missing` | R2-G1：live A 的真实形状 |
| `unknown + no-proof` | `missing` | 有输出但从未有 proof 记录——缺证据 |
| `unknown + no-output` | `missing` | 无任何输出，无证据可判 |
| `unavailable + trailing-pending / trailing-unsafe` | `invalid`（置 sticky） | 需已有更早 proof（covered 后延伸），属「已覆盖又失效」——不绕过恢复 |
| `unknown + output-gap / journal-gap / journal-evicted / proof-evicted / snapshot-seq-future / snapshot-before-window / invalid-snapshot-seq` | `invalid`（置 sticky） | 连续性/窗口完整性存疑 |
| `unknown + invalid-view-proof / view-proof-future / records-dropped / proof-output-gap` | `invalid`（置 sticky） | 协议校验失败 |
| UI invalidateViewProof 的 `view-proof-replay-gap`、`view-proof-trailing-*` | `invalid`（置 sticky） | 传输/解析/身份校验失败 |
| **任何未识别的 status/reason** | `invalid`（置 sticky） | fail-closed，宁等不显 |

（表中各行在 `stickyInvalid === true` 时除 covered 行外均被 sticky 优先规则覆盖为 invalid。）

「covered 后又因身份/连续性失效」归类 invalid 且 sticky，与父 spec「不能借降级绕过恢复」一致。A06 对本表逐行断言（每行一个正例 + sticky 优先规则的清洗反例 + null×sticky 两态 + 未识别值默认 invalid 的 fail-closed 反例）。

**3.2 恢复预算 timer（组件层；R1-D1 + R2-G2 修订）**

- 新增独立常量 `ATTACH_RECOVERY_BUDGET_MS = 250`（策略数值待实施后按 U1 数据校准）；从 `attachStartedAt` 起算，**在 attach 首次启动时 arm 一次**（按 remaining 计算），普通输出不 defer，重连/`startAttachSettle` 重入**不重新 arm、不延长 deadline**（I5）；`finishAttachTransition`/detach/dispose 清理。
- **fence 生命周期（R2-G2）**：预算回调**不使用 `attachWaitToken` 防栏**（它在重连的 `startAttachSettle` 重入时递增，会与 armed-once 互相抵消——首次 arm 捕获的 token 过期、budgetElapsed 永不置位）。预算使用**独立的 attach 生命周期 fence**：回调仅校验 `attaching && !closed && budgetArmed`；预算事实（budgetElapsed）属 attach 生命周期，与连接换代无关；到期后旧连接的过期视图发布仍由 I3 的身份防栏（connectionToken）拦截。
- **待新增注入接缝**（现有 `attachStartedAt` 直取 `Date.now()`、timer 直用全局 `setTimeout`，`nowFn` 只服务 desync）：组件构造器增加可注入的 `now()` 与 scheduler（或等价 fake-timer 接线），A07 的 249/250ms 边界与预算生命周期测试全部走注入时钟，不依赖 wall clock。
- timer 回调：fence 校验 → `budgetElapsed = true` → `evaluateAttachReady()`。
- `handleAttachHardTimeout` 的 idle-downgrade 特判块（:1126-1140）**删除**，cap 到期只置 `deadlineState="expired"` 诊断后调用 `evaluateAttachReady()`——降级判定完全由策略承担（预算 2500ms 前早已过期，行为等价于「预算早已到、仍不满足谓词则继续等」）。legacy 分支行为不变。

**3.3 committed 路径锁存（组件层；R1-G3 + R2-D1 修订）**

- 新增 `witnessLatched` 状态：本次 attach 内 `frameWitnessAvailable` 首次变 true 时置位一次；**capability loss（`enabled:false`）不清除锁存、不调用 `restoreLegacyDeadlines()`**（当且仅当已锁存）——runner 撤销能力后 UI 继续走 committed 呈现路径。
- **锁存生命周期按 I6 三层**：**同组件内的 socket/connection 重连保留锁存**（重连是 connectionToken 递增 + `startAttachSettle` 重入，不新建组件），但旧 view/proof 按 I3 失效、凭新连接的新快照重建；baseline 替换、reset、resnapshot 同样只失效旧 view/proof，锁存保持；detach/dispose/新建 UI 组件才重置锁存（新 attach 重新观察能力）。
- 未协商协议 / 无 witness 能力 / parser observer 不支持的旧会话：`attachMode !== "protocol"` 或从未锁存——保留原 legacy 分支与 settle/hard 超时，锁存不影响它们。
- capability loss 后无新闭合帧则旧画面保留（不假装刷新）——此限制记录进诊断并由 U2 验证。

**3.4 readyReason 诊断字段**

`finishAttachTransition` 增加来源参数，发布时记录 `readyReason: "complete" | "committed-degraded" | "legacy-settle" | "legacy-cap"`（策略 publish → complete；publish-degraded → committed-degraded；legacy 两分支 → legacy-*）。`notReadyReason` 语义不变（等待原因）。诊断记录新增 `budgetDeadline` 与 `readyReason`，只记数值与有限枚举。

### D4（修订版）：统一汇合点重评

`evaluateAttachReady()` 已有 6 个调用点（capability 更新、baseline 状态、snapshot proof、proof payload、geometry satisfied、sync close）。本设计新增/调整：

- **新增**预算到期回调（3.2）；
- **新增** `commitCommittedView` 成功后的重评钩子（预算已到而视图刚提交的 quiet→late-snapshot 场景，不再等下一个 cap——父 spec D4「预算到期时没有可用视图，以后安全快照到达时立即重评」）；
- **保持**过期 callback 的 token/stream 身份防栏（既有 `attachWaitToken` 模式适用于连接相位回调；预算回调按 3.2 的独立 fence）；
- **语义**：预算到期时无可用视图只记「已到期」；之后任一汇合点到达即重评。持续输出每帧闭合 → 预算后下一个 sync close 发布最近已提交帧；输出始终未闭合 → 继续等待（不保证有界首屏）。

### D5（修订版）：诊断与性能范围

- 扩充既有 attach 诊断（非新增常驻服务）：`readyReason`、`budgetDeadline`、`witnessLatched`、`committedView` 的身份/实际尺寸/来源与内容等级、`proofStatus` 与 sticky-invalid 事实、既有 `deadlineState/notReadyReason/publishabilityState/latestViewProof` 全量保留。只记数值与有限枚举，不记 token、屏幕文本、密钥、整条终端数据。
- 性能目标范围不变：现代协议、同尺寸、安全快照已提交、受控无 F 场景——真实 socket 自动化首屏 <1500ms（调度余量）且证明未等 2500ms cap；纯策略精确断言预算边界（A06 用注入的 `budgetElapsed` 布尔，249/250ms 边界在组件 harness 用注入 clock 断言）；健康 F 路径证明在预算前完成。1500ms 不是产品目标，250ms 数值是待 U1 校准的策略选择。

## 4. 非目标

- 不改协议层（evaluator/reporter/hosted-frame-witness 的 #280 语义）。
- 不做通用 renderer、resize 协议、terminal parser 重写；不加后台服务或全局 watchdog。
- 不改 `childInputReady`/selection/copy/首 attach 副作用门禁（I4）。
- 不承诺 empty baseline、differing-size、未闭合输出的有界首屏；不承诺 legacy 会话 250ms。
- **不声称降级内容的语义级 boot/raw 识别**（R3-G2）：无 F 时生产代码无法判定内容是启动占位还是业务终帧——本设计的 "complete" 只指本地闭合完整性（快照校验完整非空 / 同步帧完整解析闭合）。残余风险（本地闭合但 producer 未完成的半帧被降级显示）是降级语义的固有部分，由 `readyReason=committed-degraded` 显式标记、由 U1 内容正确性样本与 U2 验证兜底，不伪装成已证实。
- 不把 `attach-frame-witness.real.test.mjs` 的绿灯当 U1 完成。

## 5. 验收矩阵与可测性拆分（A06–A12 + U1/U2）

自动化分层：策略 unit（纯函数语义）→ 组件 harness（真实 xterm + 注入 clock/timer，UI 状态转移）→ runner integration（真实双 main + 真实 socket + 真实组件，端到端时序）。

| ID | 功能点 | 层级与命令 | 通过标准 |
|---|---|---|---|
| A06 | D3 策略边界（unit）：budgetElapsed 注入布尔；F 先到立即 publish/"complete"；proofStatus=invalid 不降级；七条谓词各设反例（witnessLatched=false / baseline 非 valid-content / frameState 非 complete / committedViewValid=false / 尺寸不匹配或 resizeIntentRequired / budgetElapsed=false / **committedContentKind 为 boot、raw、partial、unknown** 各自 wait 且 reason 具体）；**candidate-open 与 candidate-aborted 双形状正向降级断言**（unavailable 与 unknown 两种到达形状，均经 proofStatus=missing）；**A/unavailable 不变为 covered（covered 只能来自真实 F，沿用父 spec 措辞）**；**committed-degraded 发布不改写 latestViewProof/proof/marker/seq（I1 独立断言）**；已 covered 但有其他门禁时 wait 不降级；**3.1.1 归纳表逐行断言 + sticky 优先规则清洗反例：同 baseline invalid 后到达 live S/A、no-proof、null 均归 invalid 不被清洗，预算与 cap 均不发布（R3-G1）**；null×sticky 两态；未识别 status/reason 默认 invalid 的 fail-closed 反例 | unit，`node --test test/attach-recovery.test.mjs`（新文件，直接测扩展后的 `decideAttachPresentation` 与新纯函数 `classifyProofStatus`） | 全部反例 wait 且 reason 命名谓词；降级仅七条全过；归纳表逐行符合；sticky 不可被非 covered 状态清洗 |
| A07 | D3/D4 组件行为（注入 clock）：quiet（预算到期回调发布）、每 25ms 完整帧持续输出（不重置预算、预算后下一 sync close 发布）、预算前/后才提交快照（late-snapshot 重评钩子）、249ms 不发布 250ms 发布、candidate-aborted 场景降级、**t<250ms 重连（`startAttachSettle` 重入）后预算仍在原 250ms deadline 到期（不延长）；旧连接回调不能发布**（R2-G2 成对断言）、**至少一条用例经真实 `viewProofRecord` 的 S/A 驱动 candidate 状态**（不伪造合成 proof 对象，R2-G1） | 组件 harness，`node --test test/attach-recovery.test.mjs test/attach-recovery-component.test.mjs test/pty-attach-parser-replacement.test.mjs`；新 harness `test/attach-recovery-component.test.mjs` 驱动 `test-support/attach-recovery-scenario.ts`（真实 xterm、**注入 now/scheduler**，模式参照 parser-replacement scenario），纳入 `npm test` | 首屏只取 committed 内容；预算不被输出/重连重置；晚到快照立即重评；重连保 deadline |
| A08 | D3/D4 反例（组件）：empty baseline、open sync、parser 在途、错代、reset/resnapshot、晚 callback（token 过期）、proofStatus=invalid、covered 又失效、**invalid→capability loss（proof 置 null）→ 预算与 cap 均不得发布（sticky-invalid 反例）**；**同 baseline invalid→live S/A 到达、invalid→no-proof 到达均不得发布（sticky 清洗反例，R3-G1）；随后当前 baseline covered 或 baseline 身份更换才清除**；**内容等级守卫用可观测事实驱动**（empty/占位 baseline → wait；committed view 的 source 字段记录 snapshot/sync-close，不手工伪造枚举装配，R3-G2）、producer 未完但合成 snapshot 已闭合（只 committed-degraded 非 proof-ready，后续完成可更新）、锁存后 capability loss 仍 committed 路径、loss → resnapshot/baseline 更换 → 新身份快照/合法闭合帧到达后继续 committed 更新（成对断言）、loss 后无闭合帧保留旧提交（成对断言）、**同组件重连保留锁存、旧 view/proof 失效需新快照**（R2-D1）、副作用至多一次、childInputReady 不被降级提前放行 | 组件 harness，命令同 A07 | 每反例保持 loading 或仅保留有效旧提交；不显示本地解析中状态；loss 后锁存与新身份重建共存；sticky invalid 不被 loss/后续 S/A/no-proof 清洗 |
| A09 | D3 geometry：same-size 零 resize/新 intent；错尺寸/错 intent/revision 的 F、A、loss、全部 timer 不解除 gate；真实 target F 才解除；源快照旧尺寸而 identity 已标当前 target 的反例不发布（I3+3.1 谓词 4） | integration + 组件，`node --test test/attach-frame-witness.integration.test.mjs test/pty-attach-parser-replacement.test.mjs` 及 A07 组件入口 | geometry proof 不可伪造 |
| A10 | D4 生命周期：detach/dispose 清 timer（含预算 timer）、失效→新 capability 不复活旧 view、连接/stream 换代旧身份不发布、新身份需新快照、legacy 不受锁存影响、降级后 selection/copy 与显示来源一致、预算 armed 一次（重复启动不重 arm）、**同组件重连保留锁存（R2-D1）** | 组件 harness，命令同 A07 | token fence 与身份防栏全过；预算一次性；重连保锁存 |
| A11 | D5 端到端：真实双 main、受控 S 后 quiet 与持续完整帧无 F（真实 coverage 含 live unknown/unavailable 双形状）——首屏 <1500ms、内容正确、readyReason=committed-degraded、证明未等 2500ms；healthy F 在预算前完成且 readyReason=complete；**断言保持外部 wall-clock（settledMs<1500ms、未等 2500ms），不用注入时钟、不放宽容差**（R2-D2）；flaky 治理靠确定性等待条件（poll 至 settle 条件）而非放宽门槛；**至少一条用例经真实 viewProofRecord S 驱动**（R2-G1） | integration，扩充 `test/attach-frame-witness.integration.test.mjs` 与 `test-support/attach-idle-socket-driver.ts`；**改写** :306「S-then-idle at the legacy cap」为预算断言 | <1500ms + readyReason 正确 + 无 2500ms 等待 |
| A12 | 回归总量：typecheck、perf gate、tests、coverage、pack:dry；legacy 反例、#227 Kitty 回归、#275 快速路径、leaked coordinators | `npm run verify`（实施 worktree 内） | 全过，不得只以 `npm test` 代替 |
| U1 | 全新 fullscreen 会话首次 attach 隔离试点（≥10 首次 + 10 reattach 样本，P50/P95、readyReason 分布、按父 spec §4.1 报告成功率） | 用户实测，步骤按父 spec §6（worktree 绝对路径 entry/runner、隔离 PI_CODING_AGENT_DIR/board root/socket） | 样本齐全如实报告；任何 >预算样本注明阻塞门禁 |
| U2 | 不同尺寸、旧新版本组合与故障恢复（target F 后正常、loss 不伪造 geometry、混合版本兼容、全旧组合 legacy 策略保留、锁存后 loss → resnapshot 恢复序列与无闭合帧旧画面限制确认） | 用户实测，步骤按父 spec §6 | 如实报告 |

**可测性拆分设计（硬约束）**：① 策略扩展保持纯函数——`budgetElapsed`/`witnessLatched`/`proofStatus`/`committedContentKind` 等全部由调用方装配为事实传入，策略内不读时钟不读 socket（A06 直接单测谓词矩阵）；② **`classifyProofStatus(viewProof, stickyInvalid)` 是独立纯函数**（3.1.1 表的唯一实现源），sticky 事实的记录/清除是组件层职责，独立单测；③ 预算 timer/fence/锁存/readyReason 属组件薄 I/O 层，经注入 now/scheduler 的组件 harness 测（A07/A08/A10），不进策略；④ 集成层只测协议端到端时序与诊断（A09/A11），不重复策略语义。实施不得把①②的纯函数逻辑耦合回组件。

## 6. 实施边界

- 允许改动：`src/core/pty-attach-render.mjs`（策略扩展）、新纯函数 `classifyProofStatus`（落位同文件或新 `src/core/attach-recovery.mjs`，实施计划定）、`src/ui/pty-attach.ts`（预算 timer 与独立 fence、锁存、sticky-invalid 事实、committedContentKind 装配、汇合点、readyReason、cap 特判删除、注入 now/scheduler 接缝）、上述测试与 test-support、诊断记录。
- 既有安全测试重写预期：`attach-frame-witness.integration.test.mjs:306` 及相关 cap 断言改为预算断言；empty/错尺寸/错代/解析未完反例**保留**。`attach-entry-22.test.mjs:100`（忙场景测量窗口）与 B/Q 200ms 发布预算经调研确认不受影响，**不改**；实施时如受影响按同一原则改写并说明。
- 保留 #227 grid/图像前缀与 bridge 生命周期、#275 快速路径。
- 提交按 task 分层可回退（策略+归纳函数 → 组件 → 集成/诊断），各阶段定向测试先行（TDD）；worktree 内实施，main 保持干净。

## 7. 风险与反例（增量引用父 spec §8）

父 spec §8.1–8.7 的风险与反例全部继续有效，本节只列锚定增量：

- **§8.1 提前呈现（最高风险）**：降级谓词链的每个「不满足即 wait」都是防提前呈现的反例；`proofStatus=invalid`（含 sticky invalid 的优先规则——同 baseline 后续 S/A/no-proof/loss 均不可清洗、trailing-pending/unsafe、连续性缺口、协议校验失败、未识别值 fail-closed）不可降级，防「传输坏但时间到了就显示」；内容等级守卫用可观测事实（本地闭合完整性 + source 字段），不虚构语义判定（R3-G2）；A08 逐反例覆盖。
- **§8.4 呈现锁存的新形态**：锁存后 capability loss 不回 legacy——若 runner 反复撤销/重建能力，UI 必须稳定停留在 committed 路径；loss 后 resnapshot 凭新身份重建 view（I6 分层），无新闭合帧时旧画面保留是**已知限制**，U2 专项确认，不作为缺陷掩盖。sticky invalid 在 loss 后保持，防「失败→撤销→降级」绕过链（R2-G3）。
- **#263 教训的延续**：降级出口必须保留（本设计把出口提前而非移除）；若 #284 后再出现「witness 停帧永久等待」，按序怀疑：proofStatus 归纳把可降级态误归 invalid（检查 3.1.1 表与真实 reason——含 unknown/unavailable 双形状——的对齐）→ sticky invalid 清除条件过严（清除只有 covered 与 baseline 更换两途）→ #280 协议修复未覆盖的新路径。
- **预算数值风险**：250ms 是策略选择非验证指标；U1 数据若显示 committed view 常晚于 250ms 才安全提交，调大预算或改「预算+最近闭合帧」语义，不在 U1 前硬编码调小。
