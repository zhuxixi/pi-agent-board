# Spec: attach 会话内就地删除（issue #147）

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-09T23:09:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-10T22:04:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-10T22:12:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-10T22:25:00+08:00

> 状态：v4 —— 第 3 轮复核收敛（真缺口 0、细化 2 已处置）+ **用户裁决两项开放问题已写入**；待用户确认设计
> **行号基准：`884040f`（0.10.2）**——`pty-attach.ts` 随 main 前进（0.10.1 → 0.10.2，issue #167/#169 新增 `handleMouse`），
> 全文行号已按新基准刷新；`agent-board.ts`、`dashboard.ts`、`service.mjs`、`core/*` 在该区间无 diff。
> 依据：issue #147 正文 + 三轮调研（`research/round1-key-choice-and-occupancy.md`、
> `round2-delete-path-and-return-channel.md`、`round3-ui-surface-and-verification.md`）
> + 2026-10-09 用户拍板（键位 + 四个设计点：顶栏整行顶替 / 非确认键取消并透传 / 断连无条件可用 / 选中落相邻行）
> + `research/spec-review-round-1.md`、`research/spec-review-round-2.md`（各轮发现的处置见对应修订摘要）

## 1. 目标与非目标

### 1.1 目标

1. attach 视图内一个手势完成「退出 attach → 归档该行（停 host、停 run）→ 回 board」。
2. 删除语义与 board 完全一致：同一 `service.archive()`，软删除（session 文件保留）、busy 行走协调器 fence。
3. 回到 board 后：被删行消失、有删除提示、选中落在相邻行。

### 1.2 非目标

- 不改 board 侧键位与语义（`x` → `y` 与 `Ctrl+X` ×2 均不动）。
- 不做 `ctx.switchSession`（PTY 不可用）路径的删除——那条路径下「要删的正是用户当前所在的会话」，语义不同，单独讨论。
- 不给 attach 增加 `Ctrl+X` ×2 别名（避免第三种删除路径；attach 从无删除键，无旧肌肉记忆要照顾）。
- 不改 `service.archive` / `archiveView` / 状态协调器。
- 不同步孤儿 `src/commands/attach-flow.ts`（属 `REMAINING_WORK.md:102` T14；其现有映射 `result.action === "closed" ? "closed" : "detached"` 对新态天然落到 `detached`，不产生错误行为）。
- 不做键位可配置化。

## 2. 现状审计（实现时按此定位）

