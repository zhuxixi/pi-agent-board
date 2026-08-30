# Spec: fix deterministic post-exit test failure after #43 (issue #46)

## Problem

`test/runner.integration.test.mjs` → `runner does not clobber a manual completion
made during post-exit model passes` fails deterministically on Node 24 since
#43 (`ffc2c8c`). Upstream `main` CI is red (`e14cc41`, `ffc2c8c`) and blocks
subsequent PRs (#44).

## Root cause (research: `~/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-46/`)

#43 added a synchronous `updateCodeRefsFromEvidence()` call (git subprocesses,
hundreds of ms) into `runner/job-runner.mjs`'s `persist()` chain, widening two
pre-existing race windows:

### Window 1 — `markCompleted` rejected (CI failure point)
`persist()` order: `writeStatus` (endedAt visible) → `updateCodeRefsFromEvidence`
(slow) → `writeState` (semanticState converges). The test sees `endedAt` while
`state.json` is still `working`; the runner process is still alive
(`pid.json` records the runner pid) → `isAgentBusy(row)` → `markCompleted`
returns `'Wait for the active run to finish before marking done'`.

### Window 2 — manual completion clobbered (the actual bug)
`finalizeSemanticState` (`src/core/derive.mjs:33`) returns `"idle"` for a clean
worker exit. `applyHeuristicAutoState` (`runner/job-runner.mjs:360`) calls
`applyAutoStateToStatus` with the **in-memory** status; `isManualCompletion`
requires `semanticState === "completed"` (it is `"idle"`), so the guard does not
fire and the post-exit heuristic classification (`in_progress`, since
`autoStateDoneDisabled()` defaults to true) overwrites the manual completion —
`state.json` becomes `idle` + `autoState: {kind: "in_progress"}`.
`maybeModelAutoState` has a fresh-read guard for this exact case;
`applyHeuristicAutoState` does not.

## Fix (minimal, four changes in `runner/job-runner.mjs`)

### Change 1 — persist order
Move `writeState` before `updateCodeRefsFromEvidence` inside `persist()`:
```js
writeStatus(root, status);
writeRunEvidence(root, evidence);
writeEvidence(root, evidence);
writeState(root, projectViewState(status, now, readState(root, viewId)));
updateCodeRefsFromEvidence(root, viewId, evidence, meta);
```
Semantics unchanged (code-refs extraction depends only on evidence + git).
Verified experimentally: markCompleted assertion passes again.

### Change 2 — heuristic persist goes through persistUnlessManual
In the close handler, the `applyHeuristicAutoState` branch's `persist(true)`
becomes `persistUnlessManual(true)` so a manual completion racing the
heuristic classification is not overwritten. `persistUnlessManual` checks
`isManualCompletion(readState(...))` (state.json — the only place
`completeView` writes the `completed` + `autoState: null` signal; it only
clears autoState in status.json) before writing.

### Change 3 — applyHeuristicAutoState manual-completion guard
Skip classification when state.json shows a manual completion, so the
in-memory status isn't mutated in a way a later drain/persist could replay
over the user's verdict:
```js
const latestState = readState(config.root, config.viewId);
if (isManualCompletion(latestState)) return false;
```

### Change 4 — drainQueuedFollowUp / finalizeSteeringIfNeeded guards
`drainQueuedFollowUp` (follow-up runs) and `finalizeSteeringIfNeeded`
(plan approval resurrection) both early-return on
`isManualCompletion(readState(...))` so the exit chain never starts new
work or resurrects a row the user just manually completed.

## Non-goals
- No changes to #44/#45 code (windowsHide / control socket)
- No handling of Windows-local EPERM cleanup noise (environment-only)
- No auto-state state machine refactor

## Verification
1. clobber test ≥3× on Node 24: all pass (assertion part)
2. Full `test/runner.integration.test.mjs`: failure set not worse than baseline
3. `npm run typecheck` if present
4. CI green (Node 22/24) after merge
