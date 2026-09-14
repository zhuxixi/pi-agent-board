# Issue #102 Spec：attach 投影层按 child 的 DECTCEM 显隐状态决定是否绘制光标块

> Draft：2026-09-14 ｜ state: **approved by user (2026-09-14)** — implemented on branch `issue-102-attach-cursor-dectcem-gate`
> 调研依据：issue 评论（第 1–3 轮）+ `research/` 下的 harness 与实测数据
> 计划分支：`issue-102-attach-cursor-dectcem-gate`（worktree `$WT=<repo>/.pi/worktrees/<branch>`）

## 1. 根因（调研结论）

attach 投影层把「PTY 光标位置」直接当成「应该绘制的光标」：`projectPtyCursor()` 只从 xterm buffer 取 `baseY + cursorY / cursorX`，`lineToAnsi()` 在该格无条件注入 `CURSOR_MARKER` 并加反色属性画实心块，**整条链路不读 child 的 DECTCEM 显隐状态**。

而 pi-tui 的 `positionHardwareCursor()`（`tui-main-screen.js`）在默认配置下必然发 `?25l`（只有 `PI_HARDWARE_CURSOR=1` 且找到 marker 才发 `?25h`），并且 park 到的是"差分重绘结束点 / 上一次 park 点"这类渲染副产品位置。于是 child 明确说"光标不可见"，投影层仍把那个位置复活成可见黑块。

实测证据（2026-09-14，本机托管会话 view_6e2de515c0）：

- 流尾：`…\x1b[?2026l\x1b[4A\x1b[1G\x1b[?25l`（帧结束 → park → hide）。
- `isCursorHidden === true`、PTY 光标落在状态行首字符 `e` 上（非 pi 假光标格）。
- 真组件 `render()` 输出：marker 后紧跟 SGR `0;7;38;2;…`（含反色）→ **黑块确实被画出来**。

## 2. 设计

### 2.1 核心原则：拆开「定位」与「可见性」

| 关注点 | 语义 | 驱动来源 |
|--------|------|----------|
| `CURSOR_MARKER` 注入 | 让外层 TUI 把硬件光标定位到该格（IME 候选窗跟随、`PI_HARDWARE_CURSOR=1`） | 光标位置（保持不变，hidden 时照常注入） |
| 反色属性（可见块） | 在 attach 视图里让光标"看得见" | 位置 **∧** child 的 DECTCEM 可见 |

可见性的唯一权威是 child 自己发的 `?25l/?25h`；投影层不做任何推断。

### 2.2 组件契约

**新增纯函数**（`src/core/pty-attach-render.mjs`）：

```js
/**
 * Duck-typed read of the child terminal's DECTCEM state.
 * Hidden only when xterm explicitly reports true; anything unknown (no `_core`,
 * renamed internals, non-boolean) falls back to visible so the projected block
 * keeps today's behavior.
 */
export function isPtyCursorHidden(term) // -> boolean
```

**`src/ui/pty-attach.ts`**：

- `XtermLike` 增加可选字段：`_core?: { coreService?: { isCursorHidden?: boolean } }`（与既有 `osc8UriForCell()` 读 `term._core?._oscLinkService` 同一 duck-type 风格）。
- `project()`：每帧算一次 `const cursorHidden = isPtyCursorHidden(this.term)`，随 `cursor` 一起交给 `lineToAnsi`。
- `lineToAnsi(..., cursor, cursorHidden = false)`：缺省 `false` = 可见 = 现行行为（无回归）。
  1. `isCursor`（`cursor.row === lineIndex && x === cursor.col`）继续负责注入 marker；
  2. 新增 `paintCursor = isCursor && !cursorHidden`，作为 `attrKey()` / `attrsToAnsi()` 的第三个参数（反色属性来源）；
  3. 三个"光标块"分支同样拆分：
     - `!line` 分支 → hidden 时 `return CURSOR_MARKER;`
     - 空行分支 → hidden 时 `return CURSOR_MARKER;`
     - 行尾超出内容分支 → hidden 时只拼 marker，不拼 `"\x1b[7m \x1b[0m"`。

### 2.3 行为矩阵

| child DECTCEM | 光标格是否在投影窗口内 | marker | 反色块 |
|---------------|----------------------|--------|--------|
| visible（shell/vim/`PI_HARDWARE_CURSOR=1`） | 是 | 注入 | 画（现状） |
| hidden（pi 默认） | 是 | 注入 | **不画**（修复点） |
| visible / hidden | 否（滚出窗口） | 不注入 | 不画（现状） |
| 状态未知（`_core` 缺失/改名） | 是 | 注入 | 画（降级为现状） |

### 2.4 取舍与非目标

- **取舍 A：为什么不用 `detectCursorDesync()` 的 `isInverse()` 判定？** 那会把"位置是否对得上"当成"该不该可见"，并且只在 pi 画了反白假光标时才成立，shell/vim 类子进程会误判。DECTCEM 是通用且权威的信号。
- **取舍 B：为什么不全删这个反色块？** 95e20a6 是为"托管 shell/vim 等自带可见光标的子进程"加的，删掉会让这些场景看不到光标。门禁后 pi 场景不画块是正确的，因为 pi 的可见光标由它自己画的反白假光标承担（#66 已实证）。
- ❌ 非目标：不模拟/篡改 child 的 DECTCEM；不动 #11 的 jiggle heal 与 `detectCursorDesync` 判定；不动 #24/#28 的 marker / sync-block 机制；不替 pi 画光标。
- ❌ 非目标：不修 IME 锚点可能落在错误格的问题（那是 #11 的域；本次只保证 marker 位置逻辑不变）。

