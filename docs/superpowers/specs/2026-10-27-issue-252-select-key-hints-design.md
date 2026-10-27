# spec — issue #252：SELECT 模式的 in-app 文案对齐（hint 行 / `?` 覆盖层 / `!` 措辞）

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-27T23:28:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-27T23:47:00+08:00 — cross-review R2（收敛轮，0 真缺口）：R2-D1 接受（§5 残留的 `rg` 改为 `grep -c`，与 §4 A8 一致）；R2-D2 接受（`pty-support.mjs:155` → `src/core/pty-support.mjs:155`）；R2-D3 接受（U1 前置补 checkout 加载出处 + 重开 pi 会话）

基线：`main @ 3fcc2a4`（#249 之后）。调研留档（仓外，不随 PR 提交）：`~/.github-issue-driven/zhuxixi/pi-agent-board/issue-252/research/` 下的 `01-surfaces-audit.md`、`02-wording-evidence.md`、`03-test-harness.md`。
授权：`authorization.md` → `Gate: auto`（合并前仍需用户明确批准）。

## 1. 背景

`handleSelectKey`（`src/ui/dashboard.ts:398-423`）绑 9 组键：移动（`↑`/`↓`/`j`/`k`）、`space` toggle、`a` 全选、`u` 清空、`d` 批量 Done、`ctrl+x` 批量删除、`m`/`esc`/`ctrl+c` 退出、`?` 帮助、`!` PTY 诊断。

面向用户的两个 in-app 表面都落后于这份清单：

- **SELECT hint 行**（`listHints()`，`:1347-1358`）写 7 项，缺 `m`/`?`/`!`，且**现状已 122 字符**——120 列终端就被裁掉 2 字符（`esc cancel` → `esc canc`）。
- **`?` 覆盖层**（`renderHelp`，`:1723`）的 `In select` 行写的是 `j/k move · a select all · u clear · d move done · ctrl+x delete · esc cancel`：缺 `space`（该模式最常用的键）、方向键、`m`、`?`、`!`。

另外 `!` 的措辞三处不一致：README 六处 `repair hints`，覆盖层 `fix steps`，运行时面板用 `Fix:` + `Suggested steps`。

本 issue 是**纯文案同步**，无键位/行为变更。

## 2. 设计决策表

| # | 决策 | 依据 |
|---|---|---|
| D1 | SELECT hint 行改为 11 个 token 的紧凑形态：`${n} selected` · [`•${u} unread`] · `↑↓/j/k move` · `space toggle` · `a all visible` · `u clear` · `d done` · `ctrl+x delete` · `m/esc cancel` · `? help` · `! pty`（131 可见字符；带 unread 143） | 9 项全在；相对现状只长 9 字符。压缩方式：`d move done`→`d done`、`ctrl+x delete done`→`ctrl+x delete`、`esc cancel`→`m/esc cancel`。保留 `all visible` 的语义精度（过滤态下 `a` 只选可见行） |
| D2 | `In select` 行改为：`↑↓/j/k move · space toggle · a all · u clear · d done · ctrl+x delete · m/esc cancel`（渲染 101 列） | 只写本模式专属语义；`?`/`!` 由 D3 的全局行覆盖，不在本行重复。**该行决定整个帮助盒子的宽度**（`renderCenteredBox` 取最长行）：在 D2 行基础上再补 `? help`/`! pty` 为 118 列（若保留原 `a all visible` 写法则为 126 列），两种形态都超过 120 列终端的 `width-6=114` 上限，在 120 列也照样被裁（research/01 §B） |
| D3 | 覆盖层新增一行 `["?", "Open the key help overlay (list and multi-select)"]`，位置在 `/` 行与 `!` 行之间 | `?` 只绑在 list（`:373`）与 select（`:421`），覆盖层 26 行里一句都没有——这是 issue 未点明的第三处缺口。`!` 已有全局行，故 D2 不重复它 |
| D4 | `!` 的 canonical 措辞 = `fix steps`：README 六处改齐（4 张表 + `:289` + `:368`）；覆盖层 `:1716` 不动 | 面板自己写 `Fix:` / `Suggested steps`，字段名 `fixHint`/`steps`，代码注释（`src/core/pty-support.mjs:155`）也是 `fix steps`；反向对齐要改运行时代码且与面板自相矛盾（research/02） |
| D5 | 不动 handler、不动键位、不动 `#246` 的高度适配、不新增 README 表格、不回改历史 spec/plan | 范围纪律。#245 的 D5 是「in-app 三处就其 j/k/l 范围而言已正确，故不动」，并非把 in-app 侧 defer 给后续 issue；本 issue 处理的是 #245 范围**之外**的 SELECT 表面（hint 行的 `m`/`?`/`!`、`In select` 行、`!` 措辞），两者不冲突 |

