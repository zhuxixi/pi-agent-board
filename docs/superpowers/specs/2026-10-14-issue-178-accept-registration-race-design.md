# Spec — Issue #178: subscribe_terminal / editor_state 的 accept-注册竞态修复

Drafted: ollama/deepseek-v4.1-flash:cloud (selected) · ollama/deepseek-v4.1-flash:cloud (physical) @ 2026-10-11T18:56:21+08:00
Revised: ollama/deepseek-v4.1-flash:cloud (selected) · ollama/deepseek-v4.1-flash:cloud (physical) @ 2026-10-12T08:07:43+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-13T08:53:41+08:00

> 状态：**DRAFT v3 待用户确认**（2026-10-13 更新：cross-review 第 1 轮裁定落地——editor_state 补 capture 接线、
> A6 加补丁前阳性控制轮、静态断言落为持久化测试、D7 覆盖计数修正为 A2 用例体全部等待点）
> 认领：zhuxixi（2026-10-10）；基线 HEAD：`f47766c`
> 调研：`research/01-accept-registration-race.md`（代码级证据链）、`research/02-new-evidence-2026-10-12.md`（新证据与验收修正）
> 上游：issue #178（本 spec 目标）；#95（umbrella，观察窗继续）；#153（拆分子 issue 的先例与验收标准来源）
> 路由：bug → systematic-debugging（根因已在调研中完成，本 spec 是设计）

## 1. 问题陈述

`subscribe_terminal: snapshot + live continuity alongside legacy clients` 与 `pty-runner routes editor_state between clients…`
两条用例在负载下慢性红，是 #95 观察窗内命中最多的签名。

| 场景 | 日期 | commit / run | 耗时 | F3 现场 |
|---|---|---|---|---|
| main CI | 09-23 | `e2f7e9c` / `35852392307` | 15094ms | 无（F3 未上线） |
| main CI | 10-01 | `d40726e` / `36821332656` | 15087 / 15088ms | 有 |
| main CI | 10-01 | `ac8163c` / `36823061068` | 15166ms | 有 |
| main CI | 10-09 | `fee345c` / `37932010325` | 15091ms | 有 |
| main CI（**Node 22 + 24 双矩阵同红**） | 10-10 | `0fd1dc5` / `38007611071` | 15102.9ms | 有（同 run 还红 `A5 burst`） |
| PR #177 CI | 10-11 | `dccaf9f` | ~15s | —（byte-identical 前次 push 全绿，`rerun --failed` 即绿） |
| **本地全量负载** | 10-10/11 | #174 分支 | 15s | —（**`npm run verify` 2/2 红；隔离同用例 187ms 通过**） |

`editor_state` 另命中两次：09-30（PR #157 CI，15207ms）、10-06（PR `37495589443`，15246ms）。

两条都烧满 15s 等待预算后失败，F3 现场逐字一致：runner 活、心跳健康、客户端已连、协调器诊断与日志皆空、输出零字节到达。

目标：把这两条签名的等待假设从「一次性 banner / TCP connect」改为「事件驱动、可证伪」的等待，
使失败不可能再发生（而不是把预算再调大）。

## 1.5 根因（已完成；不再重复调试）

**accept-注册竞态**：客户端的 TCP `connect` 完成 ≠ 服务端已把它注册进广播集合。服务端在 accept 回调里才
`clients.add(socket)`（`runner/pty-runner.mjs:375`）并回写 hello（`:380`）；子进程输出无条件喂 canonical model
（`:334`），但 socket 转发只发给已注册客户端（`:340-345`），legacy 输出无重放。

- **subscribe_terminal**：等一次性横幅 `fake pi ready`（`:1825`）；横幅在 accept 前广播即永久丢失。
- **editor_state**：client2 只等 `connect` 没等服务端 hello（注册证明），client1 就发出了 editor_state。

