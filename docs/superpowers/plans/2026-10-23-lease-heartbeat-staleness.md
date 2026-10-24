# Lease Heartbeat Staleness Reclaim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the state-coordinator lease reclaimable when its recorded pid has been reused, by judging the lease on its own heartbeat staleness instead of pid liveness alone.

**Architecture:** `classifyLeaseOwner` stays a pure decision function and gains two injected inputs — the owner's declared heartbeat period and the observed heartbeat age. A thin I/O shell (`readLeaseHeartbeat` inside `reclaimOrBlock`) supplies them. Eligibility is deliberately narrow: either the owner declared `heartbeatMs` in `owner.json` (forward contract), or a `heartbeat.<token>` file exists **and** the lock is older than the existing 5-minute orphan age (self-healing for records written by older builds). Short-hold leases (`host-meta`, `host-start`) therefore keep today's behaviour unless they are both heartbeating and 5 minutes old. The coordinator additionally steps down when it cannot write its own heartbeat, so a live-but-stuck holder always vacates before it can be preempted.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict`, `c8`, TypeScript checkJs (`tsc --noEmit`), detached runner processes.

**Spec:** `docs/superpowers/specs/2026-10-23-lease-heartbeat-staleness-design.md`

## Global Constraints

- Tabs for indentation; English comments and commit messages (AGENTS.md).
- Conventional commit subjects; append `(issue #224)` until the PR number exists.
- `LEASE_HEARTBEAT_STALE_MS = 60_000`, `MAX_CONSECUTIVE_TOUCH_FAILURES = 3`, coordinator cadence 1000ms — exact values from the spec.
- No new production switches. Test-only knobs must be `AGENT_BOARD_TEST_*` and default to production-identical behaviour when unset.
- Pure decision functions stay free of fs/net/process I/O; injected probes (`fs`, `clock`, `isProcessDead`) are the only seam.
- Tests use self-contained fixtures under `mkdtempSync`; never the host repository.
- `npm run verify` (typecheck → perf gate → tests → coverage → pack:dry) must pass before claiming done.
- Fixture shape for the #224 record is fixed: `identity: { pid, startToken: null }` (Windows reality), a live unrelated pid, `startedAt` 48h ago, `heartbeat.<token>` `at` 24h ago.

## Review Focus

1. **A legacy lock record must behave exactly as today.** An old `owner.json` with `identity: null`, no `heartbeatMs`, and no heartbeat file must never become reclaimable faster than before — `host-meta` holds for milliseconds and a wrong verdict here means two writers on `host.json`. Pinned by A4 + A1b.
2. **Concurrent replacement must not be deleted.** If a successor publishes a new lock between the read and the quarantine rename, the reclaim must restore it and report contention. Pinned by A7.
3. **A corrupt or non-monotonic heartbeat must fail closed.** Broken JSON, a string `at`, or a future timestamp must not make a live holder look stale (or a dead one look fresh). Pinned by A5b, A6.
4. **A holder that cannot heartbeat must vacate before it can be preempted.** The step-down bound (`3 × cadence`) must stay strictly below the stale threshold, the supervision must start only after the endpoint is bound, and the step-down must survive its own diagnostic write failing. Pinned by A9, A9b, A14, A14b.
5. **The declared path must not be dead code on Linux.** Linux records carry a real `startToken`; the heartbeat check has to run before the `hasIdentity` busy early-return, and must bypass the identity-less age gate. Pinned by A3, A3b.

---

### Task 1: Pure classifier — heartbeat eligibility and staleness

**Files:**
- Modify: `src/core/locks.mjs` (`classifyLeaseOwner`, new constants)
- Test: `test/locks.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const LEASE_HEARTBEAT_STALE_MS = 60_000`
  - `classifyLeaseOwner(owner, now, isProcessDead, opts)` where `opts` gains `heartbeatAgeMs?: number|null`, `heartbeatMs?: number`, `heartbeatStaleMs?: number`
  - return type unchanged: `"reclaim" | "busy" | "blocked"`

- [ ] **Step 1: Write the failing tests**

Append to `test/locks.test.mjs` (after the existing `classifyLeaseOwner` tests). `FIXED_NOW`, `livePid`, `deadPid` already exist in that file:

```js
const HB_STALE = 60_000;
const hb = (o) => ({ heartbeatStaleMs: HB_STALE, ...o });

test("classifyLeaseOwner: declared heartbeat — stale reclaims, fresh stays busy (A3)", () => {
	const owner = { token: "t", pid: 1, identity: null, startedAt: FIXED_NOW - 2 * 60_000, heartbeatMs: 1000 };
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, hb({ heartbeatAgeMs: HB_STALE })), "reclaim");
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, hb({ heartbeatAgeMs: HB_STALE - 1 })), "busy");
});

test("classifyLeaseOwner: threshold is max(staleMs, 3 × period) — both sides (A3)", () => {
	const owner = { token: "t", pid: 1, identity: null, startedAt: FIXED_NOW - 10 * 60_000, heartbeatMs: 20_000 };
	// (a) staleMs (90s) dominates 3 × period (60s)
	const a = hb({ heartbeatStaleMs: 90_000, heartbeatAgeMs: 90_000 });
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, a), "reclaim");
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, { ...a, heartbeatAgeMs: 89_999 }), "busy");
	// (b) 3 × period (60s) dominates a 10s staleMs
	const b = hb({ heartbeatStaleMs: 10_000, heartbeatAgeMs: 60_000 });
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, b), "reclaim");
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, { ...b, heartbeatAgeMs: 59_999 }), "busy");
});

test("classifyLeaseOwner: declared bypasses the identity-less age gate (A3b)", () => {
	const young = { token: "t", pid: 1, identity: null, startedAt: FIXED_NOW - 30_000, heartbeatMs: 1000 };
	assert.equal(classifyLeaseOwner(young, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 120_000 })), "reclaim");
});

test("classifyLeaseOwner: declared runs before the hasIdentity busy path (A3, Linux shape)", () => {
	const linux = { token: "t", pid: 1, identity: { pid: 1, startToken: "s" }, startedAt: FIXED_NOW - 60_000, heartbeatMs: 1000 };
	assert.equal(classifyLeaseOwner(linux, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 120_000 })), "reclaim");
	assert.equal(classifyLeaseOwner(linux, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 0 })), "busy");
});

test("classifyLeaseOwner: legacy heartbeat requires age >= orphanAgeMs (A1b/A1c pure shape)", () => {
	const young = { token: "t", pid: 1, identity: null, startedAt: FIXED_NOW - 30_000 };
	assert.equal(classifyLeaseOwner(young, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 120_000 })), "blocked");
	const aged = { ...young, startedAt: FIXED_NOW - 10 * 60_000 };
	assert.equal(classifyLeaseOwner(aged, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 120_000 })), "reclaim");
	assert.equal(classifyLeaseOwner(aged, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 0 })), "busy");
});

test("classifyLeaseOwner: negative heartbeat age counts as fresh (A5)", () => {
	const owner = { token: "t", pid: 1, identity: null, startedAt: FIXED_NOW - 10 * 60_000, heartbeatMs: 1000 };
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, hb({ heartbeatAgeMs: -5000 })), "busy");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/locks.test.mjs`
Expected: FAIL — declared cases return `busy`/`blocked` because `opts.heartbeatAgeMs` is ignored.

- [ ] **Step 3: Implement the classifier**

Add beside `ORPHAN_LEASE_AGE_MS`:

```js
/** Age past which a heartbeating lease with no live proof of ownership is an orphan. */
export const LEASE_HEARTBEAT_STALE_MS = 60_000;
/** Consecutive supervised heartbeat failures after which a holder must vacate. */
export const MAX_CONSECUTIVE_TOUCH_FAILURES = 3;
```

Rewrite `classifyLeaseOwner` to follow the spec's D1 pseudocode exactly: early `blocked` for missing owner/token/pid; declared branch (age = `heartbeatAgeMs ?? now - startedAt`, threshold `Math.max(heartbeatStaleMs, 3 * heartbeatMs)`) before the `hasIdentity` branch; legacy branch only when `heartbeatAgeMs != null && age >= orphanAgeMs`; then the existing identity / identity-less liveness logic, with the identity-less age gate skipped when `declared`. Clamp with `Math.max(0, …)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/locks.test.mjs`
Expected: PASS. **A4** is satisfied by the pre-existing tests in this file (`fresh identity-less lock is still blocked`, `stale identity-less lock (issue #112 residue) is reclaimed`, `classifyLeaseOwner: a full identity reclaims exactly when its pid is dead`) — they must stay green with no edits.

- [ ] **Step 5: Commit**

```bash
git add src/core/locks.mjs test/locks.test.mjs
git commit -m "feat(locks): judge lease ownership by heartbeat staleness (issue #224)"
```

---

### Task 2: I/O shell — heartbeat age, reclaim metadata, declared period

**Files:**
- Modify: `src/core/locks.mjs` (`readLeaseHeartbeat`, `reclaimOrBlock`, `attemptAcquireLease`, `tryAcquireOwnedViewLock`, `acquireOwnedViewLock`)
- Test: `test/locks.test.mjs`

**Interfaces:**
- Consumes: `classifyLeaseOwner` options and constants from Task 1.
- Produces:
  - `readLeaseHeartbeat(lockPath, token, fs = defaultLocksFs, now = Date.now): number | null`
  - `lease.reclaimed: { ownerPid: number, heartbeatAgeMs: number | null, lockAgeMs: number, eligibility: "declared" | "legacy" } | null`
  - `acquireOwnedViewLock(root, viewId, name, { identity, waitMs, heartbeatMs })` / `tryAcquireOwnedViewLock(..., { identity, heartbeatMs })` — `heartbeatMs` is written into `owner.json` when provided.

- [ ] **Step 1: Write the failing tests**

Add `readFileSync` to the `node:fs` import at the top of `test/locks.test.mjs`, import `readLeaseHeartbeat` from `../src/core/locks.mjs`, then append:

```js
const HOUR = 3_600_000;
const ME_NULL = { pid: process.pid, startToken: null };   // Windows coordinator identity

function seedLock(root, viewId, name, owner, heartbeatAgeMs) {
	const lockPath = P.viewLockPath(root, viewId, name);
	mkdirSync(lockPath, { recursive: true });
	writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner));
	if (heartbeatAgeMs != null) {
		writeFileSync(join(lockPath, `heartbeat.${owner.token}`), JSON.stringify({ at: Date.now() - heartbeatAgeMs }));
	}
	return lockPath;
}

test("#224 A1: reused pid + stale heartbeat + aged lock is reclaimed", () => {
	const root = freshRoot();
	try {
		seedLock(root, "_coordinator", "state-coordinator", {
			token: "stranded", pid: process.pid,
			identity: { pid: process.pid, startToken: null },
			startedAt: Date.now() - 48 * HOUR,
		}, 24 * HOUR);
		const got = tryAcquireOwnedViewLock(root, "_coordinator", "state-coordinator", { identity: ME_NULL });
		assert.equal(got.acquired, true);
		assert.equal(got.lease.reclaimed.eligibility, "legacy");
		assert.ok(got.lease.reclaimed.heartbeatAgeMs >= 24 * HOUR - 1000);
		got.lease.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A1b: young lock with a heartbeat file stays blocked", () => {
	const root = freshRoot();
	try {
		seedLock(root, "v1", "host-meta", { token: "boot", pid: process.pid, identity: null, startedAt: Date.now() - 30_000 }, 29_000);
		const got = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: ME });
		assert.equal(got.acquired, false);
		assert.equal(got.reason, "blocked");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A1c: aged lock with a fresh heartbeat stays busy", () => {
	const root = freshRoot();
	try {
		seedLock(root, "v1", "host-meta", { token: "slow", pid: process.pid, identity: null, startedAt: Date.now() - 10 * 60_000 }, 0);
		const got = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: ME });
		assert.equal(got.acquired, false);
		assert.equal(got.reason, "busy");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A2: declared period reaches owner.json and a fresh heartbeat stays busy", () => {
	const root = freshRoot();
	try {
		const got = tryAcquireOwnedViewLock(root, "_coordinator", "state-coordinator", { identity: ME_NULL, heartbeatMs: 1000 });
		assert.equal(got.acquired, true);
		const ownerPath = join(P.viewLockPath(root, "_coordinator", "state-coordinator"), "owner.json");
		assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).heartbeatMs, 1000);
		got.lease.release();
		seedLock(root, "_coordinator", "state-coordinator", {
			token: "declared", pid: process.pid, identity: { pid: process.pid, startToken: null },
			startedAt: Date.now() - 30_000, heartbeatMs: 1000,
		}, 0);
		const held = tryAcquireOwnedViewLock(root, "_coordinator", "state-coordinator", { identity: ME_NULL });
		assert.equal(held.acquired, false);
		assert.equal(held.reason, "busy");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A5b: readLeaseHeartbeat clamps a future timestamp to 0", () => {
	const now = Date.now();
	const fakeFs = { ...defaultLocksFs, readFileSync: () => JSON.stringify({ at: now + 5000 }) };
	assert.equal(readLeaseHeartbeat("/nonexistent/lock", "t", fakeFs, now), 0);
});

test("#224 A6: broken heartbeat fails closed for legacy, falls back for declared", () => {
	const root = freshRoot();
	try {
		const legacyPath = seedLock(root, "v1", "host-meta", { token: "b", pid: process.pid, identity: null, startedAt: Date.now() - 10 * 60_000 }, null);
		writeFileSync(join(legacyPath, "heartbeat.b"), "{not json");
		const legacy = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: ME });
		assert.equal(legacy.acquired, false);
		assert.equal(legacy.reason, "busy", "unreadable heartbeat grants no eligibility");

		seedLock(root, "v2", "host-meta", {
			token: "d", pid: process.pid, identity: { pid: process.pid, startToken: null },
			startedAt: Date.now() - 10 * 60_000, heartbeatMs: 1000,
		}, null);
		writeFileSync(join(P.viewLockPath(root, "v2", "host-meta"), "heartbeat.d"), "{not json");
		const declared = tryAcquireOwnedViewLock(root, "v2", "host-meta", { identity: ME });
		assert.equal(declared.acquired, true, "declared leases fall back to startedAt");
		declared.lease.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A7: a successor's lock is never deleted by a stale reclaim", () => {
	const root = freshRoot();
	try {
		const lockPath = seedLock(root, "v1", "host-meta", { token: "old", pid: process.pid, identity: null, startedAt: Date.now() - 10 * 60_000 }, 120_000);
		const successor = { token: "new", pid: process.pid, identity: null, startedAt: Date.now() };
		const racingFs = {
			...defaultLocksFs,
			renameSync: (from, to) => {
				// A concurrent winner publishes between our read and our quarantine rename.
				if (String(from) === lockPath) writeFileSync(join(lockPath, "owner.json"), JSON.stringify(successor));
				return realRenameSync(from, to);
			},
		};
		const got = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: ME, fs: racingFs });
		assert.equal(got.acquired, false);
		assert.equal(got.reason, "busy");
		assert.equal(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).token, "new");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/locks.test.mjs`
Expected: FAIL — A1 stays `blocked`, `lease.reclaimed` is `undefined`, `readLeaseHeartbeat` is not exported.

- [ ] **Step 3: Implement the shell**

`readLeaseHeartbeat` reads `<lockPath>/heartbeat.<token>`, parses `{ at }`, returns `Math.max(0, now - at)`, and returns `null` for a missing file or unparseable/invalid `at`. `reclaimOrBlock` calls it, derives `declared`/`legacy` eligibility, passes `{ heartbeatAgeMs, heartbeatMs, heartbeatStaleMs }` to `classifyLeaseOwner`, and on `"reclaim"` attaches the metadata to the lease returned by `makeLease`. `attemptAcquireLease` writes `heartbeatMs` into the candidate `owner.json` when `opts.heartbeatMs` is a positive number and returns the reclaim metadata with the lease. Existing quarantine token verification stays untouched.

- [ ] **Step 4: Run tests to verify they pass** — `node --test test/locks.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/locks.mjs test/locks.test.mjs
git commit -m "feat(locks): read lease heartbeats in the reclaim path (issue #224)"
```

---

### Task 3: Coordinator-facing helpers

**Files:**
- Modify: `src/core/locks.mjs`
- Test: `test/locks.test.mjs`

**Interfaces:**
- Consumes: `LEASE_HEARTBEAT_STALE_MS`, `MAX_CONSECUTIVE_TOUCH_FAILURES` (Task 1); `readLeaseHeartbeat` (Task 2).
- Produces:
  - `describeLeaseConflict(root, viewId, name, opts): { reason: "reclaim"|"busy"|"blocked", ownerPid: number, hasIdentity: boolean, lockAgeMs: number, heartbeatAgeMs: number | null, heartbeatMs: number | null } | null`
  - `heartbeatFailureAction(consecutiveFailures, maxFailures = MAX_CONSECUTIVE_TOUCH_FAILURES): "continue" | "abandon"`

- [ ] **Step 1: Write the failing tests**

```js
test("#224 A8: describeLeaseConflict returns exactly six fields", () => {
	const root = freshRoot();
	try {
		seedLock(root, "_coordinator", "state-coordinator", {
			token: "t", pid: process.pid, identity: { pid: process.pid, startToken: null },
			startedAt: Date.now() - 1000,
		}, 0);
		const world = describeLeaseConflict(root, "_coordinator", "state-coordinator");
		assert.deepEqual(
			Object.keys(world).sort(),
			["hasIdentity", "heartbeatAgeMs", "heartbeatMs", "lockAgeMs", "ownerPid", "reason"],
		);
		assert.equal(world.reason, "blocked", "young identity-less lock is fail-closed");
		assert.equal(world.ownerPid, process.pid);
		assert.equal(world.hasIdentity, false);
		assert.equal(world.heartbeatMs, null);
		assert.ok(world.lockAgeMs >= 0 && world.lockAgeMs < 60_000);
		assert.ok(world.heartbeatAgeMs != null && world.heartbeatAgeMs >= 0);
		assert.equal(describeLeaseConflict(root, "_coordinator", "absent"), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A9/A9b: step-down boundary and its relationship to the stale threshold", () => {
	assert.equal(heartbeatFailureAction(2, 3), "continue");
	assert.equal(heartbeatFailureAction(3, 3), "abandon");
	assert.ok(MAX_CONSECUTIVE_TOUCH_FAILURES * 1000 < LEASE_HEARTBEAT_STALE_MS, "step down before anyone can reclaim us");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/locks.test.mjs` → FAIL (`describeLeaseConflict is not a function`).

- [ ] **Step 3: Implement both exports** — `describeLeaseConflict` reads `owner.json` and `readLeaseHeartbeat`, computes `reason` with the same classifier call the acquisition path makes, and returns exactly the six keys (return `null` when there is no readable owner). `heartbeatFailureAction` returns `"abandon"` when `consecutiveFailures >= maxFailures`.

- [ ] **Step 4: Run to verify pass** — `node --test test/locks.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/locks.mjs test/locks.test.mjs
git commit -m "feat(locks): expose lease conflict summary and step-down rule (issue #224)"
```

---

### Task 4: Coordinator diagnostics wiring

**Files:**
- Modify: `runner/state-coordinator.mjs` (acquisition failure path, post-acquisition path)
- Test: `test/state-coordinator.integration.test.mjs`

**Interfaces:**
- Consumes: `describeLeaseConflict`, `lease.reclaimed`; `appendDiagnostic` / `readDiagnostics` from `src/core/diagnostics.mjs`.
- Produces: `views/_coordinator/diagnostics.jsonl` events `lease_reclaimed` and `coordinator_lease_unavailable`.

- [ ] **Step 1: Write the failing tests**

Add `readDiagnostics` to the imports, extend the existing "second coordinator instance exits immediately (lease held)" test with the A11 block, and add the A10 test:

```js
	// A11: the loser must leave a diagnostic, not just exit silently.
	const events = readDiagnostics(root, "_coordinator");
	const failure = events.find((e) => e.code === "coordinator_lease_unavailable");
	assert.ok(failure, "acquisition failure is recorded");
	assert.deepEqual(
		Object.keys(failure.details).sort(),
		["hasIdentity", "heartbeatAgeMs", "heartbeatMs", "lockAgeMs", "ownerPid", "reason"],
	);
```

```js
test("#224 A10: a stranded lease with a reused pid is reclaimed and writes resume", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	const lockPath = P.viewLockPath(root, "_coordinator", "state-coordinator");
	mkdirSync(lockPath, { recursive: true });
	writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
		token: "stranded", pid: process.pid,
		identity: { pid: process.pid, startToken: null },
		startedAt: Date.now() - 48 * 3_600_000,
	}));
	writeFileSync(join(lockPath, "heartbeat.stranded"), JSON.stringify({ at: Date.now() - 24 * 3_600_000 }));

	child = startCoordinator(root);
	const { client } = await readyClient(root);
	client.send({
		type: "state_command", commandId: "a10-1", viewId: "v1",
		source: "dashboard-user", kind: "mark_completed", expectedRevision: null, payload: {},
	});
	const result = await client.next();
	assert.equal(result.status, "applied");

	const reclaimed = readDiagnostics(root, "_coordinator").find((e) => e.code === "lease_reclaimed");
	assert.ok(reclaimed, "lease_reclaimed is recorded");
	assert.equal(reclaimed.details.eligibility, "legacy");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/state-coordinator.integration.test.mjs` → FAIL (no `_coordinator/diagnostics.jsonl`; A11 finds no event).

- [ ] **Step 3: Implement** — in the acquisition `catch`, write `coordinator_lease_unavailable` with the six `describeLeaseConflict` fields as `details` (skip when the summary is `null`), then keep `exit(0)`. After a successful acquisition, when `lease.reclaimed` is non-null write `lease_reclaimed` with `{ ...lease.reclaimed }`.

- [ ] **Step 4: Run to verify pass** — same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add runner/state-coordinator.mjs test/state-coordinator.integration.test.mjs
git commit -m "feat(coordinator): record lease reclaims and acquisition failures (issue #224)"
```

---

### Task 5: Coordinator heartbeat supervision and step-down

**Files:**
- Modify: `runner/state-coordinator.mjs` (heartbeat interval, boot-edge touches, shutdown ordering)
- Test: `test/state-coordinator.integration.test.mjs`

**Interfaces:**
- Consumes: `heartbeatFailureAction`, `MAX_CONSECUTIVE_TOUCH_FAILURES`, `resolveTestMs`, existing `shutdown(code)`.
- Produces: `coordinator_heartbeat_lost` diagnostic; knobs `AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS`, `AGENT_BOARD_TEST_FORCE_TOUCH_FAILURE`, `AGENT_BOARD_TEST_FAIL_DIAGNOSTIC`.

- [ ] **Step 1: Write the failing tests**

```js
async function startWithHeartbeatFailure(root) {
	process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS = "50";
	process.env.AGENT_BOARD_TEST_FORCE_TOUCH_FAILURE = "1";
	return startCoordinator(root);
}

function clearHeartbeatKnobs() {
	delete process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS;
	delete process.env.AGENT_BOARD_TEST_FORCE_TOUCH_FAILURE;
	delete process.env.AGENT_BOARD_TEST_FAIL_DIAGNOSTIC;
}

test("#224 A14: persistent heartbeat failure makes the coordinator step down", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		clearHeartbeatKnobs();
		if (child && isAlive(child.pid)) {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = await startWithHeartbeatFailure(root);

	const code = await waitForExit(child, 5000);
	assert.equal(code, 0, "clean shutdown, not a crash");
	assert.equal(existsSync(P.viewLockPath(root, "_coordinator", "state-coordinator")), false, "lease released");

	const lost = readDiagnostics(root, "_coordinator").find((e) => e.code === "coordinator_heartbeat_lost");
	assert.ok(lost, "step-down is recorded");
	assert.ok(lost.details.consecutiveFailures >= 3);

	if (process.platform !== "win32") {
		assert.equal(existsSync(P.coordinatorEndpointPathFor(process.platform, root)), false, "socket unlinked");
	}
});

test("#224 A14b: a failing diagnostic write must not block the step-down", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		clearHeartbeatKnobs();
		if (child && isAlive(child.pid)) {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	process.env.AGENT_BOARD_TEST_FAIL_DIAGNOSTIC = "1";
	child = await startWithHeartbeatFailure(root);

	const code = await waitForExit(child, 5000);
	assert.equal(code, 0, "diagnostic failure must not skip shutdown");
	assert.equal(existsSync(P.viewLockPath(root, "_coordinator", "state-coordinator")), false, "lease still released");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/state-coordinator.integration.test.mjs` → FAIL (process keeps running, no step-down).

- [ ] **Step 3: Implement**

Read the cadence via `resolveTestMs(process.env, "AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS", HEARTBEAT_MS)` (import from `src/core/test-knobs.mjs`) and pass `heartbeatMs` into `acquireOwnedViewLock`. Then:

1. Add boot-edge `lease.touch()` calls whose results are ignored (never counted).
2. **Start the supervision interval only inside the `server.listen` callback**, after `boundSocketIdentity` is recorded: each tick does the supervised touch (`AGENT_BOARD_TEST_FORCE_TOUCH_FAILURE` forces `false`), resets or increments a counter, and on `heartbeatFailureAction(...) === "abandon"` writes `coordinator_heartbeat_lost` inside `try/catch` (where `AGENT_BOARD_TEST_FAIL_DIAGNOSTIC` makes the write throw) and then calls `shutdown(0)`.

- [ ] **Step 4: Run to verify pass** — same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add runner/state-coordinator.mjs test/state-coordinator.integration.test.mjs
git commit -m "feat(coordinator): step down when the lease heartbeat cannot be written (issue #224)"
```

---

### Task 6: Full verification and acceptance accounting

**Files:** none (commands only).

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`
Expected: typecheck, perf gate, `node --test test/*.test.mjs`, coverage thresholds (lines 85 / funcs 80 / branches 70) and `npm pack --dry-run` all pass; the dry run lists the new docs spec and no new runtime file.

- [ ] **Step 2: Record the acceptance ledger**

Produce a table mapping every spec ID to evidence: A1–A14b → test name + PASS; A12/A13 → verify output; U1/U2 → `pending (Windows machine + merged build)`. U1/U2 must **not** be reported as verified.

- [ ] **Step 3:** Report the ledger in the PR body; no repository artifact unless the repo already stores such ledgers.
