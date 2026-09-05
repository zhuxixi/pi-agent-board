# Issue #63 Flaky Manual-Completion Assert — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the runner.integration "manual completion" test from racing `markCompleted` against the status.json→state.json persist window (test-only fix).

**Architecture:** Replace the one-shot `assert.deepEqual(createService({root}).markCompleted("view_1"), {ok:true})` with a `waitFor` poll of `markCompleted` until `{ok:true}`, then assert the exact shape. Durability asserts after runner exit stay unchanged.

**Tech Stack:** Node built-in test runner (`node --test`), existing `waitFor(fn, timeoutMs = 15000, intervalMs = 50)` helper in the test file.

## Global Constraints

- Test-only: modify `test/runner.integration.test.mjs` and nothing else (spec A4).
- No production code change under `runner/` or `src/` (spec Non-goals).
- Test command: `npm test` (= `node --test test/*.test.mjs`).
- Commit style: conventional commits.

**Execution mode:** inline (executing-plans) — single task, 3-line diff; the heavy part is the 10-run verification loop which stays in the controlling session.

---

### Task 1: Poll markCompleted to success in runner.integration test

**Files:**
- Modify: `test/runner.integration.test.mjs` (~L357-364, test "runner does not clobber a manual completion made during post-exit model passes")

**Interfaces:**
- Consumes: `waitFor(fn, timeoutMs = 15000, intervalMs = 50)` (defined at top of same file), `createService({ root }).markCompleted(viewId)` → `{ ok: boolean, error?: string }`.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Replace the one-shot assertion with a poll**

Replace:

```js
		// User marks the row done manually while the model passes are in flight.
		const { createService } = await import("../src/runtime/service.mjs");
		assert.deepEqual(createService({ root }).markCompleted("view_1"), { ok: true });
```

with:

```js
		// User marks the row done manually while the model passes are in flight.
		// persist() writes status.json before state.json, so markCompleted can
		// transiently reject ("active run") after endedAt is already visible.
		// Poll it to success, then assert the exact shape; the race window is
		// millisecond-scale and 15s default timeout is ample.
		const { createService } = await import("../src/runtime/service.mjs");
		const svc = createService({ root });
		let manual = null;
		await waitFor(() => {
			manual = svc.markCompleted("view_1");
			return manual.ok ? manual : null;
		});
		assert.deepEqual(manual, { ok: true });
```

Note: if `waitFor` times out it returns `null` and leaves `manual` falsy-or-`{ok:false}`; the trailing `assert.deepEqual` then fails — timeout is still a test failure, not a silent pass.

- [ ] **Step 2: Run the single test file, expect pass**

Run: `npm test` (full suite; there is no per-file filter in `node --test` glob mode — use `node --test test/runner.integration.test.mjs` for the quick check)
Expected: PASS, no other test affected.

- [ ] **Step 3: Verify A3 — 10 consecutive full `npm test` runs**

Run: `for i in $(seq 1 10); do npm test > /tmp/issue63-run-$i.log 2>&1 || { echo "RUN $i FAILED"; break; }; echo "run $i ok"; done`
Expected: `run 1 ok` … `run 10 ok`, zero failures (spec A3).

- [ ] **Step 4: Verify A4 — only the test file changed**

Run: `git diff main --stat`
Expected: exactly one file: `test/runner.integration.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add test/runner.integration.test.mjs
git commit -m "test: poll markCompleted to success instead of racing the persist window (issue #63)"
```

## Self-Review

- Spec coverage: A1 (Step 1 diff shape), A2 (Step 2 + unchanged durability asserts), A3 (Step 3), A4 (Step 4). Covered.
- Placeholder scan: no TBD/TODO; exact code shown.
- Type consistency: `manual` is `{ok:boolean,error?:string}`; `waitFor` returns truthy-on-success, `null` on timeout. Consistent.