**这是测试设计缺陷，不是生产缺陷，不是机器慢**（邻用例 260ms 通过 + 心跳健康）。机制与修法（echo-probe）
在仓内（A5，`terminal-snapshot.integration.test.mjs:284-294`）与 KB（flake 归因法坑③）都已有记载。
10-10/11 的新样本把「只需全量负载即可复现」这一点钉死（本地 `verify` 2/2），详见研究 02。

## 2. 设计决策

### D1：subscribe_terminal 的 legacy 等待点换成 echo-probe，模式与 A5 共享

照抄 A5 模式：每 300ms 发 `boot-probe-N\r`，等回显。**提取共享实现** `test-support/echo-probe.mjs`，
subscribe_terminal 与 A5 都用它（A5 的 inline 循环迁移过去）。

**迁移不改的三条不变量**（原稿写的「行为逐字节一致」精确化为这三条，实现阶段逐条对照）：
① 发送间隔恒为 300ms；② 回显判定用 `/boot-probe-\d/`；③ 等待结束即停止发送、不留悬挂定时器。

**明确允许的一处差异**（有意偏离 A5 现状，不是回归）：helper 用「发送 → sleep」循环，首个探针在 t≈0 发出；
A5 现用 `setInterval`，首个探针在 t≈300ms。两者都满足「连接活着就一定能收到探针」这一判定前提，
A5 迁移后首探针提前约 300ms 属预期。若不写开，实现者会在「逐字节一致」与「sleep 驱动」之间两头挨挤。

**断言不变性（硬约束）**：假 pi 程序顺序保证「先写 banner 再 echo」，`feedOutput` 无条件喂模型
→ 收到 echo ⟹ banner 已在 canonical model → 后续 snapshot 断言（`frame.data.includes("fake pi ready")`、
`begin.snapshotSeq >= 1`）原样保留、原样通过。不许删除或弱化这些断言。
【勘误：第 1 轮 CR 阻塞发现】此段原表述不完整——「先写 banner 再 echo」只对假 pi 的**应用层回显**（stdin
处理器写出的 `echo:` 前缀行）成立；子进程调用 `setRawMode` 之前，PTY 线路规程仍处 canonical + ECHO，
内核同样会回显探针行且可能早于 banner 广播，裸正则 `/boot-probe-\d/` 会提前收敛（Node 22 合并阻塞
flake 的根因）。因此所有探针等待一律匹配应用层回显 `/echo:boot-probe-\d/`，上文不变量②据此修正。

### D2：editor_state 补注册证明

client2 在 client1 发 `editor_state` 之前，先等服务端回写的 hello。
这是「accept 回调已跑、client2 已注册」的事件驱动证明，零墙钟。client1 已有同款等待，本次只补 client2。

**同批追加 capture 接线（第 1 轮 R1-G1）**：该用例（`test/pty-runner.integration.test.mjs:511-580`）的**全部等待点**
也接上 `capture`，照抄同文件 subscribe_terminal 的写法（`:1782` 的
`const capture = () => formatPostmortem(capturePostmortem(root, "v1", null));`；本文件 `waitFor` 已有第三参，`:31`；
首个待接的等待是 `:532` 的 `await waitFor(() => hostReady(root, "v1"))`）。
理由：本 issue 的两条目标签名必须同权——D3 与 D7 都在为「下一次红自带现场」投资，而 editor_state
（第二条目标签名）当前所有等待都不传 capture，再红时只会打出一句 `timed out waiting`，U1 的失败分支判据对它不可执行。
不改任何等待条件与预算。

### D3：postmortem 增加 screen.log 尾巴

`capturePostmortem` 增加 `screenLogTail`（读 `screenLogPath(root, viewId)` 的最后 ~2KB，缺失/读失败记 `<absent>`），
`formatPostmortem` 增加对应输出行。作用：若改完仍红，现场直接区分「banner 没落盘」（子进程侧）与「落盘未转发」
（转发侧）——给「修错了」上的保险。

### D4：确定性复现用例（before/after 证据，钉住机制）

新增用例（`test/pty-runner.integration.test.mjs` 内）：

