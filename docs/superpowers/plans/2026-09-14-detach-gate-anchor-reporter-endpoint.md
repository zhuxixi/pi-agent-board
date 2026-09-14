# Issue #103 Detach Gate Anchor + Editor Reporter Endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `←` from being swallowed by chat-area inverse content in the attach detach gate, and restore the child's authoritative editor-state channel that has been dead since issue #70.

**Architecture:** Two independent fixes that reinforce each other. (B) The host runner injects its own bound control endpoint into the child Pi environment (`AGENT_BOARD_CONTROL_SOCKET`); the child extension resolves it with a pure function (legacy fallback unchanged), and the reporter identifies itself with a hello so the runner can exclude its permanent connection from the `attachedClients` count that gates warm-host reclamation. (A) The detach gate's tier-1 inverse anchor only accepts a line that actually looks like Pi's editor line, so a chat diff row or notification bar can no longer veto a detach.

**Tech Stack:** Node 24 (ESM, `.mjs` core + TypeScript UI/harness run with `--experimental-transform-types`), `node:test` + `node:assert/strict`, `@xterm/headless`, `node-pty`.

**Spec:** `docs/superpowers/specs/2026-09-14-detach-gate-anchor-reporter-endpoint-design.md`

## Global Constraints

- Work only inside the worktree: `WT=/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-103-detach-anchor-reporter-endpoint`. Every edit/command uses `$WT` absolute paths; never edit the main checkout.
- All code comments, JSDoc and commit messages in English. Conventional Commits format.
- Stage files by explicit path (`git add <file> ...`); never `git add -A`.
- No new runtime or dev dependencies.
- Platform rules: socket paths come from `paths.mjs`. Windows endpoints are named pipes — never gate on `existsSync(socketPath)`. Always pass `platform` explicitly to the path helpers in tests.
- Legacy compatibility is a hard requirement: when `AGENT_BOARD_CONTROL_SOCKET` is absent (old runner, or a child spawned before this change) the reporter must keep connecting to `controlSocketPathFor()` exactly as today, and a config without `instanceId` must keep running through `legacyMain()`.
- The detach gate's overarching rule (issues #48/#69/#72) is unchanged: when the buffer cannot prove the editor is empty, `←` must still escape rather than trap the user. Only certain evidence may gate.
- `attachedClients` is load-bearing (warm-host reclamation `src/core/warm-host-sweeper.mjs:53`, revoke guard `src/runtime/service.mjs:807`): the reporter's connection must never raise it.

---

## File Structure

**Create**
- `src/core/host-child-env.mjs` — one pure builder for the hosted child's environment; both runner mains use it (removes the duplicated literal).
- `src/core/control-clients.mjs` — client-id constants + `classifyClientHello()`; the reporter and the runner share the identification contract.
- `test/host-child-env.test.mjs`, `test/control-clients.test.mjs` — unit tests for the two new pure modules.

**Modify**
- `src/core/paths.mjs` — add `resolveControlEndpointFor()` (pure; env value wins, legacy path otherwise).
- `src/core/pty-input.mjs` — add `isEditorAnchorLine()` (pure anchor guard).
- `src/core/editor-state-reporter.mjs` — send the identification hello on connect.
- `src/index.ts` — build the reporter's `connect` from `resolveControlEndpointFor()`.
- `runner/pty-runner.mjs` — build child env with `hostChildEnv()`; classify reporter connections and keep them out of `attachedClients`.
- `src/ui/pty-attach.ts` — tier-1 scans candidates through `isEditorAnchorLine()`; drop `findLastInverseCellLine()`.
- `test-support/fake-pty-pi.mjs` — optional env capture (`FAKE_PTY_ENV_CAPTURE_PATH`).
- `test-support/detach-gate-smoke.ts` — scenarios O1–O3.
- `test/pty-input.test.mjs`, `test/socket-path.test.mjs`, `test/editor-state-reporter.test.mjs`, `test/pty-runner.integration.test.mjs`, `test/pty-attach-detach-gate.test.mjs` — assertions.

---

## Task 1: Control endpoint resolver (`resolveControlEndpointFor`)

**Files:**
- Modify: `src/core/paths.mjs` (add after `controlSocketPath`, ~line 73)
- Test: `test/socket-path.test.mjs`

**Interfaces:**
- Consumes: existing `controlSocketPathFor(platform, root, viewId)`.
- Produces: `resolveControlEndpointFor({ envSocketPath, platform, root, viewId }) → string`.

- [ ] **Step 1: Write the failing test**

Append to `test/socket-path.test.mjs` and add `resolveControlEndpointFor` to the existing import list on line 4:

```js
test("resolveControlEndpointFor prefers the runner-provided endpoint and falls back to the legacy view socket", () => {
	const injected = "/run/agent-board/views/view_1/control.abc.sock";
	assert.equal(
		resolveControlEndpointFor({ envSocketPath: injected, platform: "linux", root: "/tmp/root", viewId: "view_1" }),
		injected,
		"the runner's own bound endpoint wins",
	);
	assert.equal(
		resolveControlEndpointFor({ envSocketPath: "", platform: "linux", root: "/tmp/root", viewId: "view_1" }),
		controlSocketPathFor("linux", "/tmp/root", "view_1"),
		"empty env falls back to the legacy per-view socket",
	);
	assert.equal(
		resolveControlEndpointFor({ envSocketPath: undefined, platform: "darwin", root: "/tmp/root", viewId: "view_1" }),
		controlSocketPathFor("darwin", "/tmp/root", "view_1"),
		"missing env falls back to the legacy per-view socket",
	);
	const pipe = "\\\\.\\pipe\\pi-agent-board-view_1-0123abcd";
	assert.equal(
		resolveControlEndpointFor({ envSocketPath: pipe, platform: "win32", root: "C:\\root", viewId: "view_1" }),
		pipe,
		"windows named pipes pass through unchanged",
	);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd $WT && node --test test/socket-path.test.mjs`
