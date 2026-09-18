# Spec：← detach tier-1 锚点劫持 + editor-state reporter 端点断连（issue #103）

日期：2026-09-18 · 状态：approved（用户确认 D1 = R1）
基线：`main @ f657528`
调研：issue #103 评论 Round 1（根因复现）/ Round 2（方案约束）/ Round 3（f657528 复核 + 4 条增量发现）

## 1. 根因（systematic-debugging 结论）

### A. tier-1 反色锚点无形态校验

`src/ui/pty-attach.ts:372 childInputLooksEmpty()` 调 `findLastInverseCellLine()`（自底向上取**第一个含反色 cell 的行**），`:381-386` 无条件把该行当编辑器行。

假设「反色 cell 只可能来自编辑器假光标」不成立：pi 本体在聊天区也渲染反色 —— `renderDiff` 的行内变更片段、通知条整条反色、searchCurrentMatch、alt-screen 选择高亮。而编辑器假光标行**常常不在 buffer 里**（差分帧不重绘未变化的行），于是锚点落到聊天区反色行 → 该行有文本 → 判"有草稿" → `←` 被吞。

**间歇性来源**：假光标是否在 buffer 内取决于绘制时序。

**证据**：view_06f9f09cee 的 screen.log 3.4MB 中 117 处 `ESC[7m`；活体 view_e81b4d8d10 的 2.7MB 日志中反色行 275 = 263 行「空白 + 单反色 cell」编辑器假光标 + 12 行聊天区 diff 内容。

### B. editor-state reporter 端点失配（仅 owned 路径）

| 端 | 地址 |
|---|---|
| reporter 连接（`src/index.ts:118`） | `controlSocketPathFor()` → `views/<id>/control.sock`（posix）/ `\\.\pipe\pi-agent-board-<viewId>`（win32） |
| owned runner 绑定（`runner/pty-runner.mjs:439` ← `src/runtime/service.mjs:279`） | `hostEndpointPathFor(..., instanceId)` → `control.<instanceId>.sock` / `…-<8hexhash>` |
| legacy runner 绑定（`runner/pty-runner.mjs:108`） | `controlSocketPath()` —— 与 reporter 一致 |

reporter 永远 ENOENT/EADDR → error 监听触发无限退避重连（上限 5s），永不成功 → `editorEmpty` 恒 `null` → 门禁永远落回有缺陷的启发式（A）。分派见 `runner/pty-runner.mjs:97-104`（有 `instanceId` 走 ownedMain）。

**实测证据**：view_e81b4d8d10 目录内只有 `control.2cec1af1….sock`，无 `control.sock`；活得好的子 pi 进程 `/proc/<pid>/fd` 中 socket fd = 0。

### C. 直修 B 会掐死 warm-host 回收（阻塞级）

reporter 是**常驻连接**，而 runner 把连接数直接当 `attachedClients`：

- owned：`:704 clients.add(socket)` → `:502 attachedClients: clients.size`；`attachedEver` 在 hello 时翻（`:914`，probe 除外）
- legacy：`:303 clients.add(socket)` + `:304 update({attachedEver: true})` —— **connect 即翻**

消费方 `src/core/warm-host-sweeper.mjs:53` 与 `src/runtime/service.mjs:807` 均以 `attachedClients !== 0` 跳过回收 → 宿主与子 session 永久泄漏（issue #75 的回收机制失效）。

## 2. 修复设计

### 2.1 A：tier-1 锚点形态校验（D1 = R1，已确认）

新增纯函数 `pickEditorAnchorLine(candidates)`，自底向上遍历**含反色字符的行**：只有「**恰好 1 个反色字符**」的候选才被采信。

| 候选行形态（反色字符数 = 1） | 判定 | 依据 |
|---|---|---|
| 字形行（`isProbablyPiInputLine`） | 编辑器行，empty 由 `isProbablyEmptyPiInputLine` 决定 | 场景 B/B3 的既有语义（draft 保护保留） |
| 非字形 + 文本全空白 | 新式 pi 空编辑器行（假光标）→ empty，放行 detach | pi-tui 空编辑器行 = 反色假光标 + 填充 |
| 非字形 + 有文本 | 新式 pi draft 行 → **跳过**（R1 取舍：兜底不采信） | 见下方「已知代价」 |
| 反色字符数 ≠ 1（多字符片段 / 通知条） | **跳过，继续向上扫** | 聊天区内容不得否决 detach |
| 扫完全部候选 | `null` → 交 tier-2 字形扫描 → 仍无 → `return true`（放行） | #48/#69/#72 逃生链不变 |

