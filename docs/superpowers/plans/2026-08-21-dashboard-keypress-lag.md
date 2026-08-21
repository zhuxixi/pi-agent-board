# Dashboard Keypress Lag Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate perceptible ↑/↓ selection lag on the dashboard by moving prewarm off the keypress path, skipping artifact loads for archived views, and stopping forced PTY probes (issue #9).

**Architecture:** Three independent fixes: (A) a debounced prewarm scheduler so arrow keys only mutate selection and trigger a render; (B) an archived short-circuit in `listRows` so the 700ms poll (`reconcile()` + `refresh()` + `render()` each call it) stops reading ~10 artifact files per archived view; (C) `ensureHost` no longer forces `ptySupport({refresh:true})`, which spawned a probe process on every keypress when PTY support is broken.

**Tech Stack:** Node 20+, TypeScript (`.ts` UI) + ESM JavaScript (`.mjs` core), `node --test` test runner, no new dependencies.

## Global Constraints

- No new npm dependencies.
- All commits in this worktree branch `issue-9-dashboard-keypress-lag`; never touch `main` checkout.
- `git add` per-file; never `git add -A`.
- Commit messages in English, conventional-commits format, reference `issue #9`.
- `npm run verify` (typecheck + tests + pack dry-run) must pass before the PR.
- Core modules are `.mjs` with JSDoc types; UI is `.ts`. Follow existing file conventions.

---

### Task 1: `listRows` archived short-circuit (Fix B)

**Files:**
- Modify: `src/core/store.mjs` (function `listRows`, around line 220)
- Test: `test/store.test.mjs` (append new test)

**Interfaces:**
- Consumes: existing `readMeta(root, viewId)`, `loadRow(root, viewId)` from `src/core/store.mjs`.
- Produces: unchanged `listRows(root, opts)` signature and return type. Callers (`service.mjs` `reconcile()`/`rows()`/`pruneWarmHosts()`, `dashboard.ts` render) need no changes.

- [ ] **Step 1: Write the safety-net test**

Note: `readJson` swallows missing/corrupt files with a null fallback (`src/core/atomic.mjs`), so the archived short-circuit has no black-box failure mode — pre-fix and post-fix output is identical; the difference is pure IO volume, proven by the Task 4 real-store measurement. This test instead pins the behavioral contract that makes the short-circuit safe: archived views whose artifact files are absent/stale must not break `listRows`, and `includeArchived` semantics stay unchanged.

Append to `test/store.test.mjs` (imports `createView`, `listRows`, `writeMeta`, `P` are already at top; add `rmSync`/`writeFileSync`/`mkdirSync` to the existing `node:fs` import if missing):

```js
test("listRows tolerates archived views with only meta.json", () => {
	const root = freshRoot();
	try {
		const live = createView(root, { id: "live1", name: "live", cwd: "/r" });
		for (const id of ["arch1", "arch2"]) {
			const meta = createView(root, { id, name: id, cwd: "/r" });
			meta.archived = true;
			writeMeta(root, meta);
			// Simulate the worst case the short-circuit must handle: archived view
			// dirs containing nothing but meta.json (no state/evidence/host files).
			rmSync(P.viewDir(root, id), { recursive: true, force: true });
			mkdirSync(P.viewDir(root, id), { recursive: true });
			writeFileSync(P.metaPath(root, id), JSON.stringify(meta));
		}
		const rows = listRows(root);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].meta.id, live.id);
		const all = listRows(root, { includeArchived: true });
		assert.equal(all.length, 3);
		assert.equal(all.filter((r) => r.meta.archived).length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run test to confirm green baseline**

Run: `cd <worktree> && npm install --no-audit --no-fund 2>/dev/null; node --test test/store.test.mjs`
Expected: PASS pre-fix (safety net — see Step 1 note). This test must stay green after the implementation change.

- [ ] **Step 3: Write minimal implementation**

In `src/core/store.mjs`, change `listRows`:

```js
export function listRows(root, opts = {}) {
	const roster = readRoster(root);
	/** @type {Row[]} */
	const rows = [];
	for (const viewId of roster.views) {
		// Archived short-circuit: archived rows are invisible on the dashboard, so
		// never pay for their artifact files (state/evidence/host/diagnostics...).
		// meta.json is the single authoritative source of the archived flag.
		const meta = readMeta(root, viewId);
		if (!meta) continue;
		if (meta.archived && !opts.includeArchived) continue;
		const row = loadRow(root, viewId);
		if (!row) continue;
		if (row.meta.archived && !opts.includeArchived) continue;
		rows.push(row);
	}
	return rows;
}
```

(The second archived check is belt-and-suspenders in case `loadRow` re-reads a meta that changed between reads.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/store.test.mjs`
Expected: PASS, all tests in file green.

