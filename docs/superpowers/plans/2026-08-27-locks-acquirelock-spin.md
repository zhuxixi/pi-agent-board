# locks.mjs Bounded Acquisition Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `acquireLock` in `src/core/locks.mjs` fail fast (bounded attempts → throw) instead of spinning forever when the lock can never be acquired, and harden every layer above it (queue, runner, test harness) so a lock failure can never produce a 100%-CPU zombie process again (issue #33).

**Architecture:** Four defense layers. (1) `locks.mjs`: classify acquisition failures — EEXIST contention keeps the existing wait-window + force-steal semantics (bounded to 2 steal attempts), all other errors (ENOENT/EACCES/ENOTDIR/EROFS/ENOSPC…) get 3 quick retries with `ensureDir` re-run for self-heal, then throw. (2) `follow-up-queue.mjs` catches any throw and returns `{ok:false, error}` per the module's existing convention. (3) `runner/job-runner.mjs` wraps the post-exit finalize chain in try/catch so `process.exit` always runs. (4) `test/runner.integration.test.mjs` kills every detached runner in teardown before deleting the root.

**Tech Stack:** Node 24 ESM (`.mjs`), `node:test` + `node:assert/strict`, sync `node:fs`, tabs indentation, JSDoc types, zero new dependencies.

## Global Constraints

- **Worktree only:** all file paths below are relative to `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-33-locks-acquirelock-spin` — never touch the main checkout.
- **Existing semantics must not change:** the 5 existing tests in `test/locks.test.mjs` stay unmodified and green (wait-window contention + stale steal + force-steal-after-window are contract).
- Every new test carries `{ timeout: 5000 }` so a regression to a spin loop fails fast instead of hanging the suite.
- fs injection follows the `defaultScreenLogFs` precedent in `src/core/screen-log.mjs` (frozen object of raw `node:fs` functions passed via opts).
- Stage by explicit file path (`git add <file>`), never `git add -A`.
- Conventional commits, English messages. Comments in English, tabs for indentation.
- Test command: `npm test` (= `node --test test/*.test.mjs`). Final gate: `npm run verify`.
- `appendLine`/`appendDiagnostic` are NOT best-effort (verified: `ensureDir` + `appendFileSync` throw on deleted roots) — any diagnostic call on a possibly-dead root must be wrapped.

---

### Task 1: locks.mjs — bounded acquisition, error classification, fs injection

**Files:**
- Modify: `src/core/locks.mjs` (full rewrite of internals, same public API + new opts)
- Test: `test/locks.test.mjs` (append new tests; do not modify existing 5)

**Interfaces:**
- Consumes: `ensureDir(dir)` from `src/core/atomic.mjs`; `P.viewLockPath(root, viewId, name)`.
- Produces (other tasks rely on these):
  - `withFileLockSync(lockPath, fn, opts?)` — `opts.fs` (frozen `{existsSync, mkdirSync, readFileSync, rmSync, writeFileSync}`, default `defaultLocksFs`), `opts.staleMs` (default 30000). Throws `Error` with `err.code === "LOCK_TIMEOUT"` and message containing the lockPath when acquisition is impossible.
  - `withViewLockSync(root, viewId, name, fn, opts?)` — passes opts through.
  - `defaultLocksFs` exported (for tests).

- [ ] **Step 1: Write the failing tests**

Append to `test/locks.test.mjs` (also add `defaultLocksFs` to the import from `../src/core/locks.mjs`, and `writeFileSync` to the existing `node:fs` import — it is already there for the stale-lock tests, verify):

