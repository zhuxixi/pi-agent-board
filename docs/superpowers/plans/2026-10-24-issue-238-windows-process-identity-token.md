# Windows Process Identity Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the four duplicate Linux-only `captureStartToken` implementations into one, give win32 a real comparable token (`ct:<unix-ms>` from the existing identity probe), and make host-role observation compare tokens — without touching the lease layer.

**Architecture:** `src/core/pid.mjs` keeps the only synchronous token reader; `src/core/process-identity-probe.mjs` gains the async, platform-dispatching reader (`readProcessStartToken`) plus a pure `creationTimeToken`. `runner/pty-runner.mjs` writes the probed token into `host.json`'s `runnerIdentity`/`childIdentity`. `src/runtime/service.mjs` assembles an observation snapshot (alive + observed token, memoized per pid) and lets the pure `processIdentityState` decide; `revalidateProbeOwned` re-reads before any signal. Lease identities (`host-start`/`host-meta`/coordinator) keep using the synchronous reader, so `locks.mjs` is untouched.

**Tech Stack:** Node ESM (`.mjs` + one `.ts` module), `node:test` + `assert/strict`, c8 coverage, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-24-issue-238-windows-process-identity-token-design.md`

## Global Constraints

- Tabs for indentation; English comments and commit messages.
- Pure functions first, thin I/O shell; the spec's §5 split is a hard constraint — do not re-couple assembly and judgment.
- Tests: `node:test` + `assert/strict`; anything touching fs/git uses a temp-dir fixture, never the host repository.
- No new runtime dependencies.
- Token format is exactly `ct:<positive-safe-integer-ms>` (`creationTimeToken()`), and only win32 produces it.
- `readProcessStartToken` must never throw: every failure path returns `null` (callers read `null` as "unverifiable", never "foreign").
- Commit subjects: conventional (`feat`/`fix`/`refactor`/`test`/`docs`/`chore`).

## Review Focus

- **An old `host.json` (Windows, `startToken: null`) must behave exactly as today** — observation returns `unknown` immediately and the #217 probe fallback runs unchanged, with zero added probes.
- **A hung probe (PowerShell disabled / 3 s timeout) must not consume the recovery budget** — `HOST_RECOVERY_POLL_MS`/`HOST_RECOVERY_GRACE_MS` still bound the loop, and a probe failure degrades to `unknown`, never `foreign`.
- **A malformed record (identity present, `pid` or `spawnedAt` missing) must never become a releasable state** — `not_started` requires `identity == null && spawnedAt == null`; identity-bearing records are judged by observation.
- **A reused pid must never receive a signal** — `revalidateProbeOwned` re-reads the token and refuses on mismatch or read failure; the `tokenMemo` may not shortcut this.
- **Concurrent/bypassed memo must not leak** — each `recoverHost`/resolver invocation owns its own `tokenMemo`; a stale successful token must not be cached beyond one invocation.

---

### Task 1: `creationTimeToken` pure function

**Files:**
- Modify: `src/core/process-identity-probe.mjs`
- Test: `test/process-identity-probe.test.mjs`

**Interfaces:**
- Produces: `creationTimeToken(creationTimeMs: number): string | null` — `"ct:<ms>"` for a positive safe integer, `null` otherwise.

- [ ] **Step 1: Write the failing test**

Add to `test/process-identity-probe.test.mjs`:

```js
test("creationTimeToken formats only positive safe integers", () => {
	assert.equal(creationTimeToken(1792811668715), "ct:1792811668715");
	assert.equal(creationTimeToken(1), "ct:1");
	assert.equal(creationTimeToken(0), null);
	assert.equal(creationTimeToken(-1), null);
	assert.equal(creationTimeToken(1.5), null);
	assert.equal(creationTimeToken(NaN), null);
	assert.equal(creationTimeToken(Infinity), null);
	assert.equal(creationTimeToken(Number.MAX_SAFE_INTEGER + 1), null);
	assert.equal(creationTimeToken("1792811668715"), null);
	assert.equal(creationTimeToken(null), null);
	assert.equal(creationTimeToken(undefined), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/process-identity-probe.test.mjs`
Expected: FAIL — `creationTimeToken is not a function` (or import error).

- [ ] **Step 3: Implement `creationTimeToken` in `src/core/process-identity-probe.mjs`**

Signature and contract:

```js
export function creationTimeToken(creationTimeMs) { /* positive safe integer → `ct:${n}`; else null */ }
```

Use `Number.isSafeInteger(creationTimeMs) && creationTimeMs > 0`; no string coercion.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/process-identity-probe.test.mjs`
Expected: PASS (all existing probe tests plus the new one).

- [ ] **Step 5: Commit**

```bash
git add src/core/process-identity-probe.mjs test/process-identity-probe.test.mjs
git commit -m "feat: add creationTimeToken for comparable win32 process tokens"
```

---

### Task 2: `readProcessStartToken` cross-platform reader

**Files:**
- Modify: `src/core/process-identity-probe.mjs`
- Test: `test/process-identity-probe.test.mjs`

**Interfaces:**
- Consumes: `captureStartToken(pid)` from `src/core/pid.mjs`; `readProcessIdentityProbe(pid, opts)` (same module); `creationTimeToken(ms)` from Task 1.
- Produces: `readProcessStartToken(pid, { platform?, probe? }): Promise<string|null>` — linux → `captureStartToken`, win32 → `probe()` → `creationTimeToken(probe.creationTimeMs)`, every other platform → `null` **without calling `probe`**.

- [ ] **Step 1: Write the failing tests**

Add to `test/process-identity-probe.test.mjs`:

```js
test("readProcessStartToken: linux delegates to captureStartToken", async () => {
	let probed = false;
	const token = await readProcessStartToken(process.pid, { platform: "linux", probe: async () => { probed = true; return null; } });
	assert.equal(probed, false);
	assert.equal(token, captureStartToken(process.pid));
});

test("readProcessStartToken: win32 converts the probe creation time", async () => {
	let seenPid = null;
	const token = await readProcessStartToken(4242, {
		platform: "win32",
		probe: async (pid) => { seenPid = pid; return { creationTimeMs: 1792811668715, commandLine: "node x" }; },
	});
	assert.equal(seenPid, 4242);
	assert.equal(token, "ct:1792811668715");
});

test("readProcessStartToken: darwin never probes and returns null", async () => {
	let probed = false;
	const token = await readProcessStartToken(4242, { platform: "darwin", probe: async () => { probed = true; return { creationTimeMs: 1, commandLine: null }; } });
	assert.equal(probed, false);
	assert.equal(token, null);
});

test("readProcessStartToken: probe failure and bad pids degrade to null", async () => {
	assert.equal(await readProcessStartToken(4242, { platform: "win32", probe: async () => null }), null);
	assert.equal(await readProcessStartToken(4242, { platform: "win32", probe: async () => ({ creationTimeMs: null, commandLine: null }) }), null);
	assert.equal(await readProcessStartToken(0, { platform: "win32", probe: async () => { throw new Error("must not probe"); } }), null);
	assert.equal(await readProcessStartToken(null, { platform: "win32", probe: async () => { throw new Error("must not probe"); } }), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/process-identity-probe.test.mjs`
Expected: FAIL — `readProcessStartToken is not a function`.

- [ ] **Step 3: Implement `readProcessStartToken` in `src/core/process-identity-probe.mjs`**

Signature and dispatch exactly as the Interfaces block. Validate `pid` first (`Number.isSafeInteger(pid) && pid > 0` → else `null`, no probe). Linux path is synchronous inside the async function. Win32 path: `const probe = await probeFn(pid); return probe ? creationTimeToken(probe.creationTimeMs) : null;`. Any thrown probe error must be caught and become `null`. Update the module header comment: linux is supported via `/proc`, win32 via creation time, **darwin is deliberately unsupported** (ps elapsed time is second-resolution).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/process-identity-probe.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/process-identity-probe.mjs test/process-identity-probe.test.mjs
git commit -m "feat: read process start tokens across platforms (win32 creation time)"
```

---

### Task 3: Collapse the four token copies into one

**Files:**
- Modify: `runner/pty-runner.mjs` (delete private `captureStartToken` at ~1613; import from `../src/core/pid.mjs`)
- Modify: `runner/state-coordinator.mjs` (delete private `captureStartToken` at ~494; import from `../src/core/pid.mjs`)
- Modify: `src/runtime/service.mjs` (delete private `readProcStartToken` at ~2546; import `captureStartToken`)

**Interfaces:**
- Consumes: `captureStartToken(pid)` from `src/core/pid.mjs`.
- Produces: no new API — this task only removes duplicates. All three call sites keep their current argument and behaviour (lease identities stay `null` on non-Linux).

- [ ] **Step 1: Replace the runner copies**

In `runner/pty-runner.mjs` add `import { captureStartToken } from "../src/core/pid.mjs";` and delete the function at ~1613. In `runner/state-coordinator.mjs` add the same import (path `../src/core/pid.mjs`) and delete the function at ~494.

- [ ] **Step 2: Replace the service copy**

In `src/runtime/service.mjs`, delete `readProcStartToken` (~2546) and change `serviceIdentity()` and `defaultObserveProcess` to call `captureStartToken` (import it from `../core/pid.mjs`).

- [ ] **Step 3: Verify the static convergence and types**

Run: `Get-ChildItem src,runner -Recurse -Filter *.mjs | Select-String -Pattern 'function captureStartToken|function readProcStartToken'`
Expected: exactly one hit — `src/core/pid.mjs`. (On POSIX: `grep -rn "function captureStartToken\|function readProcStartToken" src runner`.)

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Run the affected suites**

Run: `node --test test/pid.test.mjs test/pty-runner.integration.test.mjs test/state-coordinator.integration.test.mjs test/service.test.mjs`
Expected: no new failures versus the recorded baseline (`research/baseline-test.log`); the `/proc` token assertions in `pty-runner.integration.test.mjs` still pass on Linux.

- [ ] **Step 5: Commit**

```bash
git add runner/pty-runner.mjs runner/state-coordinator.mjs src/runtime/service.mjs
git commit -m "refactor: collapse the four start-token copies into src/core/pid.mjs"
```

---

### Task 4: pty-runner writes real tokens into `host.json`

**Files:**
- Modify: `runner/pty-runner.mjs`

**Interfaces:**
- Consumes: `readProcessStartToken(pid, opts)` from `../src/core/process-identity-probe.mjs`.
- Produces: `host.json` records whose `runnerIdentity.startToken` / `childIdentity.startToken` are `/proc` tokens on Linux and `ct:<ms>` on win32; `null` when the probe is unavailable.

- [ ] **Step 1: Start the self probe before the start lease**

At the very top of `async function ownedMain(config)` (before the `acquireOwnedViewLock(..., "host-start", ...)` call at ~768):

```js
const selfTokenPromise = readProcessStartToken(process.pid);
```

Do **not** await it here — it runs in parallel with lease acquisition, the yield check and socket binding.

- [ ] **Step 2: Use it for `runnerIdentity`**

At the "Publish runner identity" `ownedUpdate` (~933), await before the update and use the result:

```js
const selfToken = await selfTokenPromise;
const claimedSelf = ownedUpdate((cur) => ({ ...cur, runnerPid: process.pid, runnerIdentity: { pid: process.pid, startToken: selfToken }, ... }));
```

Leave the `host-start` lease identity at ~771 on the synchronous `captureStartToken` (lease layer unchanged).

- [ ] **Step 3: Use it for `childIdentity`**

At the post-spawn `ownedUpdate` (~1023), read the child token first:

```js
const childToken = await readProcessStartToken(childPid);
const ready = ownedUpdate((cur) => ({ ...cur, childPid, childIdentity: { pid: childPid, startToken: childToken }, ... }));
```

- [ ] **Step 4: Run the integration suite**

Run: `node --test test/pty-runner.integration.test.mjs`
Expected: PASS on Linux — `runnerIdentity.startToken` and `childIdentity.startToken` still match `/^\d+$/` (the `/proc` value); on a Windows host the same assertions read `ct:` and the run/ready timing stays within the suite's existing tolerances.

- [ ] **Step 5: Commit**

```bash
git add runner/pty-runner.mjs
git commit -m "feat(host): publish a real start token on win32 host records"
```

---

### Task 5: `processIdentityState` — narrow `not_started`

**Files:**
- Modify: `src/core/host-coordination.mjs:49-54`
- Test: `test/host-coordination.test.mjs`

**Interfaces:**
- Produces: `processIdentityState(identity, observed, spawnedAt)` now returns `not_started` only when `spawnedAt == null && identity == null`; an identity-bearing record with a missing `spawnedAt` is judged by `observed`.

- [ ] **Step 1: Write the failing tests**

Add to `test/host-coordination.test.mjs`:

```js
test("processIdentityState: an identity-bearing record is never not_started", () => {
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: true, startToken: "t" }, null), "owned");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: true, startToken: "u" }, null), "foreign");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: false }, null), "dead");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: true, startToken: null }, null), "unknown");
});

