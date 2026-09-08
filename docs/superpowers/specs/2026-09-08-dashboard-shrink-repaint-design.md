# issue #88 spec：dashboard 花屏修复（首帧全清 + 收缩自愈帧）

日期：2026-09-08 · 状态：已授权全自动推进（用户 2026-09-08 决策）

## 背景与问题

dashboard（pi-tui 全屏 overlay）花屏：行重复、folder 计数错位。根因：pi-tui 差分渲染在 overlay 激活时禁用 clearOnShrink（tui-main-screen.js L315 `!hasOverlayEntries`），且首帧不清屏（"assumes clean screen"）——脏底/收缩残留无任何自愈通道。拖窗口（widthChanged → fullRender(true)）可恢复，证明全清是有效兜底。973d492（v0.3.0）起存在的存量问题。

## 核心设计（单文件：src/ui/dashboard.ts）

### D1：mount 首帧全清
组件新增 `needsFullClear = true`；首帧 render 时 `this.tui.requestRender(true)`（nextTick 异步，无递归）——下一帧全量重绘，给干净底。

### D2：内容收缩自愈帧
- `fitToHeight` 记录 pad 前内容行数到实例字段（pad 后行数恒满屏，检测无效——必须用 pad 前值）；
- `render(width)` 改为包装方法：调原逻辑（改名 `renderLines`）拿 lines → 若 `needsFullClear` 或内容行数较上帧**减少** → `requestRender(true)` → 更新记录 → 返回 lines；
- 只响应**减少**（增长/同行数由差分正确处理），避免无意义全清。

### 为什么这样安全
- `requestRender(true)` 经 nextTick 异步执行（tui.js L612-628），render() 内调用不递归；
- 全清帧被 DECSET 2026 同步输出包裹，支持终端无闪烁；dashboard-render.mjs 注释警告的是"每帧 true"，本设计仅首帧+收缩帧低频触发；
- 不动 pi-tui 上游、不动差分语义、不动 dashboard-render.mjs。

## 非目标
- pi-tui 上游修复（node_modules 不可控；且 overlay 禁 clearOnShrink 是有意设计）；
- 每帧全清（闪烁，明确放弃）；
- attach 视图（PtyAttachComponent）的渲染问题（不同组件，不在本 issue）。

## 可测性拆分设计

| 单元 | 性质 | 测法 |
|---|---|---|
| 首帧/收缩触发逻辑 | 组件 render 包装（.ts） | 子进程冒烟：`test-support/dashboard-shrink-render.ts` 用 --experimental-transform-types 加载组件，fake tui spy + fake deps，render 三帧（首帧/增行/减行）输出 requestRender 调用序列 JSON |
| 既有差分语义 | dashboard-render.mjs | 现有测试 "dashboard repaint preserves Pi TUI differential render state" 不动（requestDashboardRender 不改成 force） |

冒烟脚本 deps 构造照搬 `test-support/dashboard-refs-render.ts`（同组件既有范式）。

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | mount 首帧全清 | 自动化（integration/冒烟） | `node --test test/dashboard-render.test.mjs` | 首帧 render 后 requestRender 收到 [true] |
| A2 | 收缩帧自愈 | 自动化（integration/冒烟） | 同上 | 减行帧触发 [true]；增行/不变帧不触发 |
| A3 | 修复在 .ts 层（jiti 可重载） | 自动化（static） | diff 审查 | 运行时代码改动仅在 dashboard.ts（.mjs 无运行时行为变更） |
| A4 | 全量回归 | 自动化（static/build） | `npm test` + `npm run typecheck` | 617+ 全绿 |
| U1 | 真实花屏场景 | 用户实测 | 合并后重启 pi：密集创建/删除若干 session（可配合 host 崩溃场景），观察 dashboard | 无行重复/计数错位残留；无需拖窗口恢复 |

U1 需重启 pi（git 包不热重载），合并后用户执行。

## 风险与降级
- 老终端无同步输出支持时全清帧可见一闪——低频可接受；
- 若 U1 发现仍有残留场景（如运行期外部写屏非首帧非收缩），后续可加"定时低频全清"兜底，本 spec 不做。
