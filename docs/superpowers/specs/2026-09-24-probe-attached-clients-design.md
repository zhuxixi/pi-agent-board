# Spec：probe 在连接窗口内计入 attachedClients（issue #130）

日期：2026-09-24 · 状态：**approved（用户确认 D1=A / D2=A / 范围=A）**
基线：`main @ 3dad7f9`（issue 行号基于 `794c755`，已逐条核对未漂移）
调研：issue #130 评论「根因确认 + 确定性复现」/ `~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-130/research/root-cause.md`

## 1. 根因（systematic-debugging 结论）

### 1.1 一句话根因

`runner/pty-runner.mjs` 的 `clients` 这个 Set 同时承担两个角色——**广播目标**与**已连接真实客户端计数**
（`attachedClients: clients.size`，legacy `:256` / owned `:611`）。hello 分类把 reporter 从 `clients`
移了出去（#103），**却漏了 probe**：probe 只在 owned 路径被 `markProbe()` 标记（`:1096-1098`）、
legacy 路径完全不处理（`:427-434`），于是 probe 从 connect 到 close 一直被计入 `clients.size`。

### 1.2 两条路径的差异（决定危害大小）

| | 计数窗口 | 窗口内的错值如何被修正 |
|---|---|---|
| **legacy** | connect（`:375`）→ close（`:389/:396`） | close 处理器**无条件 `update()`** → 立即落盘正确值 |
| **owned** | connect（`:869`）→ close（`:883/:899`） | close/error **对 probe 提前 return**（`:888`/`:898`，为抑制写放大）→ 错值要等下一次心跳（`HEARTBEAT_MS = 1000`，`:1055-1070`）才回落 |

### 1.3 实测暴露度（`/tmp/measure-130.mjs`：真实 `probeHost` 按 `HOST_PROBE_RETRY_MS = 150` 节奏压测，5ms 采样 host.json）

单次 12s / 80 次 probe 跑（宿主与采样器并行争抢 CPU）时：

```
[owned]  attachedClients!=0 in 195/2344 samples (8.32%)
[owned]  longest contiguous non-zero run ~975ms      ← ≈ 一个心跳周期
[owned]  落盘写入：1/12 次心跳记录了 attachedClients!=0
[legacy] attachedClients!=0 in 0/2340 samples (0.00%)
```

随后 3 × 20s（~400 次 probe）单跑均为 0 命中。**结论：**

1. **owned 是真实暴露面，legacy 不是。** legacy 的 close 刷盘把错值寿命压到 probe 生命周期内，实测 0 命中；
   owned 因为 close 抑制，**一次命中就要错满一个心跳周期（~975ms）**。
2. 命中频率低但非零，且随宿主 CPU 负载（event loop 延迟）上升——正是 attach 解析进行时的工作状态。
3. 消费方周期是 60s（`src/index.ts:67` `AGENT_BOARD_SWEEP_INTERVAL_MS` 默认 60000），
   所以最坏后果是「空闲宿主多活一个 sweep 周期（~1 分钟）」，方向保守、不误杀、不丢数据——与 issue 的评估一致。

### 1.4 影响链已端到端证实

```
attachedClients=0 -> {"ttlEvicted":["v1"],"excessEvicted":[]}   ← 到点即回收
attachedClients=1 -> {"ttlEvicted":[],"excessEvicted":[]}       ← 永不回收
```

（`selectIdleHostsToEvict`，`src/core/warm-host-sweeper.mjs:53`；同款复查在 `src/runtime/service.mjs:807`。）

### 1.5 还有一条结构性理由（比 1.3 的暴露度更值得修）

**owned 路径今天把「probe 停止计数」这件事挂在「观察到 close」上。** 一旦 close/error 事件永远不来
（对端半开：进程卡死而非退出，issue 已点名的尾部风险），计数就永久挂住。改成「probe hello 即移出」后，
清理点从**生命周期末端**移到**握手早期**，probe 只要成功握手就不会留下计数——这是本修复的主要价值，
1.3 的暴露度收窄是副产品。

