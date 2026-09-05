# Spec: issue #63 — runner.integration "manual completion" flaky

## Problem

`test/runner.integration.test.mjs` "runner does not clobber a manual completion
made during post-exit model passes" asserts `markCompleted()` returns
`{ok:true}` immediately after `endedAt` becomes visible in status.json. But
`runner/job-runner.mjs` `persist()` writes status.json **before** state.json
(no transaction). In the window between the two writes, `markCompleted` →
`completeView` still sees an active run (pid liveness via `loadRow` →
`isAgentBusy`) and rejects with
`{ok:false, error:'Wait for the active run to finish before marking done'}`.

CI caught this once on PR #60 (Node 24); rerun + 5 local runs passed. Pure
timing window, no behavior regression.

## Decision (issue option 1 — poll the assertion target itself)

Replace the one-shot assertion with a `waitFor` poll of `markCompleted` until
it returns `{ok:true}` (then assert the exact shape). The assertion then checks
**durability after success** rather than racing the exact call. The existing
`waitFor(fn, timeoutMs = 15000, intervalMs = 50)` helper is reused; default
15s timeout is ample (the race window is millisecond-scale: two evidence file
writes).

The durability assertions that are the actual behavior under test stay
unchanged: after the runner exits, `semanticState === "completed"` and
`autoState === null`.

## Non-goals

- No production code change (`runner/`, `src/` untouched) — test-only fix.
- No refactor of `persist()` write ordering (would change production behavior;
  the ordering is deliberate: endedAt converges first, see code comment).

## Acceptance matrix

| ID | Feature point | Acceptance | Concrete verification | Pass criteria |
|----|---------------|------------|----------------------|---------------|
| A1 | Test no longer asserts `markCompleted` return immediately after `endedAt` visibility | Automated (unit/integration) | Inspect diff: one-shot `assert.deepEqual(createService(...).markCompleted(...), {ok:true})` replaced by waitFor-poll + shape assert | Code review of diff; no immediate assert after `endedAt` waitFor remains |
| A2 | Flaky assertion semantics preserved | Automated (integration) | `npm test` (node --test, the runner.integration test itself) | Test passes; durability asserts (`semanticState === "completed"`, `autoState === null`) unchanged in diff |
| A3 | Suite stability (the CI flake mode) | Automated (integration) | 10 consecutive full `npm test` runs | All 10 green, zero flakes |
| A4 | No production behavior change | Automated (static) | `git diff main --stat` in PR | Only `test/runner.integration.test.mjs` modified |

## Testability split design

Test-only change; no new production functions. The poll helper (`waitFor`)
already exists and is exercised by every other use in the file — no new test
boundary introduced.