| 事实 | 位置 |
| --- | --- |
| attach 按键拦截链（mouse → pageUp/Down/Home/End → `Ctrl+\` → `Ctrl+←` → `←` 门控 → 兜底透传） | `src/ui/pty-attach.ts:289` |
| 鼠标事件的**第二通道**（fullscreen 模式走规范化 `TuiMouseEvent`，**不进** `handleInput`） | `src/ui/pty-attach.ts:376-385`（issue #167/#169，0.10.2 新增） |
| 顶部状态行渲染（标题 + `status · 键位提示`） | `src/ui/pty-attach.ts:399-401` |
| 结果类型（现为 `detached` \| `closed`）与 `done` 回调 | `src/ui/pty-attach.ts:17`、`:265` |
| 线上消费点（唯一） | `src/commands/agent-board.ts:187-192`（`resolveAttachTarget` → `openPtyAttach`） |
| attach 循环（重开 board、带 `selectedId`） | `src/commands/agent-board.ts:139-161` |
| `service.archive` → `archiveView` | `src/runtime/service.mjs:2088` → `:753-779` |
| board 确认引擎（`y`/`Y`/Enter 确认，其它键取消） | `src/ui/dashboard.ts:509` |
| board 删除文案 `Deleted "name"` | `src/ui/dashboard.ts:1044`、`:1067` |
| board 选中兜底（悬空 → `orderedIds[0]`） | `src/ui/dashboard.ts:196-199` |
| 排序来源 `groupRowsByFolder` | `src/core/rows.mjs:233`（dashboard 从 `:31` 导入） |
| `openDashboard` deps 现有能力（只有 `initialSelectedId`） | `src/ui/dashboard.ts:116-124`；`agent-board.ts:104` |
| 孤儿 `attach-flow.ts`（无 import、`setOpenDashboardFn` 从未调用） | `src/commands/attach-flow.ts:201` |

## 3. 设计

### 3.1 决策表

| 决策点 | 选择 | 理由 | 被拒备选 |
| --- | --- | --- | --- |
| 触发键 | `Ctrl+X`（0x18），**单击进入确认态** | 单字节 raw、终端无关（#126 标准）；与 board `x`→`y` 心智一致 | `Ctrl+X` ×2（#150 已否决双击形态）；`Ctrl+^`/`Ctrl+_`/`Ctrl+Space`（难按 / IME 抢）；字母键（必须透传）；`Ctrl+\`（已是 detach） |
| 形态 | 单击 → `y/N` 确认，第一次按下**不透传** | 单击不删、抢键不致命；子 Pi 不会同步收到 `message.copy` | 透传+第二次才删（产生真实 copy 副作用）；延迟透传（每次 `Ctrl+X` 都延迟） |
| 提示落点 | **顶栏整行顶替**，不改变渲染行数 | 顶栏已存在 1 行，替换文本不触发 PTY resize（jiggle/resize 竞态面）；body 与 loading 不受影响 | 底部覆盖条（会盖住子 Pi 编辑器行）；只在 status 位追加（争宽、可见性弱） |
| 非确认键 | 取消确认态，**然后按既有链路继续处理该键** | 不吞用户输入；确认态只影响一次按键 | 吞掉（用户丢字）；模态保持（模糊态重） |
| 断连 / host exited | arm 与 confirm **无条件可用** | archive 不依赖子进程存活；与 `←` 的 always-exitable 同性质；断连正是最想清掉该行的场景 | 仅连接正常时可用 |
| 删除语义 | 复用 `service.archive(viewId)`，零改动 | 与 board 单一实现；busy 行走协调器 fence；避免两条停机路径 | 另写停机逻辑 |
| 回 board 选中 | **相邻可见行**（无下一个则上一个；都没有则 `null` → 落 `orderedIds[0]`） | 单行删除语义明确，行多时不跳走 | 沿用 `orderedIds[0]` 兜底 |
| 删除提示 | `openDashboard` 新增 `initialNotice`，带到重开的 board | 重开的 board 是新建组件、内联 notice 带不过去 | 不显示提示 |
| archive 失败 | `ctx.ui.notify(res.error ?? "Delete failed", "error")`，仍回 board | 与 board 的 `notice(..., "error")` 同义；不静默 | 吞掉错误 |
| `session-switch` 路径 | 本期不做 | 「要删的正是当前所在会话」，语义不同 | 一起做（语义风险） |
| 孤儿 `attach-flow.ts` | 不同步 | 无 import、`setOpenDashboardFn` 从未被调用（T14 单列）；新态在其映射下天然落到 `detached` | 顺手同步（扩大改动面） |

### 3.2 交互（状态机）

状态：`confirmArmed: boolean`（组件字段，初始 `false`，attach 期间不持久化；无定时器、无窗口过期语义）。

| 当前状态 | 按键 | 动作 |
| --- | --- | --- |
| 未 armed | `Ctrl+X` | **arm**：置位 + 重绘顶栏（提示）；**不**发 socket；**不** archive |
| armed | `y` / `Y` / Enter | **confirm**：先 `close(true)` 做本地拆解（清定时器与监听、`restoreAndStop()` 恢复被 hold 的 PTY 尺寸、`socket.end()` 保序关闭），再 `done({ action: "delete" })`；**不**发送 `detach`/`terminate` 控制帧；**不** archive（由消费点 archive） |
| armed | `Ctrl+X` 二次按下 | **cancel-swallow**：清位，**吞掉该字节**（不透传——避免向子 Pi 注入一次 `message.copy`；用户裁决 2026-10-10） |
| armed | 其它任何按键（含 `n`、`Esc`、字母、方向键、pageUp/Down） | **cancel**：清位，然后**按既有链路继续处理该键**（输入不丢；`Ctrl+\` 仍 detach、`←` 仍按门控、普通字符仍进子 Pi） |
| armed | 鼠标事件（**两通道**：常规模式的 `handleInput` 鼠标 chunk / fullscreen 模式的 `handleMouse` 事件） | 按既有鼠标逻辑处理，并清位。**两个入口都要清**（`handleInput` 鼠标分支命中即 return、`handleMouse` 不经过 `handleInput`，纯函数两者都看不到） |
| 未 armed | 其它按键 | 既有链路，无变化 |

顶栏文案（armed 时整行替换，经既有 `clip(header, width)` 裁剪）：

```
 Delete "NAME"? y confirms · any other key cancels
