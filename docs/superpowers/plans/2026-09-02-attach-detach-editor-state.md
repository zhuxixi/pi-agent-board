# editor_state Push Detach Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the render-heuristic detach gate with the child Pi's authoritative editor state, pushed over the existing control socket (`editor_state`), with the heuristic kept as fallback.

**Architecture:** Child Pi extension polls `ctx.ui.getEditorText()` every 100ms and reports on change → runner caches + broadcasts `{type:"editor_state", empty}` and seeds it in `hello` → attach panel caches `editorEmpty` and judges `resolveEditorEmpty(editorEmpty, heuristic)`. All pieces are dependency-injected/unit-testable; the production wiring is one hook in `src/index.ts`.

**Tech Stack:** TypeScript (pty-attach.ts), plain ESM (mjs), `node:test`, @xterm/headless (smoke harness).

**Spec:** `docs/superpowers/specs/2026-09-02-attach-detach-editor-state-design.md`

## Global Constraints

- Coverage gates: lines 85 / funcs 80 / branches 70 (`npm run test:coverage`); CI Node 22/24 must be green.
- Do NOT remove or change the existing three-tier render heuristic (`findLastInverseCellLine` / glyph fallback / escape fallback) — it becomes the fallback only.
- `ctrl+]` semantics unchanged; `←` keeps its gate (never unconditionally detach while connected).
- Protocol: `{type:"editor_state", empty: boolean}`; `hello` gains `editorEmpty: boolean | null`. Old peers ignore unknown fields — backward compatible.
- `resolveEditorEmpty(editorEmpty, heuristic)`: `editorEmpty === null || editorEmpty === undefined ? heuristic : editorEmpty`.
- All edits inside worktree `WT=.pi/worktrees/issue-68-attach-detach-editor-state`; git ops via `git -C $WT`. You are the only agent; do NOT dispatch subagents.

---

### Task 1: `resolveEditorEmpty` pure function + unit tests (A5)

**Files:**
- Modify: `src/core/pty-input.mjs`
- Test: `test/pty-input.test.mjs`

**Interfaces:**
- Produces: `export function resolveEditorEmpty(editorEmpty: boolean | null | undefined, heuristic: boolean): boolean`

- [ ] **Step 1: Write the failing test**

Append to `test/pty-input.test.mjs` (keep existing tests untouched):

```js
import { isProbablyEmptyPiInputLine, isProbablyPiInputLine, resolveEditorEmpty } from "../src/core/pty-input.mjs";

test("resolveEditorEmpty prefers the pushed editor state, falls back on null/undefined", () => {
	assert.equal(resolveEditorEmpty(true, false), true);
	assert.equal(resolveEditorEmpty(false, true), false);
	assert.equal(resolveEditorEmpty(null, true), true);
	assert.equal(resolveEditorEmpty(null, false), false);
	assert.equal(resolveEditorEmpty(undefined, true), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pty-input.test.mjs`
Expected: FAIL — `resolveEditorEmpty is not a function` (import error).

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/pty-input.mjs`:

```js
/**
 * Resolve the ← detach gate's emptiness signal: when the child Pi pushes its
 * authoritative editor state (boolean), it wins; when it is unknown (null/
 * undefined — child extension missing or socket never connected), fall back
 * to the render heuristic.
 * @param {boolean | null | undefined} editorEmpty
 * @param {boolean} heuristic
 * @returns {boolean}
 */
