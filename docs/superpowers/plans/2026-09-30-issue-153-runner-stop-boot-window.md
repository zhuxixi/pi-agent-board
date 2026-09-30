# Issue #153 Runner Boot-Window Stop Latch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a stop signal delivered during job-runner's boot window (between the observable `run_started` and the SIGTERM handler wiring) still finalize the run, via a module-scope stop latch.

**Architecture:** A pure state machine (`createStopLatch`) is installed as SIGTERM/SIGINT handlers at job-runner's module scope — before anything is observable. The real `stop()` replays a latched signal once it exists. A test-only knob (`AGENT_BOARD_TEST_BOOT_WINDOW_MS`) widens the window deterministically so the race is testable without timing luck; `service.reconcile()` convergence of an unfixable hard-kill is pinned as defense in depth.

**Tech Stack:** Node.js 20+ ESM (.mjs) with JSDoc types, `node:test` + `assert/strict`, tabs.

**Spec:** `docs/superpowers/specs/2026-09-30-issue-153-runner-stop-boot-window-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- Indentation: **tabs**. Comments and commit messages: **English**.
- Commit subjects: conventional (`feat`/`test`/`docs`/`refactor`), ending with `(issue #153)`.
- `npm run verify` must exit 0 at branch head before the branch is called done.
- Tests are self-contained: every fixture lives under a `mkdtempSync` root, removed in `finally`; never mutate `~/.pi/agent/agent-board`; never touch the main checkout.
- The test knob is `AGENT_BOARD_TEST_*`-scoped and must be inert when unset.
- Windows: signals cannot be caught (Node hard-kills); this fix is Unix-only by design — do not add platform branches.
- All work happens in this worktree (`$WT`); never edit files outside it.

## Review Focus

Five failure modes the spec implies but happy paths don't exercise. Each is pinned to the task that owns the code:

1. **A signal during module import (before the latch handlers exist) still exits by default** — nothing is published yet, so nothing observable is lost. Pinned: Task 3's A3 assertion (`stop_latch_armed` is the run's first diagnostic) proves nothing is published before the latch.
2. **Both SIGINT and SIGTERM noted before wiring** — must collapse into one stop, not two. Pinned: Task 1's first-wins and take-once unit tests.
3. **A normal stop after wiring must behave exactly as before** — pinned: Task 2's step runs the whole existing `runner.integration` suite; the existing `stopping the runner finalizes the run as stopped` test is the regression guard.
4. **The boot-window knob leaking between tests or into production** — pinned: Task 3's leg 2 runs without the knob and must pass identically (inert-when-unset), and every leg deletes the env var in `finally`.
5. **Replay double-firing with a later real signal** — `take()` clears once and `stop()` is `worker.killed`-guarded. Pinned: Task 1's take-once unit test plus the existing stop test staying green.

Known-untested residual: the latch replay finalizing through the `coordinator_disabled` legacy branch is not directly pinned; the existing legacy-path suites cover that branch indirectly. Recorded, not expanded here.

---

### Task 1: Stop-latch pure state machine

**Files:**
- Create: `src/core/stop-latch.mjs`
- Test: `test/stop-latch.test.mjs`

**Interfaces:**
- Produces: `createStopLatch()` → `{ note(signal: string): void, pending(): string | null, take(): string | null }` — `note` idempotent (first signal wins), `take` reads-and-clears once.

- [ ] **Step 1: Write the failing tests**

