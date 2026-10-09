# Spec: #167 — middle-click paste in attach views under pi ≥1.0 fullscreen TUI

Status: DRAFT (awaiting user approval — github-issue-driven step 4 gate)
Issue: https://github.com/zhuxixi/pi-agent-board/issues/167
Date: 2026-10-09

## Problem (root cause, verified)

pi ≥1.0 defaults to fullscreen TUI. `TuiAltScreen` parses and consumes all SGR mouse
sequences itself; overlays receive mouse only through the normalized `handleMouse(event)`
API. `PtyAttachComponent` implements only the legacy `handleInput(data)` path, so its
middle-click paste (`pastePrimarySelection()`, commit a1c5f08) never runs in fullscreen.
Regular mode (`pi --tui-mode regular`) is unaffected. Evidence: pi-tui 1.1.0
`tui-alt-screen.js:520-526`, `tui.js:507-532`; research notes in
`~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-167/research/`.

## Goal / non-goals

**Goal**: middle-click inside the attach view pastes the X11 PRIMARY selection into the
hosted session in fullscreen mode, with the same semantics and escape hatch as regular
mode; regular mode behavior unchanged.

**Non-goals** (explicitly deferred):
- X11 PRIMARY *mirroring* of selections made in fullscreen (pi's own fullscreen selection
  writes CLIPBOARD, not PRIMARY). Taking over left-button events would displace pi's
  fullscreen selection — needs its own design (follow-up).
- #169 (attach teardown disabling outer-terminal mouse reporting) — separate issue/PR.
- Any wheel behavior change (today's defer-to-overlay fallback keeps working; we return
  `undefined` for wheel).

## Design

### 1. Pure decision helper (new, `src/core/pty-scroll.mjs` — same module that owns
`parseMouseInputChunk`)

```js
// Returns the attach-surface action for a normalized pi-tui mouse event.
// "paste-primary": read X11 PRIMARY and forward as input (middle-click paste).
// null: not ours — let the event fall through untouched (today's behavior).
resolveAttachMouseAction(event, { nativePasteEnabled }) → "paste-primary" | null
```

Decision table (`event.type`, `event.button`, `nativePasteEnabled`):

