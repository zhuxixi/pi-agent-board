# Spec: board 删除键改为 `x` → `y` 确认（issue #150）

状态：draft（等用户确认）
日期：2026-09-30
仓库：pi-agent-board @ main `c93307d`

## 问题

board 上删除一个 session 现在是 `Ctrl+X` 连按两次（500ms 窗口，超时作废），第二次直接 archive、**无确认**。同一面板里 `d`（标 Done）、`X`（按状态批量删）、多选 `Ctrl+X`（批量删 Done）都走 `(y/N)` 确认——list 模式删除是唯一例外（`d5b2b84` 引入，当时替换掉的正是 y/N 确认）。用户反馈双击"有点麻烦"，要求改为 `x` → `y` 确认，与 `d` 的心智一致。

键位前提已审计通过：list 模式小写 `x` 空闲（调研见 `research/key-occupancy-audit.md`）。

## 设计决策

| # | 决策 | 结论 | 理由 |
| --- | --- | --- | --- |
| D1 | 触发键 | list 模式小写 `x` | 空闲；与 `v`/`e`/`m`/`i`/`d` 的单字母风格一致；避开大写 `X`（已占用）与 evidence 的 `x`（已占用，不同模式） |
| D2 | 确认方式 | 复用 `pending` + `mode = "confirm"` + `handleConfirmKey` | 与 `d`/`X`/多选删除同构，零新增机制 |
| D3 | 旧 `Ctrl+X` ×2 | **保留为便捷别名**（用户 2026-09-30 拍板） | 老用户肌肉记忆不受影响；`x` → `y` 成为主要入口，`ctrl+x` ×2 仍是"免确认快捷路" |
| D4 | 多选态（`m`）批量删 Done | **不动**（保持 `ctrl+x`；用户 2026-09-30 拍板） | 缩小改动面；多选态与主列表的删除路径不要求同键 |
| D5 | 删除语义 | 不变，仍 `service.archive()` | 软删除、busy 先停 host/run、session 文件保留 |
| D6 | peek / session / evidence | 不动 | 这些模式本无删除入口；evidence 的 `x` 语义不同 |
| D7 | 与 #147 的关系 | 不动 attach 键位 | 独立议题 |

### 非目标

- 不改 `service.archive()` / 状态协调器（语义与实现均不动）。
- 不给 attach 会话加删除入口（#147）。
- 不改 `X`（大写，按状态批量删）与 evidence 的 `x`（清诊断）。
- 不做键位可配置化（YAGNI）。

## 组件契约

改动集中在 `src/ui/dashboard.ts`：

1. 新增 `private confirmDelete(): void`（样板照 `confirmClearDiagnostics` `:1101` / `confirmDeleteState` `:1035`）：
   - `const row = this.selectedRow(); if (!row) return;`
   - `this.pending = { prompt: \`Delete "${row.meta.name}"?${isAgentBusy(row) ? " Stops the active run." : ""} Session file is preserved. (y/N)\`, onYes: () => { void Promise.resolve(this.deps.service.archive(row.meta.id)).then((res) => { res.ok ? this.notice(\`Deleted "${row.meta.name}"\`, "info") : this.notice(res.error ?? "Delete failed", "error"); this.refresh(); }); } }`
   - `this.mode = "confirm"`（`returnMode` 省略即默认 `list`，与 `confirmDeleteState` 一致）
2. `handleListKey`（`:355-390`）：新增 `if (data === "x") return this.confirmDelete();`（放在 `d`/`X` 分支旁）。`handleListKey` 首行的 arm 重置（`:356`）保持不变——按 `x` 会清掉 `ctrl+x` 的待确认态，语义正确。
3. **保留** `handleDeleteKey`（`:1016-1032`）、`deleteArm`（`:135`）、`DELETE_DOUBLE_PRESS_MS`（`:1803`）、`handleSelectKey` 的多选 `ctrl+x`（`:405`）——D3/D4 不变。
4. 文案同步（两条路径都要能查到，主入口 `x` 在前）：
   - list hints（`:1316`）：`ctrl+x x2 delete` → 两个 token：`x delete (y/N)` 与 `ctrl+x x2 quick`
   - help overlay（`:1667-1668`）：`d` 行下一并列出 `["x", "Delete selected session (y/N confirm)"]` 与既有 `["ctrl+x x2", "Delete selected session (quick double-press, no confirm)"]`
   - `README.md:117`（bullet）与 `README.md:142`（表格）：`x` 确认式为主、`Ctrl+X` ×2 标注为免确认快捷方式
   - select hints（`:1311`）与 help `:1671` **不动**（多选态保持 `ctrl+x`）

