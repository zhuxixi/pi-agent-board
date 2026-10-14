Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T12:29:14Z
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T12:48:00Z (round-1 review: R1-G1 accepted — classify the gesture in SCREEN coordinates; R1-D1 accepted — double-click path gets its own case; R1-D2 accepted — A2 gains the content-wait precondition and contains-semantics wording)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T13:05:00Z (round-2 review: R2-G1 accepted — U3 stops demanding double-click-under-drift and the boundary is documented; R2-D1 accepted — A4/A5 gain the press-created-selection precondition; R2-D2 accepted — A6 asserts an observable signal)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-14T13:22:00Z (round-3 review: converged with R3-D1 as the only detail — the raw/unclamped screen-cell semantics now have an explicit A1 case and an implementation note; the round-3 hash is the converged version plus this detail fix)

# Spec: #187 — attach(legacy): a motion-less drag must be classified by geometry, not by the move flag

Status: DRAFT (awaiting spec-cross-review, then user approval — github-issue-driven step 4 gate)
Issue: https://github.com/zhuxixi/pi-agent-board/issues/187
Repo state baseline: main @ `f81949d`
Scope: **#187 only.** #188 (X10 release parsed as press) and #189 (mixed input chunks) stay open and
untouched; the fix must not assume they are fixed.

## Problem (root cause, verified in code + reproduced at runtime)

`src/ui/pty-attach.ts` → `handleLocalMouseEvent` (legacy/regular-mode mouse path; the fullscreen path
is `handleMouse` and never reaches this handler):

```ts
// press  (:1035)  — 1-cell selection, and the drag flag is cleared
this.selection = { anchor: point, focus: point };
this.selectionDragging = false;
// move   (:1045)  — the ONLY place the drag flag is ever set
this.selectionDragging = true;
// release(:1054)  — drag inferred from the flag
const shouldCopy = this.selectionDragging;
```

The flag answers "did a motion event arrive since the press", not "did the gesture move". Warp
delivers fast drags as **press + release with zero motion events** (byte capture in the issue), so
`shouldCopy` is `false` and the release takes the plain-click path (`:1079`
`schedulePendingClick(point)`): `copySelectionToClipboard()` never runs, and the 1-cell selection is
wiped by the pending-click timer 260 ms later. That timer is the reported symptom — *"drag-select
doesn't select at all; the moment I release, the selection is gone"*.

Runtime reproduction (throwaway harness modeled on `test-support/pty-attach-mouse-scenario.ts`: real
`PtyAttachComponent` + real runner socket + fake PTY, fake TUI capturing `terminal.write`):

| Gesture (row 2 = first body row) | OSC 52 payload | `selection` after 400 ms |
|---|---|---|
| press (col 1) → release (col 16), **zero motion** | none | `null` (pending-click timer) |
| press (col 1) → move (col 8) → release (col 16) | `["fake pi ready"]` | retained |
| press (col 1) → release (col 1) (same point) | none | `null` (expected click behavior) |

### Why the decision must be taken in SCREEN coordinates, not buffer coordinates

`mousePointForEvent` (`:1088-1089`) maps a screen cell to a buffer line through the *current*
viewport base: `start = this.viewportTop ?? this.bottomViewportTop(height)`. While following the
bottom (`viewportTop === null`, the normal case) `bottomViewportTop` (`:1340-1343`) is
`max(0, min(buf.length, baseY + rows) - height)`, which **grows as the session streams new lines**
and `clampViewportTop` (`:1346-1348`) deliberately does not pin it.

So `anchor` and `focus` are buffer coordinates captured at two different times against two different
bases: on a streaming session (the primary attach use case — watching a running agent) a stationary
click maps to `focus.line > anchor.line` purely because output arrived in between. A buffer-space
comparison would therefore classify every stationary click on a live session as a drag: the single
click would stop opening links, the double-click would stop selecting words, and each click would
write the clipboard. The gesture must be classified from the pointer's **screen cells**
(`mouse.row` / `mouse.col` of the parsed report, 1-based), which is exactly the data the terminal
sent and is immune to viewport drift.

## Goal / non-goals

**Goal**: in the legacy path, a release is treated as a drag when the gesture actually moved —
either a motion event was seen (`selectionDragging`) **or** the release's screen cell differs from
the press's screen cell. The motion-less gesture then lands on the same branch as the canonical
drag: copy + highlight retained until the next click. Stationary clicks keep the click path
regardless of how much output arrived between press and release.

**Non-goals**:

- #172 (clear the highlight after copy) — the drag-copy branch deliberately keeps the highlight;
  #187 must reproduce that contract, not change it.
