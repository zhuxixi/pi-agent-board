# Issue #297 根因报告与修复 Spec — 看板镜像 compaction 窗口

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-16T22:24:08+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-16T22:43:40+08:00（round-1：接受 R1-G1/G2/G3 修订与 R1-D1–D6 细化，spec 升 v2）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-16T23:12:00+08:00（round-2：0 真缺口；吸收 R2-D1，U1 前置去掉不存在的 `npm run build`）
Base: main @ 608a22a（0.13.1）
Status: v2-final（round-2 收敛：0 真缺口、1 细化已吸收）

## 0. 一句话结论

给两条事件通路（interactive/hosted 扩展钩子、JSON runner 流）各加一个 compaction 窗口的**状态标记**：窗口内把行置为 `working` 并显示 `Compacting context…`，窗口结束时按「压缩前状态」恢复；标记里持久化压缩前快照（含 `processState`），因此两条通路共用同一套 reducer 语义，且 `isAgentBusy` 派生出的全部忙守卫自动恢复。

## 1. 根因

看板没有订阅 compaction 事件，不是镜像逻辑写错（证据与代码坐标见 issue #297 与本目录 `research/root-cause.md`）：

- 扩展事件通路只注册了 8 个事件（`src/index.ts:238-244`），compaction 的扩展钩子 `session_before_compact` / `session_compact` / `session_compact_failed` 未被注册。
- JSON 通路 `reduceEvent`（`src/core/events.mjs:144`）没有 `compaction_start` / `compaction_end` 分支。
- `syncRowEvent`（`src/runtime/service.mjs:1849`）只在 `input | before_agent_start | agent_start` 时置 `working`。

后果不只是标签：`isAgentBusy()`（`src/core/warm-host-sweeper.mjs:23`）只认 `queued/working`，压缩期间 mark-done / hold / follow-up drain / warm-host 驱逐保护 / header Running 计数全部把行当作空闲。

pi 侧事件时序（1.5.2 `dist/core/agent-session.js`）：

- interactive 手动 `/compact`：`compaction_start` → `session_before_compact` → 摘要生成 → `session_compact`；失败时触发 `session_compact_failed`（`errorMessage` 已带 `Compaction failed: ` 前缀；`aborted` 表示取消）。
- interactive 自动压缩（threshold/overflow）：同样先 `session_before_compact`，成功 `session_compact`，失败 `session_compact_failed`；`willRetry=true` 表示压缩后要重试被中断的 turn。
- JSON/RPC：只发 `compaction_start` / `compaction_end`（`{reason, result|undefined, aborted, willRetry, errorMessage?}`）。
- 手动压缩在 `prepareCompaction` 失败（如「Nothing to compact」）时**仍会**走 catch 分支发 `compaction_end` + `session_compact_failed`，因此不会留下「永远 Compacting」的悬空窗口——但这也意味着 begin 与 end 之间可能只隔毫秒级（R1-G2 的竞态来源）。

## 2. 修复设计

### D1 — 新增 compaction 窗口字段（ViewState + RunStatus）

```js
/**
 * @typedef {Object} CompactionWindow
 * @property {"running"|"failed"} phase
 * @property {"manual"|"threshold"|"overflow"} reason
 * @property {number} startedAt
 * @property {{semanticState:SemanticState, processState:ProcessState, summary:string,
 *             question:string|null, error:string|null}|null} previous
 *        压缩前快照（含 processState，R1-G3）。failed 标记也保留它：重试成功后恢复压缩前的 error，
 *        而不是把 `Compaction failed: …` 留在行上（CR round-1 advisory）。
 * @property {string|null} error 仅 phase "failed"：pi 的 errorMessage 原文。
 */
```

