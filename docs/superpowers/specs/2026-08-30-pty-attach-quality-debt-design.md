# Spec: pty-attach.ts legacy quality debt cleanup (issue #8)

- **Date**: 2026-08-30
- **Issue**: zhuxixi/pi-agent-board#8
- **Type**: chore — zero behavior change (comments + signature trim only)
- **Status**: draft, awaiting user approval

## Background

pi-lens flagged 10 legacy quality issues in `src/ui/pty-attach.ts` on 2026-08-21
(upstream original author's style, pre-existing). The issue tracked them for
separate cleanup so they wouldn't pollute feature PRs. Since then, #45 and #48
modified the file, so every line number in the issue has drifted. A fresh scan
of current main (1324 lines) found:

- **9 empty `catch {}` blocks** (issue said 8): L484, 510, 724, 745, 755, 766,
  924, 951, 1010
- **1 `as unknown as` cast without a SAFETY comment**: L795 (`currentSize()`)
- **1 unused parameter**: L970 (`project(height, width)` — `width` never read)

Two other catches are out of scope: L902 (`onSocketData`, multi-line catch with
an explanatory comment) and L1048 (`openExternalTarget`, catch returns `false`).

## Goals

1. Every empty catch documents *why* silence is correct (intentional vs forgot).
2. The as-cast states the invariant that makes it safe.
3. No unused parameters in `project()`.
4. Zero behavior change: no logic, no logging, no reformatting beyond the edits.

## Non-goals

- No logging infrastructure (no logger is imported in pty-attach today; these
  failures have no consumer; `forwardTerminalProtocols` runs at frame frequency
  and would spam).
- No changes outside `src/ui/pty-attach.ts`.
- No touching L902/L1048 (already documented/behavioral).
- No drive-by refactors of nearby code.

## Decision: empty catches stay silent + explanatory comment (Option A)

Rejected alternative (Option B): debug-level logging — needs new UI-layer log
plumbing, has no consumer, and high-frequency paths would flood output.

Precedent in this repo: `dashboard.ts` uses `/* best effort: stats must never
block dispatch */` style comments for the same pattern.

Per-site comment text (implementation is mechanical):

| Line | Method | Failure tolerated | Comment to add |
|------|--------|-------------------|----------------|
| 484 | `enableMouseScroll()` | `terminal.write(XTSHIFTESCAPE/MOUSE_ENABLE)` | `/* best-effort: some terminals reject these sequences; mouse reporting is optional */` |
| 510 | `disableMouseScroll()` | `terminal.write(MOUSE_DISABLE)` | `/* best-effort: terminal may already be gone at teardown */` |
| 724 | `copySelectionToClipboard()` | OSC52 write | `/* best-effort: OSC52 clipboard support is optional */` |
| 745 | `pastePrimarySelection()` inner timer | `child.kill("SIGKILL")` | `/* the child may have already exited before the timeout fired */` |
| 755 | `pastePrimarySelection()` outer | `spawn("xclip")` | `/* silent no-op when xclip is absent — documented contract of this helper */` |
| 766 | `writePrimarySelection()` | `spawn("xclip")` | `/* silent no-op when xclip is absent */` |
| 924 | `forwardTerminalProtocols()` | per-sequence `terminal.write` | `/* best-effort: forwarded sequences are enhancements, never critical */` |
| 951 | `replayScreenLog()` | screen.log read/replay | `/* best-effort: a missing or racing screen.log must not block attach */` |
| 1010 | `close()` | `socket.destroy()` | `/* best-effort teardown: socket may already be destroyed */` |

## Decision: SAFETY comment for the as-cast (L795)

`currentSize()` reads `this.tui.terminal as unknown as { cols?: number;
columns?: number; rows?: number } | undefined`. Comment to add above the line:

```
// SAFETY: duck-typed read — Pi TUI's Terminal type does not consistently expose
// cols/columns/rows across versions (see resizeIfNeeded below). Runtime
// fallbacks (120/24) keep this safe when the fields are absent.
```

## Decision: delete `width` param (not `_` prefix)

`private project(height: number, width: number)` → `private project(height: number)`;
single call site L271 `this.project(bodyHeight, width)` → `this.project(bodyHeight)`.
Deleting is cleaner than `_width`: private method, exactly one caller, no
interface stability concerns.

## Verification

1. `npm run typecheck` — clean.
2. `npm test` — all pass (attach-related suites must stay green).
3. `grep -n "catch {}" src/ui/pty-attach.ts` — still 9 hits, each immediately
   preceded by a comment line.
4. `grep -n "project(" src/ui/pty-attach.ts` — signature and call site both
   single-arg.
5. Coverage thresholds unaffected (comments + signature trim don't move lines/funcs/branches).

## Risks & mitigations

- **Line drift vs this spec**: implementation re-locates sites by method name
  (as in the table), not by line number.
- **Untracked files in main checkout** (`scratch/`, `test-support/*`,
  `test/pty-attach-*.test.mjs`): all work happens in a worktree; staging is
  per-file, never `git add -A`.
- **Zero-behavior guarantee**: no statement is added/removed except the param
  deletion and its call-site argument; review diff must show comments + two-line
  signature/call-site change only.

## Rollout

- Worktree: `issue-8-pty-attach-quality-debt` (from main).
- Spec lands in worktree `docs/superpowers/specs/2026-08-30-pty-attach-quality-debt-design.md`
  as the first commit, then plan → implement → local CR → PR.