```js
// test/stop-latch.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStopLatch } from "../src/core/stop-latch.mjs";

test("A2: latch records the first signal and collapses later ones", () => {
	const latch = createStopLatch();
	assert.equal(latch.pending(), null, "nothing noted initially");
	latch.note("SIGTERM");
	latch.note("SIGINT");
	assert.equal(latch.pending(), "SIGTERM", "first signal wins; SIGINT/SIGTERM collapse into one stop intent");
});

test("A2: take returns the noted signal exactly once", () => {
	const latch = createStopLatch();
	latch.note("SIGINT");
	assert.equal(latch.take(), "SIGINT", "take returns the noted signal");
	assert.equal(latch.take(), null, "take clears — a replayed stop cannot double-fire");
	assert.equal(latch.pending(), null);
});

test("A2: take on an empty latch is null", () => {
	const latch = createStopLatch();
	assert.equal(latch.take(), null);
	assert.equal(latch.pending(), null);
});

test("A2: latches are independent instances", () => {
	const a = createStopLatch();
	const b = createStopLatch();
	a.note("SIGTERM");
	assert.equal(b.pending(), null, "no shared state across instances");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/stop-latch.test.mjs`
Expected: FAIL — `Cannot find module '.../src/core/stop-latch.mjs'`

- [ ] **Step 3: Write the minimal implementation**

```js
// src/core/stop-latch.mjs
/**
 * Minimal stop-intent latch for detached runners (issue #153).
 *
 * A runner installs signal handlers as early as module scope — before its
 * config is even read — but the real stop path (kill worker, finalize the
 * run) only exists once the worker is spawned and the close handlers are
 * wired. A stop signal that lands in between must not die with Node's
 * default action (that would leave the run without a terminal state); the
 * latch records it and the runner replays it once the real stop path exists.
 *
 * Pure state: no signal wiring, no timers, no I/O.
 */

/**
 * @returns {{
 * 	note(signal: string): void,
 * 	pending(): string | null,
 * 	take(): string | null,
 * }} A latch object. `note` is idempotent (the first signal wins, later ones
 * collapse); `take` returns the recorded signal once, then null.
 */
export function createStopLatch() {
	/** @type {string | null} */
	let noted = null;
	return {
		/** Record a stop signal. @param {string} signal */
		note(signal) {
			if (noted == null) noted = signal;
		},
		/** The first recorded signal, or null. */
		pending() {
			return noted;
		},
		/** Read-and-clear: returns the recorded signal once, then null. */
		take() {
			const signal = noted;
			noted = null;
			return signal;
		},
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/stop-latch.test.mjs`
Expected: PASS (4 tests, 0 fail)

- [ ] **Step 5: Commit**

```bash
git add src/core/stop-latch.mjs test/stop-latch.test.mjs
git commit -m "feat: add stop-latch state machine (issue #153)"
```

---

### Task 2: Wire the latch into job-runner

**Files:**
- Modify: `runner/job-runner.mjs` (four insertions — anchors quoted below)

**Interfaces:**
- Consumes: `createStopLatch()` from Task 1.
- Produces: env knob `AGENT_BOARD_TEST_BOOT_WINDOW_MS` (test-only delay between `run_started` and the spawn) and diagnostic code `stop_latch_armed` — both consumed by Task 3.

- [ ] **Step 1: Add the import**

In `runner/job-runner.mjs`, beside the other `../src/core/...` imports (after the `prompt-transport` import line):

```js
import { createStopLatch } from "../src/core/stop-latch.mjs";
```

- [ ] **Step 2: Install the latch at module scope**

Immediately after `const WRITE_THROTTLE_MS = 250;` (line ~36):

```js
// Stop-intent latch (issue #153): a stop signal that arrives before the real
// stop path exists (config read → run_started → worker spawn → handler
// wiring) must not kill this process via Node's default action — the run
// would never reach a terminal state. The latch records it; bootstrapRun
// replays it into stop() once the handlers are wired. A signal during module
// import (before these handlers exist) still exits by default, but nothing
// has been published at that point, so no observable state is lost.
const stopLatch = createStopLatch();
process.on("SIGTERM", () => stopLatch.note("SIGTERM"));
process.on("SIGINT", () => stopLatch.note("SIGINT"));
```

- [ ] **Step 3: Emit `stop_latch_armed` as the run's FIRST diagnostic**

