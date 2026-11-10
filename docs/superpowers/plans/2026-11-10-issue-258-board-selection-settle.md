# Board Selection Settle (issue #258) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In fullscreen, clear pi-tui's selection highlight right after copy-on-select when a selection gesture ends inside the board — via a shared settle core that the attach view is also refactored onto.

**Architecture:** A new pure core module (`src/core/fullscreen-selection.mjs`) owns the deferred-settle logic (gesture serial + `shouldSettle` lifecycle gate + read/mirror/copyOnSelect/clear/repaint order) with every side effect injected. `PtyAttachComponent` deletes its inline implementation and instantiates the core; `DashboardComponent` gains a `handleMouse` observer (always returns `undefined`) plus a `disposed` gate. Four test layers: unit (core), component harness (attach regression, board wiring), real-renderer harness (SGR dispatch chain), full gate.

**Tech Stack:** TypeScript components under `src/ui/`, JS core under `src/core/`, `node:test` + `assert/strict`, child-process scenario harnesses under `test-support/` launched with `node --experimental-transform-types`.

**Spec:** `docs/superpowers/specs/2026-11-10-issue-258-board-selection-settle-design.md` (acceptance IDs A1–A5, U1–U2 referenced per task).

## Global Constraints

- Tabs for indentation; English comments and commit subjects; conventional commit types (`feat`/`fix`/`refactor`/`test`/`docs`).
- `node --test test/<file>` for targeted runs; every scenario harness is a child process that prints ONE JSON line consumed by its wrapper test (see `test/pty-attach-selection-mirror.test.mjs`).
- `settleFullscreenSelection` semantics must stay byte-compatible on the attach path: mirror before the `copyOnSelect` check; clear is NOT governed by `AGENT_BOARD_ATTACH_NATIVE_PASTE` (the env gate lives inside `writePrimarySelection`).
- Never call `resetTextSelection()`; only feature-detected `clearTextSelection()`.
- Existing assertions in `test/pty-attach-selection-mirror.test.mjs` and `test/dashboard-fold.test.mjs` must not be modified — only appended to / new files added.
- Work from the worktree ONLY (this directory); never touch the main checkout.

---

### Task 1: `FullscreenSelectionSettler` core + unit tests (A1)

**Files:**
- Create: `src/core/fullscreen-selection.mjs`
- Create: `test/fullscreen-selection.test.mjs`

**Interfaces:**
- Consumes: `isFullscreenSelectionEnd(event)` from `./pty-scroll.mjs` (exists, `src/core/pty-scroll.mjs:279`).
- Produces: `createFullscreenSelectionSettler(options) -> { observeMouse(event) }` where options = `{ host, mirror?, repaint?, schedule?, shouldSettle? }` and host = `{ getActiveSelectionText?, getCopyOnSelect?, clearTextSelection? }` (all optional, feature-detected). Tasks 2 and 3 construct it; nothing else consumes the module.

- [ ] **Step 1: Write the failing tests**

