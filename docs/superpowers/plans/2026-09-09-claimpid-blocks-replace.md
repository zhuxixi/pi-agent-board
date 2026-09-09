# claimPid-Blocks-Replace Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #99 — an exited/failed host whose `claimPid` (the dashboard process) is still alive must be replaceable, so attach no longer pends to `host start timed out`.

**Architecture:** The fix relaxes one pure decision function (`canReplaceHost` in `src/core/host-coordination.mjs`): the claim role no longer participates in the replacement gate for terminal hosts, because claim protection (a launcher mid-transaction between claim and spawn) only matters while a host is `starting`. The observation helper (`observeHostForReplace` in `src/runtime/service.mjs`) drops its now-unused `claimObservation` field.

**Tech Stack:** Node.js (node:test, node:assert/strict), plain ESM modules, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-claimpid-blocks-replace-design.md`

## Global Constraints

- Change only the claim-role gate semantics; runner/child unknown observations must still block replacement (spec A2), `launchLeaseActive` must still block (spec A3), non-terminal hosts must still refuse (spec A4).
- `canReplaceHost` signature loses `claimObservation`; `observeHostForReplace` stops computing it (one fewer `process.kill(pid, 0)` syscall).
- All existing tests in `test/host-coordination.test.mjs` and `test/host-resolver.test.mjs` must keep passing (no behavioral regressions outside the claim-role gate).
- `npm run typecheck` must pass (service.mjs is .mjs but the repo runs tsc over TS sources; keep JSDoc types consistent).
- No changes to pty-runner.mjs, store.mjs, or host.json structure (spec non-goals).

## Acceptance traceability

| Spec ID | Plan coverage |
|---------|---------------|
| A1 (exited/failed + live claimPid → replaceable) | Task 1 Step 1 test `canReplaceHost allows replacing a terminal host whose claimPid is still alive` |
| A2 (runner/child unknown still blocks) | Task 1 Step 1 test `canReplaceHost still refuses unknown runner/child observations` + legacy case 1 of `canReplaceHost refuses unknown observations` |
| A3 (launchLeaseActive still blocks) | Task 1 Step 1 legacy case 3 of `canReplaceHost refuses unknown observations` |
| A4 (non-terminal hosts refuse; host null) | Task 1 Step 1 test `canReplaceHost refuses non-terminal hosts and null host` |
| A5 (foreign/not_started releasable) | Task 1 Step 1 test `canReplaceHost SAFE_TO_RELEASE boundary regression` |
| A6 (resolver integration: exited + live claimPid → new host) | Task 2 |
| U1 (real dashboard attach) | Post-implementation manual task (Task 3) |

---

### Task 1: Relax `canReplaceHost` claim-role gate + drop `claimObservation` (A1-A5)

**Files:**
- Modify: `src/core/host-coordination.mjs:60-80` (canReplaceHost + its JSDoc)
- Modify: `src/runtime/service.mjs:2006-2013` (observeHostForReplace)
- Test: `test/host-coordination.test.mjs:30-35`

**Interfaces:**
- Consumes: `SAFE_TO_RELEASE` set (already defined at `host-coordination.mjs:57`).
- Produces: `canReplaceHost({ host, runnerObservation, childObservation, launchLeaseActive }) → boolean` — the `claimObservation` parameter is REMOVED. Sole caller `observeHostForReplace` (service.mjs, internal, not exported) stops passing it. Task 2's integration test relies on this behavior only indirectly (through `resolveAttachTarget`), so no signature dependency.

- [ ] **Step 1: Write the failing tests**

In `test/host-coordination.test.mjs`, first EDIT the existing `canReplaceHost refuses unknown observations` test (line 30-35) to drop the `claimObservation` argument from all three assertions (the parameter is being removed):

```js
test("canReplaceHost refuses unknown observations", () => {
	const host = { state: "failed" };
	assert.equal(canReplaceHost({ host, runnerObservation: "unknown", childObservation: "dead", launchLeaseActive: false }), false);
	assert.equal(canReplaceHost({ host, runnerObservation: "dead", childObservation: "not_started", launchLeaseActive: false }), true);
	assert.equal(canReplaceHost({ host, runnerObservation: "dead", childObservation: "dead", launchLeaseActive: true }), false);
});
```

Then ADD these four tests right after it:

```js
test("canReplaceHost allows replacing a terminal host whose claimPid is still alive (issue #99)", () => {
	// The bug: an exited/failed host keeps its claimPid (the dashboard process
	// that wrote the claim), and a live pid observed as "unknown" used to block
	// replacement forever — attach pended to "host start timed out". Claim
	// protection only matters while a claim is mid-transaction (state
	// "starting"); a terminal host cannot still be being launched.
	assert.equal(canReplaceHost({ host: { state: "exited" }, runnerObservation: "dead", childObservation: "dead", launchLeaseActive: false }), true);
	assert.equal(canReplaceHost({ host: { state: "failed" }, runnerObservation: "dead", childObservation: "dead", launchLeaseActive: false }), true);
});