- `ViewState` 新增可选 `compaction`；`RunStatus` 新增 `compaction`。
- `createRunStatus` / `blankState` 初始化为 `null`；**`statusFromRow` 读穿现有值** `compaction: s.compaction ?? null`（R1-D1：这里不是「初始化 null」，否则 begin 落盘的 marker 在下一个事件重建时丢失）。
- `projectViewState` 透传 `compaction: status.compaction ?? null`。
- `src/core/foreground-projection-cache.mjs` 的 `CACHED_FIELDS` 白名单**必须加入 `"compaction"`**（R1-G2）：前台通路 `syncRowEvent` 入口会 `adopt` 缓存覆盖白名单字段做 read-your-writes 纠正（issue #225 机制），白名单漏掉该字段会让「begin 写盘在途时 end 到达」的毫秒级失败路径丢掉 marker，随后落入 previous 缺失分支，idle 行卡在 working + `Compacting context…`。
- 旧行无该字段：读取时按 `?? null` 容忍，**不做迁移、不写版本号**。

### D2 — 纯函数语义（events.mjs，两条通路共用）

`beginCompaction(status, { reason }, now)`：

- 已有 marker 且 `phase === "running"`（重复/嵌套 before_compact）：**不覆盖** `previous`（I3），只刷新 `lastActivityAt`。
- 已有 marker 且 `phase === "failed"`（失败后用户立刻重试 `/compact`，或自动压缩失败后 pi 再次触发）：**视为新窗口**——用当前（已恢复的）状态重拍快照，`phase` 置 `"running"`（R1-D2）。
- 无 marker：快照 `previous = { semanticState, processState, summary, question, error }`，`phase="running"`，`startedAt=now`。
- 统一置 `semanticState="working"`、`processState="alive"`、`lastActivityAt=now`，`summary = deriveSummary(status)`。
- 不动 `pendingQuestions`、`latestAssistantPreview`、`latestTool`、evidence。

`endCompaction(status, { willRetry, aborted, errorMessage }, now)`：

- `previous` 缺失（没等到 begin 落盘 / 迟到 end）：清标记，保持 `working`，交给后续 `agent_end` 或 reconcile 收敛（这是唯一无法从快照恢复的分支，见 R1-G2 的缓存白名单消除主要来源）。
- `willRetry === true`：清标记、保持 `working`（run 会重试）。**有意丢弃 `errorMessage`**：重试会把该错误盖掉，写进行里只会误导（R1-D2，A2 有断言）。
- 否则 `previous.semanticState ∈ {queued, working}`：清标记、`semanticState="working"`、`processState="alive"`，summary 用 `deriveSummary`。
- 否则（resting 态）：恢复 `semanticState / processState / question / error`，`summary = previous.summary || deriveSummary(status)`（R1-G3：`processState` 必须回到快照值，否则 idle 行会留下假 `alive`，导致 `row.alive`、reconcile 的 `looksActive`、dashboard stop 守卫全部误判）。
- `aborted === true`：按上面的恢复规则收尾，**不**写 `error`、**不**留 failed 标记（pi 的语义是「Compaction cancelled」）。
- `!aborted && errorMessage`：先按恢复规则回落，再写 `status.error = errorMessage`，留 `compaction = { phase:"failed", reason, startedAt:now, previous:null, error:errorMessage }`，**并在同一函数内 `status.summary = deriveSummary(status)`**（R1-G1：前台薄壳不经过 `reduceEvent` 的尾巴，失败文案只能由这里产出）。
- 所有分支清 `lastActivityAt = now`。

`finalizeRun`：清 `compaction = null`（终态不可能仍在压缩）。

### D3 — summary 派生与归属（derive.mjs + events.mjs）

`deriveSummary` 的首个分支（**先于** currentTool / preview）：

- `phase === "running"` → `"Compacting context…"`（对齐 pi 自己的状态文案）。
- `phase === "failed"` → `truncate(error, max)`（pi 的 `errorMessage` 已自带 `Compaction failed: ` 前缀，不再二次拼接）。

**summary 归属（R1-D3）**：compaction 窗口的两个 helper 是 summary 的唯一生产者。`reduceEvent` 末尾的 `if (meaningful) status.summary = deriveSummary(status)` 对 `compaction_start` / `compaction_end` 两个事件**跳过**（用局部标记），否则 JSON 通路会重派生、吃掉 `endCompaction` 刚恢复的 `previous.summary`，与前台通路行为分裂。

