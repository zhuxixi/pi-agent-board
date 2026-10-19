Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-19T12:40:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-19T13:05:00+08:00 — 第 1 轮复核处置（R1-G1/G2/G3 + D1/D2/D3）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-19T13:15:00+08:00 — 第 2 轮复核处置（R2-G1 + D1/D2/D3）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-19T13:25:00+08:00 — 第 3 轮复核处置（收敛轮，R3-D1/D2/D3 细化）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-19T14:20:00+08:00 — 代码评审批次修复（A8③ 空转 grep、REPLY_HEADS 注释未改、armed 路径未覆盖）

# issue #213 根因报告与修复设计：reply guard 的 cell-size 前缀吞掉 kitty 编码的 PageDown

仓库：zhuxixi/pi-agent-board · 基线：`origin/main` @ `ef4317f`

## 1. 症状

`v0.12.0` + WezTerm 20240203 + pi fullscreen 1.3.0 → `/agent-board` → attach：

| 键 | 结果 |
| --- | --- |
| `PageUp` | 正常（本地滚动 / 转发） |
| `PageDown` | **完全无反应** |
| 鼠标滚轮 | 正常 |

不对称本身就是线索：两个键在 `handleKeyInput` 里走**完全相同**的
`tryScrollBy(±pageSize)` → `send()` 兜底，所以差异只能出在更上游的输入分类层。

## 2. 根因

`src/core/terminal-reply-guard.mjs` 的 `REPLY_HEADS` 含：

```js
{ family: "cell-size", prefix: "\x1b[6;" }
```

本意是吸收被拆碎的 XTWINOPS cell-size 回复（`CSI 6;<rows>;<cols>t`）。
但 **PageDown 的 legacy 功能键编号正是 6**：kitty 键盘协议下带修饰键的 PageDown 编码为
`CSI 6;<mod>u`（`\x1b[6;1u`），modifyOtherKeys 回退下为 `CSI 6;<mod>~`（`\x1b[6;5~`）。
两者都以 `\x1b[6;` 开头 → `classifyReplyEvent` 判成 `reply-head` → guard 进入 armed
→ 250ms/64 字节吸收窗口把按键吞掉。PageUp 的编号是 5（`\x1b[5;1u`），永不命中，所以不受影响。

附带发现的**文档与代码矛盾**：`REPLY_HEADS` 上方的注释写着
「Deliberately absent: … `\x1b[5`/`\x1b[6` (PageUp/PageDown heads)」，
但列表里实际存在 `\x1b[6;` —— 注释想表达的是"不吸收 `\x1b[6` 开头的裸键位"，
实现却用了一个更宽的前缀，正是这条矛盾掩盖了本次冲突。

引入点：`2148360 fix(attach): stop terminal reply fragments leaking into the attached child's input (#194)`。

## 3. 证据（对仓库当前代码实测）

```
"\x1b[6;1u"     → { kind: "reply-head", family: "cell-size" }   ❌ PageDown 被吞
"\x1b[6;5~"     → { kind: "reply-head", family: "cell-size" }   ❌ modifyOtherKeys PageDown 被吞
"\x1b[5;1u"     → { kind: "other" }                             ✓ PageUp
"\x1b[6~"       → { kind: "other" }                             ✓ 无修饰的 legacy PageDown
"\x1b[57422u"   → { kind: "other" }                             ✓ kitty codepoint 形式
"\x1b[6;"       → { kind: "reply-head", family: "cell-size" }   ✓ 真 fragment 仍 arm
"\x1b[6;24"     → { kind: "reply-head", family: "cell-size" }   ✓
"\x1b[6;24;80t" → { kind: "reply-complete", action: "drop" }    ✓
```

现有测试（15 个 `test()` / 63 条 assert，全绿）**没有覆盖** `\x1b[6;<mod>u` / `\x1b[6;<mod>~` 形态 —— 这是回归缺口。
`test/terminal-reply-guard.test.mjs:58` 只测了裸 `\x1b[5~` / `\x1b[6~`，
`:96` 测了 `\x1b[6;` 仍需 arm。

## 4. 修复

**在 head 前缀之前**识别"完整的 CSI 键序列"：真 cell-size fragment 没有 `u`/`~` 终结符，
所以完整键序列可以安全地判成用户输入。

