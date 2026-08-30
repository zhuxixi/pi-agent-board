# Plan: fix post-exit timing test failure (issue #46)

Branch: `issue-46-post-exit-timing` · Worktree: `.pi/worktrees/issue-46-post-exit-timing`
Spec: `docs/superpowers/specs/2026-08-30-post-exit-timing-fix-design.md`

## Task 1 — persist() order in `runner/job-runner.mjs`
Move `updateCodeRefsFromEvidence(root, viewId, evidence, meta)` to **after**
`writeState(...)` inside the `persist()` closure (line ~100-108).
- Verify: `git diff` shows only the reordering in `persist()`.

## Task 2 — fresh-read guard in `applyHeuristicAutoState` (`runner/job-runner.mjs`)
Add before the classification logic (function at ~line 360):
```js
const fresh = readStatus(config.root, config.viewId, config.runId);
if (fresh && isManualCompletion(fresh)) return false;
if (fresh) Object.assign(status, fresh);
```
`readStatus` is already imported in the file (used by `maybeModelAutoState`).
- Verify: `git diff` shows only this function's guard added.

## Task 3 — targeted test verification (Node 24)
```bash
node --test --test-name-pattern "clobber a manual completion" test/runner.integration.test.mjs
```
- Run 3×: all pass on the assertion part (364/377).
- Windows EPERM in the cleanup `finally` is acceptable (pre-existing env noise).

## Task 4 — full test file + typecheck
```bash
node --test test/runner.integration.test.mjs
npm run typecheck   # if script exists
```
- Failure set must not be worse than baseline (before fix: clobber + stopping-the-runner fail).

## Task 5 — commit & summary
- Commit: `fix: prevent post-exit auto-state from clobbering manual completion (issue #46)`
- Note: the `stopping the runner finalizes the run as stopped` failure is
  pre-existing (fails on `23c7c46` too) and out of scope.
