# Spec — Issue #95 切片：临时隔离 `internal marker failure … (legacy main)` 并补 F3 现场

> 状态：**DRAFT 待用户确认**（`stepwise` 档，步 4 收敛后 ⏸）
> 认领：zhuxixi（2026-11-22）
> 调研：同目录 `research/01-red-state-and-scope.md`、`research/02-mechanism-evidence.md`（2026-09-25）、
> `research/03-legacy-quarantine-slice.md`（2026-11-22，本切片专属）
> 上游：issue #95（umbrella，本切片**不关闭**它）
> 基线 HEAD：`c1e39cd`（2026-11-23 main；目标相关文件与 `df083a5` 无差异；已完成的 run `43781526496` Node 22 Coverage 红在本切片目标用例）
> Drafted: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-22T21:57:44+08:00
> Revised: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-22T22:14:46+08:00（R1：接受 R1-G1 + R1-D1…D5 全部六条）

> Revised: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-11-22T22:30:23+08:00（R2：收敛，接受 R2-D1…D3 三条细化；A7 预算改为有实测依据的 240s）

## 1. 问题陈述

`test/attach-frame-witness.integration.test.mjs` 的
`internal marker failure revokes capability via onUnavailable (legacy main)` 是 main CI 的反复红源：
11-16 run `43781526496` 上它烧满 15s 等待（`duration_ms 15263.9`），失败信息只有一句 `timed out waiting`；
同一 run 的 owned 半边与 Node 24 双 job 全绿。issue 台账记录该签名近 6 次 main CI 有 5 次命中。

这条红属于 #95 已定论的 B 类：**事件产生了，但没在墙钟窗口内到达**（并行争抢 + 默认文件级并发）。
它**不是** A 类（事件根本没产生的生产缺陷）——没有证据指向 legacy runner 的降级链路本身坏了。

**本切片的定位是临时隔离，不是修复。** #95 的结构性病因（无串行化、墙钟预算）原样保留，
恢复条件写死为「process 相位串行化落地后 revert」。

## 2. 设计决策

### D1：只跳 legacy 半边，owned 半边原样保留并继续跑

`for (const legacy of [false, true])` 生成的两个用例共享**同一段参数化 test 体**，因此隔离只能写成条件式：

```js
{ skip: legacy ? "issue #95: temporary quarantine … restore after process-phase serialization" : undefined }
```

`legacy === false`（owned）时 `skip` 为 `undefined`，用例照常执行；`legacy === true` 时跳过并输出理由。
skip 理由是字符串而非 `true`，会原样出现在 TAP 输出里，让每次跳过都自证原因。

skip 文案须包含三要素：`issue #95`、临时性质（temporary quarantine）、恢复条件（restore after process-phase serialization）。

- **为什么不整条删**：它保护的跨进程降级链路（marker 写失败 → `onUnavailable` → `socket.destroy`
  → runner 清理 → 广播 `enabled:false` → host.json 改写）只有本用例在测；
  `attach-frame-reporter.test.mjs:557` 的单测只覆盖第一步。整条删 = 撤掉兜底保护。
- **为什么跳 legacy 而不是 owned**：owned 是现代默认路径（`attachMode==="protocol" && frameWitnessAvailable`），
  保护价值更高，且当前不是红源。
- **为什么不用 `--test-name-pattern` 隔离**：#178 D6 已实证 Node 24 下负向前瞻排除不掉测试（root 聚合条目名称为空、恒匹配）。

### D2：保留的 owned 半边必须补 F3 现场快照

本文件是 F3 纪律的漏网文件（同族 6 个文件已接 `test-support/flake-postmortem.mjs`，本文件零命中）。
给 owned 半边的两处等待接上 capture thunk，使超时错误自带 **host / state / diagnosticsTail / journal / screenLog** 现场。
**`status` 恒为 `<absent>`，不是「可能缺失」**：`capturePostmortem` 只在 `runId` 非空时才读 status
（`test-support/flake-postmortem.mjs:87`），而本文件 fixture 直接 spawn `pty-runner`、不经协调器建 run，全文件无 `runId`。
本切片不改这个行为——为拿到 status 而引入协调器属于范围扩张。

实现走**本文件本地 `waitFor` 的可选参数**，与同族 `runner.integration.test.mjs:71` 的既有写法一致：

```js
async function waitFor(predicate, timeoutMs = 15000, capture = null) {
	return waitForWithPostmortem(predicate, { timeoutMs, intervalMs: 25, capture });
}
```

- **默认值与轮询间隔不变**（15000 / 25ms），未传 capture 的既有 74 处 `await waitFor(` 调用行为字节级不变。
- 只在 owned 半边传 capture；legacy 半边已 skip，不接。
- **不做全文件迁移**：其余 18 个用例的等待不在本切片范围，避免 diff 膨胀。

