# Attach In-Place Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the PTY attach view, `Ctrl+X` opens an in-place delete confirm; `y` archives the row (same `service.archive` semantics as the board), returns to the board with the neighbor selected and a `Deleted "name"` notice.

**Architecture:** A pure key-resolution function (`resolveAttachDeleteKey`) gates a `confirmArmed` state inside `PtyAttachComponent`; confirming performs the same local teardown as `detach()` minus the control frame, then resolves the custom-UI result as `{action:"delete"}`. The command layer (`attach()` in agent-board.ts) consumes that state, computes the neighbor row with a second pure function (`nextVisibleIdAfterRemoval`, same ordering source as the dashboard), archives, and hands `afterDelete` to `dashboardAttachLoop`, which reopens the board with `initialSelectedId` + a new `initialNotice` dep.

**Tech Stack:** TypeScript (pi extension, tabs, English comments), pi-tui `matchesKey`/`Key`/`truncateToWidth`, `node:test` + TS probes via `node --experimental-transform-types`.

**Spec:** `docs/superpowers/specs/2026-10-10-attach-delete-in-place-design.md` (v4, sha256 `cc51282e…3765`; line-number baseline `884040f` / 0.10.2). Every task cites the spec acceptance IDs it implements (A1–A8, U1–U4).

**Work from:** `/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-147-attach-delete-in-place` (all paths below are repo-relative; run every command from that worktree root).

## Global Constraints

- Spec §1.2 non-goals are hard: do NOT touch board keys (`x`→`y`, `Ctrl+X` ×2), `service.archive`/`archiveView`/coordinator, the `ctx.switchSession` path, or the orphan `src/commands/attach-flow.ts`.
- First `Ctrl+X` press and the armed-state `y`/`Y`/Enter confirm must NEVER be forwarded to the child PTY; second `Ctrl+X` is swallowed (`cancel-swallow`, user adjudication 2026-10-10); every other key cancels and falls through the existing chain.
- Confirm teardown = `this.close(true)` then `this.done({action:"delete"})` — no `detach` control frame, no archive from the component (spec §3.4.3).
- Header row count must not change when armed (no PTY resize); `NAME` truncated to ≤24 columns via `truncateToWidth(name, 24, "")` so `y confirms` stays visible (spec §3.2).
- Tabs for indentation; English comments and commit messages; conventional commits (`feat`/`test`/`docs`).
- Line numbers cited from the spec's baseline `884040f`; if the file drifted, locate by symbol name, not blindly by number.

## Review Focus

Five input classes the spec implies but individual tasks might not exercise — each is pinned by the listed test, in the task that owns the code:

1. **Armed state swallows input or hangs armed** (a `y` typed while composing gets eaten, or armed survives a mouse event and a later `y` mis-deletes) → pinned by Q3/Q4 (cancel forwards, second `Ctrl+X` swallowed) and Q5/Q6 (both mouse channels clear) in Task 3.
2. **Confirm path skips teardown** (timer leak, held-PTY size not restored, component still consuming socket events after exit) → pinned by Q8 (wire order: `resize` → `END`, no `DESTROY`, no `detach` frame) in Task 3.
3. **Gesture unavailable while disconnected / host exited** → the resolver never reads connection state; pinned by Q1 running against the never-connected default harness plus A1's pure-function contract in Task 1.
4. **Long session name clips the confirm hint** → pinned by Q2 (`y confirms` present with a 40-char title) in Task 3.
5. **Command layer orders archive after component exit, and archive failure is silent** → pinned by A5 (deps assertions after the second board opens) and A6 (`ctx.ui.notify` receives the error) in Task 4.

---

### Task 1: `resolveAttachDeleteKey` pure function (spec A1)

**Files:**
- Create: `src/core/attach-delete.mjs`
- Test: `test/attach-delete-key.test.mjs` (new)

**Interfaces:**
- Consumes: pi-tui `matchesKey`, `Key` (devDeps pins `@earendil-works/pi-tui@1.1.0`, resolves for plain `node --test`).
- Produces: `resolveAttachDeleteKey(state: { confirmArmed: boolean }, data: string): { action: "arm" | "confirm" | "cancel" | "cancel-swallow" | "forward"; confirmArmed: boolean }` — Task 3 imports it.

- [ ] **Step 1: Write the failing test**

