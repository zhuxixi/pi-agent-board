# Spec（v3，已确认）：#140 control-reconcile 偶红收敛 —— 断言窗口化与口径对齐

- issue: zhuxixi/pi-agent-board#140
- 根因报告：`research/root-cause.md`（含复现脚本 `research/repro-140.test.mjs`，产品代码零改动）
- 状态：已确认（2026-09-24，用户批准 v3）
- 变更记录：v1→v2（首轮评审）与 v2→v3（终审）见文末 §8

## 1. 问题

`test/control-reconcile.integration.test.mjs` 的两条断言在负载下偶红（签名 A `:295`、签名 B `:383`），**产品行为正确**：

- 签名 A：wire 上出现重复 seq。机制是 runner 无法原子「停止裸广播 + 开始 ring 重放」——订阅前已写入 socket 的 stray 若在客户端**发出订阅之后**才投递，就落在 `resyncing` 分支（既不计入 `strayHighWater`，又被当成重放起点）。客户端按 `seq <= lastSeq` 丢弃重放的那一份 ⇒ **UI 仍恰好一次**。
- 签名 B：`assert.ok(h.outputSeqs().at(-1) >= ready2.nextSeq)` 不是有效不变量——`outputSeqs()` 是跨 socket 累加器，`ready2` 的 `waitFor` 因旧事件已存在而**立即返回**（取到旧 baseline）。新 runner 的 seq 从 1 重启，只要断言时刻最后一条 output 是快照前的 stray，断言即假。
- 共同根因：`attachClientOverSocket()` 的 `messages` / `events` 是闭包级单数组，`switchSocket()` 不清空、不分段 ⇒ 断言把「重连前残留 / 窗口外消息」与「新流」混在同一集合里比较。

对 issue 三条出口的对账：命中「断言过严/把窗口外残留计入」；**未**命中「runner 真实重复写 seq」（重复 = 一次订阅前裸广播 + 一次重放）；**不属** #95 墙钟类（两条均为断言失败，326ms/359ms，非超时）⇒ 不重分类。

**证据强度（v2 补）**：「UI 恰好一次在 wire 重复下成立」共 4 次观测（基线自然交错 1 次 + 150ms 确定性交错 3 次，marker guard 全部通过，其中 3 次窗口内有 6–7 个重复）；「老断言不完备」已从推断升级为观测——150ms 交错下 wire 含 6 个重复而老 `deepEqual` 通过（前 3 个恰好被 strays 填满）。

## 2. 目标 / 非目标

**目标**：让该文件 A2 相关断言不再依赖消息到达时序；同时保住对真实回归的检测力；把与真实保证不符的注释改正。

**非目标**：
- 不改产品行为（唯一产品改动是注释，见 D6）。
- 不做 F2（runner 侧为每 socket 记裸广播高水位、重放起点取 `max(sinceSeq, broadcastHighWater)`）：只改 runner 会让客户端 **UI 冻结**：客户端 `resyncing` 对 `seq !== lastSeq + 1` 的 chunk 一律忽略，且该状态没有 gap 检测 / resync 触发路径，直到下一次重连才能恢复（v3 措辞精确化），必须同时改客户端游标语义；而收益仅「wire 无重复」，UI 早已正确 ⇒ 留给未来协议级设计（本 spec 只记录评估结论，不实现）。
- 不动 #95 的墙钟预算策略。

