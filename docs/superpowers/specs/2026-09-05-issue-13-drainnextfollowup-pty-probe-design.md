# Spec: issue #13 — drainNextFollowUp forces PTY probe refresh on the 700ms poll path

## Problem

`src/runtime/service.mjs` `drainNextFollowUp` (L496) calls
`ptySupport({ refresh: true })` and is reachable from the 700ms `reconcile()`
poll (L1007-1011: queued follow-up + `canAutoDrain` → `drainNextFollowUp`).
When a queued follow-up repeatedly fails to start, every poll cycle forces a
fresh PTY probe — `ptySpawnSupported` does a **real `pty.spawn`** process.
This violates the probe-cache discipline (`shouldProbePtySupport`): success
cached for process lifetime, failures retried on a 2s TTL; only `refresh`
bypasses it.

`dispatch` (L616) and `reply` (L649) also use `refresh: true` but are explicit
user actions — fine as-is, untouched.

## Decision (issue's fix sketch, verbatim)

Replace in `drainNextFollowUp`:

```js
const pty = ptySupport({ refresh: true });
```

with default cached-probe semantics:

```js
const pty = ptySupport();
```

Plus a red-green test asserting the injected `ptySupport` never receives
`refresh: true` from the reconcile→drain path (pattern from PR #12's service
test "ensureHost probes PTY support with TTL cache, not forced refresh",
test/service.test.mjs:940).

## Behavior contract

- Poll-path drains use the cache: after a successful probe, zero further real
  spawns; after a failed probe, at most one real spawn per 2s window.
- Explicit user actions (`dispatch`, `reply`) keep forced refresh.
- No other behavior change in drain logic (claim/launch/complete paths
  untouched).

## Non-goals

- No change to `dispatch`/`reply` refresh semantics.
- No change to `ptySpawnSupported`/`shouldProbePtySupport` internals.

## Acceptance matrix

| ID | Feature point | Acceptance | Concrete verification | Pass criteria |
|----|---------------|------------|----------------------|---------------|
| A1 | reconcile→drain path never forces probe refresh | Automated (unit) | New test in `test/service.test.mjs`: idle row + queued follow-up → `svc.reconcile()` → injected ptySupport spy records opts; assert `probeCalls.length >= 1` and no call has `refresh === true` | New test passes; fails (red) if production line keeps `refresh: true` |
| A2 | Explicit user actions unaffected | Automated (unit) | Existing service tests (dispatch/reply paths) green in full suite | `npm test` all green |
| A3 | Full regression | Automated (integration) | Full `npm test` | All pass |
| A4 | Change scope | Automated (static) | `git diff main` review | Production delta is exactly the one-line probe switch in `src/runtime/service.mjs`; test delta is one new test |

## Testability split design

Test-only seam already exists: `createService` opts inject `ptySupport`
(spy) and `launch` (fake, avoids real spawn). The new test drives the public
`reconcile()` API so the exact poll path is covered. Row state constructed
via `readState`/`writeState` (idle + exited) so `canAutoDrain` holds. No new
production functions.