export function resolveEditorEmpty(editorEmpty, heuristic) {
	return editorEmpty === null || editorEmpty === undefined ? heuristic : editorEmpty;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pty-input.test.mjs`
Expected: PASS (all pty-input tests including the new one).

- [ ] **Step 5: Commit**

```bash
git add test/pty-input.test.mjs src/core/pty-input.mjs
git commit -m "feat: add resolveEditorEmpty gate resolution helper (issue #68)"
```

---

### Task 2: `createEditorStateReporter` + unit tests (A1, A2)

**Files:**
- Create: `src/core/editor-state-reporter.mjs`
- Test: `test/editor-state-reporter.test.mjs`

**Interfaces:**
- Produces: `export function createEditorStateReporter({ getEditorText, connect, intervalMs = 100, scheduler = defaultScheduler }): { start(): void, stop(): void }`
  - `getEditorText(): string` — returns the child Pi editor text (`""` = empty).
  - `connect(): SocketLike` — opens the control socket; throws on failure. `SocketLike` = `{ write(jsonLine: string): void; on?(event: "close" | "error", fn: () => void): void }`.
  - `scheduler = { interval(fn, ms): handle; timeout(fn, ms): handle; clear(handle): void }` — defaults to setInterval/setTimeout wrappers.
  - Behavior: connect immediately on `start()` (retry with backoff 1s→2s→4s→5s cap, forever); after connect, poll `getEditorText()` every `intervalMs` and send `{type:"editor_state", empty: text.length === 0}` ONLY when the text changed; on socket `close`/`error` (or a write throw), tear down, clear the poll, and re-enter the reconnect backoff (backoff resets to 1s after a successful connect); `stop()` is idempotent and ends everything.

- [ ] **Step 1: Write the failing tests**

Create `test/editor-state-reporter.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEditorStateReporter } from "../src/core/editor-state-reporter.mjs";

/** Manual-clock scheduler: interval/timeout register callbacks; fire() runs the oldest due one. */
function fakeScheduler() {
	const pending = []; // { at, fn, handle }
	let nextId = 1;
	return {
		pending,
		interval(fn, ms) { return this._push(fn, ms); },
		timeout(fn, ms) { return this._push(fn, ms); },
		_push(fn, ms) {
			const handle = nextId++;
			pending.push({ handle, fn, ms, due: 0 });
			return handle;
		},
		clear(handle) {
			const i = pending.findIndex((p) => p.handle === handle);
			if (i >= 0) pending.splice(i, 1);
		},
		/** Run the callback whose (re-registration cadence) is due now; returns it or null. */
		fireOne(now) {
			const due = pending.filter((p) => p.due <= now).sort((a, b) => a.due - b.due)[0];
			if (!due) return null;
			const { fn } = due;
			this.clear(due.handle);
			fn();
			return due;
		},
	};
}

function fakeSocket() {
	const sent = [];
	const handlers = {};
	return {
		sent,
		write(jsonLine) { sent.push(jsonLine); },
		on(event, fn) { handlers[event] = fn; },
		emit(event) { handlers[event]?.(); },
	};
}

test("reporter polls and sends only on text change (A1)", () => {
	const sched = fakeScheduler();
	let text = "";
	const socket = fakeSocket();
	const reporter = createEditorStateReporter({
		getEditorText: () => text,
		connect: () => socket,
		scheduler: sched,
		intervalMs: 100,
	});
	reporter.start();
	assert.equal(socket.sent.length, 0); // no send before the first poll
	sched.fireOne(100); // first poll: "" → lastText was null → change → send empty:true
	assert.deepEqual(socket.sent.map((l) => JSON.parse(l)), [{ type: "editor_state", empty: true }]);
	text = "draft";
	sched.fireOne(200);
	assert.equal(socket.sent.length, 2);
	assert.deepEqual(JSON.parse(socket.sent[1]), { type: "editor_state", empty: false });
	text = "draft 2"; // still non-empty → no send
	sched.fireOne(300);
	assert.equal(socket.sent.length, 2);
	text = "";
	sched.fireOne(400);
	assert.equal(socket.sent.length, 3);
	assert.deepEqual(JSON.parse(socket.sent[2]), { type: "editor_state", empty: true });
	reporter.stop();
});

test("reporter stop is idempotent and ends polling (A1)", () => {
	const sched = fakeScheduler();
	const socket = fakeSocket();
	const reporter = createEditorStateReporter({ getEditorText: () => "", connect: () => socket, scheduler: sched, intervalMs: 100 });
	reporter.start();
	sched.fireOne(100);
	reporter.stop();
	reporter.stop();
	assert.equal(sched.pending.length, 0); // poll + reconnect timers all cleared
	assert.equal(socket.sent.length, 1);
});