### D3：守卫必须钉「条件式 skip」这一具体形态，并给 TAP 面一个真归属

**前置事实（决定守卫怎么写）**：两个「半边」不是两段独立源码，而是**同一段参数化 test 体**——
`for (const legacy of [false, true])` + 模板串名（`test/attach-frame-witness.integration.test.mjs:1320-1321`）。
所以「owned 段无 skip / legacy 段有 skip」在源码文本上互斥，**唯一可实现且防得住扩大化的守卫是钉住条件式形态**：

```js
{ skip: legacy ? "issue #95: temporary quarantine …" : undefined }
```

沿用 `test/wait-capture-wiring.test.mjs`（#178 A3/A7）的源码级手法，新增守卫断言五件事：

1. 用例体匹配 `skip:\s*legacy\s*\?\s*"issue #95[^"]*"`，且 false 分支为 `undefined`
   ——拍平成 `skip: "…"`（全跳）或删掉 skip（隔离失效）都会红；
2. skip 文案含「temporary quarantine」与恢复条件关键词；
3. 两条核心断言仍在，**以磁盘源文本为准**（`:1327` 与 `:1330`，含 `msg.` 前缀与可选链）：
   广播断言 `msg.status?.frameWitness?.enabled === false`、host 断言 `readHost(root, viewId)?.frameWitness?.enabled === false`
   ——删断言不是转绿的方式；守卫按真实文本写正则，不得按转述写；
4. 用例体内每个 `await waitFor(` 都以裸 `capture` 收尾（复用既有正则 `/,\s*capture\s*$/`）；
5. 本地 `waitFor` 委托层的默认值文本仍为 `timeoutMs = 15000` 与 `intervalMs: 25`。

**TAP 面（「owned 半边真的在跑」）必须有自动归属，不能靠人眼扫**：新增一条用例 spawn
`node --test test/attach-frame-witness.integration.test.mjs`（预算见下），
解析其 TAP 输出，断言：legacy 条目带 `# SKIP` 且理由含 `issue #95`；owned 条目为 `ok` 且**不含** `SKIP`。
这条是本切片唯一会 spawn 进程的守卫，与纯文本守卫分文件存放（见 §3.2）。

**预算依据（实测，非拍脑袋）**：本机（8 核、Node v24.22.1）跑目标文件全量 29 条用例，墙钟 **45.08s**、
`duration_ms 45058`，29 pass / 0 fail / 0 skipped；目标用例单条约 0.51s（基线 TAP 留档见下）。
取 `{ timeout: 240_000 }`（4 分钟 ≈ 5.3× 本机实测）以容纳 CI 慢机与 c8 插桩开销，
并按 `scripts/budget-audit.mjs` 规则 (b) 附 `// budget: spawns the whole 29-case file; 4 min = 5.3x the 45.08s local measurement` 豁免。
若实测 CI 上仍不够，改预算属于后续 PR 的事，不在本切片里反复加宽。

### D4：范围与硬边界

- **只动测试**：不改 `runner/`、不改 `src/`、**`ci.yml` 零改动**、不加依赖、不改任何测试用例名称。
- **不改预算数值**：15s / 5s 等待与文件内既有的 `{ timeout: 20000 }`（`spawnSync` 选项，非 test 超时）原样保留。
  本切片不是预算调整，预算纪律由 #95 F2 的 `budget-audit` 门禁继续把守。
- **不动 #95 的其它签名**：`subscribe_terminal`、`A5 burst`、`attach-entry-22` B/Q、reporter 系列等一律不碰。
- **不关闭 #95**：PR 描述用 `Refs #95`，不用 `Fixes`。

## 3. 组件契约

### 3.1 `test/attach-frame-witness.integration.test.mjs`（改）

| 点 | 改动 |
|---|---|
| import | 新增 `capturePostmortem, formatPostmortem, waitForWithPostmortem`（来自 `../test-support/flake-postmortem.mjs`） |
| `waitFor` | 签名加第三个可选参数 `capture = null`，函数体改为委托 `waitForWithPostmortem`，默认 `timeoutMs = 15000`、`intervalMs = 25` 不变 |
| legacy 半边 | test 选项加 `{ skip: legacy ? "issue #95: temporary quarantine …" : undefined }`（条件式，见 D1） |
| owned 半边 | 用例体内先建命名绑定 `const capture = () => formatPostmortem(capturePostmortem(root, viewId, null));`，两处 `await waitFor(...)` 以裸 `capture` 收尾 |