```js
// test/attach-delete-key.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { resolveAttachDeleteKey } from "../src/core/attach-delete.mjs";

test("resolveAttachDeleteKey: full branch matrix (issue #147 A1)", () => {
	// arm: not armed + ctrl+x (raw 0x18)
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: false }, "\x18"), { action: "arm", confirmArmed: true });
	// confirm: armed + y / Y / enter (\r)
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: true }, "y"), { action: "confirm", confirmArmed: false });
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: true }, "Y"), { action: "confirm", confirmArmed: false });
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: true }, "\r"), { action: "confirm", confirmArmed: false });
	// cancel: armed + other keys (forwarded)
	for (const key of ["n", "\x1b", "a", "\x1b[D", "\x1b[5~", " "]) {
		assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: true }, key), { action: "cancel", confirmArmed: false }, `key=${JSON.stringify(key)}`);
	}
	// cancel-swallow: armed + second ctrl+x (user adjudication 2026-10-10)
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: true }, "\x18"), { action: "cancel-swallow", confirmArmed: false });
	// forward: not armed + anything else
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: false }, "x"), { action: "forward", confirmArmed: false });
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: false }, "\r"), { action: "forward", confirmArmed: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/attach-delete-key.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/attach-delete.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// src/core/attach-delete.mjs
import { Key, matchesKey } from "@earendil-works/pi-tui";

/**
 * Issue #147: key resolution for the in-attach delete gesture. Pure — never
 * reads socket/connection/editor state, so the gesture works even while the
 * host is down. Second ctrl+x is swallowed (cancel-swallow, user adjudication
 * 2026-10-10): the chord is a confirm toggle here, and forwarding it would
 * inject one message.copy into the child Pi.
 * @param {{ confirmArmed: boolean }} state
 * @param {string} data raw key chunk
 * @returns {{ action: "arm" | "confirm" | "cancel" | "cancel-swallow" | "forward", confirmArmed: boolean }}
 */
export function resolveAttachDeleteKey(state, data) {
	if (matchesKey(data, Key.ctrl("x"))) {
		return state.confirmArmed ? { action: "cancel-swallow", confirmArmed: false } : { action: "arm", confirmArmed: true };
	}
	if (state.confirmArmed) {
		if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
			return { action: "confirm", confirmArmed: false };
		}
		return { action: "cancel", confirmArmed: false };
	}
	return { action: "forward", confirmArmed: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/attach-delete-key.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/core/attach-delete.mjs test/attach-delete-key.test.mjs
git commit -m "feat(core): pure key resolver for the in-attach delete gesture"
```

### Task 2: `nextVisibleIdAfterRemoval` (spec A2)

**Files:**
- Modify: `src/core/rows.mjs` (append after `groupRowsByFolder`, ~line 260)
- Test: `test/rows.test.mjs` (existing file — append a test)

**Interfaces:**
- Consumes: `groupRowsByFolder(rows, now)` from the same file — the SAME ordering source the dashboard uses for `orderedIds` (`src/ui/dashboard.ts:192`), so the two can never drift.
- Produces: `nextVisibleIdAfterRemoval(rows, id, now): string | null` — Task 4 imports it.

- [ ] **Step 1: Write the failing test** (append to `test/rows.test.mjs`; reuse its existing temp-root helpers if present, else this self-contained block)

```js
// appended to test/rows.test.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createView, listRows } from "../src/core/store.mjs";
import { nextVisibleIdAfterRemoval } from "../src/core/rows.mjs";

test("nextVisibleIdAfterRemoval: neighbor semantics (issue #147 A2)", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-neighbor-"));
	try {
		for (const id of ["v1", "v2", "v3"]) createView(root, { id, name: id, cwd: root });
		const now = Date.now();
		const rows = listRows(root);
		assert.equal(nextVisibleIdAfterRemoval(rows, "v2", now), "v3", "middle row -> next visible row");
		assert.equal(nextVisibleIdAfterRemoval(rows, "v3", now), "v2", "last row -> previous row");
		const single = mkdtempSync(join(tmpdir(), "agentview-neighbor-single-"));
		try {
			createView(single, { id: "only", name: "only", cwd: single });
			assert.equal(nextVisibleIdAfterRemoval(listRows(single), "only", Date.now()), null, "single row -> null (board falls back to orderedIds[0])");
			assert.equal(nextVisibleIdAfterRemoval([], "only", Date.now()), null, "empty list -> null");
			assert.equal(nextVisibleIdAfterRemoval(rows, "nope", now), null, "unknown id -> null");
		} finally {
			rmSync(single, { recursive: true, force: true });
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rows.test.mjs`
Expected: FAIL — `nextVisibleIdAfterRemoval` is not exported.

- [ ] **Step 3: Write the implementation** (append to `src/core/rows.mjs`)