test("reporter retries connect with capped backoff then recovers (A2)", () => {
	const sched = fakeScheduler();
	const socket = fakeSocket();
	let attempts = 0;
	let connect = () => { attempts++; throw new Error("not up yet"); };
	const reporter = createEditorStateReporter({ getEditorText: () => "", connect: () => connect(), scheduler: sched, intervalMs: 100 });
	reporter.start();
	assert.equal(attempts, 1); // immediate try
	// Backoff sequence: 1s, 2s, 4s, 5s, 5s …
	let t = 0;
	for (const expectedGap of [1000, 2000, 4000, 5000, 5000]) {
		const before = attempts;
		const fired = sched.fireOne(t + expectedGap);
		assert.ok(fired, "reconnect timer must fire");
		assert.equal(attempts, before + 1);
		t += expectedGap;
	}
	// Now the server is up — next reconnect succeeds and polling begins, backoff resets.
	connect = () => socket;
	sched.fireOne(t + 5000);
	assert.equal(attempts, 7);
	sched.fireOne(t + 5000 + 100); // first poll after connect
	assert.equal(socket.sent.length, 1);
	assert.deepEqual(JSON.parse(socket.sent[0]), { type: "editor_state", empty: true });
	reporter.stop();
});

test("reporter reconnects after socket close (A2)", () => {
	const sched = fakeScheduler();
	const first = fakeSocket();
	const second = fakeSocket();
	let call = 0;
	const reporter = createEditorStateReporter({
		getEditorText: () => "",
		connect: () => (++call === 1 ? first : second),
		scheduler: sched,
		intervalMs: 100,
	});
	reporter.start();
	sched.fireOne(100); // poll on first socket
	assert.equal(first.sent.length, 1);
	first.emit("close");
	assert.equal(sched.pending.length, 1); // reconnect timer scheduled (backoff 1s)
	sched.fireOne(1100); // reconnect succeeds on second socket
	sched.fireOne(1200); // poll resumes
	assert.equal(second.sent.length, 1);
	reporter.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/editor-state-reporter.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/editor-state-reporter.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/editor-state-reporter.mjs`:

```js
/** Child-Pi editor-state reporter (issue #68): polls the child Pi's editor text
 * and pushes `{type:"editor_state", empty}` over the control socket whenever the
 * text changes, so the attach surface can gate ← on the authoritative state
 * instead of render heuristics. Dependency-injected for unit testing. */

/** @typedef {{ write(jsonLine: string): void; on?(event: "close" | "error", fn: () => void): void }} SocketLike */

const defaultScheduler = {
	interval(fn, ms) { return setInterval(fn, ms); },
	timeout(fn, ms) { return setTimeout(fn, ms); },
	clear(handle) { clearInterval(handle); clearTimeout(handle); },
};

export function createEditorStateReporter({ getEditorText, connect, intervalMs = 100, scheduler = defaultScheduler }) {
	let started = false;
	let stopped = false;
	let socket = null;
	let pollTimer = null;
	let reconnectTimer = null;
	let backoffMs = 1000;
	let lastText = null;

	function send(json) {
		if (!socket) return;
		try {
			socket.write(JSON.stringify(json) + "\n");
		} catch {
			teardownSocket();
			scheduleReconnect();
		}
	}

	function teardownSocket() {
		if (pollTimer !== null) { scheduler.clear(pollTimer); pollTimer = null; }
		const s = socket;
		socket = null;
		if (s?.on) { try { s.on("close", () => {}); s.on("error", () => {}); } catch { /* already torn down */ } }
	}

	function poll() {
		if (stopped || !socket) return;
		const text = getEditorText();
		if (text !== lastText) {
			lastText = text;
			send({ type: "editor_state", empty: text.length === 0 });
		}
	}

	function startPolling() {
		if (pollTimer !== null) return;
		lastText = null; // force a first report after (re)connect
		pollTimer = scheduler.interval(poll, intervalMs);
	}

	function scheduleReconnect() {
		if (stopped) return;
		teardownSocket();
		reconnectTimer = scheduler.timeout(tryConnect, backoffMs);
		backoffMs = Math.min(backoffMs * 2, 5000);
	}

	function tryConnect() {
		reconnectTimer = null;
		if (stopped) return;
		let s;
		try {
			s = connect();
		} catch {
			scheduleReconnect();
			return;
		}
		socket = s;
		backoffMs = 1000;
		s?.on?.("close", () => { if (socket === s) scheduleReconnect(); });
		s?.on?.("error", () => { if (socket === s) scheduleReconnect(); });
		startPolling();
	}

	function start() {
		if (started) return;
		started = true;
		stopped = false;
		tryConnect();
	}

	function stop() {
		stopped = true;
		if (reconnectTimer !== null) { scheduler.clear(reconnectTimer); reconnectTimer = null; }
		teardownSocket();
	}

	return { start, stop };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/editor-state-reporter.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/editor-state-reporter.mjs test/editor-state-reporter.test.mjs
git commit -m "feat: add editor-state reporter with injected scheduler (issue #68)"
```

---

### Task 3: runner `editor_state` routing + hello seed + exit reset (A3 code)

**Files:**
- Modify: `runner/pty-runner.mjs`

**Interfaces:**
- Consumes: none (protocol only).
- Produces: runner-side `editorEmpty` cache; `hello` payload `{ type:"hello", status, editorEmpty }`; broadcast `{type:"editor_state", empty}`.

- [ ] **Step 1: Implement**

In `runner/pty-runner.mjs`:

1. Near the top-level state (next to `let crashed = false;` — locate the exact spot when editing; the variables live near `host` init): add

```js
	/** Authoritative child editor emptiness, pushed by the child Pi extension
	 * (issue #68). null = unknown (extension missing / not yet reported). */
	let editorEmpty = null;
```

2. In the `child.onExit` handler, inside the `if (!crashed) { ... }` block, before `broadcast({ type: "exit", exitCode })`, add:

```js
			editorEmpty = null;
			broadcast({ type: "editor_state", empty: null });
```

3. In `handleClientLine`'s switch:

```js
			case "hello":
				send(socket, { type: "hello", status: host, editorEmpty });
				break;
```

4. Add a new case (after `get_status`):

```js
			case "editor_state": {
				editorEmpty = typeof msg.empty === "boolean" ? msg.empty : null;
				broadcast({ type: "editor_state", empty: editorEmpty });
				break;
			}
```

- [ ] **Step 2: Run targeted tests to verify no regression**

Run: `node --test test/pty-runner.integration.test.mjs`
Expected: PASS (existing tests; new assertions come in Task 6).

- [ ] **Step 3: Commit**

```bash
git add runner/pty-runner.mjs
git commit -m "feat: route editor_state through the control socket (issue #68)"
```

---

### Task 4: attach panel cache + judgment + smoke scenarios H/I (A4)

**Files:**
- Modify: `src/ui/pty-attach.ts`
- Modify: `test-support/detach-gate-smoke.ts`
- Modify: `test/pty-attach-detach-gate.test.mjs`

**Interfaces:**
- Consumes: `resolveEditorEmpty` (Task 1).
- Produces: private `editorEmpty: boolean | null`; smoke keys `leftEditorStateOverridesHeuristicEmpty`, `leftEditorStateBlocksDetachOnDraft`.

- [ ] **Step 1: Write the failing smoke scenarios + assertions**

In `test-support/detach-gate-smoke.ts`, after scenario F (use the existing `writeToTerm`/`makeAttach`/`out` pattern), add:

```ts
// H. The pushed editor state is authoritative over the render heuristic: the
// buffer looks non-empty (garbled line) but the child reports empty → ← detach.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n────── ◊◊ ──────");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: true }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftEditorStateOverridesHeuristicEmpty = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// I. The pushed editor state is authoritative the other way: the heuristic
// would say "empty" (nothing in the buffer), but the child reports a draft →
// ← is forwarded (editor protection), NOT detach.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	(attach as unknown as { onSocketData: (t: string) => void }).onSocketData(JSON.stringify({ type: "editor_state", empty: false }) + "\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftEditorStateBlocksDetachOnDraft = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}
```

In `test/pty-attach-detach-gate.test.mjs`, after the `leftDetachesOnGlyphLineWithoutFakeCursor` assertion, add:

```js
	assert.equal(parsed.leftEditorStateOverridesHeuristicEmpty, true, "← must detach when editor_state says empty even if the buffer looks non-empty");
	assert.equal(parsed.leftEditorStateBlocksDetachOnDraft, true, "← must be forwarded when editor_state reports a draft even if the buffer looks empty");
```

- [ ] **Step 2: Run smoke to verify new scenarios fail**

Run: `node --experimental-transform-types test-support/detach-gate-smoke.ts`
Expected: `leftEditorStateOverridesHeuristicEmpty` and `leftEditorStateBlocksDetachOnDraft` are both `false` (no editor_state handling yet); all 11 existing keys still true.

- [ ] **Step 3: Implement**

In `src/ui/pty-attach.ts`:

1. Update the pty-input import (line ~8):

```ts
import { isProbablyEmptyPiInputLine, isProbablyPiInputLine, resolveEditorEmpty } from "../core/pty-input.mjs";
```

2. Add the cache field next to the other private fields (e.g. right above `private receivedOutput` — find the field block):

```ts
	/** Authoritative editor emptiness pushed by the child Pi extension via the
	 * control socket (issue #68). null = unknown — fall back to the heuristic. */
	private editorEmpty: boolean | null = null;
```

3. In `onSocketData`, extend the hello/status branch:

```ts
				if (msg.type === "hello" || msg.type === "status") {
					this.status = "attached";
					if (msg.type === "hello" && typeof msg.editorEmpty === "boolean") this.editorEmpty = msg.editorEmpty;
				} else if (msg.type === "editor_state") {
					this.editorEmpty = typeof msg.empty === "boolean" ? msg.empty : null;
				} else if (msg.type === "exit") {
```

4. In `handleInput`, the `Key.left` branch — replace the judgment call:

```ts
			if (shouldEscapeAttach(this.connected, resolveEditorEmpty(this.editorEmpty, this.childInputLooksEmpty()))) {
```

- [ ] **Step 4: Run smoke + gate tests to verify pass**

Run: `node --experimental-transform-types test-support/detach-gate-smoke.ts` then `node --test test/pty-attach-detach-gate.test.mjs test/pty-input.test.mjs test/editor-state-reporter.test.mjs`
Expected: smoke has all 13 keys true (11 existing + H + I); all three test files pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/pty-attach.ts test-support/detach-gate-smoke.ts test/pty-attach-detach-gate.test.mjs
git commit -m "fix: gate ← on pushed editor_state with heuristic fallback (issue #68)"
```

---

### Task 5: production wiring in `src/index.ts` (A2 production end)

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `createEditorStateReporter` (Task 2), `controlSocketPathFor` from `./core/paths.mjs`, `createConnection` from `node:net`.

- [ ] **Step 1: Implement**

In `src/index.ts`:

1. Add imports at the top:

```ts
import { createConnection } from "node:net";
import { controlSocketPathFor } from "./core/paths.mjs";
```

2. Add a module-level reporter handle (next to the other module constants):

```ts
let hostedEditorReporter: { stop(): void } | null = null;
```

3. Inside the `pi.on("session_start", ...)` handler, as the FIRST statement (before `updateStatus(ctx)`):

```ts
		if (isHostedChild && !hostedEditorReporter && typeof ctx.ui?.getEditorText === "function" && hostedViewId) {
			const { createEditorStateReporter } = await import("./core/editor-state-reporter.mjs");
			hostedEditorReporter = createEditorStateReporter({
				getEditorText: () => ctx.ui.getEditorText(),
				connect: () => createConnection(controlSocketPathFor(process.platform, root, hostedViewId)),
			});
			hostedEditorReporter.start();
		}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (exit 0).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: start editor_state reporter in hosted child sessions (issue #68)"
```

---

### Task 6: runner integration test for editor_state routing (A3)

**Files:**
- Test: `test/pty-runner.integration.test.mjs`

**Interfaces:**
- Consumes: Task 3's runner behavior.

- [ ] **Step 1: Write the failing test**

Append to `test/pty-runner.integration.test.mjs` (reusing `freshRoot`/`createView`/`atomicWriteJson`/`hostReady`/`connectWhenReady`/`send`/`waitFor`/`stopRunner`/`reapChild` from the existing helpers):

```js
test("pty-runner routes editor_state between clients, seeds hello, resets on exit", async () => {
	const root = freshRoot();
	let runner;
	try {
		const meta = createView(root, { id: "v1", name: "editor-state", cwd: process.cwd() });
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
			env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1" },
			cols: 80,
			rows: 24,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		await waitFor(() => hostReady(root, "v1"));

		const readMessages = (socket) => {
			let buf = "";
			const messages = [];
			socket.on("data", (chunk) => {
				buf += chunk.toString();
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
			});
			return messages;
		};

		const client1 = createConnection(P.controlSocketPath(root, "v1"));
		await once(client1, "connect");
		const messages1 = readMessages(client1);
		send(client1, { type: "hello" });
		await waitFor(() => messages1.find((m) => m.type === "hello"));

		// A second client must receive the pushed state as a broadcast.
		const client2 = createConnection(P.controlSocketPath(root, "v1"));
		await once(client2, "connect");
		const messages2 = readMessages(client2);
		send(client1, { type: "editor_state", empty: false });
		await waitFor(() => messages2.find((m) => m.type === "editor_state"));
		assert.equal(messages2.find((m) => m.type === "editor_state").empty, false);

		// A client connecting afterwards gets the current state seeded in hello.
		const client3 = createConnection(P.controlSocketPath(root, "v1"));
		await once(client3, "connect");
		const messages3 = readMessages(client3);
		send(client3, { type: "hello" });
		await waitFor(() => messages3.find((m) => m.type === "hello"));
		assert.equal(messages3.find((m) => m.type === "hello").editorEmpty, false);

		// Child exit resets the state to null and broadcasts it.
		send(client1, { type: "input", data: "exit\r" });
		await waitFor(() => messages2.find((m) => m.type === "editor_state" && m.empty === null));
		await waitFor(() => readHost(root, "v1")?.endedAt);

		client1.destroy();
		client2.destroy();
		client3.destroy();
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pty-runner.integration.test.mjs`
Expected: the new test FAILS (no `editor_state` broadcast before Task 3 — if Task 3 is already in the tree this step's test passes; then simply confirm PASS and skip to commit).

- [ ] **Step 3: (If it failed) — Task 3 is already merged in this branch; re-run to confirm PASS**

Run: `node --test test/pty-runner.integration.test.mjs`
Expected: PASS (all runner tests, including the new one).

- [ ] **Step 4: Commit**

```bash
git add test/pty-runner.integration.test.mjs
git commit -m "test: cover editor_state routing, hello seed and exit reset (issue #68)"
```

---

### Task 7: Full regression (A6)

**Files:** none (verification only).

- [ ] **Step 1: Run verify**

Run (in worktree): `npm run verify`
Expected: typecheck clean; all `node --test test/*.test.mjs` pass (430+ tests, zero pre-existing semantics changed); c8 coverage above gates (lines ≥85 / funcs ≥80 / branches ≥70); `npm pack --dry-run` succeeds.

- [ ] **Step 2: Commit any incidental fixes**

If verify surfaced issues, fix and commit referencing issue #68. Otherwise nothing to commit.

---

### Task 8: Post-implementation manual verification (U1–U4)

**Files:** none (user verification; report back into the PR).

- [ ] **Step 1: U1 — attach-then-←**

1. Update the local extension checkout to the branch (`~/.pi/agent/git/github.com/zhuxixi/pi-agent-board` → `issue-68-attach-detach-editor-state`), restart Pi.
2. Attach into a pi session; as soon as the surface paints, press `←`.
Expected: returns to the dashboard immediately.

- [ ] **Step 2: U2 — ← while Pi is thinking**

1. Send a prompt that triggers streaming (`⠹ Working...` visible).
2. While the animation runs, press `←`.
Expected: returns to the dashboard (the #68/#69 failure mode).

- [ ] **Step 3: U3 — draft protection**

1. Attach, type a draft, press `←`.
Expected: cursor moves left inside the draft (forwarded), NOT detach.

- [ ] **Step 4: U4 — fallback when the reporter is absent**

1. Temporarily set `AGENT_BOARD_DISABLE_EDITOR_STATE=1` is NOT part of this plan's product code; instead verify by attaching while the child extension build predates this branch (or just confirm U1-U3 — the heuristic fallback is covered by the existing smoke suite). If U4 cannot be arranged, record it as covered-by-automation (A4 smoke H/I covers the null path).
Expected: ← still exits (heuristic fallback), recorded in the PR.

- [ ] **Step 5: Record results**

Write U1-U4 outcomes into the PR description before merge.