### 1.6 一句话根因之外

- issue 的「注释与实现不符」判断正确：`:1092-1094` 与 `:423-426` 的注释都声称 probe 不得让 `attachedClients` 非 0，
  实现不符；`src/core/host-protocol.mjs` 模块注释同款。
- `attachedEver` **无任何生产消费方**（全仓 grep 仅 runner 写入 + `src/core/types.mjs:144` 注释 + 测试断言），
  本 issue 的危害面完全落在 `attachedClients`。

## 2. 修复设计

### 2.1 决策 D1：probe hello 时把 socket 移出 `clients`，**不写 host.json**

采纳 issue 建议 1 的「移出 `clients`」半条，**明确不采纳**其「并刷新一次计数」半条。理由：

| 取向 | 后果 |
|---|---|
| 移出 `clients`（做） | 内存计数在 hello 处理后立刻正确；后续心跳不可能再持久化 probe 的 1；清理点从 close 前移到 hello（§1.5） |
| 移出时写 host.json（不做） | 解析期每 150ms 一轮 probe → 最多 ~6.7 次/秒的 fenced host.json 写入。这正是 `:864-867` 注释要防的写放大，reporter 的 `ownedUpdate` 是常驻连接的一次性写入才可接受 |
| 不写会不会留下错误持久值 | 不会：`clients.size` 已在内存中正确，下一次心跳（≤1000ms）落盘正确值；错值寿命与 legacy 同量级，不引入新退化 |

残留窗口收窄为 `connect → hello 处理`（一次本地 socket RTT，且不依赖 close 事件）。**接受**该残留：
它在允许的 1 个心跳周期内自愈，且消费方是「非 0 就不杀」的保守判据。

### 2.2 决策 D2：把 hello 记账策略抽成纯函数

现状：两条 hello 分支各自内联判断（`:427-434` vs `:1095-1105`），已经漂移——owned 有 `markProbe`、legacy 没有；
注释声称的 probe 语义在两边都不成立。新增纯函数收拢决策（与 #103 抽出 `classifyClientHello` 同款做法）：

```js
// src/core/host-protocol.mjs（与 classifyClientHello 同文件）
/**
 * Socket bookkeeping implied by a hello classification (issue #103 §C / #130).
 *
 * ...probe 必须 persist:false + suppressCloseWrite:true 的理由注释...
 * @param {"probe" | "editor-reporter" | "client"} kind
 * @returns {{ keepInClients: boolean, registerReporter: boolean,
 *             flipAttachedEver: boolean, persist: boolean, suppressCloseWrite: boolean }}
 */
export function helloBookkeeping(kind) { ... }
```

| kind | keepInClients | registerReporter | flipAttachedEver | persist | suppressCloseWrite |
|---|---|---|---|---|---|
| `probe` | false | false | false | **false** | true |
| `editor-reporter` | false | true | false | true | false |
| `client` | true | false | true | true | false |

两条分支改为消费该描述符（副作用仍留在 runner，纯函数零 IO）：

```js
const kind = classifyClientHello(msg);
const book = helloBookkeeping(kind);
if (!book.keepInClients) { clients.delete(socket); terminalSubscriptions.delete(socket); }
if (book.registerReporter) editorReporters.add(socket);
if (book.suppressCloseWrite) socket.markProbe?.();          // legacy 无此抑制点，markProbe 为 undefined → 跳过
if (book.flipAttachedEver) update({ attachedEver: true });  // owned: ownedUpdate(...)
else if (book.persist) update();                            // owned: ownedUpdate(...)
```

`terminalSubscriptions.delete` 一并做：probe 从不 `subscribe_terminal`，留着只会让它继续收 `output` 原始行
（`child.onData` 的 `terminalSubscriptions` 循环，legacy `:341` / owned `:991`）。收窄语义，与 reporter 对称，
已核对无副作用（probe 读到第一行数据就 `destroy()`，`src/core/host-probe.mjs:47-130`）。

