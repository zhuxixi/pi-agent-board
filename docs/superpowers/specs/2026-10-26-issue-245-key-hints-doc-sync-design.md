# spec — issue #245：key hints 与实际绑定同步（三条文档欠账）

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-26T22:40:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-26T22:55:00+08:00 — cross-review R1：R1-D1 接受（D3 钉死 9 行小表，含 `?`/`!`）；R1-D2 接受（U1/U2 补部署前置与可执行时机）；R1-D3 接受（§5 补 fitToHeight 截尾陷阱）；R1-D4 接受（删除无出处数字 89/1257，改为实测 1404）

基线：main @ 724c4da（v0.13.0 之后）。调研留档：`research/01-verify-three-gaps.md`（三条主张全部复核属实）。

## 1. 背景

#229 落地 vim 键位时按「加键须同步三处文案」的纪律补了 README 表、`?` 帮助面板、hints 行，但有三处历史欠账没覆盖：peek 视图的 in-view footer 仍宣传旧键位；README 的 Peek/Transcript 两表漏写 `!`；README 的多选段落从未写过移动键。本 issue 是一次纯文案同步，**无行为变更**。

## 2. 设计决策表

| # | 决策 | 依据 |
|---|---|---|
| D1 | peek footer 改为 `↑↓/j/k prev/next · →/l attach · d done · v transcript · e evidence · r reply · esc back` | 与 #237 给 session/evidence footer 补 `↑↓/j/k` 的写法严格一致；与 peek 的 `?` 行、README Peek 表口径对齐 |
| D2 | README Peek 表与 Transcript 表各加一行 `\| \`!\` \| Open node-pty diagnostics and repair hints. \|`，措辞照抄 Main list 表（:148） | 同一功能三种视图应同措辞；Evidence 表**不加**（`handleEvidenceKey` 无 `!` 分支） |
| D3 | README 多选段落改为**独立小表**（`### Multi-select`），**固定 9 行**，逐行对应 `handleSelectKey` 的全部绑定：`↑`/`↓`/`j`/`k` 移动 · `space` toggle · `a` 全选 · `u` 清空 · `d` 批量 Done · `ctrl+x` 删除 · `m`/`esc` 退出 · `?` 帮助 · `!` PTY 诊断 | select 模式现有 9 组绑定，句子已列 5 项；README 四视图凡绑定多的都用表格。**行数必须钉死 9，不可只写 7 组**——只列模式专属的 7 组会把 `?`/`!` 原样遗留，正是本 issue 在修的同类欠账（R1-D1）。**备选方案**：延伸 `README.md:120` 的句子（改动更小但可读性差）——见 §6 待裁决 |
| D4 | 顺手给 peek footer 加渲染断言（`test-support/vim-keys-wrap.ts` 的 `out.copy` 补 `peekRender`，A 项断言） | 现有探针断言了 list/select/session/evidence 渲染，**唯独漏 peek** —— 这正是本轮欠账能漂移的机制原因。不补则下次同样漂移 |
| D5 | 不动任何 handler 代码、不动 `?` 帮助面板、不动 hints 行 | 三处已正确；本 issue 只修「对外文档」侧，避免范围扩张 |

