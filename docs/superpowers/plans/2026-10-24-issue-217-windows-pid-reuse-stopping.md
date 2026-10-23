# Issue #217 — Precise Host Identity Corroboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On platforms where `captureStartToken()` is `null` (Windows, macOS), refine an `unknown` host-role observation with deterministic evidence — role-specific command-line match, falling back to process creation time vs `*SpawnedAt` — so a reused pid no longer strands a `stopping` host, and `recovery_pending` is never silent.

**Architecture:** The decision is a pure function in `src/core/host-coordination.mjs`. A new I/O shell `src/core/process-identity-probe.mjs` runs one async `execFile` per pid (Windows CIM JSON, macOS `ps`) behind injectable seams. `service.mjs` keeps all wiring: `observeHostRole` becomes async, receives `{ sessionFile, memo }`, and only probes when the fast token path returns `unknown`. Diagnostics use a new `appendDiagnosticOnce`.

**Tech Stack:** Node ESM `.mjs`, `node:test` + `assert/strict`, `node:child_process.execFile` (async, `windowsHide: true`), PowerShell `Get-CimInstance Win32_Process`, POSIX `ps -p <pid> -o etime=,command=`.

**Spec:** `docs/superpowers/specs/2026-10-24-issue-217-windows-pid-reuse-stopping-design.md`

**Worktree:** `C:/Users/27499/proj/opensource/pi-agent-board/.pi/worktrees/issue-217-windows-pid-reuse-stopping` — every path below is relative to it; never edit the main checkout.

## Global Constraints

- Tabs for indentation; English comments; conventional commit subjects (`(#217)` lands on the PR, not on local commits).
- `host-coordination.mjs` stays pure: no fs/net/process I/O, no `resolveTestMs` import.
- `probe == null` MUST return `unknown` — never `foreign`. This is the #70 contract.
- Role-specific fragment: child → `meta.sessionFile`, runner → host `configPath`. Never use `sessionFile` for the runner.
- Do not change `processIdentityState`, `captureStartToken` (all copies), lock identity, or `serviceIdentity()`.
- `recoverHost(viewId, expectedInstanceId, sessionFile?)` — third parameter optional so existing two-arg calls keep working.
- Probe memo is created by the caller and shared across the loop and the final re-check; the resolver stopping branch creates its own local memo.
- Every spawn/exec uses `windowsHide: true` and a `timeout`.
- `git add <explicit files>` only.
- Gate: `npm run typecheck` + the listed test files; `npm run verify` if the local node-pty environment allows it (known Windows `AttachConsole failed` limitation).

## Review Focus

1. **Process dies between `isAlive` and the probe** — `probe == null` must stay `unknown` for that round; the next poll's `defaultObserveProcess` classifies `dead`. → A8 (Task 3).
2. **Path prefix trap** (`session.jsonl` inside `session-2.jsonl`, `view_abc` inside `view_abcd`) — matching must be boundary-aware, not a raw `includes`. → A1 (Task 1).
3. **Mixed slash/case/quoting in command lines** — Windows paths arrive as `C:\…` inside `"…"`; comparison normalizes slashes and case. → A1 (Task 1).
4. **Command line unreadable (permission / system process)** — fall back to the creation-time window; a missing `spawnedAt` yields `unknown`. → A2 (Task 1).
5. **Clock step between spawn and recovery** — creation-time fallback uses a 5 s tolerance and only applies when the command-line signal is unavailable. → A2/A15 (Task 1).

---

### Task 1: Pure decision functions + tolerance knob

**Files:**
- Modify: `src/core/host-coordination.mjs` (append after `processIdentityState`)
- Modify: `src/runtime/service.mjs` (add the constant + reader next to `resolveHostRecoveryPollMs` at :90)
- Test: `test/host-coordination.test.mjs`, `test/test-knobs.test.mjs`

**Interfaces:**
- Produces:
  - `export function commandLineMentions(commandLine: string, fragment: string): boolean`
  - `export function classifyUnverifiableProcess({ spawnedAt, probe, expectedCommandFragment, toleranceMs }): "owned" | "foreign" | "unknown"`
  - `export const HOST_IDENTITY_CREATION_TOLERANCE_MS = 5_000` (in `service.mjs`)
  - `export function resolveIdentityCreationToleranceMs(env = process.env): number` (in `service.mjs`)
