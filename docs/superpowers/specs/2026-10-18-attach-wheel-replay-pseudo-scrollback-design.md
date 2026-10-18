Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-18T13:34:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-18T14:05:00+08:00 — 第 1 轮复核处置（R1-G1 公式修正、R1-G2 测试接缝、R1-D1..D9）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-18T14:20:00+08:00 — 第 2 轮复核处置（R2-G1 非有限数归零、R2-G2 reset 接线与验收、R2-D1 帧投递接缝、R2-D2 记号）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-18T14:35:00+08:00 — 第 3 轮复核处置（收敛轮，0 真缺口；R3-D1..D5 细化）

# issue #205 根因报告与修复设计：attach 滚轮被「快照帧溢出」的伪 scrollback 吞掉

仓库：zhuxixi/pi-agent-board · 基线：`origin/main` @ `b837286`（含 #204）

## 1. 症状（报告者环境）

pi fullscreen TUI → `/agent-board` → attach 会话：

- 滚轮能"动"，但滚动出来的是**旧屏幕碎片**（同一 editor 行重复），不是子会话 transcript
- PageUp/PageDown 正常滚动子会话
- `AGENT_BOARD_WHEEL_LINES=3` 在 fullscreen 下无效（文档已注明，非根因）
- 表现随终端高度变化，矮终端更严重

## 2. 根因

### 2.1 结论

`PtyAttachComponent` 把 **hydrate 快照帧时滚出本地视口的行**当成了"会话历史"，
于是 `tryScrollBy()` 恒为真，#199 的 `forwardWheelToChild()` 兜底永不触发。

### 2.2 机制

协议路径（`attachMode === "protocol"`）下：

1. 构造期 `replayScreenLog()` 先写入 60 KB legacy 重放（本问题无关，见 §2.4）
2. runner 用**它自己的尺寸**（子进程 PTY 尺寸，如 `300x65`）`captureTerminalSnapshot()` 并合成
   `synthesizeFullRedrawFrame()`（65 行 viewport + 0 行 scrollback）
3. attach 收到 `snapshot_begin { cols: 300, rows: 65 }`，发现与自身尺寸（`rows = terminal.rows - 2 = 38`）不符，
   只 `sendResize()`，**仍然接受并按 38 行终端 hydrate 这个 65 行的 frame**
4. `synthesizeFullRedrawFrame` 前导 `\x1b[2J\x1b[3J` 清了 viewport 与 scrollback
   （`src/core/terminal-snapshot.mjs:329-335`），但随后写入的 65 行 > 38 行，
   xterm 自然滚动出 **`65 - 38 = 27` 行** → `buffer.active.baseY = 27`
5. `bottomViewportTop(38) = min(65, 27 + 38) - 38 = 27` → `tryScrollBy()` 认为有 27 行历史可滚
6. 这 27 行是**当前屏幕顶部若干行**（不是历史），用户滚轮看到的就是它们 → "滚的是输入框内容的历史"

**行溢出不是唯一来源**：列宽不匹配（300 列的绝对定位帧写入更窄的本地 xterm）会按列换行，
同样推高 `baseY`。因此判据不能只算 `rows` 差，必须取**实际写入后的 `baseY` 增量**。

核心关系：

```
baseY_after_hydrate = 真实历史行（runner 快照的 scrollback）+ 溢出伪历史行（帧写入时被挤出视口的屏幕顶部行）
真实历史行          = snapshot.scrollback.length    ← runner 唯一知道，需随协议下发
可向上滚的行数       = max(0, baseY - historyFloor)
historyFloor        = baseY_after_hydrate > scrollbackLines ? baseY_after_hydrate : 0
```

**为什么是"全有或全无"**：`synthesizeFullRedrawFrame` 先写真实 scrollback 行、再写 viewport 行
（`src/core/terminal-snapshot.mjs:336-351`），所以 hydrate 之后本地 buffer 的布局是

```
[0 .. S)        真实历史（最旧优先）
[S .. S+k)      制造行：被挤出视口的屏幕顶部 k 行
[S+k ..)        视口
baseY_after = S + k
```

制造行**夹在真实历史和视口之间**，任何本地滚动都必然先穿过它们；单一 floor 常量无法跳过中间块。
因此只要发生溢出就把 floor 设为 `baseY`（本地历史整体禁用、滚轮全部转发），不牺牲最旧的真实行。

### 2.3 实证（真实链路，无 mock 组件）