| type | button | nativePasteEnabled | result |
| --- | --- | --- | --- |
| press | middle | true | `"paste-primary"` |
| press | middle | false | `null` (kill switch = today's silent drop) |
| press/release/click | left/right/none | * | `null` (pi fullscreen selection & default behavior untouched) |
| wheel | any | * | `null` (existing defer-to-`handleInput` path preserved) |
| move/drag | any | * | `null` |

`nativePasteEnabled` is computed once per call site from
`process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE !== "0"` (same rule as `pastePrimarySelection`).

### 2. Component wiring (`src/ui/pty-attach.ts`)

```ts
handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
	const action = resolveAttachMouseAction(event, {
		nativePasteEnabled: process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE !== "0",
	});
	if (action === "paste-primary") {
		this.clearPendingClick();
		this.clearSelection();
		this.pastePrimarySelection();
		return { handled: true, render: false };
	}
	return undefined;
}
```

- `{ handled: true }` stops propagation and suppresses alt-screen fallback for that
  press; `render: false` because a successful paste repaints via child output (async)
  and a failed one (no xclip) needs no repaint.
- Legacy `handleInput` raw path stays exactly as is — regular mode and wheel keep working.
- No changes to outer-terminal mouse-mode writes (`MOUSE_ENABLE`/`MOUSE_DISABLE`) — #169.

### 3. devDependencies bump (enabling task)

Bump `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` devDeps 0.79.8 → 1.1.0
(match the runtime the extension actually runs under). Gate: `npm run typecheck` +
`npm run verify` green. If unrelated type breakage from 0.79.8→1.1.0 turns out to be large,
fallback: keep 0.79.8 and declare local structural `TuiMouseEvent`/result types in the
component — decision point recorded in the plan; the bump is the preferred path.

## Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 决策表：哪些归一化鼠标事件触发中键粘贴 | 自动化验证（unit） | `node --test test/pty-scroll.test.mjs`（新增用例直接调 `resolveAttachMouseAction`，覆盖决策表全部行 + `AGENT_BOARD_ATTACH_NATIVE_PASTE=0`） | 新增用例全绿，且现有点击/滚轮用例不回归 |
| A2 | 组件接线：`PtyAttachComponent.handleMouse` 中键 press → 读 PRIMARY → 作为 input 发往 attach socket；kill switch 时返回 undefined | 自动化验证（integration，组件级场景） | 新增 `test-support/pty-attach-mouse-scenario.ts`（仿 `pty-attach-protocol-scenario.ts`：fake tui + stub-`xclip` 目录 prepend PATH 打印 fixture 文本），由 `test/pty-attach-mouse.test.mjs` 以 `node --experimental-transform-types` 运行并断言 JSON 输出 | ① 中键 press 返回 `{handled:true}` 且 socket 收到 `{type:"input",data:fixture}`；② 同场景 legacy `handleInput` 注入 SGR 中键序列行为一致（regular 路径回归）；③ `AGENT_BOARD_ATTACH_NATIVE_PASTE=0` 时 `handleMouse` 返回 undefined 且无 input 发出 |
| A3 | 类型与构建在 pi-tui 1.1.0 下成立 | 自动化验证（static/build） | `npm run typecheck`、`npm run verify`（含 pack:dry） | 全部通过，无 0.79.8→1.1.0 引入的未处理类型错误 |
| A4 | 全部既有行为不回归 | 自动化验证（unit+integration，既有套件） | `npm test` / `npm run test:coverage` | 既有测试全绿，覆盖阈值不降 |
| U1 | 真实终端里 fullscreen 中键粘贴生效 | 用户实测 | ① pi 1.1.0 fullscreen → `/agent-board` → attach；② 在别的 X11 应用选中一段文字；③ 在 attach 视图内中键 | 子 session 收到粘贴文本并有反应；同机 `pi --tui-mode regular` 行为不变；`AGENT_BOARD_ATTACH_NATIVE_PASTE=0` 后中键回到无反应 |

## Testability split design (hard constraint for implementation)

- **Pure core**: `resolveAttachMouseAction(event, {nativePasteEnabled})` — plain function,
  no I/O, no env reads inside (env read at call site). Unit-tested decision table (A1).
  Test boundary: `src/core/pty-scroll.mjs` exports; tests import only this.
- **I/O shell**: `PtyAttachComponent.handleMouse` maps action → `pastePrimarySelection()`
  (existing xclip spawn) + result object. Tested at component level (A2) through public
  seams only: `handleMouse`/`handleInput` in, fake tui terminal writes + attach-socket
  messages out, `xclip` stubbed via PATH. No test-only constructor options.
- The pure function must not be re-coupled into the component (no inline decision logic).

## Risks / notes

- devDep bump may expose type breakage elsewhere (0.79.8 typings vs 1.1.0). Contained by
  A3 as its own task; fallback documented above.
- `AGENT_BOARD_ATTACH_MOUSE=0` does not disable the new path (it governs outer-terminal
  mode writes only); in fullscreen the alt screen owns reporting regardless. Documented
  here as intended.
- Behavior when xclip is absent: unchanged silent no-op (existing contract), but the
  event is still consumed (`handled:true`) — same as regular mode today.

## Deliverables

- `src/core/pty-scroll.mjs`: + `resolveAttachMouseAction`
- `src/ui/pty-attach.ts`: + `handleMouse`
- `package.json`: devDeps bump (pi-tui, pi-coding-agent → 1.1.0)
- `test/pty-scroll.test.mjs`: decision-table cases
- `test-support/pty-attach-mouse-scenario.ts` + `test/pty-attach-mouse.test.mjs`
- CHANGELOG entry via release tooling at release time (not in this PR)