不新增 export、不改 `PtyAttachResult`/协议、不改 `service` 层。

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | `x` 打开确认提示（idle 行） | 自动化（unit，组件探针） | 新增 `test-support/dashboard-delete-key-probe.ts`（真 service 工厂）；`handleInput("x")` | `mode === "confirm"`；prompt 为 `Delete "name"? Session file is preserved. (y/N)`；`archive` 未被调用 |
| A1b | 空列表 / 无选中行按 `x` | 自动化（unit） | probe：空 root（无 view）构造组件 → `handleInput("x")` | 无崩溃、`mode === "list"`、不进入 confirm |
| A1c | busy 行提示会停 run | 自动化（unit） | probe：`setRowPatch` 置 `alive:true, state:{semanticState:"working"}` → `x` | prompt 含 `Stops the active run.`（idle 行不含） |
| A2 | `y` 执行软删除并回列表 | 自动化（unit，组件探针 + 真 temp-root service） | 同 probe 第二场景：`createView` ×2（navigation-wrap 模式）→ `x` → `y` | `service.rows()` 不含被删 id；notice `Deleted "name"`；`mode === "list"`；选中落相邻行 |
| A3 | 取消路径不删除 | 自动化（unit） | probe：`x` 后分别注入 `n`、`\x1b`(esc)、再次 `x`、`q` | 无 archive 调用、无 `Deleted` notice、`mode === "list"` |
| A4 | 旧双击别名仍可用（D3 回归） | 自动化（unit） | probe：注入 `\x18` ×2（间隔 0ms） | `archive` 被调用一次、无 confirm 步骤；间隔 700ms 的组合不删除（窗口语义不变；700ms > 500ms 窗口留余量） |
| A5 | insert 模式 `x` 是普通字符 | 自动化（unit） | probe：`i` 进 dispatch → 输入 `x` | `dash.input` 含 `x`；无 confirm/archive |
| A6 | 多选态路径不变（D4 回归） | 自动化（unit） | probe：`m` → 选中 Done 行 → `x`（应无副作用）→ `ctrl+x` → `y` | `x` 在多选态无任何副作用；`ctrl+x` 仍打开批量确认（`returnMode === "select"`）；`y` 经 `service.archiveMany` 归档且行从列表消失。注意：`archiveMany` 内部直调 `archiveView`、绕过 `service.archive`，须单独包记录器 |
| A7 | 文案同步（两条路径都可发现） | 自动化（unit + static） | probe 断言 list hints 与 help overlay 同时含 `x delete` 与 `ctrl+x x2`；`rg -n "Ctrl\+X twice quickly|Twice quickly" README.md` 命中且周围提到 `x` + `(y/N)` | 断言通过；README 两处均说明两条路径 |
| U1 | 真机交互确认 | 用户实测 | 起 board：选中一行 → `x` → 看提示 → `y`；对 Working 行重做；再验 `ctrl+x` ×2 老路径；删后查 `views/<id>/meta.json` 与 session 文件 | 行消失、host 停止、session 文件仍在；Working 行先停 run 再 archive；`x`→`n`/`esc` 无副作用；老双击仍按原语义删除 |

## 可测性拆分设计

- **不新增纯函数**：本次改动是"两个按键分支 + 一个复用既有 confirm 引擎的方法"，逻辑已天然分离——副作用边界 = `deps.service.archive()`，确认会话 = `handleConfirmKey()`。再抽纯函数只会为测试增加表面，无行为收益。
- **单工厂探针**：所有场景共用 `makeEnv()` —— 真 temp-root service（复用 `test-support/navigation-wrap.ts` 的 `mkdtempSync + createView + createService` 模式）+ 两个记录 wrapper（`service.archive` 与 `service.archiveMany`——后者内部直调 `archiveView`、绕过前者，必须单独包）+ `setRowPatch(fn)` 行补丁（busy 行 `alive:true, semanticState:"working"`；Done 行 `semanticState:"completed"`）。A2/A6 借真 service 验证"归档后行真的从列表消失"这条端到端组件路径；A1/A1b/A1c/A3/A4/A4b/A5 只断言提示与调用记录。
- **唯一真实计时点**：A4b 用 700ms sleep 验证 500ms 双击窗口过期——`setTimeout` 回调触发时墙钟必 ≥700ms > 窗口，不受机器负载影响，确定性成立。
- **驱动方式**：只走公开 `handleInput()`；断言可白盒读 `mode` / `pending` / `flash` / `input`（`navigation-wrap.ts` 已有先例）。按键编码用裸字节（`x`、`y`、`\x18`、`\x1b`）——dashboard 侧无终端编码依赖。
- **测试边界（不得越界）**：不测 `service.archive` 内部（`test/service.test.mjs` 已覆盖）；不测 attach / pty 路径（#147）；不测 pi-tui `matchesKey`（上游职责）；不依赖真实 host 进程。
- **新增文件**：`test-support/dashboard-delete-key-probe.ts`（tsconfig 已排除 test-support，不参与类型检查）+ `test/dashboard-delete-key.test.mjs`（`execFileSync` 跑探针，模式同 `dashboard-navigation.test.mjs`）。

## 风险

- **两套删除路径并存（D3）**：`deleteArm` 状态机保留，`x` 与 `ctrl+x` 的交互需明确——按 `x` 会清掉待确认的 arm（`:356` 现有逻辑），不会出现"x 确认中又触发双击"的叠加；A1/A4 用例分别钉住两条路径。
- **误按 `x` 后随手 `y`**：确认提示带行名，且有 `(y/N)` 兜底；代价是比双击多一次按键，属用户自选的主入口。
- **文案漂移**：同一事实现在散在 hints / help / README 三处且涉及两条路径，A7 用断言 + rg 钉住。
- **双入口的文档负担**：README 需同时解释"确认式 `x`"与"免确认 `Ctrl+X` ×2"，措辞要避免让用户以为两者等价。

## 决策记录（2026-09-30 用户拍板）

1. D3 = **保留** `Ctrl+X` ×2 作为免确认快捷别名（不移除状态机）。
2. D4 = 多选态批量删**保持** `ctrl+x`，本次不改。

scope 收敛为：**只在 list 模式新增 `x` → `(y/N)` 确认入口**；其余键位与语义全部保持。下一步：worktree `issue-150-board-delete-key-x-y-confirm` + writing-plans。