```

`NAME` 经 `truncateToWidth` 截断到 ≤24 列（该函数已在该文件 import），保证 `y confirms` 子串在任何终端宽度下完整可见。

### 3.3 数据流

```
[attach 视图] PtyAttachComponent.handleInput
  mouse chunk (handleInput) → 既有鼠标处理 + 清 confirmArmed（该分支命中即 return）
  handleMouse(event)        → 入口先清 confirmArmed，再走既有鼠标逻辑（fullscreen 通道；纯函数看不到）
  resolveAttachDeleteKey({confirmArmed}, data)        ← 纯函数（新）
    arm     → confirmArmed = true; scheduleRender(); return（不 send）
    confirm → close(true) → done({ action: "delete" })（本地拆解；不发控制帧，不 archive）
    cancel  → confirmArmed = false; 继续既有链路
    cancel-swallow → confirmArmed = false; return（吞掉该字节，不 send）
    forward → 继续既有链路
  既有链路（pageUp/Down/Home/End → Ctrl+\ → Ctrl+← → ← 门控 → 兜底 send）

[命令层] attach()（agent-board.ts，open-pty 分支）
  result.action === "delete"
    neighbor = nextVisibleIdAfterRemoval(service.rows(), viewId, Date.now())   ← 纯函数（新）
    name     = service.row(viewId)?.meta.name ?? ""
    await service.archive(viewId)          → 失败则 ctx.ui.notify(error, "error")
    return { action: "detached", afterDelete: { nextSelectedId: neighbor, notice: `Deleted "${name}"` } }

[命令层] dashboardAttachLoop
  下一轮 openDashboard({ initialSelectedId: afterDelete.nextSelectedId ?? selectedId,
                         initialNotice: afterDelete.notice })

