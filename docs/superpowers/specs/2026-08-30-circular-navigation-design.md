# Spec: dashboard 列表方向键导航循环回绕（issue #52）

日期：2026-08-30 · 状态：draft（等用户确认）

## 根因报告

**现象**：dashboard 主列表 ↑/↓ 移动选中项，到达首/尾边界后按键无效，无法循环。

**根因**（已通过代码直读确认，systematic-debugging Phase 1 完成）：
`src/ui/dashboard.ts` `moveSelection()`（L250-258）用 `Math.max(0, Math.min(len-1, ...))` 钳制新索引，而非取模回绕。该写法来自 MVP commit `72c0d8f`，非有意设计。

**调用链**：`handleListKey`（L334-335，normal 模式）与 `handleSelectKey`（L370-371，multi-select 模式）→ `moveSelection(±1)`。

## 设计

### 改动点

| # | 位置 | 改动 |
|---|------|------|
| 1 | `moveSelection()` L250-258 | 钳制 → 取模回绕：`next = ((base + delta) % len + len) % len` |
| 2 | `peekStep()` L1094-1101 | 同上，保持与主列表一致 |

### 决策表

| 决策点 | 决定 | 理由 |
|--------|------|------|
| `cur < 0`（selectedId 不在列表中） | 保持现状语义：按 ↑ 选最后一条、按 ↓ 选第一条（以 0 为 base 取模天然得到） | 与当前"从 0 开始"行为最接近，且更直觉 |
| 单条列表（len=1） | 取模后索引恒为 0，`nextId === selectedId` early return 挡掉无效更新 | 现有兜底继续生效，无需特判 |
| 空列表 | 现有 `length === 0` early return 保留 | 不变 |
| 滚动跟随 | **不改**——`windowBody()` 渲染时强制选中行可见，方向无关，回绕自动跟随 | 已验证 |
| 按键热路径性能 | 改动只涉及一次取模运算，不影响 #9/PR #12 的 prewarm debounce 设计 | 调研结论 |
| launch picker（cwd/model/thinking，L539-547） | **本 issue 不改**（非目标），另开 issue 跟踪 | 弹窗内短列表，回绕收益低；避免一次 PR 混两个行为变更 |

### 非目标

- launch 对话框 picker 的回绕（另议）
- 任何渲染层、滚动层改动
- 其他模式的按键行为

### 测试

目前 `moveSelection`/`peekStep` 无测试覆盖。补一个针对 Dashboard 的轻量测试（参考 `test/ui-smoke.test.mjs` 的实例化方式）：构造 3 条 orderedIds，断言 尾→↓→首、首→↑→尾 的回绕行为，以及单条/空列表不炸。

## 验证

1. `npm test` 全绿（含新增用例）
2. 手动跑 dashboard：多 session 列表，尾按 ↓ 回首、首按 ↑ 回尾，peek 模式同样验证