```js
const LOCK_FS = defaultLocksFs;

function eexist() {
	const e = new Error("EEXIST");
	e.code = "EEXIST";
	return e;
}

test("withFileLockSync throws promptly when mkdirSync keeps failing", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const fs = {
			...LOCK_FS,
			mkdirSync: (p, o) => {
				const e = new Error("EACCES");
				e.code = "EACCES";
				throw e;
			},
		};
		const started = Date.now();
		assert.throws(
			() => withFileLockSync(join(root, "x.lock"), () => "no", { fs }),
			/lock path unusable/,
		);
		assert.ok(Date.now() - started < 2000, "must fail fast, not spin");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLockSync throws and cleans up when owner.json writes keep failing", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const fs = {
			...LOCK_FS,
			writeFileSync: (file, data, opts) => {
				if (String(file).endsWith("owner.json")) {
					const e = new Error("ENOSPC");
					e.code = "ENOSPC";
					throw e;
				}
				return LOCK_FS.writeFileSync(file, data, opts);
			},
		};
		assert.throws(
			() => withFileLockSync(join(root, "w.lock"), () => "no", { fs }),
			/lock path unusable/,
		);
		assert.equal(existsSync(join(root, "w.lock")), false, "half-created lock must be cleaned up");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLockSync throws after bounded steal attempts when rmSync keeps failing", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const lockPath = join(root, "s.lock");
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 1, at: Date.now() - 60_000 }), "utf8"); // stale
		const fs = {
			...LOCK_FS,
			rmSync: (p, o) => {
				const e = new Error("EPERM");
				e.code = "EPERM";
				throw e;
			},
		};
		const started = Date.now();
		assert.throws(
			() => withFileLockSync(lockPath, () => "no", { fs, staleMs: 50 }),
			/stale lock could not be stolen/,
		);
		assert.ok(Date.now() - started < 2000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLockSync waits through transient contention and acquires", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const lockPath = join(root, "c.lock");
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 1, at: Date.now() }), "utf8"); // fresh holder
		let eexistLeft = 3;
		const fs = {
			...LOCK_FS,
			mkdirSync: (p, o) => {
				if (p === lockPath && eexistLeft-- > 0) throw eexist();
				if (p === lockPath) LOCK_FS.rmSync(lockPath, { recursive: true, force: true }); // holder releases
				return LOCK_FS.mkdirSync(p, o);
			},
		};
		const started = Date.now();
		const result = withFileLockSync(lockPath, () => "won", { fs, staleMs: 30_000 });
		assert.equal(result, "won");
		assert.ok(Date.now() - started >= 40, "should have slept through contention ticks");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLockSync self-heals a parent dir deleted mid-acquisition", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const lockPath = join(root, "del", "parent", "p.lock");
		let failedOnce = false;
		const fs = {
			...LOCK_FS,
			mkdirSync: (p, o) => {
				if (p === lockPath && !failedOnce) {
					failedOnce = true; // simulate parent deleted between ensureDir and mkdir
					const e = new Error("ENOENT");
					e.code = "ENOENT";
					throw e;
				}
				return LOCK_FS.mkdirSync(p, o);
			},
		};
		const result = withFileLockSync(lockPath, () => "healed", { fs });
		assert.equal(result, "healed");
		assert.equal(existsSync(lockPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lock timeout errors carry LOCK_TIMEOUT code and the lock path", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const fs = {
			...LOCK_FS,
			mkdirSync: (p, o) => {
				const e = new Error("EROFS");
				e.code = "EROFS";
				throw e;
			},
		};
		const lockPath = join(root, "code.lock");
		assert.throws(
			() => withFileLockSync(lockPath, () => "no", { fs }),
			(err) => err.code === "LOCK_TIMEOUT" && String(err.message).includes(lockPath),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern "withFileLockSync (throws|waits|self-heals)|lock timeout"`
Expected: the spin-path tests (`mkdirSync keeps failing`, `self-heals`) FAIL via the 5000ms timeout (current code spins forever); the rmSync-steal test fails by timeout too; `owner.json writes` may fail by timeout. RED confirmed.

- [ ] **Step 3: Implement the new locks.mjs**

Replace `src/core/locks.mjs` with:

```js
/**
 * Tiny dependency-free synchronous file lock helpers for local agent-board artifacts.
 * Locks use atomic mkdir on a sibling .lock directory and are cleaned up in finally.
 *
 * Failure model (issue #33): acquisition failures are classified.
 * - EEXIST (contention): wait in 20ms ticks until the stale window passes, then
 *   force-steal (bounded to MAX_STEAL_ATTEMPTS). This preserves the original
 *   wait/steal contract (see test/locks.test.mjs).
 * - Anything else (deleted parent, read-only fs, permissions, disk full, ...):
 *   MAX_ENV_ATTEMPTS quick retries — each retry re-runs ensureDir so a parent
 *   deleted mid-acquisition self-heals — then throw LOCK_TIMEOUT. Never spin.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { ensureDir } from "./atomic.mjs";
import * as P from "./paths.mjs";

const DEFAULT_STALE_MS = 30_000;
/** Minimum contention window before a fresh lock can be force-stolen. */
const MIN_WINDOW_MS = 250;
const WAIT_TICK_MS = 20;
/** Max stale-lock steal attempts before giving up. */
const MAX_STEAL_ATTEMPTS = 2;
/** Max quick retries for environmental failures before giving up. */
const MAX_ENV_ATTEMPTS = 3;

export const defaultLocksFs = Object.freeze({ existsSync, mkdirSync, readFileSync, rmSync, writeFileSync });

/**
 * @template T
 * @param {string} lockPath
 * @param {() => T} fn
 * @param {{ staleMs?: number, fs?: typeof defaultLocksFs }} [opts]
 * @returns {T}
 */
export function withFileLockSync(lockPath, fn, opts = {}) {
	const fs = opts.fs ?? defaultLocksFs;
	acquireLock(lockPath, opts.staleMs ?? DEFAULT_STALE_MS, fs);
	let result;
	try {
		result = fn();
	} finally {
		releaseLock(lockPath, fs);
	}
	return result;
}

/**
 * @template T
 * @param {string} root
 * @param {string} viewId
 * @param {string} name
 * @param {() => T} fn
 * @param {{ staleMs?: number, fs?: typeof defaultLocksFs }} [opts]
 * @returns {T}
 */
export function withViewLockSync(root, viewId, name, fn, opts = {}) {
	return withFileLockSync(P.viewLockPath(root, viewId, name), fn, opts);
}

/** @param {string} lockPath @param {number} staleMs @param {typeof defaultLocksFs} fs */
function acquireLock(lockPath, staleMs, fs) {
	const deadline = Date.now() + Math.max(MIN_WINDOW_MS, staleMs);
	let steals = 0;
	let envAttempts = 0;
	for (;;) {
		let created = false;
		try {
			// Re-run every attempt: a parent deleted mid-acquisition self-heals here.
			ensureDir(path.dirname(lockPath));
			fs.mkdirSync(lockPath);
			created = true;
			fs.writeFileSync(
				path.join(lockPath, "owner.json"),
				JSON.stringify({ pid: process.pid, at: Date.now() }),
				"utf8",
			);
			return;
		} catch (err) {
			if (err && err.code === "EEXIST") {
				const expired = Date.now() >= deadline;
				if (isLockStale(lockPath, staleMs, fs) || expired) {
					if (steals >= MAX_STEAL_ATTEMPTS) {
						throw lockError(lockPath, `stale lock could not be stolen after ${steals} attempts`);
					}
					steals += 1;
					releaseLock(lockPath, fs);
					continue;
				}
				sleep(WAIT_TICK_MS);
				continue;
			}
			// Environmental failure: bounded quick retries, then fail fast.
			if (created) releaseLock(lockPath, fs);
			envAttempts += 1;
			if (envAttempts >= MAX_ENV_ATTEMPTS) {
				const reason = (err && (err.code || err.message)) || "unknown error";
				throw lockError(lockPath, `lock path unusable (${reason})`);
			}
			sleep(WAIT_TICK_MS);
		}
	}
}

/** @param {string} lockPath @param {string} reason */
function lockError(lockPath, reason) {
	const err = new Error(`file lock unavailable: ${lockPath} (${reason})`);
	err.code = "LOCK_TIMEOUT";
	return err;
}

/** @param {number} ms */
function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {string} lockPath @param {number} staleMs @param {typeof defaultLocksFs} fs */
function isLockStale(lockPath, staleMs, fs) {
	try {
		if (!fs.existsSync(lockPath)) return false;
		const raw = fs.readFileSync(path.join(lockPath, "owner.json"), "utf8");
		const owner = JSON.parse(raw);
		return Date.now() - Number(owner.at ?? 0) > staleMs;
	} catch {
		return true;
	}
}

/** @param {string} lockPath @param {typeof defaultLocksFs} fs */
function releaseLock(lockPath, fs) {
	try {
		fs.rmSync(lockPath, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npm test -- --test-name-pattern "withFileLockSync|withViewLockSync|lock timeout"`