[dashboard] DashboardComponent 构造：deps.initialNotice 存在 → this.notice(text, "info")
```

顺序约束：**必须先退出 attach 组件（`close(true)` + `done()`）、再由命令层 archive**。反了会把 host 被杀过程渲染给用户（`status` → `host exited` / `disconnected`，`pty-attach.ts:508`、`:1312`）。

### 3.4 组件契约（逐文件）

1. **`src/core/attach-delete.mjs`（新）**
   - `export function resolveAttachDeleteKey(state: { confirmArmed: boolean }, data: string): { action: "arm" | "confirm" | "cancel" | "cancel-swallow" | "forward"; confirmArmed: boolean }`
   - 判定：`matchesKey(data, Key.ctrl("x"))`（覆盖 0x18 / kitty CSI-u / modifyOtherKeys）；确认键 = `data === "y" || data === "Y" || matchesKey(data, Key.enter)`；**armed 时 `Ctrl+X` 二次按下 → `cancel-swallow`**；其余按键在 armed 时为 `cancel`、未 armed 时为 `forward`。不读 socket / 连接 / 编辑器状态。

2. **`src/core/rows.mjs`**
   - `export function nextVisibleIdAfterRemoval(rows, id, now): string | null` —— 用与 board 相同的排序（`groupRowsByFolder(rows, now)` → flatMap id）取被删 id 的下一个可见 id；末位取前一个；不存在该 id 或列表里没有其它行 → `null`。

3. **`src/ui/pty-attach.ts`**
   - `PtyAttachResult` 增加第三态：`| { action: "delete" }`（`:17`）。
   - 新字段 `private confirmArmed = false`。
   - `handleInput`（`:289`）：鼠标分支之后、`PageUp` 分支之前调用纯函数；`arm` / `confirm` / `cancel` / `forward` 按 3.2 执行。
   - `handleInput` 的鼠标分支（`:290-291`）内清 `confirmArmed`——该分支命中即 `return`，纯函数永远看不到鼠标 chunk。
   - **`handleMouse`（`:376-385`）入口同样清 `confirmArmed`**——fullscreen 模式鼠标只走这里（#167/#169）；清位发生在 `resolveAttachMouseAction` 之前，覆盖返回 `paste-primary` 与返回 `undefined` 的全部路径。
   - **confirm 的拆解**（照 `detach()`（`:435-447`）的形状，去掉控制帧）：`this.close(true)` → `this.done({ action: "delete" })`。`close()`（`:1522`）自带全部本地清理并调用 `jiggleRetry.restoreAndStop()`（`:1533`；控制器 `pty-attach-jiggle-controller.mjs:325-329`），`true` 走 `socket.end()` 保序（`:1562`）、失败由 unref 计时器兜底（`:1563-1567`）；**不发送** `detach` 帧（host 将由 archive 终止）。`close()` 会置 `closed`（`:1529`），而 `scheduleReconnect` 首行即 `if (this.closed || this.retryTimer) return`（`:546-547`）→ 拆解后不会再重连。
   - `render`（`:399-401`）：armed 时顶栏整行替换为确认提示（`NAME` 截断 ≤24 列，保证 `y confirms` 可见）；**行数与未 armed 时一致**。

4. **`src/commands/agent-board.ts`**
   - `AttachOutcome` 增加旁带信息：`{ action: "detached" | "closed" | "switched" | "none"; afterDelete?: { nextSelectedId: string | null; notice: string } }`（`:137`）。
   - `attach()` open-pty 分支：按 3.3 处理 `delete`（`:187-192`；`attach()` 本体起于 `:163`）。
   - `dashboardAttachLoop`（`:139-161`）：把 `afterDelete` 带到下一轮 `openDashboard`。
   - `openDashboard` options（`:77`）与 `DashboardComponent` deps 透传 `initialNotice`。

5. **`src/ui/dashboard.ts`**
   - deps 类型（`:116-124`）加 `initialNotice?: string`；构造函数中 `this.selectedId` 初始化后（`:175`）若存在则 `this.notice(deps.initialNotice, "info")`。
   - 不改 `refresh()` 的兜底语义。

6. **`README.md`**
   - attach 两处叙述（`:96`、`:201`）补 `Ctrl+X` → `y` 说明与 caveat：attach 期间子 Pi 的 `Ctrl+X`（`app.message.copy` / `app.models.clearAll`）被接管；与 board 的 `Ctrl+X` ×2 不是同一件事。

### 3.5 降级与边界

- **行数不变**：确认提示不改变渲染行数，避免 PTY resize（jiggle 控制器竞态面）。
- **无窗口语义**：不引入定时器，不存在「窗口过期作废」的模糊态（这是相对 #147 原案 `Ctrl+X` ×2 的关键改动）。
- **二次 `Ctrl+X`**：**取消 + 吞掉**（用户 2026-10-10 裁决）——`Ctrl+X` 在本视图内是确认开关，再按一次只是关掉提示：不透传、不会向子 Pi 注入 `message.copy`。这是「非确认键一律透传」的唯一例外；README caveat 据此写成「`Ctrl+X` 在 attach 期间被接管」。
- **邻居退化**：`nextSelectedId` 为 `null` 或该行在删除前已消失 → board 的 `refresh()` 兜底到 `orderedIds[0]`（既有行为）。
- **archive 失败**：不静默，`ctx.ui.notify(..., "error")`；仍回 board。
- **confirm 与 detach 的差别**：只做本地拆解（`close(true)`），不发送 `detach` 控制帧（host 由 archive 终止）。`detach()` 里那句显式 `restoreAndStop()` 是为了在**发送 detach 帧之前**把 restore 包排进缓冲（`:435-447`），本路径无控制帧，故不需要额外调用——`close()` 内部已经做（`:1533`）。

## 4. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | `resolveAttachDeleteKey` 全分支 | 自动化（unit） | `node --test test/attach-delete-key.test.mjs` | 未 armed + `\x18` → `arm`；armed + `y`/`Y`/`\r` → `confirm`；armed + `n`/`\x1b`/`a`/方向键 → `cancel`（透传）；**armed + `\x18` → `cancel-swallow`（吞掉）**；未 armed + 其它 → `forward`；返回的 `confirmArmed` 与动作自洽 |
| A2 | `nextVisibleIdAfterRemoval` | 自动化（unit） | `node --test test/rows.test.mjs`（或该模块既有测试文件） | 中间行 → 下一可见行；末行 → 上一行；单行 / 空列表 / 未知 id → `null`；跨分组取全局下一个可见行 |
| A3 | 组件级 arm/confirm/cancel、拆解与不透传 | 自动化（integration，组件探针） | `node --test test/pty-attach-delete-gate.test.mjs`（沿用 `test-support/detach-gate-smoke.ts` 新增场景：真 `PtyAttachComponent` + 假 socket server） | arm 后顶栏含 `y` 子串与 session 名（含长名字场景：`y confirms` 不被裁）；arm 期间 socket 未收到该 `\x18`；`y` → `done` 结果为 `{action:"delete"}`；socket **未收到 detach/terminate 帧**，但假 server 观察到客户端 socket 关闭且**此后无新连接**（无重连）；legacy 模式下 confirm 发出 restore resize 且先于 socket end（对照既有 `leftDetachRestoresBeforeGracefulEnd` 场景）；`n` 后 socket 收到该字节；**armed + 第二次 `\x18` → socket 未收到该字节且 `done` 未被调用（cancel-swallow）**；armed + `handleInput` 滚轮 chunk + `y` → 不 delete 且 `y` 被透传；**armed + `handleMouse` 事件（直接调 `handleMouse({type:"press",button:"middle",…})`，形状照 `test-support/pty-attach-mouse-scenario.ts:142-152`）+ `y` → 同样不 delete 且 `y` 被透传**（fullscreen 通道清位）；`host exited` / 断连状态下 arm 与 confirm 仍成立 |
| A4 | 编码形态兼容 | 自动化（integration，同上探针） | 同 A3 文件 | 0x18、kitty CSI-u（`\x1b[120;5u`）、modifyOtherKeys（`\x1b[27;5;120~`）三种形态均能 arm |
| A5 | 命令层闭环：archive + board 重开参数 | 自动化（integration，新 harness） | `node --test test/attach-delete-flow.test.mjs`：stub ctx（替身面见 §5）+ 真 temp-root service + **打桩 `service.resolveAttachTarget` 返回 `{kind:"pty", socketPath:"<temp>/fake.sock"}`**，驱动 `dashboardAttachLoop`；`ui.custom` 为**两段式**：第 1 段（board）调用 factory 构造 `DashboardComponent` 并以 wrappedDone 推入 `{action:"attach", viewId, stopFirst:false}`，第 2 段（PTY）不调 factory、直接 resolve `{action:"delete"}` | 被删 view `meta.archived === true`；其 session 文件仍存在；`service.rows()` 不含该 id；第 2 轮 board 的 `DashboardComponent` deps 收到 `initialSelectedId === 相邻 id` 与 `initialNotice === 'Deleted "name"'` |
| A6 | archive 失败不静默 | 自动化（integration，同上 harness） | 同 A5，`service.archive` 打桩返回 `{ok:false, error:"boom"}` | `ctx.ui.notify` 收到 error 级提示；仍回到 board；无未捕获 rejection |
| A7 | 文案与类型 | 自动化（static） | `npm run typecheck` + `rg -n "Ctrl\+X" README.md` 的 static 断言 | attach 两处段落含 `Ctrl+X` → `y`；board 的 `x` / `Ctrl+X` ×2 文案未被误改；typecheck 0 error |
| A8 | 全量回归 | 自动化（build/test） | `npm run verify`（typecheck + perf gate + 全量测试 + coverage 阈值 + pack:dry） | 全绿，无新增失败 |
| U1 | 真机交互（删除路径） | 用户实测 | 起 board → attach 一个空闲会话 → `Ctrl+X`（看提示）→ `y` | 行从 board 消失、`Deleted "name"` 可见、选中落相邻行、session 文件仍在、host 已停（无残留 pid） |
| U2 | 真机（不删除路径） | 用户实测 | attach → `Ctrl+X` → `n`；再 attach → `Ctrl+X` → 继续打字 | 会话未被删；继续打字字符不丢（取消透传生效） |
| U3 | 真机（Working 会话） | 用户实测 | attach 一个 Working 会话 → `Ctrl+X` → `y` | 先停 run 再归档、无「删除后 runner 仍写状态」竞态；回 board 无 `host exited` / 重连横幅闪现 |
| U4 | 真机（断连场景） | 用户实测 | attach 后杀掉 host 进程（或等其 exited）→ `Ctrl+X` → `y` | 仍能删除并回 board |

**U 类统一前置（可执行时机）**：先确认运行面是待测 checkout——`pi install "$(pwd)"` 指向该 checkout，或 `~/.pi/agent/agent-board` 经 dev auto-discovery 指向它（README:42-63）；改动落地后重启 pi 会话再执行，否则会拿旧安装副本验收、误报「功能不生效」。

## 5. 可测性拆分设计（必答）

**新增纯函数（副作用全部外推）**

1. `src/core/attach-delete.mjs` → `resolveAttachDeleteKey(state, data)`
   - 依赖：pi-tui `matchesKey`（纯），不读 `this` / socket / 连接 / 编辑器状态。
   - 测试边界：A1 覆盖全分支；三种真实编码形态由 A4 在组件层钉住（纯函数层只保证不自行解析转义序列）。
2. `src/core/rows.mjs` → `nextVisibleIdAfterRemoval(rows, id, now)`
   - 依赖：同文件 `groupRowsByFolder`（既有纯函数）——**与 board 的 `orderedIds` 同一排序来源，避免两套排序漂移**。
   - 测试边界：A2。

**副作用隔离**

- 组件层 `PtyAttachComponent`：只做「调用纯函数 → 置位 / 渲染顶栏 / `done()`」；无 `service` 引用，不 archive。
- 命令层 `attach()`：只做「取 name → 调纯函数算邻居 → `await service.archive` → 返回旁带信息」；notice 文案在此拼装（与 board 同一字面量）。
- dashboard：只消费 `initialNotice`，不动 `refresh()` 兜底语义。

**测试边界（不得越界）**

- 不测 `service.archive` 内部（`test/service.test.mjs` 已覆盖）。
- 不测 pi-tui `matchesKey` 实现（上游职责）。
- A5/A6 的 stub ctx 面**按真实调用枚举**（依据 `src/commands/agent-board.ts`）：`ctx.ui.custom/notify/setHeader/setFooter/setWorkingVisible/setTitle`、`ctx.modelRegistry.getAvailable`、`ctx.model`、`ctx.cwd`、`ctx.sessionManager.getSessionFile`（返回 `null` 即可——测试不在 attach 会话内）。`attach()` 的 session-switch 分支不在 A5 路径上，`ctx.switchSession` 无需替身。
- **A5 进入被测分支的合法路径**：`attach()` 在开 PTY 前先跑 `planAttachResolved(await service.resolveAttachTarget(viewId))`（`:187`）；真 temp-root service 在无 host 时会真实 `ensureHostImpl` spawn host 并轮询探活（`service.mjs:1236+`），PTY 不可用时回落 `kind:"session"` → session-switch（与「不在 A5 路径上」矛盾）。因此 **A5 允许打桩 `service.resolveAttachTarget` 返回 `{kind:"pty", socketPath:<temp 路径>}`**——stub 的 `ui.custom` 不会真连 socket，被测逻辑（archive / 邻居 / notice 拼装）不依赖 host 存活。除此以外 service 用真 temp-root 实现（A6 例外：额外打桩 `service.archive` 返回值）。

## 6. 风险

| 风险 | 处置 |
| --- | --- |
| 抢键回归（子 Pi 的 `Ctrl+X` = `message.copy` / `models.clearAll`） | 确认式（单击不删）+ README caveat；U2 钉「不删除路径」 |
| 顶栏提示与 status 争宽 / 行数变化引发 resize / 长名字裁掉确认键提示 | 整行顶替、行数不变、`NAME` 截断 ≤24 列；A3 断言顶栏含 `y` 子串 |
| 确认态吞输入 / armed 悬挂导致后续 `y` 误删（含 fullscreen 鼠标通道） | 取消一律透传（U2 验收）；`handleInput` 鼠标分支 **与** `handleMouse` 入口双清位 + A3 两条断言（两条通道各一条） |
| confirm 漏拆解（定时器泄漏 / PTY 尺寸残留 / 退出后仍消费 socket 事件） | §3.4.3 契约定死 `close(true)` → `done()`；A3 断言 socket 关闭后无新连接 + legacy 有 restore 且先于 end |
| 二次 `Ctrl+X` 被吞（用户在子 Pi 侧暂时失去 `message.copy`） | 用户裁决「取消 + 吞掉」；README 明确 `Ctrl+X` 在 attach 期间整体被接管 |
| 命令层无既有 harness（仓库首个 stub ctx 测试） | 独立 plan task；若成本超预期，降级为 static 断言 + U1 并在 plan 记录 |
| 孤儿 `attach-flow.ts` 与实际接口漂移 | 非目标；T14 单列 |
| 半重构双副本漏改导致入口行为不一致 | 线上只有 `agent-board.ts` 一份映射（R2 已证实），风险解除 |

## 7. 开放问题

1. ~~armed 状态下第二次 `Ctrl+X`~~ **已裁决（用户 2026-10-10）：取消 + 吞掉**（不再向子 Pi 透传，避免注入 `message.copy`）——已写入 §3.2 / §3.3 / §3.4.1 / §3.5 与 A1 / A3。
2. ~~顶栏文案是否含 busy 提示~~ **已裁决（用户 2026-10-10）：不含**——保持 `Delete "NAME"? y confirms · any other key cancels`；Working 场景的行为由 U3 真机验收覆盖。

## 参考

- issue #147；#150（board 确认式删除，main `444199d`）；#126 / PR #137（`Ctrl+\` 选键标准与「抢键 + caveat」文案先例）；#103 / #119（attach 按键判定只信权威状态）
- 调研：`research/round1-key-choice-and-occupancy.md`、`round2-delete-path-and-return-channel.md`、`round3-ui-surface-and-verification.md`