`test/fullscreen-selection.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createFullscreenSelectionSettler } from "../src/core/fullscreen-selection.mjs";

const leftEvent = (type, x = 3, y = 3) => ({ type, button: "left", x, y, screenX: x, screenY: y, width: 80, height: 22, shift: false });

/** Manual scheduler: collect callbacks, flush explicitly. Mirrors process.nextTick ordering without wall-clock. */
const manualQueue = () => {
	const q = [];
	return { q, schedule: (cb) => q.push(cb), flush: () => { while (q.length) q.shift()(); } };
};

/** Counting host fixture; clear invalidates text so a read-after-clear order yields no mirror text. */
const makeHost = ({ text = "fixture-text", copyOnSelect = true, withClear = true } = {}) => {
	const state = { text, copyOnSelect, reads: 0, clears: 0, repaints: 0, mirrored: [] };
	return {
		state,
		host: {
			getActiveSelectionText: () => { state.reads += 1; return state.text; },
			getCopyOnSelect: () => state.copyOnSelect,
			...(withClear ? { clearTextSelection: () => { state.clears += 1; state.text = undefined; } } : {}),
		},
	};
};

test("settler: left release defers settle via the injected scheduler, then clears and repaints once", () => {
	const { q, schedule, flush } = manualQueue();
	const { state, host } = makeHost();
	const s = createFullscreenSelectionSettler({ host, repaint: () => { state.repaints += 1; }, schedule });
	s.observeMouse(leftEvent("release"));
	assert.equal(state.reads, 0, "nothing may run synchronously");
	flush();
	assert.equal(state.reads, 1);
	assert.equal(state.clears, 1);
	assert.equal(state.repaints, 1);
});

test("settler: empty or absent selection text never clears, never mirrors", () => {
	for (const text of [undefined, ""]) {
		const { q, schedule, flush } = manualQueue();
		const mirrored = [];
		const { state, host } = makeHost({ text });
		const s = createFullscreenSelectionSettler({ host, mirror: (t) => mirrored.push(t), schedule });
		s.observeMouse(leftEvent("release"));
		flush();
		assert.equal(state.clears, 0, `text=${String(text)}`);
		assert.equal(mirrored.length, 0, `text=${String(text)}`);
	}
});

test("settler: copyOnSelect=false mirrors but keeps the selection for Ctrl+X", () => {
	const { schedule, flush } = manualQueue();
	const mirrored = [];
	const { state, host } = makeHost({ copyOnSelect: false });
	const s = createFullscreenSelectionSettler({ host, mirror: (t) => mirrored.push(t), schedule });
	s.observeMouse(leftEvent("release"));
	flush();
	assert.equal(mirrored.length, 1);
	assert.equal(mirrored[0], "fixture-text", "mirror runs before the copyOnSelect check and reads live text");
	assert.equal(state.clears, 0);
});

test("settler: missing clearTextSelection degrades without throwing", () => {
	const { schedule, flush } = manualQueue();
	const { state, host } = makeHost({ withClear: false });
	const s = createFullscreenSelectionSettler({ host, schedule });
	s.observeMouse(leftEvent("release"));
	assert.doesNotThrow(flush);
	assert.equal(state.clears, 0);
});

test("settler: read-before-clear order (mirror receives live text even though clear invalidates it)", () => {
	const { schedule, flush } = manualQueue();
	const mirrored = [];
	const { host } = makeHost();
	const s = createFullscreenSelectionSettler({ host, mirror: (t) => mirrored.push(t), schedule });
	s.observeMouse(leftEvent("release"));
	flush();
	assert.equal(mirrored[0], "fixture-text", "text was read before clearTextSelection invalidated it");
});

test("settler: a release followed by a new left press in the same tick is dropped (gesture serial)", () => {
	const { q, schedule, flush } = manualQueue();
	const { state, host } = makeHost();
	const s = createFullscreenSelectionSettler({ host, schedule });
	s.observeMouse(leftEvent("release", 3, 3));
	s.observeMouse(leftEvent("press", 9, 9));
	flush();
	assert.equal(q.length, 1, "only the release queued a settle");
	assert.equal(state.reads, 0, "the queued settle must not consume the new gesture");
	assert.equal(state.clears, 0);
});

test("settler: left click also settles; press/move/right/middle/wheel never do", () => {
	const { schedule, flush } = manualQueue();
	const { state, host } = makeHost();
	const s = createFullscreenSelectionSettler({ host, schedule });
	s.observeMouse(leftEvent("click"));
	flush();
	assert.equal(state.clears, 1, "click is a selection end");
	const nonEndings = [
		{ type: "press", button: "left" },
		{ type: "move", button: "left" },
		{ type: "press", button: "right" },
		{ type: "press", button: "middle" },
		{ type: "wheel", button: "none" },
	];
	for (const ev of nonEndings) s.observeMouse({ ...leftEvent("press"), ...ev });
	flush();
	assert.equal(state.clears, 1, "no non-ending cleared again");
});

test("settler: shouldSettle() === false blocks before any host read, mirror, clear or repaint", () => {
	const { schedule, flush } = manualQueue();
	const mirrored = [];
	const { state, host } = makeHost();
	const s = createFullscreenSelectionSettler({
		host,
		mirror: (t) => mirrored.push(t),
		repaint: () => { state.repaints += 1; },
		schedule,
		shouldSettle: () => false,
	});
	s.observeMouse(leftEvent("release"));
	flush();
	assert.equal(state.reads, 0, "gate is checked before the host read");
	assert.equal(mirrored.length, 0);
	assert.equal(state.clears, 0);
	assert.equal(state.repaints, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/fullscreen-selection.test.mjs`
