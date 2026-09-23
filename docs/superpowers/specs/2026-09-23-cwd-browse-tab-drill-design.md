# issue #127 spec —— cwd 选择器 browse 模式 Tab 补全失效

> 状态：**已确认**（2026-09-23 用户拍板：选项 B shell 式下钻；`~` 展开不纳入本次范围）
> 调研留痕：research/01-kb-design-history.md、02-root-cause-code.md、03-test-infra.md（结论已评论到 issue）

## 根因报告（systematic-debugging Phase 1–3 结论）

**直接原因**：`src/ui/dashboard.ts:598-608` `handleLaunchPickerKey()` 的 Tab 分支内层条件是
`launch.cwdPickerMode === "favorites" && launch.cwdSuggestions.length > 0`。
browse 模式下条件不成立，控制流落到分支末尾 `return`——Tab 键被消费但什么都不做。

**促成原因**：`src/core/launch-options.mjs:358` `filterCwdCandidates()` 做原始子串匹配、不做 `~` 展开，
而收藏榜存绝对路径，所以任何 `~/...` 路径式输入必然零匹配，`nextCwdPickerState()`（:372）翻到 browse 模式。
browse 的候选列表本身是对的（`listDirectorySuggestions()` 内部已 `expandHome`）——
用户看到「候选对、Tab 死」，正是这条链路。

**可稳定复现**：结构性缺陷，无竞态——browse 模式下按 Tab 100% 走空 return。
修复前先写探针测试复现（Phase 4 要求）。

**历史脉络**：browse 是 issue #22（PR #23）之前就有的旧能力；Tab 补全是 #22 只给 favorites 模式新加的，
旧模式漏接。设计语义应保持 #22 的决定：Tab = 补全进输入框，Enter 才确认。

## 关键设计发现（issue 建议 1 单独不成立）

browse 补全后重算 `listDirectorySuggestions("/abs/dir")`，返回的 suggestions[0] 恒等于「目录自身」
（代码里 `if (existsDir(resolved)) out.push(resolved)` 在最前）。若只做建议 1（补全 + 重算），
下一次 Tab 会补全到自身 = 无进展，**无法像 shell 一样连续 Tab 下钻**。
issue 自己也意识到这点（建议 2「可选：追加路径分隔符或等价处理」）——结论是建议 2 不是可选，是下钻体验的必要组成。

## 设计方案（两个选项，待用户拍板）

### 选项 A：最小镜像（favorites 同款逻辑铺到 browse）——未采用

Tab 分支去掉 `cwdPickerMode === "favorites"` 限制，两模式共用：
取 `cwdSuggestions[cwdSuggestionIndex] ?? cwdSuggestions[0]` 写入 cwdQuery，`nextCwdPickerState()` 重算，index 指向已补全项。

- 效果：`~/wo` → Tab → `/home/elling/work`；此后 Tab 无进展（补全自身），下钻需 ↓ 选子目录再 Tab。
- 优点：改动最小、语义与 favorites 完全一致、无新行为。
- 缺点：不符合 issue 描述的「连续按 Tab 逐层下钻」预期。

### 选项 B：shell 式下钻（**已采用**）

在 A 的基础上加两条纯函数语义（browse 模式专属）：

1. **无进展前进**：若高亮候选与当前 query 解析到同一目录（忽略尾部分隔符），Tab 循环前进到下一个候选。
2. **补全即到位**：browse 模式补全时给目录路径追加 `path.sep` 写入 query——
   重算后列表第一项仍是该目录自身（Enter 可选它），连续 Tab 经规则 1 自然进入子目录，实现纯 Tab 下钻。

- favorites 模式行为一字不动（只删模式守卫，不动其分支语义）。
- 边界：候选只剩自身时下钻自然停止（循环回自身 = no-op）；补全后若路径命中收藏榜子串，状态机自动翻回 favorites，可接受。

### 范围外（单独的改进，本 issue 不含）——已确认不纳入

- issue 建议 3（收藏匹配前先 `~` 展开）：正交的 UX 改进，改变模式翻转条件，建议另开 issue 或用户明确点名再加。

## 改动面（选项 B）

1. `src/core/launch-options.mjs`：新增两个纯函数（见可测性拆分）。
2. `src/ui/dashboard.ts`：
   - `handleLaunchPickerKey()` Tab 分支删模式守卫，browse 走新 helper（约 :598-608）；
   - browse 底部提示（:1586）补 `tab complete`，与 favorites（:1582）对齐。

## 可测性拆分设计（实现硬约束）

新逻辑全部沉到 `launch-options.mjs` 纯函数层，dashboard 只做接线：

| 函数 | 职责 | 副作用 | 测试方式 |
|------|------|--------|----------|
| `sameResolvedDir(a, b)` | 两路径串是否解析到同一目录（expandHome + resolve + 去尾部分隔符） | 无（纯字符串运算） | unit |
| `browseTabCompletion(query, suggestions, index)` | 返回 `{ query, usedIndex }`：含无进展前进、目录追加分隔符 | 仅 `existsDir` 读 fs（与模块既有风格一致，测试用 tmpdir 真实目录） | unit |

dashboard.ts 的 Tab 分支瘦身成：取候选 → 调 helper → 写 query → `nextCwdPickerState()` 重算 → 设 index。
这层接线用既有探针模式覆盖（test-support/*.ts + `node --experimental-transform-types` 子进程），
不新造测试基建。实现不得把这两条语义重新耦回 dashboard.ts（保持纯函数边界）。

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | browse 模式 Tab 补全高亮候选进输入框并重算状态 | 自动化（integration，探针） | `node --test test/dashboard-cwd-tab.test.mjs` | 补全后 cwdQuery 等于高亮候选路径；修复前此测试必失败 |
| A2 | 连续 Tab 逐层下钻（选项 B 专属） | 自动化（integration，探针） | 同上探针：构造 tmp 目录树 `root/work/app`，连续 Tab | cwdQuery 依次深入 `work/` → `work/app/` |
| A3 | favorites 模式 Tab 行为不回归 | 自动化（integration，探针） | 同上探针：ranked 非空 + 子串命中场景 | Tab 仍补全高亮收藏项，模式保持 favorites |
| A4 | 纯函数 helper 边界 | 自动化（unit） | `node --test test/launch-options.test.mjs` | sameResolvedDir / browseTabCompletion 用例全过（含 `~`、尾部 `/`、单候选循环、index 越界） |
| A5 | browse 提示文案含 tab | 自动化（integration，探针渲染输出断言） | 同上探针渲染 launch 视图 | browse 模式提示行含 `tab complete` |
| A6 | 全量测试无回归 | 自动化（unit+integration 混合） | `npm test`（node --test test/*.test.mjs） | 全绿；另跑 `npm run typecheck` 通过 |
| U1 | 真实 TUI 手感 | 用户实测 | 开 agent-board → Start session → cwd 输 `~/wo` → Tab 补全为 `~/work/`（或绝对路径）→ 连续 Tab 下钻 → Enter 确认 → 启动 session | 补全/下钻符合 shell 手感；启动的 session cwd 正确 |

说明：U1 无法自动化的原因——补全「手感」（连续 Tab 节奏、渲染刷新是否顺眼）只有人在真实终端能判断；
探针已覆盖功能正确性，U1 是最终 UX 确认，时机为 PR 合并前。

## 非目标

- 不改 Enter/上下键/Esc 语义；不动 cwd-stats 计数；不动 favorites 排序与 home 兜底。
- 不做模糊匹配（fuzzy subsequence）——#22 已明确否决。
- 不做 issue 建议 3 的 `~` 展开进收藏匹配（除非用户点名纳入）。