```js
/**
 * Issue #147: the row the board should select after `id` is removed — the
 * next visible row in dashboard order, else the previous one, else null
 * (caller falls back to the existing orderedIds[0] clamp). Uses the same
 * groupRowsByFolder ordering as the dashboard's orderedIds.
 * @param {Row[]} rows
 * @param {string} id
 * @param {number} now
 * @returns {string | null}
 */
export function nextVisibleIdAfterRemoval(rows, id, now) {
	const ordered = groupRowsByFolder(rows, now).flatMap((g) => g.folders.flatMap((f) => f.rows.map((r) => r.id)));
	const idx = ordered.indexOf(id);
	if (idx === -1) return null;
	if (idx + 1 < ordered.length) return ordered[idx + 1];
	if (idx - 1 >= 0) return ordered[idx - 1];
	return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rows.test.mjs`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 5: Commit**

```bash
git add src/core/rows.mjs test/rows.test.mjs
git commit -m "feat(core): neighbor id helper for post-delete board selection"
```

### Task 3: `PtyAttachComponent` delete gesture + smoke scenarios (spec A3, A4)

**Files:**
- Modify: `src/ui/pty-attach.ts` — type `:17`, private fields ~`:156`, `handleInput` `:289`, `handleMouse` `:376-385`, `render` header `:399-401`, plus a new private helper near `detach()` (`:435`)
- Modify: `test-support/detach-gate-smoke.ts` — extend `makeAttach` (title option + `resultAction`), add scenarios Q1–Q8
- Test: `test/pty-attach-delete-gate.test.mjs` (new)

**Interfaces:**
- Consumes: `resolveAttachDeleteKey` from Task 1; `truncateToWidth` (already imported `:7`); `resolveAttachMouseAction` (already used in `handleMouse`).
- Produces: `PtyAttachResult` third state `{ action: "delete" }` — Task 4's `attach()` switches on it.

- [ ] **Step 1: Write the failing smoke scenarios + test file**

In `test-support/detach-gate-smoke.ts`:

(a) `makeAttach` gains a title option and exposes the captured result action — change the signature line and the constructor call, and extend the returned object:

```ts
function makeAttach(options: { backgroundReplies?: Array<{ r: number; g: number; b: number } | undefined>; queryVia?: "background" | "colors"; title?: string } = {}) {
```

```ts
	const attach = new PtyAttachComponent(
		scopedTui as never,
		theme,
		keybindings,
		(r) => { result = r; },
		{ socketPath: "/no/such/socket", title: options.title ?? "gate" },
	);
```

```ts
	return {
		attach,
		sent,
		terminalWrites,
		scopedTui,
		backgroundProbeCalls,
		didDetach: () => (result as { action?: string } | null)?.action === "detached",
		resultAction: () => (result as { action?: string } | null)?.action ?? null,
	};
```