Expected: FAIL — cannot find module `../src/core/fullscreen-selection.mjs`.

- [ ] **Step 3: Write the core module**

`src/core/fullscreen-selection.mjs`:

```js
import { isFullscreenSelectionEnd } from "./pty-scroll.mjs";

/**
 * Issue #258 (+ #172/#174 refactor): one place that settles pi's fullscreen
 * selection after copy-on-select, so the attach overlay and the board cannot
 * drift. All I/O is injected (repo convention: pure/testable core, thin shell).
 *
 * host: the TuiAltScreen-shaped seam — getActiveSelectionText /
 *   clearTextSelection are private in pi-tui typings (runtime plain methods),
 *   getCopyOnSelect is public. Every access is feature-detected so an older or
 *   newer pi-tui degrades to the pre-settle behaviour instead of throwing.
 * mirror: attach passes its X11 PRIMARY write (self-gated on
 *   AGENT_BOARD_ATTACH_NATIVE_PASTE inside writePrimarySelection); the board omits it.
 * repaint: schedules one repaint after a successful clear.
 * schedule: deferral transport, defaults to process.nextTick — overlays are
 *   dispatched BEFORE TuiAltScreen finalizes and copies the selection, so the
 *   settle must run after that event completes (issue #174).
 * shouldSettle: runtime lifecycle gate — checked inside the deferred callback
 *   before any host read. attach passes () => !this.closed; the board passes
 *   () => !this.disposed. The gesture serial cannot cover unmount/close: it
 *   only grows on presses this component still observes.
 */
export function createFullscreenSelectionSettler({ host, mirror, repaint, schedule = (cb) => process.nextTick(cb), shouldSettle } = {}) {
	let serial = 0;
	const settle = () => {
		if (typeof shouldSettle === "function" && !shouldSettle()) return;
		const text = host.getActiveSelectionText?.();
		if (typeof text !== "string" || text.length === 0) return;
		if (mirror) mirror(text);
		if (host.getCopyOnSelect?.() === false) return;
		if (typeof host.clearTextSelection !== "function") return;
		host.clearTextSelection();
		repaint?.();
	};
	return {
		/** Observe only — never consumes; callers return undefined for these events. */
		observeMouse(event) {
			if (!event || typeof event !== "object") return;
			if (event.type === "press" && event.button === "left") serial += 1;
			if (!isFullscreenSelectionEnd(event)) return;
			const captured = serial;
			schedule(() => {
				if (captured !== serial) return;
				settle();
			});
		},
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/fullscreen-selection.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/fullscreen-selection.mjs test/fullscreen-selection.test.mjs
git commit -m "feat(core): shared fullscreen selection settler (issue #258)"
```

**Acceptance: A1**

---

### Task 2: Refactor attach onto the core (A2)

**Files:**
- Modify: `src/ui/pty-attach.ts` (handleMouse selection block ~`:854-868`; `selectionGestureSerial` field `:555`; `settleFullscreenSelection` `:2432-2447`; export the host interface `:36`)
- Modify: `test-support/pty-attach-selection-mirror-scenario.ts` (append case 8 + two result fields)
- Modify: `test/pty-attach-selection-mirror.test.mjs` (append two assertions inside the existing test — existing assertions untouched)

**Interfaces:**
- Consumes: `createFullscreenSelectionSettler` from `../core/fullscreen-selection.mjs` (Task 1).
- Produces: `export interface FullscreenSelectionHost` in `src/ui/pty-attach.ts` — Task 3 imports this type for its own host cast.

- [ ] **Step 1: Append the failing case to the scenario**

