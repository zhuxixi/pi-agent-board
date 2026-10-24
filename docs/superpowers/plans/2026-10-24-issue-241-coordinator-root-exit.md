# Coordinator root-vanished self-exit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a detached `runner/state-coordinator.mjs` exit on its own when its board root disappears, make throwaway roots deletable on win32 while it serves them, and make the test suite fail loudly if it leaks a coordinator.

**Architecture:** (1) `launchCoordinator` passes an absolute root argv and spawns with `cwd = dirname(root)` so the process no longer pins the root; (2) the coordinator checks `statSync(root)` on its existing supervised heartbeat tick and steps down on `ENOENT`; (3) a new `scripts/run-tests.mjs` wraps `node --test`, snapshots this checkout's coordinator pids before the run, polls a grace window after it, and kills + fails on survivors. No protocol bump, no new dependencies, no new timers.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `assert/strict`, `node:child_process` detached spawn, `net` JSONL control sockets, Windows CIM / `ps` for process enumeration.

**Spec:** `docs/superpowers/specs/2026-10-24-issue-241-coordinator-root-exit-design.md` (read §3, §5, §6 before starting; the acceptance IDs A1–A8/U1 used below come from §5).

## Global Constraints

- Tabs for indentation; English comments and commit messages (repo `AGENTS.md`).
- No new dependencies. Wrapper uses only Node built-ins.
- Tests: `node:test` + `assert/strict`; every filesystem fixture under a temp dir — never the host repo.
- Node >= 20 (CI matrix 22/24, ubuntu). Nothing may depend on Node 21+ test-runner flags.
- No protocol version bump (`COORDINATOR_PROTOCOL_VERSION` unchanged); lease/journal formats unchanged.
- Detection cadence reuses `AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS` (default 1000 ms); do not add a second knob for the root check.
- Work from the worktree only: `WT=C:\Users\27499\proj\opensource\pi-agent-board\.pi\worktrees\issue-241-coordinator-self-exit`. Never edit the main checkout.
- `npm run verify` is the completion gate (typecheck + perf gate + tests + coverage + pack:dry); `npm test` itself now goes through the new wrapper.
- Conventional commit subjects with the issue ref: `fix(coordinator): … (issue #241)`.

## Review Focus