test("processIdentityState: not_started needs both identity and spawnedAt to be absent", () => {
	assert.equal(processIdentityState(null, null, null), "not_started");
	assert.equal(processIdentityState(undefined, null, null), "not_started");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/host-coordination.test.mjs`
Expected: FAIL — the identity-bearing `null`-`spawnedAt` cases return `not_started`.

- [ ] **Step 3: Change the guard**

In `src/core/host-coordination.mjs`:

```js
if (spawnedAt == null && identity == null) return "not_started";
```

Update the JSDoc sentence that explains the degradation rule (identity present ⇒ spawn happened ⇒ judge by observation; suggesting `not_started` there would mark a possibly-live host releasable).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/host-coordination.test.mjs`
Expected: PASS, including the pre-existing `(null, null, null) → not_started` case.

- [ ] **Step 5: Commit**

```bash
git add src/core/host-coordination.mjs test/host-coordination.test.mjs
git commit -m "fix: never classify an identity-bearing record as not_started"
```

---

### Task 6: Service observation assembly + `tokenMemo`

**Files:**
- Modify: `src/runtime/service.mjs` (`observeHostRole` ~983, `defaultObserveProcess` ~2624, `createService` ~136-161, six call sites)
- Test: `test/service.test.mjs`

**Interfaces:**
- Consumes: `captureStartToken` (Task 3), `readProcessStartToken` (Task 2), `processIdentityState` (Task 5).
- Produces:
  - `createService(opts)` accepts `opts.isAlive?: (pid) => boolean` and `opts.readStartToken?: (pid) => Promise<string|null>` (defaults `isAlive`, `readProcessStartToken`).
  - `observeHostRole(host, role, { sessionFile, memo, tokenMemo })` — `tokenMemo: Map<number, Promise<string|null>>`.
  - Default observation: `identity == null && spawnedAt == null → "not_started"`; `pid == null → "unknown"`; dead → `"dead"`; record token `null` → `"unknown"` **without probing**; otherwise compare the memoized observed token and return `processIdentityState(...)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/service.test.mjs` (follow the file's existing `createService` fixture pattern):

```js
test("observe: a matching win32 token is owned and a mismatching one is foreign", async () => {
	// inject isAlive → true and readStartToken → "ct:111" for a stored identity whose token is "ct:111" / "ct:222"
});

test("observe: a null record token never probes and stays unknown", async () => {
	// readStartToken must not be called; observation must be "unknown"
});

test("observe: tokenMemo probes each pid once per recovery", async () => {
	// counting stub: two observations of the same pid → exactly 1 read
});
```

Write real assertions in the body; the three comments name the cases the tests must pin.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/service.test.mjs`
Expected: FAIL — observations fall back to the old behaviour / the injected seams do not exist.

- [ ] **Step 3: Implement the assembly and wire the memo**

Move the observation assembly into the `createService` closure as `observeProcessIdentity(identity, { spawnedAt, pid, tokenMemo })` (spec D4 pseudo-code). Keep `opts.observeProcess` as the outer override; default to the new closure. Add `opts.isAlive` / `opts.readStartToken`. Thread `tokenMemo` through `observeHostRole` and create one per invocation at all six call sites (`~1109`, `~1110`, `~1152`, `~1155`, `~1416`, `~1417`), next to the existing `probeMemo`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/service.test.mjs test/host-recovery.test.mjs test/host-resolver.test.mjs`
Expected: PASS; existing injected `observeProcess` stubs keep working (they may stay synchronous).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/service.mjs test/service.test.mjs
git commit -m "feat(service): compare start tokens when observing host roles"
```

---

### Task 7: `revalidateProbeOwned` covers the token path

**Files:**
- Modify: `src/runtime/service.mjs:1005-1018`
- Test: `test/service.test.mjs`

**Interfaces:**
- Produces: `revalidateProbeOwned(host, role, sessionFile, memo, tokenMemo)` — with a recorded token it re-reads via `readStartTokenImpl(pid)` **bypassing `tokenMemo`**, compares, and returns `false` on mismatch or `null`.

- [ ] **Step 1: Write the failing tests**

Add to `test/service.test.mjs`:

```js
test("revalidate: a reused pid with a different token never receives a signal", async () => {
	// first read "ct:111" (observation, memoized), then re-read "ct:222" → no SIGTERM recorded
});

test("revalidate: a failing re-read refuses the signal", async () => {
	// observation "ct:111", re-read null → no signal
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/service.test.mjs`
Expected: FAIL — the token path currently returns `true` unconditionally.

- [ ] **Step 3: Implement the revalidation**

Replace the `identity?.startToken != null → return true` shortcut: re-read with `readStartTokenImpl(pid)` (not the memo), compare against `identity.startToken`, return `false` on mismatch/`null`. Keep the probe branch unchanged (it still writes back to `probeMemo`). Do not write token results into `probeMemo` (its values are probe objects).

- [ ] **Step 4: Run the recovery suites**

Run: `node --test test/service.test.mjs test/host-recovery.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/service.mjs test/service.test.mjs
git commit -m "fix(service): re-read the token before signalling an owned process"
```

---

### Task 8: Degradation-path acceptance test

**Files:**
- Test: `test/service.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 6–7; no production change expected.

- [ ] **Step 1: Write the test**

```js
test("degradation: unreadable token and unavailable probe stay unknown and pend recovery", async () => {
	// record token "ct:111"; readStartToken → null; probeProcessIdentity → null
	// expect observation "unknown" and the recovery result "recovery_pending"
	// assert no signal was sent to any pid
});
```

- [ ] **Step 2: Run it**

Run: `node --test test/service.test.mjs`
Expected: PASS. If it fails because production behaviour differs, fix production (the spec's D7 row is the contract), then re-run.

- [ ] **Step 3: Commit**

```bash
git add test/service.test.mjs
git commit -m "test: pin the unverifiable-identity degradation path"
```

---

### Task 9: Full verification and PR preparation

**Files:**
- Modify: none (verification only; PR body goes to `~/.github-issue-driven/zhuxixi/pi-agent-board/issue-238/pr-body.md`, outside the repo).

- [ ] **Step 1: Typecheck and full test run (Windows host)**

Run: `npm run typecheck` then `npm test *> "$HOME/baseline-after.log"`
Expected: typecheck clean; failure set equals the recorded baseline (`research/baseline-test.log` / `baseline-failures.txt`, 1298 tests / 66 fail / 5 skip) — diff the `✖` lines and require an empty difference.

- [ ] **Step 2: Coverage and package sanity**

Run: `npm run test:coverage` then `npm run pack:dry`
Expected: coverage thresholds hold (lines 85 / funcs 80 / branches 70) for the changed files; `pack:dry` lists the same file set plus no strays.

- [ ] **Step 3: Record the acceptance matrix**

Write the A1–A11 results (command → outcome) and U1 as `pending (user acceptance, needs Windows host + reload)` into the issue-238 ledger; do not claim U1 as passed.

- [ ] **Step 4: Write the PR body**

`pr-body.md` must contain: summary, the spec link, per-gap mapping (A-IDs), the two Windows-only behaviours that CI cannot cover, and the local-baseline evidence.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin issue-238-process-identity-token
gh pr create --repo zhuxixi/pi-agent-board --base main --head issue-238-process-identity-token --title "fix(host): unify process identity tokens and produce them on win32 (#238)" --body-file "$HOME/.github-issue-driven/zhuxixi/pi-agent-board/issue-238/pr-body.md"
gh pr edit <PR> --repo zhuxixi/pi-agent-board --add-label zima:needs-review
```

Then block on Zima CR (skill `zima-pr-monitor`) in the same turn.

---

## Self-Review

**Spec coverage:** A1→T1, A2→T2, A3/A6→T6, A4→T5 (+T6), A5→T7, A7→T3, A8→T4, A9→T8, A10/A11→T9, U1→T9 Step 3 (recorded pending). D1→T3, D2→T2, D3→T4, D4→T6, D5→T5, D6→T7, D7→T8. No spec section without a task.

**Step scan:** every step names one action and its checkable result; bodies are limited to signatures, dispatch rules and the exact guards the spec pins.

**Type consistency:** `creationTimeToken(number) → string|null` (T1) is consumed by `readProcessStartToken` (T2) and both live in `process-identity-probe.mjs`; `tokenMemo: Map<pid, Promise<string|null>>` is introduced in T6 and consumed by T7; `processIdentityState(identity, observed, spawnedAt)` keeps its three-argument shape in T5 and T6.

**Review Focus:** old-record zero-probe path → T6 Step 1 case 2; hung probe degradation → T8; malformed record not releasable → T5 Step 1; reused-pid signal refusal → T7 Step 1; memo isolation → T6 Step 1 case 3.

**Proportion:** ~9 tasks against a 286-line spec; code blocks are signatures and test assertions, not implementations.
