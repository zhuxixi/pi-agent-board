# issue #89 plan：Ctrl+← detach 和弦实现

日期：2026-09-08 · spec：docs/superpowers/specs/2026-09-08-attach-ctrl-left-detach-design.md

## 任务拆解

### T1：Ctrl+← 分支 + header 文案（A1, A2, A4）

文件：`src/ui/pty-attach.ts`

1. `handleInput` 在 `Key.left` 分支（~L247）之前插入 Ctrl+← 分支（spec D1 代码原样，含注释）。确认 `Key.ctrl` 已从 pi-tui import（文件顶部现有 `Key` import——matchesKey/Key 都在用，无需新 import）。
2. header 两处文案（~L282 `← detach`、~L298 `← to detach`）→ `←/Ctrl+← detach` / `←/Ctrl+← to detach`。

### T2：测试扩建（A1-A4）

文件：`test-support/detach-gate-smoke.ts` + `test/pty-attach-detach-gate.test.mjs`

1. harness 加场景（照现有场景范式：makeAttach + writeToTerm + handleInput 注入）：
   - **ctrlLeftDetachesOnDraft**：造一个 editor_state=draft（或写非空内容行进 buffer——看现有 `leftEditorStateBlocksDetachOnDraft` 场景怎么造 draft）→ `handleInput("\x1b[1;5D")` → didDetach() === true；
   - **ctrlLeftDetachesOnEmptyInput**：空编辑器场景（照现有 C 场景）→ 同序列 → didDetach() === true；
   - **headerMentionsCtrlLeft**：`attach.render(80)` 输出行里含 "Ctrl+←"（header 在 render 输出组装；注意 attaching 状态——renderLoading 的 L298 在 loading 时显示，L282 在正常帧。两个都改后任一断言即可，取正常帧：先 writeToTerm 一点输出让组件脱离 loading）。
2. 测试文件加 3 条断言（照现有断言风格）。

### T3：全量回归（A5）

`npm test`（基线 618）+ `npm run typecheck`。

## 验收对账
- A1/A2/A4 → T2 · A3 → 现有断言回归 · A5 → T3
- U1（用户实测，合并后）：attach 活跃 session 输入文字后 Ctrl+← 退出。