Expected: FAIL — `resolveControlEndpointFor is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/core/paths.mjs`, directly below `controlSocketPath`:

```js
/**
 * Control endpoint a hosted child's editor-state reporter must connect to
 * (issue #103). The host runner exports its own bound endpoint through
 * `AGENT_BOARD_CONTROL_SOCKET`, so the reporter never has to guess the
 * per-instance name (issue #70 made it `control.<instanceId>.sock`). Without
 * the variable — a legacy runner, or a child spawned before the export existed
 * — fall back to the historical per-view socket.
 * @param {{ envSocketPath?: string|undefined, platform: "win32"|"linux"|"darwin", root: string, viewId: string }} opts
 */
export function resolveControlEndpointFor({ envSocketPath, platform, root, viewId }) {
	if (typeof envSocketPath === "string" && envSocketPath.length > 0) return envSocketPath;
	return controlSocketPathFor(platform, root, viewId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd $WT && node --test test/socket-path.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd $WT && git add src/core/paths.mjs test/socket-path.test.mjs
git commit -m "feat(paths): add resolveControlEndpointFor for hosted child reporters (issue #103)"
```

---

## Task 2: Hosted child environment builder (`hostChildEnv`)

**Files:**
- Create: `src/core/host-child-env.mjs`
- Test: `test/host-child-env.test.mjs`

**Interfaces:**
- Produces: `hostChildEnv({ root, viewId, socketPath, baseEnv, extraEnv }) → Record<string, string|undefined>`.
- Consumed by: Task 3 (runner wiring) in both `legacyMain()` and `ownedMain()`.

- [ ] **Step 1: Write the failing test**

Create `test/host-child-env.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostChildEnv } from "../src/core/host-child-env.mjs";

test("hostChildEnv exports the hosted-child markers and the bound control endpoint", () => {
	const env = hostChildEnv({
		root: "/tmp/root",
		viewId: "view_1",
		socketPath: "/tmp/root/views/view_1/control.i1.sock",
		baseEnv: { PATH: "/usr/bin", AGENT_BOARD_ROOT: "/stale" },
		extraEnv: { CUSTOM: "1" },
	});
	assert.equal(env.PATH, "/usr/bin", "ambient environment is preserved");
	assert.equal(env.CUSTOM, "1", "per-launch env is preserved");
	assert.equal(env.AGENT_BOARD_ROOT, "/tmp/root", "fixed keys override a stale ambient value");
	assert.equal(env.AGENT_BOARD_VIEW_ID, "view_1");
	assert.equal(env.AGENT_BOARD_CHILD, "1");
	assert.equal(env.AGENT_BOARD_HOSTED, "pty");
	assert.equal(env.AGENT_BOARD_CONTROL_SOCKET, "/tmp/root/views/view_1/control.i1.sock");
	// Legacy aliases stay exported for older child extension builds.
	assert.equal(env.AGENT_VIEW_ROOT, "/tmp/root");
	assert.equal(env.AGENT_VIEW_VIEW_ID, "view_1");
	assert.equal(env.AGENT_VIEW_CHILD, "1");
	assert.equal(env.AGENT_VIEW_HOSTED, "pty");
});

test("hostChildEnv defaults baseEnv and extraEnv to empty objects", () => {
	const env = hostChildEnv({ root: "/r", viewId: "v", socketPath: "/r/v/control.sock" });
	assert.equal(env.AGENT_BOARD_CONTROL_SOCKET, "/r/v/control.sock");
	assert.equal(env.AGENT_VIEW_CHILD, "1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd $WT && node --test test/host-child-env.test.mjs`
Expected: FAIL — cannot find module `../src/core/host-child-env.mjs`.

- [ ] **Step 3: Write the implementation**

Create `src/core/host-child-env.mjs`:

```js
/**
 * Environment for a hosted Pi child process.
 *
 * Both runner paths (legacy and the issue-#70 owned protocol) spawn the same
 * child, so the variable set lives here instead of being duplicated: a single
 * place to add or rename a key, and a pure function that can be unit-tested
 * without spawning anything. `socketPath` is the endpoint THIS host instance
 * bound; exporting it is what lets the child's editor-state reporter reach the
 * live host instead of the pre-#70 per-view path (issue #103).
 *
 * @param {{
 *   root: string,
 *   viewId: string,
 *   socketPath: string,
 *   baseEnv?: Record<string, string|undefined>,
 *   extraEnv?: Record<string, string> | undefined,
 * }} opts
 */
export function hostChildEnv({ root, viewId, socketPath, baseEnv = {}, extraEnv = {} }) {
	return {
		...baseEnv,
		...extraEnv,
		AGENT_BOARD_ROOT: root,
		AGENT_BOARD_VIEW_ID: viewId,
		AGENT_BOARD_CHILD: "1",
		AGENT_BOARD_HOSTED: "pty",
		AGENT_BOARD_CONTROL_SOCKET: socketPath,
		// Legacy names are exported too so older child extension builds still behave.
		AGENT_VIEW_ROOT: root,
		AGENT_VIEW_VIEW_ID: viewId,
		AGENT_VIEW_CHILD: "1",
		AGENT_VIEW_HOSTED: "pty",
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd $WT && node --test test/host-child-env.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd $WT && git add src/core/host-child-env.mjs test/host-child-env.test.mjs
git commit -m "feat(core): add hostChildEnv builder that exports the bound control endpoint (issue #103)"
```

---

## Task 3: Runner wiring — child env via `hostChildEnv` (both paths)

**Files:**
- Modify: `runner/pty-runner.mjs` (legacy env literal ~line 220, owned env literal ~line 739)
- Modify: `test-support/fake-pty-pi.mjs`
- Test: `test/pty-runner.integration.test.mjs`