Expected: ALL PASS — the 5 existing tests unmodified plus the 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/core/locks.mjs test/locks.test.mjs
git commit -m "fix: bound lock acquisition with error classification and fs injection (issue #33)"
```

---

### Task 2: follow-up-queue.mjs — catch-all {ok:false} translation

**Files:**
- Modify: `src/core/follow-up-queue.mjs` (route all 5 lock sites through one guarded helper)
- Test: `test/follow-up-queue.test.mjs` (append)

**Interfaces:**
- Consumes: Task 1's `withViewLockSync(root, viewId, name, fn, opts?)` (throws `LOCK_TIMEOUT` on failure).
- Produces: unchanged public signatures; NEW behavior — every mutating queue op (`enqueueFollowUp`, `claimNextFollowUp`, `completeFollowUp`, `failFollowUp`, `releaseFollowUp`, `removeLastFollowUp`, `clearQueuedFollowUps`) returns `{ok:false, error}` instead of throwing when the lock (or any fs op inside fn) fails. `service.mjs` and `runner/job-runner.mjs` consume the `{ok}` convention unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/follow-up-queue.test.mjs` (add `writeFileSync` to the `node:fs` import):

```js
test("queue ops return {ok:false} when the lock path is unusable", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const fileRoot = join(root, "notadir");
		writeFileSync(fileRoot, "x", "utf8"); // ensureDir under a file path -> ENOTDIR, unrecoverable
		const enq = enqueueFollowUp(fileRoot, "v1", "hello");
		assert.equal(enq.ok, false);
		assert.match(String(enq.error), /lock unavailable/);
		const claim = claimNextFollowUp(fileRoot, "v1");
		assert.equal(claim.ok, false);
		assert.match(String(claim.error), /lock unavailable/);
		const removed = removeLastFollowUp(fileRoot, "v1");
		assert.equal(removed.ok, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern "lock path is unusable"`
Expected: FAIL — current code propagates the raw ENOTDIR throw (uncaught error fails the test).

- [ ] **Step 3: Implement**

In `src/core/follow-up-queue.mjs`: add a guarded wrapper after the imports and route the 5 `withViewLockSync(...)` call sites (`enqueueFollowUp`, `claimNextFollowUp`, `removeLastFollowUp`, `clearQueuedFollowUps`, and the private `updateItem`) through it — replace each `return withViewLockSync(root, viewId, "queue", () => { ... })` with `return lockedQueueOp(root, viewId, () => { ... })` (body unchanged):

```js
import { withViewLockSync } from "./locks.mjs";
// ...existing imports...

/**
 * Run a queue mutation under the view lock, translating any failure (lock
 * unavailable, fs errors inside the mutation) into {ok:false} so callers on
 * the {ok} convention never see a throw (issue #33).
 * @template T
 * @param {string} root
 * @param {string} viewId
 * @param {() => T} fn
 * @returns {T | { ok: false, error: string }}
 */
function lockedQueueOp(root, viewId, fn) {
	try {
		return withViewLockSync(root, viewId, "queue", fn);
	} catch (err) {
		return { ok: false, error: `follow-up queue lock unavailable: ${err instanceof Error ? err.message : String(err)}` };
	}
}
```