- #186 UX umbrella items (selection background color, no 1-cell press selection, clipboard
  fallback/`pbcopy`, Shift+drag docs).
- #188 (X10 `Cb=3` release parsed as press) and #189 (all-or-nothing chunk parsing): separate
  issues, separate acceptance. The fix works with both still broken.
- Fullscreen mode / `handleMouse` / pi-tui behavior (upstream concern).
- Press/move branches, selection autoscroll, middle-click paste, PRIMARY mirroring, wheel handling.
- No change to how the selection range itself is stored (still buffer coordinates) — only the
  drag/click classification moves to screen space.
- No new env knob, no new dependency, no new I/O surface.

## Design

### 1. Pure helpers (`src/core/pty-scroll.mjs`)

```js
/** Issue #187: two mouse points are "the same" within the terminals' 1-cell coordinate slack.
 * Moved here from pty-attach.ts (it was already pure) so double-click detection and the
 * screen-space gesture comparison share one definition each. Buffer-space comparison. Pure. */
export function sameMousePoint(a, b) {
	return a.line === b.line && Math.abs(a.col - b.col) <= 1;
}

/** Issue #187: two SCREEN cells are "the same" within the same 1-cell slack — the terminal
 * reports cells, and a genuine click must survive a ±1 sub-cell report. Screen-space
 * comparison; see the spec for why the gesture is classified here and not in buffer space. Pure. */
export function sameScreenCell(a, b) {
	return a.row === b.row && Math.abs(a.col - b.col) <= 1;
}

/** Issue #187: whether a mouse release ends a real selection drag. Terminals such as Warp
 * deliver a fast drag as press + release with zero motion events, so the move flag alone is not
 * sufficient — the gesture geometry decides. Points are SCREEN cells, so a viewport that drifts
 * between press and release (streaming session, follow-bottom) cannot turn a click into a drag.
 * Missing geometry (no screen anchor recorded) degrades to the pre-fix answer: not a drag. Pure. */
export function selectionReleaseIsDrag({ dragging, pressScreen, releaseScreen }) {
	if (dragging) return true;
	if (!pressScreen || !releaseScreen) return false;
	return !sameScreenCell(pressScreen, releaseScreen);
}
```

Decision table for `selectionReleaseIsDrag`:

| dragging | pressScreen / releaseScreen (screen cells) | result |
|---|---|---|
| `true` | any (incl. missing) | `true` |
| `false` | same row, `\|Δcol\| <= 1` | `false` (click) |
| `false` | same row, `\|Δcol\| >= 2` | `true` (motion-less drag) |
| `false` | different row | `true` (motion-less drag) |
| `false` | either missing | `false` (degrade to pre-fix behavior) |

Buffer-space points (`anchor`/`focus`) are deliberately **not** inputs: they are only meaningful
against the viewport base that produced them.

### 2. Component wiring (`src/ui/pty-attach.ts`)

- The selection object carries the gesture anchor in screen space, so its lifetime is bound to the
  selection and no extra reset site is introduced:

```ts
// press (:1035): record the raw screen cell alongside the buffer-space anchor
this.selection = { anchor: point, focus: point, screenAnchor: { row: mouse.row, col: mouse.col } };
```

  `screenAnchor` is optional: `selectWordAtPoint` (double-click) creates a selection without one,
  and a missing anchor degrades to "not a drag".

  **Both sides of the comparison must be the raw reported cells** (`mouse.row` / `mouse.col` as
  parsed from the terminal report) — never the clamped buffer point `mousePointForEvent` returns, and
  never `this.selection.focus`. A release outside the body is still classified by where the pointer
  actually went; only the *selection focus* is clamped (unchanged). A1 carries an out-of-body case
  for exactly this reason.

- Release branch — the decision, and nothing else, changes:

```ts
if (mouse.action === "release") {
	this.clearSelectionAutoScroll();
	const point = this.mousePointForEvent(mouse.row, mouse.col, true);   // unchanged
	if (point) this.selection.focus = point;                             // unchanged
	const shouldCopy = selectionReleaseIsDrag({                          // was: this.selectionDragging
		dragging: this.selectionDragging,
		pressScreen: this.selection.screenAnchor,
		releaseScreen: { row: mouse.row, col: mouse.col },
	});
	this.selectionDragging = false;                                      // unchanged
	// ...copy branch / click branch unchanged
}
```

Plus: `sameMousePoint` is deleted from `pty-attach.ts` (`:1658`) and imported from
`../core/pty-scroll.mjs` together with `selectionReleaseIsDrag` (one import line, `:20`).
`isDoubleClickCandidate` (`:1096`) keeps calling `sameMousePoint` on buffer points, unchanged.

