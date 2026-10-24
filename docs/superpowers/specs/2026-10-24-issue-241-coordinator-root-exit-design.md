# Issue #241 — detached state-coordinator never exits on its own

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T17:48:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T17:59:00+08:00 (spec-cross-review round 1, degraded — findings R1-G1..G3, R1-D1..D8)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T18:04:00+08:00 (spec-cross-review round 2, degraded — converged; R2-D1..D3)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T18:35:00+08:00 (task-2 review I1: the root-missing step-down must not write a diagnostic — `appendLine` recreates the root skeleton; stderr attribution only. A3/A4 updated, §3.2/§6/§7 corrected)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T19:05:00+08:00 (task-3 verification ruling: A7 is a CI acceptance — the dev Windows box has 62 pre-existing environmental failures; local gate = 0 survivors + no new failure. U1 reworded to measure residue, not exit codes; §7 baseline row added)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-24T19:20:00+08:00 (final-review MUST-FIX I1: writes recreate a deleted root, so existence-only detection is insufficient — add the boot-time dev/ino root-identity guard, A3c integration test, correct §7/G1; wrapper trailing-separator false-green gets a code+unit fix in the same wave)

Status: step-4 root-cause report / spec draft (github-issue-driven). Cross-review:
`research/spec-review-round-1.md` (round 1 not converged → this revision; round 2
reviews this version). Research: `research/root-cause.md`. Issue comments: #241
(6382598306, 6382598816, 6382611575).

## 1. Problem statement

A detached `runner/state-coordinator.mjs` outlives every short-lived caller that
lazily started it (tests, probe child processes, detached runner children,
one-shot CLI/repro scripts) because it only ever exits on SIGTERM/SIGINT, a
server error, or three consecutive heartbeat failures. There is no idle timeout
and no "my root is gone" check; `server.listen()` keeps the event loop alive
forever. Live audit on the reporting box: 26 orphans, all roots under
`%TEMP%\agentview-*`, all parents dead, ~3.75 GB RSS, 68 `agentview-pty-*`
directories.

On win32 the throwaway root is also **undeletable while the coordinator lives**,
because the coordinator's own **cwd is the root** — verified: `rmSync(root)`
fails with `EPERM` (experiment in research §3). Therefore the issue's option 1
(`statSync(root)` ⇒ ENOENT ⇒ exit) cannot fire as written: the root is still
there. On Linux deleting a process's cwd is allowed, which is why CI stays green.

Root cause chain (four links):

1. `launchCoordinator` spawns `detached, stdio:ignore, cwd: root` — outliving
   the caller is by design (a real board's coordinator must survive the
   dashboard Pi), so the spawn shape itself is not the bug.
2. The coordinator has no root-vanished and no idle exit.
3. Short-lived callers lazily `ensureCoordinator` on throwaway roots and never
   learn the spawned pid (`ensureCoordinator` returns it, but only
   `coordinator-client.test.mjs` tracks it; probes and runner children do not).
4. On win32 the coordinator's `cwd: root` keeps the root present, so even the
   "root is gone" signal the reporter proposed is shadowed by the process's own
   handle — the test's `rmSync` fails, the directory and the process both stay.

## 2. Goals / non-goals

Goals:

- G1 A coordinator whose root was deleted exits on its own within a bounded,
  small window, releasing its lease. Covers test/probe roots and one-shot CLI
  roots, not just this repo's suite. A concurrent write that recreates the
  directory is detected by the boot-time dev/ino identity guard and steps down on
  the next tick (residual: a skeleton directory, never a surviving process).
- G2 Throwaway roots become deletable on win32 while a coordinator serves them
  (the cwd handle is released), so test/probe cleanup stops leaving directories.
- G3 The test suite fails loudly if it leaks a coordinator: after `node --test`
  finished, any coordinator spawned from this checkout on a temp root is killed
  and the run exits nonzero.
- G4 Production behavior is unchanged while the board root exists: no extra
  startup cost, no restart, no protocol bump, no data migration.

Non-goals:

- Idle timeout ("root still exists but nobody talks to me"). No acceptance
  criterion in the issue requires it; it needs a conservative knob and could
  thrash a live board. Follow-up candidate.
- Changing the detached spawn design (the coordinator must outlive the
  dashboard Pi).
- Cleaning the 330 empty `agentview-cclient-*` directories (fake-server roots
  that are simply never removed in `coordinator-client.test.mjs`; no live
  process, separate hygiene item).
