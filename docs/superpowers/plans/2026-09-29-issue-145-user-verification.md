# Issue #145 — On-hold semantic state: user-verification checklist

Source: `docs/superpowers/specs/2026-09-29-issue-145-holding-semantic-state-design.md` §9 "用户实测" (U1–U7). Operation steps and pass criteria below are copied verbatim from that table; 验收方式 for every item is 用户实测.

**How to run this checklist:** these items are executed **by a human against an installed build** of the extension (not against a source checkout run through `node`). The automated gate passing (`npm run verify`, acceptance A20, recorded in the task-12 report) does **not** substitute for any of them. An item with no observed result stays `pending` — per spec §9's 验收纪律: "U 项未执行前不得宣称验收完成；自动化项通过不能替代 U 项。"

Record each item's result (`pass` / `fail` / `pending`) in its section and in the summary table below. If a `fail` is observed, note the row's `diagnostics.jsonl` tail and the exact key sequence.

## Results summary

| ID | 功能点 | 结果 | 备注 |
|----|--------|------|------|
| U1 | `h` 置搁置 | `pending` | |
| U2 | `h` 解除搁置 | `pending` | |
| U3 | 说话即恢复（holding） | `pending` | |
| U4 | 说话即恢复（既存回归） | `pending` | |
| U5 | `d` 转真完成 | `pending` | |
| U6 | 搁置行可删 | `pending` | |
| U7 | 搁置行 + follow-up 不自动唤醒（含 Done 行对照） | `pending` | |

## U1 — `h` 置搁置

- **操作步骤**: 在面板 list 选中一个非 busy 行，按 `h`
- **通过标准**: 行进入 **ON HOLD** 分组（位置在 NEEDS INSTRUCTIONS 之后、DONE 之前）；顶栏与 footer 计数不变；notice 提示已搁置
- **结果**: `pending`

## U2 — `h` 解除搁置

- **操作步骤**: 对 ON HOLD 行再按 `h`
- **通过标准**: 行回到 **NEEDS INSTRUCTIONS** 分组；notice 提示已恢复
- **结果**: `pending`

## U3 — 说话即恢复（holding）

- **操作步骤**: 对 ON HOLD 行按 `→` attach，在真实会话里敲一句话提交
- **通过标准**: 行变为 **RUNNING**；该行 `diagnostics.jsonl` **不再新增** `sync_foreground rejected (manual_fence)`
- **结果**: `pending`

## U4 — 说话即恢复（既存回归）

- **操作步骤**: 对 **DONE** 行 attach 后敲字提交
- **通过标准**: 同上（行变 RUNNING、无新 manual_fence 拒绝）。这条是本 PR 修的既有 bug，与 holding 无关也应通过
- **结果**: `pending`

## U5 — `d` 转真完成

- **操作步骤**: 对 ON HOLD 行按 `d` 并确认
- **通过标准**: 行进入 **DONE** 分组；`state.json` 的 `semanticState === "completed"`
- **结果**: `pending`

## U6 — 搁置行可删

- **操作步骤**: 对 ON HOLD 行按 `X`
- **通过标准**: 该状态全部 inactive 行被归档；live 行跳过
- **结果**: `pending`

## U7 — 搁置行 + follow-up 不自动唤醒（含 Done 行对照）

- **操作步骤**: 给 ON HOLD 行排队一条 follow-up（先使其 busy 时 reply，或 `delivery: "queue"`），再置搁置，等待；**对照**：另一条 Done 行同样排队 follow-up 且 host 存活，等待 reconcile
- **通过标准**: 主行保持 ON HOLD，不被自动唤醒，队列计数保留；对照行 follow-up 被投递且行变 RUNNING（§4.4 自动投递交互的实测）
- **结果**: `pending`
- **Note:** spec §10 open question 2 — if "holding + queued follow-up" is too hard to construct manually, U7 degrades to the A18 automated coverage and stays `pending`.

## Completion rule

All seven items must read `pass` (or U7 degraded per its note) before issue #145's user acceptance is declared complete. Do not flip a result without performing the operation against the installed build.