1. spawn runner，**轮询 screen.log 出现 `fake pi ready`**（证明 banner 已广播且我们错过了）；
2. 连接 legacy socket 并 hello；
3. echo-probe 至收到回显（证明连接活着、输出此刻在流）；
4. 断言：消息里有 echo、**没有** `fake pi ready`（钉住「legacy 无重放」的设计事实，防止日后有人把
   banner 等待写回来）。

设计要点：负断言由 echo 到达事件驱动，不是「等 N 秒看没到」——避免再造一个计时竞态。
这是本 issue **唯一不依赖负载的**修复证据（D6 之外）。

### D5：范围

test-only；不改 `runner/`、`src/` 生产行为；不改 `ci.yml`；不做串行化（F5 在 #95 继续押后）；
不动 A5 的残留（另行观察）；不做 147 个等待点的全量 capture 迁移。

### D6：按名字隔离**不得使用负模式**（硬约束，实证）

`node --test --test-name-pattern` 的否定形式不可用：文件级聚合条目名是文件路径，`(?!X).+` 类模式必然命中它，
而父条目命中会让子测试全部执行。本机 node v24.13.0 上四种否定锚定形式全部无法排除（见研究 02 §二）。
因此：本次验收命令一律用**正模式选择**（如 `--test-name-pattern subscribe_terminal`）；
若将来需要按名字排除，只能正模式选择、拆文件或用 env knob。

**并要求 flag 前置（第 2 轮 R2-D2 追加）**：`--test-name-pattern` 必须写在位置参数（测试文件）**之前**——
写在文件之后时本机 node v24.13.0 会静默忽略它并跑满全文件（实测：`node --test test/budget-audit.test.mjs
--test-name-pattern 'rule-a pass'` → 7/7；flag 前置 → 1/1）。本文档所有含该 flag 的命令一律采用
`node --test --test-name-pattern <模式> <文件>` 的形态。

### D7：为 control-reconcile 的 A2 reconnect 等待点补 capture（**已纳入**，用户 2026-10-13 裁定）

`control-reconcile.integration.test.mjs` 未接 F3 capture，它再红时没有现场（10-11 的 `A2 reconnect` 15.7s 即如此）。
本次为**该用例的等待点**补 `capture`，使相邻签名下一次红自带现场。纳入理由：与 D3「让下一次红自带现场」
同源、改动小、直接减少后续考古成本。A2 reconnect 的**等待逻辑本身仍然不动**（见 §6 非目标）。

**前置动作（第 1 轮 R1-D2 修正）**：该文件的本地 `waitFor` 没有 capture 槽
（`test/control-reconcile.integration.test.mjs:38` 是 `async function waitFor(predicate, timeoutMs = 15000)`，
对照 `pty-runner.integration.test.mjs:31` 有第三参 `capture = null`）。所以原稿「只传 capture 参数」在该文件现状下
不成立，必须**先给它的 `waitFor` 加第三参并委托 `waitForWithPostmortem`**（镜像 `:31`，不改等待条件与预算），
再在调用点接线。

**覆盖计数（修正）**：A2 用例体（`:335-489`）实测有 **13 处** `await waitFor(`，原稿「约 4–5 处」是低估。
本次覆盖范围为 **A2 用例体内的全部等待点**；同文件其余用例（`:490`、`:567`、`:662` 的 A2 epoch 系列）不在本次范围。
10-11 那次 A2 reconnect 烧在哪个具体等待点事先未知，只有用例体全覆盖才能保证下一次红必有现场。

## 3. 组件契约

### 3.1 `test-support/echo-probe.mjs`（新）

```js
/**
 * Send echo probes on an interval until the caller observes the echo (the standard wait for
 * the accept-registration race, replacing the one-shot boot banner).
 * @param {{ send: (line: string) => void, intervalMs?: number, sleep?: (ms: number) => Promise<void> }} io
 * @returns {{ line: () => string, start: () => void, stop: () => void }}
 */
export function createEchoProbe(io)
```

- 纯逻辑与 I/O 分离：`send`/`sleep` 可注入；判定（回显是否到达）留给调用方的 `waitFor`
  （复用各文件既有的 `waitForWithPostmortem` 包装）。