- `probe` shape: `{ creationTimeMs: number|null, commandLine: string|null } | null`.

- [ ] **Step 1: Write the failing truth-table tests**

In `test/host-coordination.test.mjs`, add:

```js
test("commandLineMentions normalizes slashes/case and respects path boundaries", () => {
	assert.equal(commandLineMentions('node C:\\x\\cli.js --session "C:\\a b\\s.jsonl"', "C:/a b/s.jsonl"), true);
	assert.equal(commandLineMentions("NODE --session c:\\A\\S.JSONL", "C:\\a\\s.jsonl"), true);
	// prefix trap: view_abc must not match view_abcd
	assert.equal(commandLineMentions("node x --session C:\\v\\view_abcd.jsonl", "C:\\v\\view_abc.jsonl"), false);
	assert.equal(commandLineMentions("node x --session C:\\v\\session-2.jsonl", "C:\\v\\session.jsonl"), false);
	assert.equal(commandLineMentions("", "C:\\v\\s.jsonl"), false);
});

test("classifyUnverifiableProcess truth table", () => {
	const probe = (creationTimeMs, commandLine) => ({ creationTimeMs, commandLine });
	const base = { spawnedAt: 1_000_000, expectedCommandFragment: "C:\\v\\s.jsonl", toleranceMs: 5_000 };
	assert.equal(classifyUnverifiableProcess({ ...base, probe: null }), "unknown");
	assert.equal(classifyUnverifiableProcess({ ...base, probe: probe(9_999_999, "node --session C:\\v\\s.jsonl") }), "owned");
	assert.equal(classifyUnverifiableProcess({ ...base, probe: probe(9_999_999, "node other.js") }), "foreign");
	assert.equal(classifyUnverifiableProcess({ ...base, probe: probe(1_002_000, null) }), "owned");
	assert.equal(classifyUnverifiableProcess({ ...base, probe: probe(900_000, null) }), "foreign");
	assert.equal(classifyUnverifiableProcess({ ...base, probe: probe(1_020_000, null) }), "foreign");
	// command line wins over a null spawnedAt
	assert.equal(classifyUnverifiableProcess({ ...base, spawnedAt: null, probe: probe(5, "node --session C:\\v\\s.jsonl") }), "owned");
	// no signal at all
	assert.equal(classifyUnverifiableProcess({ ...base, spawnedAt: null, probe: probe(1_000_000, null) }), "unknown");
	assert.equal(classifyUnverifiableProcess({ ...base, expectedCommandFragment: null, probe: probe(1_000_000, "node x") }), "owned");
});
```

In `test/test-knobs.test.mjs`, extend both reader tests:

```js
assert.equal(HOST_IDENTITY_CREATION_TOLERANCE_MS, 5_000);
assert.equal(resolveIdentityCreationToleranceMs({}), 5_000);
assert.equal(resolveIdentityCreationToleranceMs({ AGENT_BOARD_TEST_IDENTITY_CREATION_TOLERANCE_MS: "25" }), 25);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/host-coordination.test.mjs test/test-knobs.test.mjs`
Expected: FAIL — `commandLineMentions is not a function` / import error for the new reader.

- [ ] **Step 3: Implement the pure functions**

`host-coordination.mjs`: `commandLineMentions` normalizes `\`→`/` and lowercases both sides, then scans every occurrence and accepts only when both neighbours are start/end or whitespace/quote (boundary-aware). `classifyUnverifiableProcess` follows the spec D1 pseudo-code exactly: `probe == null → unknown`; command line + fragment → `owned`/`foreign`; else creation window `|creation - spawnedAt| <= tolerance → owned`, otherwise `foreign`; missing `spawnedAt`/`creation` → `unknown`.

`service.mjs`: add the constant and reader (uses `resolveTestMs`) beside the existing readers.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/host-coordination.test.mjs test/test-knobs.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/host-coordination.mjs src/runtime/service.mjs test/host-coordination.test.mjs test/test-knobs.test.mjs
git commit -m "feat(core): add identity corroboration pure functions and tolerance knob (issue #217)"
```

