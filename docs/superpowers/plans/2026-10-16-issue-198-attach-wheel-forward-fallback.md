# Plan — issue #198 attach wheel forward-fallback

- Spec: `docs/superpowers/specs/2026-10-16-issue-198-attach-wheel-forward-fallback-design.md` (acceptance IDs from its §5)
- Worktree: `.pi/worktrees/issue-198-attach-wheel-forward-fallback` on branch `issue-198-attach-wheel-forward-fallback` (base `main` @ `eab48d0`)
- Flow note: same degradation as #185 — direct implementation in the parent session (the `subagent` tool is unavailable there), TDD discipline kept (red → green).

## Tasks

### T1 — production-topology regression test (A1, integration) — **red first**
- Add `FAKE_PTY_STREAM_MODE=alt-flood` to `test-support/fake-pty-pi.mjs`: one-shot `\x1b[?1049h`, then absolute-positioned frames (no newline past the last row) fast enough to pass 130 KB before the attach connects.
- New `test-support/pty-attach-wheel-fallback-scenario.ts` + `test/pty-attach-wheel-fallback.test.mjs`: pin `buffer.type === "normal"` and local room `0`, then require the wheel to be forwarded.

### T2 — implementation (A1)
- `src/ui/pty-attach.ts` `handleMouse` wheel branch: `route === "none"` → `undefined`; `"local"` + `tryScrollBy` → handled; otherwise ( `"child"`, or `"local"` that cannot move) forward when connected, else `undefined`. Comments cite #183/#185/#198.

### T3 — keep branch coverage honest (A2, A3)
- Remove the per-tick `?1049h` re-assertion from the `alt` fixture mode (it masked this bug) and force the legacy replay path in that scenario (`AGENT_BOARD_TERMINAL_SNAPSHOT=0`), documenting the premise in the header; restore the env afterwards.
- Update #183's scenario comment + assertion message to the new meaning (disconnected half of the rule).

### T4 — docs (A6)
- Rewrite the `README.md` PTY-attach wheel sentence to the parity rule.

### T5 — gate (A4, A5)
- `npm test`, then `npm run verify` (typecheck, perf gate, tests, coverage, pack:dry).

### T6 — user verification (U1, post-merge)
- Merge → `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board pull --ff-only` → restart pi → wheel vs `PageUp`/`PageDown` in a real session (this time the production topology is what the new scenario encodes, so the local gate is meaningful).

## Out of scope

- Conveying the alternate-screen flag through the runner's terminal model / snapshot DTO (correctness no longer depends on it).
- Any change to middle-click, selection mirroring, kill switches, or `AGENT_BOARD_WHEEL_LINES` semantics.
