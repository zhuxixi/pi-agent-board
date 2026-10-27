Drafted: ollama/deepseek-v4.1-flash:1017-cloud (selected) · ollama/deepseek-v4.1-flash:1017-cloud (physical) @ 2026-10-27T00:16:00Z
Revised: ollama/deepseek-v4.1-flash:1017-cloud (selected) · ollama/deepseek-v4.1-flash:1017-cloud (physical) @ 2026-10-27T00:41:00Z — R1-G1 (U1 deployment preconditions), R1-D1 (README decision), R1-D2 (follow-up issue #250)
Revised: ollama/deepseek-v4.1-flash:1017-cloud (selected) · ollama/deepseek-v4.1-flash:1017-cloud (physical) @ 2026-10-27T00:52:00Z — R2-D1 (U1 sequencing), R2-D2 (supersession note), R2-D3 (baseline)
Revised: ollama/deepseek-v4.1-flash:1017-cloud (selected) · ollama/deepseek-v4.1-flash:1017-cloud (physical) @ 2026-10-27T01:25:00Z — local code review F1 (gesture-generation guard) + F3 (deferral pin) + F4 (predicate table)

# Spec: #172 — attach view keeps the fullscreen selection highlight after copy-on-release

Status: DRAFT (awaiting spec-cross-review, then user approval — github-issue-driven step 4 gates)
Issue: https://github.com/zhuxixi/pi-agent-board/issues/172
Repo state baseline: `origin/main` @ `3fcc2a4` (local working copy `724c4da`, one docs-only commit behind; every cited line number was re-verified at `3fcc2a4`), pi-tui / pi-coding-agent 1.1.0

## Problem (root cause, verified against source)

The reported symptom is real, but the issue's Root cause paragraph points at the wrong
mechanism. In **fullscreen** (pi ≥1.0, `TuiAltScreen` owns left-drag), the highlight is
painted by pi-tui's own `applySelection()` from `selectionAnchor` / `selectionFocus`.
`PtyAttachComponent.handleLocalMouseEvent` — the `shouldCopy` branch the issue blames — is
never reached in fullscreen (the component's own comment at `pty-attach.ts:474`), so
`this.selection` stays null and no board-side `clearSelection()` can affect what the user
sees.

pi-tui 1.1.0 `dist/tui-alt-screen.js:1090-1139` release path:

```js
if (this.copyOnSelect)
    void this.copySelectionToClipboard();
this.requestRender();
return;
```

The copy is done, the selection state is not reset, so the inverse-video highlight stays
lit until pi clears it on a later gesture (`clearTextSelection()` is invoked by pi itself
when the user clicks a component or moves focus).

The repo already has the one hook that runs after pi finalizes a selection: #174's
`process.nextTick` callback scheduled from `handleMouse` for left `release`/`click`
(`pty-attach.ts:523-528` → `mirrorFullscreenSelectionToPrimary()`, `:1376`).

## Goal / non-goals

**Goal**: in fullscreen, once pi's copy-on-select has completed for a selection gesture
that ends inside the attach view, drop pi's selection so the highlight disappears
immediately — without changing what reaches the clipboard, and without breaking pi's
multi-click chain (double-click word, triple-click line).

**Supersedes** #174's "pi's own selection behavior (visuals, CLIPBOARD copy) is untouched" for
the post-copy highlight only; #174's mirror, kill-switch and no-consume contracts are
preserved.

**Non-goals**:

- The legacy/regular-mode gap (`handleLocalMouseEvent` `shouldCopy` missing
  `clearSelection()`). It is a real, separate bug; this PR leaves regular-mode behavior
  untouched and the existing `pty-attach-legacy-drag` assertions intact. It will be tracked
  separately: issue #250.
- Selections that end outside the attach overlay (dashboard, other pi UI): outside the
  component's event window, same limitation as the #174 mirror.
- Any upstream change to pi/pi-tui. The change uses a feature-detected private method; if
  pi ever exposes a public "clear visual selection" API, this code can switch to it.
- Changing `AGENT_BOARD_ATTACH_NATIVE_PASTE` semantics beyond making the highlight clear
  independent of it (see D2 below).

## Decisions

**D1 — clear via `clearTextSelection()`, not `resetTextSelection()`.**
`resetTextSelection()` is public but also clears `lastClick`; `getClickCount` uses
`lastClick` with `DOUBLE_CLICK_INTERVAL_MS = 500`, so clearing it on every release would
make the second press of a double-click count as a first click and break word/line
selection. `clearTextSelection()` only drops the visual selection
(`tui-alt-screen.js:689-698`), preserving the click chain. It is declared `private` in
pi-tui's typings but is a plain prototype method at runtime; the board already reads the
private `getActiveSelectionText` the same way (`pty-attach.ts:1379`). Access is
feature-detected so older/newer pi degrades to today's behavior instead of throwing.

**D2 — decouple the clear from `AGENT_BOARD_ATTACH_NATIVE_PASTE`.**
That switch is documented as X11 PRIMARY copy + middle-click paste integration. The stale
highlight is a pi-selection-state issue, not a clipboard concern: with the switch off, pi
still copies on release and the highlight still lingers. `writePrimarySelection()` already
self-gates on the env var, so the scheduling predicate does not need it — the mirror keeps
its exact behavior, and the clear runs regardless.

**D3 — only clear when pi actually copied.**
`getCopyOnSelect()` (public) is checked before clearing. With copy-on-select disabled the
user keeps the selection deliberately (pi's `Ctrl+X` copies it), so the highlight must
stay. With it enabled, the text is already in the clipboard, so the highlight has no
remaining purpose.

**D4 — clear only for a non-empty selection.**
`getActiveSelectionText()` returning empty/undefined means no selection was made (bare
press-release, click on a link) — nothing to clear, and pi's own click handling is left
untouched.

**D5 — a settle may not consume the next gesture.**
pi-tui emits batched mouse reports synchronously in one loop, so a `release` and the next
left `press` can land in the same stdin chunk. Without a guard, the deferred settle would
run after that press has already started a new (word/line) selection, mirror it, and clear
it — the double-click would then copy nothing. A monotonic `selectionGestureSerial`,
bumped on every left press, is captured when the settle is scheduled; a mismatch on the
next tick drops the settle.

## Design

### 1. Pure predicate (`src/core/pty-scroll.mjs`)

Replace the env-gated mirror helper with an env-free gesture predicate:

```js
/** Issue #174/#172: whether a normalized mouse event ends a fullscreen text
 * selection gesture the attach overlay settles — mirror the selection into
 * X11 PRIMARY (#174) and drop pi's highlight once copy-on-select has run (#172).
 * Only release/click of the left button ends a selection in TuiAltScreen; pi
 * owns the gesture, so the overlay observes without consuming. Pure. */
export function isFullscreenSelectionEnd(event) → boolean
```

Decision table:

| type | button | result |
| --- | --- | --- |
| release / click | left | `true` |
| press / move / drag / wheel | any | `false` |
| release / click | middle / right / none | `false` |

`shouldMirrorSelectionToPrimary` is removed; `writePrimarySelection()` remains the single
place that honours `AGENT_BOARD_ATTACH_NATIVE_PASTE`.

### 2. Component wiring (`src/ui/pty-attach.ts`)

```ts
const nativePasteEnabled = process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE !== "0";
// D5: a press starts a new gesture; see the serial check below.
if (event.type === "press" && event.button === "left") this.selectionGestureSerial += 1;
if (isFullscreenSelectionEnd(event)) {
    // Overlays are dispatched before TuiAltScreen finalizes (and copies) the
    // selection for this event, so settle on the next tick (issue #174).
    const serial = this.selectionGestureSerial;
    process.nextTick(() => {
        if (serial !== this.selectionGestureSerial) return;   // D5: next gesture started
        this.settleFullscreenSelection(nativePasteEnabled);
    });
    return undefined;   // observe only — pi keeps the gesture
}
```

`mirrorFullscreenSelectionToPrimary()` is renamed and extended:

```ts
interface FullscreenSelectionHost {
    getActiveSelectionText?: () => string | undefined;
    getCopyOnSelect?: () => boolean;
    clearTextSelection?: () => void;   // private in pi-tui's typings; feature-detected
}

/** Issue #174 (B2) + #172: after a selection gesture ends inside this overlay,
 * pi has finalized (and copied) its selection. Mirror the text into X11 PRIMARY
 * so middle-click paste works, then drop pi's selection so the inverse-video
 * highlight does not outlive the copy. Clearing is gated on copy-on-select and
 * on the pi-tui method being present; a missing method degrades to the old
 * behaviour (highlight persists) rather than throwing. */
private settleFullscreenSelection(nativePasteEnabled: boolean): void {
    if (this.closed) return;
    const alt = this.tui as FullscreenSelectionHost;
    const text = alt.getActiveSelectionText?.();
    if (typeof text !== "string" || text.length === 0) return;
    if (nativePasteEnabled) this.writePrimarySelection(text);
    if (alt.getCopyOnSelect?.() === false) return;
    if (typeof alt.clearTextSelection !== "function") return;
    alt.clearTextSelection();
    this.scheduleRender();   // pi's own release repaint happened before this tick
}
```

### Resulting behavior matrix

| Scenario | Behavior |
| --- | --- |
| fullscreen: drag-select inside attach, release | copied by pi; PRIMARY mirrored; highlight cleared on the next tick ✅ |
| fullscreen: double-click a word, release | word copied by pi; word highlighted momentarily, then cleared; triple-click chain still works (`lastClick` untouched) ✅ |
| fullscreen: plain left click | empty selection → nothing cleared, pi's own click handling untouched |
| fullscreen: `fullscreenCopyOnSelect = false` | selection kept for `Ctrl+X`; highlight stays (intended) |
| fullscreen: `AGENT_BOARD_ATTACH_NATIVE_PASTE=0` | no PRIMARY write; highlight still cleared |
| older pi without `clearTextSelection` | no PRIMARY-write change, highlight stays (graceful degradation) |
| regular / legacy mode | unchanged: `handleMouse` is not called; the local selection path is untouched |

## Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 手势谓词决策表 | 自动化验证（unit） | `node --test test/pty-scroll.test.mjs`（替换原 `shouldMirrorSelectionToPrimary` 用例，覆盖 release/click × left 为 true，press/move/drag/wheel/其它按钮为 false） | 新增用例全绿 |
| A2 | 非空选区 release：镜像 + 清高亮，且先取文本后清 | 自动化验证（integration，组件级场景） | `test/pty-attach-selection-mirror-scenario.ts` 的 fake TUI 增加 `clearTextSelection()`（置空 fixture 并计数）与 `getCopyOnSelect()`；`test/pty-attach-selection-mirror.test.mjs` 断言 | xclip 日志收到 `-selection primary` 与 fixture 文本（证明清除前已读取），`clearCalls === 1`，`handleMouse` 返回 `undefined` |
| A3 | 空选区 / press / move 不清 | 自动化验证（同上） | 同场景 | `clearCalls === 0`，无 PRIMARY 写 |
| A4 | `copyOnSelect === false` 不清、仍镜像 | 自动化验证（同上） | 同场景，fake TUI 返回 false | `clearCalls === 0`，PRIMARY 写 1 次 |
| A5 | `NATIVE_PASTE=0`：不写 PRIMARY 但仍清高亮 | 自动化验证（同上） | 同场景，env 覆盖 | `killSwitchWrites === 0`，`killSwitchClears === 1` |
| A6 | 旧 pi（无 `clearTextSelection`）：降级不抛错 | 自动化验证（同上） | 同场景，fake TUI 省略该方法 | 无异常，PRIMARY 写 1 次，`clearCalls` 不可用（不适用） |
| A7 | 类型与构建 | 自动化验证（static/build） | `npm run typecheck`、`npm run verify` | 全部通过（含既有套件、覆盖率阈值、perf gate、pack:dry） |
| A8 | release + 下一次 press 同 tick 合并：排队中的 settle 不得读/清新选区 | 自动化验证（同上） | 同场景：`handleMouse(release)` 后立即 `handleMouse(press)`，再等 tick | `coalescedWrites === 0` 且 `coalescedClears === 0`；另在 release 后同步断言 `releaseSyncWrites === 0`（deferral 钉死） |
| U1 | 真机 fullscreen 体验 | 用户实测 | **前置**：① 合并后把 pi 实际加载的 git checkout 更新到 main —— 扩展在 `~/.pi/agent/settings.json` 以 `git:github.com/zhuxixi/pi-agent-board` 注册，路径为 `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board`，入口 `./index.ts`（免构建）；执行 `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board pull --ff-only`，若因本地 `package-lock.json` 改动被拒就先 `git stash push -- package-lock.json`、测完 `git stash pop`；② 完全退出并重启 pi（扩展启动时加载；fullscreen 是默认模式，必要时用 `pi --tui-mode fullscreen` 显式指定）；③ 确认 X11 会话且 `which xclip` 有输出。**步骤**：① fullscreen attach 内拖选一段文字并松开 → 高亮立即消失；② 中键粘贴仍粘贴刚选内容；③ 双击选词 → 高亮消失且双击仍能选词；④ 三击选行仍生效；⑤ 把 `~/.pi/agent/settings.json` 的 `"fullscreenCopyOnSelect"` 设为 `false` 并重启，拖选松开 → 高亮保留、`Ctrl+X` 可复制；测完恢复默认并重启 | ①–⑤ 全部符合 |

## Testability split design (hard constraint for implementation)

- **Pure core**: `isFullscreenSelectionEnd(event)` — no env reads, no side effects; full
  event-shape decision table at unit level (A1).
- **I/O shell**: `handleMouse` maps the predicate to one `process.nextTick` schedule;
  `settleFullscreenSelection()` owns the ordering (`getActiveSelectionText` →
  `writePrimarySelection` → clear → `scheduleRender`). The gesture serial lives on the
  component (`handleMouse` bumps it on left press, the scheduled closure compares it) and
  needs no separate unit test: A8 drives it through the public seam. The only xclip touch point stays
  `writePrimarySelection`; the only pi-selection touch points stay `getActiveSelectionText`
  / `getCopyOnSelect` / `clearTextSelection`, all through the structural cast.
- **Fake TUI seams** (component scenario): `getActiveSelectionText`, `getCopyOnSelect`,
  `clearTextSelection`, `requestRender`. `clearTextSelection` must invalidate the fixture
  so that a wrong order (clear → read) produces zero PRIMARY writes and fails A2 — the
  test must not merely count calls.
- The clear must not be inlined into `handleMouse` (it needs the deferred tick) and must
  not be replicated in the legacy path.

## Risks / notes

- Private API coupling: `clearTextSelection` can disappear in a future pi-tui. Mitigated
  by feature detection (degrade, never throw) and by a comment naming the upstream ask
  (expose a public "clear visual selection, keep click history" method).
- If pi ever defers selection finalization across ticks, the clear would land before the
  copy; the `copyOnSelect` gate would then clear a selection pi is about to copy. Accepted
  risk recorded here; the ordering assumption is pinned by A2's read-before-clear fixture.
- `Ctrl+X` (pi's copy binding) after a drag becomes a no-op when copy-on-select is on —
  by construction, the text is already in the clipboard; when the user disabled
  copy-on-select, the clear is skipped and `Ctrl+X` still works.
- The highlight for gestures ending outside the overlay remains (same as #174's mirror
  limitation).
- A release followed by another press inside one stdin chunk is guarded by the gesture
  serial (D5/A8). A press that lands outside the overlay does not touch the serial, but
  pi's own press path has already reset its selection, so the settle reads nothing.
- Updating the issue's Root cause / Environment text is part of the PR narrative, not of
  the code change.

## Deliverables

- `src/core/pty-scroll.mjs`: replace `shouldMirrorSelectionToPrimary` with
  `isFullscreenSelectionEnd`
- `src/ui/pty-attach.ts`: predicate branch in `handleMouse`; rename/extend
  `settleFullscreenSelection`; `FullscreenSelectionHost` structural type
- `test/pty-scroll.test.mjs`: decision-table update
- `test-support/pty-attach-selection-mirror-scenario.ts` + `test/pty-attach-selection-mirror.test.mjs`:
  clear/order/copyOnSelect/kill-switch/fallback cases
- No README change: the `AGENT_BOARD_ATTACH_NATIVE_PASTE` row (README:323) describes X11
  PRIMARY copy + middle-click paste, which is still exactly what the switch governs; the
  highlight clear is neither, so the current wording stays accurate after the decoupling.
- CHANGELOG entry via release tooling at release time (not in this PR)