## 3. 改动清单

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/ui/dashboard.ts` | :1543 `renderPeek` footer | 文案 `↑↓ prev/next · →/> attach` → `↑↓/j/k prev/next · →/l attach` |
| `README.md` | Peek 表（:152-167） | 新增 `!` 行 |
| `README.md` | Transcript 表（:169-183） | 新增 `!` 行 |
| `README.md` | 多选段落（:120） | 依 D3 改为独立小表（或延伸句子，见 §6） |
| `test-support/vim-keys-wrap.ts` | `out.copy` 段 | 新增 `peekRender` 捕获 |
| `test/dashboard-vim-keys.test.mjs` | A7 测试 | 新增 peek footer 断言 |

## 4. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | peek footer 渲染出 `j/k` 与 `l` | 自动化（unit，探针渲染） | `node --test test/dashboard-vim-keys.test.mjs` | `assert.match(peekRender, /↑↓\/j\/k prev\/next/)` 与 `/→\/l attach/` 均通过 |
| A2 | 改前先红、改后转绿 | 自动化（unit） | 同一命令，先提交断言跑一次 | 改文案前 FAIL（旧 footer 无 `j/k`）；改后 PASS |
| A3 | peek footer 不再出现旧措辞 | 自动化（unit，探针渲染） | `assert.doesNotMatch(peekRender, /↑↓ prev\/next · →\/> attach/)` | 负向断言通过 |
| A4 | 其余视图 footer/hints 未回归 | 自动化（unit，现有断言） | `npm test` | 全量用例（当前实测 1404：1401 pass / 3 skipped / 0 fail）全绿，且 `dashboard-vim-keys` 两条测试均过 |
| A5 | typecheck + 全量门槛 | 自动化（build/test） | `npm run verify` | typecheck、perf gate、全测试、coverage 阈值（lines 85/funcs 80/branches 70）、pack:dry 全过 |
| U1 | README 三处改动可读且与代码一致 | 用户实测 | **前置**：PR 合并后 `git pull` main；本地 checkout 由 pi 自动发现加载（README:63 Development auto-discovery），重启 pi 后测；README 必须是合并后版本（旧版本内容不同）。**步骤**：① 对照 `### Peek` 表逐行按 `!`，确认打开 PTY 诊断（此绑定 v0.13.0 已存在，对旧版本同样成立）② 同样验 `### Transcript` ③ 进 `m` 多选模式，按小表**全部 9 行**逐项核对（移动 / space / a / u / d / ctrl+x / m·esc / `?` / `!`） | 三处无遗漏、无虚构键位；小表 9 行逐项可用 |
| U2 | peek footer 实际显示 | 用户实测 | **前置**：同 U1（新 footer 只存在于合并后的代码，旧安装仍是旧文案 → 不拉取就必然假失败）。**步骤**：`space` 进 peek，看底部提示行 | 显示 `↑↓/j/k prev/next · →/l attach · …` |

## 5. 可测性拆分设计

**不新增函数、不改拆分**：唯一的产品改动是 `renderPeek` 内一个字符串字面量。`renderPeek(width)` 已是独立纯渲染方法（输入 width，输出 string[]），副作用只在终端写入，符合「纯函数优先、副作用隔离」的既有结构。

**测试边界**：继续用 `test-support/vim-keys-wrap.ts` 探针 —— `dash.render(120)` 取整屏文本，正则断言（与 A7 现有 28 条渲染断言同类）。**不新增测试文件、不新增探针文件**：本 issue 的自动化面只有一条 footer 文案，扩展现有探针是最低成本层级（unit），无需 integration。

**⚠️ fitToHeight 截尾陷阱（R1-D3）**：`render()` 走 `fitToHeight`，它对超出行高的输出是**截尾部**（`src/ui/dashboard.ts:1280` `lines.slice(0, height)`）。peek footer 是 `renderPeek` 输出的**最后一行**，而探针终端默认 24 行——只要 peek 内容（Summary / Auto-state / Refs / Question / Latest output / Error 各段加 wrap 折行）超过 24 行，footer 就会被切掉，A1/A3 假红。**实现时必须在 peek 捕获前临时把 `tui.terminal.rows` 调大**（A7 段已用同样手法把 help 捕获提到 40 行，照此先例），或保证夹具视图足够矮。不处理会误判为渲染逻辑问题。

**README 三处不可自动化**：仓内无任何测试读 README（`rg -ln 'README' test/` 仅命中两个与文档无关的用例），为此新建 README-lint 测试属于超出本 issue 范围的基础设施投入 → 归 A5 之外的 U1 用户实测，spec 明说不自动化的原因。

## 6. 待裁决：D3 的呈现形态

- **方案 A（推荐）**：新增 `### Multi-select` 小表，与四个视图表并列。理由：9 组绑定用句子不可读；README 现有结构是「视图/模式 → 表」。
- **方案 B**：延伸 `README.md:120` 的句子加「`↑`/`↓`/`j`/`k` to move」。理由：diff 最小（一行），不动文档结构。

选 A 的代价是要动 README 章节结构（可能影响锚点）；选 B 的代价是句子继续变长。

## 7. 非目标

- 不改任何 handler 行为、不改 `?` 帮助面板、不改 hints 行（D5）。
- 不给 Evidence 表加 `!`（该模式无此绑定）。
- 不新建 README 测试基础设施。
- 不处理 help 面板矮终端裁剪（那是 #246）。

## 8. 保证边界

- 只保证 §3 列出的六处改动；不保证 README 其它段落（如 `## Dashboard Workflow` 的叙述）与键位完全一致。
- A1–A4 只证明 peek footer 与既有渲染断言；README 三处的正确性仅由 U1 人工核对保证，无机器门禁——这是本 spec 明说的保证边界，不假装有自动化兜底。