In `test-support/pty-attach-selection-mirror-scenario.ts`, add `closedWrites: -1, closedClears: -1,` to the `result` object, then append after the last existing case (keep every existing case byte-identical):

```ts
	// 8. Issue #258 shared-core guard, attach wiring: a settle queued before
	// close() must not fire after the component is closed.
	await withComponent(undefined, async (c) => {
		resetFixture();
		const before = writes().length;
		(c as any).handleMouse(leftEvent("release"));
		(c as any).close();
		await sleep(80);
		result.closedWrites = writes().length - before;
		result.closedClears = clearCalls;
	});
```

- [ ] **Step 2: Append the failing assertions to the wrapper test**

At the end of the existing `test(...)` body in `test/pty-attach-selection-mirror.test.mjs` (after the `coalescedClears` assertion):

```js
	// Issue #258: the closed-gate must survive the shared-core refactor.
	assert.equal(parsed.closedWrites, 0, "a settle queued before close() must not mirror after close");
	assert.equal(parsed.closedClears, 0, "a settle queued before close() must not clear after close");
```

- [ ] **Step 3: Run to verify the new case fails**

Run: `node --test test/pty-attach-selection-mirror.test.mjs`
Expected: FAIL — `closedClears` is 1 (today's inline settle has the guard only in `settleFullscreenSelection`'s `this.closed` check, which the refactor must preserve; the failing assertion proves the case exercises the path). If it already passes, stop and re-check the case actually queues before close.

- [ ] **Step 4: Refactor `src/ui/pty-attach.ts`**

1. Add to imports: `import { createFullscreenSelectionSettler } from "../core/fullscreen-selection.mjs";` (place alphabetically near the existing `../core/pty-scroll.mjs` import).
2. Change `interface FullscreenSelectionHost` (`:36`) to `export interface FullscreenSelectionHost` (Task 3 imports it).
3. Delete the `private selectionGestureSerial = 0;` field (`:555`).
4. Add a field `private readonly selectionSettler: ReturnType<typeof createFullscreenSelectionSettler>;` and initialize it in the constructor body (after `this.tui`/fields it references exist):

```ts
		this.selectionSettler = createFullscreenSelectionSettler({
			host: this.tui as FullscreenSelectionHost,
			mirror: (text) => this.writePrimarySelection(text),
			repaint: () => this.scheduleRender(),
			shouldSettle: () => !this.closed,
		});
```

5. In `handleMouse`, replace the `Issue #172` press-bump + `isFullscreenSelectionEnd` defer block (`:854-868`) with:

```ts
		// Issue #172 + #258: observe the gesture; the shared settler owns the
		// serial guard, the deferral and the lifecycle gate.
		this.selectionSettler.observeMouse(event);
		if (isFullscreenSelectionEnd(event)) return undefined;
```

(keep the surrounding `nativePasteEnabled` removal if it is no longer referenced below — verify with `rg nativePasteEnabled src/ui/pty-attach.ts` and drop dead locals).

6. Delete the whole `settleFullscreenSelection` method (`:2432-2447`) and the `Issue #174 (B2) + #172` doc comment above it. Keep `writePrimarySelection` (the mirror target) untouched.

- [ ] **Step 5: Run the attach mirror tests to verify everything passes**