In `main()`, immediately BEFORE the existing `appendDiagnostic(... code: "runner_start" ...)` line:

```js
	// First observable write of the run (issue #153, A3): the stop latch was
	// armed at module scope — before this diagnostic, nothing about the run is
	// observable. Pinned by the stop-window integration test asserting this is
	// diagnostics.jsonl's first entry.
	appendDiagnostic(root, viewId, { source: "runner", runId, code: "stop_latch_armed", message: "Stop latch armed before any observable state", details: { signals: ["SIGTERM", "SIGINT"] } });
```

- [ ] **Step 4: Add the test-only boot-window knob**

In `bootstrapRun`, immediately AFTER the closing brace of the `if (!coordinatorDisabled()) { ... }` run_started block and BEFORE the `/** One transient progress beat ... */` comment:

```js
	// Test-only boot-window knob (issue #153): deterministically widen the gap
	// between the observable run_started and the handler wiring so a stop can
	// be delivered inside the window without timing luck. Inert when unset.
	const bootWindowMs = Number(process.env.AGENT_BOARD_TEST_BOOT_WINDOW_MS || 0);
	if (bootWindowMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, bootWindowMs));
```

- [ ] **Step 5: Replay a latched stop once the real handlers exist**

Immediately after the two lines `process.on("SIGTERM", stop);` / `process.on("SIGINT", stop);` (line ~371):

```js
	// Replay a stop observed before the real handlers existed (issue #153).
	// take() clears, so this fires at most once and cannot double-fire with a
	// later real signal; stop() itself is worker.killed-guarded.
	if (stopLatch.take() != null) stop();
```

- [ ] **Step 6: Run the existing runner suites — no regression**