- Auto-cleaning orphans that predate this change (they have no self-exit code).
  The wrapper only snapshots-and-warns about pre-existing ones.

## 3. Design

### 3.1 Release the root handle (launchCoordinator)

`src/core/launch.mjs` (add `import { dirname, resolve } from "node:path";` — the
file currently imports only `spawn`, `atomicWriteJson`, `resolveNode`, `paths.mjs`,
`writePid`, see `launch.mjs:8-12`):

```js
export function coordinatorSpawnPlan(root) {
	const absoluteRoot = resolve(root);
	return { root: absoluteRoot, cwd: dirname(absoluteRoot) };
}

export function launchCoordinator(root, opts) {
	const node = opts.node ?? resolveNode();
	const plan = coordinatorSpawnPlan(root);
	const child = spawnDetached(node, [opts.runnerScript, plan.root], plan.cwd);
	return { pid: child.pid ?? null };
}
```

- The coordinator derives every path from the absolute root argument and never
  touches `process.cwd()` (verified line by line: `runner/state-coordinator.mjs`
  uses `root = process.argv[2]` at `:91` plus `src/core/paths.mjs`; no `chdir`).
  cwd is purely a process-level side effect, so there is no behavior change.
- Passing `resolve(root)` keeps relative-root callers working and makes the argv
  canonical. Pipe-name isolation is unaffected: `coordinatorEndpointPathFor`
  already hashes `path.win32.resolve(root)` (`src/core/paths.mjs:120-139`,
  issue #124), so every spelling maps to the same endpoint.
- `dirname(root)` exists whenever the root's parent exists; for `C:\`/`/` the
  parent is the root itself. The parent of a board root (`~/.pi/agent`) and the
  parent of a temp root (`os.tmpdir()`) are stable, so the process still has a
  valid cwd and no longer pins a throwaway root.

### 3.2 Root-vanished self-exit (state-coordinator)

`runner/state-coordinator.mjs`, inside the existing supervised heartbeat
interval (started in the `server.listen` callback, `:237-272`, default 1000 ms,
`AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS` compressible per
`src/core/test-knobs.mjs` and read at `main()` start, `:123`):

```js
heartbeatTimer = setInterval(() => {
	if (rootVanished()) {
		// No diagnostic: appendLine ensureDirs its parent and would recreate
		// <root>/views/_coordinator, leaving the skeleton dir U1 measures.
		process.stderr.write(`state-coordinator: board root missing (${root}); stepping down\n`);
		shutdown(0);
		return;
	}
	// ... existing touch/failure logic unchanged
}, heartbeatMs);
```

`rootVanished()` is a module-scope helper using the already-imported `statSync`
(`:39`):

```js
function rootVanished() {
	try { statSync(root); return false; }
	catch (err) { return err?.code === "ENOENT"; }
}
```

**Root-replacement guard (final-review I1).** An existence-only check is not
enough: a write that lands after the delete (`appendCommand` / `writeState` →
`ensureDir`) *succeeds by recreating* the directory, so the next tick sees
"present" and the coordinator serves a dead board — or, in the boot-window race
(guard passes, then the root is deleted before lease acquisition `ensureDir`),
it acquires a lease on the recreated root and serves forever. Capture the
directory identity once at boot and step down when it changes:

```js
const rootIdentity = captureRootIdentity(); // {dev, ino} | null (null when the FS reports ino 0)
function rootVanishedOrReplaced() {
	try {
		const st = statSync(root);
		if (!rootIdentity) return null;
		return st.dev !== rootIdentity.dev || st.ino !== rootIdentity.ino ? "replaced" : null;
	} catch (err) {
		return err?.code === "ENOENT" ? "missing" : null;
	}
}
```

The boot guard captures the identity before lease acquisition and compares the
same way. Step-down stderr: `state-coordinator: board root missing (<root>);
stepping down` or `state-coordinator: board root replaced (<root>); stepping
down`. When `ino` is unavailable/0 the check degrades to existence-only (never a
false step-down). Residual accepted: a write in the delete window may leave a
skeleton directory (data, not a process); the guard bounds its lifetime to one
tick.

- `ENOENT` ⇒ step down. Any other error (EACCES/EBUSY) or success ⇒ keep
  serving — a transient access failure must not kill a healthy coordinator.
- **No diagnostic is written on the root-missing path.** Every append helper
  `ensureDir`s its parent (`src/core/atomic.mjs:107-109`), so writing
  `<root>/views/_coordinator/diagnostics.jsonl` would *succeed* by recreating the
  deleted directory chain — reintroducing the skeleton-dir residue U1 measures.
  The step-down is logged to stderr instead
  (`state-coordinator: board root missing (<root>); stepping down`): detached
  callers ignore stdio, while a test can spawn the runner with a stderr pipe and
  attribute the exit deterministically. The boot-time guard (`rootVanished()`
  before lease acquisition — lease acquisition also `ensureDir`s and would
  recreate the root, so "fails lease acquisition" is not a viable boot path)
  logs the same stderr line and writes nothing either.
- `shutdown(0)` already clears the interval, closes the server, best-effort
  unlinks the POSIX socket, releases the lease, and exits — all cleanup is
  try/catch guarded (`:278-293`). `shutdown` is idempotent via its `shuttingDown`
  flag, and `lease.release()` no-ops when `owner.json` is gone (token-fenced).
- A command in flight at the instant the root disappears fails its journal/write
  and the client observes the documented ambiguous outcome
  (`connection_reset`/`timeout`); it must not retry with a fresh commandId
  (`coordinator-client.mjs:11-25`). This is an accepted edge, see §7.

Bounds: detection latency ≤ one heartbeat tick (1 s production) after the root
disappears. No new timer, no new startup cost. The test knob also shortens the
lease touch interval, but the stale-lease threshold stays
`max(60s, 3 × heartbeatMs)` = 60 s (existing #224 behavior in
`src/core/locks.mjs`), so A3/A4 never depend on the knob changing stale
semantics.

### 3.3 Suite gate (new `scripts/run-tests.mjs`)

`package.json` (`:56-57`):

```json
"test": "node scripts/run-tests.mjs",
"test:coverage": "c8 node scripts/run-tests.mjs",
```

The wrapper (Node, no shell glob, no new dependency):

1. Enumerate test files: `readdirSync("test")` filtered to `*.test.mjs`, sorted,
   passed to `node --test <files>`; child stdio inherited.
2. **Before** the run, enumerate coordinator processes and keep their pids as a
   *snapshot* (pre-existing orphans must not fail this run; print a one-line
   warning with the count instead).
3. Spawn `process.execPath --test <files...>`, wait for exit. `exitCode === null`
   (killed by a signal) is treated as failure and the signal is printed — it is
   never a success passthrough.
4. **After** the run, poll every 100 ms up to 10 s for every coordinator above
   the snapshot to be gone (the 1 s self-exit window plus load slack).
5. Any survivor: print pid + root per process, `SIGTERM` (on win32 that is
   TerminateProcess), wait 2 s, `SIGKILL` leftovers, and exit 1. Otherwise exit
   with the test run's own exit code (test failures keep priority; residue is
   also reported if both happen).