**Acceptance:** A1, A2, A15.

---

### Task 2: Process identity probe module

**Files:**
- Create: `src/core/process-identity-probe.mjs`
- Create: `test/process-identity-probe.test.mjs`

**Interfaces:**
- Produces:
  - `export const PROBE_TIMEOUT_MS = 3_000`
  - `export function parseUnixMillis(text: string): number|null`
  - `export function parseProbeJson(text: string): {creationTimeMs:number|null, commandLine:string|null}|null`
  - `export function parsePsElapsedMs(text: string): number|null`
  - `export function parsePsProbeLine(text: string, nowMs: number): {creationTimeMs:number|null, commandLine:string|null}|null`
  - `export function resolveProbeCommand(platform: string, pid: number): {command:string, args:string[]}|null`
  - `export async function readProcessIdentityProbe(pid, { platform = process.platform, execFileFn = execFile, timeoutMs = PROBE_TIMEOUT_MS, nowMs = Date.now } = {}): Promise<{creationTimeMs:number|null, commandLine:string|null}|null>`
- Consumes nothing from Task 1.

- [ ] **Step 1: Write the failing parser/command tests**

In `test/process-identity-probe.test.mjs`:

```js
test("parseUnixMillis accepts positive integers only", () => {
	assert.equal(parseUnixMillis("1792718500139"), 1_792_718_500_139);
	assert.equal(parseUnixMillis(""), null);
	assert.equal(parseUnixMillis("abc"), null);
	assert.equal(parseUnixMillis("-5"), null);
});

test("parseProbeJson parses the CIM object and rejects junk", () => {
	assert.deepEqual(parseProbeJson('{"creation":1792718500139,"cmd":"node x"}'),
		{ creationTimeMs: 1_792_718_500_139, commandLine: "node x" });
	assert.deepEqual(parseProbeJson('{"creation":null,"cmd":null}'), { creationTimeMs: null, commandLine: null });
	assert.equal(parseProbeJson("not json"), null);
});

test("parsePsElapsedMs handles every etime shape", () => {
	assert.equal(parsePsElapsedMs("05:03"), 303_000);
	assert.equal(parsePsElapsedMs("01:02:03"), 3_723_000);
	assert.equal(parsePsElapsedMs("2-01:02:03"), 176_523_000);
	assert.equal(parsePsElapsedMs("nope"), null);
});

test("parsePsProbeLine splits elapsed from the command", () => {
	assert.deepEqual(parsePsProbeLine("05:03 node /x --session y z", 1_000_000),
		{ creationTimeMs: 697_000, commandLine: "node /x --session y z" });
});

test("resolveProbeCommand is platform- and pid-aware", () => {
	assert.match(resolveProbeCommand("win32", 123).args.at(-1), /ProcessId=123/);
	assert.deepEqual(resolveProbeCommand("darwin", 123), { command: "ps", args: ["-p", "123", "-o", "etime=,command="] });
	assert.equal(resolveProbeCommand("linux", 123), null);
	assert.equal(resolveProbeCommand("win32", 0), null);
	assert.equal(resolveProbeCommand("win32", 1.5), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/process-identity-probe.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parsers and command resolver**

Windows command: `powershell.exe -NoProfile -NonInteractive -Command "$p = Get-CimInstance Win32_Process -Filter \"ProcessId=<pid>\" -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{creation=[long]([datetimeoffset]$p.CreationDate).ToUnixTimeMilliseconds(); cmd=$p.CommandLine} | ConvertTo-Json -Compress }"`. macOS: `ps -p <pid> -o etime=,command=`. Other platforms: `null`.

- [ ] **Step 4: Write the failing execution-layer tests**

```js
test("readProcessIdentityProbe parses stdout and honors exec options", async () => {
	const calls = [];
	const execFileFn = (cmd, args, opts, cb) => {
		calls.push({ cmd, args, opts });
		cb(null, '{"creation":1792718500139,"cmd":"node x --session y"}\n', "");
	};
	const probe = await readProcessIdentityProbe(123, { platform: "win32", execFileFn });
	assert.deepEqual(probe, { creationTimeMs: 1_792_718_500_139, commandLine: "node x --session y" });
	assert.equal(calls[0].opts.windowsHide, true);
	assert.equal(calls[0].opts.timeout, 3_000);
});

