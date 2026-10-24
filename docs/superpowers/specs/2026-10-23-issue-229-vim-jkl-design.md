# spec — issue #229：vim-style j/k/l in the board list

Drafted: kimi-coding/k3 (selected) · kimi-coding/k3 (physical) @ 2026-10-23T22:50:00+08:00
Revised: kimi-coding/k3 (selected) · kimi-coding/k3 (physical) @ 2026-10-23T23:00:30+08:00 — cross-review R1：R1-G1 接受（§4.1 In evidence 行补 l attach、A7 改逐行断言）；R1-G2 接受（新增 A9 负向断言）；R1-D1 接受（U1 部署前置改为按 `pi list` 原源同形移除/恢复）；R1-D2 接受（§7 先例引用改 dashboard-prewarm-smoke.ts）
Revised: kimi-coding/k3 (selected) · kimi-coding/k3 (physical) @ 2026-10-23T23:05:30+08:00 — cross-review R2：R2-D1 接受（evidence 帮助行手势串改 `→/l attach` 与 peek 口径对称）；R2-D2 接受（A7 枚举补齐 4 处 j/k 行断言 + 负向断言扩展到 In peek/session/evidence 旧措辞）

基线：main @ 759d659。调研留档：`research/01-keybinding-audit-and-history.md`（issue 测量全部验证属实）。

## 1. 背景与问题

board 的 `list` 模式是用户停留最久的视图，却是唯一不接受 `j`/`k` 的导航视图：`j`/`k` 落到 printable fallback 弹错误的 INSERT toast；`l` 全模式空闲，而它的箭头孪生 `→` 是主 attach 手势。两个只读视图（session/evidence）已绑 `j`/`k` 滚动。目标：让 list/select/peek 的导航与 attach 键位符合 vim 肌肉记忆，且不破坏任何文本输入模式与既定键位契约（`h` = Hold，PR #151）。

## 2. 设计决策表

| # | 决策 | 依据 |
|---|---|---|
| D1 | 采纳 issue 的 Proposed direction 全部内容 | 测量经调研验证属实，与历史决策无冲突 |
| D2 | `j`/`k` **复用** `moveSelection()` / `peekStep()` —— 继承**环绕（wrap）**语义，与 `↑`/`↓` 逐字节一致；**不**实现 issue Verification 措辞里的 "clamp" | wrap 是 issue #52 的既定行为，`test/dashboard-navigation.test.mjs` 锁定；`j`/`k` 与 `↑`/`↓` 行为分裂（一个 wrap 一个 clamp）比不环绕更糟。这是与 issue 措辞的唯一偏差 |
| D3 | 顺带清理 `handleListKey` 的两处重复行（`data === "d"` ×2、`ctrl("x")` ×2，merge 残留死代码） | 零行为变化；改动同函数，顺手清理成本最低 |
| D4 | select 不绑 `l`（无对应动作，`space` 才是 toggle）；session 不绑 `l`（无 `→` 可镜像，已有 `enter`/`a` 两条 attach 路径） | issue 已论证 |
| D5 | 补齐**已有** `j`/`k` 在 Transcript/Evidence 的文档欠账（help 面板与 README 四表均未写） | 调研发现：欠账不止新键，既有键也未写 |
| D6 | 不动 `h`（Hold）、不动 dispatch/filter/rename/reply（`j`/`k`/`l` 保持字面字符）、不动 attach 侧键位 | `h` = Hold 是 PR #151 契约；文本模式字母必须字面；attach 是裸 PTY 透传的另一套面（JFox `202610182229584028`） |

## 3. 逐模式键位变更（src/ui/dashboard.ts，行号为 main @ 759d659 参考值）

| 模式 | handler | 新增绑定 | 行为（复用现有路径） |
|---|---|---|---|
| list | `handleListKey` :359 | `j` / `k` | `moveSelection(+1 / -1)`，环绕，与 `↑`/`↓` 同一路径 |
| list | `handleListKey` | `l` | `attachSelected()`，镜像 `→` / `>` |
| select | `handleSelectKey` :400 | `j` / `k` | `moveSelection(±1)` |
| peek | `handlePeekKey` :427 | `j` / `k` | `peekStep(±1)`，环绕 |
| peek | `handlePeekKey` | `l` | `attachPeek()`，镜像 `→` / `>` |
| evidence | `handleEvidenceKey` :484 | `l` | `attachSelected()`，镜像 `→`（`j`/`k` 已有） |
| session | — | 无变更 | `j`/`k` 已有；不绑 `l`（D4） |
| dispatch / filter / rename / reply | `handleTextMode` | 无变更 | `j`/`k`/`l` 保持字面字符（D6） |