一次性探针：假 runner 用**完整** `screen.log` 构建 `createTerminalModel()`（模拟真实 pty-runner），
`captureTerminalSnapshot()` + `synthesizeFullRedrawFrame()` 原样回包；attach 侧用真实
`TuiAltScreen` + 真实 `PtyAttachComponent`，喂真实 `ESC[<64;10;10M`。

```
protocolReady: true, attachMode: "protocol"
runnerType: normal, runnerBaseY: 0, runnerLength: 65
snapshotScrollback: 0, snapshotViewportRows: 65
attachType: normal, attachBaseY: 27, attachLength: 65
bodyHeight: 38, bottomViewportTop: 27
→ firstForwardAt: 28   （第 28 个滚轮事件才到达子会话）
```

该探针是一次性脚本（未入库），**A4 的 scenario 落地后必须复现同组数值**（见 §5/§6）。
legacy（无 protocol）路径同源：`rows=30` 时测得 `firstForwardAt: 65`。

### 2.4 与 legacy 重放的关系

构造函数里的 60 KB 重放（`ATTACH_REPLAY_BYTES = 60_000`）在 protocol 路径会被
`\x1b[3J` 清空，**不是**本次根因；它只在 pre-protocol runner / `AGENT_BOARD_TERMINAL_SNAPSHOT=0`
降级路径下贡献同类伪历史。本修复**不覆盖**该路径（见 §4 非目标）。

## 3. 修复设计

### 3.1 核心：`historyFloor` 基线

组件维护 `historyFloor`（"早于它的一切都是伪历史"的 baseY 基线），
"能否向上滚"的判定为 `maxScrollUp = max(0, baseY - historyFloor)`。

更新时机（唯一三处）：

| 时机 | 动作 |
| --- | --- |
| `pushOutput(frame, { authoritative: true })` 的 `term.write` 回调 | `historyFloor = historyFloorAfterHydrate(baseY, scrollbackLines)`，`scrollbackLines` 取自本次 `snapshot_ready` 的 payload（见 §3.5），缺省 0 |
| `term.reset()`（`snap.empty` / `resnapshot`） | `historyFloor = 0`；接线位置见 §3.3，验收见 A6b |
| `term.resize()` 之后（`resizeIfNeeded`） | `historyFloor = buffer.active.baseY`（见 §3.4 保证边界） |

**不使用 `snapshot_begin.rows` 推算溢出**：行差会被列换行放大，`baseY` 是实测值，唯一可靠。

### 3.2 纯函数拆分（`src/core/pty-scroll.mjs`）

```js
/**
 * baseY 在 hydrate 之后包含了「本次写入强制滚出的行」。runner 快照里真正属于
 * 历史的只有 scrollbackLines 行，其余一律是伪历史。返回可视为历史的起点。
 */
export function historyFloorAfterHydrate(baseYAfter, scrollbackLines)

/** max(0, baseY - historyFloor)：真正可以往回滚的历史行数。 */
export function scrollableHistoryLines(baseY, historyFloor)

/** 现有函数增加 floor 参数（视口起点下限），默认 0 时与原实现逐例等价。 */
export function scrollViewportTop(viewportTop, bottom, linesUp, floor = 0)
```

`scrollViewportTop` 语义扩展：

```
safeBottom = max(0, floor(bottom))
safeFloor  = clampInt(floor, 0, safeBottom)
current    = viewportTop == null ? safeBottom : clampInt(viewportTop, safeFloor, safeBottom)
next       = clampInt(current - linesUp, safeFloor, safeBottom)
→ { viewportTop: next >= safeBottom ? null : next, changed: next !== current }
```

`historyFloorAfterHydrate(baseYAfter, scrollbackLines)`：

```
// 非有限数（undefined / NaN / Infinity）一律归 0——老 runner 不发送该字段
safeBase       = Number.isFinite(baseYAfter)     ? Math.max(0, Math.floor(baseYAfter))     : 0
safeScrollback = Number.isFinite(scrollbackLines) ? Math.max(0, Math.floor(scrollbackLines)) : 0
// 溢出（baseY > scrollback）=> 制造行夹在真实历史与视口之间 => 整体禁用本地历史
// 未溢出          => 视口之上的每一行都是真实历史 => floor 0，全部可滚
return safeBase > safeScrollback ? safeBase : 0
```

语义：`baseYAfter` 至少为 0；`scrollbackLines` 只用来判断"是否溢出"，不用来计算"保留多少行历史"。
**不得**用 `max(0, floor(x))` 处理未校验的输入（`Math.floor(undefined) === NaN`，会污染整条判定链）。

