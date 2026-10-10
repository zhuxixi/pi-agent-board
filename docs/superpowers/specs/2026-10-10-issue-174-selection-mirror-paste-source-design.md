Drafted: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-10-10T00:31:00Z

# Spec: #174 — middle-click paste in fullscreen reads a stale X11 PRIMARY: mirror pi's selection to PRIMARY (B2) + paste-source override (C)

Status: DRAFT (awaiting spec-cross-review or user waiver, then user approval — github-issue-driven step 4 gates)
Issue: https://github.com/zhuxixi/pi-agent-board/issues/174
Repo state baseline: main @ `0fd1dc5` (post-#173)

## Problem (root cause, verified live + from source)

In fullscreen, drag-select belongs to `TuiAltScreen` and its copy-on-select writes
**CLIPBOARD** only; nothing in a pi session ever writes X11 **PRIMARY**. Middle-click
paste (#171) reads **PRIMARY** → serves a fossil (live evidence 2026-10-10: PRIMARY held
`assert_contains(doc, contracts)` while the user's fresh selection sat in CLIPBOARD).
Pre-1.0 the loop closed because the component's own selection mirrored to PRIMARY
(`writePrimarySelection`, a1c5f08) — dead in fullscreen since pi owns left-drag.

Design-critical ordering fact (pi-tui 1.1.0 `handleMouseEvent`): overlays are dispatched
**before** pi's selection finalization for the same event, so the mirror must read the
selection **deferred** (`process.nextTick` after the release/click).

## Goal / non-goals

**Goal**: (B2) when a selection gesture ends inside the attach view in fullscreen, mirror
pi's final selection text into X11 PRIMARY so the classic select → middle-click-paste
loop works again; (C) opt-in `AGENT_BOARD_ATTACH_PASTE_SOURCE=primary|clipboard` for
environments where PRIMARY never updates. Both governed by the existing
`AGENT_BOARD_ATTACH_NATIVE_PASTE` kill switch. pi's own selection behavior (visuals,
CLIPBOARD copy) is untouched — B2 observes, never consumes.

**Non-goals**:
- Selections released outside the attach overlay (dashboard / other pi UI) — outside the
  component's event window; pi-wide coverage belongs upstream (earendil-works/pi).
- Any change to #169's ownership model, #171's paste decision table, or regular-mode
  behavior (mirror is a no-op there: `getActiveSelectionText` doesn't exist on
  regular-mode TUIs; paste source defaults to primary as today).

## Design

### 1. Pure decision helpers (`src/core/pty-scroll.mjs`)

```js
/** Issue #174 (C): which X11 selection buffer middle-click paste reads.
 * "primary" (default, classic X11 semantics) | "clipboard" (escape hatch for
 * environments where PRIMARY never updates, e.g. WSLg). Unknown values fall
 * back to "primary". Pure: the env value is read at the call site. */
resolvePasteSelectionSource(value) → "primary" | "clipboard"

/** Issue #174 (B2): whether a normalized mouse event should trigger mirroring
 * pi's (final) selection text into X11 PRIMARY. Only selection-gesture endings
 * (release/click of the left button) with native paste enabled. Pure. */
shouldMirrorSelectionToPrimary(event, { nativePasteEnabled }) → "mirror-primary" | null
```

Decision table for `shouldMirrorSelectionToPrimary`:

| type | button | nativePasteEnabled | result |
| --- | --- | --- | --- |
| release / click | left | true | `"mirror-primary"` |
| release / click | left | false | `null` |
| press/move/drag/wheel | any | * | `null` |
| release / click | middle/right/none | * | `null` |

### 2. Component wiring (`src/ui/pty-attach.ts`)

- `handleMouse(event)` gains one branch BEFORE the paste branch (order irrelevant; events
  are disjoint): if `shouldMirrorSelectionToPrimary(event, {nativePasteEnabled})` →
  schedule `process.nextTick(() => this.mirrorFullscreenSelectionToPrimary())` and
  **return `undefined`** (observe only — pi keeps the event). The paste branch is
  unchanged (`press + middle` → paste, `{handled:true, render:false}`).
- New private method:

```ts
/** Issue #174 (B2): after a selection gesture ends inside this overlay, copy
 * pi's final selection text into the X11 PRIMARY selection so the classic
 * select-then-middle-click-paste loop works in fullscreen. Runs on nextTick
 * because overlays are dispatched before TuiAltScreen finalizes the selection
 * for the same event. No-op in regular mode (no getActiveSelectionText) and
 * under the native-paste kill switch. */
private mirrorFullscreenSelectionToPrimary(): void {
	if (this.closed) return;
	const alt = this.tui as { getActiveSelectionText?: () => string | undefined };
	const text = alt.getActiveSelectionText?.();
	if (typeof text === "string" && text.length > 0) this.writePrimarySelection(text);
}
```

  (`writePrimarySelection` already guards `AGENT_BOARD_ATTACH_NATIVE_PASTE === "0"`;
  the decision helper guards the scheduling side — belt and suspenders, no behavior
  difference.)
- `pastePrimarySelection()`: the spawn args become
  `xclip -o -selection ${resolvePasteSelectionSource(process.env.AGENT_BOARD_ATTACH_PASTE_SOURCE)}`.
  Everything else (800 ms kill timer, forward-as-input, silent no-op) unchanged.

### Resulting behavior matrix

| Scenario | Behavior |
| --- | --- |
| fullscreen: drag-select inside attach → middle-click in attach | selection lands in PRIMARY (B2) AND CLIPBOARD (pi); middle paste = the selection ✅ |
| fullscreen: select in another X11 app → middle-click in attach | pastes that app's PRIMARY (unchanged, correct) |
| fullscreen: select elsewhere in pi (dashboard) → middle-click in attach | NOT mirrored (no event window) — known limitation; middle paste reads whatever PRIMARY holds |
| `AGENT_BOARD_ATTACH_PASTE_SOURCE=clipboard` | middle paste reads CLIPBOARD regardless of PRIMARY |
| `AGENT_BOARD_ATTACH_NATIVE_PASTE=0` | no mirror, no paste (kill switch governs both sides) |
| regular mode | mirror no-ops (no `getActiveSelectionText`), paste reads primary (default) — unchanged |

## Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 两个纯决策表（mirror 触发条件 × 开关；paste source 解析） | 自动化验证（unit） | `node --test test/pty-scroll.test.mjs`（新增用例直接调两个 helper：mirror 表全部行 + source 的 unset/"primary"/"clipboard"/garbage） | 新增用例全绿，既有用例不回归 |
| A2 | B2 接线：release/click(left) → nextTick 后 PRIMARY 收到 pi 的选中文本；observe 不消费；空选择不写；kill switch 不写 | 自动化验证（integration，组件级场景） | 新增 `test-support/pty-attach-selection-mirror-scenario.ts`（fake tui `mode:"fullscreen"` + `getActiveSelectionText` fixture + PATH-stub `xclip` 把 args/stdin 记日志），由 `test/pty-attach-selection-mirror.test.mjs` 运行断言 | ① `handleMouse({release,left})` 返回 `undefined` 且 nextTick 后 stub 日志含 `-selection primary` 写、stdin=fixture；② `getActiveSelectionText→undefined` 时无写；③ NATIVE_PASTE=0 无写；④ `press+left`/`move` 不触发 |
| A3 | C 接线：paste source 覆盖 | 自动化验证（integration，同一场景文件加 case） | 同场景：`AGENT_BOARD_ATTACH_PASTE_SOURCE=clipboard` + `handleMouse({press,middle})` | stub 日志显示 `-o -selection clipboard`；fixture 文本经 socket 以 `{type:"input"}` 发出（复用 #171 场景缝） |
| A4 | 类型与构建 | 自动化验证（static/build） | `npm run typecheck`、`npm run verify` | 全部通过 |
| A5 | 既有行为不回归（#171 中键粘贴、#169 ownership、regular 路径） | 自动化验证（unit+integration，既有套件） | `npm test` / `npm run test:coverage` | 既有测试全绿，覆盖阈值不降 |
| U1 | 真机：pi 内选中 → 中键粘贴闭环 | 用户实测 | ① fullscreen attach 内拖选一段文字；② 中键 → 应粘贴刚选的内容；③ 在别的 X11 应用选中 → 中键 → 粘贴该内容；④ `AGENT_BOARD_ATTACH_PASTE_SOURCE=clipboard` 后中键粘贴读剪贴板；⑤ `AGENT_BOARD_ATTACH_NATIVE_PASTE=0` 后中键无反应、选中不再镜像 PRIMARY | ①–⑤ 全部符合 |

## Testability split design (hard constraint for implementation)

- **Pure core**: `resolvePasteSelectionSource(value)` and
  `shouldMirrorSelectionToPrimary(event, {nativePasteEnabled})` — plain functions, no env
  reads inside, no side effects. Unit decision tables (A1).
- **I/O shell**: `PtyAttachComponent.handleMouse` maps decisions to side effects
  (`process.nextTick` scheduling → `mirrorFullscreenSelectionToPrimary()` → existing
  `writePrimarySelection`; paste branch spawns xclip with the resolved source).
  Component-level tests (A2/A3) drive only public seams (`handleMouse`, ticks,
  `dispose()`) and observe the PATH-stubbed `xclip` log + attach-socket messages; the
  stub handles both directions (`-o` prints a fixture; write mode records stdin/args).
- The pure helpers must not be re-inlined into the component; `handleMouse` must remain
  the only mirror scheduling point; `writePrimarySelection`/`pastePrimarySelection`
  remain the only xclip touch points.

## Risks / notes

- nextTick timing assumes pi's release handling is synchronous in the same tick (verified
  in tui-alt-screen.js: overlay dispatch → `handleSelectionMouseEvent` → copy, no awaits
  before selection state is final; `copySelectionToClipboard` is async but only writes
  CLIPBOARD — irrelevant to our read). If a future pi-tui defers selection state, the
  mirror lags one gesture — acceptable degradation, not corruption.
- `getActiveSelectionText` typing: structural cast in the component (declared private in
  pi-tui 1.1.0's `tui-alt-screen.d.ts` but runtime-reachable, hence the cast; absent on
  regular TUIs and old runtimes → optional access → no-op).
- Double-click word / triple-click line selections: press path sets the full range
  immediately; release/click mirror picks up the same text — covered by the same code
  path, no special casing.
- The stub-xclip scenario must restore PATH and clean temp dirs (self-contained).

## Deliverables

- `src/core/pty-scroll.mjs`: + `resolvePasteSelectionSource`, `shouldMirrorSelectionToPrimary`
- `src/ui/pty-attach.ts`: mirror branch in `handleMouse`, `mirrorFullscreenSelectionToPrimary()`,
  paste source in `pastePrimarySelection`
- `test/pty-scroll.test.mjs`: decision-table cases
- `test-support/pty-attach-selection-mirror-scenario.ts` + `test/pty-attach-selection-mirror.test.mjs`
- CHANGELOG entry via release tooling at release time (not in this PR)