- **实现形态已钉死（第 1 轮 R1-D3）**：`start()` 启动一个 `while (!stopped)` 循环，每轮
  `n += 1` → `send(\`boot-probe-${n}\r\`)` → `await sleep(intervalMs)`。
  **不得用 `setInterval`**——否则注入的 `sleep` 成死参数，A1 的纯 fake 单测无法构造
  （A5 现状用 `setInterval`，迁到 helper 时随之改为本形态；由此产生的首探针时序差异见 D1）。
- **`now` 已从 io 契约删除（第 2 轮 R2-D3）**：钉死的 while/sleep 形态不读墙钟，保留 `now` 只会让它
  成为一个永不参与行为的死参数，反而诱使实现者给它发明用途（如按墙钟对齐发送时刻），把 R1-D3 刚关上的口子换个位置重开。
- `n` 首发值为 **1**（与 A5 现状等价：`probeN = 0` 后先自增再发送），A1 据此断言。
- `stop()` 置停止标志，在途 `sleep` 返回后循环不再发送；幂等，可重复调用。
- `line()` 返回**最近一次已发送**的探针行，仅供失败诊断复用；helper 自身不参与判定、不断言。
- 实现期注释一律**英文**（仓规 AGENTS.md「Conventions：English comments and commit messages」；
  同目录 `test-support/flake-postmortem.mjs:16-23` 为英文 JSDoc 样例）。

### 3.2 `test-support/flake-postmortem.mjs`（改）

`capturePostmortem` 返回值增加 `screenLogTail: string | null`；`formatPostmortem` 增加一行输出。
截断规则做成纯函数 `tailSlice(text, maxBytes)`，多字节字符边界不劈开。

### 3.3 两个用例改写 + 一个用例新增（`test/pty-runner.integration.test.mjs`）

见 D1 / D2 / D4。预算审计门禁（`test/budget-audit.test.mjs`）必须继续零违规——新增/改动的等待都走
文件内默认 15000ms 的 `waitFor`，不声明用例级 timeout，天然满足规则 (a)/(b)。

### 3.4 `control-reconcile.integration.test.mjs`（D7 已纳入）

两步，顺序不可颠倒：

1. 给该文件本地 `waitFor`（`:38`）加第三参 `capture = null` 并委托 `waitForWithPostmortem`
   （镜像 `test/pty-runner.integration.test.mjs:31`）；
2. 为 `A2: reconnect wires hello → reconcile → subscribe in order`（`:335-489`）**用例体内全部等待点**
   （实测 13 处 `await waitFor(`）传入 `() => formatPostmortem(capturePostmortem(root, "v1", null))`。

不改任何等待条件与预算；`viewId "v1"` 已核实正确（`:342`）。

### 3.5 静态接线断言落为持久化测试（`test/wait-capture-wiring.test.mjs`，新；第 1 轮 R1-D1）

原稿把 A3/A7 的「`rg` 断言」写成四个字：没有模式、没有命令、没有落位（一次性 shell 还是持久化测试未定），
第三方无法复跑，也不防回归。现改为**一个持久化静态测试文件**，读真实测试源码断言三件事：

1. `test/pty-runner.integration.test.mjs` 的 editor_state 用例体内，每个 `await waitFor(` 都带第三参；
2. 同文件 subscribe_terminal 用例的快照断言仍在（源码中仍含 `fake pi ready` 与 `begin.snapshotSeq`），
   即 A2 的「不能靠删断言变绿」有机械保障；
3. `test/control-reconcile.integration.test.mjs` 的 A2 用例体内同样每处 `await waitFor(` 都带第三参。

仓内先例：`test/architecture-writer-boundary.test.mjs`、`test/budget-audit.test.mjs`（都读真实树做断言）。
**边界声明**：这是源码文本级断言，**不证明**运行时真的会打印现场（那由 A5 的 fixture 单测与 A2/A3 的
integration 兜底）；它的唯一职责是防止「接线被后人删掉」这类静默回归。

