# Issue 145 Spec — 第 8 个语义状态 `holding`（搁置）+ 人工判定锁解封回归修复

> Issue: zhuxixi/pi-agent-board#145
> 基线：`main@c93307d`（chore: release 0.9.0 (#146)）
> 调研记录：`research/round1-fence-and-prereq-gap.md`、`research/round2-ui-and-callsites.md`
> 状态：待用户审阅（未提交任何仓库改动）

## 1. 意图与目标

看板的 **Done 分组不可信**：`completed` 被迫同时承载「真收工」和「先搁置」两种含义，用户无法回答「哪些是真的收工了」。

本 spec 交付两件事，按两个独立功能点验收：

1. **`F-hold`：新增第 8 个语义状态 `holding`**，人工独占——只有人能写、只有人能解，自动分类器永不产出，不参与自动续跑，不阻塞 attach 与 warm host 回收。
2. **`F-lift`：修复人工判定锁（manual fence）在用户交互路径上的解封缺口**。这是既有功能的**回归**（不是新功能依赖）：`service.syncForegroundEvent` 的 JSDoc 明写「Without this, a row that was completed/needs_input **can keep looking stale** after the user types a follow-up in the real Pi session」，而 fence 在 manually-judged 行上把这段能力完全废掉。

`F-hold` 的「说话即恢复」依赖 `F-lift`；但 `F-lift` 有独立价值，因此独立验收。

成功判据：面板能回答「哪些是真收工」；对已判定（Done / 搁置）的行说话，行状态跟随实际会话，不再出现「面板显示 Done 而 agent 在跑」。

## 2. 非目标

- **批量搁置**：select 模式不加 `h`，不做批量 holding 入口。
- **顶栏 / footer 计数**：holding 不进 `HeaderCounts`，也不进 `index.ts` 的 `setStatus`。
- **`mark_completed` 的 source 限制**：既有行为不动（只有新增的两个 kind 加用户来源守卫）。
- **恢复原状态**：`h` 解除搁置后回落 `idle`（Needs instructions），不记账、不恢复搁置前的状态。
- **`EvidenceOutcome` 之外的新契约**：不改 evidence 的其他字段。
- **多轮乱序 / coordinator 崩溃窗口**：既有架构行为，非本次回归。
- **`isManualCompletion` 的窄语义保留**：第 5.3 节给出结论（无窄语义调用点，直接改名）。

## 3. 决策记录

### 已拍板（用户 2026-09-29 确认）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 恢复模型 | **说话即恢复 + `h` 显式 toggle**。speak 走 F-lift 的解封机制；`h` 做 holding ⇄ idle 切换 |
| D2 | F-lift 修复范围 | **对所有人工判定生效**（completed 与 holding 一视同仁） |
| D3 | fence 调用点策略 | **全部宽化**：14 个调用点统一用宽谓词 `isManualVerdict()` |
| D4 | `d` 对 holding 的语义 | **转成真 `completed`**（零改动：`confirmDone` 只挡 completed，多选过滤也只排除 completed） |
| D5 | 展示位置与计数 | GROUP_ORDER 插在 `idle` 之后、`completed` 之前；顶栏不计数 |
| D6 | 按键与文案 | 键 `h`（已验证 list 模式空闲）；标签 `On hold` |
| D7 | 可转态范围 | **任何非 busy 状态**（与 `mark_completed` 的守卫对齐） |
| D8 | evidence 契约 | `outcome: "holding"` + `ready: true` |

### 实现级决策（本 spec 提出，待审阅）

| # | 决策 | 结论与理由 |
|---|---|---|
| D9 | 命令层形态 | **两个独立 kind**：`mark_holding`、`clear_holding`。分开而非一个带 boolean 的 kind——「解除搁置」是独立语义（把行交回自动管理、回到 Needs instructions），不是「非 holding」 |
| D10 | `clear_holding` 目标状态 | `idle`。`idle`（Needs instructions）的语义就是「run 结束了、没提出问题、等你下一句指令」，正是解除搁置后的状态 |
| D11 | summary 处理 | `mark_holding` 与 `clear_holding` **都保留既有 summary**，与 `mark_completed` 同构。状态变化由分组标题承载，不虚构 summary 规则 |
| D12 | 服务端解封机制 | **把镜像命令的 source 从 `service` 换成 `dashboard-user`**，不新增 command kind。依据：`sync_foreground` 的 source 白名单已含 `dashboard-user`；`stale_run` 守卫要求 `command.runId` 非空而该命令 `runId: null`，所以换 source **只穿过 `manual_fence` 这一道**（已逐行核对 `decideStateTransition` 守卫顺序） |
| D13 | 解封触发信号 | 子 Pi 的 **`InputEvent.source === "interactive"`**。pi 的既有类型 `InputSource = "interactive" \| "rpc" \| "extension"`，语义就是「用户输入 / RPC 注入 / 扩展注入」。比板子侧猜用户意图可靠 |
| D14 | 非用户来源的命令拒绝理由 | 新增 `source_not_allowed` 并加入 `DECIDED_REJECT_REASONS`。不复用 `field_not_allowed`（那是字段白名单语义）或 `manual_fence`（那是「行已被 fence」语义） |
| D15 | 窄谓词处置 | `isManualCompletion` **改名为 `isManualVerdict`**，不保留旧函数（无窄语义调用点，保留即死代码） |
| D16 | `canAutoDrain` 可测性 | 从 `service.mjs` **提取到 `src/core/warm-host-sweeper.mjs`** 并导出。它是纯行谓词（`isAgentBusy` + 状态白名单的组合），该模块已托管同类谓词（`hasPendingQuestions`、`isAgentBusy`）且是既有单测归宿（`test/warm-host-sweeper.test.mjs:105`）。模块名略有拉伸，是接受的取舍 |

**决策的衍生行为（评审补充，需要知晓）**：

- **D10 的衍生**：`clear_holding` 落到 `idle` 后，该行立即重新满足 `canAutoDrain`——若此前有排队 follow-up，下一次 reconcile（面板打开 / session_start / 各类触发点）会自动投递开跑。这与「解除搁置 = 交回自动管理」一致（un-hold 即 resume），但用户可能没预料到「按个 h 就自己跑起来了」；属设计内行为，A8 已锁定其谓词基础。
- **D7 的衍生**：从 `needs_input`（无 pendingQuestions、进程已退出的那种）置搁置会清掉 `question` 字段。上下文不丢——D11 保留 summary，且 attach 进真实会话后问题上下文仍在会话文件里；只是面板不再展示该问题。与 `mark_completed` 同构。

## 4. 契约

### 4.1 词表与类型契约

| 常量/类型 | 位置 | 变更 |
|---|---|---|
| `SemanticState` typedef | `src/core/types.mjs:6` | 手写联合类型加入 `"holding"`（**issue 正文漏项**；不加入会被 `GROUP_LABELS` 的 excess property check 拦住，但报错指向 `GROUP_LABELS` 而非根因） |
| `SEMANTIC_STATES` | `src/core/types.mjs:40` | 在 `idle` 之后插入 `"holding"` |
| `GROUP_ORDER` | `src/core/types.mjs:53` | 在 `idle` 与 `completed` 之间插入 `"holding"` |
| `GROUP_LABELS` | `src/core/types.mjs:64` | `holding: "On hold"` |
| `EvidenceOutcome` typedef | `src/core/types.mjs:14` | 加入 `"holding"`（该词表已含全部 7 个语义状态 + `unknown`/`in_progress`/`ready`，holding 走同一模式） |
| `STAGE_RGB` | `src/ui/dashboard.ts:1920` | 加 holding 色（建议 `[251, 191, 36]` 琥珀系，与 needs_input 的 `[245,158,11]` 区分）。**唯一编译期护栏**（`satisfies Record<keyof typeof GROUP_LABELS, ...>`） |

**不变项**：`AutoStateKind`（`src/core/auto-state.mjs:21`）保持 `needs_input|in_progress|done`；`semanticStateForAutoKind`（`:56`）永不返回 `holding`。

### 4.2 命令契约

新增两个 kind，加入 `STATE_COMMAND_KINDS`（`src/core/state-commands.mjs:36-50`）。

`mark_holding`：

```
source 守卫:  command.source !== "dashboard-user"  → reject("source_not_allowed")
busy 守卫:    currentState.processState === "alive" → reject("busy")
apply mutate: state: {
                semanticState: "holding",
                processState: "exited",
                needsInput: false,
                hasError: false,
                question: null,
                pendingQuestions: [],
                error: null,
                autoState: null,
              }
              status: { autoState: null }
```

`clear_holding`：

```
source 守卫:  command.source !== "dashboard-user"  → reject("source_not_allowed")
状态守卫:     currentState.semanticState !== "holding" → reject("no_change")
busy 守卫:    currentState.processState === "alive" → reject("busy")
apply mutate: state: {
                semanticState: "idle",
                processState: "exited",
                needsInput: false,
                hasError: false,
                question: null,
                pendingQuestions: [],
                error: null,
                autoState: null,
              }
              status: { autoState: null }
```

契约要点：
- `autoState: null` 是两个方向的**共同 fence 信号**，让 fence 语义与 `mark_completed` 完全同款。
- mutate 返回**完整字段集**（不是 diff）。coordinator 的 `materialize`（`runner/state-coordinator.mjs:346`）做 `{ ...state, ...mutate.state }` 稀疏合并，因此重复提交是幂等的，不需要 `no_change` 去重。
- `status: { autoState: null }` 沿用 `mark_completed` 的「patch 存在 ≠ 必须建文件」语义（`STATUS_BOOTSTRAP_KINDS` 不含这两个 kind），不为无 status 文件的 legacy 行伪造文件。
- 两个 kind 都加入 `LAST_ACTIVITY_STAMP_KINDS`（`runner/state-coordinator.mjs:72`），与 `mark_completed` 同构。

**协议版本**：新增 command kind ⇒ **`COORDINATOR_PROTOCOL_VERSION` 从 2 bump 到 3**（`src/core/coordinator-protocol.mjs:13`）。不 bump 的后果是 #108 的复现：detached 常驻的旧 coordinator pong 正常 → 被复用 → 新 kind 全部 `unknown_kind` 静默拒收，holding 写入永久失败且只有 warn 级 diagnostic。bump 后 `ensureCoordinator` 会 SIGTERM 旧实例再拉起（journal + boot replay 保证崩溃安全）。

**payload 校验**：两个 kind 都**不**新增 `validateCommand` 的 payload case（与 `mark_completed` 相同走 fall-through），payload 允许为 `{}`。

### 4.3 fence 契约（谓词泛化）

`src/core/auto-state.mjs`：

```js
export function isManualVerdict(state) {
	return Boolean(state && (state.semanticState === "completed" || state.semanticState === "holding") && state.autoState == null);
}
```

`isManualCompletion` 删除，14 个生产调用点全部改用 `isManualVerdict`（逐点判定见调研 round 2 第 4 节；结论是**无任何调用点需要窄语义**，每处意图都是「用户已作出终态判定，自动化别再动这一行」）。

权威守卫（`src/core/state-commands.mjs:280`）随之覆盖 holding：

```js
if (command.source !== "dashboard-user" && isManualVerdict(currentState)) {
	return reject("manual_fence");
}
```

守卫顺序不变：`unknown_view` → `revision_conflict` → `stale_run` → `manual_fence` → kind 分支。

### 4.4 解封契约（F-lift）

**触发条件**：`syncRowEvent` 收到 `event.type === "input" && event.source === "interactive"`。

**动作**：该次 `writeForegroundState` 发出的 `sync_foreground` 命令，source 用 `"dashboard-user"` 而非 `"service"`。

**覆盖面**：两条用户路径都会命中——attach 会话里直接敲字、`reply` 注入到存活 host。机制依据：`pty-runner` 对两者都执行 `child.write(msg.data)`（`runner/pty-runner.mjs:443`、`:1122-1138`），字节进入子 Pi 的 stdin，pi 一律报 `source: "interactive"`。

**不触发**：`rpc` / `extension` 来源的 input 事件，以及 `before_agent_start` / `agent_start`（这两个事件不带 source 字段，验证自 pi 的 d.ts）。

**会触发的三类投递**（三者都经 `child.write()` 进 PTY 字节，pi 一律报 `interactive`；评审时逐条核实）：

| 投递路径 | 性质 | 行为 |
|---|---|---|
| attach 会话里用户直接敲字 | 用户 | 解封——设计目标 |
| `reply` 的 `row.hostActive` 分支（`service.mjs:1617`） | 用户 | 解封——设计目标（D1 说话即恢复） |
| `drainNextFollowUp` 的 `row.hostActive` 分支（`service.mjs:1338-1360`）经 `sendHostInput` 注入 | 自动 | **也会解封**——见下 |

**自动续跑交互（评审发现，初稿此处结论写反了已修正）**：`canAutoDrain` 包含 `completed`，所以手动完成的行若有排队 follow-up，reconcile 会自动投递；该投递也是 PTY 字节，同样报 `interactive`，因此 F-lift 会在自动投递上触发，行从 Done 翻成 Running。

这是**既有不一致的修正**而非新破坏：对**没有存活 host** 的 completed 行，`drainNextFollowUp` 走 `launchHost` → `markQueued`（source `dashboard-user`，`service.mjs:217`）——**今天就已经解除 fence**、行进 Queued/Running；只有**有存活 host** 的 completed 行才出现「follow-up 实际执行、行冻在 Done」（本机诊断即此病态现场）。F-lift 把两条路径收敛到同一语义：行跟随现实。

**holding 不受自动投递影响**：`canAutoDrain` 白名单不含 holding，自动投递根本不会发生。已知窄竞态：`claimNextFollowUp` 之后、`sendHostInput` 落地之前用户恰好置搁置——此时注入仍触发 F-lift，行转 working。窗口为毫秒级，且此刻 follow-up 已被投递、行必然执行，转 working 是诚实状态；接受并记录。

**`ensureHost` 的 `markQueued: false` 保持不变**：attach 只看不敲不解封。issue 改动清单暗示要动这条路径；本设计刻意不动它，把解封时机后移到真实输入事件，语义更准（看不是意图，说才是）。

**时序说明**：`input` 事件先于 `before_agent_start` / `agent_start` 到达，所以后两者落地时行已解封。若跨 socket 顺序反转（当前实现中 `writeForegroundState` 同步算出投影、socket 写按调用顺序发出，实际不会反转），后到者会收到一次 `manual_fence` 拒绝并留一条 info 级诊断，**最终状态仍收敛正确**——这是接受的降级。

### 4.5 不变量契约（白名单，判定逻辑不改，只补测试）

| 谓词 | 位置 | 现状 | holding 的行为 |
|---|---|---|---|
| `isAgentBusy(row)` | `src/core/warm-host-sweeper.mjs:23-26` | `row.alive && (st === "queued" \|\| st === "working" \|\| hasPendingQuestions(row))` | **白名单**，holding 自然为 `false` → 可 attach、可标 done、warm host 照常按 TTL 回收 |
| `canAutoDrain(row)` | `src/runtime/service.mjs:2278-2281`（按 D16 迁到 `warm-host-sweeper.mjs`） | `!isAgentBusy(row) && (st === "idle" \|\| st === "completed")` | **白名单**，holding 自然为 `false` → 搁置行不被排队 follow-up 自动唤醒 |

两个谓词都是白名单，因此 holding 的排除是**结构性**的。本次只补回归测试锁定该性质，不动判定表达式（`canAutoDrain` 按 D16 换位置，表达式逐字符不变）。

**reconcile 安全性（评审核实）**：`reconcile()` 的 `looksActive`（`service.mjs:2023`）= `processState === "alive" || semanticState ∈ {queued, working}`——holding 行是 `exited`，不在其中，**整个 reconcile 循环跳过搁置行**，不会把它 finalize 成 failed/idle。F-lift 之后行进入 alive 路径，与既有前台镜像行为一致：host 存活时 `!row.hostAlive` 不成立、不触发 host 收尾分支；host 干净退出后由 `reconcile_finalize` 以 `idle` 收敛（均为既有语义）。reconcile 末尾的 follow-up drain 循环用 `canAutoDrain` 门控，holding 被排除。

### 4.6 已核实的实现前提

以下三条在 spec 审查期逐行核实，是本设计成立的前提，不需要改动：

- **`validateCommand` 只做全局 source 检查**（`src/core/state-commands.mjs:158`：`COMMAND_SOURCES.includes(raw.source)`），**没有 per-kind 的 source 限制**。所以 `sync_foreground` 携带 `source: "dashboard-user"` 能通过校验（D12 前提）。
- **`COORDINATOR_PROTOCOL_VERSION` 全仓按名引用，无硬编码字面量**（唯一出现 `protocolVersion: 1` 的是 `test/coordinator-client.test.mjs:399` 的「旧实例」故意构造）。bump 到 3 后，`test/coordinator-client.test.mjs:371` 的 `assert.equal(pong.protocolVersion, COORDINATOR_PROTOCOL_VERSION)` 自动适配。
- **`evidence.ready` 只有展示与过滤两处消费**（`src/ui/dashboard-evidence.mjs:16` 拼字符串、`src/core/rows.mjs:344` 的 `review:ready` 过滤器），**不参与任何功能门禁**。因此 D8 取 `ready: true` 不会意外唤醒任何自动行为。
- **D12 在三层全部验证通过（评审复核）**：① `validateCommand` 无 per-kind source 限制（见上）；② coordinator 外壳对 `command.source` **零消费**（`rg '\.source\b' runner/state-coordinator.mjs` 无命中，source 只在决策层 `decideStateTransition` 起作用）；③ `stale_run` 守卫要求 `command.runId` 非空而 `sync_foreground` 恒为 `runId: null`（`service.mjs:767`）。所以换 source 的全部效果就是穿过 `manual_fence` 这一道。
- **`projectViewState` 透传 `semanticState` 与 `autoState`**（`src/core/events.mjs:204`、`:220`），因此 input 分支算出的 `working` 投影落地后 `isManualVerdict` 为 false，行脱离 fence 的机制闭环。

### 4.7 命名消歧约定

「hold」在本仓库 attach 子系统已有既定含义：shrink-and-hold jiggle 协议（`src/core/pty-attach-jiggle-controller.mjs` 出现 39 次、`src/ui/pty-attach.ts` 9 次，指「attach 时把子终端缩到 (cols-1, rows-1) 并保持到收到 full clear」）。

约定：
- 语义状态在**代码标识符**里一律用 `holding` / `isHolding` / `markHolding` 这类完整词，**禁止**出现裸 `hold` 标识符。
- 注释与诊断消息里提到本状态时带上限定，如「on-hold semantic state」「搁置」，不写裸「hold」，避免与 jiggle 协议混淆。
- 该约定是文档纪律，无法机制强制；实现期的 CR 检查项之一。

### 4.8 UI 契约

| 位置 | 变更 |
|---|---|
| `dashboard.ts:355` `handleListKey` | 加 `if (data === "h") return this.toggleHold();` |
| `dashboard.ts` `handlePeekKey` | 加 `h` |
| `dashboard.ts` `handleSessionKey` | 加 `h`（对齐 `d` 的三处可用性） |
| `dashboard.ts:967` `confirmDone` | **不改**。holding 行天然通过（只挡 `completed`） |
| `dashboard.ts:985` `confirmDoneSelection` | **不改**。过滤条件只排除 `completed` |
| `dashboard.ts:1035` `confirmDeleteState` / `1017` `handleDeleteKey` / `confirmDeleteSelection` | **不改**。走 `rowState(row)` / `isAgentBusy`，自动泛化 |
| `service.markCompletedMany` | **不改**。只跳过 `completed` |
| `renderHelp`（`:1648`）+ hint 行（`:1316`） | 加 `h hold / unhold` 条目 |
| `HeaderCounts` / `headerStageSummary` / `index.ts:93-99` | **不改** |
| `src/runtime/service.mjs` | 新增 `holdView(viewId)` / `clearHoldView(viewId)`，模板 `completeView`（`:600`）：本地 `isAgentBusy` 快速预检查 + 提交命令 + `coordinator_disabled` 时的 `*Direct` 回退 |
| `src/ui/dashboard.ts` | 新增 `toggleHold()` |

新 UI 动作 `toggleHold()`：
- 当前状态是 `holding` → 发 `clear_holding`，notice「Resumed — needs instructions」
- 否则 → 发 `mark_holding`，notice「On hold」
- `isAgentBusy` → notice「Wait for the active run to finish before placing on hold」（与 `confirmDone` 同款措辞风格）

### 4.9 降级契约（`AGENT_BOARD_COORDINATOR=off` 逃生门）

- `holdView`/`clearHoldView` 需要 `holdViewDirect`/`clearHoldViewDirect` 直写 helper（与 `completeView` 的 `coordinator_disabled` 回退分支 `service.mjs:618-621` 并列），并在 `test/architecture-writer-boundary.test.mjs` 的 `WRITE_STATE_ALLOWLIST` 说明文字里归入既有的 coordinator_disabled 豁免条目（该文件的既有条目文字已概括 `*Direct` helpers，机制上不需要扩展，但文字保真度需要确认）。
- `job-runner.mjs:235/240` 的 legacy 直写守卫改用 `isManualVerdict`（宽语义）。
- **解封在直写模式下天然无操作**：`syncForegroundState` 的 `coordinator_disabled` 分支直接 `writeState(root, projected)`（`:772`），本来就不经过 fence。行为与 0.9.0 一致，只做回归验证。

## 5. 数据流

### 5.1 搁置写入

```
dashboard 按 h
  → service.holdView(viewId)
      → isAgentBusy(row) 本地预检查（快，给即时 UI 反馈）
      → sendStateCommand(mark_holding, source="dashboard-user")
          → validateCommand（kind 在 STATE_COMMAND_KINDS）
          → decideStateTransition
              unknown_view → revision_conflict → stale_run → manual_fence（用户来源直接过）
              → case "mark_holding": source 守卫 → busy 守卫 → apply
          → journal append + fsync → materialize（{...state, ...mutate.state}）
      → notice + refresh
```

### 5.2 说话即恢复（F-lift）

```
用户在 attach 会话里敲字 / reply 注入到存活 host
  → pty-runner: child.write(data) → 子 Pi stdin
  → 子 Pi 触发 pi.on("input") { source: "interactive" }
  → src/index.ts syncForeground → service.syncHostedEvent / syncForegroundEvent
  → syncRowEvent(row, event)
       reduceEvidence 直写（不受 fence 影响）
       event.type === "input" && event.source === "interactive"
         → status 置 working / alive / "Running…"
         → writeForegroundState(row, status, { source: "dashboard-user" })
             projectViewState → sync_foreground(source="dashboard-user", runId=null)
             → 通用 manual_fence 守卫放行（用户来源）
             → materialize：semanticState 变 "working" → 行脱离 fence
  → 后续 tool/message/agent_end 事件照常镜像（行已 unfenced）
```

## 6. 改动清单

### 词汇层（机械，多数静默失败）

- `src/core/types.mjs`：`SemanticState:6`、`EvidenceOutcome:14`、`SEMANTIC_STATES:40`、`GROUP_ORDER:53`、`GROUP_LABELS:64`
- `src/core/rows.mjs`：`stateGlyph:67`、`stateColor:93`（**两者都有 `default` 兜底，漏改不报错**）
- `src/core/derive.mjs`：`GENERIC_STATUS_TEXT:16`（加入 `holding: new Set(["On hold"])`，遵循该表只增不减的兼容模式）、`fallbackStatusText:46`
- `src/core/evidence.mjs:223-224`：`outcome`、`ready`
- `src/ui/dashboard.ts:1920-1933`：`STAGE_RGB`（唯一编译期护栏）

### 锁层（高风险）

- `src/core/auto-state.mjs`：`isManualCompletion:200` → `isManualVerdict`；`:214`、`:239` 两个调用点
- `src/core/state-commands.mjs`：`DECIDED_REJECT_REASONS:71`（加 `source_not_allowed`）、`STATE_COMMAND_KINDS:36`（加两个 kind）、泛化守卫 `:280`、新增两个 kind 分支（模板 `mark_completed:284-304`）
- `src/core/coordinator-protocol.mjs:13`：`COORDINATOR_PROTOCOL_VERSION` 2 → 3
- `runner/state-coordinator.mjs:72`：`LAST_ACTIVITY_STAMP_KINDS` 加 `mark_holding`、`clear_holding`
- `src/runtime/service.mjs`：新增 `holdView`/`clearHoldView`（模板 `completeView:600`）+ 两个 `*Direct` helper；`syncRowEvent:1444` 的来源判定；`writeForegroundState:745` 增加 source 参数；`canAutoDrain:2278` 迁出
- `src/core/warm-host-sweeper.mjs`：接收 `canAutoDrain`
- `runner/job-runner.mjs`：8 个调用点（`:187`、`:235`、`:240`、`:471`、`:501`、`:659`、`:680`、`:714`）
- `runner/state-runner.mjs:34`

### UI / 文档

- `src/ui/dashboard.ts`：`toggleHold`、`handleListKey`、`handlePeekKey`、`handleSessionKey`、`renderHelp`、hint 行
- `README.md`：状态表（`:204-213`）、主列表键位表、`d`/`X`/多选的说明段、过滤示例
- `CHANGELOG.md`：由 release 工具生成，本 PR 不手改

### 测试

- `test/state-commands.test.mjs`（决策层，最大改动面）。注意 `:53-58` 是 `STATE_COMMAND_KINDS` 快照断言，加两个 kind 必须同步更新
- `test/auto-state.test.mjs`（谓词真值表）
- `test/rows.test.mjs`（glyph/color/过滤别名/分组顺序）
- `test/derive.test.mjs`（`fallbackStatusText`/`GENERIC_STATUS_TEXT`）
- `test/evidence.test.mjs`（outcome/ready）——**issue 正文未列，本次补**
- `test/warm-host-sweeper.test.mjs`（`isAgentBusy` + `canAutoDrain`）——**issue 正文未列，本次补**
- `test/service.test.mjs`（`holdView`/`clearHoldView`/解封路径）
- `test/host-input.test.mjs`（`canAutoDrain` 门禁回归）——**issue 正文未列，本次补**
- `test/state-coordinator.integration.test.mjs`（A8 回归 + 新 kind 的真实协调器路径）
- `test/runner.integration.test.mjs`（post-exit 不覆盖、follow-up 不续跑）
- `test/dashboard-navigation.test.mjs`（`h` 键接线，A21；复用 `test-support/navigation-wrap.ts` 探针基座）——**issue 正文未列，评审补**
- `test/coordinator-client.test.mjs`（协议版本 bump 的既有断言自动适配，需确认）

## 7. 风险与缓解

| 风险 | 后果 | 缓解 |
|---|---|---|
| **fence 泛化漏掉一个调用点** | 用户搁置/完成后几十秒，迟到的自动分类把它改回去，且无报错 | D3 全宽化 + D15 改名（旧函数不存在 ⇒ 漏改会 typecheck 失败而非静默）。这是本次最大的风险，也是「改名而非并存」的主要理由 |
| **协议版本未 bump** | 旧 coordinator 静默 `unknown_kind` 拒收，holding 写入永久失败（#108 复现） | 列为硬性改动项；A 矩阵加一条断言 `COORDINATOR_PROTOCOL_VERSION >= 3` |
| **解封信号被误用** | 程序化注入解除用户搁置 | 只认 `source === "interactive"`；A 矩阵补 `rpc`/`extension` 反例 |
| **解封削弱 A8 不变量** | 迟到的自动分类重新能覆盖人工判定 | 解封只换 `sync_foreground` 的来源，`sync_foreground` 不携带 autoState 分类结果；A8 既有用例作为回归门禁（A5） |
| **`canAutoDrain` 迁址引入循环依赖** | 构建失败 | `warm-host-sweeper.mjs` 已被 service.mjs 依赖，方向不变 |
| **过滤别名碰撞** | `s:h` 命中歧义 | 已分析：现有 7 状态无一以 h 开头；D6 标签 `On hold` 归一化 `onhold` 无碰撞 |
| **与 attach 子系统既有「hold」术语撞名** | 注释/诊断里把 shutdown-and-hold jiggle 协议与搁置状态混为一谈，排障时误导 | 4.7 的命名消歧约定；列为 CR 检查项 |
| **F-lift 在自动投递的 follow-up 上也触发**（评审发现，见 §4.4） | 用户标完成的行因排队 follow-up 自动从 Done 翻成 Running，可能被视为「状态自己变了」 | 已论证是对既有不一致的修正（host-less 路径今天就会经 `mark_queued` 解封）；U7 的对照步骤实测确认 |

## 8. 可测性拆分设计（自动化验证类功能点）

| 功能点 | 独立单元 | 测试边界 |
|---|---|---|
| 人工判定谓词 | `isManualVerdict(state)` — 纯函数，导出 | 真值表：`{completed, holding} × {autoState null / 非 null} × {其他 5 状态} × {null/undefined}` |
| 命令决策 | `decideStateTransition(command, state, status, now)` — 已是纯函数，零 I/O | 构造 command/state 直接断言 `{action, reason, mutate}`；守卫顺序用「同时满足多个拒绝条件」的用例锁定 |
| 来源守卫 | 同上（`source_not_allowed` 分支） | 对**未 fence** 的行发非用户来源的 `mark_holding` → 仍拒绝（证明不是靠 fence 顺带拦住） |
| 分类器不产出 holding | `semanticStateForAutoKind(kind)` — 纯函数 | 遍历 `AUTO_STATE_KINDS` 断言返回值永不为 `holding` |
| busy 契约 | `isAgentBusy(row)` — 纯函数，已导出 | holding 行为 `false`；`idle`/`completed`/`failed`/`stopped` 在 `alive: false` 下同样为 `false`（原语义不回归） |
| 续跑门禁 | `canAutoDrain(row)` — 纯谓词（D16 提取并导出） | 6 个语义状态 × `alive` 真/假的矩阵断言；holding 恒为 `false`；`idle`/`completed` 非 busy 时恒为 `true`（防白名单被改成黑名单） |
| 渲染词表 | `stateGlyph` / `stateColor` / `fallbackStatusText` — 纯函数 | 断言 holding 的返回值**不等于** `default` 分支值（`"?"` / `"text"` / `undefined`），把「静默失败」变成显式断言 |
| 编译期护栏 | `STAGE_RGB satisfies Record<keyof typeof GROUP_LABELS, ...>` | `npm run typecheck`；另加一条断言 `COORDINATOR_PROTOCOL_VERSION >= 3` |
| evidence 契约 | `finalizeEvidence(snapshot, status, now)` — 纯函数 | 构造 status 断言 outcome/ready |
| 过滤别名 | `parseFilter(query)` — 纯函数 | `s:holding`/`s:hold`/`s:onhold` 各只命中 holding；反向断言不命中其他 7 状态 |
| 服务层动作 | `createService(opts)` 注入 fake `sendStateCommand` | 断言提交的命令 kind/source/payload 形状；`coordinator_disabled` 分支走 `*Direct` |
| 解封集成 | 真实 coordinator（复用 `startTrackedCoordinator` + `waitFor` 基座） | 见 A3/A4/A5/A6 |
| 直写模式不回归 | `service(root, { coordinatorDisabled-ish })` 或注入 | 既有 `syncForegroundEvent` 用例全部保持绿 |

关键：**解封的集成用例必须能红**。做法是用「fenced 行 + interactive input 事件」构造场景，在未实现 F-lift 时该用例必然得到 `manual_fence` 拒绝与冻结的行状态，实现后收敛到 `working`——红/绿自证，不依赖时序竞态、非 flaky。

## 9. 验收矩阵

### 自动化验证

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | `isManualVerdict` 真值表 | unit | `node --test test/auto-state.test.mjs` | holding/completed × autoState 的 4 组合为 true/false 正确；其余 5 状态恒 false；`null`/`undefined` 为 false |
| A2 | `mark_holding` 决策 | unit | `node --test test/state-commands.test.mjs` | 非 busy 行 apply，mutate 字段集与 `mark_completed` 逐字段同形 + `semanticState: "holding"` + `autoState: null`；`processState: "alive"` → `reject("busy")` |
| A3 | `clear_holding` 决策 | unit | 同上 | holding 行 apply → `semanticState: "idle"`；非 holding 行 → `reject("no_change")`；alive → `reject("busy")` |
| A4 | 来源守卫（独立于 fence） | unit | 同上 | 对**未 fence** 的 idle 行发 `source: "job-runner"` 的 `mark_holding`/`clear_holding` → `reject("source_not_allowed")`；`source_not_allowed` ∈ `DECIDED_REJECT_REASONS` |
| A5 | fence 泛化 · 决策层 | unit | 同上 | 非用户来源的任意 kind 撞 holding 行 → `reject("manual_fence")`；用户来源同一命令放行 |
| A6 | fence 泛化 · 分类器 | unit | `node --test test/auto-state.test.mjs` | `applyAutoStateToViewState`/`applyAutoStateToStatus` 对 holding 行返回 `false` 且不改字段 |
| A7 | 分类器永不产出 holding | unit | 同上 | 遍历 `AUTO_STATE_KINDS`，`semanticStateForAutoKind` 返回值永不为 `holding`；`STATE_COMMAND_KINDS`/`AUTO_STATE_KINDS` 词表快照 |
| A8 | busy / 续跑门禁 | unit | `node --test test/warm-host-sweeper.test.mjs test/host-input.test.mjs` | `isAgentBusy(holding) === false`；`canAutoDrain(holding) === false`；`canAutoDrain(idle 非 busy) === canAutoDrain(completed 非 busy) === true`（白名单未被改成黑名单） |
| A9 | 渲染词表无静默兜底 | unit | `node --test test/rows.test.mjs test/derive.test.mjs` | `stateGlyph`/`stateColor`/`fallbackStatusText` 对 holding 的返回值不等于各自 default 分支值 |
| A10 | 分组顺序与标签 | unit | `node --test test/rows.test.mjs` | `GROUP_ORDER` 中 `idle < holding < completed`；`GROUP_LABELS.holding === "On hold"`；holding 行落在独立分组 |
| A11 | 过滤别名 | unit | 同上 | `s:holding`/`s:hold`/`s:onhold`/`s:on` 各只命中 holding；均不命中其他 7 状态 |
| A12 | evidence 契约 | unit | `node --test test/evidence.test.mjs` | holding → `outcome === "holding"`、`ready === true`；completed/idle 既有取值不变 |
| A13 | 协议版本 | unit + build | `node --test test/coordinator-client.test.mjs` + `npm run typecheck` | `COORDINATOR_PROTOCOL_VERSION >= 3`；pong 断言自动适配新版本 |
| A14 | 解封 · 集成（**红/绿自证**） | integration | `node --test test/state-coordinator.integration.test.mjs` | fenced holding 行 + `input{source:"interactive"}` → 行收敛 `working`，且 `diagnostics.jsonl` 无 `manual_fence` 拒绝记录；**未实现 F-lift 时该用例必失败** |
| A15 | 解封 · 反例 | unit + integration | 同上 + `test/service.test.mjs` | `input{source:"rpc"}` / `input{source:"extension"}` / `before_agent_start` 撞 fenced 行 → 仍 `manual_fence` 拒绝，行保持 holding |
| A16 | 解封 · 既有 completed 回归 | integration | `node --test test/service.test.mjs` | Done 行 + interactive input → 解封并收敛 `working`（证明 F-lift 对所有人工判定生效，非仅 holding） |
| A17 | A8 不变量不回归 | integration | `node --test test/state-coordinator.integration.test.mjs` | 既有「迟到 `auto_state_classified` → `manual_fence`」用例（`:308-310`、`:542-577`）保持绿；coordinator 重启后 journal 重放仍拒 |
| A18 | runner 侧不覆盖 / 不续跑 | integration | `node --test test/runner.integration.test.mjs` | post-exit pass 不覆盖 holding；holding 行不被 `drainQueuedFollowUp` 自动续跑 |
| A19 | 直写模式不回归 | unit | `node --test test/service.test.mjs` | `coordinator_disabled` 下 `syncForegroundEvent` 行为与 0.9.0 一致；`write_state` 架构守卫（`test/architecture-writer-boundary.test.mjs`）保持绿 |
| A20 | 全量回归 | build | `npm run verify` | typecheck + perf gate + tests + coverage 阈值（lines 85 / funcs 80 / branches 70）+ pack:dry 全绿 |
| A21 | `h` 键接线（评审补） | unit | `node --test test/dashboard-navigation.test.mjs`（新增用例，复用 `test-support/navigation-wrap.ts` 探针基座注入 fake service） | list/peek/session 三模式按 `h` 各自提交 `mark_holding` / `clear_holding`；busy 行只给 notice 不发命令；`isPrintable` 兜底不再拦截 `h` |

### 用户实测

| ID | 功能点 | 验收方式 | 操作步骤 | 观察结果 / 通过标准 |
|----|--------|----------|----------|---------------------|
| U1 | `h` 置搁置 | 用户实测 | 在面板 list 选中一个非 busy 行，按 `h` | 行进入 **ON HOLD** 分组（位置在 NEEDS INSTRUCTIONS 之后、DONE 之前）；顶栏与 footer 计数不变；notice 提示已搁置 |
| U2 | `h` 解除搁置 | 用户实测 | 对 ON HOLD 行再按 `h` | 行回到 **NEEDS INSTRUCTIONS** 分组；notice 提示已恢复 |
| U3 | 说话即恢复（holding） | 用户实测 | 对 ON HOLD 行按 `→` attach，在真实会话里敲一句话提交 | 行变为 **RUNNING**；该行 `diagnostics.jsonl` **不再新增** `sync_foreground rejected (manual_fence)` |
| U4 | 说话即恢复（既存回归） | 用户实测 | 对 **DONE** 行 attach 后敲字提交 | 同上（行变 RUNNING、无新 manual_fence 拒绝）。这条是本 PR 修的既有 bug，与 holding 无关也应通过 |
| U5 | `d` 转真完成 | 用户实测 | 对 ON HOLD 行按 `d` 并确认 | 行进入 **DONE** 分组；`state.json` 的 `semanticState === "completed"` |
| U6 | 搁置行可删 | 用户实测 | 对 ON HOLD 行按 `X` | 该状态全部 inactive 行被归档；live 行跳过 |
| U7 | 搁置行 + follow-up 不自动唤醒（含 Done 行对照） | 用户实测 | 给 ON HOLD 行排队一条 follow-up（先使其 busy 时 reply，或 `delivery: "queue"`），再置搁置，等待；**对照**：另一条 Done 行同样排队 follow-up 且 host 存活，等待 reconcile | 主行保持 ON HOLD，不被自动唤醒，队列计数保留；对照行 follow-up 被投递且行变 RUNNING（§4.4 自动投递交互的实测） |

**验收纪律**：U 项未执行前不得宣称验收完成；自动化项通过不能替代 U 项。

## 10. 开放问题

1. **`STAGE_RGB.holding` 的具体色值**：建议 `[251, 191, 36]`（琥珀系，与 needs_input 的橙 `[245,158,11]` 区分）。属视觉偏好，可在实现期调整。
2. **U7 的可操作性**：构造「holding + 排队 follow-up」需要特定前置（该行存在 queued follow-up 且进程已退出）。若实测难以构造，降级为 A18 覆盖 + 标记 U7 为 pending。
3. **`test/architecture-writer-boundary.test.mjs` 的说明文字**：新增两个 `*Direct` helper 后，该文件的豁免条目文字是否需要在注释里枚举新名称（机制上不需要，文字保真度需要）。
4. **`canAutoDrain` 迁址 vs 原地导出**：D16 选了迁址。若审阅认为模块名拉伸不可接受，退回「在 service.mjs 原地 `export function canAutoDrain`」——测试边界不变，只是归宿不同。