### Resulting behavior matrix

| Gesture | Before | After |
|---|---|---|
| press + release, same screen cell | click path: pending link-open, clear after 260 ms | unchanged |
| press + release, `\|Δcol\| <= 1` on the same screen row | click path | unchanged (documented boundary) |
| press + release, same screen cell, **session streamed output in between** | click path | **unchanged** (this is the R1-G1 regression the screen-space decision prevents) |
| press + move + release | copy + highlight retained | unchanged |
| press + release, `\|Δcol\| >= 2` or different screen row (motion-less drag) | **click path: no copy, selection wiped after 260 ms** | **copy + highlight retained (same branch as the canonical drag)** |
| drag released outside the body | clamped selection focus, drag if the flag was set | clamped selection focus, drag by screen geometry too |
| middle press / non-primary press / wheel | unchanged | unchanged |
| fullscreen TUI | different handler (`handleMouse`) | unchanged |

Side effect of the fix worth stating: a motion-less drag now cancels a pending click from an
earlier press, exactly as the canonical drag path already does (`clearPendingClick()` in the copy
branch). That is intended — a drag is not a click.

## Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 纯决策 `selectionReleaseIsDrag` 决策表（屏幕坐标）+ `sameScreenCell` / `sameMousePoint` 边界 | 自动化验证（unit） | `node --test test/pty-scroll.test.mjs`（新增用例：dragging=true；同屏幕单元 → false；`\|Δcol\| = 1` → false；`\|Δcol\| = 2` → true；不同屏幕行 → true；pressScreen/releaseScreen 缺省 → false；**body 外的原始屏幕单元**（`pressScreen={row:2,col:1}`、`releaseScreen={row:30,col:16}`）→ true（按**原始**屏幕值判定，不复用 `mousePointForEvent` 的 clamp 结果）；sameMousePoint 的行相等与 1 格容差；sameScreenCell 的行相等与 1 格容差） | 新增用例全绿，既有用例不回归 |
| A2 | 组件接线：零 motion 的 press→release 走复制分支（本 issue 的确切复现） | 自动化验证（integration，组件级场景：真 runner socket + 默认模式 fake PTY + fake TUI 捕获 `terminal.write`） | 新增 `test-support/pty-attach-legacy-drag-scenario.ts` + `test/pty-attach-legacy-drag.test.mjs`；case 1：先照 `test-support/pty-attach-mouse-scenario.ts` 的 `sawContent` 轮询等到 `fake pi ready` 渲染完成（**前置条件，防空缓冲竞态**），再注入 `\x1b[<0;1;2M` + `\x1b[<0;16;2m`（零 move） | ① `terminal.write` 收到的序列中包含 `\x1b]52;c;<base64("fake pi ready")>\x07`（**包含语义**：同一通道还有鼠标模式控制序列，不得用等值断言）；② 400 ms 后组件 selection 非 null（未被待点击定时器清除）；③ 无 `{type:"input"}` 转发到 socket |
| A3 | 等价性：零 motion 拖拽与常规拖拽复制同一份文本 | 自动化验证（integration，同场景） | 同场景 case 2：`press(col1,row2)` + `move(col8,row2)` + `release(col16,row2)`；与 case 1 的 OSC 52 payload 比对 | 两个 case 提取出的 base64 payload 逐字节相同 |
| A4 | 负向：同屏幕单元的 press+release 仍走点击路径（不复制、260 ms 后清选中） | 自动化验证（integration，同场景） | 同场景 case 3：`press(col1,row2)` + `release(col1,row2)`，等 400 ms | ① press 注入后组件 selection **非 null**（证明 press 路径确实建立了选区，否则本用例空转过绿、无判别力）；② 无 OSC 52 写出；③ 400 ms 后组件 selection 为 null |
| A5 | 漂移负向控制（R1-G1）：流式输出导致的视口漂移不得把定身点击变成拖拽 | 自动化验证（integration，组件级场景：`FAKE_PTY_STREAM_MODE=steady` 的 fake PTY，缓冲区在 press→release 之间确实增长） | 新增 `test-support/pty-attach-legacy-drag-drift-scenario.ts` + `test/pty-attach-legacy-drag-drift.test.mjs`：等到内容渲染后，在同一屏幕单元 `press(col1,row2)`，等 ≥150 ms（期间 steady 流持续写入），再 `release(col1,row2)` | ① 断言期间缓冲区行数确实增长（否则该用例无判别力，视为失败）；② press 注入后组件 selection 非 null（同 A4 判据①）；③ 无 OSC 52 写出；④ 400 ms 后组件 selection 为 null（点击路径未被改判） |
| A6 | 点击路径未被改判：双击选词仍复制（该路径修复前无任何既有测试覆盖） | 自动化验证（integration，A2 场景） | 同场景 case 4：同屏幕单元两次快速 `press`+`release`（间隔 < 260 ms，第二次 release 触发 `isDoubleClickCandidate`）。默认模式 PTY 在此期间无新输出，故缓冲坐标不漂移——与 U3 的真实流式环境形成对照 | ① `terminal.write` 中包含以该单元格所在词为内容的 OSC 52 payload（fixture 下预期 `fake`）；② 400 ms 后组件 selection 仍为该词的选区（未被 pending-click 定时器清空） |
| A7 | 类型 / 构建 / 打包 | 自动化验证（static + build） | `npm run typecheck`；`npm run verify` | 全部通过（含 perf gate、coverage 阈值 lines 85 / funcs 80 / branches 70、`pack:dry`） |
| A8 | 既有行为不回归（#167 鼠标分发、#171 中键粘贴、#174 选中镜像、滚轮） | 自动化验证（unit + integration，既有套件） | `npm run test:coverage`（含 `test/pty-scroll.test.mjs`、`test/pty-attach-mouse.test.mjs`、`test/pty-attach-selection-mirror.test.mjs`、`test/pty-attach-wheel.test.mjs`） | 既有测试全绿，覆盖率不低于阈值。注：双击/待点击路径**此前无既有覆盖**（`grep -rn 'isDoubleClickCandidate\|selectWordAtPoint\|schedulePendingClick' test/ test-support/` 空），其不回归由 A6 承担 |
| U1 | 真机（终端原生，回归）：常规模式 attach 内拖选照旧复制 | 用户实测 | ① 把本机加载的扩展更新到合并后的 main：`git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board pull`（该 checkout 当前 HEAD=f81949d、有 `package-lock.json` 本地改动，先确认或 stash；扩展经 `~/.pi/agent/settings.json` 的 `git:github.com/zhuxixi/pi-agent-board` 注册，入口 `./index.ts` 免构建）；② 重启 `pi --tui-mode regular`（legacy 路径只在常规模式生效）→ `/agent-board` → attach 到任一 session；③ 左键拖选一段文字后松开；④ 中键粘贴 | ④ 中键粘贴内容与 ③ 选中的文字一致；高亮状态与 #172 现状一致（保留到下一次点击） |
| U2 | 真机（精确字节流）：注入 Warp 的 press+release 字节，复现本 issue 的确切输入 | 用户实测（tmux 3.4 已在本机；不可用时标 pending） | ① tmux 内跑 `pi --tui-mode regular` → `/agent-board` → attach；② 注入原始字节：`tmux send-keys -H 1b 5b 3c 30 3b 31 3b 32 4d`（press col1,row2）然后 `tmux send-keys -H 1b 5b 3c 30 3b 31 36 3b 32 6d`（release col16,row2）；③ 观察 attach 视图高亮与该行文本的剪贴板/PRIMARY 内容 | 注入后该行文本进入剪贴板（OSC 52 或 xclip PRIMARY），高亮保留到下一次点击；若常规模式下的真实 TUI 不把该字节流交给 attach 组件（与组件级 A2 环境不同），如实记录观察结果并标 pending，不改 A2 结论 |
| U3 | 真机（流式会话，R1-G1 回归）：输出持续滚动时单击**不得**被改判为拖拽 | 用户实测 | ① 承接 U1 的环境；② 让被 attach 的 session 持续输出（例如 `while :; do date; sleep 0.2; done`）；③ 输出滚动期间单击一段**无链接**文本数次；④ 停掉持续输出、让 session 空闲后，双击某词作对照 | ③ 单击期间剪贴板内容不变（无 OSC 52 写入迹象）、不误开链接——这是本次修复的核心回归项；④ 输出停止后的双击仍能选中该词并复制。**输出正好滚动时双击失配属既有行为（见保证边界），不计入本项判定** |