## 4. 可测性拆分设计（硬约束，实现阶段不得重新耦合）

| 单元 | 性质 | 怎么测 | 覆盖验收项 |
|---|---|---|---|
| `createEchoProbe` | **副作用薄层**，I/O 全注入（send/sleep） | 注入 fake：sleep 驱动循环、N 首发 1、stop 幂等、缺省 interval | A1 |
| `tailSlice` | **纯函数** | 直接传字符串：截断、短于上限原样、多字节边界 | A5 |
| `capturePostmortem` / `formatPostmortem` 扩展 | I/O 读 + 纯渲染（沿用既有分层，只加一个字段） | fixture 单测：screen.log 存在 / 缺失 / 超长 | A5 |
| subscribe_terminal 改写 | integration（真实 spawn） | A2 + A6b | A2 / A6b |
| editor_state 改写 | integration + static | A3（行为）+ 等待点位置的静态断言（`:532` 起） | A3 |
| editor_state 的 capture 接线 | static（持久化测试） | `node --test test/wait-capture-wiring.test.mjs` 断言每处等待都带第三参 | A3 / A7 |
| 复现用例 | integration（负载无关） | A4 | A4 |
| D7 的 capture 接线 | static | 先扩 `waitFor` 签名，再为 A2 用例体 13 处等待接线（不改行为） | A7 |

边界声明：**探针发送（副作用）↔ 回显判定（既有 waitFor）↔ 快照断言（用例）三层不得合并**；
不允许把 echo 判定内联进 helper，也不允许 helper 自己断言。

## 5. 验收矩阵

> **判据按签名对账，不按「套件全绿」。** 负载剖面下范围外签名（`A5 burst`、`A2 reconnect`）仍可能红，
> 它们如实记录、不阻塞本 issue；本 issue 的两条目标签名必须零命中。
> **「全绿」只在剖面仍有判别力时才算证据**——A6① 的补丁前控制轮就是这条判据的阳性对照（第 1 轮 R1-G2）。

