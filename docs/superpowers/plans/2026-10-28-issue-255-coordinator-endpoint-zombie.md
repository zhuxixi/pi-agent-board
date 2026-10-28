# Issue #255 — Coordinator endpoint zombie: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A coordinator that loses its endpoint steps down within one heartbeat tick, and a
deposed coordinator can no longer unlink an endpoint it does not own.

**Architecture:** Two changes. (1) `classifyEndpointHealth` + `socketIdentityObservation` +
`shouldUnlinkEndpoint` become pure exports in `src/core/host-coordination.mjs`; (2) the
coordinator runner wires them into the existing 1 s heartbeat tick (self-supervision) and into
`shutdown()` (owner-token cleanup gate). All I/O stays in `runner/state-coordinator.mjs`; no
new timers, no protocol changes.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `assert/strict`, existing repo fixtures.

**Spec:** `docs/superpowers/specs/2026-10-28-issue-255-coordinator-endpoint-zombie-design.md`

## Global Constraints

- POSIX-only behaviour: all endpoint assertions are guarded by `process.platform !== "win32"`.
- No new timers: reuse `heartbeatTimer` (state-coordinator.mjs:344).
- Diagnostic appends from a step-down path MUST be `try/catch`-fenced (#224 D4).
- No wire-format change; no new protocol message types.
- Tabs for indentation; English comments.
- Commit subjects: conventional (`test:`, `feat:`, `fix:`), with `(issue #255)` suffix.
- New integration case titles MUST start with `#255 A<n>: ` so `--test-name-pattern` can select them.

## Review Focus

- A transient `statSync` error (EACCES/EBUSY) must never step a healthy coordinator down —
  pinned by A2 (`{kind:"unknown"}` row) and by the `unknown ⇒ never step down` classify row.
- A failing diagnostic append must not turn a clean step-down into a crash — pinned by A4b.
- A deposed owner must not delete its own (or a successor's) endpoint — pinned by A3.
- The replacement endpoint must survive the step-down that it caused — pinned by A5.
- A14's single-owner cleanup must stay green — pinned by A6/A14 regression run.

---

### Task 1: Pure decision functions + unit tests

**Files:**
- Modify: `src/core/host-coordination.mjs` (append three exports after `ownsEndpoint`, ~:162)
- Test: `test/host-coordination.test.mjs` (import them; add two tests after the `ownsEndpoint` test at :125)

**Interfaces:**
- Consumes: `ownsEndpoint(bound, current)` (already exported at host-coordination.mjs:160).
- Produces:
  - `shouldUnlinkEndpoint({ stillOwner, compromised, bound, current }) -> boolean`
  - `socketIdentityObservation(stat: {dev:number,ino:number}|null, errorCode: string|null) -> {kind:"ok",dev,ino}|{kind:"missing"}|{kind:"unknown"}`
  - `classifyEndpointHealth(bound: {dev:number,ino:number}|null, observed: observation|null) -> "ok"|"missing"|"replaced"|"unknown"`

- [ ] **Step 1: Write the failing tests**

In `test/host-coordination.test.mjs`, extend the import list with the three names and append:

```js
test("shouldUnlinkEndpoint gates on lease ownership and compromise", () => {
	const same = { dev: 1, ino: 2 };
	assert.equal(shouldUnlinkEndpoint({ stillOwner: true, compromised: false, bound: same, current: same }), true);
	assert.equal(shouldUnlinkEndpoint({ stillOwner: false, compromised: false, bound: same, current: same }), false);
	assert.equal(shouldUnlinkEndpoint({ stillOwner: true, compromised: true, bound: same, current: same }), false);
	assert.equal(shouldUnlinkEndpoint({ stillOwner: true, compromised: false, bound: same, current: { dev: 1, ino: 3 } }), false);
	assert.equal(shouldUnlinkEndpoint({ stillOwner: false, compromised: false, bound: same, current: { dev: 1, ino: 3 } }), false);
	assert.equal(shouldUnlinkEndpoint({ stillOwner: true, compromised: true, bound: same, current: { dev: 1, ino: 3 } }), false);
	assert.equal(shouldUnlinkEndpoint({ stillOwner: false, compromised: true, bound: same, current: same }), false);
	assert.equal(shouldUnlinkEndpoint({ stillOwner: false, compromised: true, bound: same, current: { dev: 1, ino: 3 } }), false);
	// degenerate rows: without both identities nothing may be unlinked
	assert.equal(shouldUnlinkEndpoint({ stillOwner: true, compromised: false, bound: null, current: same }), false);
	assert.equal(shouldUnlinkEndpoint({ stillOwner: true, compromised: false, bound: same, current: null }), false);
});

test("socketIdentityObservation maps one stat attempt", () => {
	assert.deepEqual(socketIdentityObservation({ dev: 7, ino: 8 }, null), { kind: "ok", dev: 7, ino: 8 });
	assert.deepEqual(socketIdentityObservation(null, "ENOENT"), { kind: "missing" });
	assert.deepEqual(socketIdentityObservation(null, "EACCES"), { kind: "unknown" });
	assert.deepEqual(socketIdentityObservation(null, "EBUSY"), { kind: "unknown" });
	assert.deepEqual(socketIdentityObservation(null, "ELOOP"), { kind: "unknown" });
});

test("classifyEndpointHealth never steps down without an identity", () => {
	const bound = { dev: 1, ino: 2 };
	const ok = { kind: "ok", dev: 1, ino: 2 };
	assert.equal(classifyEndpointHealth(bound, ok), "ok");
	assert.equal(classifyEndpointHealth(bound, { kind: "ok", dev: 1, ino: 3 }), "replaced");
	assert.equal(classifyEndpointHealth(bound, { kind: "missing" }), "missing");
	assert.equal(classifyEndpointHealth(bound, { kind: "unknown" }), "unknown");
	assert.equal(classifyEndpointHealth(null, ok), "unknown");
	assert.equal(classifyEndpointHealth(bound, null), "unknown");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/host-coordination.test.mjs`
Expected: ERR_MODULE_NOT_FOUND / import error naming `shouldUnlinkEndpoint` (or `undefined`).

- [ ] **Step 3: Implement the three exports**

In `src/core/host-coordination.mjs`, after `ownsEndpoint`, add the three functions exactly as
specified in the design doc §4.2/§4.3, with JSDoc. Behaviour:
`shouldUnlinkEndpoint` returns `false` unless `stillOwner && !compromised && ownsEndpoint(bound, current)`;
`socketIdentityObservation` returns the ok object on `stat != null`, `missing` iff
`errorCode === "ENOENT"`, else `unknown`; `classifyEndpointHealth` returns `unknown` when
`!bound || !observed || observed.kind === "unknown"`, `missing` on `kind === "missing"`, else
`ownsEndpoint(bound, observed)` → `ok`/`replaced`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/host-coordination.test.mjs`
Expected: all tests pass (3 new + existing).

- [ ] **Step 5: Commit**

```bash
git add src/core/host-coordination.mjs test/host-coordination.test.mjs
git commit -m "feat(coordination): add endpoint health and cleanup-gate decisions (issue #255)"
```

---

### Task 2: R1 — owner-token cleanup gate in shutdown()

**Files:**
- Modify: `runner/state-coordinator.mjs` (import `shouldUnlinkEndpoint`; add `endpointCompromised`; rewrite the shutdown-time-site block at :411-418; add `safeIsOwner`)
- Test: `test/state-coordinator.integration.test.mjs` (add `#255 A3` and `#255 A6`)

**Interfaces:**
- Consumes: `shouldUnlinkEndpoint` from Task 1; `lease.isOwner()` (locks.mjs:176); existing
  `startCoordinator`/`readyClient`/`waitForExit`/`freshRoot`/`createView`/`readDiagnostics` helpers.
- Produces: `endpointCompromised` flag (module-scope `let`, set by Task 3's tick) and
  `safeIsOwner()` shell helper (returns false on throw).

- [ ] **Step 1: Write the failing tests**

In `test/state-coordinator.integration.test.mjs` (POSIX guards), add:

```js
test("#255 A3: a deposed coordinator keeps its own endpoint", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX AF_UNIX only");
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	await readyClient(root);
	const socketPath = P.coordinatorEndpointPathFor(process.platform, root);
	const lockPath = P.viewLockPath(root, "_coordinator", "state-coordinator");
	assert.ok(existsSync(socketPath), "precondition: endpoint exists");
	// Simulate "the lease moved elsewhere": remove the lease dir (quarantine shape).
	rmSync(lockPath, { recursive: true, force: true });
	assert.ok(existsSync(socketPath), "anti-vacuous: endpoint still exists after lease removal");
	const code = await waitForExit(child, 6000);
	assert.equal(code, 0, "clean step-down");
	assert.ok(existsSync(socketPath), "a deposed owner must not unlink its own endpoint");
});

test("#255 A6: SIGTERM on a healthy owner still unlinks the endpoint", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX AF_UNIX only");
	const root = freshRoot();
	let child = null;
	t.after(async () => { rmSync(root, { recursive: true, force: true }); });
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	await readyClient(root);
	const socketPath = P.coordinatorEndpointPathFor(process.platform, root);
	assert.ok(existsSync(socketPath), "precondition: endpoint exists");
	child.kill("SIGTERM");
	await waitForExit(child);
	assert.equal(existsSync(socketPath), false, "healthy owner cleans its own endpoint");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-name-pattern="#255 A3|#255 A6" test/state-coordinator.integration.test.mjs`
Expected: A3 fails (`a deposed owner must not unlink its own endpoint` — old code unlinks it);
A6 passes already (regression guard).

- [ ] **Step 3: Implement the shutdown gate**

In `runner/state-coordinator.mjs`:
- import `shouldUnlinkEndpoint` from `../src/core/host-coordination.mjs`;
- add `let endpointCompromised = false;` next to `boundSocketIdentity`;
- add the shell helper above `shutdown()`:
  ```js
  function safeIsOwner() {
      try { return lease.isOwner(); } catch { return false; }
  }
  ```
- replace the shutdown-time-site unlink block with:
  ```js
  const stillOwner = safeIsOwner();
  if (process.platform !== "win32" && stillOwner && !endpointCompromised && boundSocketIdentity) {
      try {
          const st = statSync(socketPath);
          if (shouldUnlinkEndpoint({ stillOwner, compromised: endpointCompromised,
              bound: boundSocketIdentity, current: { dev: st.dev, ino: st.ino } })) {
              try { unlinkSync(socketPath); } catch { /* best effort */ }
          }
      } catch { /* path gone — nothing to clean */ }
  }
  ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="#255 A3|#255 A6|#224 A14" test/state-coordinator.integration.test.mjs`
Expected: A3, A6, A14, A14b all pass.

- [ ] **Step 5: Commit**

```bash
git add runner/state-coordinator.mjs test/state-coordinator.integration.test.mjs
git commit -m "fix(coordinator): gate endpoint cleanup on lease ownership (issue #255)"
```

---

### Task 3: R2 — supervised endpoint health in the heartbeat tick

**Files:**
- Modify: `runner/state-coordinator.mjs` (import the two pure functions; add `statSocketObservation`; insert the endpoint check in the `heartbeatTimer` callback between `rootVanishedOrReplaced` and `lease.touch()`; extend the identity-capture catch with a stderr line)
- Test: `test/state-coordinator.integration.test.mjs` (add `#255 A4`, `#255 A4b`, `#255 A5`; optional `#255 A8`)

**Interfaces:**
- Consumes: `socketIdentityObservation`, `classifyEndpointHealth` (Task 1);
  `endpointCompromised` (Task 2); `appendCoordinatorDiagnostic` (:118-123);
  `AGENT_BOARD_TEST_FAIL_DIAGNOSTIC` and `AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS` knobs.
- Produces: `statSocketObservation(socketPath) -> observation` shell helper;
  diagnostic code `coordinator_endpoint_lost` with `details.state ∈ {"missing","replaced"}`.

- [ ] **Step 1: Write the failing tests**

Add to `test/state-coordinator.integration.test.mjs`:

```js
test("#255 A4: a missing endpoint steps the coordinator down", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX AF_UNIX only");
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS = "100";
	child = startCoordinator(root);
	await readyClient(root);
	const socketPath = P.coordinatorEndpointPathFor(process.platform, root);
	unlinkSync(socketPath);
	const code = await waitForExit(child, 5000);
	delete process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS;
	assert.equal(code, 0, "clean step-down");
	const lost = readDiagnostics(root, "_coordinator").find((e) => e.code === "coordinator_endpoint_lost");
	assert.ok(lost, "endpoint loss is recorded");
	assert.equal(lost.details.state, "missing");
});

test("#255 A4b: a failing diagnostic write does not block the step-down", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX AF_UNIX only");
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS = "100";
	process.env.AGENT_BOARD_TEST_FAIL_DIAGNOSTIC = "1";
	child = startCoordinator(root);
	await readyClient(root);
	unlinkSync(P.coordinatorEndpointPathFor(process.platform, root));
	const code = await waitForExit(child, 5000);
	delete process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS;
	delete process.env.AGENT_BOARD_TEST_FAIL_DIAGNOSTIC;
	assert.equal(code, 0, "exit 0 even when the diagnostic append throws");
	assert.equal(existsSync(P.viewLockPath(root, "_coordinator", "state-coordinator")), false, "lease released");
});

test("#255 A5: a replaced endpoint steps the coordinator down and the replacement survives", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX AF_UNIX only");
	const root = freshRoot();
	const standinPath = join(root, `.standin-${process.pid}.sock`);
	let child = null;
	let standin = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		if (standin) await new Promise((r) => standin.close(r));
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS = "100";
	child = startCoordinator(root);
	await readyClient(root);
	const socketPath = P.coordinatorEndpointPathFor(process.platform, root);
	const before = statSync(socketPath).ino;
	standin = createServer(() => {});
	await new Promise((r) => standin.listen(standinPath, r));
	renameSync(standinPath, socketPath);              // atomic replacement, same filesystem
	assert.notEqual(statSync(socketPath).ino, before, "stand-in really replaced the inode");
	const code = await waitForExit(child, 5000);
	delete process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS;
	assert.equal(code, 0, "clean step-down");
	const lost = readDiagnostics(root, "_coordinator").find((e) => e.code === "coordinator_endpoint_lost");
	assert.ok(lost, "replacement is recorded");
	assert.equal(lost.details.state, "replaced");
	assert.ok(existsSync(socketPath), "the replacement endpoint must survive the step-down");
});
```

Required new imports in the test file: `unlinkSync`, `renameSync` (already imports `existsSync`,
`mkdtempSync`, `mkdirSync`, `appendFileSync`, `rmSync`, `statSync`, `writeFileSync`), and
`createServer` from `node:net` (the file currently imports `createConnection` only).

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-name-pattern="#255 A4|#255 A4b|#255 A5" test/state-coordinator.integration.test.mjs`
Expected: all three time out/fail because the coordinator never steps down (old behaviour).

- [ ] **Step 3: Implement R2**

In `runner/state-coordinator.mjs`:
- import `classifyEndpointHealth`, `socketIdentityObservation` from `../src/core/host-coordination.mjs`;
- add the shell helper near `safeIsOwner`:
  ```js
  function statSocketObservation(socketPath) {
      let stat = null, errorCode = null;
      try { stat = statSync(socketPath); } catch (err) { errorCode = err?.code ?? "UNKNOWN"; }
      return socketIdentityObservation(stat, errorCode);
  }
  ```
- extend the identity-capture catch inside `server.listen` with one stderr line:
  `state-coordinator: endpoint identity unavailable (<err>); self-supervision disabled`;
- inside the `heartbeatTimer` callback, after the `rootVanishedOrReplaced` block and before the
  `lease.touch()` try/catch, insert:
  ```js
  const endpointState = classifyEndpointHealth(boundSocketIdentity, statSocketObservation(socketPath));
  if (endpointState === "missing" || endpointState === "replaced") {
      endpointCompromised = true;                  // veto cleanup in shutdown (R1)
      try {
          appendCoordinatorDiagnostic("coordinator_endpoint_lost", { state: endpointState }, "warn");
      } catch { /* a failing diagnostic must not block the step-down (#224 D4) */ }
      process.stderr.write(`state-coordinator: endpoint ${endpointState} (${socketPath}); stepping down\n`);
      shutdown(0);
      return;
  }
  ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="#255" test/state-coordinator.integration.test.mjs`
Expected: A3, A4, A4b, A5, A6 all pass.

- [ ] **Step 5: Commit**

```bash
git add runner/state-coordinator.mjs test/state-coordinator.integration.test.mjs
git commit -m "feat(coordinator): supervise the bound endpoint and step down when it is lost (issue #255)"
```

---

### Task 4: Full verification and regression fixes

**Files:**
- Modify (only if a gate fails): whichever file the failure points at.
- Test: whole suite.

**Interfaces:**
- Consumes: everything above.
- Produces: a green `npm run verify` on the worktree branch.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. Fix any type errors in the new helpers.

- [ ] **Step 2: Targeted coordinator + coordination suites**

Run: `node --test test/host-coordination.test.mjs test/locks.test.mjs test/coordinator-lifecycle.test.mjs test/coordinator-client.test.mjs`
Expected: all pass.

- [ ] **Step 3: Full test suite with coverage**

Run: `npm run test:coverage`
Expected: all tests pass; thresholds lines 85 / funcs 80 / branches 70. If a legacy test now
fails, inspect whether the change altered intended behaviour (A14/A14b must stay green) before
touching the test.

- [ ] **Step 4: Perf gate + pack**

Run: `npm run test:perf && npm run pack:dry`
Expected: both exit 0.

- [ ] **Step 5: Final gate**

Run: `npm run verify`
Expected: exit 0.

- [ ] **Step 6: Commit (only if Step 1-5 changed files)**

```bash
git add <changed files>
git commit -m "test(coordinator): harden endpoint-loss cases after full-suite verification (issue #255)"
```

---

### Task 5: Local code review before PR

**Files:** none (review only).

- [ ] **Step 1: Inspect the branch diff**

Run: `git log --oneline main..HEAD && git diff main...HEAD --stat`
Expected: spec commit + Tasks 1-3 (+ Task 4 if it changed files); no unrelated files.

- [ ] **Step 2: Run the review checklist**

Required: `requesting-code-review` skill (or `workflow` code-review mode). Focus: the Review
Focus list above, the POSIX/win32 guards, and whether the A3/A4/A5 fixtures can flake
(heartbeat pinned, atomic rename, no polling window).

- [ ] **Step 3: Record the review outcome in the plan**

Append a short "Review outcome" section (findings + dispositions). Commit if it changes files.

---

## Task ↔ acceptance traceability

| Spec acceptance ID | Task |
|---|---|
| A1, A2 | Task 1 |
| A3, A6 | Task 2 |
| A4, A4b, A5 | Task 3 |
| A8 (optional smoke) | Task 3 (optional; non-gating) |
| A7 (#241 regression) | Task 4 Step 2/3 |
| A9–A12 | Task 4 |
| U1, U2 | post-merge manual (recorded as pending until executed) |