- **Relative / trailing-slash / dot-segment root** passed to `launchCoordinator` must resolve to the same absolute root and the same coordinator endpoint (issue #124 contract). Owning task: Task 1 (A1 + existing `test/coordinator-client.test.mjs` #124 case).
- **Root already gone at boot** (deleted before the coordinator starts): it must exit 0 through the existing lease-unavailable path, not crash and not linger. Owning task: Task 2 (A3b).
- **Host without process enumeration** (powershell/ps missing or failing): the wrapper must warn and skip the residue check, never turn an environment issue into a red suite. Owning task: Task 3 (A6 branch E).
- **Pre-existing orphans** (from older builds like the 26 on the reporter's box) must be snapshot-only: warn, never fail the run, never kill someone else's process. Owning task: Task 3 (A6 branch C).
- **win32 command-line spellings** (quoted paths, forward slashes, case differences) must still select the coordinator; production roots (`~/.pi/...`, `$AGENT_BOARD_ROOT`) must never be selected. Owning task: Task 3 (A5).

---

## Task 1: `launchCoordinator` spawn plan (A1, A2)

**Files:**
- Modify: `src/core/launch.mjs` (imports at `:8-12`; `launchCoordinator` at `:124-137`)
- Test: `test/coordinator-lifecycle.test.mjs` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `coordinatorSpawnPlan(root: string): { root: string, cwd: string }` exported from `src/core/launch.mjs`; `launchCoordinator(root, opts)` keeps its existing signature/return (`{ pid: number|null }`).

- [ ] **Step 1: Write the failing A1 unit test**

```js
import assert from "node:assert/strict";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { coordinatorSpawnPlan } from "../src/core/launch.mjs";

test("A1 coordinatorSpawnPlan: absolute root argv, parent-dir cwd", () => {
	const base = join(tmpdir(), "agentview-c241-plan", "board root");
	for (const input of [base, `${base}/`, join(base, "views", "..")]) {
		const plan = coordinatorSpawnPlan(input);
		assert.ok(isAbsolute(plan.root), `root must be absolute for ${input}`);
		assert.equal(plan.root, resolve(input));
		assert.equal(plan.cwd, dirname(resolve(input)));
	}
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/coordinator-lifecycle.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../src/core/launch.mjs' does not provide an export named 'coordinatorSpawnPlan'`.

- [ ] **Step 3: Add `coordinatorSpawnPlan` (no wiring yet)**

In `src/core/launch.mjs`, add `import { dirname, resolve } from "node:path";` next to the other imports and export:

```js
/**
 * Compute the detached coordinator spawn plan (issue #241): an absolute root
 * argv and a cwd OUTSIDE the root. The coordinator derives all paths from the
 * root argument and never uses cwd, so keeping cwd off the root releases the
 * win32 directory handle that made throwaway roots undeletable.
 * @param {string} root
 * @returns {{ root: string, cwd: string }}
 */
export function coordinatorSpawnPlan(root) {
	const absoluteRoot = resolve(root);
	return { root: absoluteRoot, cwd: dirname(absoluteRoot) };
}
```

- [ ] **Step 4: Run A1 to verify it passes** — `node --test test/coordinator-lifecycle.test.mjs` → PASS.

- [ ] **Step 5: Write the failing A2 integration test (append to the file)**

```js
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { launchCoordinator } from "../src/core/launch.mjs";
import { isAlive } from "../src/core/pid.mjs";
import { sleep, waitFor } from "./helpers-c241.mjs"; // inline helpers instead if preferred
```

Fake runner body (written under the temp root by the test):

```js
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.argv[2], "spawn-probe.json"), JSON.stringify({ cwd: process.cwd(), arg: process.argv[2] }));
```

Test body:

```js
test("A2 launchCoordinator spawns with absolute root argv and parent-dir cwd", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-c241-spawn-"));
	try {
		const fake = join(root, "fake-runner.mjs");
		writeFileSync(fake, FAKE_RUNNER, "utf8");
		const { pid } = launchCoordinator(root, { runnerScript: fake });
		assert.ok(pid, "detached child has a pid");
		const probePath = join(root, "spawn-probe.json");
		const raw = await waitFor(() => (existsSync(probePath) ? readFileSync(probePath, "utf8") : null), 5000);
		assert.ok(raw, "fake runner must write its probe file");
		const probe = JSON.parse(raw);
		const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
		assert.equal(norm(probe.arg), norm(root), "argv[2] is the absolute root");
		assert.equal(norm(probe.cwd), norm(dirname(root)), "cwd is the root's parent, not the root");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 6: Run A2 to verify it fails** — `node --test test/coordinator-lifecycle.test.mjs` → A2 FAIL at `cwd ... not the root` (launchCoordinator still spawns with `cwd: root`); A1 passes.

- [ ] **Step 7: Wire `launchCoordinator` to the plan**

```js
export function launchCoordinator(root, opts) {
	const node = opts.node ?? resolveNode();
	const plan = coordinatorSpawnPlan(root);
	const child = spawnDetached(node, [opts.runnerScript, plan.root], plan.cwd);
	return { pid: child.pid ?? null };
}
```

Update the JSDoc above it with one sentence: "The child's cwd is the root's PARENT (issue #241): the coordinator derives paths from argv and cwd must not pin the root on win32."

- [ ] **Step 8: Run both A1 and A2 to verify they pass** — `node --test test/coordinator-lifecycle.test.mjs` → PASS.

- [ ] **Step 9: Run the coordinator endpoint-normalization regression**

Run: `node --test test/coordinator-client.test.mjs`
Expected: PASS, including the `#124` alternate-spelling test (spawn argv now canonical; endpoint hash already normalizes via `path.win32.resolve`).

- [ ] **Step 10: Commit**

```bash
git add src/core/launch.mjs test/coordinator-lifecycle.test.mjs
git commit -m "fix(coordinator): spawn with absolute root and parent-dir cwd (issue #241)"
```

---

## Task 2: root-vanished self-exit (A3, A3b, A4)

**Files:**
- Modify: `runner/state-coordinator.mjs` (`statSync` already imported at `:39`; supervised heartbeat at `:237-272`; `shutdown` at `:278-293`)
- Test: `test/coordinator-lifecycle.test.mjs` (append)

**Interfaces:**
- Consumes: `launchCoordinator` from Task 1 (A3 spawns the real coordinator through it).
- Produces: coordinator behavior only — no exported API. Exit path is the existing `shutdown(0)`.

- [ ] **Step 1: Write the failing A3 self-exit test (append)**

```js
const COORDINATOR_SCRIPT = fileURLToPath(new URL("../runner/state-coordinator.mjs", import.meta.url));

test("A3 deleting the root makes the coordinator exit within the grace window", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-c241-exit-"));
	const prev = process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS;
	process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS = "100";
	try {
		const { pid } = launchCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
		assert.ok(pid);
		assert.ok(await waitForCoordinatorReady(root, 10_000), "coordinator binds its endpoint");
		const lease = join(P.viewLockPath(root, "_coordinator", "state-coordinator"), "owner.json");
		assert.ok(existsSync(lease), "lease exists BEFORE the delete (anti-vacuous precondition)");
		assert.ok(isAlive(pid), "coordinator is alive before the delete");
		rmSync(root, { recursive: true, force: true }); // must not throw: cwd no longer pins the root
		assert.equal(existsSync(root), false);
		await waitForPidGone(pid, 5000);
		assert.equal(isAlive(pid), false, "coordinator exits after its root vanished");
	} finally {
		if (prev === undefined) delete process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS;
		else process.env.AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS = prev;
		rmSync(root, { recursive: true, force: true });
	}
});
```

Helpers in the same file (not exported elsewhere): `waitForCoordinatorReady(root, ms)` polls `createConnection(P.coordinatorEndpointPathFor(process.platform, root))` until connect succeeds; `waitForPidGone(pid, ms)` polls `isAlive` every 25 ms; `isAlive` is imported from `../src/core/pid.mjs` (`src/core/pid.mjs` exports `isAlive`).

- [ ] **Step 2: Run A3 to verify it fails** — `node --test test/coordinator-lifecycle.test.mjs` → A3 FAIL: `rmSync` now succeeds (Task 1) but `coordinator exits after its root vanished` fails (pid stays alive); lease precondition passes.

- [ ] **Step 3: Add `rootVanished()` and hook it into the supervised interval**

```js
/** True only when the root is provably gone (ENOENT). A transient access
 *  failure (EACCES/EBUSY) must not kill a healthy coordinator. */
function rootVanished() {
	try { statSync(root); return false; }
	catch (err) { return err?.code === "ENOENT"; }
}
```

Inside the `setInterval` callback started in `server.listen` (`runner/state-coordinator.mjs:248`), before the existing `lease.touch()` logic:

```js
heartbeatTimer = setInterval(() => {
	if (rootVanished()) {
		// Root is gone, so the diagnostic write itself will fail; it is
		// best-effort and must not block the step-down (same fence as the
		// heartbeat-loss path, issue #224 D4).
		try { appendCoordinatorDiagnostic("coordinator_root_missing", { root }, "error"); } catch { /* root is gone */ }
		shutdown(0);
		return;
	}
	// ...existing touch/failure logic unchanged...
}, heartbeatMs);
```

- [ ] **Step 4: Run A3 to verify it passes** — `node --test test/coordinator-lifecycle.test.mjs` → PASS.

- [ ] **Step 5: Write A3b (boot with an already-missing root) and A4 (no false positive)**

A3b: create a root with `mkdtempSync`, `rmSync` it, then `launchCoordinator(root, { runnerScript: COORDINATOR_SCRIPT })`; poll `isAlive(pid)` and assert it exits within 5 s; assert nothing remains bound (a probe connect fails). Boot fails lease acquisition (`shutdown` path is not involved) and must exit 0 without lingering.

A4: with the same 100 ms knob, launch on an existing root, wait ≥ 3 ticks (`await new Promise((r) => setTimeout(r, 500))`), then assert `isAlive(pid)` and a raw `ping`/`pong` round-trip on the endpoint; finally kill it. Assert the step-down diagnostic code is absent: read `views/_coordinator/diagnostics.jsonl` if present and assert no `"code":"coordinator_root_missing"` line.

- [ ] **Step 6: Run A3, A3b, A4** — all PASS. If A4 fails because the coordinator was killed by the test's own knob, restore the env var before spawning (the knob is read at coordinator `main()` start).

- [ ] **Step 7: Run the existing coordinator suites**

Run: `node --test test/state-coordinator.integration.test.mjs test/coordinator-client.test.mjs`
Expected: PASS (heartbeat supervision, lease reclaim, A14 endpoint cleanup unchanged).

- [ ] **Step 8: Commit**

```bash
git add runner/state-coordinator.mjs test/coordinator-lifecycle.test.mjs
git commit -m "fix(coordinator): step down when the board root disappears (issue #241)"
```

---

## Task 3: suite gate wrapper (A5, A6, A7 wiring)

**Files:**
- Create: `scripts/run-tests.mjs`
- Create: `test/run-tests-wrapper.test.mjs`
- Modify: `package.json` (`:56-57` test scripts)
- Modify: `.c8rc.json` (exclude array, `:4-9`)

**Interfaces:**
- Consumes: nothing from earlier tasks for its own tests; its real run expects Tasks 1–2 to stop leaks (A7).
- Produces: `parseProcessList(raw, platform)`, `selectOrphanCoordinators({processes, repoRoot, tmpRoot, platform})`, `runSuite(deps)`, `main()`; `package.json` `"test": "node scripts/run-tests.mjs"`, `"test:coverage": "c8 node scripts/run-tests.mjs"`.

- [ ] **Step 1: Write the failing A5 parse tests**

In `test/run-tests-wrapper.test.mjs`, `import { parseProcessList, selectOrphanCoordinators } from "../scripts/run-tests.mjs";` and assert:

```js
const CIM_ARRAY = JSON.stringify([
	{ ProcessId: 123, CommandLine: "node C:\\repo\\runner\\state-coordinator.mjs C:\\Temp\\agentview-pty-a" },
]);
const CIM_SINGLE = JSON.stringify({ ProcessId: 456, CommandLine: "node other.mjs" });
test("A5 parseProcessList: CIM array and single object", () => {
	assert.deepEqual(parseProcessList(CIM_ARRAY, "win32"), [{ pid: 123, commandLine: "node C:\\repo\\runner\\state-coordinator.mjs C:\\Temp\\agentview-pty-a" }]);
	assert.deepEqual(parseProcessList(CIM_SINGLE, "win32"), [{ pid: 456, commandLine: "node other.mjs" }]);
});
test("A5 parseProcessList: ps lines incl. long command line", () => {
	const long = "/usr/bin/node /home/u/repo/runner/state-coordinator.mjs /tmp/agentview-" + "x".repeat(200);
	const raw = `  123 ${long}\n  456 node other.mjs\nnot-a-line\n`;
	const parsed = parseProcessList(raw, "linux");
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0].pid, 123);
	assert.ok(parsed[0].commandLine.includes("x".repeat(200)), "long command line survives parsing");
	assert.equal(parseProcessList("", "linux").length, 0);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test test/run-tests-wrapper.test.mjs` → FAIL (module not found).

- [ ] **Step 3: Implement `parseProcessList` in `scripts/run-tests.mjs`**

Top of file: shebang `#!/usr/bin/env node`, module JSDoc describing the gate, imports (`readdirSync`, `execFileSync`/`spawn`, `readFileSync` if needed, `tmpdir`, `dirname`, `resolve`, `sep`, `fileURLToPath`, `pathToFileURL`). Pure function:

```js
export function parseProcessList(raw, platform) {
	const text = String(raw ?? "").trim();
	if (!text) return [];
	if (platform === "win32") {
		let data;
		try { data = JSON.parse(text); } catch { return []; }
		const rows = Array.isArray(data) ? data : [data];
		return rows
			.map((row) => ({ pid: Number(row?.ProcessId ?? 0), commandLine: String(row?.CommandLine ?? "") }))
			.filter((row) => Number.isFinite(row.pid) && row.pid > 0 && row.commandLine);
	}
	const out = [];
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (m) out.push({ pid: Number(m[1]), commandLine: m[2] });
	}
	return out;
}
```

- [ ] **Step 4: Run A5 parse tests to verify they pass.**

- [ ] **Step 5: Write the failing A5 selection tests**

```js
const REPO = "C:\\repo";
const TMP = "C:\\Users\\u\\AppData\\Local\\Temp";
const SCRIPT = `${REPO}\\runner\\state-coordinator.mjs`;
function proc(pid, root, { script = SCRIPT, platform = "win32" } = {}) {
	const cmd = platform === "win32"
		? `"C:\\Program Files\\nodejs\\node.exe" "${script}" "${root}"`
		: `/usr/bin/node ${script} ${root}`;
	return { pid, commandLine: cmd };
}
test("A5 selection: this checkout + temp root only; production/other-checkout excluded", () => {
	const processes = [
		proc(1, `${TMP}\\agentview-pty-abc`),                            // selected
		proc(2, "C:\\Users\\u\\.pi\\agent\\agent-board"),                // production root
		proc(3, `${TMP}\\agentview-pty-def`, { script: "C:\\other\\runner\\state-coordinator.mjs" }), // other checkout
		proc(4, `${TMP}\\agentview-pty-ghi`, { script: SCRIPT.replace(/\\/g, "/") }), // slash variant
		{ pid: 5, commandLine: "node unrelated.mjs" },
	];
	const got = selectOrphanCoordinators({ processes, repoRoot: REPO, tmpRoot: TMP, platform: "win32" });
	assert.deepEqual(got.map((x) => x.pid), [1, 4]);
	assert.ok(got.every((x) => x.root.startsWith(TMP)));
});
test("A5 selection: POSIX", () => {
	const processes = [
		{ pid: 10, commandLine: `/usr/bin/node /home/u/repo/runner/state-coordinator.mjs /tmp/agentview-pty-abc` },
		{ pid: 11, commandLine: `/usr/bin/node /home/u/repo/runner/state-coordinator.mjs /home/u/.pi/agent/agent-board` },
	];
	const got = selectOrphanCoordinators({ processes, repoRoot: "/home/u/repo", tmpRoot: "/tmp", platform: "linux" });
	assert.deepEqual(got.map((x) => x.pid), [10]);
});
```

- [ ] **Step 6: Run to verify selection fails** (not implemented), then implement:

Rules: normalize separators (`/`→`\` on win32) and lowercase both sides on win32; require the command line to contain `<repoRoot>/runner/state-coordinator.mjs`; extract the root as the token after the script path (strip surrounding quotes); require the root to resolve under `tmpRoot` (`resolve(root).toLowerCase().startsWith(resolve(tmpRoot).toLowerCase() + sep)` on win32, `startsWith(resolve(tmpRoot) + "/")` on POSIX). Return `[{pid, root}]` sorted by pid.

- [ ] **Step 7: Run A5 selection tests to verify they pass.**

- [ ] **Step 8: Write the failing A6 `runSuite` tests (injected fakes)**

`runSuite(deps)` contract: `deps = { spawnTest, listProcesses, kill, sleep, log, repoRoot, tmpRoot, platform, graceMs = 10_000, pollMs = 100, log }`; `spawnTest()` resolves `{ exitCode: number|null, signal?: string|null }`; `listProcesses()` returns `[{pid, commandLine}]`; `kill(pid, signal)`; `sleep(ms)`; `log(line)`; returns `{ exitCode, survivors: number[] }`.

Cases:
- clean: before `[]`, after `[]`, `spawnTest` → `{exitCode: 0}` ⇒ `{exitCode: 0, survivors: []}`, `kill` never called.
- survivor: before `[]`; after list returns a selected coordinator forever; `spawnTest` → `{exitCode: 0}` ⇒ `exitCode: 1`, `kill` called with `SIGTERM` then `SIGKILL`, survivor reported.
- snapshot-only survivor: same pid present in before AND after ⇒ not killed, `exitCode: 0`, `log` contains a pre-existing warning with count 1.
- signal exit: `spawnTest` → `{exitCode: null, signal: "SIGINT"}` ⇒ `exitCode: 1`.
- enumeration failure: `listProcesses` throws ⇒ `exitCode` equals the test exit code (0), `kill` not called, `log` contains a warning.
- import safety: importing the module twice resolves the same namespace and does not start anything (a spurious `main()` would run the suite recursively here).

- [ ] **Step 9: Run to verify A6 fails, then implement `runSuite` + `main()` + main-guard**

Main guard:

```js
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await main();
}
```

`main()`: `files = readdirSync("test").filter((f) => f.endsWith(".test.mjs")).sort().map((f) => join("test", f))`; `spawnTest = () => new Promise((res) => { const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" }); child.on("exit", (code, signal) => res({ exitCode: code, signal })); })`; `listProcesses = () => parseProcessList(execFileSync(enumCmd, enumArgs, { encoding: "utf8" }), process.platform)` where the enum command is `pwsh/powershell` CIM on win32 and `ps -e -ww -o pid=,args=` otherwise; `kill = (pid, sig) => { try { process.kill(pid, sig); } catch {} }`; grader: poll `pollMs` until `graceMs` for snapshot-subtracted pids to vanish, then kill survivors (`SIGTERM` → 2 s → `SIGKILL`) and `process.exitCode = 1`. Print `run-tests: no leaked coordinators` on success. On enumeration error: warn via `log`, skip residue check.

- [ ] **Step 10: Run A6 tests to verify they pass.**

- [ ] **Step 11: Wire `package.json` and `.c8rc.json`**

- `package.json`: `"test": "node scripts/run-tests.mjs"`, `"test:coverage": "c8 node scripts/run-tests.mjs"`.
- `.c8rc.json`: add `"scripts/run-tests.mjs"` to `exclude`.

- [ ] **Step 12: Run the wrapper over the full suite**

Run: `npm test`
Expected: the suite runs, exits 0, and prints `run-tests: no leaked coordinators`. If survivors are reported, record pid + root (Task 4 owns fixing exposed tests) — do not loosen the gate.

- [ ] **Step 13: Commit**

```bash
git add scripts/run-tests.mjs test/run-tests-wrapper.test.mjs package.json .c8rc.json
git commit -m "test: fail the suite when it leaks a state-coordinator (issue #241)"
```

---

## Task 4: full verification, exposed-leak fixes, coverage (A7, A8, U1)

**Files:**
- Modify: any test file the gate exposes as not cleaning up its root (expected: none, but the gate is the source of truth)
- No product code changes expected.

**Interfaces:**
- Consumes: Tasks 1–3 complete.

- [ ] **Step 1: Typecheck** — `npm run typecheck` → 0 errors.

- [ ] **Step 2: Run the suite twice through the wrapper** — `npm test` twice → both exit 0 with no survivors. If a test file leaves a coordinator, its root or its cleanup is fixed in that test file (attach the pid/root from the gate output to the commit message).

- [ ] **Step 3: Coverage gate** — `npm run test:coverage` → wrapper runs under c8, thresholds hold (lines 85 / funcs 80 / branches 70).

- [ ] **Step 4: Perf gate** — `npm run test:perf` → pass 3 / skipped 0 (the wrapper must not affect it).

- [ ] **Step 5: Full verify** — `npm run verify` → typecheck + perf + tests + coverage + pack:dry all green.

- [ ] **Step 6: U1 measurement on the reporter's box (Windows)**

Record before/after `npm test`: count `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` filtered to `state-coordinator` and count `%TEMP%\agentview-pty-*` dirs. One-time cleanup of pre-existing orphans is allowed before the baseline (document the exact pids/dirs removed). Report both counts and the delta in the task summary; the post-merge U1 entry points at this measurement.

- [ ] **Step 7: Commit any fixes** (test cleanup only; message `test: clean up <file> coordinator root (issue #241)`).

---

## Task 5: pre-existing win32 `launch.test.mjs` cleanup failures (gate exposure)

**Why:** `node --test test/launch.test.mjs` fails 4/5 on win32 on `main` @2815469 (verified before this branch). Its fixtures build `config.cwd = root` and spawn `test-support/fake-pi.mjs` as a detached runner but never kill it, so `rmSync(root)` fails `EPERM` at cleanup — the same root-pinning and fake-runner-orphan class this issue fixes. A7 requires `npm test` green on Windows, so this must be repaired in the same PR (spec §7 "a test that never deletes its root: fix that test's cleanup in the same PR").

**Files:**
- Modify: `test/launch.test.mjs` only (no product code, per the Why).

- [ ] **Step 1: Reproduce** — `node --test test/launch.test.mjs` → 4 failures with `EPERM ... agentview-launch-*`.

- [ ] **Step 2: Add a local `killAndRemove(pid, dir)` helper** at the bottom of the file: SIGTERM the pid (ignore errors), poll `isAlive(pid)` every 25 ms up to 2 s, SIGKILL if still alive, then `rmSync(dir, { recursive: true, force: true })` retried every 50 ms up to 40 attempts (rethrow the last error). `isAlive` can be a local `try { process.kill(pid, 0); return true; } catch { return false; }`.

- [ ] **Step 3: Use it in the four failing tests' `finally`** — replace `rmSync(root, ...)` with `await killAndRemove(res.pid, root)` (hoist `res` above the `try`). Keep every assertion unchanged.

- [ ] **Step 4: Verify** — `node --test test/launch.test.mjs` → 5/5 pass; run it twice and confirm no `agentview-launch-*` dirs and no lingering `fake-pi.mjs` processes are left behind.

- [ ] **Step 5: Commit** — `test: kill launched fake runners before removing launch roots (issue #241)`.

Execution order note (ledger): Task 5 runs after Tasks 1–3 and **before Task 4**, because Task 4's gate must see a green suite.

## Self-Review

**Spec coverage:** §3.1 → Task 1 (A1, A2); §3.2 → Task 2 (A3, A3b, A4); §3.3 → Task 3 (A5, A6, A7); §3.4 ordering honored (wrapper wired after 1–2); §5 A8 + U1 → Task 4; §7 risks mapped to Review Focus + tests; §8 deployment unchanged by design (no bump, no migration).

**Step scan:** every step names the file, the exact function/assertion or command, and the expected failure/pass; no "handle edge cases" or TBD lines.

**Type consistency:** `coordinatorSpawnPlan` (Task 1) is not referenced by later tasks except through `launchCoordinator`; `parseProcessList`/`selectOrphanCoordinators`/`runSuite` names and signatures are identical between Task 3 steps and its tests; `isAlive` comes from `src/core/pid.mjs`; `P.viewLockPath` from `src/core/paths.mjs`.

**Review Focus coverage:** relative/trailing/dot root → A1 + #124 suite (Task 1); boot with missing root → A3b (Task 2); no-enumeration host → A6 branch E (Task 3); pre-existing orphans → A6 branch C (Task 3); win32 spellings/production roots → A5 (Task 3).

**Proportion:** plan tasks are code-light; the wrapper's pure functions are the only non-trivial bodies and their behavior is fixed by the tests above.