**Interfaces:**
- Consumes: `hostChildEnv` from Task 2.
- Produces: every hosted child process sees `AGENT_BOARD_CONTROL_SOCKET` equal to its own host's bound endpoint (legacy: `control.sock`; owned: `control.<instanceId>.sock`).

- [ ] **Step 1: Add env capture to the fake child**

In `test-support/fake-pty-pi.mjs`, after the existing `FAKE_PTY_ARGV_CAPTURE_PATH` block, add:

```js
if (process.env.FAKE_PTY_ENV_CAPTURE_PATH) {
	try {
		appendFileSync(process.env.FAKE_PTY_ENV_CAPTURE_PATH, `${process.env.AGENT_BOARD_CONTROL_SOCKET ?? ""}\n`);
	} catch {}
}
```

- [ ] **Step 2: Write the failing integration test**

Append to `test/pty-runner.integration.test.mjs`:

```js
test("hosted child receives this host instance's control endpoint in its environment (issue #103)", async () => {
	const root = freshRoot();
	let runner;
	let childPid;
	try {
		const capturePath = join(root, "child-env.txt");
		// launchOwnedRunner spreads opts.config last, so the whole env object is replaced here.
		const { runner: r, socketPath } = await launchOwnedRunner(root, "v1", "i103", {
			config: { env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_ENV_CAPTURE_PATH: capturePath } },
		});
		runner = r;
		const host = await waitFor(() => {
			const h = readHost(root, "v1");
			return h?.state === "alive" && h?.childPid ? h : false;
		});
		childPid = host.childPid;
		await waitFor(() => (existsSync(capturePath) ? readFileSync(capturePath, "utf8").trim() : false));
		assert.equal(readFileSync(capturePath, "utf8").trim(), socketPath, "owned child sees the per-instance endpoint");
		const socket = createConnection(socketPath);
		socket.on("error", () => {});
		await once(socket, "connect");
		send(socket, { type: "input", data: "exit\r" });
		await waitForExit(runner, 5000);
		socket.destroy();
	} finally {
		try { runner?.kill("SIGKILL"); } catch {}
		if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("legacy child receives the legacy view socket as its control endpoint (issue #103)", async () => {
	const root = freshRoot();
	let runner;
	try {
		const meta = createView(root, { id: "v1", name: "legacy-env", cwd: process.cwd() });
		const capturePath = join(root, "legacy-child-env.txt");
		const configPath = P.hostConfigPath(root, "v1");
		atomicWriteJson(configPath, {
			root,
			viewId: "v1",
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
			model: null,
			tools: null,
			env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_ENV_CAPTURE_PATH: capturePath },
			cols: 80,
			rows: 24,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		await waitFor(() => hostReady(root, "v1"));
		const expected = P.controlSocketPath(root, "v1");
		await waitFor(() => (existsSync(capturePath) ? readFileSync(capturePath, "utf8").trim() : false));
		assert.equal(readFileSync(capturePath, "utf8").trim(), expected, "legacy child sees the legacy view socket");
		const socket = createConnection(expected);
		socket.on("error", () => {});
		await once(socket, "connect");
		send(socket, { type: "input", data: "exit\r" });
		await waitForExit(runner, 5000);
		socket.destroy();
	} finally {
		try { runner?.kill("SIGKILL"); } catch {}
		reapChild(root, "v1");
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd $WT && node --test test/pty-runner.integration.test.mjs`
Expected: the two new tests FAIL (captured value is `""` — the variable does not exist yet); every pre-existing test still passes.

- [ ] **Step 4: Replace both env literals**

In `runner/pty-runner.mjs`, add to the import list (alphabetical, near the other `src/core` imports):

```js
import { hostChildEnv } from "../src/core/host-child-env.mjs";
```

In `legacyMain()`, replace

```js
	const env = {
		...process.env,
		...(config.env || {}),
		AGENT_BOARD_ROOT: config.root,
		AGENT_BOARD_VIEW_ID: config.viewId,
		AGENT_BOARD_CHILD: "1",
		AGENT_BOARD_HOSTED: "pty",
		// Legacy names are exported too so older child extension builds still behave.
		AGENT_VIEW_ROOT: config.root,
		AGENT_VIEW_VIEW_ID: config.viewId,
		AGENT_VIEW_CHILD: "1",
		AGENT_VIEW_HOSTED: "pty",
	};
```

with

```js
	const env = hostChildEnv({
		root: config.root,
		viewId: config.viewId,
		socketPath,
		baseEnv: process.env,
		extraEnv: config.env || {},
	});
```

In `ownedMain()`, replace the identical literal (it is preceded by the same `if (config.initialPrompt)` line but sits on one line less of blank space) with

```js
	const env = hostChildEnv({
		root: config.root,
		viewId: config.viewId,
		socketPath: config.socketPath,
		baseEnv: process.env,
		extraEnv: config.env || {},
	});
```

Both literals exist exactly once each; after editing, `rg -n "AGENT_BOARD_HOSTED" runner/pty-runner.mjs` must return no matches outside `src/core/host-child-env.mjs`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd $WT && node --test test/pty-runner.integration.test.mjs`
Expected: PASS — new tests plus all pre-existing runner tests.

- [ ] **Step 6: Commit**

```bash
cd $WT && git add runner/pty-runner.mjs test-support/fake-pty-pi.mjs test/pty-runner.integration.test.mjs
git commit -m "feat(runner): export the bound control endpoint to hosted children (issue #103)"
```

---

## Task 4: Client classification contract (`control-clients.mjs`)

**Files:**
- Create: `src/core/control-clients.mjs`
- Test: `test/control-clients.test.mjs`

**Interfaces:**
- Produces: `PROBE_CLIENT_ID`, `EDITOR_REPORTER_CLIENT_ID`, `classifyClientHello(msg) → "probe" | "reporter" | "client"`.
- Consumed by: Task 5 (reporter hello) and Task 6 (runner counting).

- [ ] **Step 1: Write the failing test**

Create `test/control-clients.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyClientHello, EDITOR_REPORTER_CLIENT_ID, PROBE_CLIENT_ID } from "../src/core/control-clients.mjs";