**为什么判据是「反色字符数」而不是「反色 cell 数」**（本机 `@xterm/headless` 6.x 实测）：

| 缓冲行 | 反色 cell 数 | 反色 `getChars().length` 累加 |
|---|---|---|
| `\x1b[7m草\x1b[27m稿`（宽字符 draft） | 2 | **1** |
| `\x1b[7m \x1b[27m`（空编辑器假光标） | 1 | 1 |
| `\x1b[7m Session saved \x1b[27m`（通知条） | 15 | 15 |
| `+ 65 ## \x1b[7mR2 · \x1b[27m#\x1b[7m822 新 step\x1b[27m`（diff） | 16 | 15 |

宽字符占 2 个 cell 但只有 1 个字符（续格 `getChars()` 返回空串）。**按 cell 计数会把中文假光标算成 2 → 字形行被误跳过 → 场景 B 的 draft 保护被破坏**，故判据必须是累加 `getChars().length`。

判定所需的「反色字符数」超出 `findLastInverseCellLine()` 的存在性判断 → UI 侧新增提取（副作用隔离），判定逻辑全部移入纯函数。

**已知代价（D1=R1 明确接受）**：新式 pi（编辑器行无 prompt 字形）+ 有 draft + reporter 不在线 → 兜底认不出 draft → 误 detach。可接受：detach 不丢草稿（子 session 继续跑，重新 attach 即回），而困死不可接受；B 修好后权威通道在位，A 只在连接窗口期/扩展缺失时兜底。按 K2 先例用场景 O3 钉住。

### 2.2 B：端点发现 + 反污染协议

1. **env 注入（两处 spawn 都做）**：`runner/pty-runner.mjs` 的 legacyMain（`:226`）与 ownedMain（`:784`）在子进程 env 中加 `AGENT_BOARD_CONTROL_SOCKET = socketPath`（各自"本宿主实际绑定的端点"）。
2. **reporter 侧解析**：新增纯函数 `resolveControlEndpoint({ envSocketPath, platform, root, viewId })` → env 有值优先，缺失/空串回落 `controlSocketPathFor()`（兼容旧 runner 与 legacy）。
3. **身份握手**：reporter 每次（重）连成功后立刻发 `{ type: "hello", clientId: "editor-reporter" }`，随后才开始推 `editor_state`。
4. **runner 反污染**：hello 分类抽成纯函数 `classifyClientHello(msg)` → `"probe" | "editor-reporter" | "client"`：
   - `probe`：维持现状（`markProbe`，不写 `attachedEver`），但 owned/legacy 都要把 `attachedEver` 移到 hello 判定之后；
   - `editor-reporter`：把该 socket **移出 `clients`**（恢复 `attachedClients` 计数），不翻 `attachedEver`，转入独立的 `editorReporters` 集合；
   - `client`：现状（记 `attachedEver`）。
5. **生命周期补齐**：`editorReporters` 在宿主关闭阶梯（owned `:560-563`）中一并 destroy，避免悬挂 socket 与重连退避循环。