failed 标记的清除：`reduceEvent` 末尾计算 summary 之前（非 compaction 事件且 `meaningful`）清标记再派生；前台通路在 `syncRowEvent` 入口清除非 compaction 事件带来的残留标记。失败提示只活到下一次真实活动为止。

### D4 — 扩展事件通路（src/index.ts + service.mjs）

- `src/index.ts` 追加三个注册，全部复用现有 `syncForeground`（hosted 走 `syncHostedEvent`，普通会话走 `syncForegroundEvent`）：
  `session_before_compact` / `session_compact` / `session_compact_failed`。
  处理器**不返回**任何值（不 cancel、不提供自定义 compaction）。
- `syncRowEvent` 追加三个分支，各 3–6 行薄壳：构造 facts → 调 D2 的纯函数 → `writeForegroundState` → `return true`：
  - `session_before_compact` → `beginCompaction(status, { reason: event.reason }, now)`
  - `session_compact` → `endCompaction(status, { willRetry: event.willRetry }, now)`
  - `session_compact_failed` → `endCompaction(status, { willRetry: event.willRetry, aborted: event.aborted, errorMessage: event.errorMessage ?? null }, now)`
- 入口清理规则：`if (status.compaction && !COMPACTION_EVENTS.has(event.type)) status.compaction = null;`（COMPACTION_EVENTS = 上述三个），保证 abandon 的 running 标记/残留 failed 标记不会跨真实事件存活。
- `index.ts` 的注册名由 A6 静态断言覆盖（R1-D4：注册层不进 service harness，拼写错误不能只等用户实测发现）。

### D5 — JSON 通路（events.mjs reduceEvent）

- `case "compaction_start"`：`beginCompaction(status, { reason: event.reason }, now)`，`meaningful = true`，标记「本次 summary 已由 helper 产出」。
- `case "compaction_end"`：`endCompaction(status, { willRetry, aborted, errorMessage }, now)`，`meaningful = true`，同样跳过尾巴重派生（D3）。

D2/D3 的语义在两条通路上完全相同；`runner/job-runner.mjs` 不需要改（beat 把整份 status 当作 patch，`applyStatusProjection` 泛型合并后由 `projectViewState` 投影）。

### D6 — 不改动的层（明确排除）

- `isAgentBusy` 及其全部调用点：**读的是 semanticState，不是 compaction 字段**；本修复只通过置 `working` 生效。
- coordinator 决策层与 `PATCHABLE_FIELDS` 白名单：`sync_foreground` 是全量投影（`state-commands.mjs:612-618`），`run_progress` 是泛型 `diffFields` 合并，新字段无需白名单（R1-P1 已逐条核对）。
- evidence / session view / attach 通路：compaction 不产生 evidence 变化。

## 3. 不变量

- **I1（窗口只动展示态）**：compaction 窗口内只允许改 `semanticState / processState / summary / lastActivityAt / compaction`；`pendingQuestions`、`latestAssistantPreview`、`latestTool`、evidence 保持原样。
- **I2（忙判据不扩语义）**：忙守卫仍只读 `semanticState ∈ {queued, working}`；`compaction` 字段不参与任何守卫判断。
- **I3（快照一次性）**：同一 running 窗口内重复 `before_compact`/`compaction_start` 不覆盖 `previous`；只有 failed 残留会被视为新窗口。
- **I4（恢复有条件）**：压缩前是 resting 态（`idle/needs_input/completed/failed/stopped/holding`）→ 恢复该态及其 `processState`；压缩前是 `queued/working` 或 `willRetry` → 保持 `working/alive`，交由后续 `agent_end` 收尾。
- **I5（失败不伪造终态）**：压缩失败只写 `error` 与失败 summary，不把行改成 `failed` 语义态（会话本身仍可用）；`willRetry` 时连 error 也不写。
- **I6（终态不残留）**：`finalizeRun` 必清 `compaction`；任何真实活动事件都会清掉 failed 标记。
- **I7（旧行兼容）**：缺失字段按 `null` 解释，不迁移、不改 version。
- **I8（summary 单一生产者）**：窗口内 summary 只由 D2 helper 产出，两条通路的尾巴都不得重派生。

