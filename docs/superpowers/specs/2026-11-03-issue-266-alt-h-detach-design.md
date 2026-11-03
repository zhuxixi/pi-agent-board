# spec — issue #266：attach 视图新增 `Alt+H` 无条件 detach 和弦

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-03T23:12:30+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-03T23:24:24+08:00 — cross-review R1（真缺口 0 / 细化 4）：R1-D1 接受（§9「落后 main」→「与 origin/main 同提交 1e22425，但不会自动获得 worktree 改动」）；R1-D2 接受（D5 改「2 处屏内提示」；§3.3 行号改 confirmArmed :571-573 与底部分隔线 :576）；R1-D3 接受（A7 由 rg 改 grep -n，BRE 下 `+` 按字面）；R1-D4 接受（§1 alt 绑定枚举补 alt+f/alt+delete）

基线：`origin/main @ 1e22425`（本地 `revert/261-attach-ready @ 51c98e9` 与之树相同，行号已在该树上核对）。调研留档：`research/01-detach-chords-and-key-space.md`；issue 评论 R1（键位空间）/ R2（编码与误触）。

## 1. 背景与问题

vim 用户的 `h` 就是「左」。attach 视图现在离开会话要么 `Ctrl+←`（要离开 home row 去摸方向键），要么 `Ctrl+\`（0x1c 在 AltGr 布局上打不出来）。诉求：`Alt+H` 直接 detach。

两条硬约束决定了键位只能是 `Alt+H` 而不是裸 `h`：

- attach 是裸 PTY 透传，**裸字母必须原样进子 Pi 编辑器**（JFox 永久笔记「attach 视图的快捷键空间」），绑 `h` 会废掉打字。
- `Alt+H` 是修饰键组合，不占打字的 `h`；它抢的是子 Pi 的 `alt+h` 绑定，而 `pi-tui` / `pi-coding-agent` 两棵 dist 树 grep `alt\+h` 均无匹配（`pi-tui` 的 alt 组合为 `alt+left/right/b/f/d/delete/y/backspace` 与 `ctrl+alt+]`；`pi-coding-agent` 的 alt+<字母> 也不含 `h`）。没有可观测的子 Pi 功能损失。

## 2. 设计决策表

| # | 决策 | 依据 |
|---|---|---|
| D1 | `Alt+H` 加入**无条件 detach** 集合，与 `Ctrl+←`（#89）/ `Ctrl+\`（#126）完全同语义：不读 `editor_state`、不读连接状态 | 和弦是明确的退出意图；与裸 `←` 的「读 `editorEmpty` 门控」是两条不同的路 |
| D2 | 抽出纯函数 `resolveAttachDetachChord(data)` 到新模块 `src/core/attach-detach.mjs`，替换 `src/ui/pty-attach.ts:434-455` 的两处内联分支；**匹配式与今天逐字一致**（`"ctrl+\\"`、`Key.ctrl("left")`）后追加 `Key.alt("h")` | 与 `src/core/attach-delete.mjs` 同构（纯 resolver + 单测）；#126/#89 的成因注释随逻辑迁入模块 docblock，pty-attach 保留一行指路 |
| D3 | 不绑裸 `h`、不绑 `Alt+←`、不要求 `Alt+Shift+H` 生效；不碰 board 键位 | 裸 `h` 必须透传；`Alt+←` 无诉求；board 的 `h` = Hold（#151/#254）在另一个面，本 issue 不动 |
| D4 | 删除确认态（#147）语义保持：`Alt+H` 先被 `resolveAttachDeleteKey` 判 `cancel`，随后落进 detach 分支 —— 取消确认并 detach，**不** archive | 与今天 `Ctrl+←` / `Ctrl+\` 在同一状态下的行为逐字相同 |
| D5 | 同步 **2 处**屏内提示（header :575、loading :591）+ README 两段 detach 说明 | 键盘手势没有入口即不存在（#245/#252 的文档欠账教训） |
| D6 | 不做可配置化（无 env / settings 键位） | 先验证真实使用；配置化是独立决策 |
| D7 | 终端前提只文档化、不加代码兜底 | macOS Option 非 Meta、GNOME Terminal 的 `_Help` 助记符占 Alt+H —— 与既有 alt 绑定同源，不是本 issue 引入 |
| D8 | ESC 前缀歧义与粘贴误触：**不改行为**，用测试锁住「不误触」 | `splitAttachInput` 实测把 `\x1bh` 保留为单段、bracketed paste 整段不匹配；只有 Esc 与 h 落在同一次 read 才合并 |

## 3. 代码落点（main @ 1e22425）

### 3.1 新文件 `src/core/attach-detach.mjs`

```js
import { Key, matchesKey } from "@earendil-works/pi-tui";