### D1 的取舍：为什么接受「窄终端裁尾」

11 个 token 在任何布局下都塞不进 80 列，131 字符在 120 列仍会裁掉尾部（`? help`/`! pty`）。三个理由支撑这个取舍：

1. 仓库既有行为就是裁尾：NORMAL hint 行 **238 字符**，240 列才完整（实测，research/01 §A）。
2. 裁掉的恰好是两个辅助键：`m/esc cancel` 止于第 114 列，在 120 列终端**完整可见**，被裁的只有尾部 `? help` / `! pty`——安全优先。
3. `?`/`!` 在覆盖层（D3 + `!` 全局行）与 README 里都有完整说明，不依赖 hint 行发现。

**被否决的替代方案**：SELECT footer 折成两行（改 `renderFooter`，让 select 模式多占一行）。它能让 80 列也全可见，但会改变 footer 高度、且仓库没有任何多行 hint 先例，属于布局变更而非文案同步——留给 `#246` 的高度适配一并考虑。

### 与 `#246` 的交互

新增 `?` 行使帮助盒子从 32 行变 **33 行**，`#246` 的裁剪阈值随之多一行。此处不做补偿（不加行数压缩、不删 `normal`/`insert` 说明行）：`#246` 的方向就是重构高度适配，提前在文案侧做布局妥协会让它的方案空间变窄。

## 3. 改动清单

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/ui/dashboard.ts` | `listHints()` SELECT 分支 `:1348-1357` | 按 D1 替换 token 列表 |
| `src/ui/dashboard.ts` | `renderHelp()` rows `:1723` | `In select` 行按 D2 替换 |
| `src/ui/dashboard.ts` | `renderHelp()` rows `:1715` 后 | 按 D3 插入 `?` 行 |
| `README.md` | `:148` `:166` `:180` `:200` | `repair hints` → `fix steps` |
| `README.md` | `:289` | `diagnosis and repair hints` → `diagnosis and fix steps` |
| `README.md` | `:368` | `follow its repair hints` → `follow its fix steps` |
| `test-support/vim-keys-wrap.ts` | capture 段 `:130` 之后 | 先插捕获代码：`tui.terminal.rows = 40`，在 SELECT 模式下取 `dash.render(160).join("\n")`，随后恢复 `rows = 24`（照 `:122-126` 的既有手法） |
| `test-support/vim-keys-wrap.ts` | `out.copy`（`:146`，单行对象字面量） | 把 `selectWide` 加进该对象 |
| `test/dashboard-vim-keys.test.mjs` | 末尾 | 新增一条 test（A1-A6） |

## 4. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | SELECT hint 行文档化 9 组绑定中的 7 个键 + 2 个辅助键 | 自动化（unit，探针渲染） | `node --test test/dashboard-vim-keys.test.mjs`，对 `selectWide` 断言 `/↑↓\/j\/k move/`、`/space toggle/`、`/a all visible/`、`/u clear/`、`/d done/`、`/ctrl\+x delete/`、`/m\/esc cancel/`、`/· \? help · ! pty/` | 8 条全部通过 |
| A2 | 旧措辞不再出现 | 自动化（unit） | 同命令，`assert.doesNotMatch(selectWide, /d move done/)`、`/ctrl\+x delete done/` | 2 条负向断言通过 |
| A3 | hint 行宽度受控（防再次膨胀） | 自动化（unit） | 从 `selectWide` 取含 `[SELECT]` 的行，`trimEnd().length` 断言 `<= 132` | 131 ≤ 132 通过；超过即红 |
| A4 | 覆盖层 `In select` 行同步 | 自动化（unit，探针 `help120`，rows=40） | `/In select.*↑↓\/j\/k move/`、`/In select.*space toggle/`、`/In select.*a all · u clear/`、`/In select.*d done/`、`/In select.*ctrl\+x delete/`、`/In select.*m\/esc cancel/`；负向 `/In select.*a select all/` | 6 条正向 + 1 条负向通过 |
| A5 | 覆盖层新增 `?` 行 | 自动化（unit，`help120`） | `/\?\s+Open the key help overlay \(list and multi-select\)/` | 通过 |
| A6 | `!` 措辞统一（in-app 侧） | 自动化（unit，`help120`） | `/Open node-pty diagnostics and fix steps/` 且 `doesNotMatch(/repair hints/)` | 通过 |
| A7 | 无回归 | 自动化（unit，全量） | `npm test` | 全绿，尤其既有 `dashboard-vim-keys` 两条用例 |
| A8 | README 六处措辞改齐 | 自动化（static，grep；dev 工具，未入 CI） | `grep -c 'repair hints' README.md` → 0 行匹配；`grep -c 'fix steps' README.md` → 6 | 两个计数符合预期 |
| A9 | 类型/构建/覆盖率门槛 | 自动化（build + test） | `npm run verify` | typecheck、perf gate、全测试、coverage（lines 85 / funcs 80 / branches 70）、pack:dry 全过 |
| U1 | 真机观感 | 用户实测 | **前置**：PR 合并后在本 checkout `git pull`；确认扩展从本 checkout 加载（README `### Development auto-discovery`：`ln -s "$(pwd)" ~/.pi/agent/extensions/agent-board`，或 `pi install "$(pwd)"`；npm registry 副本要等发版才能看到改动）；**重开 pi 会话**后测（扩展只在 pi 启动时加载，已在跑的实例不会拾取新代码）。**步骤**：① `pi /agent-board`，按 `m`，看底栏是否完整列出 9 项（终端 ≥132 列时可全见，120 列时尾部 `? help`/`! pty` 会被裁——符合 D1 取舍）② 按 `?`，看 `In select` 行含 `space toggle` ③ 在覆盖层确认 `?` 行与 `!` 行文案 ④ 按 `!`：面板标题恒为 `node-pty diagnostics`；**若 PTY 健康**，确认只显示 `Status: healthy`（正文无 `repair hints` 旧措辞即符合 D4）；**若面板进故障分支**，确认分节标签为 `Fix:` / `Suggested steps`（这两段只在非健康分支渲染，健康机器上不出现是预期的） ⑤ 按 `m` 或 `esc` 退出 | 五步观察与 D1-D4 一致；若 120 列下尾部裁剪超出预期，记录实际宽度并回报（不视为失败，D1 已声明取舍） |