## 3. 可测性拆分设计（硬约束）

| 拆分单元 | 形态 | 依赖 | 测法 |
|----------|------|------|------|
| `isPtyCursorHidden(term)` | 纯函数（无副作用，纯读） | 无（入参 duck-typed） | unit：普通对象字面量 + 真 `@xterm/headless` 实例各一遍 |
| `lineToAnsi(...)` 的可见性分支 | 组件私有；由参数 `cursorHidden` 决定输出 | xterm buffer + pi-tui 常量 | component smoke：喂字节 → `render()` → 解析输出 SGR |

设计约束：显隐读取必须独立成函数（不在 `lineToAnsi` 内部读 `term._core`），这样"状态未知时降级为 visible"可以脱离 xterm 实例被穷举测试；`lineToAnsi` 只接受布尔参数，保持"同一输入同一输出"。

## 4. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | `isPtyCursorHidden` 读取 `?25l/?25h` | 自动化验证（unit） | `node --test test/pty-attach-render.test.mjs`（真 Terminal 喂 `?25l`/`?25h`） | `?25l` 后 true、`?25h` 后 false |
| A2 | 状态未知时降级为 visible | 自动化验证（unit） | 同上（`{}`、`{_core:{}}`、`{_core:{coreService:{}}}`、`isCursorHidden` 非布尔、getter 抛错） | 全部返回 false，不抛异常 |
| A3 | hidden 时不画反色块、marker 仍在 | 自动化验证（integration · 组件 smoke） | `node --test test/pty-attach-cursor-visibility.test.mjs`（`test-support/cursor-visibility-smoke.ts`，照 `detach-gate-smoke.ts` 模式） | 输出行含 `CURSOR_MARKER`，且 marker 后首个 SGR 字段不含 `7` |
| A4 | visible 时维持现状（marker + 反色块） | 自动化验证（integration · 组件 smoke） | 同上 | 输出行含 `CURSOR_MARKER` 且 SGR 字段含 `7` |
| A5 | hidden 且光标落在内容格 / 空行 / 行内容之后三种分支 | 自动化验证（integration · 组件 smoke） | 同上 harness，逐分支构造字节流 | 三条分支均只输出 marker（无 `7` 属性、无 `\x1b[7m`），且不产生额外可见字符 |
| A6 | 全量回归 + 覆盖率门禁 + 类型检查 | 自动化验证（static + build） | `npm run verify`（`tsc --noEmit` + `node --test test/*.test.mjs` + c8 门禁 lines85/funcs80/branches70 + `pack:dry`） | 全绿，无既有测试被改语义 |
| U1 | 选择题 overlay 不再出现幽灵黑块 | 用户实测 | `board attach` 一个 pi 会话 → 触发 `question` 工具的选择题 → 观察选项行；再按 ↑↓ 移动高亮 | 选项行末尾/状态行均无黑色方块 |
| U2 | pi 场景光标可见性不回归（假光标 + IME 定位） | 用户实测 | attach 后在输入框输入中文：① 输入框内反白假光标是否正常 ② IME 候选窗是否仍贴在输入框光标处 | 假光标正常；候选窗不跳到状态行/选项行（即 marker 注入未被误伤） |
| U3 | 非 pi 子进程的可见光标仍被画出来 | 用户实测 | attach 一个 shell/vim 类会话（光标可见的子进程），观察光标 | 光标块仍显示且位置正确 |

`用户实测` 无法自动化的原因：U1/U2/U3 依赖真实终端 + 真实 IME + 真实子进程的可见光标状态，仓库既有 E2E 无法稳定复现 IME 候选窗行为；组件层已用 A3–A5 覆盖同一代码路径。

A5 的范围说明：`lineToAnsi()` 的 `!line`（buffer 查不到该行）分支在 `render()` 路径不可达（投影窗口由 `buf.length` 裁剪），属防御性分支，只做同构处理、不单独验收。

## 5. 风险与降级

| 风险 | 缓解 |
|------|------|
| `@xterm/headless` 私有字段改名（`_core.coreService.isCursorHidden`） | duck-type + `=== true` 判定 → 退化为 visible（= 现状），不崩 |
| marker 在 hidden 时被误删，导致 IME 定位回归 | A3 显式断言 marker 仍在；U2 人工确认候选窗行为 |
| 空行/无 buffer 行的 early return 分支漏改 | A5 覆盖三个分支，覆盖率门禁兜底 |
| 对 pi 之外子进程造成光标消失 | 行为矩阵 + A4 + U3；A4 用 `?25h` 回放模拟可见光标子进程 |

## 6. 改动文件（预估）

- `src/core/pty-attach-render.mjs`：新增 `isPtyCursorHidden()`。
- `src/ui/pty-attach.ts`：`XtermLike` 可选字段、`project()` 传参、`lineToAnsi()` 三个分支 + `paintCursor`。
- `test/pty-attach-render.test.mjs`：A1/A2。
- `test-support/cursor-visibility-smoke.ts`（新）+ `test/pty-attach-cursor-visibility.test.mjs`（新）：A3–A5。
- 无新增依赖、无配置变更、无文档面向用户的破坏性变更（如行为需说明，补 `docs/` 备注由 plan 决定）。