**若用户认为 D2 过度设计**：退化为「两条分支各自内联同样的修复 + 镜像注释」，A2/A3/A4 仍成立，
只是 D2 对应的 A1 单测与「两侧不漂移」的结构保证消失。**建议保留 D2。**

### 2.3 改动点清单（`runner/pty-runner.mjs`）

| 位置 | 改动 |
|---|---|
| `:422-437` legacy hello 分支 | 改为消费 `helloBookkeeping`；probe 时 `clients.delete` + `terminalSubscriptions.delete`，**不** `update()` |
| `:1091-1108` owned hello 分支 | 同上；probe 时补 `clients.delete` + `terminalSubscriptions.delete` + `markProbe()`，**不** `ownedUpdate()` |
| `:423-426` legacy 注释 | 与实现对齐：probe「不翻转 `attachedEver`、不长期占计数、不写 host.json」，而非「从不计数」 |
| `:1092-1094` 注释 | 同款对齐 |
| `:864-867` owned probe 注释 | 补一句：probe 在 hello 时即移出 `clients`（#130），close 抑制只负责「不写」 |
| `src/core/host-protocol.mjs` | 新增 `helloBookkeeping` + 模块注释对齐（把「keep bookkeeping-only connections out of attachedClients」的承诺落到显式策略） |

## 3. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | hello 记账策略纯函数 | 自动化（unit） | `node --test test/host-protocol.test.mjs` | 三行决策表逐字段断言（probe: keepInClients/persist/flipAttachedEver 均 false 且 suppressCloseWrite true；reporter: registerReporter true、persist true、keepInClients false；client: keepInClients/persist/flipAttachedEver 均 true）。既有 `classifyClientHello` 用例保持全绿 |
| A2 | owned：probe 在连时不计入 `attachedClients` | 自动化（integration） | `node --test test/pty-runner.integration.test.mjs`（新用例） | probe 握手完成后（见到第 2 条 `hello`，证明分类路径已跑完）保持 socket 连接，跨过至少一次心跳落盘，读到的 `attachedClients === 0`；`attachedEver !== true` |
| A3 | legacy：同 A2 | 自动化（integration） | 同上（legacy 分支新用例，配置走 `P.hostConfigPath` 无 `instanceId`） | 同 A2 |
| A4 | 判别性：probe 与真实 client 并存时计数恰为 1 | 自动化（integration） | 同上两条用例内 | probe 仍在连时，真实 client 的 hello 所触发的落盘写入里 `attachedClients === 1`（**修复前为 2**）；client 断开后回落 `0` |
| A5 | 错值在一个心跳内自愈（D1 不做即时刷盘的安全性） | 自动化（integration） | 同上两条用例内 | probe 断开后再跨一个心跳落盘，`attachedClients === 0` |
| A6 | probe 应答能力零回归 | 自动化（integration） | 新用例内调用真实 `probeHost(socketPath, {...})` | `classification === "ready"`；且 `probeHost` 之后 `attachedClients === 0` |
| A7 | 既有 probe / reporter 语义零回归 | 自动化（integration） | `node --test test/pty-runner.integration.test.mjs` | 既有用例 `:1159`、`:1206`、`:1289` 全绿（reporter 计数隔离、probe 不翻 `attachedEver`、legacy reporter/probe 隔离） |
| A8 | 静态 + 全量 | 自动化（static + 全量 unit） | `npm run typecheck && npm test` | typecheck 0 error；与基线（实现前在 `main@3dad7f9` 记录，见 plan）对比**无新增失败** |

**端到端效果的验收由组合证据给出**（不新建慢速 E2E，避免 flake）：