capture 使用 `runId = null`：本文件的 fixture 直接 spawn `pty-runner`、不经协调器创建 run，因此现场里 `status` 恒为 `<absent>`
（见 D2）；`capturePostmortem` 对其余缺失文件一律安全返回 `null`（`safe()` 包裹），不会二次抛错。

**形态必须与兄弟文件先例一致**：`control-reconcile.integration.test.mjs:343` 与 `pty-runner.integration.test.mjs:521`
都是「命名 `capture` 绑定 + 裸标识符传参」，既有守卫正则 `/,\s*capture\s*$/`
（`test/wait-capture-wiring.test.mjs:120,127`）也只认这个形态。写内联 thunk 会让复用的守卫必红。

### 3.2 `test-support/test-source-scan.mjs`（新，纯函数模块）

**为什么放 `test-support/` 而不是从守卫文件 import**：`test/wait-capture-wiring.test.mjs` 在 import 时即注册 5 个顶层 `test()`，
跨测试文件 import 会在新守卫文件的 `node --test` 进程里把这 5 个用例**再跑一遍**（`node --test` 对每个测试文件各起一个子进程；`scripts/run-tests.mjs:331` 把全部文件交给单个 `node --test` 调用），
红时失败归因翻倍。故把纯函数移到 `test-support/`，两个守卫文件都从那里 import——符合仓约定的「纯函数 + 薄 I/O 壳」分层。

迁移内容（实现阶段不改其逻辑，只搬家）：

- `testCaseBody(source, marker)` —— 从 `test/wait-capture-wiring.test.mjs:40` 迁入并 re-export，原文件改为 import；
- `waitForCalls(body)` —— 从 `:55` 迁入，同上；
- `indentedTestCaseBody(source, marker)` —— **新增**，处理本切片目标用例位于 `for` 循环内、**缩进一级**的情形：
  起始为行首 `\ttest(`，收尾为该缩进层级的 `\n\t});`；marker 不存在或找不到收尾都显式抛错（防空跑成绿）。

### 3.3 `test/frame-witness-quarantine.test.mjs`（新，unit/static）

纯文本守卫（D3 第 1/2/3/4/5 条）+ `indentedTestCaseBody` 的真值表单测。不 spawn 进程。

### 3.4 `test/frame-witness-quarantine-tap.test.mjs`（新，integration）

唯一 spawn 子进程的守卫：跑目标文件、解析 TAP、断言 legacy SKIP / owned 非 SKIP（D3 的 TAP 面）。
与纯文本守卫分文件，避免「只想跑静态检查」时被迫跑一遍真实 runner 套件。

### 3.5 非组件

不新增 `src/` 模块、不改 `scripts/run-tests.mjs`、不动 `package.json` 脚本。
`test/wait-capture-wiring.test.mjs` 只改 import 来源，其 5 个用例的断言与行为不变。

## 4. 可测性拆分设计（实现阶段硬约束）

| 单元 | 性质 | 怎么测 | 验收 |
|---|---|---|---|
| `indentedTestCaseBody(source, marker)` | **纯函数**（字符串处理，无 I/O） | 直接传字符串样本，断言：正确截取、不吞掉后续用例、marker 缺失抛错、收尾缺失抛错 | A1 |
| `waitFor` 委托层 | 薄壳，决策全在已测的 `waitForWithPostmortem` | 不新增单测；由 `test/flake-postmortem.test.mjs` 既有 11 个顶层用例覆盖核心逻辑；默认值由静态守卫钉住（A2） | A2 |
| capture thunk | 纯 I/O 读取 + 已测的 `formatPostmortem` | 由 `test/flake-postmortem.test.mjs` 覆盖渲染；本切片只保证接线形态 | A3 |
| 条件式 skip 接线 | 声明式 test 选项 | 静态守卫钉形态（A4）+ TAP 实证（A7） | A4 / A7 |
| 纯函数迁移 | 搬家不改逻辑 | `test/wait-capture-wiring.test.mjs` 既有 5 个用例原样通过即回归钉 | A6 |

边界声明：**解析（纯）↔ 等待（已测共享件）↔ 断言（测试）三层不得合并**；
不允许把 `indentedTestCaseBody` 内联进断言里，也不允许在目标文件里重写一份 postmortem 渲染。

## 5. 验收矩阵