- [ ] **Step 5: Commit**

```bash
git add src/core/store.mjs test/store.test.mjs
git commit -m "perf: skip artifact loading for archived views in listRows (issue #9)"
```

---

### Task 2: Debounced prewarm off the keypress path (Fix A)

**Files:**
- Create: `src/core/prewarm-schedule.mjs`
- Create: `test/prewarm-schedule.test.mjs`
- Modify: `src/ui/dashboard.ts` (fields near line 127, `moveSelection` ~L237, `refresh` ~L176, `dispose` ~L1086)

**Interfaces:**
- Produces: `createPrewarmScheduler(prewarm: () => void, delayMs?: number): { schedule(): void; cancel(): void }` — single-flight debounce; repeated `schedule()` within `delayMs` fire `prewarm()` exactly once after the last call; `cancel()` clears the pending timer.
- Consumes (dashboard.ts): existing private `prewarmSelected()`.

- [ ] **Step 1: Write the failing test**

`test/prewarm-schedule.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrewarmScheduler } from "../src/core/prewarm-schedule.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("rapid schedules fire prewarm once after quiet period", async () => {
	let fired = 0;
	const s = createPrewarmScheduler(() => { fired += 1; }, 15);
	s.schedule();
	s.schedule();
	s.schedule();
	await sleep(5);
	assert.equal(fired, 0); // still debouncing
	await sleep(25);
	assert.equal(fired, 1); // exactly once
});

test("cancel prevents prewarm entirely", async () => {
	let fired = 0;
	const s = createPrewarmScheduler(() => { fired += 1; }, 10);
	s.schedule();
	s.cancel();
	await sleep(30);
	assert.equal(fired, 0);
});

test("schedule after cancel works again", async () => {
	let fired = 0;
	const s = createPrewarmScheduler(() => { fired += 1; }, 10);
	s.schedule();
	s.cancel();
	s.schedule();
	await sleep(30);
	assert.equal(fired, 1);
});

test("prewarm errors do not crash the scheduler", async () => {
	let fired = 0;
	const s = createPrewarmScheduler(() => { fired += 1; throw new Error("boom"); }, 5);
	s.schedule();
	await sleep(20);
	assert.equal(fired, 1);
	s.schedule();
	await sleep(20);
	assert.equal(fired, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/prewarm-schedule.test.mjs`
Expected: FAIL — cannot find module `../src/core/prewarm-schedule.mjs`.

- [ ] **Step 3: Write minimal implementation**

`src/core/prewarm-schedule.mjs`:

