# Issue #13 Drain-Path PTY Probe Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `drainNextFollowUp` (reachable from the 700ms reconcile poll) from forcing a real `pty.spawn` probe on every cycle; switch it to cached-probe semantics and lock that in with a red-green test.

**Architecture:** One-line production change (`ptySupport({ refresh: true })` → `ptySupport()` in `drainNextFollowUp`) + one new test in `test/service.test.mjs` driving the public `reconcile()` API with an injected `ptySupport` spy, modeled on the existing "ensureHost probes PTY support with TTL cache" test and the "busy replies queue and drain when idle" row-state pattern.

**Tech Stack:** Node built-in test runner; existing `createService` DI seams (`ptySupport`, `launch`).

## Global Constraints

- Production delta is exactly the one-line probe switch in `src/runtime/service.mjs` `drainNextFollowUp` (spec A4).
- `dispatch` (L616) and `reply` (L649) keep `refresh: true` — explicit user actions.
- No changes to `ptySpawnSupported` / `shouldProbePtySupport`.
- Test command: `npm test` (= `node --test test/*.test.mjs`).

**Execution mode:** inline (executing-plans) — single task, one-line production diff + one test.

---

### Task 1: Red-green test + one-line probe switch

**Files:**
- Modify: `src/runtime/service.mjs:496` (inside `drainNextFollowUp`)
- Modify: `test/service.test.mjs` (append new test after "ensureHost probes PTY support with TTL cache, not forced refresh", ~L958)

**Interfaces:**
- Consumes: `createService` opts `{ ptySupport?: (opts?) => {ok, reason?}, launch?: typeof launchRun }`; public `svc.reconcile()`, `svc.queueFollowUp(viewId, text)`; helpers `freshRoot()`, `createView(root, {id, name, cwd})`, `readState`/`writeState`, `rmSync`.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the failing test (red)**

Append to `test/service.test.mjs` (after the "ensureHost probes PTY support with TTL cache, not forced refresh" test):

```js
test("reconcile auto-drain uses the cached PTY probe, never forced refresh", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "idle";
		st.processState = "exited";
		writeState(root, st);
		const probeCalls = [];
		const svc = service(root, {
			ptySupport: (opts = {}) => {
				probeCalls.push(opts);
				return { ok: false, reason: "test" };
			},
			launch: () => ({ pid: null, configPath: "/no/config.json" }),
		});
		const queued = svc.queueFollowUp("v1", "next step");
		assert.equal(queued.ok, true);
		const fixed = svc.reconcile();
		assert.ok(fixed >= 1, "reconcile drained the queued follow-up");
		assert.ok(probeCalls.length >= 1, "drain path probed ptySupport");
		for (const opts of probeCalls) {
			assert.notEqual(opts?.refresh, true, "reconcile→drain must not force ptySupport refresh");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run it, verify it fails against current production code**

Run: `node --test test/service.test.mjs`
Expected: FAIL — `reconcile→drain must not force ptySupport refresh` (production still passes `{refresh: true}`).

- [ ] **Step 3: The one-line fix (green)**

In `src/runtime/service.mjs` `drainNextFollowUp` (~L496), change:

```js
			const pty = ptySupport({ refresh: true });
```

to:

```js
			const pty = ptySupport();
```

(Only inside `drainNextFollowUp`. The `dispatch` and `reply` occurrences keep `{ refresh: true }`.)

- [ ] **Step 4: Run the test file, verify pass**

Run: `node --test test/service.test.mjs`
Expected: PASS including the new test.

- [ ] **Step 5: Full suite (A2/A3)**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Verify A4 — scope**

Run: `git diff main -- src/ test/`
Expected: exactly one line changed in `src/runtime/service.mjs`, one test appended in `test/service.test.mjs`.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/service.mjs test/service.test.mjs
git commit -m "perf: use cached PTY probe on the reconcile drain path (issue #13)"
```

## Self-Review

- Spec coverage: A1 (Steps 1-2 red, 3-4 green), A2/A3 (Step 5), A4 (Step 6). Covered.
- Placeholder scan: exact code shown for both edits.
- Type consistency: spy signature matches `createService` opts type; `launch` fake matches the pattern used by the existing "busy replies queue and drain when idle" test.