### 自动化验证

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 缩进用例段解析 + 纯函数迁移 | 自动化（unit，`test/frame-witness-quarantine.test.mjs`） | `node --test test/frame-witness-quarantine.test.mjs` | 真值表通过；marker 缺失 / 收尾缺失均抛错（防空跑成绿）；不吞后续用例 |
| A2 | 默认等待行为不变 | 自动化（static，同上） | 静态守卫断言委托层文本含 `timeoutMs = 15000` 与 `intervalMs: 25`；`node --test test/attach-frame-witness.integration.test.mjs` 退出码 0 | 默认值被改即红；`git diff` 复核为评审注记，不计入自动化 |
| A3 | owned 半边现场接线 | 自动化（static，同上） | 静态守卫断言用例体内每个 `await waitFor(` 以裸 `capture` 收尾（复用 `/,\s*capture\s*$/`） | 全部命中；漏接即红 |
| A4 | skip 是条件式且只落 legacy | 自动化（static，同上） | 断言用例体匹配 `skip:\s*legacy\s*\?\s*"issue #95[^"]*"` 且 false 分支为 `undefined` | 拍平成全跳、或删 skip，均红 |
| A5 | 降级断言未被削弱 | 自动化（static，同上） | 静态守卫按磁盘真实文本断言两条核心断言仍在用例体（`msg.status?.frameWitness?.enabled === false`、`readHost(root, viewId)?.frameWitness?.enabled === false`） | 均在；任一被删即红 |
| A6 | 既有套件与迁移回归 | 自动化（unit + integration + build） | `node --test test/wait-capture-wiring.test.mjs`；`npm run verify` | 既有 5 个守卫用例原样通过；verify exit 0（typecheck + perf gate + 全量测试 + 覆盖率阈值 85/80/70 + pack:dry） |
| A7 | TAP 面：owned 真的在跑、legacy 真的被跳 | 自动化（integration，`test/frame-witness-quarantine-tap.test.mjs`） | `node --test test/frame-witness-quarantine-tap.test.mjs`（该守卫内部 spawn `node --test test/attach-frame-witness.integration.test.mjs` 并解析 TAP） | legacy 条目带 `# SKIP` 且理由含 `issue #95`；owned 条目为 `ok` 且不含 `SKIP`。两版 Node 由 CI 矩阵各跑一次（A8） |
| A8 | CI 双矩阵 | 自动化（CI） | PR 的 `Test (Node 22)` / `Test (Node 24)` | 两个必需检查均绿；A7 的 TAP 守卫在两版 Node 上都执行并通过 |

### 用户实测 / 合并后观测

| ID | 功能点 | 验收方式 | 步骤与观察 | 通过标准 |
|----|--------|----------|------------|----------|
| U1 | 该签名不再阻塞 main | 用户实测（合并后 CI 观测） | `gh run list --branch main --limit 8`，逐 run 记录失败点 | 合并后 ≥5 次 main run 中，`internal marker failure … (legacy main)` 零命中（它已 SKIP）；若 owned 半边转红，失败信息**必须**自带 postmortem 现场 |
| U2 | 隔离可回退 | 用户实测（#95 串行化落地时） | revert 本切片 commit 后跑 `node --test test/attach-frame-witness.integration.test.mjs` | 静态守卫同步更新后，legacy 半边恢复执行；本条是恢复动作的 checklist，不在本 PR 执行 |

**诚实声明**：A6/A7 全绿不能证明 #95 痊愈。本切片只移除一条签名，
同文件其余等待与其它 32 个真实进程文件的 flake 风险原样存在，U1 只对该签名负责。

## 6. 非目标

- 不实现 #95 的 process 相位串行化（F5/D1），不新增 CI job，不改分支保护。
- 不做 `attach-entry-22` B/Q 的 c8 相位剔除（属另一条线）。
- 不迁移本文件其它 18 个用例的 postmortem 接线。
- 不清理 `/tmp/agentview-*` 夹具残留（#95 F6 / #211）。
- 不改 `enforce_admins`、不使用 `--admin` 绕过必需检查。

## 7. 交付物清单

1. `test/attach-frame-witness.integration.test.mjs`：skip + F3 接线（预计 ~20 行）
2. `test-support/test-source-scan.mjs`：新纯函数模块（迁移 `testCaseBody` / `waitForCalls` + 新增 `indentedTestCaseBody`）
3. `test/wait-capture-wiring.test.mjs`：改为从 `test-support/test-source-scan.mjs` import，断言不变
4. `test/frame-witness-quarantine.test.mjs`：新纯文本守卫 + 解析真值表（预计 ~110 行）
5. `test/frame-witness-quarantine-tap.test.mjs`：新 TAP 实证守卫（预计 ~60 行）
6. spec 文档落 worktree `docs/superpowers/specs/2026-11-22-issue-95-legacy-quarantine-design.md`（首个 commit）
7. plan 落 worktree `docs/superpowers/plans/2026-11-23-issue-95-legacy-quarantine.md`
8. issue #95 评论：切片交付对账 + 「未结案」声明 + 恢复条件