### 3.3 组件接线（`src/ui/pty-attach.ts`）

- `pushOutput(data, opts)` 增加可选 `opts.scrollbackLines?: number`；
  `term.write` 回调里 `if (opts.authoritative) this.historyFloor = historyFloorAfterHydrate(this.term.buffer.active.baseY, opts.scrollbackLines)`（回调内没有 `buf` 绑定，必须重新取 `this.term.buffer.active`）
- `handleAttachEvent("snapshotReady")` 的 `else if (snap.empty || snap.resnapshot)` 分支（`src/ui/pty-attach.ts:1597-1601`）：`this.term.reset()` 之后**必须** `this.historyFloor = 0`，否则 host 重启/重订阅后的 `baseY` 已归零而 floor 仍是旧值，前 floor 行无法本地滚动
- `handleAttachEvent("snapshotReady")`：`this.pushOutput(snap.frame, { authoritative: true, scrollbackLines: snap.scrollbackLines })`
  （不再在组件里计算 overflow，也不引入 `pendingFrameOverflow` / `snapshotRows`）
- 新增 `private scrollFloorStart(height)`：
  `bottom = bottomViewportTop(height)`；`floorStart = max(0, bottom - scrollableHistoryLines(baseY, historyFloor))`
- `tryScrollBy` / `tryScrollToTop` / `clampViewportTop` 改用 `scrollFloorStart()` 作为下限
- `resizeIfNeeded` 的 `term.resize()` 后：`this.historyFloor = buffer.active.baseY`

### 3.4 保证边界

- **hydration 溢出即禁用本地历史**：只要 `baseY > scrollbackLines`，`historyFloor = baseY`，本地一行都滚不动、滚轮全部转发给子会话。制造行夹在真实历史与视口之间（见 §2.2），这是唯一不牺牲最旧真实行的选择。
- **resize 之后本地滚动历史清零**：`historyFloor` 被设为当前 `baseY`，"宁可暂时不能本地滚，也不把伪历史当历史滚"。resize 之后的真实历史只保留在子会话侧（可转发滚动）。
- **老 runner 没有 `scrollbackLines`**：按 0 处理 → 本地历史被禁，滚轮全部转发给子会话（对 fullscreen 子会话是正确的；对 regular 子会话是本地滚动能力的退化，记录在 §4）。
- frame 解析是异步的：解析完成前的滚轮事件按旧 floor 处理（最坏情况 = 现状），解析完成后收敛。

### 3.5 协议扩展（向后兼容）

`src/core/terminal-attach-protocol.mjs`：`snapshot_end` 增加
`scrollbackLines: dto.scrollback.length`（runner 侧 `captureTerminalSnapshot()` 已经产出该数组）。

`src/core/terminal-attach-client.mjs`：把 `snapshot_end.scrollbackLines` 并入 `snapshotReady` payload，
**仅当它是 number 时写入该键，否则省略该键**（不写 `scrollbackLines: undefined`）——
`test/terminal-attach-client.test.mjs:94-95` 的 `deepEqual` 钉死了 `snapshotReady` 的精确形状，
无条件写键会让既有 happy-path 用例变红；同时更新该文件 `:85` 处 payload 形状的头部注释。

老 runner 不发该字段 → 客户端省略键 → `snap.scrollbackLines === undefined` → §3.3 按 0 处理。**无版本闸门**（字段可选，无需 frameVersion 变更）。

## 4. 非目标

- **不改变 legacy（pre-protocol runner）路径的本地滚动**：那条路径的 60 KB 重放是唯一历史来源，
  `historyFloor` 保持 0，行为与现状逐例等价。该路径的伪历史问题不在本 issue 范围。
- 不修改 `AGENT_BOARD_WHEEL_LINES` 在 fullscreen 下的语义（上游 `fullscreenWheelScrollLines` 已负责步长）
- 不修正 #198 的 buffer-type 探测（本修复不再依赖它）
- 不新增 `frameVersion` 变更（`scrollbackLines` 是可选字段，缺失即降级）

