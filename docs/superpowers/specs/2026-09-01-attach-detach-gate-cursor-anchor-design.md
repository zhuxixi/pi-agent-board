# Issue #66 Spec：← detach 门禁锚点重构（反白假光标）

> Draft：2026-09-01。state: **pending user review**（⏸ 等用户确认后再进 worktree）

## 1. 根因（调研结论，详见 issue 评论）

`childInputLooksEmpty()` 以 **xterm 硬件光标所在行**为锚点（`baseY + cursorY`），而 pi 渲染时：
- streaming：差分帧只重绘 Working 行，光标**持续**停在 `⠙ Working...` 行（~120ms/帧）；
- attach 完成瞬间：光标停在输出区/提示行。

两态下输入框为空但光标行非空 → `isProbablyEmptyPiInputLine` 判非空 → `←` 被转发给子进程。
v0.5.1 起 `ctrl+]` 已透传 Pi，`←` 是 attach 表面**唯一 detach 键** → 用户被困。

**可靠锚点（实证）**：pi 输入行恒渲染**反白假光标**（`\x1b[7m...\x1b[27m`，pi-tui `input.js` render + 本机 screen.log 双重确认），且反白 cell 在 xterm buffer 中**持久存在**（差分帧不重绘也保留）。从 buffer 底部向上扫"含 inverse cell 的行"即可定位输入行，**不依赖光标位置**。

## 2. 修复设计

### 2.1 `src/core/pty-input.mjs`

新增纯函数（现有 `isProbablyEmptyPiInputLine` 不变）：

```js
export function isProbablyPiInputLine(line) // 行首（trim 左空白）为 prompt/continuation 字形
```

字形集：`›>┃│|┆╎╏:`（与 isProbablyEmptyPiInputLine 的 trim 字符集一致，兼容有字形 pi 版本）。

### 2.2 `src/ui/pty-attach.ts` — `childInputLooksEmpty()` 重构

三层判定，按优先级：

1. **反白假光标锚点**（主）：从 `active.baseY + active.length - 1` 向上扫，找第一个含 `isInverse()` cell 的行 → 返回 `isProbablyEmptyPiInputLine(line.translateToString(true))`；
2. **字形行 fallback**（兼容无反白光标渲染的 pi 变体）：找不到反白行时，同向扫 `isProbablyPiInputLine` 行 → 判空；
3. **逃生兜底**：都找不到（损坏 buffer / replay 窗口无输入行帧）→ 视为空 → `←` 可 detach。

行为矩阵：

| 状态 | 反白行 | 字形行 | 判定 | ← 行为 |
|------|--------|--------|------|--------|
| 输入框空（attach 后 / streaming 中） | 空行 | — | 空 | detach ✓ |
| 输入框有草稿 | 非空行 | — | 非空 | 转发（不抢编辑键）✓ |
| 损坏残影 buffer | 无 | 无 | 空 | detach（逃生）✓ |
| 有字形 pi 版本 | 空行(`> `) | `> ` | 空 | detach ✓ |

## 3. 非目标

- ❌ ← 无条件 detach（违背"编辑中不抢键"产品意图，attach-flow.ts 亦保留门禁）
- ❌ 控制 socket 编辑器状态查询（pi 无此协议）
- ❌ 修改 `ctrl+]` 语义（v0.5.1 已透传 Pi，保持）

## 4. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | `isProbablyPiInputLine` 纯函数行为 | 自动化验证（unit） | `node --test test/pty-input.test.mjs` | 字形行 true；内容行/空行 false |
| A2 | 反白锚点：空输入行（光标漂移）→ detach | 自动化验证（unit） | `node --test test/pty-attach-detach-gate.test.mjs`（smoke B3） | `leftDetachesWhenCursorOffEmptyInputLine === true` |
| A3 | 反白锚点：草稿行 → 转发 | 自动化验证（unit） | 同上（smoke B） | `leftStaysGatedOnNonEmptyLine === true` |
| A4 | 反白锚点：无假光标行 + 空行 fallback | 自动化验证（unit） | 同上（smoke 新增） | `leftDetachesOnEmptyInput === true` 保持 |
| A5 | 损坏 buffer（无输入行）→ 逃生 | 自动化验证（unit） | 同上（smoke B1） | `leftEscapesOnGarbledBuffer === true` |
| A6 | 全套回归 + 覆盖率门禁 | 自动化验证（build/static + unit） | `npm run verify`（typecheck + 全部测试 + coverage 门禁 lines85/funcs80/branches70 + pack:dry，Node 22/24） | 全绿；无既有测试被改语义 |
| U1 | attach 后输入框空按 ← 回退 | 用户实测 | attach 进入 pi session → 立即按 ← | 回退到 dashboard，无需 ↑↓/输入删除 |
| U2 | pi 思考中（Working...）按 ← 回退 | 用户实测 | 触发 pi 思考（Working 动画）→ 按 ← | 回退到 dashboard |

## 5. 可测性拆分设计

| 函数 | 位置 | 职责 | 测试边界 |
|------|------|------|----------|
| `isProbablyPiInputLine(line)` | pty-input.mjs（纯函数） | 行首字形判定 | 输入字符串 → boolean；不碰 buffer/term |
| `findLastInverseCellLine(active)` | pty-attach.ts（私有，仅依赖 xterm buffer 接口） | 底部向上扫含 inverse cell 的行号 | 输入 fake buffer（{baseY, length, getLine}）→ 行号/null；**不依赖 cursorY** |
| `childInputLooksEmpty()` | pty-attach.ts | 三层组合判定 | 输入 buffer 状态 → boolean；经 smoke 场景验证 |

约束：`findLastInverseCellLine` 只读 buffer（无副作用）；`isProbablyPiInputLine` 无状态；smoke 场景构造 xterm 渲染序列（`\x1b[7m \x1b[27m` 等）验证端到端判定，不 mock 内部函数。

## 6. 风险

- pi 未来版本假光标不再反白渲染 → 字形/兜底 fallback 接管（判定仍可用，只是可能放宽为"视为空"）
- 多行编辑器最后一行空 → 判空 detach（与现状光标行逻辑一致，非回归）
- buffer 中其他反白元素（选中文本等）在输入行下方 → 极罕见；底部扫描以"最靠下"优先，选中文本在输出区（输入行上方）不干扰
