# 解绑 attach 视图对 ctrl+g 的截获，让 ctrl+g 透传打开外部编辑器

## Context（背景与动机）

用户在 pi-agent-board 里 attach 一个 pi background session 后，按 `ctrl+g` 无法打开外部编辑器（nvim）。

**根因**：attach 视图（`PtyAttachComponent`，`src/ui/pty-attach.ts`）把 `ctrl+g`（控制字符 `\x07`）列为 detach 键——在 attach 视图里按 ctrl+g 时，若子进程输入行看起来为空（`childInputLooksEmpty()`）会直接退出 attach 回到面板，到不了 pi 的"打开外部编辑器"逻辑；即使输入行非空时能转发，ctrl+g 这个键在 attach 语境下语义也是混乱的。

用户实际退出 attach 用的是**左方向键**，不需要 ctrl+g 当 detach 键。

**目标**：让 ctrl+g 在 attach 视图里干净透传给子进程 pi，从而按 pi 默认的 `app.editor.external`（默认就是 ctrl+g）打开 nvim。退出 attach 仍可用 ← 或 ctrl+]，不受影响。

## Approach（方案）

改 pi-agent-board fork 的 attach 视图源码，从 detach 判定里**移除 ctrl+g**（保留 ctrl+] 和 ←）。这是"方案 B"——精准修在根因上，pi 保持默认 ctrl+g 开 editor，**不需要改 keybindings.json、不需要换键**。

明确不做的事：
- 不动 pi 本体、不创建 `~/.pi/agent/keybindings.json`；
- 不动光标可见性（已在上一个 commit `95e20a6` 解决，本次改动不影响它）；
- 不动 ctrl+] 和 ← 的 detach 行为。

## Files to modify

只改一个文件：`src/ui/pty-attach.ts`（fork repo `~/git-repo/github/pi-agent-board/`），两处：

1. **第 29 行**——从 detach 键集合去掉 `\x07`（ctrl+g 的控制字符）：
   ```ts
   // 改前
   const DETACH_KEYS = new Set(["\x1d", "\x07"]); // ctrl+], ctrl+g
   // 改后
   const DETACH_KEYS = new Set(["\x1d"]); // ctrl+]
   ```
2. **第 212–215 行的 detach 判断块**——删掉 `matchesKey(data, Key.ctrl("g"))` 那一行，并把它上一行 `matchesKey(data, Key.ctrl("]"))` 行尾的 `||` 去掉（否则会留下悬空的 `||` 语法错误）：
   ```ts
   // 改前
   if (
       DETACH_KEYS.has(data) ||
       matchesKey(data, Key.left) ||
       matchesKey(data, Key.ctrl("]")) ||
       matchesKey(data, Key.ctrl("g"))
   ) {
   // 改后
   if (
       DETACH_KEYS.has(data) ||
       matchesKey(data, Key.left) ||
       matchesKey(data, Key.ctrl("]"))
   ) {
   ```

> 注意：文件里其他位置的 `\x07`（第 1060/1214/1218/1228/1269 行）是 OSC52 / OSC8 序列的 BEL 终止符（如 `` `\x1b]52;c;...${data}\x07` ``），属于终端协议字节，和按键无关，**一律不动**。

## Reuse（复用现有代码）

- **无需新增任何转发逻辑**：ctrl+g 移出 detach 判断块后，会自动落到 `handleInput` 末尾现成的 `this.send({ type: "input", data })`（无条件透传分支），把 ctrl+g 原样发给子进程 pi。
- `Key.ctrl()` / `matchesKey()` / `Key.left` 等按键工具保持不变。
- pi 侧无需改动：`app.editor.external` 默认就是 ctrl+g，子进程 pi 收到 ctrl+g 即开外部编辑器。

## Steps（实施步骤）

- [ ] 1. 改 `src/ui/pty-attach.ts` 第 29 行：`new Set(["\x1d", "\x07"])` → `new Set(["\x1d"])`，同步改注释
- [ ] 2. 删第 215 行 `matchesKey(data, Key.ctrl("g"))`，并去掉第 214 行行尾的 `||`
- [ ] 3. `npm run typecheck` 通过（改动不涉及类型，预期直接通过）
- [ ] 4. `npm test` 通过（145 个测试，无针对 DETACH_KEYS 的用例，预期不破坏）
- [ ] 5. `git add src/ui/pty-attach.ts` 并提交（**只 add 这一个文件，本计划文件不提交**）：
       message: `fix(attach): stop intercepting ctrl+g so it opens the external editor in the hosted session`
- [ ] 6. `git push fork main`（`fork` 远程 = `github.com/zhuxixi/pi-agent-board.git`）
- [ ] 7. `pi update git:github.com/zhuxixi/pi-agent-board`（把 fork 最新拉到 `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board/`）
- [ ] 8. pi 里执行 `/reload` 加载新代码

## Verification（验证）

**自动化**：
- `npm run typecheck` 无错误；
- `npm test` 仍是 145 pass / 0 fail；
- `git -C ~/git-repo/github/pi-agent-board log --oneline -1` 确认新 commit 在 main 顶端；
- push 后 `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board rev-parse --short HEAD` 确认 pi 安装的 fork 已更新到新 commit（pi update 之后）；
- grep 确认安装目录的 pty-attach.ts 里 `ctrl("g")` 已从 detach 块消失、`\x07` 已从 DETACH_KEYS 消失。

**手动（核心验收）**：
- 在 pi-agent-board 里 attach 一个 background session；
- 按 `ctrl+g` → **应直接打开 nvim**（外部编辑器），不再退出 attach；
- 按 `←`（左方向键）→ 仍能正常退出 attach 回到面板；
- 按 `ctrl+]` → 仍能退出 attach（保留的另一个 detach 键）。

## Notes

- 本计划文件（`plans/attach-ctrl-g-unbind.md`）不纳入 commit，只作为审阅与执行依据；提交时只 `git add src/ui/pty-attach.ts`。
- 与"方案 A（改 keybindings.json 用 ctrl+q）"互斥：走本方案后，pi 保持默认 ctrl+g 开 editor，**不要**再创建 keybindings.json。
- 环境已确认：本地 repo working tree 干净，分支 main，HEAD `95e20a6`，remote `fork` 指向 `github.com/zhuxixi/pi-agent-board.git`。