## 5. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | `historyFloorAfterHydrate` 纯函数 | 自动化（unit） | `test/pty-scroll.test.mjs` 新增用例 | `(27,0)=27`（溢出）、`(127,100)=127`（溢出→禁用）、`(5,10)=0`（未溢出）、`(undefined,0)=0`、`(27,undefined)=27` |
| A2 | `scrollableHistoryLines` 纯函数 | 自动化（unit） | 同上 | `(27,27)=0`、`(127,27)=100`、`(0,0)=0` |
| A3 | `scrollViewportTop` floor 语义 | 自动化（unit） | 同上（含对拍） | floor=bottom 时 `changed=false`；floor=0 时对现有全部输入逐例与旧实现一致 |
| A4 | protocol 快照溢出后首次滚轮即转发 | 自动化（integration） | 新增 `test-support/pty-attach-frame-overflow-scenario.ts` + `test/pty-attach-frame-overflow.test.mjs`：假 runner 用真实 `captureTerminalSnapshot`/`synthesizeFullRedrawFrame`（**runner 模型 rows=65，attach rows=38，scrollback=0**），attach 侧真实 `PtyAttachComponent`，直接调 `component.handleMouse` 驱动 | `attachBaseY===27`、`historyFloor===27`、`scrollableHistoryLines===0`；首个 wheel 返回 `{handled:true,render:false}` 并发出 `{type:"input","data":"\x1b[<64;…M"}`；`viewportTop` 保持 `null` |
| A5 | 溢出时禁用本地历史而不是牺牲最旧真实行 | 自动化（integration） | 同 scenario 变体：runner 先写 100 行普通文本再快照（`scrollbackLines=100`，帧 165 行写入 38 行终端 → 溢出） | `historyFloor === baseY`、`scrollableHistoryLines === 0`，首个 wheel 即转发（未溢出且带历史的情形由 A1 的 `(5,10)=0` 覆盖） |
| A6 | resize 后基线重置（含保证边界） | 自动化（integration） | 同 scenario：hydrate 后 `component.render(<更窄宽度>)` 触发 `term.resize` | `historyFloor === baseY`、`scrollableHistoryLines===0`，下一次 wheel 立即转发 |
| A6b | `term.reset()` 后基线归零 | 自动化（integration） | 同 scenario 的 `snap.empty`（或 `resnapshot`）变体：hydration 后投递一次 empty 基线 | `historyFloor === 0` 且 `baseY === 0`；随后以超过 `bodyHeight` 行的 live 输出填满视口，wheel 可本地滚动（floor 不再残留旧值） |
| A7 | `scrollbackLines` 缺失降级 | 自动化（unit + integration） | unit：`historyFloorAfterHydrate(27, undefined)=27`；integration：scenario 不发 `scrollbackLines` 的变体 | 与 A4 同结果（本地不滚、直接转发），不抛错 |
| A8 | 真实 fullscreen 调度 smoke | 自动化（integration，附加保护） | 同 scenario 额外用例：真实 `TuiAltScreen` + `showOverlay` + `(tui as any).handleTerminalInput("\x1b[<64;10;10M")`（`handleTerminalInput` 在运行时可达，private 只是 TS 类型层；一次性探针已验证可调用） | `handleMouse` 被调用且首个 notch 即转发 |
| A9 | legacy 路径不回归 | 自动化（integration） | 现有 `pty-attach-wheel`、`pty-attach-alt-wheel`、`pty-attach-wheel-fallback` 套件 | 全部通过 |
| A10 | 协议字段兼容 | 自动化（integration） | `test/terminal-attach-protocol*.test.mjs` / client 套件新增断言；同步更新 `test/terminal-attach-client.test.mjs:94-95` 的 `deepEqual` 与 `:85` 形状注释 | `snapshot_end` 带 `scrollbackLines`；client 透传到 `snapshotReady`；`scrollbackLines` 为非 number 时**省略该键**且不报错 |
| A11 | 类型与构建 | 自动化（static/build） | `npm run typecheck`、`npm run verify` | 通过（含 perf gate + coverage 阈值） |
| U1 | 真实终端滚轮 | 用户实测 | 见 §5.1 | 面板立即显示子会话 transcript 的上一行（而非输入框碎片）；PageUp 行为保持一致 |

### 5.1 U1 执行时机与部署前置

1. A1–A11 全绿、PR 合并到 `main`
2. `cd C:/Users/27499/proj/opensource/pi-agent-board && git pull`
3. **刷新 pi 的 git 包缓存**（pi 加载的是 `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board`，
   不是本工作区）：`pi update`（或重启 pi 让其重新拉取），并确认
   `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board log --oneline -1` 含本 PR 提交
4. 完整重启 pi（旧进程内的模块缓存不会热更新）
5. pi fullscreen → `/agent-board` → attach 一个输出超过 60 KB 的长会话 → 拨一次滚轮
6. 通过标准：第一次滚轮即显示子会话 transcript 的上一行；不出现输入框/旧屏幕碎片；PageUp 仍正常