## 4. 非目标

- 不显示压缩进度百分比、token 数、耗时、成本。
- 不处理 `summarization_retry_*`（pi 的重试提示不进看板），也不把压缩尝试渲染成独立行。
- 不改 mark-done / hold / follow-up / attach 的任何语义或文案。
- 不为 JSON runner 增加手动 `/compact` 能力（该通路本就没有斜杠命令）。
- 不改 dashboard 分组规则、header 计数公式、evidence 聚合。

## 5. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | `deriveSummary` 的 compaction 文案与优先级 | 自动化验证（unit） | `node --test test/derive.test.mjs` | running→`Compacting context…`；failed→`error` 原文（不二次加前缀）；无标记时既有断言全过；优先级高于 currentTool/preview |
| A2 | D2/D3 reducer 语义（两条通路共用的纯函数） | 自动化验证（unit） | `node --test test/events.test.mjs` | `beginCompaction`：快照含 processState、running 幂等、failed 残留→新窗口；`endCompaction`：resting 恢复（含 `processState` 回到快照值）/ mid-run 保持 working+alive / `willRetry` 保持并**丢弃 errorMessage** / `aborted` 恢复且无 error / `errorMessage`→failed 标记 + `error` + summary=error 原文 / previous 缺失→保持 working；`finalizeRun` 清标记；`projectViewState` 透传、缺字段→null；`reduceEvent` 对 `compaction_start/end` 返回 meaningful、summary 不被尾巴重派生覆盖；下一个真实事件清掉 failed 标记 |
| A3 | 前台/hosted 镜像（`syncRowEvent` 三分支 + 忙守卫 + 在途竞态） | 自动化验证（integration，进程内） | `node --test test/service.test.mjs`（主断言用 coordinator off；另加一条 `startTrackedCoordinator` 的在途用例） | coordinator off：`session_before_compact`→`state.json`: working/alive/summary=`Compacting context…`/`compaction.previous.semanticState===idle`. 期间 `isAgentBusy(row)===true`、`markCompleted`/`holdView` 返回 busy 拒绝；`session_compact`→恢复 idle + 原 summary + `processState==="exited"` + `compaction===null`；failed(aborted)→恢复且无 error；failed(errorMessage)→恢复态 + `error` 原文 + **summary 为 `Compaction failed: …`**；重复 before 不覆盖 previous。tracked coordinator：back-to-back 触发 begin→end（不等待在途写）后轮询到恢复态，**不得**停在 working + Compacting |
| A4 | JSON runner 通路的端到端镜像 | 自动化验证（integration） | `node --test test/runner.integration.test.mjs`（fake-pi 新增 `compact` 模式，sleep 窗口 ≥1s） | 压缩窗口内用 `waitFor` 轮询到 `state.json` 为 working + `Compacting context…` 且 `status.json.compaction.phase==="running"`；`agent_end` 后行终态为 idle 且 `compaction===null`、`status.json` 同步清空 |
| A5 | 全量回归 | 自动化验证（build+static+test） | `npm run verify`（typecheck + perf gate + tests + coverage + pack:dry） | 全绿，覆盖率阈值（lines 85 / funcs 80 / branches 70）不下降 |
| A6 | `src/index.ts` 的三个钩子注册名（注册层不进 service harness） | 自动化验证（static） | 新增 `test/index-compaction-events.test.mjs`：读 `src/index.ts` 文本，断言包含 `pi.on("session_before_compact"`、`pi.on("session_compact"`、`pi.on("session_compact_failed"` 三处 | 三条注册都在；文件被改名/删除时测试失败（fail-closed） |
| U1 | 真实 `/compact` 观感与守卫 | 用户实测 | **前置**：切到 PR 分支并 `npm install`——**没有构建步骤**（`package.json` 的 `main`/`exports` 直接指向 `./index.ts`，pi 加载 TS 源；不存在 `build` script），或用隔离启动 `--extension <worktree 绝对 index.ts>`；随后重启 pi 或 `/reload` 扩展；JSON 通路需重新 dispatch 一个后台会话才会用新 runner。**时机**：A1–A6 全绿后、合并前。**步骤**：在 board 里对一个有历史的后台会话 attach → 执行 `/compact`（长历史会话最直观）。**观察**：(1) 行进入 Running 且 summary 为 `Compacting context…`；(2) 压缩期间在 dashboard 按 `d` 标记完成被拒（提示等待）；(3) 压缩结束行回到压缩前状态（通常 Needs instructions），summary 不再是 Compacting；(4) 阈值压缩：用一个小上下文窗口模型（或超长历史）跑一个后台会话，压缩发生时行不显示为空闲 | 四项均符合；(3) 若压缩失败（用 `Nothing to compact` 的短历史触发），行显示 `Compaction failed: ...` 且不残留 Compacting |