test("readProcessIdentityProbe returns null on failure/empty output", async () => { /* non-zero exit, timeout, empty stdout → null */ });
```

- [ ] **Step 5: Run to verify they fail, then implement the I/O shell**

Run: `node --test test/process-identity-probe.test.mjs` → FAIL.
Implement `readProcessIdentityProbe` with `execFile(command, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 }, cb)` wrapped in a promise; non-zero exit / error / empty trimmed stdout → `null`.

- [ ] **Step 6: Run to verify they pass + commit**

Run: `node --test test/process-identity-probe.test.mjs` → PASS.

```bash
git add src/core/process-identity-probe.mjs test/process-identity-probe.test.mjs
git commit -m "feat(core): add cross-platform process identity probe (issue #217)"
```

**Acceptance:** A3, A4, A5.

---

### Task 3: Wire the probe into recovery

**Files:**
- Modify: `src/runtime/service.mjs` (`createService` opts at :100-160; `observeHostRole` :961; `recoverHost` :982-1050; resolver stopping branch :1304-1318; final re-check :1046)
- Test: `test/host-recovery.test.mjs`, `test/host-resolver.test.mjs`

**Interfaces:**
- Consumes: `classifyUnverifiableProcess`, `resolveIdentityCreationToleranceMs` (Task 1); `readProcessIdentityProbe` (Task 2).
- Produces: `createService({ probeProcessIdentity })` injection point; `observeHostRole(host, role, { sessionFile, memo })` async.

- [ ] **Step 1: Update existing unknown→pending tests to inject a null probe**

In `test/host-recovery.test.mjs:179` and `test/host-resolver.test.mjs:350`, add `probeProcessIdentity: async () => null` to the `service(...)` overrides. Run both files; the existing assertions must still pass (they will fail after Step 3 without this).

- [ ] **Step 2: Write the failing recovery tests**

Add to `test/host-recovery.test.mjs`:

```js
test("recoverHost releases an unverifiable reused pid when the command line is foreign", async () => {
	// host record: stopping, runnerIdentity/childIdentity startToken null, runnerSpawnedAt/childSpawnedAt set
	// observeProcess: () => "unknown"; probeProcessIdentity: async () => ({ creationTimeMs: 9, commandLine: "node other.js" })
	// expect: res.ok === true, res.recovered === true, signals.length === 0, new instance claimed
});

test("recoverHost signals an unverifiable owned pid when the command line matches", async () => {
	// same record, probe commandLine includes the view's sessionFile
	// expect: exactly one SIGTERM to the owned identity, replacement claimed
});

