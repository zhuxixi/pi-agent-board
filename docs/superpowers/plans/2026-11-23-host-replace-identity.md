# Host Replacement Identity Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the terminal-host replacement gate identity-aware (#301) so a recycled `runnerPid` no longer blocks attach forever, surface refusals, and stop writing pids into terminal records.

**Architecture:** Replace the sync `conservativeObservation()` input of `canReplaceHost()` with the existing async `observeHostRole()` seam (token compare → probe fallback), propagating `async` up `startHostUnderLease → ensureHostImpl → ensureHost/prewarmHost`. Add one pure formatter for the refusal reason, one `blockedLaunchResult` shell that logs `host_replace_blocked`, a bounded retry in the attach resolver, and clear all six role fields on terminal writes.

**Tech Stack:** Node 22 ESM (`src/core/*.mjs`, `src/runtime/service.mjs`), TypeScript UI (`src/ui/dashboard.ts`), `node:test` + `assert/strict`, c8 coverage.

**Spec:** `docs/superpowers/specs/2026-11-23-host-replace-identity-design.md` (acceptance IDs A1–A11, U1).

**Work from:** `/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-301-host-replace-identity` (all paths below are relative to it).

---

## File map

| File | Responsibility | Change |
| --- | --- | --- |
| `src/core/host-coordination.mjs` | pure host-lifecycle decisions | add `describeHostReplaceBlock` |
| `src/runtime/service.mjs` | gate, observation, resolver, legacy finalize | replace observation, async propagation, blocked result, retry, mirror clear |
| `runner/pty-runner.mjs` | terminal write | clear six role fields |
| `src/ui/dashboard.ts` | prewarm call site | in-flight guard, promise handling |
| `test/host-coordination.test.mjs` | pure decisions | formatter tests (A2) |
| `test/host-replacement.test.mjs` (new) | gate integration | A3/A4/A5 |
| `test/host-resolver.test.mjs` | resolver + legacy | A6/A7/A9, `await` updates |
| `test/pty-runner.integration.test.mjs` | terminal write | A8 |
| `test/service.test.mjs`, `test/host-recovery.test.mjs` | existing service tests | `await` updates |
| `test-support/*` | scaffolding + dashboard stubs | `await` / async stubs |
| `test/dashboard-prewarm.test.mjs` + `test-support/dashboard-prewarm-smoke.ts` | prewarm contract | A11 |

---

## Task 1: Pure refusal formatter (A2)

**Files:** `src/core/host-coordination.mjs`, `test/host-coordination.test.mjs`

- [ ] Add to `test/host-coordination.test.mjs`:

```js
import { describeHostReplaceBlock } from "../src/core/host-coordination.mjs"; // extend the existing import list instead

test("describeHostReplaceBlock: releasable observations produce no reason", () => {
	for (const runnerObservation of ["not_started", "dead", "foreign"]) {
		assert.equal(describeHostReplaceBlock({ instanceId: "i1", runnerPid: 1, childPid: null, runnerObservation, childObservation: "dead" }), null);
	}
});

test("describeHostReplaceBlock: names the blocking role, pid and observation", () => {
	const reason = describeHostReplaceBlock({
		instanceId: "i1", runnerPid: 4189, childPid: null,
		runnerObservation: "unknown", childObservation: "dead",
	});
	assert.match(reason, /runner pid 4189/);
	assert.match(reason, /unknown/);
	assert.doesNotMatch(reason, /child/);
});

test("describeHostReplaceBlock: renders both roles in fixed order and missing pids as pid ?", () => {
	const reason = describeHostReplaceBlock({
		instanceId: "i1", runnerPid: null, childPid: 1610,
		runnerObservation: "unknown", childObservation: "owned",
	});
	assert.ok(reason.indexOf("runner pid ? (unknown)") < reason.indexOf("child pid 1610 (owned)"));
});

test("describeHostReplaceBlock: respects the replace gate itself", () => {
	// unknown runner + dead child is blocked; owned runner is blocked; launchLeaseActive is not observed here.
	assert.ok(describeHostReplaceBlock({ runnerPid: 1, childPid: null, runnerObservation: "owned", childObservation: "dead" }));
	assert.equal(describeHostReplaceBlock({ runnerPid: 1, childPid: null, runnerObservation: "foreign", childObservation: "not_started" }), null);
});
```