## 3. 决策

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 在测试 harness 内加**窗口/标记 API**：recorder 抽成文件顶部的 **`createRecorder()` 纯数据结构**（`push` / `mark` / `since`），`attachClientOverSocket` 只是它的一个消费者（socket 绑定） | 根治「跨 socket 累加器」；纯数据结构让窗口语义真正可单测（见 D2/A2） |
| D2 | 判定逻辑抽成**纯函数**（文件顶部，与 harness 并列）：`distinctSeqsFrom(seqs, from)`、`hasWireOverlap(seqs)`、`isContiguousFrom(distinct, from, count)` | 判定收口、可单测、避免断言内联逻辑再次漂移 |
| D3 | 签名 A 的断言改为设计真正保证的性质：**去重后连续**（无 gap）+ 既有的 **marker guard（UI 恰好一次）**；测试内注释写明「wire 允许在广播→重放交接处重复，UI 重复才是 bug」 | 设计只保证 UI 级 exactly-once；老断言（要求 wire 无重复）既过强（重复合法）又不完备（只查前 3 个 seq，窗外重复抓不到，已观测证实）。**检测力等价性论证**：对「重放起点偏高（跳过 d+1）」与「gap」两类真实回归，新断言与老断言同样变红（去重后首个 distinct ≠ d+1 即失败）；唯一放弃检测的是「wire 重复」——恰是合法行为，其 UI 级真回归由 marker guard 覆盖 |
| D4 | 签名 B 改为**条件式等待 + 客户端级不变量**：等 `snapshotReady` **数量增长**后取新事件的 `nextSeq`；断言 `h.client.getLastSeq()` 到达新 baseline 并继续前进；如需 wire 级证据，用 **mark 窗口 / 该 socket** 的切片 | `waitFor(存在任意旧事件)` 不是等待；跨 socket 的 `.at(-1)` 不是「新流的最后一条」 |
| D5 | 新增**确定性交错用例**（harness 侧注入，产品代码不动），注入设计如下（v2 修正）：<br>① **late-subscribe**：延迟**出站**的重连订阅写。参数依据：steady tick = 25ms（`test-support/fake-pty-pi.mjs:10`），**延迟 ≥ 4× tick 周期（150ms ≈ 6 tick）**——实测 3/3 每次恰好 6 个 strays 落窗，确定性成立；不可改成 ~40ms（≈ 1.6 tick，实测 2/5 命中，回到不确定）。优先实现为现有 A 测试内**同一条连接的第二次 reconnect**（注入只对第二次生效），新增 spawn = 0。<br>② **slow-consumer（epoch）**：**相对延迟**——只延迟 snapshot 路径消息（`deferFeed: msg => msg.type?.startsWith("snapshot") ? X : 0`），让 epochReset 立即触发而快照滞后到达。⚠️ **统一延迟无效**：stray/reply/snapshot 各后移同样 X，`[epochReset, 快照投递]` 窗口宽度不变（已从时序推演确认）。此用例必须新 spawn runner（epoch 换代无法复用），+2。<br>**非空转断言的观测点（v2 修正）**：重叠**滞后到达**——`waitFor(≥3)` 返回时重放尚未落地（实测该时刻 duplicates=0）。因此非空转必须写成**条件式等待**：① 用 `waitFor(() => 窗口内出现重复, 上限)` 后再断言不变量；② 的中间态检查在 epochReset 触发后立即执行，非空转条件是**此刻新 snapshotReady 事件尚不存在**（相对延迟保证快照必然未投递，确定性成立）；注意 stray 是否先到达属时序不确定（新 runner 首个 tick 与 hello/reconcile 往返是竞速，两种结局都观测过），**不**作为非空转条件（v3 修正） | 把偶红变成必红的确定性覆盖；非空转断言防止用例静默退化为「什么都没覆盖」 |
| D6 | 产品侧仅改一处注释：`src/core/terminal-attach-client.mjs` 中 `(wire-level no-dup)` 的表述 → 精确为「覆盖**已观察到的** stray；UI 级 exactly-once 才是保证，wire 可能重复在途 stray」；顺带核对该测试内 `:283-285` 的注释（「replay 恰好从 cursor 起 / stray 高水位起」同样只对已观察到的 stray 成立） | 注释即契约：这条过度承诺正是过严断言的来源（与 #130 同型根因） |
| D7 | 降级路径：若确定性交错用例在本地/CI 出现抖动（非空转等待超时等），退化为「自然交错 + 稳健断言（D3/D4）」，移除该用例并在 PR 描述记录原因 | 不为了确定性而引入新的不稳定 |