Run: `node --test test/pty-attach-selection-mirror.test.mjs`
Expected: PASS — all existing assertions AND the two new ones.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/ui/pty-attach.ts test-support/pty-attach-selection-mirror-scenario.ts test/pty-attach-selection-mirror.test.mjs
git commit -m "refactor(attach): move the fullscreen selection settle onto the shared core (issue #258)"
```

**Acceptance: A2**

---

### Task 3: Board wiring + component harness (A3)

**Files:**
- Modify: `src/ui/dashboard.ts` (constructor, `dispose()` `:1266`, add `handleMouse`, add `disposed` flag, imports)
- Create: `test-support/dashboard-selection-settle-scenario.ts`
- Create: `test/dashboard-selection-settle.test.mjs`

**Interfaces:**
- Consumes: `createFullscreenSelectionSettler` (Task 1); `FullscreenSelectionHost` type (Task 2 export); `TuiMouseEvent`/`TuiMouseEventResult` from `@earendil-works/pi-tui` (already the import source in `pty-attach.ts:6`).
- Produces: `DashboardComponent.handleMouse(event): undefined` — pi-tui's overlay dispatch calls it (Task 4 proves this through the real renderer).

- [ ] **Step 1: Write the failing scenario harness**

`test-support/dashboard-selection-settle-scenario.ts` (child process; prints one JSON line):

```ts
// Component-level coverage for issue #258: the REAL DashboardComponent with a
// fake fullscreen TUI exposing the pi-tui selection seam, driven via handleMouse
// directly (the #172 pty-attach-selection-mirror-scenario.ts pattern).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createView, listRows } from "../src/core/store.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const root = mkdtempSync(join(tmpdir(), "board-settle-"));
let selectionText: string | undefined = "board-fixture-text";
let clearCalls = 0;
let readCalls = 0;
let renderCalls = 0;

const resetFixture = () => {
	selectionText = "board-fixture-text";
	clearCalls = 0;
	readCalls = 0;
	renderCalls = 0;
};

const tui = {
	mode: "fullscreen",
	getActiveSelectionText: () => { readCalls += 1; return selectionText; },
	getCopyOnSelect: () => true,
	clearTextSelection: () => { clearCalls += 1; selectionText = undefined; },
	requestRender: () => { renderCalls += 1; },
	terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
};

const leftEvent = (type: "release" | "click" | "press" | "move", x = 3, y = 3) => ({
	type, button: "left", x, y, screenX: x, screenY: y, width: 80, height: 22, shift: false,
});

const base = (() => {
	createView(root, { id: "base", name: "base", cwd: root });
	return listRows(root)[0];
})();
const rows = Array.from({ length: 6 }, (_, i) => ({
	...base,
	meta: { ...base.meta, id: `v${i}`, name: `settle-case-${i}`, createdAt: i, cwd: root, repoCwd: root },
	state: { ...base.state, semanticState: i < 3 ? "needs_input" : "idle" },
}));
const service = {
	rows: () => rows,
	row: (id: string) => rows.find((row) => row.meta.id === id),
	prewarmHost: () => ({ ok: false }),
	ptyHealth: () => ({ ok: true, reason: null, staleHosts: 0, liveHosts: 0 }),
	getLaunchPrefs: () => null,
	reconcile: async () => {},
};

const result = {
	error: null as string | null,
	releaseUndefined: false,
	listClears: -1, listRenders: -1,
	coalescedClears: -1,
	nonEndingClears: -1,
	filterMode: false, filterClears: -1,
	launchMode: false, launchClears: -1,
	disposeRaceReads: -1, disposeRaceClears: -1, disposeRaceRenders: -1,
};

const open = () => new DashboardComponent(
	tui as never,
	{ fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t } as never,
	{ matches: () => false } as never,
	() => { throw new Error("unexpected attach/exit"); },
	{ service: service as never, root, defaultCwd: root, availableModels: [], currentModel: null, currentThinkingLevel: "off" } as never,
);