**Import safety (required):** the module must be side-effect free on import —
`main()` runs only when the file is the entry point, e.g.
`if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();`
otherwise the wrapper's own unit tests (A5/A6) would recursively run the suite.

Process enumeration, split for testability:

```js
export function parseProcessList(raw, platform)        // pure
export function selectOrphanCoordinators({ processes, repoRoot, tmpRoot, platform }) // pure
export async function runSuite({ spawn, listProcesses, kill, sleep, now, ... })      // injectable shell
export function main()                                 // real shell, guarded entry
```

- win32 enumeration: `pwsh`/`powershell` `-NoProfile -NonInteractive -Command`
  with `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = ...;`
  prefix and `Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`. The JSON may
  be a single object when only one process matches — `parseProcessList` must
  accept both object and array.
- POSIX enumeration: `ps -e -ww -o pid=,args=` (`-ww` = unlimited width; without
  it macOS/Linux may truncate the command line before the root argument and the
  process silently escapes selection).
- Selection predicate: command line contains this checkout's
  `runner/state-coordinator.mjs` absolute path (case-insensitive on win32,
  separator-normalized) **and** its root argument resolves under `os.tmpdir()`.
  Production roots (`~/.pi/agent/agent-board`, `$AGENT_BOARD_ROOT`) never match,
  so a live board coordinator is never touched; another checkout's test
  coordinator never matches because the script path differs.
- Root extraction from the command line: the token after
  `state-coordinator.mjs`, quotes stripped (spawned argv is not quoted, CIM may
  quote paths with spaces).