## 4. 可测性拆分设计（自动化项必答）

| 层 | 单元 | 怎么测 |
|---|---|---|
| 纯函数（无副作用） | `distinctSeqsFrom` / `hasWireOverlap` / `isContiguousFrom` | 直接单测：给定 seq 数组（含重复、缺口、空窗、边界 `from`）断言返回；不依赖 socket、不依赖时序 |
| 纯数据结构（副作用仅限内部数组） | `createRecorder()`（push/mark/since）——窗口 API 的唯一新增记录侧逻辑 | 单测 mark 语义（mark 之前的消息/事件不得进入窗口）；socket 绑定由集成用例覆盖 |
| 时序边界 | 交错注入点（`deferWrite` / `deferFeed` 钩子，默认 0 = 行为不变） | 由 D5 两个确定性用例覆盖；默认关闭保证既有用例零影响；注入只延迟**写或投递**，`sent` 的记录顺序不变（不扰动 wire-order 断言） |
| 端到端 | 两条既有 A2 用例（改断言后）+ 两个确定性用例 | `node --test` 按名过滤，重复运行验证稳定 |

测试边界声明：**不**新增产品侧纯函数（无产品逻辑变更）；新增纯函数/纯数据结构全部位于测试文件内，不得反向引入产品依赖。<br>**plan 阶段审计项（v3 新增）**：全文件 grep recorder 累加器的所有断言使用（`outputSeqs` / `eventsOf` / `echoCount` 等全局计数），凡跨越断连/重连边界的断言一律改走窗口 API——例如 `echoCount` 目前恰好没事只是因为 echo chunk 的 seq 落在重放范围之外（seq ≤ 断连游标），是巧合不是设计。

## 5. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|---|---|---|---|---|
| A1 | 判定谓词行为 | 自动化（unit） | `node --test --test-name-pattern="seq window predicates" test/control-reconcile.integration.test.mjs` | 重复/缺口/空窗/边界用例全部符合预期 |
| A2 | 窗口 API 语义 | 自动化（unit） | 同上（`createRecorder` 的 mark 语义用例） | 窗口内不含 mark 之前的消息/事件 |
| A3 | 签名 A 断言口径（自然交错） | 自动化（integration） | `node --test --test-name-pattern="A2: reconnect wires"` | 去重后连续（`[d+1,d+2,d+3]`）+ marker guard 通过 + 客户端游标推进 ≥ d+3 |
| A4 | 确定性交错 ①（late-subscribe） | 自动化（integration） | 同上（150ms 出站订阅延迟，注入只对 reconnect 生效） | `waitFor(窗口出现重复)` 命中（**非空转**）⇒ 去重后无 gap + UI 恰好一次 |
| A5 | 签名 B 断言口径 | 自动化（integration） | `node --test --test-name-pattern="A2 epoch"` | 等**新** `snapshotReady`（数量增长）；客户端游标到达 `nextSeq-1` 并继续前进 |
| A6 | 确定性交错 ②（slow consumer） | 自动化（integration） | 同上（snapshot 路径相对延迟 X） | epochReset 后立即检查中间态：**新 snapshotReady 事件尚不存在**（**非空转**，确定性成立）+ 新断言通过 |
| A7 | 检测力（mutation 检查） | 自动化（integration，临时副本） | 在临时副本里分别制造「丢掉一个 chunk」与「对 UI 重复 emit 一次」 | 新断言分别变红：no-gap 断言捕获丢包、marker guard 捕获 UI 重复 ⇒ 证明未空转 |
| A8 | 稳定性 | 自动化（integration） | 对受影响用例（两条 A2 + 两条确定性，共 4 个）连续 **100** 次孤立运行（约 5 分钟） | 0 失败。统计边界：若签名 A 的真实失败率仍为基线 1/10，100 次全绿概率 ≈ 0.003% ⇒ 证伪力足够。真正的保证来自「失败模式被机制性移除 + A4/A6 确定性覆盖」，A8 是 sanity |
| A9 | 静态与全量 | 自动化（static/build） | `npm run typecheck`；全量 `node --test` | typecheck 0 error；测试通过数不下降，失败仅既有 flake（需隔离复跑归因） |
| — | 用户实测 | — | — | **无 U 项**：本 issue 无用户可见行为变更（产品侧仅注释），故不设用户实测；这是结论而非兜底分类 |

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 放宽 wire 断言后，真实的「同路径重复写」回归可能漏检 | marker guard 保持为 UI 级权威；A4/A6 的非空转断言确保交错被真实覆盖；A7 mutation 检查证明断言仍能变红；测试注释写明「wire 允许、UI 不允许」 |
| 确定性注入自身引入新的不稳定（非空转等待超时 = 反向 flake） | 注入参数有硬依据（≥4× tick，tick=25ms 实测）；非空转为有界条件等待；抖动时按 D7 降级并记录 |
| 新增真实进程用例加剧 #95 的并行挤压 | late-subscribe 复用现有 runner（+0 spawn）；epoch 用例 +2 不可避免；净增 spawn = 2 |
| 断言改动掩盖「客户端游标未推进」这类真问题 | A3/A5 显式断言客户端游标推进（不只看 wire） |

