# Coordinator Replacement Identity Verification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `replaceStaleCoordinator` signal a lease-owner pid only after proving, from fresh evidence, that the lease record belongs to the coordinator actually serving the endpoint — and never let a diagnostic or signal failure break `sendStateCommand`.

**Architecture:** The coordinator records its in-process `instanceId` inside the already-passthrough lease `identity` object. The client reads the lease, judges same-ness with a pure function (instanceId equality, else a live `/proc` startToken compare for Linux legacy records), re-confirms with a second endpoint probe plus a lease re-read (TOCTOU), then sends SIGTERM and waits for process exit. The residual lease is left to the existing #224 reclaim — no client-side lease deletion. Skipped signals write one deduped diagnostic.

**Tech Stack:** Node ≥20 ESM (`.mjs`), `node:test` + `assert/strict`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-issue-239-coordinator-replacement-identity-design.md` (issue #239, sha256 `a6e578bf…`; worktree is based on `main` @ `60083f6` — the two upstream commits since the spec baseline touch only UI files).

## Global Constraints

- Tabs for indentation in `.mjs`/`.ts` sources; English comments and commit messages; conventional commit subjects with the PR number only after the PR exists (`(#N)` appended later if needed).
- `coordinator-client.mjs` module contract: **never throws** for `ensureCoordinator`/`sendStateCommand` (existing doc at `src/core/coordinator-client.mjs:11-24`). Every new path must preserve it.
- Do not change `src/core/locks.mjs`, do not bump `COORDINATOR_PROTOCOL_VERSION`, do not add client-side lease deletion (spec non-goals N1/N2/N3/N5).
- `EnsureResult` shape stays `{ ok, instanceId?, pid?, error? }`; `coordinator_stale_protocol` stays the failure code (`test/coordinator-client.test.mjs:409` deepEqual must keep passing).
- Lease `identity` stays a passthrough object; `classifyLeaseOwner` behavior must not change.
- Test commands: `node --test test/coordinator-client.test.mjs`; full local suite `npm test`; CI gate is `npm run verify`.
- Local Windows baseline (do not regress): 1375 tests / 62 fail / 5 skip; `coordinator-client` and `locks` files are green. Failure-name list: `~/.github-issue-driven/zhuxixi/pi-agent-board/issue-239/research/baseline-failures.txt` (strip trailing ` (1234.5ms)` before set comparison).

## Review Focus

- **Signal must never reach an unrelated pid**: a lease whose `pid` belongs to a live non-coordinator process must not be SIGTERMed under any branch (J2/J4/J6/J7, and the re-probe paths).
- **Fresh evidence only**: the judge input `probedInstanceId` must be the pong observed in *this* call, never a cached value; the re-probe must catch "old instance already gone" and "another old instance took over".
- **never-throws**: diagnostic writes (`appendDiagnosticOnce`), `kill`, `isAlive`, and `readProcessStartToken` are all fallible; each failure has a defined non-throwing outcome (spec D4/D5).
- **No root resurrection**: a deleted board root must not be recreated by a diagnostic write (spec A3k, #241 class).
- **Diagnostic flood**: repeated `ensureCoordinator` calls (run_progress beats ~4/s) must not grow `_coordinator/diagnostics.jsonl`.
- **Windows SIGTERM is TerminateProcess**: the wait-for-exit is the only thing that stops the next spawn from racing a still-exiting process; `existsSync(socketPath)` is meaningless on win32 (named pipe).

## File Structure

| File | Responsibility |
|---|---|
| `src/core/coordinator-client.mjs` | lease record reader, pure judge, replacement orchestration, deduped skip diagnostic, `ensureCoordinator` wiring |
| `runner/state-coordinator.mjs` | write `instanceId` into the lease `identity` (one-line change at the existing `acquireOwnedViewLock` call) |
| `test/coordinator-client.test.mjs` | unit tests (T1/T2/T3) + integration fixtures (T4/T5/T6) |

No new source files. The U1 verification script lives outside the repo in the issue research directory (not committed).

---

### Task 1: Coordinator records `identity.instanceId`

**Files:**
- Modify: `runner/state-coordinator.mjs:227-231` (the `acquireOwnedViewLock` call in `main()`)
- Test: `test/coordinator-client.test.mjs` (extend the existing real-spawn happy-path test near `:164-186`)

**Interfaces:**
- Consumes: `instanceId` (already generated at `runner/state-coordinator.mjs:198`)
- Produces: lease `owner.json` field `identity.instanceId` — the value is identical to the pong's `instanceId` (`runner/state-coordinator.mjs:431`)

- [ ] **Step 1: Write the failing test** — in `test/coordinator-client.test.mjs`, extend the `ensureCoordinator spawns the real coordinator…` test (or add a focused test after it):

```js
test("coordinator records its instanceId in the lease identity (issue #239 A4)", async (t) => {
	const root = freshRoot();
	t.after(async () => { await cleanupRoot(root); });
	createView(root, { id: "v1", name: "a4", cwd: root });

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true);
	if (ensured.pid) track(ensured.pid);

	const owner = JSON.parse(readFileSync(
		join(P.viewLockPath(root, "_coordinator", "state-coordinator"), "owner.json"), "utf8"));
	assert.equal(typeof owner.identity?.instanceId, "string");
	assert.notEqual(owner.identity.instanceId.length, 0);
	assert.equal(owner.identity.instanceId, ensured.instanceId);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test test/coordinator-client.test.mjs`
Expected: FAIL — `owner.identity.instanceId` is `undefined`.

- [ ] **Step 3: Implement** — in `runner/state-coordinator.mjs`, add `instanceId` to the identity object:

```js
identity: { pid: process.pid, startToken: captureStartToken(process.pid), instanceId },
```

- [ ] **Step 4: Run the test file**

Run: `node --test test/coordinator-client.test.mjs`
Expected: PASS (the new test and all existing tests).

- [ ] **Step 5: Commit**

```bash
git add runner/state-coordinator.mjs test/coordinator-client.test.mjs
git commit -m "feat(coordinator): record instanceId in the lease identity (issue #239)"
```

---

### Task 2: Lease record reader + pure judge

**Files:**
- Modify: `src/core/coordinator-client.mjs` (replace `readCoordinatorLeasePid` at `:119-135`; add `judgeReplacementTarget`)
- Test: `test/coordinator-client.test.mjs` (new unit tests; import the two functions)

**Interfaces:**
- Produces:
  - `readCoordinatorLeaseRecord(root): { token: string|null, pid: number|null, instanceId: string|null, startToken: string|null } | null`
    - `pid` = `Number(owner.identity.pid ?? owner.pid)`, `null` when not a positive finite number
    - `instanceId` = first non-empty string of `owner.identity.instanceId`, `owner.instanceId`
    - `startToken` = `owner.identity.startToken` when it is a non-empty string, else `null`
    - returns `null` on missing file / bad JSON / non-object
  - `judgeReplacementTarget({ recorded, probedInstanceId, currentStartToken })` → `{ action: "signal" } | { action: "skip", reason }`
    - order: `recorded`/`pid` invalid → `skip("lease_unreadable")`; `recorded.instanceId !== null` → equal = `signal`, unequal = `skip("lease_owner_mismatch")`; else (legacy) `recorded.startToken === null` → `skip("identity_unverified")`; `currentStartToken` not a string (null/undefined/Promise) → `skip("identity_unverified")`; unequal → `skip("pid_reused")`; equal → `signal`

- [ ] **Step 1: Write the failing tests** — append to `test/coordinator-client.test.mjs` (update the import line to include both functions):

```js
// --- issue #239: lease record + pure judge (T1/T2) ---

function mkRecord(overrides = {}) {
	return { token: "t1", pid: 4242, instanceId: "abc", startToken: null, ...overrides };
}

test("judgeReplacementTarget: instanceId equality decides (J1/J2)", () => {
	assert.deepEqual(judgeReplacementTarget({ recorded: mkRecord(), probedInstanceId: "abc" }), { action: "signal" });
	assert.deepEqual(judgeReplacementTarget({ recorded: mkRecord(), probedInstanceId: "other" }),
		{ action: "skip", reason: "lease_owner_mismatch" });
});

test("judgeReplacementTarget: legacy startToken fallback (J3/J4/J5/J6)", () => {
	const legacy = mkRecord({ instanceId: null, startToken: "777" });
	assert.deepEqual(judgeReplacementTarget({ recorded: legacy, probedInstanceId: "x", currentStartToken: "777" }), { action: "signal" });
	assert.deepEqual(judgeReplacementTarget({ recorded: legacy, probedInstanceId: "x", currentStartToken: "888" }),
		{ action: "skip", reason: "pid_reused" });
	assert.deepEqual(judgeReplacementTarget({ recorded: legacy, probedInstanceId: "x", currentStartToken: null }),
		{ action: "skip", reason: "identity_unverified" });
	assert.deepEqual(judgeReplacementTarget({ recorded: legacy, probedInstanceId: "x", currentStartToken: Promise.resolve("777") }),
		{ action: "skip", reason: "identity_unverified" }, "a missed await must not read as pid_reused");
	const noToken = mkRecord({ instanceId: null, startToken: null });
	assert.deepEqual(judgeReplacementTarget({ recorded: noToken, probedInstanceId: "x" }),
		{ action: "skip", reason: "identity_unverified" });
});

test("judgeReplacementTarget: malformed records are never signalled (J7)", () => {
	assert.deepEqual(judgeReplacementTarget({ recorded: null, probedInstanceId: "x" }),
		{ action: "skip", reason: "lease_unreadable" });
	assert.deepEqual(judgeReplacementTarget({ recorded: mkRecord({ pid: 0 }), probedInstanceId: "abc" }),
		{ action: "skip", reason: "lease_unreadable" });
});

test("judgeReplacementTarget: empty-string fields count as missing", () => {
	assert.deepEqual(judgeReplacementTarget({ recorded: mkRecord({ instanceId: "" }), probedInstanceId: "abc" }),
		{ action: "skip", reason: "identity_unverified" });
});

test("readCoordinatorLeaseRecord parses identity / legacy / top-level instanceId (A2)", () => {
	const root = freshRoot();
	const lockPath = P.viewLockPath(root, "_coordinator", "state-coordinator");
	mkdirSync(lockPath, { recursive: true });
	const ownerPath = join(lockPath, "owner.json");

	assert.equal(readCoordinatorLeaseRecord(root), null, "missing owner.json");
	writeFileSync(ownerPath, "{not json", "utf8");
	assert.equal(readCoordinatorLeaseRecord(root), null, "corrupt json");

	writeFileSync(ownerPath, JSON.stringify({ token: "a", pid: 7, identity: { pid: 7, startToken: "9", instanceId: "i" } }), "utf8");
	assert.deepEqual(readCoordinatorLeaseRecord(root), { token: "a", pid: 7, instanceId: "i", startToken: "9" });

	writeFileSync(ownerPath, JSON.stringify({ token: "b", pid: 8, identity: { pid: 8, startToken: null } }), "utf8");
	assert.deepEqual(readCoordinatorLeaseRecord(root), { token: "b", pid: 8, instanceId: null, startToken: null });

	writeFileSync(ownerPath, JSON.stringify({ token: "c", pid: 9, instanceId: "top" }), "utf8");
	assert.equal(readCoordinatorLeaseRecord(root).instanceId, "top", "top-level compatibility");

	writeFileSync(ownerPath, JSON.stringify({ token: "d", identity: null }), "utf8");
	assert.equal(readCoordinatorLeaseRecord(root).pid, null);
	rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `node --test test/coordinator-client.test.mjs`
Expected: FAIL — `judgeReplacementTarget`/`readCoordinatorLeaseRecord` are not exported.

- [ ] **Step 3: Implement** — in `src/core/coordinator-client.mjs`, replace `readCoordinatorLeasePid` with the exported `readCoordinatorLeaseRecord` (same read, richer shape) and add the exported pure `judgeReplacementTarget` exactly per the Interfaces block. Delete the now-unused `readCoordinatorLeasePid` and update `replaceStaleCoordinator`'s call site to the new reader (temporary: it may still use `.pid` for now; Task 4 rewrites the function).

- [ ] **Step 4: Run the test file**

Run: `node --test test/coordinator-client.test.mjs`
Expected: PASS. `npm run typecheck` also passes (JSDoc types are checked).

- [ ] **Step 5: Commit**

```bash
git add src/core/coordinator-client.mjs test/coordinator-client.test.mjs
git commit -m "feat(coordinator): lease record reader and pure replacement judge (issue #239)"
```

---

### Task 3: Deduped skip diagnostic

**Files:**
- Modify: `src/core/coordinator-client.mjs` (module-level Set + `reportReplacementSkip`)
- Test: `test/coordinator-client.test.mjs` (unit test the diagnostic writer through the exported replacement path — see Task 4; here test the dedup contract by calling the exported helper if it is exported, otherwise defer the assertion to Task 4's A8 test)

**Interfaces:**
- Produces: internal `reportReplacementSkip(root, { reason, recordedInstanceId, probedInstanceId })`
  - module-level `Set` key `${root}|${reason}|${recordedInstanceId ?? "null"}|${probedInstanceId}`; a hit returns immediately without touching disk
  - on miss: `if (!existsSync(root)) return;` then `appendDiagnosticOnce(root, "_coordinator", patch, { match: ["reason", "recordedInstanceId", "probedInstanceId"] })`; everything in `try/catch`
  - patch: `{ source: "coordinator-client", level: "warn", code: "coordinator_replacement_skipped", message: \`coordinator replacement skipped: ${reason}\`, details: { reason, recordedInstanceId: recordedInstanceId ?? null, probedInstanceId } }`

- [ ] **Step 1:** Implement `reportReplacementSkip` and call it from the replacement function's every skip return (wired fully in Task 4). No new test in this task — its observable contract (`≤1` event for repeated calls, no root resurrection) is asserted by A8/A3k in Task 4, because it is not exported (keeps the public surface small).

- [ ] **Step 2: Commit**

```bash
git add src/core/coordinator-client.mjs
git commit -m "feat(coordinator): deduped replacement-skip diagnostic (issue #239)"
```

---

### Task 4: `replaceStaleCoordinator` orchestration

**Files:**
- Modify: `src/core/coordinator-client.mjs` (`replaceStaleCoordinator` body; export it)
- Test: `test/coordinator-client.test.mjs` (T3 unit tests A3a-A3l + A8 dedup)

**Interfaces:**
- `replaceStaleCoordinator(root, socketPath, expectedInstanceId, opts = {}) → Promise<ReplaceOutcome>`
  - `ReplaceOutcome = { replaced: true } | { replaced: false, reason }`
  - `SkipReason = "lease_unreadable"|"lease_owner_mismatch"|"pid_reused"|"identity_unverified"|"lease_changed"|"instance_unresponsive"|"replacement_raced"|"replace_timeout"`
  - opts (all optional, defaults in spec §4): `probe` (default `probeOnce`, signature `(socketPath, connect, timeoutMs)`), `connect`, `probeTimeoutMs`, `readLease`, `kill` (default `process.kill`), `isAlive`, `readStartToken` (default `readProcessStartToken`, async), `clock`, `sleep`, `replaceTimeoutMs`, `reportSkip`
  - flow (spec D3/D4, exact order): read lease → legacy live-token read only when `instanceId` is null and `startToken` is a string → judge → skip or continue → **re-probe**: pong & same instanceId → continue; pong & different instanceId → `protocolVersion >= COORDINATOR_PROTOCOL_VERSION` ? `{replaced:true}` : `skip("replacement_raced")`; `null` → re-read lease (null/invalid → `skip("lease_unreadable")`; `isAlive(pid)` → `skip("instance_unresponsive")`; else `{replaced:true}`) → **re-read lease**: token/instanceId changed → `skip("lease_changed")` → `kill(pid, "SIGTERM")` in try/catch (`ESRCH` → `{replaced:true}`) → poll `isAlive` every 50ms until `replaceTimeoutMs` (`{replaced:true}` on exit, else `skip("replace_timeout")`)
  - every `skip` return calls `reportSkip` inside its own try/catch

- [ ] **Step 1: Write the failing unit tests** — append to `test/coordinator-client.test.mjs`:

```js
// --- issue #239: replacement orchestration (T3) ---

/** Build injected dependencies for replaceStaleCoordinator; `calls` records kills. */
function mkReplacementDeps(overrides = {}) {
	const calls = { kill: [], probe: 0, report: [] };
	const deps = {
		readLease: () => mkRecord(),
		probe: async () => { calls.probe += 1; return { instanceId: "abc", protocolVersion: COORDINATOR_PROTOCOL_VERSION }; },
		kill: (pid, sig) => { calls.kill.push([pid, sig]); },
		isAlive: () => false,
		readStartToken: async () => null,
		clock: () => 0,
		sleep: async () => {},
		replaceTimeoutMs: 3000,
		reportSkip: (details) => { calls.report.push(details); },
		...overrides,
	};
	return { deps, calls };
}

test("A3a: matching instanceId signals once and reports replaced", async () => {
	const { deps, calls } = mkReplacementDeps();
	const out = await replaceStaleCoordinator("/root", "/sock", "abc", deps);
	assert.deepEqual(out, { replaced: true });
	assert.deepEqual(calls.kill, [[4242, "SIGTERM"]]);
});

test("A3b: mismatched instanceId never signals", async () => {
	const { deps, calls } = mkReplacementDeps({ readLease: () => mkRecord({ instanceId: "other" }) });
	const out = await replaceStaleCoordinator("/root", "/sock", "abc", deps);
	assert.deepEqual(out, { replaced: false, reason: "lease_owner_mismatch" });
	assert.deepEqual(calls.kill, []);
	assert.equal(calls.report.at(-1).reason, "lease_owner_mismatch");
});

test("A3c/A3d: re-probe null with dead pid replaces; with live pid skips", async () => {
	const dead = mkReplacementDeps({ probe: async () => null, isAlive: () => false });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", dead.deps), { replaced: true });
	assert.deepEqual(dead.calls.kill, []);

	const live = mkReplacementDeps({ probe: async () => null, isAlive: () => true });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", live.deps),
		{ replaced: false, reason: "instance_unresponsive" });
	assert.deepEqual(live.calls.kill, []);
});

test("A3e: another old-protocol instance taking over skips; a healthy one replaces", async () => {
	const stale = mkReplacementDeps({ probe: async () => ({ instanceId: "newer-old", protocolVersion: 1 }) });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", stale.deps),
		{ replaced: false, reason: "replacement_raced" });

	const healthy = mkReplacementDeps({ probe: async () => ({ instanceId: "new", protocolVersion: COORDINATOR_PROTOCOL_VERSION }) });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", healthy.deps), { replaced: true });
	assert.deepEqual(healthy.calls.kill, []);
});

test("A3f: lease changing between judge and signal skips", async () => {
	let reads = 0;
	const { deps, calls } = mkReplacementDeps({ readLease: () => (++reads === 1 ? mkRecord() : mkRecord({ token: "t2" })) });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", deps),
		{ replaced: false, reason: "lease_changed" });
	assert.deepEqual(calls.kill, []);
});

test("A3g: a process that never exits times out after the kill", async () => {
	let now = 0;
	const { deps, calls } = mkReplacementDeps({ isAlive: () => true, clock: () => now, sleep: async () => { now += 100; } });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", deps),
		{ replaced: false, reason: "replace_timeout" });
	assert.equal(calls.kill.length, 1);
});

test("A3h: a throwing reportSkip does not throw or change the outcome", async () => {
	const { deps } = mkReplacementDeps({
		readLease: () => mkRecord({ instanceId: "other" }),
		reportSkip: () => { throw new Error("disk full"); },
	});
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", deps),
		{ replaced: false, reason: "lease_owner_mismatch" });
});

test("A3j: unreadable lease on the null-probe re-read skips", async () => {
	let reads = 0;
	const { deps, calls } = mkReplacementDeps({
		probe: async () => null,
		readLease: () => (++reads === 1 ? mkRecord() : null),
	});
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", deps),
		{ replaced: false, reason: "lease_unreadable" });
	assert.deepEqual(calls.kill, []);
});

test("A3l: kill errors are contained (ESRCH replaces, EPERM times out)", async () => {
	const esrch = Object.assign(new Error("gone"), { code: "ESRCH" });
	const a = mkReplacementDeps({ kill: () => { throw esrch; } });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", a.deps), { replaced: true });

	const eperm = Object.assign(new Error("denied"), { code: "EPERM" });
	const b = mkReplacementDeps({ kill: () => { throw eperm; }, isAlive: () => true, clock: () => 0, sleep: async () => {} });
	assert.deepEqual(await replaceStaleCoordinator("/root", "/sock", "abc", b.deps),
		{ replaced: false, reason: "replace_timeout" });
});

test("A3k: a removed root is not resurrected by the skip diagnostic", async () => {
	const root = join(freshRoot(), "removed-root"); // never created on disk
	const { deps } = mkReplacementDeps({
		readLease: () => mkRecord({ instanceId: "other" }),
		reportSkip: undefined, // default writer -> existsSync guard
	});
	// default reportSkip is not injectable here; instead assert the default writer's guard:
	const out = await replaceStaleCoordinator(root, "/sock", "abc", { ...deps, reportSkip: undefined });
	assert.deepEqual(out, { replaced: false, reason: "lease_owner_mismatch" });
	assert.equal(existsSync(root), false, "a deleted/missing root must not be recreated");
});
```

(Imports to extend: `readCoordinatorLeaseRecord`, `judgeReplacementTarget`, `replaceStaleCoordinator`; fs: `existsSync`.)

- [ ] **Step 2: Run and see them fail**

Run: `node --test test/coordinator-client.test.mjs`
Expected: FAIL — `replaceStaleCoordinator` not exported / old body lacks the branches.

- [ ] **Step 3: Implement** — rewrite `replaceStaleCoordinator` per the Interfaces flow. Keep `REPLACE_TIMEOUT_MS = 3_000` and add `REPLACE_POLL_MS = 50`. The old `existsSync(socketPath)` wait is deleted.

- [ ] **Step 4: Run and confirm green**

Run: `node --test test/coordinator-client.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/coordinator-client.mjs test/coordinator-client.test.mjs
git commit -m "feat(coordinator): verify lease identity before signalling (issue #239)"
```

---

### Task 5: `ensureCoordinator` wiring + integration fixtures

**Files:**
- Modify: `src/core/coordinator-client.mjs` (`ensureCoordinator` replacement branch + opts pass-through)
- Modify: `test/coordinator-client.test.mjs` (`STALE_COORDINATOR_CJS` fixture + new scenario fixtures/tests)

**Interfaces:**
- Consumes: Task 4 `replaceStaleCoordinator`, Task 3 `reportReplacementSkip`
- Produces: `ensureCoordinator` accepts `probe`, `kill`, `isAlive`, `readStartToken`, `clock`, `sleep`, `replaceTimeoutMs`, `reportSkip` and forwards them plus `connect`/`probeTimeoutMs` into `replaceStaleCoordinator`; result shape unchanged.
- Fixture contract: `spawnStaleV1Coordinator(root, ownerOverrides, pongInstanceId)` — the CJS writes `identity: { pid, startToken: "1", ...ownerOverrides.identity }`; when `ownerOverrides.instanceId` is set it is merged into `identity`; its pong instanceId is parameterized (default `"stale-v1"`).

- [ ] **Step 1: Write the failing integration tests** — update the fixture and add:

```js
test("A5: a matching-instanceId stale coordinator is replaced (end-to-end)", async (t) => {
	const root = freshRoot();
	t.after(async () => { await cleanupRoot(root); });
	const stale = await spawnStaleV1Coordinator(root); // fixture now records identity.instanceId = "stale-v1"
	t.after(() => stale.cleanup());
	createView(root, { id: "v1", name: "a5", cwd: root });
	assert.equal((await rawPing(stale.socketPath))?.instanceId, "stale-v1");

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true);
	assert.notEqual(ensured.instanceId, "stale-v1");
	if (ensured.pid) track(ensured.pid);
	assert.equal(stale.alive(), false);
	assert.equal((await sendStateCommand(root, markCompleted(), { timeoutMs: 5000 })).status, "applied");
});

test("A6: a mismatched lease identity never kills the unrelated pid (core)", async (t) => {
	const root = freshRoot();
	const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	t.after(() => { try { unrelated.kill("SIGKILL"); } catch {} });
	const stale = await spawnStaleV1Coordinator(root, { instanceId: "not-the-pong-instance", pid: unrelated.pid });
	t.after(() => stale.cleanup());
	const diagnostics = join(P.diagnosticsPath(root, "_coordinator"));

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.deepEqual(ensured, { ok: false, error: "coordinator_stale_protocol" });
	assert.equal(isAlive(unrelated.pid), true, "the unrelated process must survive");
	assert.equal(stale.alive(), true);
	const events = readJsonl(diagnostics).filter((e) => e.code === "coordinator_replacement_skipped");
	assert.equal(events.length, 1);
	assert.equal(events[0].details.reason, "lease_owner_mismatch");
});

test("A7: a legacy record without instanceId/token is not signalled", async (t) => {
	// same fixture with identity: { pid, startToken: null }, no instanceId; pong instanceId "stale-v1"
	// expect: stale alive, stale_protocol, reason identity_unverified
});

test("A8: repeated ensures keep exactly one skip diagnostic", async (t) => {
	// mismatched identity lease + 5 sequential ensureCoordinator calls -> 1 event total
});

test("A7b: Linux legacy live-token wiring kills the real lease owner", { skip: process.platform !== "linux" }, async (t) => {
	// fixture whose owner.json records the CHILD's real startToken (captureStartToken(child.pid)),
	// no instanceId; pong instanceId arbitrary -> J3 -> child killed, new coordinator takes over
});
```

(Exact bodies: follow the existing `spawnStaleV1Coordinator` helper shape at `test/coordinator-client.test.mjs:330-357`; for A6/A7/A8 spawn the fixture with `ownerOverrides` so `pid`/`identity`/`instanceId` are explicit. Import `isAlive`, `readJsonl`, `P.diagnosticsPath`, `captureStartToken` as needed.)

- [ ] **Step 2: Run and see them fail**

Run: `node --test test/coordinator-client.test.mjs`
Expected: FAIL — the fixture does not parameterize identity yet; `ensureCoordinator` does not pass `first.instanceId`.

- [ ] **Step 3: Implement**
  1. Fixture: add arguments to `spawnStaleV1Coordinator(root, ownerOverrides = {}, pongInstanceId = "stale-v1")`; build the `owner.json` object in JS and embed it into `STALE_COORDINATOR_CJS` via `JSON.stringify` (replace the hardcoded write at `:307`), and parameterize the pong instanceId at `:317`.
  2. `ensureCoordinator`: replace the `replaceStaleCoordinator(root, socketPath)` call with the outcome-based call forwarding `first.instanceId` and all injectable opts; `!outcome.replaced` → `{ ok: false, error: "coordinator_stale_protocol" }`.

- [ ] **Step 4: Run the file, then the local suite**

```bash
node --test test/coordinator-client.test.mjs
npm test *> after-239.log
# compare ✖ names (strip trailing " (123.4ms)") against baseline-failures.txt: after ⊆ baseline
```

- [ ] **Step 5: Commit**

```bash
git add src/core/coordinator-client.mjs test/coordinator-client.test.mjs
git commit -m "fix(coordinator): only replace a coordinator whose lease identity matches (issue #239)"
```

---

### Task 6: U1 verification script + final gates

**Files:**
- Create (outside repo, issue research dir): `~/.github-issue-driven/zhuxixi/pi-agent-board/issue-239/research/verify-u1-legacy-no-kill.mjs`
- Test: run it; no repo files change in this task (except possible goal-driven touch-ups from the gates)

**Interfaces:**
- CLI: `node verify-u1-legacy-no-kill.mjs --root <isolated-root> [--recover]`
- imports the implementation checkout by absolute file URL passed via `--checkout <path>` (default = the worktree root detected from `process.cwd()`); uses `--root` for the board root; creates a `createView` row; writes the legacy lease with an unrelated live node child pid; binds a v1 pong on `P.coordinatorEndpointPathFor(process.platform, root)`; calls `ensureCoordinator(root)`; prints `{ outcome, unrelatedAlive, diagnostics }`; `--recover` skips scenario construction and runs one more `ensureCoordinator(root)`.

- [ ] **Step 1: Write the script** (per spec §7; reuse the `STALE_COORDINATOR_CJS` shape from the test file).
- [ ] **Step 2: Run it twice against the worktree checkout**

```bash
node "<issue>/research/verify-u1-legacy-no-kill.mjs" --root "$env:TEMP\ab-u1-239" --checkout "<worktree>"
node "<issue>/research/verify-u1-legacy-no-kill.mjs" --root "$env:TEMP\ab-u1-239" --checkout "<worktree>"
```
Expected: `outcome.error === "coordinator_stale_protocol"`, `unrelatedAlive === true`, one `coordinator_replacement_skipped` with `reason: "identity_unverified"`, second run adds no diagnostic.
- [ ] **Step 3: Recovery demo** — delete the isolated lease dir, run with `--recover` → `outcome.ok === true`; then stop that coordinator / delete the isolated root.
- [ ] **Step 4: Final gates** — `npm run typecheck`; `node --test test/coordinator-client.test.mjs test/locks.test.mjs test/state-coordinator.integration.test.mjs`; `npm test` vs baseline (A10); record all results in the PR body.
- [ ] **Step 5: Commit any final fix; do not commit the script.**

---

## Self-Review

**1. Spec coverage** — A1/A2 (Task 2), A3a-A3l/A8 (Task 4; A8 re-asserted at ensure level in Task 5), A4 (Task 1), A5/A6/A7/A7b/A8 (Task 5), A9/A10/A11 (Task 5 Step 4 + Task 6 Step 4), U1 (Task 6). D1 (Task 1), D2 (Task 2), D3/D4/D5 (Task 4), D6 (Task 2 judge legacy + Task 4 live-token read + A7b). Every spec decision has an owning task.

**2. Step scan** — each step names the exact test, command, function signature, or file; no TBD/skip placeholders except the four integration tests whose bodies are pinned by the fixture contract paragraph in Task 5 (they reuse the existing helper verbatim).

**3. Type consistency** — `LeaseRecord`, `ReplaceOutcome`, `SkipReason`, `judgeReplacementTarget` args, and `replaceStaleCoordinator` opts names are identical across Tasks 2/4/5; `ensureCoordinator` forwards the same names.

**4. Review Focus** — each of the six listed failure modes has a test: unrelated-pid survial (A6/A7/A3b), fresh evidence (A3c/A3d/A3e), never-throws (A3h/A3l), root resurrection (A3k), diagnostic flood (A8), Windows SIGTERM semantics (A3g timeout + wait-for-exit; U1 on win32).

**5. Proportion** — plan ≈ 2.5× the spec's length in lines but mostly test code the spec's matrix demanded; no production body is transcribed except the flow order that the spec fixes.