- Enumeration unavailable (command missing/permission error): print a warning
  and skip the residue check (fail-open). CI (`ps`, ubuntu) and the reporting
  Windows box (`pwsh`) both support it; this avoids turning an enumeration
  environment issue into a red suite.

`.c8rc.json` (`:4-9`) gains `"scripts/run-tests.mjs"` in `exclude` (CLI shell +
process enumeration; the pure parts are unit-tested but the wrapper itself is a
dev runner). Coverage collection is unaffected: c8 exports `NODE_V8_COVERAGE` to
the whole child tree.

### 3.4 Ordering constraint

The wrapper gate (3.3) can only land green **after** 3.1 + 3.2 make the existing
suite stop leaking. Implementation order: 3.1 → 3.2 → integration tests → wire
package.json + wrapper → run the full suite. If the gate reports survivors that
come from a path not fixed by 3.1/3.2, that is a real finding to investigate
(possibly an additional lazy-spawn path), not something to silence.

## 4. Component contracts

| Symbol | Module | Contract |
|---|---|---|
| `coordinatorSpawnPlan(root)` | `src/core/launch.mjs` | `{ root: string (absolute), cwd: string }`; `cwd === dirname(resolve(root))`; idempotent for absolute roots. |
| `parseProcessList(raw, platform)` | `scripts/run-tests.mjs` | `Array<{pid:number, commandLine:string}>`; `win32` accepts CIM JSON array **or** single object, `linux`/`darwin` parse `ps` lines; unparsable lines skipped, never throws. |
| `selectOrphanCoordinators({processes, repoRoot, tmpRoot, platform})` | `scripts/run-tests.mjs` | `Array<{pid:number, root:string}>`; only this checkout's `runner/state-coordinator.mjs`; root under `tmpRoot`; deterministic order by pid. |
| `runSuite(deps)` | `scripts/run-tests.mjs` | Injectable `spawn/listProcesses/kill/sleep`; returns `{exitCode, survivors}`; no `process.exit` inside, no `main()` side effect on import. |
| root-vanished check | `runner/state-coordinator.mjs` | `ENOENT` on `statSync(root)` ⇒ step down; other errors/OK ⇒ keep serving. |

## 5. Acceptance matrix

Verification commands assume repo root. `WT` = worktree absolute path (step 5).

