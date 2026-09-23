# Plan: 终端无关的无条件 detach 逃生键 Ctrl+\（issue #126）

Spec: docs/superpowers/specs/2026-09-23-unconditional-detach-key-design.md（首个 commit 69eb7d6，含验收矩阵与可测性拆分）。

## Verified ground truth (do not re-litigate)

- `matchesKey` 对三种编码全部原生匹配（spec review 实测）：裸 `\x1c`、kitty `\x1b[92;5u`、modifyOtherKeys `\x1b[27;5;92~`。键名字符串 `"ctrl+\\"`（JS 源码双反斜杠）。
- pi 本体 dist / 本仓 src·runner·test 无 `ctrl+\` 占用。
- 集成点：`src/ui/pty-attach.ts` handleInput 的 `Key.ctrl("left")` 分支（当前 :290）**之前**插新分支；header（:343 附近 `"Ctrl+← detach"`）与 loading banner（:359 附近 `"Ctrl+← to detach"`）文案更新。
- smoke harness：`test-support/detach-gate-smoke.ts` 现有场景驱动真组件；`connected=true` 显式模式；Ctrl+← 场景为 L/M/N（对照模板）。
- README 按键段两处（:96 与 :195 附近），Phase 6 已改为 D1 契约文案，本次在其上补无条件键 + 已知代价（键盘布局限制、Ctrl+4 legacy 别名、child 抢键面）。
- 全量测试命令是 `node --test test/*.test.mjs`（目录形式会异常失败）；CI 会跑同款。

## Tasks

### Task 1: Ctrl+\ 分支 + 四象限/三编码 smoke 场景（TDD）— covers A1, A2, A3

**Files:**
- Modify: `src/ui/pty-attach.ts`（handleInput 新分支）
- Modify: `test-support/detach-gate-smoke.ts`（新增场景）
- Modify: `test/pty-attach-detach-gate.test.mjs`（新断言接线）

**Steps:**
1. Red：smoke 新增场景组——四象限（editorEmpty=true/false/null × connected=true）+ disconnected 一条；每象限注入裸 `\x1c`，断言 `didDetach()` 为真（A1/A2）。另加编码形态场景：`\x1b[92;5u`（kitty）与 `\x1b[27;5;92~`（modifyOtherKeys）各一条 detach 断言；冲突隔离：`\x1b[1;5D` 仍 detach、`\x1b[D` 按 D1 门禁、可打印键 `q` 转发、`ctrl+]` 透传（A3）。先跑确认新场景红。
2. Green：handleInput 在 `Key.ctrl("left")` 分支**之前**插入：

```ts
		if (matchesKey(data, "ctrl+\\")) {
			// Unconditional, terminal-independent escape (issue #126): 0x1c is a
			// single raw ASCII byte every terminal forwards unchanged in raw
			// mode — no modifier-encoding dependency like Ctrl+Left (macOS
			// Terminal.app never emits it, WezTerm consumes it for tab
			// switching). Only caveat (documented in README): layouts where
			// `\` sits on AltGr may never produce this byte; the escape ladder
			// still covers those. matchesKey also covers the kitty CSI-u and
			// modifyOtherKeys encodings of the same chord.
			this.detach();
			return;
		}
```

3. 定向测试全绿：`node --test test/pty-attach-detach-gate.test.mjs`。

### Task 2: 文案与 README 同步 — covers A4

**Files:**
- Modify: `src/ui/pty-attach.ts`（header + loading banner）
- Modify: `test/pty-attach-detach-gate.test.mjs`（header 断言扩到 Ctrl+\）
- Modify: `README.md`（两处按键段）

**Steps:**
1. header：`Ctrl+← detach` → `Ctrl+←/Ctrl+\\ detach`（注意渲染字符串里的反斜杠转义）；loading banner 同步。detach-gate 测试的 header 断言补 Ctrl+\ 出现（沿用 `headerMentions*` 模式）。
2. README 两处按键段：补「`Ctrl+\` 是无条件退出键（终端无关）」+ 已知代价三条（键盘布局 AltGr 限制、Ctrl+4 legacy 别名、child 抢键面 = child 内 vim terminal-mode Ctrl+\ 前缀）。
3. 定向测试绿；全量 `node --test test/*.test.mjs` + `npm run typecheck`。

## Review discipline

每 task 完成派 reviewer；final whole-branch review 后 PR；Zima CR 收敛后 merge。验收逐项对账（spec 矩阵）：A1-A4 自动化记录命令与结果；U1 mac 实测标 pending；U1b 列给用户执行。