- [ ] Run `node --test test/host-coordination.test.mjs` — expect failure (symbol missing).
- [ ] Implement in `src/core/host-coordination.mjs`, reusing `canReplaceHost` so the formatter can never disagree with the gate:

```js
/**
 * Human-readable reason for a refused host replacement (#301). Null when the
 * observation is releasable — the formatter defers to `canReplaceHost` so the
 * message and the decision can never drift. Roles render in fixed order
 * (runner, child) with the pid that blocked release.
 * @param {{instanceId?:string|null, runnerPid?:number|null, childPid?:number|null, runnerObservation:string, childObservation:string}} input
 * @returns {string|null}
 */
export function describeHostReplaceBlock({ runnerPid = null, childPid = null, runnerObservation, childObservation }) {
	const host = { state: "exited" };
	if (canReplaceHost({ host, runnerObservation, childObservation, launchLeaseActive: false })) return null;
	const role = (name, pid, observation) => `${name} pid ${pid ?? "?"} (${observation})`;
	const parts = [role("runner", runnerPid, runnerObservation), role("child", childPid, childObservation)];
	return `host replace refused: ${parts.join(" · ")}`;
}
```

- [ ] Re-run the file — green. Commit: `feat(host): add pure host-replacement refusal formatter (#301)`.

---

## Task 2: Terminal writes stop carrying pids (A8, A9)

**Files:** `runner/pty-runner.mjs`, `src/runtime/service.mjs`, `test/pty-runner.integration.test.mjs`, `test/host-resolver.test.mjs`

- [ ] Extend the existing `"exited"` assertion in `test/pty-runner.integration.test.mjs` (around line 660) with the six-field check; run it first to watch it fail.

```js
const ended = readHost(root, "v1");
assert.equal(ended.runnerPid, null);
assert.equal(ended.runnerIdentity, null);
assert.equal(ended.runnerSpawnedAt, null);
assert.equal(ended.childPid, null);
assert.equal(ended.childIdentity, null);
assert.equal(ended.childSpawnedAt, null);
```

- [ ] In `runner/pty-runner.mjs` `finishHost()` terminal `ownedUpdate` (the block that sets `childPid: null, readyAt: null, stopRequestedAt: null`), add `runnerPid: null, runnerIdentity: null, runnerSpawnedAt: null, childIdentity: null, childSpawnedAt: null`. Update the comment to note the six-field clear mirrors `recoverHost()`.
- [ ] In `src/runtime/service.mjs` `finalizeDeadLegacyHost()` (definition `:2850`, write `:2865`): add `runnerPid: null` to the written record and call `writeHostPid(root, viewId, null)` right after `writeHost` (import already present? if not, add `writeHostPid` to the store import list).
- [ ] Add to the legacy test in `test/host-resolver.test.mjs`:

```js
assert.equal(readHost(root, "v1").runnerPid, null);
assert.equal(readHostPid(root, "v1"), null);
```

- [ ] `node --test test/pty-runner.integration.test.mjs test/host-resolver.test.mjs` — green. Commit: `fix(host): stop writing pids into terminal host records (#301)`.

---

## Task 3: Identity-aware gate + refusal surface (A3, A4, A5)

**Files:** `src/runtime/service.mjs`, `test/host-replacement.test.mjs` (new), plus `await` updates in `test/service.test.mjs`, `test/host-recovery.test.mjs`, `test/host-resolver.test.mjs`, `test-support/*`

- [ ] Add `test/host-replacement.test.mjs` with the shared fixtures copied from `test/host-resolver.test.mjs` (`freshRoot`, `resolverService`-style factory, `hostRecord`), then:

```js
test("a terminal record whose runner pid is foreign is replaced (issue #301 A3)", async () => {
	// host record: state "exited", runnerPid: 4242, runnerIdentity: {pid: 4242, startToken: "old"}, runnerSpawnedAt: Date.now() - 60_000
	// service injection: observeProcess: async () => "foreign", launchHost counting spawns
	const res = await svc.ensureHost("v1");
	assert.equal(res.ok, true);
	assert.equal(res.started, true);
	assert.notEqual(res.instanceId, "old-instance");
	assert.equal(launches, 1);
	const released = readDiagnostics(root, "v1").filter((e) => e.code === "host_replace_released");
	assert.equal(released.length, 1);
	assert.equal(released[0].details.oldInstanceId, "old-instance");
	assert.equal((await svc.ensureHost("v1")).pending, true); // claim now dedupes; no second release event
	assert.equal(readDiagnostics(root, "v1").filter((e) => e.code === "host_replace_released").length, 1);
});

test("a terminal record whose runner is provably alive refuses replacement (A4)", async () => {
	// observeProcess: async () => "owned"
	const res = await svc.ensureHost("v1");
	assert.equal(res.ok, true);
	assert.equal(res.started, false);
	assert.equal(launches, 0);
	assert.equal(res.socketPath, null);
	assert.equal(res.instanceId, null);
	assert.ok(res.blocked);
	assert.match(res.blocked.reason, /runner pid 4242/);
});

test("a refusal leaves one host_replace_blocked diagnostic with role, pid and observation (A5)", async () => {
	// observeProcess: async () => "unknown"
	const first = await svc.ensureHost("v1");
	const second = await svc.ensureHost("v1");
	const blocked = readDiagnostics(root, "v1").filter((e) => e.code === "host_replace_blocked");
	assert.equal(blocked.length, 1, "appendDiagnosticOnce must dedupe repeated refusals");
	assert.deepEqual(blocked[0].details.runnerObservation, "unknown");
	assert.equal(blocked[0].details.runnerPid, 4242);
	assert.equal(first.blocked.reason, second.blocked.reason);
});
```