let dash: any;
try {
	// 1. List mode: left release defers one tick, then clears and repaints; never consumes.
	dash = open();
	resetFixture();
	result.releaseUndefined = dash.handleMouse(leftEvent("release")) === undefined;
	await sleep(30);
	result.listClears = clearCalls;
	result.listRenders = renderCalls;

	// 2. Release + new press in one tick: the queued settle is dropped.
	resetFixture();
	dash.handleMouse(leftEvent("release", 3, 3));
	dash.handleMouse(leftEvent("press", 9, 9));
	await sleep(30);
	result.coalescedClears = clearCalls;

	// 3. Non-endings never settle (right/middle press, move, wheel-shaped event).
	resetFixture();
	dash.handleMouse({ ...leftEvent("press"), button: "right" });
	dash.handleMouse({ ...leftEvent("press"), button: "middle" });
	dash.handleMouse(leftEvent("move"));
	dash.handleMouse({ type: "wheel", button: "none", x: 3, y: 3, screenX: 3, screenY: 3, width: 80, height: 22, shift: false });
	await sleep(30);
	result.nonEndingClears = clearCalls;

	// 4. Editor-bearing mode (filter): same observer, same settle (spec D6).
	resetFixture();
	dash.startFilter();
	result.filterMode = dash.mode === "filter";
	dash.handleMouse(leftEvent("release"));
	await sleep(30);
	result.filterClears = clearCalls;
	dash.toListMode();

	// 5. Editor-bearing mode (launch): same observer, same settle (spec D6).
	resetFixture();
	dash.input = "probe";
	dash.openLaunchDialog();
	result.launchMode = dash.mode === "launch";
	dash.handleMouse(leftEvent("release"));
	await sleep(30);
	result.launchClears = clearCalls;

	// 6. Unmount race (R2-D1): dispose() before flush blocks before any host
	// read even when the host already carries a newer UI's selection.
	resetFixture();
	dash.handleMouse(leftEvent("release"));
	const readsBeforeDispose = readCalls;
	dash.dispose();
	selectionText = "newer-ui-selection";
	await sleep(30);
	result.disposeRaceReads = readCalls - readsBeforeDispose;
	result.disposeRaceClears = clearCalls;
	result.disposeRaceRenders = renderCalls;
} catch (err) {
	result.error = err instanceof Error ? err.stack : String(err);
} finally {
	try { dash?.dispose(); } catch { /* already disposed in case 6 */ }
	rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
```

- [ ] **Step 2: Write the failing wrapper test**

`test/dashboard-selection-settle.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "dashboard-selection-settle-scenario.ts");

// Issue #258: the board must settle pi's fullscreen selection after
// copy-on-select, through the same shared core the attach view uses.
test("dashboard selection settle: board observes mouse, defers settle, gates on dispose", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.releaseUndefined, true, "handleMouse must never consume (returns undefined)");
	assert.equal(parsed.listClears, 1, "list-mode release clears pi's selection exactly once");
	assert.equal(parsed.listRenders, 1, "a successful clear schedules exactly one repaint");
	assert.equal(parsed.coalescedClears, 0, "a release+press in one tick must not clear the new gesture");
	assert.equal(parsed.nonEndingClears, 0, "right/middle/move/wheel events never settle");
	assert.equal(parsed.filterMode, true, "case 4 must actually enter filter mode");
	assert.equal(parsed.filterClears, 1, "editor-bearing mode (filter) settles the same way (D6)");
	assert.equal(parsed.launchMode, true, "case 5 must actually enter launch mode");
	assert.equal(parsed.launchClears, 1, "editor-bearing mode (launch) settles the same way (D6)");
	assert.equal(parsed.disposeRaceReads, 0, "dispose() before flush blocks before any host read (R2-D1)");
	assert.equal(parsed.disposeRaceClears, 0, "dispose() before flush must not clear");
	assert.equal(parsed.disposeRaceRenders, 0, "dispose() before flush must not repaint");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/dashboard-selection-settle.test.mjs`
Expected: FAIL — `dash.handleMouse is not a function`.

- [ ] **Step 4: Wire the board**

In `src/ui/dashboard.ts`:

1. Imports — add near the existing pi-tui type import (`:3`): `TuiMouseEvent, TuiMouseEventResult` inside the existing `import type { ... } from "@earendil-works/pi-tui";` line. Add `import { createFullscreenSelectionSettler } from "../core/fullscreen-selection.mjs";` and `import type { FullscreenSelectionHost } from "./pty-attach.ts";` with the other core/ui imports.
2. Fields — next to `private needsFullClear = true;`:

```ts
	/** Issue #258: set at dispose() so a settle queued before unmount cannot
	 * touch pi-level selection state afterwards (the gesture serial only grows
	 * on presses this component still observes). */
	private disposed = false;
	private readonly selectionSettler: ReturnType<typeof createFullscreenSelectionSettler>;