(b) Append scenarios Q1–Q8 after the P13 block (keep the file's `out` record style; reuse `plainTui`/`theme`/`waitFor`):

```ts
// Q1. Issue #147: ctrl+x arms the in-place delete confirm — header row is
// replaced (same row count), the chord is NOT forwarded, and y confirms by
// resolving {action:"delete"} with no detach/terminate frame. The default
// harness socket never connected, so this also pins "works while disconnected".
{
	const { attach, sent, resultAction } = makeAttach({ title: "session-a" });
	attach.handleInput("\x18");
	const header = attach.render(80)[0];
	out.deleteArmShowsPrompt = header.includes("y confirms") && header.includes("session-a");
	out.deleteArmHoldsKey = !sent.some((m) => m.type === "input" && m.data === "\x18");
	attach.handleInput("y");
	out.deleteConfirmResolves = resultAction() === "delete";
	out.deleteConfirmSendsNoControlFrame = !sent.some((m) => m.type === "detach" || m.type === "terminate");
	attach.dispose();
}

// Q2. Long names truncate (<=24 cols) so the confirm hint stays visible.
{
	const { attach } = makeAttach({ title: "x".repeat(40) });
	attach.handleInput("\x18");
	out.deleteLongNameKeepsHint = attach.render(80)[0].includes("y confirms");
	attach.dispose();
}

// Q3. Any other key cancels and is forwarded — input is never swallowed.
{
	const { attach, sent, resultAction } = makeAttach();
	attach.handleInput("\x18");
	attach.handleInput("n");
	out.deleteCancelForwards = sent.some((m) => m.type === "input" && m.data === "n") && resultAction() === null;
	attach.dispose();
}

// Q4. Second ctrl+x is swallowed (cancel-swallow): no byte reaches the child,
// the prompt clears, and a following y is ordinary input.
{
	const { attach, sent, resultAction } = makeAttach();
	attach.handleInput("\x18");
	attach.handleInput("\x18");
	out.deleteSecondSwallowed = !sent.some((m) => m.type === "input" && m.data === "\x18") && !attach.render(80)[0].includes("y confirms");
	attach.handleInput("y");
	out.deleteYAfterSwallowForwards = sent.some((m) => m.type === "input" && m.data === "y") && resultAction() === null;
	attach.dispose();
}

// Q5. A mouse chunk on the handleInput channel clears the armed state.
{
	const { attach, sent, resultAction } = makeAttach();
	attach.handleInput("\x18");
	attach.handleInput("\x1b[<64;10;10M");
	attach.handleInput("y");
	out.deleteWheelChunkClears = sent.some((m) => m.type === "input" && m.data === "y") && resultAction() === null;
	attach.dispose();
}

// Q6. A TuiMouseEvent on the handleMouse channel (fullscreen mode, #167/#169)
// clears the armed state too — native paste is off so the event returns
// undefined, exercising the not-consumed path.
{
	const { attach, sent, resultAction } = makeAttach();
	attach.handleInput("\x18");
	process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE = "0";
	(attach as unknown as { handleMouse: (e: unknown) => unknown }).handleMouse({
		type: "press", button: "middle", x: 3, y: 3, screenX: 3, screenY: 3, width: 80, height: 22, shift: false,
	});
	delete process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE;
	attach.handleInput("y");
	out.deleteHandleMouseClears = sent.some((m) => m.type === "input" && m.data === "y") && resultAction() === null;
	attach.dispose();
}

// Q7. Encoding forms arm too (kitty CSI-u, modifyOtherKeys).
{
	const kitty = makeAttach();
	kitty.attach.handleInput("\x1b[120;5u");
	const mok = makeAttach();
	mok.attach.handleInput("\x1b[27;5;120~");
	out.deleteEncodingsArm = kitty.attach.render(80)[0].includes("y confirms") && mok.attach.render(80)[0].includes("y confirms");
	kitty.attach.dispose();
	mok.attach.dispose();
}

// Q8. Confirm teardown mirrors detach()'s G3 ordering minus the control
// frame: restore the held PTY size, then a graceful socket end — never
// destroy, never a detach packet (clone of scenario D with \x18 + y).
{
	const attach = new PtyAttachComponent(plainTui as never, theme, keybindings, () => {}, { socketPath: "/no/such/socket", title: "wire" });
	const wire: string[] = [];
	const socket = {
		write(data: string) { wire.push(data); return true; },
		end() { wire.push("END"); },
		destroy() { wire.push("DESTROY"); },
		once(_event: string, _listener: () => void) { return this; },
	};
	const internals = attach as unknown as {
		socket: typeof socket | null;
		connected: boolean;
		jiggleRetry: { start: (cols: number, rows: number) => void };
	};
	internals.socket = socket;
	internals.connected = true;
	internals.jiggleRetry.start(80, 22);
	wire.length = 0;
	attach.handleInput("\x18");
	attach.handleInput("y");
	const packets = wire.filter((entry) => entry !== "END" && entry !== "DESTROY").map((entry) => JSON.parse(entry));
	out.deleteTeardownRestoresBeforeEnd =
		packets.length === 1 &&
		packets[0].type === "resize" && packets[0].cols === 80 && packets[0].rows === 22 &&
		wire.at(-1) === "END" && !wire.includes("DESTROY");
	attach.dispose();
}
```

(c) The assertions file `test/pty-attach-delete-gate.test.mjs` (mirrors `pty-attach-detach-gate.test.mjs`):

```js
// test/pty-attach-delete-gate.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const GATE_SCRIPT = join(ROOT_DIR, "test-support", "detach-gate-smoke.ts");

// Issue #147: the in-attach delete gesture — arm/confirm/cancel/cancel-swallow
// branches, both mouse channels, encoding forms, and the teardown ordering.
test("attach delete gate: arm/confirm/cancel/teardown semantics", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", GATE_SCRIPT], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const parsed = JSON.parse(out);
	for (const key of [
		"deleteArmShowsPrompt",
		"deleteArmHoldsKey",
		"deleteConfirmResolves",
		"deleteConfirmSendsNoControlFrame",
		"deleteLongNameKeepsHint",
		"deleteCancelForwards",
		"deleteSecondSwallowed",
		"deleteYAfterSwallowForwards",
		"deleteWheelChunkClears",
		"deleteHandleMouseClears",
		"deleteEncodingsArm",
		"deleteTeardownRestoresBeforeEnd",
	]) {
		assert.equal(parsed[key], true, `${key} must hold (issue #147 A3/A4)`);
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pty-attach-delete-gate.test.mjs`
Expected: FAIL — every `delete*` key is `undefined` (component has no gesture yet). The pre-existing keys parsed by other tests must stay green.

- [ ] **Step 3: Implement the component gesture** (in `src/ui/pty-attach.ts`)

(a) Type (`:17`):

```ts
export type PtyAttachResult = { action: "detached" } | { action: "closed"; exitCode?: number | null } | { action: "delete" };
```

(b) Import + field (import block top of file; field near `private status = "connecting";`):

```ts
import { resolveAttachDeleteKey } from "../core/attach-delete.mjs";
```

```ts
	/** Issue #147: in-place delete confirm is armed (first ctrl+x). */
	private confirmArmed = false;
```

(c) Helper (next to `detach()`):

```ts
	private clearConfirmArmed(): void {
		if (!this.confirmArmed) return;
		this.confirmArmed = false;
		this.scheduleRender();
	}
```

(d) `handleInput` — after the mouse branch line, before the `pageUp` branch (spec §3.4.3 insertion point):

```ts
	handleInput(data: string): void {
		const mouseInput = parseMouseInputChunk(data);
		if (mouseInput) this.clearConfirmArmed();
		if (mouseInput && this.handleMouseInputChunk(mouseInput)) return;
		// Issue #147: in-place delete gesture. The resolver is pure and never
		// reads connection state, so the gesture works even while the host is
		// down. cancel falls through so input is never swallowed.
		const deleteKey = resolveAttachDeleteKey({ confirmArmed: this.confirmArmed }, data);
		this.confirmArmed = deleteKey.confirmArmed;
		if (deleteKey.action === "arm") {
			this.scheduleRender();
			return;
		}
		if (deleteKey.action === "confirm") {
			// Teardown first — same shape as detach() minus the control frame:
			// close(true) restores a held PTY (G3, issue #42) and gracefully
			// ends the socket; the consumer archives and the host is terminated,
			// so no detach packet is sent. done() before archive so the host's
			// death is never rendered here.
			this.close(true);
			this.done({ action: "delete" });
			return;
		}
		if (deleteKey.action === "cancel-swallow") {
			this.scheduleRender();
			return;
		}
		if (deleteKey.action === "cancel") this.scheduleRender();
		if (matchesKey(data, Key.pageUp)) {
```

(e) `handleMouse` — clear at entry (before `resolveAttachMouseAction`), covering consumed and not-consumed paths:

```ts
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		this.clearConfirmArmed();
		const action = resolveAttachMouseAction(event, {
			nativePasteEnabled: process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE !== "0",
		});
```

(f) `render` header (`:399-401`) — armed row replaces the header line, same row count, `NAME` truncated:

```ts
		const header = this.confirmArmed
			? this.theme.fg("accent", this.theme.bold(` Delete "${truncateToWidth(this.opts.title, 24, "")}"? `)) +
			  this.theme.fg("muted", "y confirms · any other key cancels")
			: this.theme.fg("accent", this.theme.bold(` ${this.opts.title} `)) +
			  this.theme.fg("muted", `${this.status} · opens links · drag selects+copies · Ctrl+←/Ctrl+\\ detach`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pty-attach-delete-gate.test.mjs test/pty-attach-detach-gate.test.mjs`
Expected: PASS both files — the new gate keys all true, and the pre-existing detach-gate scenarios stay green (no key routing regressions).

- [ ] **Step 5: Commit**

```bash
git add src/ui/pty-attach.ts test-support/detach-gate-smoke.ts test/pty-attach-delete-gate.test.mjs
git commit -m "feat(attach): ctrl+x in-place delete confirm with teardown-first exit"
```

### Task 4: Command layer + board reopen plumbing (spec A5, A6)

**Files:**
- Modify: `src/commands/agent-board.ts` — `AttachOutcome` `:137`, `dashboardAttachLoop` `:139-161`, `openDashboard` options `:74-80` + deps pass `:104`, `attach()` open-pty branch `:187-192`
- Modify: `src/ui/dashboard.ts` — `DashboardDeps` `:116-124`, ctor `:175`
- Create: `test-support/attach-delete-flow-probe.ts`
- Test: `test/attach-delete-flow.test.mjs` (new)

**Interfaces:**
- Consumes: `nextVisibleIdAfterRemoval` (Task 2), `PtyAttachResult` `{action:"delete"}` (Task 3), `DashboardDeps.initialNotice` (this task).
- Produces: `AttachOutcome.afterDelete?: { nextSelectedId: string | null; notice: string }`; `openDashboard` option `initialNotice?: string`.

- [ ] **Step 1: Write the failing flow probe + test**

`test-support/attach-delete-flow-probe.ts` (pattern: `navigation-wrap.ts` service construction + scripted `ctx.ui.custom`):

```ts
// A5/A6 probe (issue #147): drive the REAL dashboardAttachLoop with a stub
// ctx and a real temp-root service. ui.custom is scripted two-stage: the
// board stage runs the factory (constructing a real DashboardComponent whose
// deps we capture) and resolves the attach action; the PTY stage resolves the
// component result {action:"delete"} without a factory run. service.resolveAttachTarget
// is stubbed to {kind:"pty"} — the stub custom never connects a socket (spec §5
// exception). DEL_FLOW_MODE=archive-fail stubs service.archive for A6.
// Run via `node --experimental-transform-types`.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { createView } from "../src/core/store.mjs";
import { dashboardAttachLoop } from "../src/commands/agent-board.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-del-flow-"));
createView(root, { id: "v1", name: "one", cwd: root });
createView(root, { id: "v2", name: "two", cwd: root });
createView(root, { id: "v3", name: "three", cwd: root });

const service = createService({
	root,
	runnerScript: "/no/runner.mjs",
	piCommand: "pi",
	piArgsPrefix: [],
	defaultCwd: root,
	launch: () => ({ pid: null, configPath: "/no/config.json" }),
	launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
	launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
});

// Session files must exist so "archive preserves the session file" is a real assertion.
for (const id of ["v1", "v2", "v3"]) {
	const meta = JSON.parse(readFileSync(join(root, "views", id, "meta.json"), "utf8"));
	if (meta.sessionFile && !existsSync(meta.sessionFile)) writeFileSync(meta.sessionFile, "");
}

const stub = service as unknown as { resolveAttachTarget: (id: string) => Promise<unknown>; archive: (id: string) => Promise<{ ok: boolean; error?: string }> };
stub.resolveAttachTarget = async () => ({ kind: "pty", socketPath: join(root, "fake.sock") });
const archiveCalls: string[] = [];
const realArchive = service.archive.bind(service);
if (process.env.DEL_FLOW_MODE === "archive-fail") {
	stub.archive = async (id: string) => { archiveCalls.push(id); return { ok: false, error: "boom" }; };
} else {
	stub.archive = async (id: string) => { archiveCalls.push(id); return realArchive(id); };
}

const notifications: Array<{ text: string; level: string }> = [];
const boardDeps: Array<{ initialSelectedId: string | null; initialNotice?: string }> = [];
let stage = 0;
const fakeTui = { terminal: { rows: 24, cols: 80, columns: 80, write() {} }, requestRender() {} };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

const ctx = {
	cwd: root,
	model: null,
	modelRegistry: { getAvailable: () => [] },
	sessionManager: { getSessionFile: () => null },
	ui: {
		setWorkingVisible() {},
		setHeader() {},
		setFooter() {},
		setTitle() {},
		notify: (text: string, level: string) => notifications.push({ text, level }),
		custom: (factory: (t: unknown, th: unknown, kb: unknown, done: (r: unknown) => void) => unknown) =>
			new Promise((resolve) => {
				stage += 1;
				if (stage === 2) {
					resolve({ action: "delete" });
					return;
				}
				const comp = factory(fakeTui, theme, {}, (result: unknown) => resolve(result)) as unknown as {
					deps: { initialSelectedId: string | null; initialNotice?: string };
					done: (r: unknown) => void;
					dispose?: () => void;
				};
				boardDeps.push({ initialSelectedId: comp.deps.initialSelectedId, initialNotice: comp.deps.initialNotice });
				comp.done(stage === 1 ? { action: "attach", viewId: "v2", stopFirst: false } : { action: "exit" });
				comp.dispose?.();
			}),
	},
};

await dashboardAttachLoop(ctx as never, service, root, null);

const v2Meta = JSON.parse(readFileSync(join(root, "views", "v2", "meta.json"), "utf8"));
const sessionExists = existsSync(String(v2Meta.sessionFile));
const rowsAfter = (await import("../src/core/store.mjs")).listRows(root).map((r) => r.meta.id);
const report = {
	error: null as string | null,
	archived: v2Meta.archived === true,
	sessionExists,
	rowsAfter,
	archiveCalls,
	notifications,
	boardDeps,
	stage,
};
try {
	console.log(JSON.stringify(report));
} finally {
	rmSync(root, { recursive: true, force: true });
}
```

`test/attach-delete-flow.test.mjs`:

```js
// test/attach-delete-flow.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "attach-delete-flow-probe.ts");

function runProbe(mode) {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, ...(mode ? { DEL_FLOW_MODE: mode } : {}) },
	});
	return JSON.parse(out.trim().split("\n").filter(Boolean).at(-1));
}