- [ ] Run it — expect failures (no `blocked` field, spawn happens/doesn't per current buggy behaviour).
- [ ] Implement in `src/runtime/service.mjs`:

```js
/** Identity-aware replacement observation for a terminal host record (issue #301):
 *  same seam as the recovery paths — token compare first, command-line / creation
 *  time probe second — so a recycled pid reads `foreign` (releasable) instead of
 *  the old conservative `unknown`. Fresh memos per call: a cached verdict would
 *  be stale. @param {any} host @param {string|null} sessionFile */
async function observeHostForReplace(host, sessionFile) {
	const memo = new Map();
	const tokenMemo = new Map();
	const runnerObservation = await observeHostRole(host, "runner", { sessionFile, memo, tokenMemo });
	const childObservation = await observeHostRole(host, "child", { sessionFile, memo, tokenMemo });
	return { host, runnerObservation, childObservation, launchLeaseActive: false };
}

/** Refusal result (new helper, alongside pendingLaunchResult at :309). Never echoes
 *  the dead instance's socketPath/instanceId; logs one deduped diagnostic. */
function blockedLaunchResult(host, observation) { /* ... */ }
```

Gate block in `startHostUnderLease` (`async` now):

```js
const observation = existing && (existing.state === "exited" || existing.state === "failed")
	? await observeHostForReplace(existing, meta.sessionFile)
	: null;
if (observation && !canReplaceHost(observation)) return blockedLaunchResult(existing, observation);
if (observation) appendDiagnosticOnce(root, meta.id, { source: "service", level: "info", code: "host_replace_released", message: "Stale terminal host record released for replacement", details: { oldInstanceId: existing.instanceId ?? null, runnerPid: existing.runnerPid ?? null, childPid: existing.childPid ?? null, runnerObservation: observation.runnerObservation, childObservation: observation.childObservation } }, { match: ["oldInstanceId"] });
```

- Delete `conservativeObservation()` (no other caller — verify with `rg`).
- Propagate `async`: `startHostUnderLease`, `ensureHostImpl`, `ensureHost`, `prewarmHost`; `await` at `:1579`, `:1645`; update the `launchHost` JSDoc status union (`:283`) to include `"blocked"`.
- Update every test/scaffolding call site (`rg -n "ensureHost\\(" test/ test-support/`): 19 sites, plus `test-support/dashboard-*` prewarm stubs → `async () => ({ ok: false })`.
- Run `node --test test/host-replacement.test.mjs test/service.test.mjs test/host-resolver.test.mjs test/host-recovery.test.mjs` — green. Commit: `fix(host): make the terminal-host replace gate identity-aware (#301)`.

---

## Task 4: Resolver reports the refusal instead of a generic timeout (A6, A7)

**Files:** `src/runtime/service.mjs`, `test/host-resolver.test.mjs`

- [ ] Add to `test/host-resolver.test.mjs`:

```js
test("resolver surfaces the blocking pid instead of the generic timeout (A6)", async () => {
	// terminal record + observeProcess: async () => "unknown"; instant sleep
	const res = await svc.resolveAttachTarget("v1", { timeoutMs: 5_000 });
	assert.equal(res.kind, "pending");
	assert.match(res.reason, /runner pid 4242/);
	assert.doesNotMatch(res.reason, /host start timed out/);
});

test("resolver retries a transient block and attaches when it clears (A7)", async () => {
	let calls = 0;
	// observeProcess: async () => (++calls === 1 ? "unknown" : "foreign"); launches counting
	const res = await svc.resolveAttachTarget("v1", { timeoutMs: 5_000 });
	assert.equal(res.kind, "pty");
	assert.ok(launches === 1);
	assert.ok(calls <= 4, `expected a bounded retry budget, saw ${calls} observations`);
});
```

- [ ] Implement: module constants `HOST_REPLACE_RETRY_MS = 1_000`, `HOST_REPLACE_RETRY_LIMIT = 2` near `HOST_PROBE_RETRY_MS` import/`HOST_START_GRACE_MS`; in `resolveAttachTargetInner` the terminal branch records `lastBlock` / `lastBlockedAt` / `blockedRetries` from `res.blocked` and:

```js
if (lastBlock && blockedRetries < HOST_REPLACE_RETRY_LIMIT && nowImpl() - lastBlockedAt >= HOST_REPLACE_RETRY_MS && nowImpl() < deadline) {
	blockedRetries += 1;
	lastBlockedAt = nowImpl();
	ensured = false; // one more ensure this invocation
}
```

and before the deadline return: `if (lastBlock) return pending(sessionFile, lastBlock.reason);` (keep `host start timed out` as the fallback when nothing ever blocked).

- [ ] Run the resolver file — green. Commit: `feat(attach): surface host-replacement refusals with a bounded retry (#301)`.

---

## Task 5: Dashboard prewarm handles the promise (A11)

**Files:** `src/ui/dashboard.ts`, `test-support/dashboard-prewarm-smoke.ts`, `test-support/dashboard-*.ts` stubs

- [ ] `dashboard.ts`: add `private prewarmingId: string | null = null;` and replace the body of the prewarm branch:

```ts
if (this.prewarmedId === id || this.prewarmingId === id) return;
this.prewarmingId = id;
void Promise.resolve(this.deps.service.prewarmHost?.(id))
	.then((res) => { if (res?.ok) this.prewarmedId = id; })
	.catch(() => {})
	.finally(() => { if (this.prewarmingId === id) this.prewarmingId = null; });
```

- [ ] `test-support/dashboard-prewarm-smoke.ts`: wrap the scenario blocks in `async function main()` and `await new Promise((r) => setImmediate(r));` before the final `process.stdout.write`; call `void main()`. Stubs in `dashboard-scroll.ts`, `dashboard-fold.ts`, `dashboard-tui-modes.ts`, `dashboard-selection-settle-scenario.ts` become `async () => ({ ok: false })`.
- [ ] `node --test test/dashboard-prewarm.test.mjs` — green, `idlePrewarmCalls === 1`. Commit: `refactor(dashboard): await the async prewarm with an in-flight guard (#301)`.

---

## Task 6: Full verification (A10)

- [ ] `npm run typecheck`
- [ ] `node --test test/host-coordination.test.mjs test/host-replacement.test.mjs test/host-resolver.test.mjs test/host-recovery.test.mjs test/service.test.mjs test/dashboard-prewarm.test.mjs test/pty-runner.integration.test.mjs`
- [ ] `npm run verify` (typecheck + perf gate + tests + coverage + pack:dry) — must pass with lines ≥85 / funcs ≥80 / branches ≥70.
- [ ] Commit any fixes with `test: ...` / `fix: ...` subjects.

---

## Acceptance → task traceability

| ID | Task |
| --- | --- |
| A1 (pure gate unchanged) | 1 (no change), 6 regression run |
| A2 (formatter) | 1 |
| A3 (foreign ⇒ replaced + release diagnostic) | 3 |
| A4 (owned ⇒ refuse, no spawn/signal) | 3 |
| A5 (blocked diagnostic + no stale socketPayload) | 3 |
| A6 (specific resolver reason) | 4 |
| A7 (bounded retry heals transient block) | 4 |
| A8 (six terminal fields null) | 2 |
| A9 (legacy host.json + mirror cleared) | 2 |
| A10 (typecheck + verify thresholds) | 6 |
| A11 (dashboard prewarm exactly-once) | 5 |
| U1 (real board attach) | post-merge manual, recorded in issue |