| ID | Functional point | Verification | Concrete check | Pass criterion |
|---|---|---|---|---|
| A1 | spawn plan: absolute argv + parent-dir cwd | Automated (unit) — `test/coordinator-lifecycle.test.mjs` | `coordinatorSpawnPlan` on absolute, trailing-slash, dot-segment roots | `root` absolute, `cwd === dirname(resolve(root))`, no throw |
| A2 | `launchCoordinator` actually spawns with that plan | Automated (integration, cross-platform) — same file | spawn a temp fake runner via `launchCoordinator(root, {runnerScript: fake})`; fake writes `{cwd: process.cwd(), arg: process.argv[2]}` under root; poll for the file | `arg === root` (absolute); both sides normalized with `path.resolve` and compared case-insensitively on win32 ⇒ `cwd === dirname(root)`; fails if cwd reverts to `root` |
| A3 | root-vanished self-exit releases the process; root becomes and stays deletable | Automated (integration) — same file | set `AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS=100` before spawn (restore in `finally`); spawn the real runner directly with the `coordinatorSpawnPlan` argv/cwd and `stdio: ["ignore", "pipe", "pipe"]`; wait until the endpoint answers; assert lease `owner.json` exists at `<root>/views/_coordinator/state-coordinator.lock/owner.json` (`P.viewLockPath`, `paths.mjs:171`) and pid alive; `rmSync(root, {maxRetries: 5, retryDelay: 50})`; wait for exit | rmSync does not throw; root gone and stays absent after exit; exit code 0; stderr matches `board root missing`; "exists before gone" asserted first (win32 rmSync success is the cwd evidence, stderr the self-exit attribution) |
| A3c | root recreated in the delete window does not defeat step-down | Automated (integration) — same file | start the real coordinator (direct spawn, stderr piped, 100 ms knob); wait ready; `rmSync(root)`; immediately send one valid `state_command` that is rejected but journaled (e.g. `patch_fields` on an unknown view) so the reply path recreates the root skeleton; await exit | exit code 0 within 2 s; stderr matches `/board root (missing\|replaced)/`; the directory may remain as a skeleton (data residue accepted) but no process survives |
| A4 | root present ⇒ no step-down (no false positive) | Automated (integration) — same file | same knob; start via the same direct spawn (stderr piped), wait ≥ 3 ticks (≈ 500 ms), then `rawPing` the endpoint and assert pid alive | still alive and answering ping; stderr contains no `board root missing` line (the root-missing path is observable only on stderr — it writes no diagnostic by design) |
| A5 | wrapper selection purity | Automated (unit) — `test/run-tests-wrapper.test.mjs` | win32 CIM array **and** single-object JSON samples + POSIX `ps` sample incl. a long (>200 char) command line; this-checkout vs other-checkout script path; temp vs production root; slash/case variants | exact pid sets, no throws, long line not truncated |
| A6 | wrapper orchestration + import safety | Automated (unit, injected fakes) — same file | survivors present → kill called for each, exit 1; clean → no kill, test exit code passthrough; snapshot survivors warn-only; `exitCode === null` → failure; `import` of the module performs no I/O and starts nothing | behavior as specified; importing twice is safe |
| A7 | suite is wired through the wrapper | Automated (build/suite) — CI `npm test` (ubuntu-latest) + local Windows baseline diff | in CI: `npm test` uses the wrapper and exits 0, printing `run-tests: no leaked coordinators`; `package.json` points at it. On the dev Windows box the full suite has a known pre-existing failure baseline (62 failures, separated by environment: AF_UNIX/EACCES `.sock`, AttachConsole, separator expectations — all reproduce with plain `node --test` on `main`); there the requirement is "failure set ⊆ baseline and 0 survivors", not exit 0 | CI: exit 0, no survivors; Windows: no new failures vs `main`, 0 survivors |
| A8 | coverage path still works with the wrapper | Automated (build) — `npm run test:coverage` (part of `npm run verify`) | c8 + wrapper + `.c8rc.json` exclude | coverage collected, thresholds lines 85 / funcs 80 / branches 70 hold |
| U1 | Windows box stops accumulating | User measurement — after merge, local Windows, before/after `npm test` twice (one-time manual cleanup of pre-existing orphans first) | count coordinators (`Get-CimInstance ... state-coordinator`) and `%TEMP%\agentview-pty-*` dirs before/after each run; also run `npm run typecheck`/the wrapper subset. The Windows-local suite is NOT expected to be green (pre-existing baseline above); U1 is about residue, not exit codes | 0 new coordinators, 0 new `agentview-pty-*` (or `agentview-del-flow-*`) dirs per run |

Automated-first: A1/A5/A6 are `unit`, A2/A3/A4 are `integration` (a real spawn
is the point; A2 is deliberately the cross-platform one so the cwd fix has a
CI-observable regression lock, since Linux cannot detect it via `rmSync`), A7/A8
are the repo's own commands. U1 is the only user measurement: it observes
process/OS state across runs on the reporter's box and is the direct
reproduction of the report.

## 6. Testability split (design constraint for implementation)

- `coordinatorSpawnPlan` is a pure function in `launch.mjs`; `launchCoordinator`
  is its thin spawn shell. A1 tests the pure part; A2 proves the shell's actual
  cwd/argv end to end on every platform (the fake runner writes its own
  `process.cwd()` and `argv[2]`); A3 proves the end-to-end consequence.
- The root-vanished decision is intentionally *not* extracted into a new module:
  it is a one-line predicate whose correctness is the timing/step-down sequence,
  so A3 (exit on delete) and A4 (no exit while present) are integration tests
  over the real runner. A pure predicate unit test would be tautological.
  Because the step-down must not write inside the root (see §3.2), its
  attribution is the **stderr line**: A3/A4 spawn the runner directly with
  `stdio: [..., "pipe", "pipe"]` instead of going through the detached
  `launchCoordinator` (whose stdio is ignored); A1/A2 already lock the
  `launchCoordinator` spawn plan, so no production-path coverage is lost.
- `scripts/run-tests.mjs` keeps two pure functions (`parseProcessList`,
  `selectOrphanCoordinators`) and one injectable orchestrator (`runSuite`) apart
  from `main()`'s real `spawn`/`execFileSync`/`process.kill`/timer shell, and is
  import-side-effect free by contract. A5 covers the pure functions; A6 covers
  `runSuite` with fakes (no real process is killed in unit tests) plus the
  import-safety contract.