```

3. Constructor body — after `this.selectedId = deps.initialSelectedId ?? null;`:

```ts
		this.selectionSettler = createFullscreenSelectionSettler({
			host: tui as unknown as FullscreenSelectionHost,
			repaint: () => this.tui.requestRender(),
			shouldSettle: () => !this.disposed,
		});
```

4. `handleInput` (`:314`) — add a sibling method right after it:

```ts
	/** Issue #258: observe-only mouse hook. pi keeps every gesture (selection,
	 * copy, links); the settler only drops the stale highlight after
	 * copy-on-select. Always returns undefined — never consumes. */
	handleMouse(_event: TuiMouseEvent): TuiMouseEventResult | undefined {
		this.selectionSettler.observeMouse(_event);
		return undefined;
	}
```

5. `dispose()` (`:1266`) — set the gate first:

```ts
	dispose(): void {
		/* poll interval is owned by the factory */
		this.disposed = true;
		this.prewarmScheduler.cancel();
	}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/dashboard-selection-settle.test.mjs`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/ui/dashboard.ts test-support/dashboard-selection-settle-scenario.ts test/dashboard-selection-settle.test.mjs
git commit -m "fix(dashboard): settle pi's fullscreen selection highlight after copy-on-release (issue #258)"
```

**Acceptance: A3**

---

### Task 4: Real dispatch chain via SGR injection (A4)

**Files:**
- Modify: `test-support/dashboard-tui-modes.ts` (fullscreen-only mouse case inside the loop, after the folded-navigation assertions and BEFORE the overlay-recreate section)
- Create: `test/dashboard-tui-modes.test.mjs`

**Interfaces:**
- Consumes: the real `TuiAltScreen` selection seam (`getActiveSelectionText`) and the board's `handleMouse` from Task 3; the existing `input`/`frame` helpers and `results` array of the scenario.
- Produces: `mouseSettleOk` field on the fullscreen result entry (`true` after the case passes; `null` for regular mode).

- [ ] **Step 1: Append the failing case to the scenario**

In `test-support/dashboard-tui-modes.ts`, just before the `// Recreate the overlay as the command does...` comment, insert:

```ts
		// Issue #258: real dispatch chain — SGR mouse into the REAL TuiAltScreen,
		// overlay hit-test to DashboardComponent.handleMouse (observe only), pi
		// finalizes + copies, the board's deferred settle clears the selection.
		let mouseSettleOk: boolean | null = null;
		if (mode === "fullscreen") {
			const sel = () => (tui as any).getActiveSelectionText?.();
			assert.ok(!sel(), `${mode}: no selection before the gesture`);
			input("\x1b[<0;5;2M");  // left press  (col 5, row 2)
			input("\x1b[<32;15;2M"); // left drag   (SGR button 32 = motion with button 1)
			const during = sel();
			assert.ok(typeof during === "string" && during.length > 0, `${mode}: drag must establish a non-empty selection (got ${JSON.stringify(during)})`);
			input("\x1b[<0;15;2m"); // left release
			await frame();           // repaint after clear
			await new Promise<void>((resolve) => setImmediate(resolve)); // flush the nextTick settle
			assert.ok(!sel(), `${mode}: release must clear the selection via the board's settler`);
			mouseSettleOk = true;
		}
```

and change the closing push to carry it:

```ts
		results.push({ mode, frames, mouseSettleOk, ok: true });
```

(Existing consumers only read `mode`/`ok` — `test/dashboard-fold.test.mjs` stays untouched and green. If the SGR coordinates fail to establish a selection on the first try, adjusting row/col numbers is acceptable; weakening either assertion is NOT — see the spec's A4 downgrade rule.)

- [ ] **Step 2: Write the failing wrapper test**

`test/dashboard-tui-modes.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "dashboard-tui-modes.ts");