插入位置约定：各 handler 内紧贴对应箭头键分支之后，保持「先功能键后字母」的既有阅读顺序。list 模式的新分支须位于 printable fallback（:394）之前。

## 4. 文案同步（五处，调研发现的三处纪律 + 两处欠账）

1. `renderHelp` 帮助面板（:1699-1730）：`↑/↓` 行 → `↑/↓ or j/k`；`→ or >` 行 → `→ / > / l`；"In select" 行补 `j/k`；"In peek" 行 `↑↓` → `↑↓/j/k`、`→ attach` → `→/l attach`；"In session"/"In evidence" 行补已有的 `j/k` 滚动（D5）；**"In evidence" 行另补 attach 手势串 `→/l attach`**（§3 给 evidence 新增了 `l`，帮助面板必须同步，否则 README/帮助/行为三处不一致；手势串保留主手势 `→` 与 peek 行口径对称，不只写新增的 `l`）。
2. `listHints()` NORMAL 行（:1362）：`→ attach` → `→/l attach`。
3. `listHints()` SELECT 行（:1350）：补 `j/k move`。
4. README Main list 表：`Up/Down` 行补 `j`/`k`；`Right / >` 行补 `l`。
5. README Peek / Transcript / Evidence 三表：Peek 补 `j`/`k` 与 `l`；Transcript/Evidence 补已有的 `j`/`k`（D5），Evidence 补 `l`。

## 5. 非目标

- 不绑 `h` 的任何新义（Hold 契约不动，不「补全 hjkl 四键」）。
- 不给 session 模式加 `l`；不给 select 模式加 `l`。
- 不动 attach 视图键位、不动文本输入模式。
- 不改变 wrap 语义本身（想改 clamp 需另开 issue 并影响 `↑`/`↓`）。

## 6. 验收矩阵（必答）

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | list 模式 `j`/`k` 移动选择 | 自动化（unit，探针） | `node --test test/dashboard-vim-keys.test.mjs`（新探针 `test-support/vim-keys-wrap.ts`，复用 navigation-wrap 模式） | 3 行 fixture 上 `j`/`k` 序列的 `selectedId` 轨迹与 `↑`/`↓` 同序列完全一致（含两端环绕） |
| A2 | select 模式 `j`/`k` | 自动化（unit，同探针） | 同上 | 进入 select 后 `j`/`k` 移动选中且环绕 |
| A3 | peek 模式 `j`/`k` → `peekStep` | 自动化（unit，同探针） | 同上 | `peekId`/`selectedId` 轨迹与 `↑`/`↓` 一致 |
| A4 | `l` 在 list/peek/evidence 触发 attach | 自动化（unit，同探针） | 构造器注入 fake `done` 回调捕获 `{action:"attach", viewId}` | 三模式各捕获一次 attach 且 viewId 正确；fixture 用非 busy row（时序约束见 §7） |
| A5 | dispatch/filter/rename/reply 的 `j`/`k`/`l` 仍为字面字符 | 自动化（unit，同探针） | 各文本模式下按 `j`/`k`/`l`，白盒读 `this.input` | input 含字面 `jkl`，无模式跳出 |
| A6 | session/evidence `j`/`k` 滚动回归保护 | 自动化（unit，同探针） | 断言 `sessionScrollTop`/`evidenceScrollTop` | `j`↓`k`↑ 与 `↓`↑ 行为一致（既有行为不回归） |
| A7 | help/hints 文案更新 | 自动化（unit，同探针渲染路径） | 探针调用渲染输出，**逐行断言**：① 主 `↑/↓ or j/k` 行存在；② `→ / > / l` 行存在；③ "In select" 行含 `j/k`；④ "In peek" 行含 `↑↓/j/k` 与 `→/l attach`；⑤ "In session" 行含 `j/k` 滚动；⑥ "In evidence" 行含 `j/k` 滚动与 `→/l attach`；⑦ NORMAL hint 含 `→/l attach`；⑧ SELECT hint 含 `j/k`；⑨ 负向：无 j/k 的旧 `↑↓` 措辞在主行与 In peek/In session/In evidence 行均不再出现 | 逐行断言全过（不用子串级 `含 l 字样`，防单行遗漏被其它行掩护；①-⑧ 覆盖 §4.1 全部变更点含 D5 欠账项） |
| A9 | 负向契约：select/session **不**绑 `l`（D4） | 自动化（unit，同探针） | select 模式 `handleInput("l")` 后断言 mode 仍为 select 且 fake `done` 零调用；session 模式同理 | 两模式按 `l` 均无副作用（不 attach、不切模式、input 不增长） |
| A8 | 全量门槛 | 自动化（build/test） | `npm run verify` | typecheck + perf gate + 全测试 + coverage 阈值（lines 85/funcs 80/branches 70）+ pack:dry 全过 |
| U1 | 真实面板手感 | 用户实测 | 部署前置：① `pi list` 记录当前安装源标识（本机维护者环境为 git 源 `git:github.com/zhuxixi/pi-agent-board`，其它环境可能是 npm 源）② `pi remove <该源标识>`（命令出处：pi docs cli.md `pi remove <source>`，源标识与安装时同形；避免原源与 worktree 双 identity 并存）③ `pi install <worktree 绝对路径>` → `pi /agent-board`；步骤：① list 按 `j`/`k` 走行含两端环绕 ② 按 `j` 不再弹 INSERT toast ③ `l` attach 选中会话 ④ detach 后 `?` 帮助显示新绑定（含 evidence 行的 `l`） ⑤ `i` 进 INSERT 后 `j`/`k`/`l` 仍是字面字符 | 五项全部符合预期；验完 `pi remove <worktree 路径>` 并按 ① 记录的原源 `pi install <原源标识>` 恢复 |
| U2 | README 四表与行为一致 | 用户实测 | 对照 README 四个表格逐行核对实际行为 | 表格无遗漏、无虚构 |