## 7. 范围核实记录（v2 新增）

- 跨 socket 录制器模式（`attachClientOverSocket` / `switchSocket`）**全仓仅此一个文件**（grep 证实）⇒ 无需姊妹文件审计，范围判断成立。
- flake「账本」无独立文件（docs/ 下无 ledger）；issue 所述账本实际是 #95 的追踪。本修复无需账本动作；PR 描述注明「#140 两条签名已机制性消除（断言口径修正 + 窗口化），非运气性通过」。

## 8. 评审修正记录（v1 → v2）

1. **[必修] A4 观测点**：重叠滞后到达（`waitFor(≥3)` 返回时 duplicates=0，实测），非空转改为条件式等待后再断言。
2. **[必修] A6 注入设计**：统一延迟无效（不改变相对时序，推演确认）；改为 snapshot 路径相对延迟。
3. **[应修] A8 统计效力**：30 次 → 100 次，并如实声明「机制性移除为主、A8 为 sanity」。
4. **[应修] D5 参数依据**：写明 tick=25ms 与「≥4× tick」余量，禁止回退到 ~40ms。
5. **[建议] runner 复用**：late-subscribe 用例复用现有 A 测试的连接（+0 spawn），净增 spawn 降为 2。
6. **[建议] recorder 纯数据结构**：`createRecorder()` 与 socket 绑定解耦，A2 的 unit 定位名副其实。
7. **[建议] D3 等价性论证**：写明对 gap / 起点偏高两类回归检测力不降，防未来评审者误判。
8. **[核实] 范围两件事**：录制器模式无姊妹文件；账本无需动作（见 §7）。

### v2 → v3（终审）

9. **[必修] A6 非空转条件**：stray 到达时机是竞速（新 runner 首 tick 25ms vs hello/reconcile 往返 ~1–3ms），非确定性；改写为「测试推进时新 snapshotReady 事件尚不存在」（相对延迟保证，确定性）。
10. **[应修] A8 口径**：全文件 100 次 ≈ 12 分钟 → 收窄为受影响 4 用例 100 次 ≈ 5 分钟，统计边界不变。
11. **[应修] F2 否决措辞**：「卡死」→「UI 冻结（resyncing 无 gap 检测 / resync 触发路径，直至下一次重连）」。
12. **[建议] plan 阶段审计项**：全文件 recorder 累加器断言审计（`echoCount` 目前安全是巧合而非设计）。
13. **[核对] tick 参数契约**：注释 25ms 与 `setInterval(..., 25)` 实参一致（`fake-pty-pi.mjs:10-16`）✓。