```js
/**
 * Single-flight debounce for dashboard prewarm.
 *
 * Arrow-key navigation must move the selection and repaint immediately; host
 * prewarm (which may spawn a PTY host and re-scan rows) is deferred so bursts
 * of keypresses trigger exactly one prewarm for the final resting selection.
 */

/**
 * @param {() => void} prewarm Invoked (with errors swallowed) once scheduling
 *   goes quiet for `delayMs`. Re-reads current state at fire time.
 * @param {number} [delayMs=200]
 * @returns {{ schedule: () => void, cancel: () => void }}
 */
export function createPrewarmScheduler(prewarm, delayMs = 200) {
	/** @type {ReturnType<typeof setTimeout> | null} */
	let timer = null;
	const fire = () => {
		timer = null;
		try {
			prewarm();
		} catch {
			/* prewarm is best-effort; never break navigation */
		}
	};
	return {
		schedule() {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(fire, delayMs);
		},
		cancel() {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/prewarm-schedule.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into DashboardComponent**

In `src/ui/dashboard.ts`:

1. Import: add near the other `../core/` imports:
   `import { createPrewarmScheduler } from "../core/prewarm-schedule.mjs";`
2. Add field (near `private prewarmedId: string | null = null;`):
   `private readonly prewarmScheduler = createPrewarmScheduler(() => this.prewarmSelected(), 200);`
3. `moveSelection()`: replace `this.prewarmSelected();` with `this.prewarmScheduler.schedule();`
4. `refresh()` (line ~176): replace `if (this.selectedId && this.selectedId !== previousSelected) this.prewarmSelected();` with `if (this.selectedId && this.selectedId !== previousSelected) this.prewarmScheduler.schedule();`
5. `prewarmSelected()`: add a mode guard as the first line so a timer firing after the user entered peek/session/launch modes does not prewarm the wrong target:
   `if (this.mode !== "list" && this.mode !== "select") return;`
6. `dispose()`: replace the comment-only body with `this.prewarmScheduler.cancel();` (keep the existing comment about poll interval ownership).

- [ ] **Step 6: Typecheck + full tests**

Run: `npx tsc --noEmit && node --test test/*.test.mjs`
Expected: no type errors; all tests green.

- [ ] **Step 7: Commit**

```bash
git add src/core/prewarm-schedule.mjs test/prewarm-schedule.test.mjs src/ui/dashboard.ts
git commit -m "perf: debounce dashboard prewarm off the keypress path (issue #9)"
```

---

### Task 3: `ensureHost` PTY probe TTL instead of forced refresh (Fix C)

**Files:**
- Modify: `src/runtime/service.mjs` (`ensureHost`, ~L674: `const pty = ptySupport({ refresh: true });`)
- Test: `test/service.test.mjs` (append new test)

**Interfaces:**
- Consumes: existing injected `ptySupport(opts)` option of `createService`; existing test helper `service(root, overrides)` in `test/service.test.mjs`.
- Produces: unchanged `ensureHost` return contract; only probe option semantics change (default = cached/TTL instead of forced refresh).

- [ ] **Step 1: Write the failing test**

Append to `test/service.test.mjs` (uses `createView`, `writeState`, `readState` imports already present; add `writeFileSync` if not imported):

```js
test("ensureHost probes PTY support with TTL cache, not forced refresh", () => {
	const root = freshRoot();
	try {
		process.env.AGENT_BOARD_FORCE_PTY = "1";
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeFileSync(meta.sessionFile, JSON.stringify({ type: "session", id: "s1", cwd: "/r" }) + "\n");
		const probeCalls = [];
		const svc = service(root, {
			ptySupport: (opts = {}) => { probeCalls.push(opts); return { ok: true }; },
			launchHost: () => ({ pid: process.pid, configPath: "/no/host-config.json" }),
		});
		const res = svc.ensureHost("v1");
		assert.equal(res.ok, true);
		assert.ok(probeCalls.length >= 1);
		for (const opts of probeCalls) {
			assert.notEqual(opts?.refresh, true, "ensureHost must not force ptySupport refresh");
		}
	} finally {
		delete process.env.AGENT_BOARD_FORCE_PTY;
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/service.test.mjs`
Expected: new test FAILS — `ensureHost` currently calls `ptySupport({ refresh: true })` so `opts.refresh === true`.

- [ ] **Step 3: Write minimal implementation**

In `src/runtime/service.mjs` `ensureHost`, change:

```js
const pty = ptySupport({ refresh: true });
```

to:

```js
// Default probe semantics: success is cached for the process lifetime and a
// failed probe retries on a short TTL. Forcing refresh here would spawn a
// probe process on every keypress-driven prewarm when PTY support is broken.
const pty = ptySupport();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/service.test.mjs`
Expected: PASS, all tests in file green.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/service.mjs test/service.test.mjs
git commit -m "fix: stop forcing PTY probe refresh on every ensureHost (issue #9)"
```

---

### Task 4: Full verification + performance evidence

**Files:**
- No source changes expected (fix-only task; measurement script is throwaway, not committed).

**Interfaces:**
- Consumes: all previous tasks merged on the branch.

- [ ] **Step 1: Install deps and run full verify**

Run: `cd <worktree> && npm install --no-audit --no-fund && npm run verify`
Expected: `tsc --noEmit` clean, all 27+ test files pass, `npm pack --dry-run` succeeds.

- [ ] **Step 2: Measure real-store improvement (read-only)**

Run against the user's real store (read-only, no mutation):

```bash
node --input-type=module -e "
import { listRows } from './src/core/store.mjs';
import os from 'node:os'; import path from 'node:path';
const root = path.join(os.homedir(), '.pi/agent/agent-board');
listRows(root);
const t0 = performance.now(); listRows(root); const t1 = performance.now();
console.log('listRows post-fix:', (t1 - t0).toFixed(1), 'ms');
"
```

Expected: ≤ 40ms on the 168-view store (was 180–204ms). Record the number.

- [ ] **Step 3: Report numbers**

Paste before/after into the PR body and as an issue #9 comment. No commit needed for this task.
