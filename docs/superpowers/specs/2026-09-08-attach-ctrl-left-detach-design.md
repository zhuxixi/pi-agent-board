# issue #89 spec：attach 界面 Ctrl+← detach 和弦

日期：2026-09-08 · 状态：已授权全自动推进（用户 2026-09-08 决策）

## 背景与问题

attach 界面里编辑器非空时 `←` 被判为光标左移转发给 child（#66/#68/#69 门禁链的有意行为），用户不知道要先清空输入才能 `←` 退出，被困后只能 Ctrl+C/D 强退（连带 shutdown child Pi——实录一次事故导致 host 反复冷启动 7 次）。需要一个不与编辑冲突、始终可用的退出和弦。

## 核心设计（issue 已定稿，本 spec 为落地细化）

### D1：Ctrl+← 无条件 detach
`src/ui/pty-attach.ts` `handleInput`：在 `Key.left` 分支**之前**新增：
```ts
if (matchesKey(data, Key.ctrl("left"))) {
	// Explicit detach chord (issue #89): single ← is gated on editor state
	// (it doubles as cursor-left in a non-empty draft), so a user with a draft
	// had no way out. Ctrl+← is unambiguous intent — detach unconditionally,
	// regardless of editor state or socket liveness (same guarantee as the
	// disconnected-← escape, issue #48).
	this.detach();
	return;
}
```
- 放 Key.left 分支前：确保组合键不被单键分支截获（matchesKey 语义上两者不相交，但顺序防御更稳）；
- 无条件：和弦语义 = "我要退出"，不需要门禁（门禁防的是误触，组合键无误触）；
- pi-tui Key 支持现成：keys.js L845-846 legacy（`\x1b[1;5D`）+ kitty 序列均映射 ctrl+left。

### D2：header 提示更新
- L282：`← detach` → `←/Ctrl+← detach`
- L298（renderLoading 中心提示）：`← to detach` → `←/Ctrl+← to detach`

### 否决项（issue 已论证，记录防重提）
- Esc：child 可能跑 vim/nvim，Esc 必须透传；
- 双击 ←：编辑时连按 ← 移动光标是高频操作，必误触。

## 非目标
- 不改 ← 单键门禁链任何行为（#66/#68/#69 的判定逻辑保持原样）；
- 不改其他键位；不改 detach() 本身语义。

## 可测性拆分设计

| 单元 | 性质 | 测法 |
|---|---|---|
| Ctrl+← 分支 | 组件 handleInput | 扩建现有 `test-support/detach-gate-smoke.ts` harness（fake tui + send spy + didDetach，#42/#48/#66 同款）：注入 `\x1b[1;5D` 序列 |
| 文案 | render 输出 | harness 内 render(width) 断言含 "Ctrl+←" |

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | Ctrl+← 编辑器非空（draft）时 detach | 自动化（冒烟） | `node --test test/pty-attach-detach-gate.test.mjs` | didDetach() === true（editor_state draft 场景） |
| A2 | Ctrl+← 编辑器空时 detach | 自动化（冒烟） | 同上 | didDetach() === true |
| A3 | 单次 ← 门禁链回归 | 自动化（冒烟） | 同上 | 现有 15+ 断言全绿 |
| A4 | header 文案 | 自动化（冒烟） | 同上 render 输出断言 | 含 "Ctrl+←" |
| A5 | 全量回归 | 自动化（static/build） | `npm test` + `npm run typecheck` | 618+ 全绿 |
| U1 | 真实场景 | 用户实测 | 合并后重启 pi：attach 活跃 session，输入几个字 → Ctrl+← | 立即 detach 回 dashboard，child 不受影响 |

U1 需重启 pi，合并后用户执行。