### 自动化验证

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | echo-probe helper 行为 | 自动化（unit，新 `test/echo-probe.test.mjs`） | `node --test test/echo-probe.test.mjs` | fake 注入下：由 `sleep` 驱动循环、按 interval 发送 `boot-probe-N\r`、**N 首发 1** 且递增；`stop()` 幂等且之后不再发送；缺省 interval=300；不依赖真实定时器 |
| A2 | subscribe_terminal 行为不变 | 自动化（integration，**正模式选择**） | `node --test --test-name-pattern subscribe_terminal test/pty-runner.integration.test.mjs`（**flag 必须在位置参数文件之前**——第 2 轮 R2-D2 实测：写在文件之后时 flag 被忽略，本机 node v24.13.0 上 `node --test <file> --test-name-pattern 'rule-a pass'` 跑满 7/7，flag 前置才 1/1） | 用例通过；snapshot 内容断言（`fake pi ready`、`snapshotSeq ≥ 1`）**仍被执行且通过**（不能靠删断言变绿） |
| A3 | editor_state 注册证明 + 现场接线 | 自动化（integration + static） | `node --test --test-name-pattern editor_state test/pty-runner.integration.test.mjs` + `node --test test/wait-capture-wiring.test.mjs` | 用例通过；client2 的等待点确为服务端 hello，且在 client1 发 editor_state 之前；该用例每处等待都带 capture（再红时能打出 `screenLogTail`） |
| A4 | 确定性复现 before/after | 自动化（integration，新用例，**负载无关**） | 同文件新用例 | leg1：screen.log 有 banner 而 legacy socket 未收到（负断言由 echo 事件驱动）；leg2：echo-probe 收敛通过；用例在 15s 内完成（记录本地实测耗时） |
| A5 | postmortem screen.log 尾巴 | 自动化（unit，`test/flake-postmortem.test.mjs`） | fixture：文件存在 / 缺失 / 超长截断 | 输出含 `screenLogTail:` 行；缺失为 `<absent>`；截断不劈多字节字符 |
| A6 | **负载剖面稳定性（主证据）** | 自动化（重复：补丁前控制轮 + 全量负载） | ①**控制轮**：在 **PR 的 merge-base** 提交上（2026-10-13 实况即 `f47766c`；合并前 main 前移则随 merge-base 前移，**不写死**）用独立 git worktree 检出，**先在 worktree 内装依赖**再跑——裸 worktree 无 `node_modules`，而目标用例的加载路径静态依赖 `@xterm/headless`（`runner/pty-runner.mjs:25` → `src/core/terminal-model.mjs:1`，无回退），不装会立刻崩在 `Cannot find package`；装法二选一：`npm ci`（仓内有 `package-lock.json`，node-pty 原生构建与 postinstall 随之执行）或 symlink 主 checkout 的 `node_modules`；随后跑 `npm test` ≥1 轮（控制轮的负载相关部分就是 `npm test` 自身的并行度），记录两条目标签名是否复红；②修后全量 `npm test` 连跑 ≥5 轮，逐轮记录 `pass/fail/skipped`、耗时与失败签名；另跑 `npm run verify` ≥2 轮 | 两条目标签名零命中；范围外签名如实记录不阻塞；逐轮数据留档；**控制轮结果必须一并留档**——若控制轮未复红，说明该剖面此刻不具判别力，则「修后全绿」不构成阳性证据，须在 issue 台账如实标注并降级其证据强度 |
| A6b | 隔离冒烟 | 自动化（重复，隔离） | `node --test test/pty-runner.integration.test.mjs` 连跑 ≥10 轮 | 10/10 绿。**声明：这不构成修复证据**——修复前隔离跑也是全绿（187ms 通过），只作廉价回归冒烟 |
| A7 | 全量与门禁 | 自动化（build + static） | `npm run verify`；budget-audit；覆盖率；`node --test test/wait-capture-wiring.test.mjs` | budget-audit 零违规；覆盖率阈值仍过（Lines ≥85 / Funcs ≥80 / Branches ≥70）；**PR diff 不含 `.github/workflows/ci.yml`（对照 PR 的 merge-base，而不是 spec 头部写的 `f47766c`：两者当前恰好等价，但合并前 main 若另动 ci.yml，按 `f47766c` 对字节会假失败）**；等待点确带 capture |

### 用户实测 / 合并后观测

| ID | 功能点 | 验收方式 | 步骤与观察 | 通过标准 |
|----|--------|----------|------------|----------|
| U1 | 两条签名在 CI 观察窗消失 | 用户实测（合并后对账，只读 main CI 日志） | **窗口定义**（建议值，用户可在验收时改写）：#95 台账当前观察窗，或合并后 ≥10 次 main CI run，取先到者；**证据源**＝main 上 CI 的日志（无需本地拉取 / 重启 / 路径指向，故无部署前置）；逐次把结果记回 #95 台账；若再红，读增强 postmortem 的 `screenLogTail` | 窗口内 `subscribe_terminal` / `editor_state` 在 main CI 零出现；若出现，现场能区分「banner 没落盘」与「落盘未转发」 |

## 6. 非目标

- **不改生产代码**（`runner/`、`src/` 行为零变化）；不给 legacy 客户端加重放（那是设计事实，D4 用例钉住它）。
- **不动 `ci.yml`**、不做测试串行化（F5 在 #95 继续押后）。
- **不动 `A5 burst` 的残留**（它已有 echo-probe 仍红过两次：10-01、10-10；机制未明，留 #95 观察）。
- **不修 `A2 reconnect`**（10-11 的 15.7s）：代码级核实它**已等**服务端 hello（`control-reconcile:352`），
  不存在本 issue 的等待缺口；fixture 是 `steady` 持续流而非一次性 banner → 不属本族机制。留 #95 台账。
  （D7 已纳入：为它补现场覆盖——仍不修它的等待逻辑。）
- **不做全量 capture 迁移**（147 个等待点的覆盖缺口是 #95 残留清单项）。
- **不新增依赖**、不重命名任何测试文件。

## 7. 风险与回退