## 7. 可测性拆分设计（必答）

**不新增函数、不改现有拆分**。各 handler 已是独立方法；本次每个 handler 只加 1–2 个早返分支，复用现有纯路径：`moveSelection`（:266）、`peekStep`（:1163）、`attachSelected`（:1174）、`attachPeek`（:1180）。副作用本就隔离在这四个方法 + `done` 回调 + `input` buffer 内，本次改动不引入新耦合。

**测试边界**：`DashboardComponent.handleInput()` 公开入口。观测点：

- `selectedId` / `peekId` / `sessionScrollTop` / `evidenceScrollTop` / `input` —— 白盒读（TS-private 运行时可访问，`navigation-wrap.ts` 已有先例）；
- attach 意图 —— 构造器第 4 参 `done` 注入 fake 捕获（先例：`test-support/dashboard-prewarm-smoke.ts` 第 42 行 `(r) => doneCapture?.push(r)` 与第 82-92 行断言 `done[0].stopFirst === false`；`done` 为第 4 参见 dashboard.ts:164，`DashboardResult` 含 `{action:"attach"; viewId; stopFirst}` 见 :58）。

**探针形态**：新建 `test-support/vim-keys-wrap.ts`（`node --experimental-transform-types` 运行，tsconfig 排除 test-support，与既有探针一致），fixture 用 `createService` + `mkdtemp` 三行 view（navigation-wrap 模式），`handleInput` 直调。一个探针覆盖 A1–A7 的全部按键序列，输出 JSON 供 `test/dashboard-vim-keys.test.mjs` 断言。

**触发时序约束（A4）**：`requestAttach` 内 `planDashboardAttach` 对 busy row 走 confirm 分支（进 `pending` 而非 `done`）。探针 fixture 固定使用 `idle/exited` 非 busy row，测直接 attach 路径；confirm 分支的 `pending` 机制由既有测试（如 `dashboard-delete-key.test.mjs`）覆盖，不在本 issue 重复。

**D3 死代码清理**：零行为变化，不单设验收项，由 A1–A8 回归兜底。

## 8. 保证边界

- 只保证 `j`/`k` 与 `↑`/`↓` 行为**完全一致**（含环绕）；不承诺 vim 语义里的 clamp。
- 只保证 list/select/peek 三模式新增导航、`l` 在 list/peek/evidence 三模式 attach；其它模式零变更。
- 文案同步覆盖 §4 五处；不保证仓内其它文档（如 demo 视频、外部博客）同步。
- U1 的部署前置（先 remove git 源再 install 本地路径）若被跳过，可能加载到旧代码，验收结论无效。
