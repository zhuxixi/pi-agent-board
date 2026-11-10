# Spec: #258 — board (dashboard) keeps the fullscreen selection highlight after copy-on-release

Status: DRAFT (awaiting spec-cross-review; gate=auto per authorization.md — after convergence, proceed straight to step 5 without pausing)
Issue: https://github.com/zhuxixi/pi-agent-board/issues/258
Repo baseline: `origin/main` @ `5d0c982` (local main `608a22a`; `608a22a..5d0c982` touches only dashboard-fold test files and docs — all src/ citations below were verified on `608a22a` and are unaffected). pi-tui / pi-coding-agent 1.5.1 installed runtime verified.

Drafted: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-10T08:52:00+08:00
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-10T09:02:00+08:00 — R1-G1 (shouldSettle lifecycle gate), R1-G2 (U1/U2 deployment preconditions), R1-G3 (A4 non-empty precondition + no-silent-downgrade), R1-D1 (production overlay:true), R1-D2 (A4 wrapper attribution), R1-D3 (D6 acceptance owner)
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-10T09:38:00+08:00 — R2-D1 (board `disposed` gate + A3 unmount-race case), R2-D2 (A4 explicit command + launch flags)

## Problem (root cause, verified against source)

In fullscreen (pi ≥1.0), drag-selecting text inside the board copies on release (pi-tui copy-on-select) but the inverse-video highlight stays lit until the next mouse press.

`TuiAltScreen` owns the gesture: each decoded mouse event is dispatched to overlays/layout components first (`component.handleMouse?.(event)`), and only when nothing consumed it does pi run its own selection logic — the release path does `copySelectionToClipboard()` + `requestRender()` and does **not** reset selection state. `DashboardComponent` (`src/ui/dashboard.ts:137`) implements `handleInput` only; there is no `handleMouse` anywhere in the file, so no code ever observes the gesture ending and nothing settles it. The attach view fixed the same symptom in #172 (PR #251, `3d72b68`) by observing in its own `handleMouse`; the board has no equivalent observation point yet.

Production mount: `ctx.ui.custom<DashboardResult>(..., { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } })` (`src/commands/agent-board.ts:94-131`) — with `overlay: true`, pi's interactive mode mounts the board via `showOverlay`, so mouse events reach `DashboardComponent.handleMouse` through `TuiAltScreen`'s overlay hit-test dispatch — the same dispatch path the #172 attach fix rides. (Corrected per review R1-D1; the editor-container mounting described in JFox KB applies to `ctx.ui.custom` **without** `overlay: true`, not to this component.)

## Goal / non-goals

**Goal**: in fullscreen, once pi's copy-on-select has completed for a selection gesture that ends inside the board, drop pi's selection so the highlight disappears immediately — without changing what reaches the clipboard, without consuming any mouse event, and without breaking pi's multi-click chain (double-click word / triple-click line).