test("canReplaceHost still refuses unknown runner/child observations (issue #99 conservatism)", () => {
	assert.equal(canReplaceHost({ host: { state: "exited" }, runnerObservation: "unknown", childObservation: "dead", launchLeaseActive: false }), false);
	assert.equal(canReplaceHost({ host: { state: "exited" }, runnerObservation: "dead", childObservation: "unknown", launchLeaseActive: false }), false);
	assert.equal(canReplaceHost({ host: { state: "failed" }, runnerObservation: "unknown", childObservation: "unknown", launchLeaseActive: false }), false);
});

test("canReplaceHost refuses non-terminal hosts and null host (issue #99)", () => {
	for (const state of ["starting", "alive", "stopping"]) {
		assert.equal(canReplaceHost({ host: { state }, runnerObservation: "dead", childObservation: "dead", launchLeaseActive: false }), false, `state ${state} must refuse`);
	}
	assert.equal(canReplaceHost({ host: null, runnerObservation: "dead", childObservation: "dead", launchLeaseActive: false }), false);
});

test("canReplaceHost SAFE_TO_RELEASE boundary regression (issue #99)", () => {
	assert.equal(canReplaceHost({ host: { state: "exited" }, runnerObservation: "foreign", childObservation: "dead", launchLeaseActive: false }), true, "foreign runner (pid reuse) is releasable");
	assert.equal(canReplaceHost({ host: { state: "exited" }, runnerObservation: "not_started", childObservation: "not_started", launchLeaseActive: false }), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/host-coordination.test.mjs 2>&1 | tail -30`
Expected: FAIL — the first new test fails (`exited` + dead runner/child returns `false` under the old three-role gate). The edited legacy test fails too: the old implementation ignores the removed `claimObservation` key but still requires `claimObservation` in SAFE_TO_RELEASE via `undefined → not in set → false`… actually with `claimObservation` absent, `SAFE_TO_RELEASE.has(undefined)` is `false`, so case 2 of the legacy test (`"dead"` args → expected `true`) FAILS under the old code. Both failures prove the tests exercise the gate.

- [ ] **Step 3: Implement the relaxation**

In `src/core/host-coordination.mjs`, replace the `canReplaceHost` function (lines ~63-80) with:

```js
/**
 * Whether an exited/failed host can be replaced by a new claim. The runner and
 * child roles must be provably gone; any `unknown` observation or an active
 * launch lease blocks replacement. The claim role does NOT participate: claim
 * protection (a launcher mid-transaction between claim and spawn) only matters
 * while the host is `starting`, and this gate only ever sees terminal hosts —
 * a terminal host cannot still be being launched (issue #99: a live claimPid —
 * the dashboard process that wrote the claim — must not block re-attach).
 * @param {{
 *   host: HostStatus|null|undefined,
 *   runnerObservation: string,
 *   childObservation: string,
 *   launchLeaseActive: boolean,
 * }} input
 * @returns {boolean}
 */
export function canReplaceHost({ host, runnerObservation, childObservation, launchLeaseActive }) {
	if (!host || (host.state !== "exited" && host.state !== "failed")) return false;
	if (launchLeaseActive) return false;
	return (
		SAFE_TO_RELEASE.has(runnerObservation) &&
		SAFE_TO_RELEASE.has(childObservation)
	);
}
```

In `src/runtime/service.mjs`, edit `observeHostForReplace` (line ~2006) to drop the `claimObservation` line:

```js
/** @param {import("../core/types.mjs").HostStatus|null} host */
function observeHostForReplace(host) {
	return {
		host,
		runnerObservation: conservativeObservation(host?.runnerPid ?? null),
		childObservation: conservativeObservation(host?.childPid ?? null),
		launchLeaseActive: false,
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/host-coordination.test.mjs 2>&1 | tail -10`
Expected: PASS — all tests in the file pass (4 new + edited legacy + all untouched).

Run: `node --test test/host-resolver.test.mjs test/host-recovery.test.mjs test/host-crash.test.mjs 2>&1 | tail -10`
Expected: PASS — no regressions in adjacent host suites.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/host-coordination.mjs src/runtime/service.mjs test/host-coordination.test.mjs
git commit -m "fix(host): claim role no longer blocks terminal host replacement (#99)"
```

---

### Task 2: Resolver integration test — exited host + live claimPid attaches via fresh spawn (A6)

**Files:**
- Test: `test/host-resolver.test.mjs` (add one test after the `resolver finalizes a provably-dead legacy alive host` test, ~line 163)

**Interfaces:**
- Consumes: existing helpers `freshRoot`, `resolverService`, `healServiceOverrides(probe, spawns)`, `scriptProbe(seq)`, `hostRecord(root, viewId, over)` (defaults `claimPid: process.pid` — exactly the live-claimer shape), `createView` (returns `{ sessionFile, ... }`), and `writeFileSync` (already imported). Task 1's relaxed `canReplaceHost` must be in place — this test verifies the full attach chain (resolver → ensureHost → startHostUnderLease → canReplaceHost → spawn → probe ready).
- Produces: nothing downstream (terminal verification task).

- [ ] **Step 1: Write the integration test**

Add to `test/host-resolver.test.mjs` after the issue #87 legacy-alive test (~line 163):

```js
test("resolver replaces an exited host whose claimPid is still alive (issue #99)", async () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeFileSync(meta.sessionFile, "");
		// The bug's exact shape: the host ran to completion (exited, exitCode 0,
		// stopReason child_exit) but its claimPid — the dashboard process that
		// wrote the claim — is STILL ALIVE (hostRecord defaults claimPid to
		// process.pid). Before the fix, canReplaceHost saw the live claim as
		// "unknown" and the resolver pended to "host start timed out".
		hostRecord(root, "v1", {
			instanceId: "i1",
			state: "exited",
			runnerPid: 999999,
			childPid: null,
			endedAt: Date.now(),
			exitCode: 0,
			stopReason: "child_exit",
		});
		const probe = scriptProbe(["ready"]);
		const spawns = [];
		const svc = resolverService(root, healServiceOverrides(probe, spawns));
		const result = await svc.resolveAttachTarget("v1", { timeoutMs: 2_000 });
		assert.equal(result.kind, "pty", `must replace the exited host despite the live claimPid: ${JSON.stringify(result)}`);
		assert.equal(spawns.length, 1, "exactly one fresh claim spawn");
		assert.notEqual(result.instanceId, "i1", "attaches to the replacement instance");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Sanity-verify the test fails against the pre-fix gate (optional but recommended)**

Temporarily `git stash` the Task 1 commit (`git stash` won't work across commits — instead: `git checkout HEAD~1 -- src/core/host-coordination.mjs src/runtime/service.mjs`), then run:

Run: `node --test --test-name-pattern "issue #99" test/host-resolver.test.mjs 2>&1 | tail -15`
Expected: the new test FAILS or times out (resolver pends — the pre-fix behavior). Then restore: `git checkout HEAD -- src/core/host-coordination.mjs src/runtime/service.mjs`.

If the timeout makes the run slow, the 2_000 ms timeoutMs bounds it.

- [ ] **Step 3: Run the test against the fix**

Run: `node --test --test-name-pattern "issue #99" test/host-resolver.test.mjs 2>&1 | tail -10`
Expected: PASS — `kind: "pty"`, exactly one spawn, replacement instanceId.

- [ ] **Step 4: Run the full suite**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — all suites green, no regressions.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add test/host-resolver.test.mjs
git commit -m "test(resolver): exited host with live claimPid attaches via fresh spawn (#99)"
```

---

### Task 3: U1 manual verification (post-implementation, user-executed)

**Files:** none (manual).

**Interfaces:** none.

- [ ] **Step 1: Restart dashboard process** (loads new code — the "immediately effective on existing bad records" property requires restart).

- [ ] **Step 2: Attach view_2472d82627 from the dashboard** — observe: attach enters the session, history renders, no `host start timed out`.

- [ ] **Step 3: Exit the session, attach again** — confirm repeatability.

- [ ] **Step 4: Same check on view_4b667ad75d / view_c038badb30** (the other two exited + live-claimPid views).

- [ ] **Step 5: Record results in the issue** (comment each view's outcome; mark U1 pass/pending in the final report).

---

## Self-Review

**1. Spec coverage:**
- A1-A5 → Task 1 Step 1 (three new tests + edited legacy test covers A2/A3 cases) ✓
- A6 → Task 2 ✓
- U1 → Task 3 ✓
- 改动文件清单 (spec) → Task 1 + Task 2 files match exactly (host-coordination.mjs, service.mjs, host-coordination.test.mjs, host-resolver.test.mjs) ✓
- 非目标: no pty-runner/store/host.json changes in any task ✓

**2. Placeholder scan:** no TBD/TODO; every code step has full code; verification commands concrete. ✓

**3. Type consistency:** `canReplaceHost` new signature `{host, runnerObservation, childObservation, launchLeaseActive}` used consistently in Task 1 tests, Task 1 implementation, and matches Task 2's indirect usage (no direct call). `healServiceOverrides(probe, spawns)` helper name matches file. ✓