// A5: the loop archives the deleted row, preserves its session file, and the
// reopened board receives the neighbor id + the Deleted notice.
test("attach delete flow: archive + board reopen params (issue #147 A5)", () => {
	const r = runProbe();
	assert.equal(r.error, null);
	assert.equal(r.archived, true, "v2 must be archived");
	assert.equal(r.sessionExists, true, "session file must be preserved");
	assert.deepEqual(r.archiveCalls, ["v2"], "exactly one archive call for the deleted view");
	assert.ok(!r.rowsAfter.includes("v2"), "archived row leaves the board list");
	assert.equal(r.boardDeps.length, 2, "two board opens (attach pick + post-delete reopen)");
	assert.equal(r.boardDeps[1].initialSelectedId, "v3", "neighbor id lands on the reopened board");
	assert.equal(r.boardDeps[1].initialNotice, 'Deleted "two"', "the notice lands on the reopened board");
	assert.deepEqual(r.notifications, [], "no notifications on the happy path");
});

// A6: archive failure is not silent — an error notify fires, the loop still
// reopens the board, and nothing throws.
test("attach delete flow: archive failure notifies (issue #147 A6)", () => {
	const r = runProbe("archive-fail");
	assert.equal(r.error, null);
	assert.deepEqual(r.archiveCalls, ["v2"]);
	assert.ok(r.notifications.some((n) => n.level === "error" && n.text.includes("boom")), "error notify fires");
	assert.equal(r.boardDeps.length, 2, "board still reopens after the failure");
	assert.equal(r.archived, false, "row stays (archive stubbed to fail)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/attach-delete-flow.test.mjs`
Expected: FAIL — `boardDeps.length` is 1 (no delete branch: the PTY stage's `{action:"delete"}` maps to `detached`, no `afterDelete`, no `initialNotice` dep) or `archived` is false.

- [ ] **Step 3: Implement the command layer + dashboard dep**

(a) `src/ui/dashboard.ts` — deps interface (`:116-124`) gains one field, ctor consumes it right after `this.selectedId = deps.initialSelectedId ?? null;` (`:175`):

```ts
	initialSelectedId?: string | null;
	initialNotice?: string;
```

```ts
		this.selectedId = deps.initialSelectedId ?? null;
		// Issue #147: the post-delete reopen carries the Deleted notice here —
		// the component is new each open, so an inline notice cannot travel.
		if (deps.initialNotice) this.notice(deps.initialNotice, "info");
```

(b) `src/commands/agent-board.ts` — import the Task 2 helper:

```ts
import { nextVisibleIdAfterRemoval } from "../core/rows.mjs";
```

`AttachOutcome` (`:137`):

```ts
type AttachOutcome = { action: "detached" | "closed" | "switched" | "none"; afterDelete?: { nextSelectedId: string | null; notice: string } };
```

`dashboardAttachLoop` (`:139-161`) — thread the notice and neighbor:

```ts
	let selectedId = initialSelectedId;
	let again = true;
	let pendingNotice: string | undefined;
	while (again) {
		const currentId = currentViewId(ctx, service);
		if (currentId) void service.markVisited?.(currentId)?.catch(() => {});
		void service.reconcile().catch(() => {});
		const result = await openDashboard(ctx, service, {
			initialSelectedId: selectedId,
			currentThinkingLevel: getThinkingLevel?.(),
			initialNotice: pendingNotice,
		});
		pendingNotice = undefined;
		if (result.action !== "attach") return;
		selectedId = result.viewId;
		const outcome = await attach(ctx, service, root, result.viewId, result.stopFirst);
		if (outcome.afterDelete) {
			// Issue #147: land on the neighbor (null -> deleted id -> existing
			// orderedIds[0] clamp) and show the Deleted notice once.
			selectedId = outcome.afterDelete.nextSelectedId ?? selectedId;
			pendingNotice = outcome.afterDelete.notice;
		}
		again = outcome.action === "detached" || outcome.action === "closed" || outcome.action === "none";
	}
```

`openDashboard` options (`:74-80`) + deps pass (`:104`):

```ts
		initialSelectedId?: string | null;
		initialNotice?: string;
```

```ts
					initialSelectedId: options.initialSelectedId,
					initialNotice: options.initialNotice,
```

`attach()` open-pty branch (`:187-192`):

```ts
	if (plan.plan === "open-pty") {
		void service.markVisited?.(viewId)?.catch(() => {});
		const result = await openPtyAttach(ctx, root, row.meta.id, row.meta.name, plan.socketPath);
		void service.markVisited?.(viewId)?.catch(() => {});
		if (result.action === "delete") {
			// Issue #147: the component already tore down and exited — archive
			// here so the host's death is never rendered inside the attach view.
			// Neighbor and name are computed BEFORE archiving (rows change).
			const latest = service.row(viewId) ?? row;
			const name = latest.meta.name;
			const nextSelectedId = nextVisibleIdAfterRemoval(service.rows(), viewId, Date.now());
			const res = await service.archive(viewId);
			if (!res.ok) ctx.ui.notify(res.error ?? "Delete failed", "error");
			else return { action: "detached", afterDelete: { nextSelectedId, notice: `Deleted "${name}"` } };
			return { action: "detached" };
		}
		return { action: result.action === "closed" ? "closed" : "detached" };
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/attach-delete-flow.test.mjs`
Expected: PASS (both A5 and A6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/agent-board.ts src/ui/dashboard.ts test-support/attach-delete-flow-probe.ts test/attach-delete-flow.test.mjs
git commit -m "feat(board): archive from the attach view and reopen on the neighbor row"
```

### Task 5: Docs sync + full verification + manual checklist (spec A7, A8, U1–U4)

**Files:**
- Modify: `README.md:96` (quick-start attach paragraph) and `README.md:201` (PTY attach section paragraph)

**Interfaces:**
- Consumes: everything above; this task changes no code.

- [ ] **Step 1: README copy (both paragraphs get the same two sentences appended)**

Append to the end of both the `:96` quick-start paragraph and the `:201` attach-section paragraph:

```markdown
`Ctrl+X` opens an in-place delete confirm: press `y` (or Enter) to archive the row and return to the board with the next row selected — any other key cancels and is passed through to the session. While attached, the child Pi's own `Ctrl+X` bindings (copy in `/tree` and fullscreen, clear-all in the models dialog) are captured by this gesture.
```

- [ ] **Step 2: Static checks (A7)**

Run: `npm run typecheck && rg -n "Ctrl\+X.*opens an in-place delete confirm" README.md`
Expected: typecheck 0 errors; exactly 2 README hits (both attach paragraphs); board copy untouched (`rg -n "x., then .y. to confirm" README.md` still matches `:118`).

- [ ] **Step 3: Full verification (A8)**

Run: `npm run verify`
Expected: typecheck + perf gate + full test suite + coverage thresholds (lines 85 / funcs 80 / branches 70) + pack:dry all green, no new failures vs `884040f`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the attach in-place delete gesture"
```

- [ ] **Step 5: Post-implementation manual verification (U1–U4) — user-executed, spec §4**

Record results in the PR description (these gate the merge, not the implementation):

- **U1**: on a checkout installed via `pi install "$(pwd)"` (or dev auto-discovery), restart pi, open the board, attach an idle session, press `Ctrl+X` (prompt appears), press `y` → row gone, `Deleted "name"` visible, selection on the neighbor row, session file still present, host stopped (no leftover pid).
- **U2**: attach → `Ctrl+X` → `n` → keep typing → session not deleted, no characters lost. Also: `Ctrl+X` twice → prompt clears, nothing forwarded, then typing `y` is ordinary input.
- **U3**: attach a Working session → `Ctrl+X` → `y` → run stops then archives; back at the board with no `host exited` / reconnect banner flash.
- **U4**: kill the host process (or wait for exited) → `Ctrl+X` → `y` → still deletes and returns to the board.

---

## Self-Review (done at plan time)

1. **Spec coverage:** A1→Task 1, A2→Task 2, A3+A4→Task 3 (Q1–Q8 + encodings), A5+A6→Task 4, A7+A8→Task 5 steps 2-3, U1–U4→Task 5 step 5. Spec §3.4.1-3.4.6 all map to Tasks 1-5; §3.5 boundary behaviors are pinned by Q3/Q4 (no-swallow/no-hang), Q8 (teardown), A6 (failure). Non-goals: no task touches board keys, archive internals, session-switch, or attach-flow.ts. ✔
2. **Placeholder scan:** no TBD/TODO; every code step carries real code; run commands and expected outcomes are explicit. ✔
3. **Type consistency:** `resolveAttachDeleteKey` five-action union used identically in Task 1 (impl) and Task 3 (component); `afterDelete` shape identical in Task 4's AttachOutcome and loop; `initialNotice` identical in dashboard deps and openDashboard options. ✔
4. **Review Focus:** all five lines pinned (Q3-Q8, A1-pure, Q2, A5/A6). ✔