test("classifyClientHello separates probes, the editor reporter and real clients", () => {
	assert.equal(classifyClientHello({ type: "hello", clientId: PROBE_CLIENT_ID }), "probe");
	assert.equal(classifyClientHello({ type: "hello", clientId: EDITOR_REPORTER_CLIENT_ID }), "reporter");
	assert.equal(classifyClientHello({ type: "hello", clientId: "ui-test" }), "client");
	assert.equal(classifyClientHello({ type: "hello" }), "client", "hello without a clientId is a real client");
});

test("classifyClientHello treats non-hello and malformed frames as plain clients", () => {
	assert.equal(classifyClientHello({ type: "editor_state", empty: true }), "client");
	assert.equal(classifyClientHello(null), "client");
	assert.equal(classifyClientHello(undefined), "client");
});

test("client id constants are the protocol strings the runner and reporter share", () => {
	assert.equal(PROBE_CLIENT_ID, "probe");
	assert.equal(EDITOR_REPORTER_CLIENT_ID, "editor-reporter");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd $WT && node --test test/control-clients.test.mjs`
Expected: FAIL — cannot find module `../src/core/control-clients.mjs`.

- [ ] **Step 3: Write the implementation**

Create `src/core/control-clients.mjs`:

```js
/**
 * Control-socket client classification (issue #103).
 *
 * Three kinds of clients talk to a host runner: the attach UI, the read-only
 * liveness probes (issue #70 CR finding 3), and the hosted child's editor-state
 * reporter (issue #68). Only a real attach client may count as "attached":
 * `attachedClients` gates warm-host reclamation (issue #75,
 * warm-host-sweeper.mjs) and the revoke guard (service.mjs), and the reporter
 * holds a permanent connection for the whole life of the session.
 */

export const PROBE_CLIENT_ID = "probe";
export const EDITOR_REPORTER_CLIENT_ID = "editor-reporter";

/**
 * @param {{ type?: string, clientId?: unknown } | null | undefined} msg a decoded client frame
 * @returns {"probe" | "reporter" | "client"}
 */
export function classifyClientHello(msg) {
	if (!msg || msg.type !== "hello") return "client";
	if (msg.clientId === PROBE_CLIENT_ID) return "probe";
	if (msg.clientId === EDITOR_REPORTER_CLIENT_ID) return "reporter";
	return "client";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd $WT && node --test test/control-clients.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd $WT && git add src/core/control-clients.mjs test/control-clients.test.mjs
git commit -m "feat(core): add control-socket client classification (issue #103)"
```

---

## Task 5: Reporter identifies itself on connect

**Files:**
- Modify: `src/core/editor-state-reporter.mjs`
- Test: `test/editor-state-reporter.test.mjs`

**Interfaces:**
- Consumes: `EDITOR_REPORTER_CLIENT_ID` from Task 4.
- Produces: the first frame written on every (re)connect is `{"type":"hello","clientId":"editor-reporter"}`; `editor_state` frames follow on the existing cadence.

- [ ] **Step 1: Update the failing assertions first**

In `test/editor-state-reporter.test.mjs` add this test at the end of the file:

```js
test("reporter identifies itself before the first editor_state frame (issue #103)", () => {
	const sched = fakeScheduler();
	const socket = fakeSocket();
	const reporter = createEditorStateReporter({ getEditorText: () => "", connect: () => socket, scheduler: sched, intervalMs: 100 });
	reporter.start();
	socket.emitConnect();
	assert.deepEqual(socket.sent.map((l) => JSON.parse(l)), [{ type: "hello", clientId: "editor-reporter" }]);
	sched.fireOne(100);
	assert.deepEqual(socket.sent.map((l) => JSON.parse(l)), [
		{ type: "hello", clientId: "editor-reporter" },
		{ type: "editor_state", empty: true },
	]);
	reporter.stop();
});
```

Then adjust the pre-existing expectations that count frames — the hello is now frame 0 on every connect:

- `"reporter polls and sends only on text change (A1)"`: after `sched.fireOne(100)` assert `socket.sent.length === 2` and `assert.deepEqual(JSON.parse(socket.sent[1]), { type: "editor_state", empty: true })`; after `fireOne(200)` `socket.sent.length === 3` and `JSON.parse(socket.sent[2])` is `{ type: "editor_state", empty: false }`; after `fireOne(300)` still `3`; after `fireOne(400)` `4` and `JSON.parse(socket.sent[3])` is `{ type: "editor_state", empty: true }`.
- `"reporter stop is idempotent and ends polling (A1)"`: final `socket.sent.length === 2`.
- `"reporter retries connect with capped backoff then recovers (A2)"`: keep `socket.sent.length === 0` before connect; after `emitConnect` + `fireOne(...)` assert `socket.sent.length === 2` and `JSON.parse(socket.sent[1])` is `{ type: "editor_state", empty: true }`.
- `"reporter reconnects after socket close (A2)"`: `first.sent.length === 2` and `second.sent.length === 2`.
- `"reporter survives a throwing getEditorText (A1 hardening)"`: after the throwing poll `socket.sent.length === 1` (the hello only); after the next poll `socket.sent.length === 2` and `JSON.parse(socket.sent[1])` is `{ type: "editor_state", empty: false }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd $WT && node --test test/editor-state-reporter.test.mjs`
Expected: FAIL — the new test sees a single `editor_state` frame, and the adjusted counts are off by one.

- [ ] **Step 3: Write the implementation**

In `src/core/editor-state-reporter.mjs`, add the import at the top:

```js
import { EDITOR_REPORTER_CLIENT_ID } from "./control-clients.mjs";
```

and change the connect handler inside `tryConnect()` from

```js
		s?.on?.("connect", () => { if (socket === s) { backoffMs = 1000; startPolling(); } });
```

to

```js
		s?.on?.("connect", () => {
			if (socket !== s) return;
			backoffMs = 1000;
			// Identify before the first editor_state frame: the runner keeps reporter
			// connections out of its attached-client count, because that count gates
			// warm-host reclamation (issue #103).
			send({ type: "hello", clientId: EDITOR_REPORTER_CLIENT_ID });
			startPolling();
		});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd $WT && node --test test/editor-state-reporter.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd $WT && git add src/core/editor-state-reporter.mjs test/editor-state-reporter.test.mjs
git commit -m "feat(reporter): identify as editor-reporter before pushing editor state (issue #103)"
```

---

## Task 6: Runner keeps reporter connections out of `attachedClients`

**Files:**
- Modify: `runner/pty-runner.mjs` (client sets, `update()`/`ownedUpdate()`, connect/close/error handlers, hello branches)
- Test: `test/pty-runner.integration.test.mjs`

**Interfaces:**
- Consumes: `classifyClientHello`, `EDITOR_REPORTER_CLIENT_ID` from Task 4.
- Produces: `attachedClients` = `clients.size - reporters.size`; a reporter hello never flips `attachedEver`; probe and reporter connections leave `attachedClients` at 0.

- [ ] **Step 1: Write the failing integration test**

Append to `test/pty-runner.integration.test.mjs`:

```js
test("reporter connections never count as attached clients (issue #103)", async () => {
	const root = freshRoot();
	let runner;
	let childPid;
	try {
		const { runner: r, socketPath } = await launchOwnedRunner(root, "v1", "i103r");
		runner = r;
		const host = await waitFor(() => {
			const h = readHost(root, "v1");
			return h?.state === "alive" && h?.childPid ? h : false;
		});
		childPid = host.childPid;

		// The child's reporter: permanent connection, identification hello, then state.
		const reporter = createConnection(socketPath);
		reporter.on("error", () => {});
		await once(reporter, "connect");
		send(reporter, { type: "hello", clientId: "editor-reporter" });
		send(reporter, { type: "editor_state", empty: true });
		await waitFor(() => readHost(root, "v1")?.attachedClients === 0 && readHost(root, "v1")?.attachedEver !== true);
		const withReporter = readHost(root, "v1");
		assert.equal(withReporter.attachedClients, 0, "a reporter must never look like an attached client");
		assert.notEqual(withReporter.attachedEver, true, "a reporter must not mark the host attached");

		// The reporter's editor_state still reaches other clients through hello.
		const ui = createConnection(socketPath);
		ui.on("error", () => {});
		await once(ui, "connect");
		const uiMessages = [];
		let buf = "";
		ui.on("data", (chunk) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) uiMessages.push(JSON.parse(line));
		});
		send(ui, { type: "hello", clientId: "ui-test" });
		const seeded = await waitFor(() => uiMessages.find((m) => m.type === "hello" && "editorEmpty" in m), 2000);
		assert.equal(seeded.editorEmpty, true, "the reporter's state is the authoritative hello seed");
		await waitFor(() => readHost(root, "v1")?.attachedClients === 1);
		assert.equal(readHost(root, "v1").attachedEver, true, "a real UI client still records attachedEver");

		// Dropping the UI client and the reporter must both leave the count at 0.
		ui.destroy();
		await waitFor(() => readHost(root, "v1")?.attachedClients === 0);
		reporter.destroy();
		await waitFor(() => readHost(root, "v1")?.attachedClients === 0);
		assert.equal(readHost(root, "v1").attachedClients, 0);

		const exitClient = createConnection(socketPath);
		exitClient.on("error", () => {});
		await once(exitClient, "connect");
		send(exitClient, { type: "input", data: "exit\r" });
		await waitForExit(runner, 5000);
		exitClient.destroy();
	} finally {
		try { runner?.kill("SIGKILL"); } catch {}
		if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd $WT && node --test test/pty-runner.integration.test.mjs`
Expected: the new test FAILS at `attachedClients === 0` (the reporter connection is counted). Pre-existing tests still pass.

- [ ] **Step 3: Classify hellos and adjust the count (owned path)**

In `runner/pty-runner.mjs` add to the imports:

```js
import { classifyClientHello } from "../src/core/control-clients.mjs";
```

In `ownedMain()`, next to `const clients = new Set();` (line ~417) add:

```js
	/** Reporter sockets hold a permanent connection for the session's lifetime;
	 *  they are transport, not viewers, so they never count as attached. */
	const reporters = new Set();
	/** Viewers only — the reporter must not inflate this (issue #103): the count
	 *  gates warm-host reclamation (issue #75) and the revoke guard. */
	const attachedClientCount = () => Math.max(0, clients.size - reporters.size);
```

In `ownedUpdate()` replace `attachedClients: clients.size` with `attachedClients: attachedClientCount()`.

In the connection handler in `ownedMain()`, make both removals clear `reporters` as well:

```js
			socket.on("close", () => {
				clients.delete(socket);
				reporters.delete(socket);
				if (probeSockets.has(socket)) return;
				// Merge into the live record (a stale closure spread here erases a
				// concurrent revoke — final review finding 2).
				ownedUpdate((cur) => ({ ...cur }));
			});
			socket.on("error", () => {
				clients.delete(socket);
				reporters.delete(socket);
				if (probeSockets.has(socket)) return;
				ownedUpdate((cur) => ({ ...cur }));
			});
```

Replace the owned `case "hello":` body with:

```js
			case "hello": {
				// Probe handshakes (host-probe.mjs) are read-only: mark the socket so
				// close/error skip the merge write, and never flip attachedEver
				// (CR round-1 finding 3). The editor reporter is read-only too but
				// holds a permanent connection (issue #103), so it is also excluded
				// from attachedClients. Real clients record attachedEver here.
				const role = classifyClientHello(msg);
				if (role === "probe") {
					socket.markProbe?.();
				} else if (role === "reporter") {
					reporters.add(socket);
					ownedUpdate((cur) => ({ ...cur })); // recompute the count without this connection
				} else {
					ownedUpdate((cur) => ({ ...cur, attachedEver: true }));
				}
				send(socket, { type: "hello", status: host, editorEmpty });
				break;
			}
```

- [ ] **Step 4: Classify hellos and adjust the count (legacy path)**

In `legacyMain()`, next to `const clients = new Set();` (line ~121) add:

```js
	/** Reporter sockets are transport, not viewers (issue #103); see ownedMain. */
	const reporters = new Set();
	const attachedClientCount = () => Math.max(0, clients.size - reporters.size);
```

In `update()` replace `attachedClients: clients.size` with `attachedClients: attachedClientCount()`.

In the legacy `createServer` handler, drop the unconditional attach flag — it now belongs to the classified hello, matching the owned path:

```js
	server = createServer((socket) => {
		clients.add(socket);
		socket.write(JSON.stringify({ type: "hello", status: host, editorEmpty }) + "\n");
```

and clear `reporters` on teardown:

```js
		socket.on("close", () => {
			clients.delete(socket);
			reporters.delete(socket);
			update();
		});
		socket.on("error", () => {
			clients.delete(socket);
			reporters.delete(socket);
			update();
		});
```

Replace the legacy `case "hello":` with:

```js
			case "hello": {
				// Reporter connections are permanent and read-only; probes and reporters
				// must not flip attachedEver or raise attachedClients (issue #103).
				const role = classifyClientHello(msg);
				if (role === "reporter") reporters.add(socket);
				update(role === "client" ? { attachedEver: true } : {});
				send(socket, { type: "hello", status: host, editorEmpty });
				break;
			}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd $WT && node --test test/pty-runner.integration.test.mjs`
Expected: PASS — the new test plus every pre-existing runner test, including `"probe connections leave host.json untouched; real clients flip attachedEver (CR r1 f3)"`.

Also run the sweeper unit tests that consume the field:

Run: `cd $WT && node --test test/warm-host-sweeper.test.mjs test/service.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd $WT && git add runner/pty-runner.mjs test/pty-runner.integration.test.mjs
git commit -m "fix(runner): keep reporter connections out of attachedClients (issue #103)"
```

---

## Task 7: Child extension connects to the runner-provided endpoint

**Files:**
- Modify: `src/index.ts` (import line 12, reporter `connect` ~line 118)

**Interfaces:**
- Consumes: `resolveControlEndpointFor` from Task 1; `AGENT_BOARD_CONTROL_SOCKET` from Task 3.
- Produces: the hosted child's reporter connects to its own host's endpoint; the legacy path is used when the variable is absent.

- [ ] **Step 1: Make the wiring change**

Replace the import on line 12

```ts
import { controlSocketPathFor, defaultRoot } from "./core/paths.mjs";
```

with

```ts
import { defaultRoot, resolveControlEndpointFor } from "./core/paths.mjs";
```

and replace the reporter `connect` line inside `session_start`

```ts
				connect: () => createConnection(controlSocketPathFor(process.platform as "win32" | "linux" | "darwin", root, hostedViewId)),
```

with

```ts
				connect: () => createConnection(resolveControlEndpointFor({
					envSocketPath: process.env.AGENT_BOARD_CONTROL_SOCKET,
					platform: process.platform as "win32" | "linux" | "darwin",
					root,
					viewId: hostedViewId,
				})),
```

- [ ] **Step 2: Verify the change is coherent**

Run: `cd $WT && rg -n "controlSocketPathFor" src/index.ts && npm run typecheck`
Expected: the `rg` prints nothing (no stale import), `tsc --noEmit` exits 0.

- [ ] **Step 3: Run the reporter and path unit tests**

Run: `cd $WT && node --test test/editor-state-reporter.test.mjs test/socket-path.test.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd $WT && git add src/index.ts
git commit -m "fix(extension): connect the hosted child reporter to its host's bound endpoint (issue #103)"
```

---

## Task 8: Tier-1 anchor guard in the detach gate

**Files:**
- Modify: `src/core/pty-input.mjs` (add `isEditorAnchorLine`)
- Modify: `src/ui/pty-attach.ts` (`childInputLooksEmpty` ~line 371, remove `findLastInverseCellLine` ~line 356, import line 8)
- Test: `test/pty-input.test.mjs`, `test-support/detach-gate-smoke.ts`, `test/pty-attach-detach-gate.test.mjs`

**Interfaces:**
- Produces: `isEditorAnchorLine({ text, inverseCellCount }) → boolean`; `childInputLooksEmpty()` only trusts a scanned inverse line whose shape is editor-like, otherwise it keeps scanning up and falls through to the existing tier-2 glyph scan and the tier-3 escape.

- [ ] **Step 1: Write the failing pure-function test**

Append to `test/pty-input.test.mjs` (and add `isEditorAnchorLine` to the import on line 3):

```js
test("isEditorAnchorLine accepts only editor-shaped inverse lines (issue #103)", () => {
	// pi-tui renders an empty editor as one inverse caret cell on an otherwise blank line.
	assert.equal(isEditorAnchorLine({ text: "", inverseCellCount: 1 }), true);
	assert.equal(isEditorAnchorLine({ text: "   ", inverseCellCount: 1 }), true);
	// Older pi variants render a prompt glyph.
	assert.equal(isEditorAnchorLine({ text: "> draft", inverseCellCount: 1 }), true);
	assert.equal(isEditorAnchorLine({ text: "  ┃ edit me", inverseCellCount: 2 }), true);
	// Chat-area diff rows and notification bars carry inverse cells but are not editor lines.
	assert.equal(isEditorAnchorLine({ text: "+ 65 ## R2 · #822 调研", inverseCellCount: 1 }), false);
	assert.equal(isEditorAnchorLine({ text: " Session saved ", inverseCellCount: 12 }), false);
	assert.equal(isEditorAnchorLine({ text: "real draft ", inverseCellCount: 1 }), false);
	// No inverse cell at all can never anchor the editor line.
	assert.equal(isEditorAnchorLine({ text: "", inverseCellCount: 0 }), false);
	assert.equal(isEditorAnchorLine({ text: "> draft", inverseCellCount: 0 }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd $WT && node --test test/pty-input.test.mjs`
Expected: FAIL — `isEditorAnchorLine is not a function`.

- [ ] **Step 3: Write the pure implementation**

Add to `src/core/pty-input.mjs` below `isProbablyPiInputLine`:

```js
/**
 * Whether a buffer line may be trusted as Pi's editor line (issue #103).
 *
 * Pi paints the editor caret as a single inverse cell and, on an empty editor,
 * nothing else on that line; older variants prefix a prompt glyph. Chat-area
 * content is NOT distinguishable by attributes alone — diff rows and
 * notification bars also carry inverse cells — so "the line has an inverse
 * cell" can never be the anchor criterion by itself. A line that fails this
 * guard is skipped and the scan continues upward; when nothing qualifies the
 * caller escapes (detaches) rather than trapping the user (issues #48/#69/#72).
 * @param {{ text: string, inverseCellCount: number }} line
 * @returns {boolean}
 */
export function isEditorAnchorLine({ text, inverseCellCount }) {
	if (!(inverseCellCount > 0)) return false;
	if (inverseCellCount === 1 && isProbablyEmptyPiInputLine(text)) return true;
	return isProbablyPiInputLine(text);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd $WT && node --test test/pty-input.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing harness scenarios**

In `test-support/detach-gate-smoke.ts`, add these scenarios right after the K2 block (before the L block):

```ts
// O1. Issue #103: the chat area paints inverse cells too (a diff row highlights
// its changed fragments). When the editor's fake cursor is missing from the
// buffer, the bottom-most inverse line is that diff row — it must not be
// trusted as the editor line, or ← gets swallowed and the user is trapped.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat\r\n+ 65 ## \x1b[7mR2 · \x1b[27m#\x1b[7m822 调研\x1b[27m\r\n  ");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesWhenChatDiffInverseHijacksAnchor = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// O2. Same hijack from a notification bar rendered entirely inverse.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat\r\n\x1b[7m Session saved \x1b[27m\r\n  ");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesWhenNotifyBarInverseHijacksAnchor = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// O3. The deliberate flip side of O1/O2, paired with scenario B: current Pi
// renders a draft line as text plus ONE inverse caret cell with no prompt
// glyph, which is attribute-wise identical to a diff row. The anchor guard
// therefore refuses it and ← detaches — draft protection now comes from the
// authoritative editor_state channel (issue #103), not from this heuristic.
// Do NOT "fix" this by trusting any inverse line again: that re-opens the trap.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat\r\nreal draft\x1b[7m \x1b[27m");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesOnUnglyphedDraftAfterAnchorGuard = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}
```

Also extend the header comment block at the top of the file (lines 1-13) with:

```ts
//   O1/O2/O3. Issue #103: chat-area inverse content must never veto a detach,
//   and the un-glyphed draft line loses its fallback protection by design.
```

- [ ] **Step 6: Run the harness to verify the new scenarios fail**

Run: `cd $WT && node --experimental-transform-types test-support/detach-gate-smoke.ts`
Expected: `leftDetachesWhenChatDiffInverseHijacksAnchor` and `leftDetachesWhenNotifyBarInverseHijacksAnchor` are `false` (bug reproduced), `leftDetachesOnUnglyphedDraftAfterAnchorGuard` is `false` (today the draft is gated).

- [ ] **Step 7: Add the assertions to the test**

In `test/pty-attach-detach-gate.test.mjs`, append inside the existing test body:

```js
	assert.equal(parsed.leftDetachesWhenChatDiffInverseHijacksAnchor, true, "a chat diff row's inverse cells must not veto ← (issue #103)");
	assert.equal(parsed.leftDetachesWhenNotifyBarInverseHijacksAnchor, true, "an inverse notification bar must not veto ← (issue #103)");
	assert.equal(parsed.leftDetachesOnUnglyphedDraftAfterAnchorGuard, true, "the un-glyphed draft line intentionally loses fallback protection; editor_state owns it now (issue #103)");
```

- [ ] **Step 8: Implement the guard in the component**

In `src/ui/pty-attach.ts`, extend the import on line 8:

```ts
import { isEditorAnchorLine, isProbablyEmptyPiInputLine, isProbablyPiInputLine, resolveEditorEmpty } from "../core/pty-input.mjs";
```

Delete the whole `findLastInverseCellLine` method (its doc comment included) and replace the tier-1 block of `childInputLooksEmpty()`:

```ts
	private childInputLooksEmpty(): boolean {
		if (!this.receivedOutput) return true;
		const active = this.term.buffer.active;
		// The terminal cursor is not a reliable anchor for the editor line:
		// while Pi streams output (or right after attach) the cursor rests on
		// working/output lines, never the input line, so a genuinely empty
		// editor was misread as non-empty and ← stopped detaching (issue #66).
		// Pi's editor line carries an inverse-video fake-cursor cell, so scan for
		// one — but attributes alone cannot identify that line: chat-area diff
		// rows and notification bars paint inverse cells too, and trusting the
		// bottom-most one trapped the user behind a "draft" that never existed
		// (issue #103). Only an editor-SHAPED line may anchor; anything else is
		// skipped and the scan continues upward.
		for (let y = active.baseY + active.length - 1; y >= active.baseY; y--) {
			const line = active.getLine(y);
			if (!line) continue;
			let inverseCellCount = 0;
			for (let x = 0; x < line.length; x++) {
				if (line.getCell(x)?.isInverse()) inverseCellCount++;
			}
			if (!isEditorAnchorLine({ text: line.translateToString(true), inverseCellCount })) continue;
			return isProbablyEmptyPiInputLine(line.translateToString(true));
		}
		// Fallback: Pi variants that render no fake cursor — look for an EMPTY
		// prompt-glyph line. (unchanged tier-2 block)
		for (let y = active.baseY + active.length - 1; y >= active.baseY; y--) {
			const line = active.getLine(y)?.translateToString(true) ?? "";
			if (isProbablyPiInputLine(line) && isProbablyEmptyPiInputLine(line)) return true;
		}
		// No editor line recoverable (e.g. a garbled replay buffer): treat the
		// input as empty — ← is the only detach key left on the attach surface,
		// so it must always escape rather than trap the user.
		return true;
	}
```

- [ ] **Step 9: Run the harness and the gate test**

Run: `cd $WT && node --experimental-transform-types test-support/detach-gate-smoke.ts && node --test test/pty-attach-detach-gate.test.mjs`
Expected: every scenario key `true` (including the pre-existing B, K1, K2, L, M) and the test passes.

- [ ] **Step 10: Commit**

```bash
cd $WT && git add src/core/pty-input.mjs src/ui/pty-attach.ts test/pty-input.test.mjs test-support/detach-gate-smoke.ts test/pty-attach-detach-gate.test.mjs
git commit -m "fix(attach): only editor-shaped lines may anchor the ← detach gate (issue #103)"
```

---

## Task 9: Full verification and manual acceptance

**Files:**
- No source changes. Verification only; record results in the PR body.

**Interfaces:** none.

- [ ] **Step 1: Run the full gate (spec A8)**

Run: `cd $WT && npm run verify`
Expected: typecheck clean, all `node --test test/*.test.mjs` pass, coverage run passes, `npm pack --dry-run` succeeds.

- [ ] **Step 2: Confirm the reporter source-side plumbing statically**

Run: `cd $WT && rg -n "AGENT_BOARD_CONTROL_SOCKET" src/ runner/ && rg -n "resolveControlEndpointFor|classifyClientHello|hostChildEnv" src/ runner/ | head -20`
Expected: producer (`host-child-env.mjs`), consumer (`src/index.ts`), classifier (runner) and resolver all present; `src/index.ts` no longer imports `controlSocketPathFor`.

- [ ] **Step 3: Manual acceptance U1 — repeated ← never traps (user)**

Procedure: from a normal Pi session run `/agent-board`, attach (`←`-enter path) into a session whose agent is Running, confirm the editor is empty, then press `←` ten times across a streaming period. Record: every press must detach. Record the view id and timestamps.

- [ ] **Step 4: Manual acceptance U2 — draft protection and the documented loss (user)**

Procedure: attach into a session, type a draft in the editor, press `←` → the caret must move left, not detach, while the reporter is online. Then verify the reporter really is online by checking the child holds a socket fd:

```bash
VIEW=<viewId>; PID=$(node -e "console.log(require(process.env.HOME+'/.pi/agent/agent-board/views/'+process.argv[1]+'/host.json').childPid)" $VIEW); ls -l /proc/$PID/fd | grep -c socket
```

Expected: a non-zero socket count (before this change the same check returned 0 — that was root cause B). Then repeat the draft test on a session whose reporter is unavailable (e.g. a legacy view without `AGENT_BOARD_CONTROL_SOCKET` in its child env) and confirm the documented `←` detach behaviour, marking it accepted.

- [ ] **Step 5: Report acceptance status**

Write the outcome of A1–A8, U1, U2 into the PR description, marking anything not executed as `pending` (never claim an unexecuted manual check as passing).

---

## Self-Review

**Spec coverage**

| Spec item | Plan task |
|---|---|
| B1 endpoint discovery (env injection + pure resolver) | Task 1 (resolver), Task 3 (injection), Task 7 (child side) |
| B2 reporter must not pollute `attachedClients`/`attachedEver` | Task 4 (contract), Task 5 (hello), Task 6 (runner counting) |
| B3 unchanged `editorEmpty` reset semantics | Not touched by any task (asserted indirectly in Task 6 Step 5) |
| A1 anchor validation | Task 8 |
| Acceptance A1 (pure predicate) | Task 8 Step 1 |
| Acceptance A2 (resolver) | Task 1 Step 1 |
| Acceptance A3 (reporter hello) | Task 5 Step 1 |
| Acceptance A4 (runner counting) | Task 6 Step 1 |
| Acceptance A5 (env injection, both paths) | Task 3 Step 2 |
| Acceptance A6 (reporter → runner → hello seed) | Task 6 Step 1 |
| Acceptance A7 (smoke harness, no regressions) | Task 8 Steps 5–9 |
| Acceptance A8 (verify) | Task 9 Step 1 |
| Acceptance U1/U2 | Task 9 Steps 3–5 |
| Non-goals (A2/A3 anchors, legacy rename, #106) | No task touches them |

**Placeholder scan:** no TBD/TODO/"similar to Task N" left; every code step carries the full code and the exact command with its expected result.

**Type consistency:** `resolveControlEndpointFor({ envSocketPath, platform, root, viewId })`, `hostChildEnv({ root, viewId, socketPath, baseEnv, extraEnv })`, `classifyClientHello(msg) → "probe"|"reporter"|"client"`, `EDITOR_REPORTER_CLIENT_ID`, `isEditorAnchorLine({ text, inverseCellCount })` are used with identical names, arities and shapes in every task that consumes them.
