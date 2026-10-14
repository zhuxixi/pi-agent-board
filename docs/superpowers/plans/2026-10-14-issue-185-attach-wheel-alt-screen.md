# Plan — issue #185: attach wheel forwarding for alternate-screen children

- Spec: `docs/superpowers/specs/2026-10-14-issue-185-attach-wheel-alt-screen-design.md` (acceptance IDs refer to its §5 matrix)
- Worktree: `.pi/worktrees/issue-185-attach-wheel-alt-screen` on branch `issue-185-attach-wheel-alt-screen` (base `main` @ `f81949d5`)
- Flow note: `subagent-driven-development` is degraded to direct implementation in the parent session — the `subagent` tool is unregistered in the workflow session (recorded in the issue-185 research state). TDD discipline (red → green per task) is kept.

## Tasks

### T1 — pure helpers (A1, unit)

1. Add failing tests to `test/pty-scroll.test.mjs`:
   - `resolveAttachWheelRoute`: `{alternate, 3, true}` → `"child"`; `{normal, 3, true}` → `"local"`; `{normal, 3, false}` → `"none"`; `{normal, 0, true}` → `"none"`.
   - `encodeWheelReport`: `("up", {col:5,row:3})` → `"\x1b[<64;5;3M"`; `("down", …)` → `65`; `col:0/row:0/NaN` → clamp/sanitize to 1.
2. Implement both in `src/core/pty-scroll.mjs` next to `wheelScrollLinesUp()` (spec §3.3 contracts).
- Verify: `node --test test/pty-scroll.test.mjs` → green. Red first (helpers absent).

### T2 — alternate-buffer branch (A2, A4, integration)

1. Add the additive `alt` mode to `test-support/fake-pty-pi.mjs` (`\x1b[?1049h` + `\x1b[H\x1b[2Kalt-frame-<n>` ticks, 25 ms).
2. New `test-support/pty-attach-alt-wheel-scenario.ts` (fake TUI with `mode: "fullscreen"`, real runner, `Socket.prototype.write` interception) + `test/pty-attach-alt-wheel.test.mjs`:
   - wheel up `{type:"wheel", wheelDelta:-3, x:3, y:3}` → `{handled:true, render:false}`; forwarded `{"type":"input","data":"\x1b[<64;4;3M"}`; `viewportTop` stays `null`; buffer type is `alternate`.
   - wheel down → `65` report.
   - `AGENT_BOARD_ATTACH_MOUSE=0` and `AGENT_BOARD_ENABLE_MOUSE_SCROLL=0` → `undefined`, no new `{type:"input"}`.
   - wheel without `wheelDelta` → `undefined`, no forward.
3. Implement in `src/ui/pty-attach.ts`: import the two helpers; route the wheel branch per spec §3.1 (`"child"` → clear selection/pending click, forward one report, return handled; `"local"` → `tryScrollBy` as today; else `undefined`), plus `forwardWheelToChild()` (coordinate mapping spec §3.2).
- Verify: `node --test test/pty-attach-alt-wheel.test.mjs` → green. Red first (no forwarding today).

### T3 — regression sweep (A3, A5)

- `npm test` — must stay green: `pty-attach-wheel` (#183 assertions unchanged, incl. `atBottomFallsThrough === true`), `pty-attach-mouse`, `pty-attach-mouse-mode`, `pty-attach-selection-mirror`.

### T4 — docs (A7)

- `README.md:201`: replace "…and the mouse wheel scroll local scrollback" with wording that matches `PageUp`/`PageDown` parity (local scrollback when it exists; otherwise forwarded so the child scrolls its own viewport).
- Verify: `rg -n "mouse wheel" README.md` → the sentence no longer promises local-only scrolling.

### T5 — full gate (A6)

- `npm run verify` (typecheck, perf gate, tests, coverage thresholds lines 85 / funcs 80 / branches 70, pack:dry).

### T6 — user verification (U1–U3, post-merge; cannot be claimed in this PR)

- U1 wheel == PageUp/PageDown in a real fullscreen attach; U2 middle-click paste + drag-select; U3 global `tuiMode: regular` smoke. Executable after merge → `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board pull --ff-only` → pi restart. Recorded as `pending` on the issue at PR time.

## Out of scope

Normal-buffer boundary fall-through (#183 contract), `AGENT_BOARD_WHEEL_LINES` semantics, horizontal wheel, pi-tui changes — per spec §7.