## Testability split design (hard constraint for implementation)

- **Pure core** (`src/core/pty-scroll.mjs`): `sameMousePoint(a, b)` (buffer space, shared with
  double-click detection), `sameScreenCell(a, b)` (screen cells) and
  `selectionReleaseIsDrag({dragging, pressScreen, releaseScreen})` — plain functions, no env reads,
  no I/O, no imports from the component. Unit decision tables (A1) call them directly.
- **I/O shell** (`PtyAttachComponent.handleLocalMouseEvent`): the only caller of the decision. It
  keeps owning selection state (buffer space), the screen anchor recording, the pending-click timer,
  the clamp, and `copySelectionToClipboard()`. No new private method is introduced and no new
  side-effect surface is added — the copy branch already exists and is reused verbatim.
- **Screen anchor ownership**: the anchor is recorded in the press branch as a field of
  `this.selection`, so it shares the selection's lifetime — there is no second piece of state to
  invalidate in `clearSelection()`, the pending-click timer, or `selectWordAtPoint()`.
- **Test seam** (component-level, A2–A6): the public `handleInput` legacy seam + a fake
  `tui.terminal.write` capture + a real runner socket with the fake PTY, i.e. exactly the seams
  `test/pty-attach-mouse.test.mjs` and `test/pty-attach-selection-mirror.test.mjs` already use.
  No test-only export, no new env knob, no injection hook.