- No test may assert "clean" without first asserting the precondition (lease
  file exists / pid alive before the delete; a survivor exists before the kill
  path; the fake runner's file appears before reading it).
- A2's fake runner lives under the temp root, is tiny, and never binds a socket;
  the test asserts the written file appears (bounded poll), then the values.

## 7. Risks / edge cases

| Risk | Handling |
|---|---|
| Root-missing step-down | writes no diagnostic and no state: `appendLine` recreates the parent chain, so a write would resurrect the deleted root skeleton; the step-down logs one stderr line and `shutdown(0)` stays unblocked. |
| `statSync` EACCES/EBUSY (transient) | treat as "root present", keep serving; only ENOENT steps down. |
| Root removed while a command is being journaled | the write may **succeed by recreating the root** (`ensureDir`), so existence-only detection is insufficient; the boot-time dev/ino identity guard detects the replacement on the next tick and steps down, leaving at most a skeleton directory. The client still sees the ambiguous `connection_reset`/`timeout` and must not retry with a fresh commandId (existing contract). |
| Wrapper kills another checkout's test coordinator | impossible: selection requires this checkout's absolute `runner/state-coordinator.mjs` path. |
| Wrapper runs while a real board coordinator serves a temp root (user set `AGENT_BOARD_ROOT` to a temp dir) | temp predicate would match; acceptable known limit — such a setup is itself a throwaway. Documented, not guarded. |
| Enumeration unavailable | warn + fail-open (skip residue check); A6 covers the failed-enumeration branch. |
| POSIX command line truncation | `ps -e -ww`; A5 covers a long line. |
| win32 CIM single-object JSON / non-UTF8 output | object-or-array parse; forced UTF-8 in the command prefix; A5 covers both shapes. |
| `pwsh` launch cost on every test run (~0.5–1 s) | acceptable for a dev/suite gate; POSIX path uses `ps`. |
| Windows-local full suite has pre-existing failures (AF_UNIX/EACCES `.sock`, AttachConsole, separator expectations) | A7 is a CI acceptance; locally the gate must show 0 survivors and no NEW failure vs `main`. Never loosen the gate (fail-open or skip) to make the local suite green. |
| Gate exposes a test that never deletes its root | after 3.1 the root is removable, so fix that test's cleanup in the same PR; no exemption list. |
| Existing orphans predating the fix | not auto-cleaned; wrapper warns with their count on every run; U1 includes one manual cleanup command. |
| npm test on Node 20 | wrapper uses only `readdirSync`/`spawn`/`process.kill`; no `--test-global-setup` (Node 22+ only), no new deps. |
| Coverage thresholds after adding the wrapper | `.c8rc.json` excludes the wrapper; A8 proves thresholds still hold. |

## 8. Deployment / execution path

- **No protocol version bump.** Every newly spawned coordinator runs the new
  `runner/state-coordinator.mjs` from the installed package — the spawn path is
  `opts.runnerScript` (`coordinator-client.mjs:197`), a file-path constant, not a
  protocol-negotiated one. Test/probe roots are freshly created per run, so they
  never collide with a pre-existing old-build instance. On a production root an
  already-running old-build coordinator keeps serving until it is next replaced
  or the process restarts; that is correct, because its root still exists and
  the new behavior is specifically "step down when the root is gone". (A
  protocol bump would force-reelect every user's coordinator on upgrade for no
  gain — explicitly out of scope.)
- No data migration. Lease/journal formats untouched.
- Already-leaked processes from older builds stay until manually killed; U1
  includes the one-time cleanup (`Get-CimInstance ... state-coordinator` filtered
  to `%TEMP%\agentview-*`, plus the temp dirs). The new suite gate prevents new
  ones.
- `npm run verify` (typecheck + perf gate + tests + coverage + pack:dry) stays
  the completion gate; `npm test` now also covers the residue assertion.

## 9. Open questions for the design gate

1. Approve 3.1 + 3.2 + 3.3 (+ tests), i.e. the issue's preferred "1 + 3" with
   the cwd correction, with idle timeout kept out of scope?
2. Is the 1 s root check / <=1 s detection latency acceptable in production, or
   should the cadence be a separate (slower) knob?
3. Is the fail-open behavior when process enumeration is unavailable acceptable
   (warn + skip), or should it fail the run?