## 6. 可测性拆分设计（实现硬约束）

- **纯函数层（events.mjs）**：`beginCompaction` / `endCompaction` 不读盘、不取时钟（`now` 注入）；`endCompaction` 的六种分支全部可由 A2 单测覆盖，`endCompaction` 是 summary 的唯一生产者（I8）。
- **派生层（derive.mjs）**：`deriveSummary` 的 compaction 分支是纯字符串决策，A1 直接断言；不引入新的 I/O。
- **薄壳层（service.mjs）**：`syncRowEvent` 三个分支只做「取字段 → 调纯函数 → 写盘」，不做判断；语义断言放在 A2，落盘断言放在 A3。**禁止**把 restore 规则复制进 service（否则两条通路会漂移）。
- **缓存层（foreground-projection-cache.mjs）**：只加白名单项，不改机制；A3 的在途用例是这个白名单的回归保护。
- **驱动层（test-support/fake-pi.mjs）**：新增 `compact` 模式（`agent_start` → `compaction_start` → sleep ≥1000ms → `compaction_end` → `message_end` → `agent_end`），只负责发事件。**sleep 下限的依据**：`runner/job-runner.mjs:37` 的 `WRITE_THROTTLE_MS = 250`，beat 节流后还要经协调器物化，窗口 <1s 会间歇性错过 running 相位（R1-D5）；A4 用 `waitFor` 轮询，不做一次性读取。
- **静态层（A6）**：只读文本断言注册名，不 import TS（`src/index.ts` 不是可运行 ESM）。
- **测试边界**：A1 只碰 derive；A2 只碰 events；A3 只碰 service + 写盘（off / tracked coordinator 两种）；A4 只碰 runner 子进程与 JSON 流；A6 只碰源文本。任何一层都不需要真实模型调用或真实 `/compact`（那是 U1 的职责）。

## 7. 风险与回滚

- **风险 1（字段进入投影）**：`compaction` 进入 `state.json` 后，若有外部消费者做严格 schema 校验会报未知字段。仓内证据：`readState` 只做 JSON 解析、dashboard 按已知字段读取，无严格 schema；`patch_fields` 白名单只约束命令来源，不约束投影字段。
- **风险 2（typecheck 覆盖面，R1-D6）**：`tsconfig.json:9` 是 `checkJs: false`，本改动主体是 `.mjs`，`npm run verify` 的 typecheck 几乎不覆盖其函数体——**真正的把关者是 A1–A4 的测试与覆盖率阈值**，不要把 A5 当成类型级保护。
- **风险 3（summary 覆盖策略）**：写错会让行短暂显示错误文案。A1/A2 钉住 running/failed 两相位、恢复取值与清除时机；U1 覆盖真实观感。
- **回滚**：按层列文件——运行时 `src/index.ts`、`src/runtime/service.mjs`、`src/core/events.mjs`、`src/core/derive.mjs`、`src/core/types.mjs`（三个 typedef）、`src/core/foreground-projection-cache.mjs`（白名单）；测试 `test/derive.test.mjs`、`test/events.test.mjs`、`test/service.test.mjs`、`test/runner.integration.test.mjs`、新增 `test/index-compaction-events.test.mjs`；夹具 `test-support/fake-pi.mjs`。revert 该 PR 即可；`state.json` 中的 `compaction` 字段对旧代码是未知字段（被忽略），无迁移负担。