- **Fixtures**: default-mode `test-support/fake-pty-pi.mjs` prints exactly one stable line
  (`fake pi ready`), so the expected OSC 52 payload is deterministic; `steady` mode is the drift
  source for A5. A PATH-stub `xclip` (logs args, swallows stdin) keeps scenarios off the host
  clipboard.
- **Boundaries to preserve**: each comparison keeps exactly one definition (`sameMousePoint` for
  buffer points, `sameScreenCell` for screen cells, both in `pty-scroll.mjs`, both unit-tested);
  the component must not re-inline either comparison, and the drag decision must not be split
  between the helper and the component.

## Risks / guarantee boundaries

- **Coordinates are cell-quantized.** A gesture that starts and ends within the same screen cell (or
  one column apart) is still a click; the fix cannot see sub-cell intent. Both comparison helpers
  apply the same 1-cell slack used today for double-click detection, so classification stays
  consistent.
- **Release outside the body** is clamped into the body before the selection focus is updated
  (existing behavior, unchanged); the drag decision itself uses the raw screen cells, so an
  out-of-body release is still classified as a drag when the pointer really moved.
- **Screen coordinates are only used for classification.** The selection range stays in buffer
  coordinates; if output scrolls the buffer mid-gesture, the copied text is whatever the current
  viewport mapping yields — unchanged behavior, not addressed here.
- **Double-click matching still uses buffer coordinates.** `isDoubleClickCandidate` (`:1096`)
  compares `lastClickPoint` (captured at the first release) against the second release point, both
  in buffer space, so output arriving between the two clicks makes a double-click miss — a
  pre-existing behaviour that #187 deliberately does not change (same drift mechanism as above,
  different call site). Fixing it means moving that comparison to screen cells too; that is a
  separate change with its own acceptance and deserves its own issue.
- **#188 / #189 are not fixed here.** X10-only terminals still misparse the release as a press, and
  mixed input chunks still bypass the mouse path; in those scenarios the selection is still lost.
  This is explicitly out of scope for #187.
- **No claim about terminal clipboard support.** The fix guarantees the copy is *attempted* on this
  path (OSC 52 write + PRIMARY mirror); whether the outer terminal honors OSC 52 is
  terminal-dependent (the reporter verified Warp does).
- **No claim about fullscreen mode.** pi ≥1.0 fullscreen selection/copy is pi-tui's; this handler
  does not run there.

## Deliverables

- `src/core/pty-scroll.mjs`: + `sameMousePoint` (moved), + `sameScreenCell`, + `selectionReleaseIsDrag`
- `src/ui/pty-attach.ts`: import both comparators + the decision; delete the local `sameMousePoint`;
  record `screenAnchor` in the press branch; release-branch decision
- `test/pty-scroll.test.mjs`: decision-table cases (A1)
- `test-support/pty-attach-legacy-drag-scenario.ts` + `test/pty-attach-legacy-drag.test.mjs` (A2–A4, A6)
- `test-support/pty-attach-legacy-drag-drift-scenario.ts` + `test/pty-attach-legacy-drag-drift.test.mjs` (A5)
- `docs/superpowers/specs/2026-10-14-issue-187-motionless-drag-design.md`: this spec, first commit in the worktree (step 5)
- CHANGELOG entry via the release tooling at release time (not in this PR)

## Open question for the design gate

U2 depends on tmux + regular TUI mode being available in the operator's environment (tmux 3.4 is
present on this machine, verified). If the operator confirms it is not available, U2 is recorded as
`pending` (per the acceptance-reporting rule) and A2 stays the evidence for the fix.
