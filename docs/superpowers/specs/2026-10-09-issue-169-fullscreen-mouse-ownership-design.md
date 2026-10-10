Drafted: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-10-09T12:49:41Z

# Spec: #169 — detaching from a PTY attach view kills outer-terminal mouse reporting for the rest of the fullscreen session

Status: DRAFT (awaiting spec-cross-review, then user approval — github-issue-driven step 4 gates)
Issue: https://github.com/zhuxixi/pi-agent-board/issues/169
Repo state baseline: main @ `fee345c` (post-#171)

## Problem (root cause, verified from source)

In fullscreen mode (pi ≥1.0 default) `TuiAltScreen` owns outer-terminal mouse reporting:
it writes the enable set `?1000h?1002h?1003h?1004h?1006h` exactly once in
`beforeTerminalStart` (pi-tui 1.1.0 `tui-alt-screen.js:194`) and disables it only at
`beforeTerminalStop` (:196-206); there is no re-assert path. `PtyAttachComponent` nonetheless
manages the outer terminal's mouse mode itself — ctor writes
`MOUSE_DISABLE`+`MOUSE_ENABLE` (downgrading `?1003h`/`?1004h`), and `close()` writes
`MOUSE_DISABLE` unconditionally (src/ui/pty-attach.ts:278-280, :1524 via
`disableMouseScroll` :882 — which, unlike `enableMouseScroll`, has no env guard). After
the first detach, pi-tui still believes mouse is on but the terminal stopped sending
events: fullscreen selection / copy-on-select / wheel / click regions are dead until pi
restarts. In regular mode the same writes are correct (board is the sole mouse owner).

Full evidence: `research/2026-10-09-fullscreen-mouse-ownership.md`,
`research/2026-10-09-repo-state-and-testability.md` in this directory.

## Goal / non-goals

**Goal**: in fullscreen mode the attach component performs **zero** outer-terminal
mouse-mode writes for its entire lifecycle (ctor, refresh timers, connect, resize,
close) — `TuiAltScreen` owns the mode and its full `?1003h/?1004h` set survives
attach AND detach. Regular-mode behavior (including the
disable→enable→refresh pairing and the kill-switch semantics) is unchanged. Old pi
runtimes without `tui.mode` keep today's (regular) behavior.

**Non-goals**:
- X11 PRIMARY mirroring of the fullscreen-native selection (deferred with #167).
- Any pi-tui change or new re-assert API (unnecessary).
- Wheel/scroll/selection behavior inside attach views (unchanged by design: deferred
  wheel still reaches `handleInput`; clicks via `handleMouse` from #171).
- #170 (reply guard), #168 (session resume) — unrelated paths.

## Design

### 1. Pure decision helper (new, `src/core/pty-scroll.mjs` — mouse helpers live here)

```js
/**
 * Issue #169: whether the attach surface should manage the OUTER terminal's mouse
 * mode. Only in regular TUI mode — in fullscreen, TuiAltScreen owns mouse reporting
 * (asserted once at startup, never re-asserted), so any write from here can only
 * downgrade or kill it. Old runtimes without tui.mode behave as regular.
 * Pure: mode and the env-derived flag are resolved at the call site.
 */
shouldOwnOuterMouseMode(mode, mouseEnabled) → boolean   // mode !== "fullscreen" && mouseEnabled
```

### 2. Component gating (`src/ui/pty-attach.ts`)

All outer-terminal mouse writes funnel through exactly two private methods —
`enableMouseScroll()` (:852) and `disableMouseScroll()` (:882). Gate both:

```ts
private ownsOuterMouseMode(): boolean {
	return shouldOwnOuterMouseMode(this.tui.mode, this.mouseScrollEnabled());
}
```

- `enableMouseScroll()`: early-return `if (!this.ownsOuterMouseMode())` (replaces the
  current `mouseScrollEnabled()` check; also gates the `XTSHIFTESCAPE_SELECT` write).
- `disableMouseScroll()`: early-return `if (!this.ownsOuterMouseMode())` (new guard —
  fixes both the fullscreen teardown kill and the flagged unguarded disable under
  `AGENT_BOARD_ATTACH_MOUSE=0`).
- `refreshMouseScrollMode()` keeps its `mouseScrollEnabled()` early-return (cheap) and
  its timers call the now-gated `enableMouseScroll` — no other call-site changes
  (ctor :278-280, connect :487, resize :1203, close :1524 all route through the two
  choke points).
- Comment on `ownsOuterMouseMode()` noting `tui.mode` is typed non-optional but may be
  absent on old runtimes — strict inequality handles it.

### Resulting behavior matrix

| tui.mode | AGENT_BOARD_ATTACH_MOUSE | ctor/connect/resize writes | close() write | fullscreen session after detach |
| --- | --- | --- | --- | --- |
| fullscreen | any | none | none | mouse alive (BUG FIXED) |
| regular / undefined (old runtime) | on (default) | today's pairing | MOUSE_DISABLE | n/a (unchanged) |
| regular / undefined | off | none | none | n/a (also fixes unguarded-disable defect) |
| fullscreen (host built with TuiAltScreenOptions.mouse: false) | n/a | none | none | consistent: host explicitly disabled mouse; nothing owns it — attach-view mouse features inert by host choice |

## Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 鼠标模式所有权决策表（mode × env 开关） | 自动化验证（unit） | `node --test test/pty-scroll.test.mjs`（新增用例直接调 `shouldOwnOuterMouseMode`，覆盖 6 格：fullscreen×on/off、regular×on/off、undefined×on/off） | 新增用例全绿，现有点击/滚轮/中键用例不回归 |
| A2 | fullscreen 全生命周期零外层鼠标写；regular 配对保留；kill switch 零写 | 自动化验证（integration，组件级场景） | 新增 `test-support/pty-attach-mouse-mode-scenario.ts`（fake tui 的 `terminal.write` 采集字节 + `mode` 可控 + 不可达 socketPath），由 `test/pty-attach-mouse-mode.test.mjs` 以 `node --experimental-transform-types` 运行断言 JSON 输出 | ① `mode:"fullscreen"`：ctor+250ms 刷新窗+close 全程 0 个 `?1000/?1002/?1003/?1004/?1006/XTSHIFTESCAPE` 写；② `mode:"regular"`：ctor 有 `MOUSE_ENABLE`、close 有 `MOUSE_DISABLE`；③ regular+`AGENT_BOARD_ATTACH_MOUSE=0`：全程 0 写（含 close）；④ 无 `mode` 字段的 fake tui 行为同 regular |
| A3 | 类型与构建 | 自动化验证（static/build） | `npm run typecheck`、`npm run verify`（含 pack:dry） | 全部通过 |
| A4 | 既有行为不回归（含 #171 中键粘贴场景） | 自动化验证（unit+integration，既有套件） | `npm test` / `npm run test:coverage` | 既有测试全绿，覆盖阈值不降 |
| U1 | 真机：detach 后外层鼠标存活 | 用户实测 | ① pi ≥1.0 fullscreen → `/agent-board` → attach → detach（ctrl+\）；② dashboard 里拖选文字 → 应高亮且 copy-on-select 生效；③ 滚轮/点击区域正常；④ attach 中 pi 自身全屏选中/复制正常（`?1003h/?1004h` 不再被降级）；⑤ `pi --tui-mode regular` 下 attach→detach 行为与从前一致 | ①–⑤ 全部符合；修复前 ①③④ 在 detach 后失效 |

## Testability split design (hard constraint for implementation)

- **Pure core**: `shouldOwnOuterMouseMode(mode, mouseEnabled)` — plain function, no env
  reads inside (both args resolved at the call site). Unit-tested decision table (A1).
  Test boundary: `src/core/pty-scroll.mjs` exports; tests import only this.
- **I/O shell**: `PtyAttachComponent.ownsOuterMouseMode()` reads `this.tui.mode` +
  `this.mouseScrollEnabled()` and delegates to the pure helper; the two write methods
  keep ALL terminal writes. Component-level tests (A2) drive only public seams
  (constructor, time, `dispose()`) and observe `terminal.write` bytes of a fake tui —
  no test-only constructor options, no reading private state.
- The pure helper must not be re-inlined into the component; the two choke-point methods
  must remain the only places that write mouse-mode/XTSHIFTESCAPE sequences.

## Risks / notes

- A2 uses an unreachable socketPath to keep the scenario runner-free; if the ctor's
  connect-error path proves non-deterministic for the write-spy assertions, fall back to
  the #171-style real-runner scenario asserting the same facts around a real
  attach/detach (decision at plan time; record whichever is used).
- Existing scenarios' fake tuis have no `mode` field → they stay on the regular path and
  don't assert terminal bytes → unaffected by the gating.
- `AGENT_BOARD_ATTACH_MOUSE` semantics in fullscreen become moot (no writes either way);
  document in the behavior matrix rather than redefining the switch.

## Deliverables

- `src/core/pty-scroll.mjs`: + `shouldOwnOuterMouseMode`
- `src/ui/pty-attach.ts`: + `ownsOuterMouseMode()` private method; guards in
  `enableMouseScroll` / `disableMouseScroll`
- `test/pty-scroll.test.mjs`: decision-table cases
- `test-support/pty-attach-mouse-mode-scenario.ts` + `test/pty-attach-mouse-mode.test.mjs`
- CHANGELOG entry via release tooling at release time (not in this PR)