```
A2/A3（probe 在连 → attachedClients 落盘为 0）
  + test/warm-host-sweeper.test.mjs A2（attachedClients>0 → 不淘汰）
  + test/warm-host-sweep.integration.test.mjs A6（attachedClients=0 的 idle host → 收到 terminate）
  ⇒ probe 不再延迟 warm-host 回收
```

无需 `用户实测` 项：本改动是进程内记账语义，全部功能点都能在 unit/integration 层稳定判真，
不存在需要真机/外部服务才能观察的部分。

## 4. 可测性拆分设计（实现硬约束）

| 拆分单元 | 位置 | 形态 | 测试边界 |
|---|---|---|---|
| `helloBookkeeping(kind)` | `src/core/host-protocol.mjs`（新增） | **纯函数**：入参三值字符串，出参冻结的记账描述符；零 IO、零 socket | `test/host-protocol.test.mjs` 表驱动直接单测 → A1 |
| `classifyClientHello(msg)` | `src/core/host-protocol.mjs`（既有，不改） | 纯函数 | 既有单测保持 → A1 |
| hello 分支副作用 | `runner/pty-runner.mjs` 两处 | 只消费描述符、只做 `clients`/`terminalSubscriptions`/`editorReporters`/`update` 的副作用调用；**判定逻辑一律不得回流进分支** | 真实进程 integration → A2–A7 |
| 计数落盘点 | 不改（`clients.size`，legacy `:256` / owned `:611`） | 保持单一来源 | 由 A2–A5 观测 |

**硬约束**：D2 要求「probe 不写 host.json」这一决策只存在于 `helloBookkeeping` 一处；两条分支不得再出现
`if (kind === "probe")` 式的判定。这样 A1 的单测就是该不变量的完整证明，integration 只证明接线正确。

## 5. 非目标

- **不动 owned close/error 的 probe 写抑制**（`:888`/`:898`）。它负责「不放大写入」，D1 已让「不计入」与它解耦。
- **不改 legacy close 时的无条件 `update()`**。既有行为，且它正是 legacy 实测 0 命中的原因。
- **不改 `attachedEver` 语义**（无消费方；probe 本就不该翻，已正确）。
- **不重构 `clients` 的「广播目标 / 计数来源」双角色**。这是根因层架构气味（§1.1），
  但拆开需要改广播语义，超出保守修复边界——记为已知债，不在本 issue 处理。
- **不处理「probe 连上但从不发 hello」**：分类必须依赖 hello（握手前无法区分 probe 与尚未 hello 的真实客户端），
  该窗口由 `HOST_PROBE_TIMEOUT_MS = 250`（`src/core/host-probe.mjs:16`）与 probe 自身的 `destroy()` 兜底。
- 不改 warm-host 回收策略本身（TTL / maxWarm / sweep 周期）。

## 6. 风险

| 风险 | 对策 |
|---|---|
| hello 被同一 socket 重复发送且身份改变（先 `probe` 后 `client`）→ 永久漏计（危险方向：可能误杀活跃客户端） | 既有协议假设「hello 一次且权威」；reporter 的 `clients.delete` 已在 #103 依赖同一假设。在代码注释中显式写明该前提，并由 A4 钉住「probe 仍在连时真实 client 计 1」 |
| D1 不即时刷盘 → 某次心跳仍可能落盘错值 | 接受：错值寿命 ≤ 1 个心跳周期，消费方是「非 0 就不杀」的保守判据；A5 钉住自愈 |
| D2 新增描述符与 runner 实际副作用脱节（描述符说 `persist:false` 但分支仍写了） | A2/A3 用真实落盘观测（不是看描述符）：probe 在连时跨心跳读到的必须是 0 |
| `terminalSubscriptions.delete` 影响 probe 回包 | probe 只读第一行数据即 `destroy()`（`src/core/host-probe.mjs`）；A6 用真实 `probeHost` 断言 `ready` |
| Windows 命名管道路径下的时序差异 | 本改动不引入路径/平台分支；A2–A5 走既有跨平台 integration 基建（`P.hostEndpointPathFor`） |