```js
// Kitty / modifyOtherKeys keys: `CSI <num>[;<mod>…]{u,~}`. PageDown's legacy number
// is 6, which shares the `\x1b[6;` prefix with the cell-size reply head.
const CSI_KEY_SEQUENCE = /^\x1b\[\d+(?:[;:]\d+)*[u~]$/;

export function classifyReplyEvent(data) {
    …DROP/FORWARD 判定不变…
    // A COMPLETE CSI key is user input, never a reply fragment.
    if (CSI_KEY_SEQUENCE.test(data)) return { kind: "other" };
    for (const head of REPLY_HEADS) { … }
    …
}
```

**正则比 issue 原文更宽一点**：issue 给的 `/^\x1b\[\d+(?:;\d+)?(?::\d+)?[u~]$/` 覆盖不了
kitty 的"交替键"编码 `\x1b[6;1:2;65u`（`;65` 在主修饰符之后），会重新落回 reply-head。
`(?:[;:]\d+)*` 覆盖全部 `CSI <num>;[<mod>[:<event>][;<alternate>]]u` 形态。

保持不变的行为：

- `\x1b[6;`、`\x1b[6;24`（无终结符）→ 仍然 `reply-head`（arm）
- `\x1b[6;24;80t` → 仍然 `reply-complete` drop（DROP_SHAPES 命中在前）
- 其余 `REPLY_HEADS`（`\x1b[?`、`\x1b[>`、`\x1bP`、`\x1b]1`、`\x1b]4`）无键位冲突，不动

顺带修掉 `REPLY_HEADS` 上方与新语义矛盾的注释（说明 `\x1b[6;` 只能靠"完整键序列优先"来消解冲突）。

### 4.1 推翻既有设计文档的 pinned 不变式（R1-G3）

`docs/superpowers/specs/2026-10-14-issue-170-attach-reply-guard-design.md:106` 钉死了：

> 窗口只由 `reply-head` 武装，只有「**永不可能是按键/鼠标编码前缀**」的形状才武装：
> `ESC[?`、`ESC[>`、**`ESC[6;`**、`ESC P`、`ESC]1`、`ESC]4`。

本次根因正是这条论断的反例：kitty 功能键编号形态 `ESC[6;1u`（PageDown）打破「永不可能是按键前缀」。
因此本修复**显式推翻**该不变式，替换为：

> 完整 CSI 键序列（`CSI <num>[;<mod>[:<event>][;<alt>]]{u,~}`）优先于 head 前缀判定；
> 只有**不带** `u`/`~` 终结符的片段才按 head 武装。

同步要求（实现阶段必做）：

- **改掉 `REPLY_HEADS` 上方那段与新语义矛盾的注释**（源码 :76-79，「can never be a key/mouse/paste
  encoding」「Deliberately absent: … `[5`/`[6`（PageUp/PageDown heads）」）：不得再出现
  绝对断言，改为说明「完整键序列优先，只有不带终结符的片段才武装」。
  模块 header 用**英文**写同一条规则（`complete CSI key sequence … beats the head prefixes`），
  中文仅在 #170 文档里作为跨引用出现。
- 在 #170 设计文档 §3.3 的「设计要点」清单里补上「完整 CSI 键序列优先于 head 前缀」这一新类别，
  并把 L106 的论断标注为已被 #213 修正（追加而非改写历史）
- #170 文档 L112 与 A4 清单里「`ESC[6;` 必须武装」仍然成立（本修复只对**完整**键序列例外）

## 5. 边界与风险

| 风险 | 说明 / 缓解 |
| --- | --- |
| 真 cell-size 回复被误判成键 | 不可能：cell-size 以 `t` 结尾，不带 `u`/`~` |
| kitty 其他功能键（`\x1b[5;1u` 等） | 本就未被 head 命中，行为不变 |
| modifyOtherKeys 其他键（`\x1b[3;5~`） | 不命中 `\x1b[6;`，行为不变 |
| 极少数终端把 PageDown 编码成 `\x1b[6;`（截断） | 仍会 arm 并吞掉；这是 issue #170 的保护方向，保留 |
| 安全方向 | 修复只是让**用户按键**更早地判定为非回复；不会让回复碎片更容易漏进子会话 |

## 6. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | kitty/modifyOtherKeys PageDown 判为键 | 自动化（unit） | `test/terminal-reply-guard.test.mjs`：`\x1b[6;1u`、`\x1b[6;5u`、`\x1b[6;1:2u`、`\x1b[6;1:2;65u`、`\x1b[6;5~` | 全部 `{ kind: "other" }` |
| A2 | PageUp 与其他键不受影响 | 自动化（unit） | 同文件：`\x1b[5;1u`、`\x1b[5;5~`、`\x1b[57422u`、`\x1b[57421u`、`\x1b[3;5~` | 全部 `{ kind: "other" }` |
| A3 | 真 cell-size fragment 仍 arm | 自动化（unit） | 同文件：`\x1b[6;`、`\x1b[6;24` | 均 `{ kind: "reply-head", family: "cell-size" }` |
| A4 | 完整 cell-size 回复仍 drop | 自动化（unit） | 同文件：`\x1b[6;24;80t` | `{ kind: "reply-complete", family: "cell-size", action: "drop" }` |
| A5 | guard 状态机不回归 | 自动化（unit） | 现有 `terminal-reply-guard` 全部用例 | 全绿 |
| A6 | attach 按键真的转发到子会话（不被 guard 吞） | 自动化（integration） | `test-support/attach-reply-guard-smoke.ts` 新增：`handleInput("[6;1u")` / `handleInput("[6;5~")` 后 `sent` 含该字节；断言归 `test/pty-attach-reply-guard.test.mjs` | `sent` 收到完整键序列；且随后的普通文本仍正常转发 |
| A7 | 语法/静态检查 | 自动化（static） | `npm run typecheck`（`tsconfig` 对 `.mjs` 是 `allowJs` + `checkJs:false`，只做语法解析）+ `npm run pack:dry` | 均通过 |
| A8 | §4.1 的文档同步真的落地 | 自动化（static） | 三条独立 grep，全部锚定**英文** marker（源码是英文注释，中文只出现在 #170 文档）：① `grep -c "complete CSI key" src/core/terminal-reply-guard.mjs`（≥1，且位于模块顶部注释区）；② `grep -n "完整 CSI 键序列优先.*#213" docs/superpowers/specs/2026-10-14-issue-170-attach-reply-guard-design.md`（≥1）；③ `grep -c "can never be a key" src/core/terminal-reply-guard.mjs`（**必须为 0** —— 旧的绝对断言已删除） | ①② ≥1、③ ==0 |
| U1 | 真实终端 PageDown | 用户实测 | 见 §6.1 三步前置 + WezTerm + pi fullscreen → attach → 按 PageDown | 面板按页向后滚动（或转发给子会话），与 PageUp 对称 |

### 6.1 U1 执行时机与部署前置

仓库加载补丁 checkout 的方式见 `README.md:54`（`pi install "$(pwd)"`）或 `README.md:68`（symlink 到
`~/.pi/agent/extensions/agent-board`）。U1 必须在以下三步之后执行，否则测的是旧代码：

1. 用上述任一方式把**当前 worktree/checkout** 加载到 pi（不是 `~/.pi/agent/git/...` 的缓存克隆）
2. 完整重启 pi（模块缓存不会热更新），并新开一个 attach 会话
3. 时机：本地 `npm run typecheck` + 目标套件全绿之后、合并之前

> **验收 ID 作用域**：#213 的 `A1–A8` 仅指本 issue。新增测试名一律带 `#213-` 前缀
> （如 `test("#213-A1: kitty PageDown is a key, not a reply head")`），
> 因为 `test/terminal-reply-guard.test.mjs` 里已有 #170 遗留的 `A1:`/`A2:`/… 测试名，
> 直接用 `--test-name-pattern="A1"` 会同时命中两套语义不同的用例。

## 7. 可测性拆分设计

- **判定逻辑已经是纯函数**（`classifyReplyEvent`），零改动地单测；本次只新增一个正则常量。
- 测试边界：`test/terminal-reply-guard.test.mjs` 覆盖 A1–A5（纯函数层）；`test-support/attach-reply-guard-smoke.ts` + `test/pty-attach-reply-guard.test.mjs` 覆盖 A6（真实 `PtyAttachComponent.handleInput` → `sent` 转发，只替换 socket）。`test/pty-scroll.test.mjs` 与本次改动无关，不作为护栏。
- 正则常量导出与否：**不导出**（内部实现细节），测试通过 `classifyReplyEvent` 的公开行为验证，避免把实现形状钉进测试。

## 8. 非目标

- 不改变 guard 的吸收窗口（250ms / 64 字节）与 kill switch 语义
- 不改动其他 `REPLY_HEADS` 条目
- 不处理 `PageUp`/`PageDown` 在 legacy 路径的行为差异（本就正常）