Run: `node --test test/runner.integration.test.mjs test/stop-latch.test.mjs`
Expected: PASS (the existing `stopping the runner finalizes the run as stopped` must stay green — Review Focus #3). If anything else in the file is red, stop and investigate before committing.

- [ ] **Step 7: Commit**

```bash
git add runner/job-runner.mjs
git commit -m "feat: module-scope stop latch replays early stops in job-runner (issue #153)"
```

---

### Task 3: Boot-window integration tests (A1 + A3 + A10)

**Files:**
- Create: `test/runner-stop-window.integration.test.mjs`

**Interfaces:**
- Consumes: `createStopLatch` semantics (Task 1), the knob `AGENT_BOARD_TEST_BOOT_WINDOW_MS` and diagnostic code `stop_latch_armed` (Task 2), `launchRun` / `startCoordinator` / `createView` / `readStatus` / `readState` / `readPid` / `readDiagnostics` helpers, `createService` for A10.

- [ ] **Step 1: Write the test file**

```js
/**
 * Boot-window stop-safety integration tests (issue #153).
 *
 * A1: a stop delivered between the observable run_started and the handler
 *     wiring must still finalize the run (module-scope stop latch). Leg 1
 *     injects the window deterministically via AGENT_BOARD_TEST_BOOT_WINDOW_MS;
 *     leg 2 repeats the flow with the knob unset (inert-when-unset proof).
 * A3: the run's first diagnostics.jsonl entry is stop_latch_armed — nothing
 *     is published before the process can handle a stop.
 * A10: a runner hard-killed before finalizing (the pre-#153 failure shape)
 *      is converged by service.reconcile() — defense in depth behind the latch.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import { launchRun } from "../src/core/launch.mjs";
import { isAlive } from "../src/core/pid.mjs";
import { createService } from "../src/runtime/service.mjs";
import { createView, readPid, readState, readStatus } from "../src/core/store.mjs";
import { startCoordinator } from "../test-support/ensure-coordinator-helper.mjs";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = join(ROOT_DIR, "runner", "job-runner.mjs");
const FAKE_PI = join(ROOT_DIR, "test-support", "fake-pi.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kill a detached process before deleting its root so it can never orphan (issue #33). */
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

/** Poll `fn()` until it returns truthy or timeout. */
async function waitFor(fn, timeoutMs = 15000, intervalMs = 50) {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > timeoutMs) return null;
		await sleep(intervalMs);
	}
}

function makeConfig(root, viewId, runId, sessionFile, cwd, prompt) {
	return {
		root,
		viewId,
		runId,
		kind: "dispatch",
		sessionFile,
		cwd,
		prompt,
		piCommand: process.execPath,
		piArgsPrefix: [FAKE_PI],
		model: null,
		tools: null,
	};
}

function testService(root) {
	return createService({
		root,
		runnerScript: RUNNER,
		ptyRunnerScript: join(ROOT_DIR, "runner", "pty-runner.mjs"),
		piCommand: process.execPath,
		piArgsPrefix: [FAKE_PI],
		defaultCwd: process.cwd(),
	});
}

/** Shared fixture: launch a hanging run and wait until working is observable. */
async function startWorkingRun(root) {
	const meta = createView(root, { id: "view_1", name: "stopwin", cwd: root });
	const config = makeConfig(root, "view_1", "run_1", meta.sessionFile, root, "do it");
	const runnerPid = launchRun(root, config, { runnerScript: RUNNER }).pid;
	assert.ok(runnerPid && runnerPid > 0, "runner spawned");
	const working = await waitFor(() => {
		const s = readStatus(root, "view_1", "run_1");
		return s && s.semanticState === "working" ? s : null;
	});
	assert.ok(working, "run reached working (run_started is observable)");
	return { runnerPid };
}

/** A3 must hold on every leg: stop_latch_armed is the run's first diagnostic. */
function assertFirstDiagnosticIsLatchArmed(root) {
	const diags = readDiagnostics(root, "view_1");
	assert.ok(diags.length > 0, "diagnostics exist");
	assert.equal(diags[0].code, "stop_latch_armed", "stop latch armed before anything was published");
}

async function stopWindowLeg(t, { injected }) {
	const root = mkdtempSync(join(tmpdir(), "agentview-stop-window-"));
	process.env.FAKE_PI_MODE = "hang";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	if (injected) process.env.AGENT_BOARD_TEST_BOOT_WINDOW_MS = "800";
	let runnerPid = null;
	// Tracked coordinator: the run's terminal state routes through it; without
	// this fixture the client's ensure path spawns an untracked twin.
	const coord = await startCoordinator(root);
	try {
		const started = await startWorkingRun(root);
		runnerPid = started.runnerPid;

		const pid = readPid(root, "view_1", "run_1");
		assert.ok(pid, "have runner pid");
		// Injected leg: the knob guarantees the SIGTERM lands between run_started
		// and the handler wiring (the poll resolves ~25ms into the 800ms window).
		process.kill(pid, "SIGTERM");

		const status = await waitFor(() => {
			const s = readStatus(root, "view_1", "run_1");
			return s && s.endedAt != null ? s : null;
		});
		assert.ok(status, "run finalized after the early stop");
		assert.equal(status.semanticState, "stopped", "early stop still produces the stopped verdict");
		assertFirstDiagnosticIsLatchArmed(root);
	} finally {
		delete process.env.AGENT_BOARD_TEST_BOOT_WINDOW_MS;
		await killDetached(runnerPid);
		await coord.kill();
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

test("A1 (injected window): SIGTERM inside the boot window still finalizes as stopped", { timeout: 20000 }, async () => {
	await stopWindowLeg(t, { injected: true });
});

test("A1 (knob unset): the same flow passes with the knob inert", { timeout: 20000 }, async () => {
	await stopWindowLeg(t, { injected: false });
});

test("A10: reconcile converges a runner hard-killed before finalizing", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-stop-window-"));
	process.env.FAKE_PI_MODE = "hang";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	let runnerPid = null;
	const coord = await startCoordinator(root);
	try {
		const started = await startWorkingRun(root);
		runnerPid = started.runnerPid;

		// Simulate the pre-#153 failure shape: a hard kill nothing can intercept,
		// leaving working/alive with no endedAt.
		process.kill(runnerPid, "SIGKILL");
		await waitFor(() => (isAlive(runnerPid) ? null : true), 10000);
		const frozen = readStatus(root, "view_1", "run_1");
		assert.ok(frozen, "status exists");
		assert.equal(frozen.endedAt, null, "no terminal state after the hard kill");
		assertFirstDiagnosticIsLatchArmed(root);

		await testService(root).reconcile();

		const state = readState(root, "view_1");
		assert.equal(state.semanticState, "failed", "reconcile converged the dead run");
		assert.equal(state.processState, "exited");
		assert.equal(state.summary, "Failed (runner exited)");
	} finally {
		await killDetached(runnerPid);
		const orphanWorker = (() => {
			try {
				return readStatus(root, "view_1", "run_1")?.pid ?? null;
			} catch {
				return null;
			}
		})();
		await killDetached(orphanWorker);
		await coord.kill();
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 2: Run the new tests — expect green**

Run: `node --test test/runner-stop-window.integration.test.mjs`
Expected: PASS (3 tests). If A1-injected fails with `run finalized after stop`, the latch wiring from Task 2 is not effective — investigate before proceeding.

- [ ] **Step 3: Red-world check — prove the tests bite**

Temporarily comment out the replay line from Task 2 (`if (stopLatch.take() != null) stop();`), then:

Run: `node --test test/runner-stop-window.integration.test.mjs`
Expected: the injected-window leg FAILS (`run finalized after stop`); leg 2 and A10 still pass.
Restore the line, re-run: PASS. (This is the same red-world discipline used by #145's A18.)

- [ ] **Step 4: Run the whole runner-related suite**

Run: `node --test test/runner.integration.test.mjs test/runner-stop-window.integration.test.mjs test/stop-latch.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/runner-stop-window.integration.test.mjs
git commit -m "test: boot-window stop latch coverage and dead-run convergence (issue #153)"
```

---

### Task 4: Full gate + load-repeat acceptance (A4)

**Files:**
- No new files. (A4 is a one-time acceptance procedure, not a recurring CI test.)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Full verify**

Run: `npm run verify`
Expected: exit 0 (typecheck, perf gate, tests, coverage thresholds, pack:dry).

- [ ] **Step 2: A4 load-repeat procedure**

Start the full suite in the background (`npm test &`), then run 20 consecutive iterations:

```bash
for i in $(seq 1 20); do node --test test/runner.integration.test.mjs >/tmp/a4-$i.tap 2>&1 || echo "FAIL run $i"; done
```

Expected: 20/20 green. Record the result summary (one line) for the PR body. Pre-fix baseline: failures within the first 2–3 runs under load.

- [ ] **Step 3: Record acceptance + wrap up**

Record A1/A2/A3/A10 (commands + outcomes) and A4 (run count) in the PR body draft; U1/U2 stay with #95. Note the residual Windows/import-window caveats from the spec. No CHANGELOG edit (machine-generated at release).

---

## Self-Review (executed while writing)

- Spec coverage: invariant → Tasks 1+2; A1/A3 → Task 3 leg 1 + `assertFirstDiagnosticIsLatchArmed`; A2 → Task 1; A10 → Task 3; A4 → Task 4; knob guards → Task 2 Step 4 + Task 3 leg 2. Platform scope/risks recorded in the spec, not tasks (no code). No orphan acceptance IDs.
- Placeholder scan: none — every step carries actual code or an exact command with expected output.
- Type consistency: `createStopLatch()` API identical across Tasks 1–2; knob name and diagnostic code identical across Tasks 2–3.
- Review Focus: all five lines pinned (see inline).