## 3. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 锚点判定纯函数 | 自动化（unit） | `node --test test/pty-input.test.mjs` | 覆盖：字形空行→empty、字形 draft（含中文宽字符）→non-empty、非字形空白单反色→empty、非字形 draft→跳过、多字符 diff 行→跳过、通知条→跳过、无候选/畸形输入→null |
| A2 | 聊天区 diff 反色 + 无假光标空编辑器 → detach | 自动化（smoke） | `node --experimental-transform-types test-support/detach-gate-smoke.ts` 场景 **O1** | `detach=true`（当前 false） |
| A3 | 反色通知条 + 同上 → detach | 自动化（smoke） | 同上，场景 **O2** | `detach=true`（当前 false） |
| A4 | 钉住 D1/R1 取舍 | 自动化（smoke） | 同上，场景 **O3**：新式 draft（文本 + 单反色，无字形）+ `editorEmpty=null` | `detach=true`（有意放行，照 K2 先例钉住） |
| A5 | 既有 detach 语义不回归 | 自动化（smoke） | 同上，A/B/B1/B2/B3/C/D/E/F/H/I/J/K1/K2/L/M/N/E2 | 全绿，B/B3 的 draft 保护保留 |
| A6 | 端点解析纯函数 | 自动化（unit） | `node --test test/socket-path.test.mjs` | env 优先（posix 路径 / win32 pipe 名原样）、env 缺失或空 → 回落稳定路径 |
| A7 | reporter 身份握手 | 自动化（unit） | `node --test test/editor-state-reporter.test.mjs` | 首次 connect 后首帧为 `hello{clientId:"editor-reporter"}`；重连后再次发送 |
| A8 | reporter 不污染 attach 计数（owned） | 自动化（integration） | `node --test test/pty-runner.integration.test.mjs` | reporter 握手后 `attachedClients === 0` 且 `attachedEver === false`；真实客户端连接后 `attachedClients === 1` |
| A9 | legacy 路径同 A8 | 自动化（integration） | 同上（legacy 分支） | connect 不再单独翻 `attachedEver`；reporter 连接零污染 |
| A10 | 静态与全量 | 自动化（static + 全量 unit） | `npm run typecheck && npm test` | typecheck 0 error；测试 0 fail |
| U1 | 实机：diff 高亮在场时空编辑器可退出 | 用户实测 | attach 一个 Running 会话，聊天区有 diff 高亮，编辑器清空后单按 `←`，重复 ≥5 次 | 每次都 detach，无需 Ctrl+← |
| U2 | 实机：draft 保护仍在 | 用户实测 | attach 后输入草稿，按 `←` | 光标左移、**不** detach |
| U3 | 实机：权威通道恢复 | 用户实测 | attach 后观察 hello / host.json（或临时诊断） | `editorEmpty` 为 `true/false` 而非恒 `null` |
| U4 | 实机：warm-host 仍可回收 | 用户实测 | reporter 在线时让会话 idle，等 sweeper 周期 | 宿主被回收，无泄漏（回归 C 的阻塞点） |

## 4. 可测性拆分设计（实现硬约束）

| 拆分单元 | 位置 | 形态 | 测试边界 |
|---|---|---|---|
| `pickEditorAnchorLine(candidates)` | `src/core/pty-input.mjs` | 纯函数：入参 `Array<{text, inverseCharCount}>`（自底向上），出参 `{empty:boolean}\|null` | 零 IO / 零终端依赖 → `test/pty-input.test.mjs` 直接单测 |
| `resolveControlEndpoint({envSocketPath, platform, root, viewId})` | `src/core/paths.mjs` | 纯函数，platform 显式注入 | 零 IO；win32 分支断言 pipe 名原样返回，不真实绑定 |
| `classifyClientHello(msg)` | `src/core/host-protocol.mjs`（新） | 纯函数 → `"probe"\|"editor-reporter"\|"client"` | 双端共用、零 IO → 单测 |
| UI 侧提取 | `src/ui/pty-attach.ts` | 只做 `BufferLine → {text, inverseCharCount}`（副作用隔离） | 判定逻辑**不得**回流进 UI |
| reporter 握手 | `src/core/editor-state-reporter.mjs` | 复用现有 DI（`connect`/`scheduler` 注入） | 用现有 manual-clock fakeScheduler 断言帧序 |
| runner 反污染 | `runner/pty-runner.mjs` | `clients` / `editorReporters` 分账 | 走既有真实进程 integration 模式 |

## 5. 非目标

- 不改 pi 本体渲染；不引入边框结构锚点 / 光标 cell 锚点方案（留作后续 issue）。
- 不重构 warm-host 回收策略本身（本 issue 只保证它不被 reporter 掐死）。
- 不动 `Ctrl+←` 兜底语义（#89）与断开态的 `←` 逃生（#48）。

## 6. 风险

| 风险 | 对策 |
|---|---|
| R1 让新式 pi draft 失去兜底保护 | 已知代价，场景 O3 钉住；B 修好后权威在线率高 |
| legacy `attachedEver` 语义调整波及别的消费方 | 实现前 grep 全部 `attachedEver` 消费点，逐条确认 |
| Windows 命名管道名经 env 传递 | A6 单测（platform 注入）+ U1 真机；不依赖真实管道绑定 |
| reporter 移出 `clients` 后漏清理 | A8/A9 断言 + 关闭阶梯测试（`editorReporters` 一并 destroy） |