test("recoverHost probes at most twice per call (shared memo)", async () => {
	// probeProcessIdentity counts calls; runner+child both unknown
	// expect probeCalls <= 2
});
```

Add to `test/host-resolver.test.mjs`:

```js
test("resolver advances a stranded stopping host when the child command line is foreign (issue #217)", async () => {
	// stopping host, staleStop true, observeProcess unknown, probe foreign, probeHost scripted ["missing","ready"]
	// expect result.kind === "pty" (no recovery_pending)
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/host-recovery.test.mjs test/host-resolver.test.mjs`
Expected: FAIL — the foreign cases still return `recovery_pending`; memo count unbounded.

- [ ] **Step 4: Implement the wiring**

Follow spec D3 exactly:
- `const probeProcessIdentityImpl = opts.probeProcessIdentity ?? readProcessIdentityProbe;`
- `async function observeHostRole(host, role, { sessionFile, memo })` — fast path unchanged; on `unknown` with a pid, `memo.set(pid, await probeProcessIdentityImpl(pid))` once, then `classifyUnverifiableProcess({ spawnedAt, probe, expectedCommandFragment: role === "child" ? sessionFile : host?.configPath ?? null, toleranceMs: resolveIdentityCreationToleranceMs() })`.
- `recoverHost(viewId, expectedInstanceId, sessionFile = loadRow(root, viewId)?.meta.sessionFile ?? null)` creates `const probeMemo = new Map()` and awaits every `observeHostRole(..., { sessionFile, memo: probeMemo })` (loop + final re-check).
- Resolver stopping branch creates its own local memo and passes its existing `sessionFile`; the resolver's `recoverHost` calls also pass `sessionFile`.

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/host-recovery.test.mjs test/host-resolver.test.mjs`
Expected: PASS (including the pre-existing unknown→pending assertions).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/service.mjs test/host-recovery.test.mjs test/host-resolver.test.mjs
git commit -m "fix(host): corroborate unverifiable process identity before stranding recovery (issue #217)"
```

**Acceptance:** A6, A7, A8, A9, A11, A13.

---

### Task 4: Recovery-pending diagnostics

**Files:**
- Modify: `src/core/diagnostics.mjs` (add `appendDiagnosticOnce`)
- Modify: `src/runtime/service.mjs` (`:1018`, `:1047`, `:1308`)
- Test: `test/diagnostics.test.mjs`, `test/host-recovery.test.mjs`

**Interfaces:**
- Produces: `export function appendDiagnosticOnce(root, viewId, patch, opts = {}): DiagnosticEvent|null` — `opts.match` (array of `details` keys, default `[]`), `opts.limit` (default 20); returns `null` when a matching recent event exists.

- [ ] **Step 1: Write the failing unit test**

```js
test("appendDiagnosticOnce writes once per match key", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-diag-"));
	createView(root, { id: "v1", name: "a", cwd: "/r" });
	const patch = { source: "service", level: "warn", code: "host_recovery_pending", details: { instanceId: "i1", role: "child" } };
	assert.ok(appendDiagnosticOnce(root, "v1", patch, { match: ["instanceId", "role"] }));
	assert.equal(appendDiagnosticOnce(root, "v1", patch, { match: ["instanceId", "role"] }), null);
	assert.ok(appendDiagnosticOnce(root, "v1", { ...patch, details: { instanceId: "i2", role: "child" } }, { match: ["instanceId", "role"] }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/diagnostics.test.mjs` → FAIL (no export).

- [ ] **Step 3: Implement and wire**

`appendDiagnosticOnce` reads the tail (default 20) via `readJsonlTail` + `normalizeDiagnostic`, returns `null` on a same-code same-key match, otherwise appends. In `service.mjs`, before the three producing returns, call it with `code: "host_recovery_pending"`, `details: { instanceId, role, observation, probe: probe ? "available" : "unavailable", path: "recover" }` (or `"attach"` at :1308), `{ match: ["instanceId", "role"] }`. Do not add it to the two relay returns (:1315, :1383).

- [ ] **Step 4: Write the failing integration assertion**

In `test/host-recovery.test.mjs`, extend the unknown→pending test: assert `readDiagnostics(root, "v1").some((e) => e.code === "host_recovery_pending")`, then call `recoverHost` again and assert the count did not grow.

- [ ] **Step 5: Run to verify they pass + commit**

Run: `node --test test/diagnostics.test.mjs test/host-recovery.test.mjs` → PASS.

```bash
git add src/core/diagnostics.mjs src/runtime/service.mjs test/diagnostics.test.mjs test/host-recovery.test.mjs
git commit -m "feat(diagnostics): record host recovery pending with dedupe (issue #217)"
```

**Acceptance:** A10.

---

### Task 5: Verification and manual-verification record

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck` → 0 errors.

- [ ] **Step 2: Run the targeted suites**

Run: `node --test test/host-recovery.test.mjs test/host-resolver.test.mjs test/host-coordination.test.mjs test/process-identity-probe.test.mjs test/diagnostics.test.mjs test/test-knobs.test.mjs` → all pass.

- [ ] **Step 3: Attempt the full gate and record the environment verdict**

Run: `npm run verify`. If it fails only on the known Windows `AttachConsole failed` / node-pty paths (JFox `202609051440498495`), record the failing files and the reason in the PR body; otherwise fix.

- [ ] **Step 4: Record U1/U2 status honestly**

Write the U1/U2 results (or `pending` with the exact blocker) into the PR body. Do not claim manual verification without observed evidence.

- [ ] **Step 5: Commit any verification-only documentation, if needed**

`git add <explicit files> && git commit -m "test: record issue #217 verification results"` only if a file changed.

**Acceptance:** A12, A14, U1, U2.