| 风险 | 缓解 |
|---|---|
| echo-probe 在极端负载下仍失败（子进程 15s 内完全没被调度） | D3 的新现场直接区分子进程侧/转发侧；真撞上按新证据再立项 |
| 负载剖面对账时范围外签名红，被误判为本 issue 失败 | §5 开头的判据声明 + A6 逐轮记录签名的要求 |
| A5 迁移到共享 helper 引入意外差异 | diff 对照 D1 的三条不变量（间隔 300ms / 正则 / 结束即停）＋已知且被证明无害的差异（首探针 t≈0）；CR 反对则退化为「A5 不动，helper 只服务新代码」 |
| 控制轮因缺依赖中途失败，实现者即兴回主 checkout 用 stash/checkout 切换 | A6① 已写明装依赖前置；**禁止**用 stash/checkout 切换主 checkout 制造「补丁态 / 基线态」混淆（worktree 本就是为了避开这一点） |
| 复现用例 leg1 依赖时序运气 | 用 screen.log 轮询保证 banner 已广播，确定性成立 |
| 负断言写成新的墙钟竞态 | D4 明确：负断言由 echo 到达事件驱动 |
| 踩 `--test-name-pattern` 负模式 / flag 位置写错 | D6 硬约束（正模式 + flag 前置）+ 验收命令一律采用 `node --test --test-name-pattern <模式> <文件>` 形态 |
| D7 的 capture 接线改动行为 | 先扩 `waitFor` 签名再接线，两者都不改等待条件与预算；A7 静态断言 + 全量剖面复核 |
| 预算审计门禁误报新用例 | 新/改用例不声明用例级 timeout、等待走文件默认 15000ms；A7 跑门禁确认零违规 |
| A6① 控制轮恰好未复红，导致「修后全绿」被误读为修复证据 | 控制轮结果强制留档；未复红时在 issue 台账降级标注证据强度，不得当作阳性证据 |
| §3.5 的静态接线测试是源码文本级断言，可能被无关重构误报 | 断言只锚 `await waitFor(` 的实参形态与两条快照断言的存在性；误报即改断言，不得删断言或阈值 |
| editor_state 补 capture 后该用例首次变红时输出体积增大 | 只增 `screenLogTail`（≤2KB）与既有一行，不改等待预算；`capturePostmortem` 的渲染路径已在 A5 覆盖 |

**回退**：全部改动在 `test/` 与 `test-support/` → 回退 = revert 单个 PR。

## 8. 文档更新

- 无 README/VERIFY.md 变化（不新增用户可见命令）。
- 合并后回 #178 记录验收证据（含 A6 逐轮签名分布）；回 #95 更新观察台账。
- 建议后续沉淀：`--test-name-pattern` 负模式不可用（工具行为，KB 未收录）；
  给 `subscribe_terminal` 笔记补「全量负载即可复现，隔离 187ms 通过」。（另行确认，不在本 PR 内）

## 9. 迁移顺序（step 6 的 plan 将据此拆 task）

1. `test-support/echo-probe.mjs` + `test/echo-probe.test.mjs`（A1）
2. `test-support/flake-postmortem.mjs` 加 `screenLogTail` / `tailSlice` + fixture 单测（A5）
3. subscribe_terminal 改写为 echo-probe（A2）
4. editor_state 补 hello 等待 + 全用例 capture 接线（A3）
5. 确定性复现用例（A4）
6. A5 迁移到共享 helper（不变量见 D1，允许首探针提前到 t≈0）
7. `test/wait-capture-wiring.test.mjs` 静态接线测试（A3 / A7）
8. D7：先扩 control-reconcile 的 `waitFor` 签名，再为 A2 用例体 13 处等待接线（A7）
9. 验收扫尾：**A6① 补丁前控制轮**（merge-base 的独立 worktree → 装依赖 → `npm test` ≥1 轮）→ A6② 修后全量剖面 ≥5 轮 + `verify` ≥2 轮 → A6b 隔离 ≥10 轮 → A7 门禁，逐轮签名数据记录回 issue