**Shared-core requirement** (from the issue's fix direction): extract the settle logic so the attach and board paths cannot drift. The attach path is refactored onto the same core with behavior preserved (its existing tests stay green, unmodified).

**Non-goals**:

- X11 PRIMARY mirroring for the board (the mirror hook stays attach-only behind `AGENT_BOARD_ATTACH_NATIVE_PASTE`; the board has no middle-click paste consumer — can be added later without touching the shared core).
- #250 — the legacy/regular-mode attach `shouldCopy` gap; a different code path, untouched.
- Selections that end outside the board's overlay box (pi transcript, other pi UI): outside the component's event window — same limitation class as #172/#174; would need an upstream event.
- The board's row-cursor highlight (`theme.bg("selectedBg")`): unrelated, by design stays visible.
- Any upstream change to pi/pi-tui; private-method access stays feature-detected with graceful degradation.

## Decisions

**D1 — shared settle core in `src/core/fullscreen-selection.mjs`.**
New core module exporting a `FullscreenSelectionSettler` with injected seams (repo convention: pure/testable core, thin I/O shell):

```ts
constructor({
	host: FullscreenSelectionHost,        // { getActiveSelectionText?, getCopyOnSelect?, clearTextSelection? } — feature-detected
	mirror?: (text: string) => void,       // attach passes its xclip write (already self-gated on its env knob); board omits
	repaint?: () => void,                  // attach: scheduleRender(); board: tui.requestRender()
	schedule?: (cb: () => void) => void,   // defaults to process.nextTick; injectable for unit tests
	shouldSettle?: () => boolean,          // runtime lifecycle gate — checked inside the deferred callback BEFORE any host read/mirror/clear (R1-G1); attach passes () => !this.closed, board omits
})
observeMouse(event): void
```

`observeMouse` semantics (exactly the semantics attach ships today):
1. `press` + `left` → bump the internal gesture serial.
2. `isFullscreenSelectionEnd(event)` (existing pure predicate, `src/core/pty-scroll.mjs:279` — release/click of left) → capture serial, `schedule(() => { if (serial unchanged) settle(); })`.
3. `settle()` order: `shouldSettle && !shouldSettle()` → return (runtime lifecycle gate, R1-G1; attach keeps its existing `!this.closed` semantics) → read `host.getActiveSelectionText?.()` → empty/absent: return → `mirror?.(text)` → `host.getCopyOnSelect?.() === false`: return (user keeps the selection for Ctrl+X) → `typeof host.clearTextSelection !== "function"`: return (older/newer runtime degrades) → `clearTextSelection()` → `repaint?.()`.

Read-before-clear is load-bearing (the #172 harness fixture invalidates text on clear to pin the order). `pty-attach.ts` refactors: delete its inline serial/defer/settle code — including the `if (this.closed) return;` first line of `settleFullscreenSelection` (`src/ui/pty-attach.ts:2433`), which moves into the `shouldSettle` option — and instantiate one settler with its existing host cast, mirror, `scheduleRender`, and `() => !this.closed`. No behavior change (R1-G1). Its `FullscreenSelectionHost` interface moves to (or is re-exported from) the core module so both components share one definition.

**D2 — gesture serial lives inside the settler.**
pi-tui decodes a stdin batch and dispatches events synchronously, so a release and the next press can share one tick; a settle queued on the release must not consume the next gesture's selection (this exact bug was caught in #172's local review). Bumping on left press and comparing the captured serial at run time is preserved as-is — now in one place instead of two.

**D3 — clear via `clearTextSelection()`, never `resetTextSelection()`.**
`resetTextSelection()` also clears `lastClick`, which `getClickCount` needs within `DOUBLE_CLICK_INTERVAL_MS = 500` — clearing it per release would break double-click word / triple-click line selection. `clearTextSelection()` drops only the visual selection state. It is `private` in pi-tui typings but a plain prototype method at runtime (verified present in the installed 1.5.1 `tui-alt-screen.js`); access stays feature-detected.

**D4 — no PRIMARY mirror for the board.**
The board's scope is the stale highlight only. The settler's `mirror` hook keeps attach's #174 behavior intact; the board simply does not pass one.

**D5 — dashboard wiring.**
- `handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined` on `DashboardComponent`: calls `this.selectionSettler.observeMouse(event)`, then **always returns `undefined`** (observe only — pi keeps every gesture, its copy and its link handling). No mode gating: the settle is about pi-level selection state and applies in every board mode.
- The settler is constructed in the constructor body (after the `tui` parameter property is assigned), with `repaint: () => this.tui.requestRender()` and `shouldSettle: () => !this.disposed` — non-forced repaint; content is unchanged, only pi's selection overlay goes away. (`requestRender` is already the board's seam; `dashboard.ts:1287` uses the forced variant only for full-clear cases.)
- The board gates on its own lifecycle too (R2-D1): a private `disposed` flag set at the top of `dispose()` (`src/ui/dashboard.ts:1266`), checked via `shouldSettle`. `done()` synchronously hides and disposes the overlay, but a settle queued before that still holds the global `TuiAltScreen` host and — if the host already carries a newer non-empty selection — the stale callback would read and clear it; the gesture serial cannot guard this (it only grows on presses the dead board still observes).

**D6 — the board's embedded `CustomEditor` rows are covered by the same observer.**
Mouse dispatch is hit-test-based within the board's box regardless of which sub-element sits under the cursor; if pi's editor consumes an event, the gesture never starts and there is nothing to settle. No special-casing.

## Testability split design (design constraint for the plan)