- [ ] **Step 4: Run the full queue suite**

Run: `npm test -- --test-name-pattern "follow-up|queue"`
Expected: ALL PASS (existing FIFO/durability tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/core/follow-up-queue.mjs test/follow-up-queue.test.mjs
git commit -m "fix: translate follow-up queue lock failures into {ok:false} results (issue #33)"
```

---

### Task 3: job-runner.mjs — finalize chain can never skip process.exit

**Files:**
- Modify: `runner/job-runner.mjs` (the `worker.on("close")` `.finally` block only)

**Interfaces:**
- Consumes: Task 2's `{ok:false}` queue results (`claimNextFollowUp` no longer throws on lock failure — the existing `if (!claimed.ok || !claimed.item) return;` already handles it).
- Produces: no signature changes. Behavioral guarantee: `finalizeSteeringIfNeeded` and `drainQueuedFollowUp` failures are logged best-effort and `process.exit` always runs.

**Note:** this task has no practical unit test (module runs `main()` on import and the guarded code is inside a child-process event chain). It is covered by Task 4's integration tests + the fix is structurally simple. Red-green is not applicable; code-review verification is the gate (spec test-plan item 7).

- [ ] **Step 1: Implement the guards**

In `runner/job-runner.mjs`, replace the `.finally(() => { ... })` block:

```js
		.finally(() => {
			// The finalize chain must never prevent process.exit: a lock/fs failure
			// here used to pin the runner as a 100% CPU zombie (issue #33).
			try {
				finalizeSteeringIfNeeded(config, status, evidence);
			} catch (err) {
				tryAppendDiagnostic(config, "finalize_steering_failed", err);
			}
			try {
				drainQueuedFollowUp(config, status);
			} catch (err) {
				tryAppendDiagnostic(config, "follow_up_drain_failed", err);
			}
			process.exit(stoppedByUser ? 0 : (code ?? 0));
		});
```

And add this helper next to `drainQueuedFollowUp` (appendDiagnostic itself throws on a deleted root — verified `appendLine` is not best-effort):

```js
/** @param {import("../src/core/types.mjs").RunConfig} config @param {string} code @param {unknown} err */
function tryAppendDiagnostic(config, code, err) {
	try {
		appendDiagnostic(config.root, config.viewId, {
			source: "runner",
			runId: config.runId,
			level: "error",
			code,
			message: "Finalize step failed",
			details: { error: err instanceof Error ? err.message : String(err) },
		});
	} catch {
		/* root may be deleted — nothing to persist, exit anyway */
	}
}
```

- [ ] **Step 2: Sanity-check syntax + typecheck**

Run: `node --check runner/job-runner.mjs && npm run typecheck`
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add runner/job-runner.mjs
git commit -m "fix: guard job-runner finalize chain so process.exit always runs (issue #33)"
```

---

### Task 4: integration tests — kill detached runners in teardown

**Files:**
- Modify: `test/runner.integration.test.mjs`

**Interfaces:**
- Consumes: `launchRun(root, config, {runnerScript})` returns `{pid}` (all 7 call sites must capture it — 4 currently discard: the `needs_input`, `dash-prefixed`, `worker exits nonzero`, and `worker error` tests).
- Produces: `killDetached(pid)` async helper; every test's `finally` kills the runner BEFORE `rmSync(root)`.

- [ ] **Step 1: Add the helper (after the existing `sleep` definition)**

```js
/** Kill a detached runner before deleting its root so it can never orphan (issue #33). */
async function killDetached(pid) {
	if (!pid || pid <= 0) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return; // already exited
	}
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		await sleep(50);
		try {
			process.kill(pid, 0);
		} catch {
			return; // exited
		}
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* already gone */
	}
}
```

- [ ] **Step 2: Capture pids at the 4 discarding call sites**

Change `launchRun(root, config, { runnerScript: RUNNER });` to `const { pid } = launchRun(root, config, { runnerScript: RUNNER });` in the `needs_input`, `dash-prefixed prompts`, `worker exits nonzero`, and `worker error` tests. The `auto-classifies`, `readPid`, and remaining tests already capture the pid — leave them (rename only if a shadow conflict with `pid` arises; use `runnerPid` as the variable name at ALL sites for uniformity).

- [ ] **Step 3: Kill before rmSync in every finally**

In each test's `finally`, add `await killDetached(runnerPid);` as the FIRST statement, before `rmSync(root, ...)`. Example (first test):

```js
	} finally {
		delete process.env.FAKE_PI_MODE;
		// ...
		await killDetached(runnerPid);
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
```

- [ ] **Step 4: Run the integration suite and check for leftovers**

Run: `npm test -- --test-name-pattern "runner" && (ps -ef | grep '[j]ob-runner.mjs' || echo "no leftover runners")`
Expected: all runner tests PASS and `no leftover runners` prints.

- [ ] **Step 5: Commit**

```bash
git add test/runner.integration.test.mjs
git commit -m "test: kill detached job-runners in integration test teardown (issue #33)"
```

---

### Task 5: full verify + field-repro regression check

**Files:**
- Create: none (verification only; fixups allowed if verification exposes issues)

- [ ] **Step 1: Full gate**

Run: `npm run verify`
Expected: typecheck + tests + coverage thresholds + pack:dry all green. If coverage thresholds fail on new branches, extend the Task 1 tests (not the thresholds).

- [ ] **Step 2: Field-repro regression check (the /sys read-only scenario from the issue)**

Run:
```bash
node -e '
import("/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-33-locks-acquirelock-spin/src/core/locks.mjs").then(({ withFileLockSync }) => {
	const t0 = Date.now();
	try {
		withFileLockSync("/sys/bus/pi-agent-board-repro.lock", () => {});
		console.log("UNEXPECTED: acquired");
	} catch (err) {
		console.log("OK: threw in", Date.now() - t0, "ms:", err.message);
	}
});'
```
Expected: `OK: threw in < 1000 ms: file lock unavailable: /sys/bus/... (lock path unusable (EROFS))` — the pre-fix behavior was an infinite spin.

- [ ] **Step 3: No zombies after the suite**

Run: `ps -ef | grep -E '[j]ob-runner|[p]ty-runner.*agentview' || echo clean`
Expected: `clean` (or only the user's real agent-board runners under ~/.pi/agent/agent-board).

- [ ] **Step 4: Commit any fixups (only if Steps 1-3 required changes)**

```bash
git add <changed files>
git commit -m "fix: address verify findings for issue #33"
```

---

## Self-Review

- **Spec coverage:** D1/D3/D4/D5/D8 → Task 1; D4b (re-ensureDir self-heal) → Task 1 implementation + self-heal test; D2 (wait/steal contract) → Task 1 keeps existing tests unmodified; D6 → Task 2; D7 → Task 3; D9 → Task 4; spec test items 1-3 → Task 1 tests, item 4/4b → Task 1 contention/self-heal tests, item 5 → Task 1 Step 4, item 6 → Task 2, item 7 → Task 3 (CR gate, documented), item 8 → Task 4 Step 4. Acceptance items map to Task 5. No gaps.
- **Placeholder scan:** all steps contain concrete code / commands / expected output. No TBDs.
- **Type consistency:** `defaultLocksFs` name used in Task 1 tests + implementation; `LOCK_TIMEOUT` code asserted in Task 1 and produced by `lockError`; `lockedQueueOp` defined in Task 2 and used at all 5 sites; `killDetached` defined and used in Task 4; `runnerPid` naming uniform in Task 4.