// Issue #258 A4: the full dispatch chain — synthetic SGR drag/release into the
// real TuiAltScreen, overlay hit-test to the board's handleMouse, deferred
// settle clearing pi's selection. Non-empty precondition first (R1-G3).
test("dashboard tui modes: fullscreen SGR drag-select settles through the board", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const results = JSON.parse(out);
	assert.deepEqual(results.map(({ mode }) => mode), ["regular", "fullscreen"]);
	const fullscreen = results.find((r) => r.mode === "fullscreen");
	assert.equal(fullscreen.ok, true);
	assert.equal(fullscreen.mouseSettleOk, true, "fullscreen run must pass the SGR settle case");
	const regular = results.find((r) => r.mode === "regular");
	assert.equal(regular.mouseSettleOk, null, "regular mode has no fullscreen selection seam");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/dashboard-tui-modes.test.mjs`
Expected: FAIL — `mouseSettleOk` is `undefined`/`null` for fullscreen until Task 3's `handleMouse` exists (it does by now) and the scenario case is in; with the case in and something wrong it fails on one of the two assertions.

- [ ] **Step 4: Run to verify it passes (both wrappers)**

Run: `node --test test/dashboard-tui-modes.test.mjs test/dashboard-fold.test.mjs`
Expected: PASS — new wrapper green, existing fold wrapper green.

- [ ] **Step 5: Commit**

```bash
git add test-support/dashboard-tui-modes.ts test/dashboard-tui-modes.test.mjs
git commit -m "test(dashboard): real-dispatch SGR settle case in the tui-modes harness (issue #258)"
```

**Acceptance: A4**

---

### Task 5: Full gate (A5)

**Files:** none (verification only)

- [ ] **Step 1: Run the full verify suite**

Run: `npm run verify`
Expected: exit 0 — typecheck, perf gate, full tests (incl. all four new/extended test files), coverage thresholds, pack:dry.

- [ ] **Step 2: If anything reds**

Fix within the task that owns the file; re-run `npm run verify`. Known unrelated flake signatures live in issue #95's ledger — if a red matches one of those signatures (rerun green in isolation), record it in the PR body, do not chase it here.

**Acceptance: A5**

---

### Task 6: Post-merge manual verification (U1, U2) — cannot run pre-merge

**Files:** none — execution checklist recorded in the PR body.

- [ ] **Step 1: Update the real load checkout** (pi loads the extension from here, not the working copy):

```bash
git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board restore package-lock.json   # or stash — local dirty state, on record 2026-11-10
git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board pull --ff-only
```

- [ ] **Step 2: U1 — drag-select copy clears the highlight**

Fully quit pi, restart in fullscreen, run `/agent-board`, drag-select a session name / log line, release. PASS = the text pastes from CLIPBOARD (Ctrl/Cmd+V — PRIMARY middle-click is NOT a condition, the board does not implement it) AND the inverse-video highlight disappears immediately without another click.

- [ ] **Step 3: U2 — double/triple-click unaffected**

On the same updated instance, double-click a word within 500 ms, then triple-click a line. PASS = word/line selection still happens and copies, and the highlight clears after each.

- [ ] **Step 4: Record results** (PASS/FAIL/pending) in the PR body acceptance ledger before merge; `pending` is acceptable pre-merge, silent skipping is not.

**Acceptance: U1, U2**

---

## Self-Review (run after writing — results)

- **Spec coverage:** D1→Task 1+2, D2→Task 1 (serial in core, unit-tested), D3→Task 1 (clear-only semantics preserved; no resetTextSelection anywhere), D4→Task 2 (attach-only mirror) + Task 3 (board passes no mirror), D5→Task 3 (+dispose gate from R2-D1), D6→Task 3 cases 4-5, A1→Task 1, A2→Task 2, A3→Task 3, A4→Task 4, A5→Task 5, U1/U2→Task 6. No spec acceptance item lacks a task; no task lacks an acceptance ID.
- **Placeholder scan:** no TBD/TODO; every code step carries real code; the only deliberate "adjust if needed" is A4's SGR coordinates (bounded by the no-weakening rule).
- **Type consistency:** `createFullscreenSelectionSettler` signature identical across Tasks 1-3; `FullscreenSelectionHost` exported (Task 2) before imported (Task 3); `mouseSettleOk` produced (Task 4 scenario) and consumed (Task 4 wrapper) with matching shape.