| Unit | Shape | How tested | Test boundary |
| --- | --- | --- | --- |
| `FullscreenSelectionSettler` (new, `src/core/fullscreen-selection.mjs`) | all I/O injected (host object, mirror/repaint/schedule callbacks, `shouldSettle` gate); no timers, no filesystem, no spawn | unit — fake host + manual `schedule` queue flushed by the test; no wall-clock waits | everything up to and including the `clearTextSelection()` call and the repaint trigger; gesture-serial semantics; the `shouldSettle` lifecycle gate |
| `DashboardComponent.handleMouse` wiring | thin shell: forward to settler, return `undefined` | component harness — child process, fake fullscreen TUI (the #172 `pty-attach-selection-mirror-scenario.ts` pattern), real `DashboardComponent` from `../src/ui/dashboard.ts`, drives `handleMouse` directly | board-side wiring only: the right events reach the settler, the return value never consumes |
| Real dispatch chain (TuiAltScreen → overlay → `handleMouse` → pi finalize → deferred settle) | real renderers | real-renderer harness — the `dashboard-tui-modes.ts` pattern: real `TuiAltScreen` + headless xterm + captured input callback, inject SGR mouse sequences | end-to-end within the process: synthetic SGR in, selection state cleared out |
| Attach behavior preservation | refactor only | existing `pty-attach-selection-mirror` tests, unmodified | regression fence for the extraction |

## Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | settler 核心语义 | 自动化验证（unit） | `node --test test/fullscreen-selection.test.mjs` | 全绿：空文本不清也不镜像；`copyOnSelect=false` 不清（mirror 照跑）；`clearTextSelection` 缺席不抛、不清；正常路径 clear+repaint 各一次；read-before-clear 顺序（clear 后文本失效的 fixture）；同 tick release→新 press 时收尾被手势序号丢弃；`click` 事件同样触发 settle；`shouldSettle` 返回 false 时 host 读取/mirror/clear/repaint 均为零 |
| A2 | attach 重构行为保持（含关闭门禁）| 自动化验证（unit/component） | `node --test test/pty-attach-selection-mirror.test.mjs`（既有断言零改动；**追加**用例：release 入队 → 组件 close → flush tick → mirror 写入与 clear 调用均为 0） | 原断言全绿 + 新增关闭门禁用例全绿 |
| A3 | board 组件接线 | 自动化验证（integration，子进程组件 harness） | `node --test test/dashboard-selection-settle.test.mjs` | 全绿：release→flush tick→`clearTextSelection` 被调、`requestRender` 被调；press/release 同 tick 抑制；wheel/右键不触发；返回值恒 `undefined`；带嵌入 CustomEditor 的模式（filter/launch）下同一手势同样 settle 且返回恒 `undefined`（D6 归属，R1-D3）；release 入队 → `dispose()` → host 换上新选区 → flush 后 host 读取/mirror/clear/repaint 均为零（卸载竞态，R2-D1） |
| A4 | 真派发链路（overlay 路径，与生产一致）| 自动化验证（integration，real renderer + headless xterm） | `node --test test/dashboard-tui-modes.test.mjs`（**新增 wrapper**，内部沿用 `test/dashboard-fold.test.mjs:27` 的启动方式：`node --experimental-transform-types test-support/dashboard-tui-modes.ts`，R2-D2；原 fold wrapper 不改动，R1-D2） | 渲染已知文本 → SGR press/drag → **先断言非空选区存在**（`getActiveSelectionText()` 非空或反色单元，R1-G3）→ release → flush nextTick → 同一选区被清且 repaint 发生；降级规则：合成 SGR 驱动不了 headless 选区时，fallback 必须仍经真实 `TuiAltScreen` 派发缝断言 finalize→deferred settle→clear 顺序与终态，否则 A4 记**未满足**（不得降级通过，U1 门保留） |
| A5 | 全量回归门 | 自动化验证（build） | `npm run verify` | exit 0（typecheck、perf、tests、coverage、pack:dry） |
| U1 | board 拖选复制后高亮即清 | 用户实测 | 按「部署前置」更新真实加载 checkout 并重启 pi 后：fullscreen 打开 board，拖选会话名/日志行后松开 | 内容已复制（CLIPBOARD 粘贴验证：Ctrl/Cmd+V；不依赖 board 未实现的 PRIMARY 中键粘贴），反色高亮立即消失，无需下一次点击 |
| U2 | 双击/三击不受影响 | 用户实测 | 在 U1 的同一已更新实例上：500ms 内双击单词、三击某行 | 选词/选行照常发生并复制，高亮随后清除 |

**U1/U2 部署前置（可执行时机，R1-G2）**：pi 通过 `git:github.com/zhuxixi/pi-agent-board` 从独立 checkout `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board` 加载本扩展（`~/.pi/agent/settings.json` extensions 块），当前工作副本不是加载路径。PR 合并后：`git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board restore package-lock.json`（或 stash——该 checkout 2026-11-10 存在 package-lock.json 本地脏改动，在案）→ `git -C … pull --ff-only` → 完全退出并以 fullscreen 模式重启 pi → `/agent-board`。

若某项无法自动化：A1–A5 均有既有同类先例（#172 的 mirror 场景、dashboard-tui-modes 的真渲染 harness），无预期障碍；A4 的降级边界已写入矩阵（fallback 仍须走真实派发缝断言时序与终态；只证明"handleMouse 被派发到"不够，A4 记未满足、U1 门保留），不允许静默降级为只跑 A3。

## Boundaries / risks

- Observation covers the overlay's hit-test box (≈ the screen). Selections released outside it keep pi's behaviour — no seam exists.
- Production and the A4 harness mount the board identically as a fullscreen overlay (`overlay: true`, `src/commands/agent-board.ts:127-131`; harness `test-support/dashboard-tui-modes.ts:61-63`) — A4 exercises the production dispatch path directly (R1-D1 correction; no separate "layout path" exists for this component).
- A settle queued before unmount is stopped by the `disposed` gate (R2-D1); without it the stale callback would still hold the global `TuiAltScreen` host and could clear a newer UI's selection.
- No wall-clock-sensitive waits are introduced (one nextTick deferral, same as attach) — nothing new for the #95 realtime-budget ledger.

## Supersedence / relations

- Mirrors #172 (attach, merged `3d72b68`) onto the board; shares its core going forward.
- #250 (legacy/regular attach) remains separate.
- #174's deferred-selection hook contract is preserved unchanged on the attach path.