## 6. 可测性拆分设计

- **决策逻辑全部下沉到 `src/core/pty-scroll.mjs` 纯函数**：`historyFloorAfterHydrate`、
  `scrollableHistoryLines`、`scrollViewportTop(…, floor)`。无 I/O、无环境变量读取，可直接单测。
- **组件只承担接线与状态**：`historyFloor` 一个字段 + 三个赋值点（hydrate 回调 / reset / resize），
  不新增任何"计算"逻辑，避免把已拆分的纯函数重新耦合回组件。
- **帧投递接缝（A4–A7 的构造前提）**：scenario 必须让 65 行帧**原样**送达组件，不得触发 runner 侧重新 capture。具体两种合法写法（选一并在场景注释里写明）：
  1. 走完整协议链路，但**假 runner 忽略 `snapshot_begin` 之后到达的 `resize` 控制消息**，按固定 65 行 `captureTerminalSnapshot()` 原样回包；
  2. 跳过协议层，直接 `component.pushOutput(frame, { authoritative: true, scrollbackLines })` 投递由真实 `synthesizeFullRedrawFrame()` 生成的帧。
  若假 runner 响应 resize 并重新 capture（38 行），`attachBaseY === 27` 的前提塌陷，A4 永远不成立。
- **连接与发送可观测（A4–A7 的第二个前提）**：`forwardWheelToChild` 只在 `this.socket && this.connected` 为真时才真正 `send`
  （`src/ui/pty-attach.ts:474-476`）。scenario 必须建立连接并拦截发送，复用仓库既有模式：
  真实 host socket / 假 runner 监听 pipe，并拦截 `Socket.prototype.write` 收集 `{type:"input"}`
  （见 `test-support/pty-attach-wheel-fallback-scenario.ts:113-119`）。用 disconnected 的假 TUI（例如
  `nonexistent.sock`）会让 forward 静默 no-op 并返回 `undefined`，A4 永远失败。
- **await 解析完成再断言**：`historyFloor` 在 `term.write` 的回调里才写入（§3.3），而 `@xterm/headless` 是异步解析。
  A4/A6b 断言前必须 `await` 写入回调，沿用既有模式
  （`test-support/pty-attach-wheel-scenario.ts:75` 的 `await new Promise((resolve) => component.term.write(..., resolve))`）或轮询到回调完成。
- **测试边界**：
  - `test/pty-scroll.test.mjs` —— 纯函数（A1–A3、A7 的 unit 部分）
  - `test-support/pty-attach-frame-overflow-scenario.ts` —— 真实帧合成 + 真实组件 + 直接 `handleMouse`（A4–A7、A6b）
  - 同一 scenario 的真实 `TuiAltScreen` 用例 —— 附加保护（A8），断言"事件确实到达 `handleMouse`"
  - 协议/client 套件 —— 字段透传（A10）
  - 现有 wheel / alt-wheel / wheel-fallback 套件 —— legacy 无回归（A9）
- A8 用到的 `handleTerminalInput` 是运行时可达的公开实例方法（`private` 只在 TS 类型层不可见），
  通过 `(tui as unknown as { handleTerminalInput(d: string): void }).handleTerminalInput(...)` 构造；
  场景落地时若该签名变化，A8 允许退化为直接调 `dispatchMouseToOverlay`，但**不得**删掉该用例而不记录。

## 7. 风险

| 风险 | 缓解 |
| --- | --- |
| `scrollbackLines` 语义与 frame 内容不一致（runner 快照后又有新 chunk 被 flush） | `snapshot_end` 的 `scrollbackLines` 取自同一次 `captureTerminalSnapshot()` 的 dto，与 frame 同源；catch-up flush 的 chunk 是增量（live output），不影响已 hydrate 的行数 |
| `historyFloor` 让真实历史被判成伪历史 | 只在 hydrate/reset/resize 三处设置；`scrollbackLines` 由 runner 权威给出；resize 场景见 §3.4 明示边界 |
| 老 runner 造成本地滚动退化 | 明确写入 §3.4 / §4：对 fullscreen 子会话是正确行为，对 regular 子会话是能力退化；`pi update` 后消失 |
| 现有测试直接调 `handleMouse`，改动可能未被覆盖 | A4 用真实帧合成覆盖 hydrate 路径；A8 补真实调度链路 |