## 5. 可测性拆分设计

**不新增函数、不改拆分。** 两个改动点都是既有渲染路径里的字符串字面量：

- `listHints()`（`:1340`）已是纯字符串构造：输入 `this.mode` / `selectionCount()` / `unreadCount()` / `input`，输出 `string`，无 I/O、无副作用；由 `renderFooter` 消费。**不把 token 数组提成模块常量**：那样测试只能断言常量自身（同义反复），反而弱于在渲染面上断言。
- `renderHelp()`（`:1698`）已是 `width -> string[]` 的纯渲染方法，`rows` 是方法内字面量；同样保持内联。

**测试边界**：`test-support/vim-keys-wrap.ts`（探针，`node --experimental-transform-types`）→ `test/dashboard-vim-keys.test.mjs`（`node:test` + `assert/strict`）。这是本仓既定的 dashboard 文本断言层级（unit），不需要 integration / E2E：改动不跨组件、不涉及文件或协议。

**探针改造（最小）**：现有 `selectRender`（`test-support/vim-keys-wrap.ts:130`）是 120 列，新行 131 字符会被 `clip()` 裁尾 → A1/A3 假红。故新增 `selectWide`（`rows = 40` 下 `render(160)`，插在 `:130` 之后，结果挂进 `:146` 的 `out.copy`）。覆盖层断言复用既有 `help120`（已是 rows=40，绕开 `#246` 的裁剪）。

**红绿校验**：A1/A2/A4/A5 在改动前必须是红的。已核对：`space toggle` 早在 `9612d92` 就在 SELECT hint 行里，因此**不能**用它做唯一断言（issue 原建议的 `assert.match(selectRender, /space toggle/)` 今天就是绿的）；`m/esc`、`? help`、`! pty`、`In select.*space toggle`、`?` 行在本改动前均不存在（research/03 红绿表）。

**不可自动化项**：README 文本（A8 用 `grep -c` 静态核对，不新建 README-lint 测试——仓内无读 README 的测试先例，为此基建超出范围）；U1 的真机观感（终端宽度、配色、截断位置只能在真终端上判断）。

## 6. 非目标

- 不修 `#246`（帮助面板在 <32 行终端的裁剪）——D3 会让它多一行，属于 `#246` 的自留地。
- 不改任何键位绑定、不改 handler 分支逻辑。
- 不新增 README 表格、不调整 README 章节结构、不回改 `docs/superpowers/{specs,plans}/2026-10-26-issue-245-*` 历史留档。
- 不改 `renderPtyHelp` 的面板标签（`Fix:` / `Suggested steps`）——D4 以它们为准。