/**
 * Issue #266: the attach view's unconditional detach chords. Pure — no
 * component state, no socket, no editor cache: a chord is exit intent or it is
 * forwarded. Callers must run the #147 delete-confirm resolver first, so an
 * armed confirm still cancels before the chord closes the surface.
 *
 * - `ctrl+\` (raw 0x1c) — the terminal-independent escape (#126).
 * - `ctrl+left` — unambiguous intent while a draft is in the editor (#89).
 * - `alt+h` — vim's h is "left"; bare `h` must keep reaching the child (#266).
 * @param {string} data one key segment from splitAttachInput
 * @returns {boolean}
 */
export function resolveAttachDetachChord(data) {
	return (
		matchesKey(data, "ctrl+\\") ||
		matchesKey(data, Key.ctrl("left")) ||
		matchesKey(data, Key.alt("h"))
	);
}
```

### 3.2 `src/ui/pty-attach.ts`

- 顶部 import 增加 `resolveAttachDetachChord`（`../core/attach-detach.mjs`）；`matchesKey` / `Key` 仍被分页键等使用，import 不删。
- 用**一个**分支替换 `:434-445`（`ctrl+\`）与 `:446-455`（`ctrl+left`）：

```ts
if (resolveAttachDetachChord(data)) {
	// Issue #266: unconditional detach chords — Ctrl+\ (raw 0x1c, #126),
	// Ctrl+← (#89) and Alt+H (vim h = left). Bare ← stays gated on the pushed
	// editor_state; a chord needs no gate. Rationale lives in
	// src/core/attach-detach.mjs.
	this.detach();
	return;
}
```

- 位置约束：必须仍在 `resolveAttachDeleteKey` 分支（:384-405）之后、`Key.left` 分支（:456）之前，保证 D4 与「和弦优先于门控」两条顺序性质。

### 3.3 屏内提示

- `:575` header：`${this.status} · opens links · drag selects+copies · Ctrl+←/Ctrl+\\/Alt+H detach`
- `:591` loading：`Ctrl+←/Ctrl+\\/Alt+H to detach`
- `confirmArmed` 顶栏（:571-573）与底部分隔线（:576）不变。

## 4. 可测性拆分设计（必答）

### 4.1 纯函数层（新增，无副作用）

| 单元 | 形态 | 测法 |
|---|---|---|
| `resolveAttachDetachChord(data)` | 纯函数，输入一段 raw key 字符串，输出 boolean | `test/attach-detach-chord.test.mjs`：3 个和弦 × 3 种真实编码的正向矩阵 + 负向矩阵（裸 `h`、`\x1bH`、`\x18`、`\x1b[104;7u`、普通文本、单独 `\x1b`） |
| 粘贴边界 | `splitAttachInput` 与 resolver 的组合（两个纯函数，不构造组件） | 同文件：bracketed paste 段仍为单段且 resolver 返回 false |

实测编码矩阵（pi-tui 1.1.0，本次调研已跑通）：

| 和弦 | raw / legacy（xterm） | kitty CSI-u | modifyOtherKeys |
|---|---|---|---|
| `ctrl+\` | `\x1c` | `\x1b[92;5u` | `\x1b[27;5;92~` |
| `ctrl+left` | `\x1b[1;5D`（SS3 变体 `\x1bOd`） | `\x1b[57417;5u` | 与 raw 列同形 `\x1b[1;5D`（方向键没有 `~` 形式；`\x1b[27;5;100~` 实测**不**命中） |
| `alt+h` | `\x1bh` | `\x1b[104;3u` | `\x1b[27;3;104~` |

补充实测：`alt+h` 的 kitty 变体 `\x1b[104:104;3u`、带事件类型的 `\x1b[104;3:1u` / `:2u` / `:3u` 都命中；唯一不命中的是带 text codepoint 的第三参 `\x1b[104;3;104u` —— pi-tui 推的是 flags `1|2|4`（不含 report text，`terminal.js:185-200`），真实终端不会发这一形。

### 4.2 组件层（沿用现有探针，不新建组件）

`test-support/detach-gate-smoke.ts` 追加 `R1..R7` 场景，`test/pty-attach-detach-gate.test.mjs` 断言。触发时序固定（`handleKeyInput` 顺序）：删除确认 resolver → detach 和弦 → 裸 `←` 门控，新分支夹在中间，`R5` 专门钉这条顺序。

| 场景 | 构造 | 断言 |
|---|---|---|
| R1 | 推送 `editor_state{empty:false}` + 连上 | `alt+h` 一次 detach 包 |
| R2 | `editor_state{empty:true}` + 连上 | 同上 |
| R3 | 不推送 `editor_state` + 连上 | 同上 |
| R4 | 断连 | 无 `input` 包、surface 结束 |
| R5 | `ctrl+x` 布防后 `alt+h` | `confirmArmed` 复位、无 `y` 输入、结果 `detached` 而非 `delete` |
| R6 | `h`、`\x1bH`、`abc` | 各自转发为 `input`，无 detach |
| R7 | 渲染 header + loading（首帧前） | 两处字符串都含 `Alt+H` |

### 4.3 测试边界

纯函数层锁「哪些字节算和弦」，组件层锁「算和弦时做什么、不算时透传什么」。两层不互相替代：R 场景不重复编码矩阵，A1 不构造 socket/TUI。

## 5. 文案同步

| 位置 | 现状 | 目标 |
|---|---|---|
| `src/ui/pty-attach.ts:575` | `... drag selects+copies · Ctrl+←/Ctrl+\\ detach` | `... · Ctrl+←/Ctrl+\\/Alt+H detach` |
| `src/ui/pty-attach.ts:591` | `Ctrl+←/Ctrl+\\ to detach` | `Ctrl+←/Ctrl+\\/Alt+H to detach` |
| `README.md:96` | `Ctrl+Left` / `Ctrl+\` 两段 detach 叙述 | 追加「或 `Alt+H`（vim 的 h = 左；需终端把 Alt 作 Meta 发送）」+ 两个终端前提 |
| `README.md:219` | 同上 | 同上 |

README 具体补写要点：`Alt+H` 与 `Ctrl+Left` 同为无条件 detach；前提是终端把 Alt 作为 Meta 发出（macOS Terminal.app / iTerm2 需勾 “Use Option as Meta key”；GNOME Terminal 的 `_Help` 菜单助记符默认占 Alt+H）；attach 期间子 Pi 的 `alt+h` 被捕获（当前无绑定）。

## 6. 非目标

- 不绑裸 `h`、`Alt+←`、`Alt+Shift+H`；不补全 hjkl。
- 不动 board（list/select/peek/session/evidence）任何键位，尤其 `h` = Hold。
- 不做键位可配置化。
- 不改 `Ctrl+\` 的 AltGr / legacy `Ctrl+4` 说明，不引入新的无条件兜底键。
- 不处理 macOS / GNOME 的终端级键位拦截（只文档化）。

## 7. 保证边界

- 终端根本不发 `Alt+H`（macOS 默认 Option 行为）时本改动无能为力 —— 已有 `Ctrl+←` / `Ctrl+\` 仍是兜底。
- 同一次 read 内「Esc 然后 h」会被识别为 `Alt+H`。这是 ESC 前缀编码的固有歧义，`matchesKey` 对所有 alt 组合一律如此；分两次 read 到达时不会合并。
- 不覆盖带 text codepoint 的 kitty 第三参编码（`\x1b[104;3;104u`）：pi-tui 不请求该 flag，真实终端不会发；若未来现场观测到，另开 issue。
- attach 期间子 Pi 收不到 `alt+h`；当前无该绑定，属记录性约束。

## 8. 验收矩阵（必答）

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 和弦识别（编码矩阵） | 自动化（unit） | `node --test test/attach-detach-chord.test.mjs` | §4.1 矩阵的 9 个正向用例全 true（另加 `\x1bOd` 与 kitty 事件类型变体）；负向（`h`、`\x1bH`、`\x18`、`\x1b[104;7u`、`abc`、`\x1b`、`\x1b[104;3;104u`）全 false |
| A2 | `Alt+H` 四象限 detach | 自动化（integration） | `node --test test/pty-attach-detach-gate.test.mjs`（R1–R4） | 每个场景 `didDetach=true`、`sent.length===1`、`type==="detach"`；断连象限无 `input` 包 |
| A3 | 删除确认态顺序 | 自动化（integration） | 同上（R5） | `confirmArmed` 变 false、无 `y` 输入、结果 `{action:"detached"}` |
| A4 | 粘贴不误触 | 自动化（unit） | A1 同文件 | bracketed paste 段 `splitAttachInput` 仍单段，`resolveAttachDetachChord` 为 false |
| A5 | 非和弦键仍透传 | 自动化（integration） | 同上（R6） | `h` / `\x1bH` / `abc` 各产生 1 个 `input` 包且无 detach |
| A6 | 屏内提示 | 自动化（integration） | 同上（R7） | header 与 loading 渲染结果都含 `Alt+H` |
| A7 | README 同步 | 自动化（static） | `grep -n 'Alt+H' README.md` + `grep -n 'Option as Meta' README.md`（BRE，`+` 按字面） | `Alt+H` ≥2 处（:96 与 :219 两段各一）；`Option as Meta` ≥1 处 |
| A8 | 全仓回归 | 自动化（build + 全仓测试） | `npm run verify` | typecheck / perf gate / 全仓测试 / coverage 阈值 / `pack:dry` 全绿 |
| U1 | 真机 WezTerm 行为 | 用户实测 | 见 §9 | 4 步观察全符合 |

## 9. U1 用户实测（部署前置 + 步骤）

**部署前置（必须，否则跑到旧代码上）**：用户 pi 的 agent-board 来自安装副本 `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board`（0.13.1；复核时 HEAD 与 `origin/main` 同为 `1e22425`，但安装副本不会自动获得 worktree 改动）。用显式扩展加载绕过安装副本：

```bash
WT=/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-266-alt-h-detach
pi -ne -e "$WT/src/index.ts"
```

`-ne` 关掉扩展发现（避免安装副本与 worktree 副本双加载），`-e` 显式加载 worktree 的扩展入口。

**步骤**（在 WezTerm 里跑）：

1. 在 board 里 dispatch 或选一个会话 attach；按 `Alt+H` → 应回到 board，且不中断子会话（重新 attach 后历史仍在）。
2. attach 后先在子会话输入框打几个字（造 draft），再按 `Alt+H` → 仍应立即回到 board（区别于裸 `←` 会转发）。
3. 重新 attach，按 `Ctrl+X` 进入删除确认（顶栏出现 `Delete "…"?`），再按 `Alt+H` → 应取消确认并回到 board，该行**未被归档**。
4. 重新 attach，按 `Alt+Shift+H` → 应作为普通输入进入子会话（**不** detach）。

**通过标准**：4 步观察全符合；任何一步不符合即为 U1 失败，先修再合。

**可执行时机**：步 9 开 PR 后、合并前（用 PR 分支的 worktree 跑）。

## 10. 风险与回滚

- 风险：误吞 `Alt+H`（若某子 Pi 版本或扩展绑定了它）。缓解：A1 负向矩阵（只认精确编码）+ D7 文档化「attach 期间子 Pi 的 alt+h 被捕获」。
- 风险：hint 变长被 `clip` 截断。缓解：header 已在窄屏截断，新串只多 7 列；A6 只断言存在子串，不锁整行。
- 回滚：单个 commit 反转（`git revert`），无数据/协议影响 —— 不新增包、不改 attach 协议。
