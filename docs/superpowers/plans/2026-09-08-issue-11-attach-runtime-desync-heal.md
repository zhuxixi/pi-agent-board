# Attach Runtime Desync Detect + Heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect runtime cursor desync (attach-settled, mid-session) via a 2s probe that checks the PTY cursor cell's inverse attribute, and self-heal by re-arming the shrink-and-hold jiggle protocol with rate limiting and a lifetime budget (issue #11).

**Architecture:** Three layers matching the existing codebase split: (1) pure classifier `detectCursorDesync()` in `src/core/pty-attach-render.mjs`; (2) protocol entry `heal()` on the existing jiggle controller in `src/core/pty-attach-jiggle-controller.mjs` reusing feed/clear detection and guards; (3) wiring in `src/ui/pty-attach.ts` — `lastOutputAt` timestamp, injectable `nowFn`, a `checkDesync()` method gated by 7 conditions, and a probe timer started at attach settle / stopped at close. Spec: `docs/superpowers/specs/2026-09-07-issue-11-attach-runtime-desync-heal-design.md`.

**Tech Stack:** Node.js ESM (.mjs), TypeScript component compiled via `--experimental-transform-types`, `node:test` + `node:assert/strict`, `@xterm/headless` in smoke tests only.

## Global Constraints

- Parameter values (copy verbatim): `DESYNC_QUIET_MS = 1500`, `DESYNC_PROBE_INTERVAL_MS = 2000`, `HEAL_RATELIMIT_MS = 10000`, `HEAL_MAX_PER_LIFETIME = 5`.
- healBudget is consumed on **entry** to `heal()` (including the tiny-terminal give-up path); `start()`/`restoreAndStop()` never reset it.
- `heal()` preserves `tuiFrameSeen` and never arms G1; it must reuse `feed()`'s existing clear detection and the G3/G4/G5 guard behavior without changing `start()`'s semantics.
- `checkDesync()` gates, in order: (1) `!attaching && !closed`, (2) `tuiFrameSeen`, (3) `detectCursorDesync(...) === "misaligned"`, (4) `now - lastOutputAt > DESYNC_QUIET_MS`, (5) chain idle (`state.stopped && !held`), (6) `now - lastHealAt > HEAL_RATELIMIT_MS`, (7) `this.connected`.
- The probe is a self-contained timer (unref'd, cleared in `close()`), NOT hooked into the render path (render is event-driven and stops exactly when desync strikes).
- `lastOutputAt` is recorded synchronously in `pushOutput()` before `term.write`, never inside its async callback.
- Never commit to main; all work stays in this worktree branch. Commit messages use conventional commits. `git add` per-file, never `git add -A`.
- Test commands: `node --test test/pty-attach-render.test.mjs`, `node --test test/pty-attach-jiggle-controller.test.mjs`, `node --test test/pty-attach-desync-heal.test.mjs`, `node --test test/pty-attach-desync-health-e2e.test.mjs`, full suite `npm test`.

---

### Task 1: `detectCursorDesync` pure classifier (A1)

**Files:**
- Modify: `src/core/pty-attach-render.mjs` (append after `projectPtyCursor`)
- Test: `test/pty-attach-render.test.mjs` (append; add `detectCursorDesync` to the import list)

**Interfaces:**
- Consumes: the `{ row, col } | null` shape returned by the existing `projectPtyCursor(buf, start, height)` (same file).
- Produces: `detectCursorDesync(buf: { getLine(row): { length: number; getCell(x): { isInverse(): boolean; getWidth(): number } | undefined } | undefined }, cursor: { row: number; col: number } | null): "aligned" | "misaligned" | "unknown"` — consumed by Task 3's `checkDesync()`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pty-attach-render.test.mjs` (extend the existing import statement with `detectCursorDesync`):

```js
// --- issue #11: runtime desync classifier ---

function fakeDesyncBuf(cells) {
	// cells: array of { inverse: boolean, width: number } | null (null = no cell at x)
	return {
		getLine(row) {
			if (row !== 0) return undefined;
			return {
				length: cells.length,
				getCell(x) {
					const c = cells[x];
					if (!c) return undefined;
					return { isInverse: () => c.inverse, getWidth: () => c.width };
				},
			};
		},
	};
}

test("detectCursorDesync: null cursor (viewport-scrolled) is unknown", () => {
	assert.equal(detectCursorDesync(fakeDesyncBuf([]), null), "unknown");
});

test("detectCursorDesync: cursor on an inverse cell is aligned", () => {
	const buf = fakeDesyncBuf([{ inverse: false, width: 1 }, { inverse: true, width: 1 }]);
	assert.equal(detectCursorDesync(buf, { row: 0, col: 1 }), "aligned");
});

test("detectCursorDesync: cursor on a non-inverse cell is misaligned", () => {
	const buf = fakeDesyncBuf([{ inverse: true, width: 1 }, { inverse: false, width: 1 }]);
	assert.equal(detectCursorDesync(buf, { row: 0, col: 1 }), "misaligned");
});

test("detectCursorDesync: cursor past line end falls back to the last inverse cell (aligned)", () => {
	const buf = fakeDesyncBuf([{ inverse: false, width: 1 }, { inverse: true, width: 1 }]);
	assert.equal(detectCursorDesync(buf, { row: 0, col: 99 }), "aligned");
});

test("detectCursorDesync: cursor on a width-0 CJK continuation falls back to the leading wide cell", () => {
	// "你" occupies cols 0-1: col 0 width 2 inverse, col 1 width 0 (continuation)
	const buf = fakeDesyncBuf([{ inverse: true, width: 2 }, { inverse: false, width: 0 }, { inverse: false, width: 1 }]);
	assert.equal(detectCursorDesync(buf, { row: 0, col: 1 }), "aligned");
});

test("detectCursorDesync: fully empty line (no cells, no inverse) is misaligned", () => {
	const buf = fakeDesyncBuf([]);
	assert.equal(detectCursorDesync(buf, { row: 0, col: 0 }), "misaligned");
});

test("detectCursorDesync: missing buffer line is unknown", () => {
	assert.equal(detectCursorDesync(fakeDesyncBuf([{ inverse: true, width: 1 }]), { row: 5, col: 0 }), "unknown");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-11-attach-runtime-desync-heal && node --test test/pty-attach-render.test.mjs`
Expected: FAIL — `detectCursorDesync` is not exported (import error).

- [ ] **Step 3: Write the implementation**

Append to `src/core/pty-attach-render.mjs`:

```js
/**
 * Classify the PTY cursor's alignment for runtime desync detection (issue #11).
 *
 * Healthy idle pi: the child pi-tui parks the hardware cursor on the editor
 * marker, whose cell is the inverse-video "fake cursor" — so the cursor cell
 * itself is inverse. A desynced buffer leaves the cursor parked elsewhere
 * (typically where the last differential write ended), on a non-inverse cell.
 * Width-0 cells are CJK continuation cells and out-of-range columns sit past
 * the line's cells; in both cases the meaningful attribute lives on the
 * preceding cell, so we look left. Returns:
 *   "aligned"    — cursor resolves to an inverse cell (healthy);
 *   "misaligned" — cursor resolves to a non-inverse cell (candidate desync;
 *                  callers gate this with an output-quietness window);
 *   "unknown"    — no cursor (scrolled out of the projected viewport) or no
 *                  buffer line (defensive); never treat these as desync.
 */
export function detectCursorDesync(buf, cursor) {
	if (!cursor) return "unknown";
	const line = buf.getLine(cursor.row);
	if (!line) return "unknown";
	let x = cursor.col;
	let cell = line.getCell(x);
	while ((!cell || cell.getWidth() === 0) && x > 0) {
		x--;
		cell = line.getCell(x);
	}
	if (!cell) return "misaligned";
	return cell.isInverse() ? "aligned" : "misaligned";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pty-attach-render.test.mjs`
Expected: PASS (all new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-attach-render.mjs test/pty-attach-render.test.mjs
git commit -m "feat: detectCursorDesync three-state classifier for runtime desync (issue #11)"
```

---

### Task 2: controller `heal()` + lifetime budget (A2)

**Files:**
- Modify: `src/core/pty-attach-jiggle-controller.mjs` (add `HEAL_MAX_PER_LIFETIME` const, `healCount` state, `heal()` function; extend `getState()` and the returned API)
- Test: `test/pty-attach-jiggle-controller.test.mjs` (append)

**Interfaces:**
- Consumes: existing `createJiggleRetryState`, `stopRetry`, `resizeJiggleSize`, `scheduleNextRetry`, `clearAllTimers`, `restoreIfHeld`, and module state (`held`, `restored`, `state`, `carry`, `tuiFrameSeen`, `originalCols/Rows`, `holdSize`).
- Produces: `heal(cols: number, rows: number): boolean` — `true` when a heal hold was armed, `false` when the budget is exhausted or no valid hold size exists. `getState()` additionally exposes `healCount: number`. Consumed by Task 3's `checkDesync()`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pty-attach-jiggle-controller.test.mjs`:

```js
// --- issue #11: runtime desync heal ---

function frameSeenController() {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.feed("\x1b[?2026h"); // first TUI frame → restore via fast path
	controller.feed("\x1b[2J");     // clear → chain done, runtime idle state
	return { controller, scheduler, resizes };
}

test("heal(): re-arms shrink-and-hold, preserves tuiFrameSeen, no G1", () => {
	const { controller, scheduler, resizes } = frameSeenController();
	resizes.length = 0;
	assert.equal(controller.heal(170, 36), true);
	assert.deepEqual(resizes, [[169, 35]], "heal sends exactly one shrink");
	assert.equal(controller.getState().held, true);
	assert.equal(controller.getState().tuiFrameSeen, true, "heal must NOT reset tuiFrameSeen");
	assert.equal(scheduler.findByDelay(6000), null, "heal must NOT arm G1");
	assert.ok(scheduler.delays().length > 0, "chain (G2 backoff) is scheduled");
});

test("heal() then feed clear → restore + stop", () => {
	const { controller, resizes } = frameSeenController();
	resizes.length = 0;
	controller.heal(170, 36);
	controller.feed("redraw\x1b[2J\x1b[Hframe");
	assert.deepEqual(resizes.slice(-1), [[170, 36]], "clear restores original size");
	assert.equal(controller.getState().held, false);
	assert.equal(controller.getState().clearDetected, true);
	assert.equal(controller.getState().stopped, true);
});

test("heal() budget: 5 attempts max per controller lifetime", () => {
	const { controller, resizes } = frameSeenController();
	resizes.length = 0;
	for (let i = 0; i < 5; i++) {
		assert.equal(controller.heal(170, 36), true, `heal #${i + 1} succeeds`);
		// resolve each heal with a clear so the next one starts idle
		controller.feed("\x1b[2J");
	}
	resizes.length = 0;
	assert.equal(controller.heal(170, 36), false, "6th heal rejected");
	assert.deepEqual(resizes, [], "no resize sent after budget exhausted");
	assert.equal(controller.getState().healCount, 5);
});

test("heal() budget is NOT reset by start() or restoreAndStop()", () => {
	const { controller } = frameSeenController();
	controller.heal(170, 36);
	controller.feed("\x1b[2J");
	controller.start(170, 36);
	controller.feed("\x1b[2J");
	controller.restoreAndStop();
	assert.equal(controller.getState().healCount, 1);
});

test("heal() consumes budget even on tiny terminals (no valid hold size)", () => {
	const { controller } = frameSeenController();
	assert.equal(controller.heal(20, 5), false, "tiny terminal cannot hold");
	assert.equal(controller.getState().healCount, 1, "budget consumed on entry");
});

test("heal() hold is cancelled by G4 notifyExternalResize", () => {
	const { controller, resizes } = frameSeenController();
	resizes.length = 0;
	controller.heal(170, 36);
	controller.notifyExternalResize(200, 50);
	assert.equal(controller.getState().held, false);
	assert.equal(controller.getState().stopped, true);
	// G4 adopts the new size as original: a later heal restores to the new size
	assert.equal(controller.heal(200, 50), true);
	controller.feed("\x1b[2J");
	assert.deepEqual(resizes.filter(([c]) => c === 200).length >= 1, true, "restore tracks the adopted size");
});

test("heal() while a previous heal is held: restores the old hold first", () => {
	const { controller, resizes } = frameSeenController();
	resizes.length = 0;
	controller.heal(170, 36);       // shrink #1
	controller.heal(170, 36);       // shrink #2 — must restore #1 first (no clear between)
	assert.deepEqual(resizes, [[169, 35], [170, 36], [169, 35]], "second heal unwinds the first hold before re-shrinking");
	assert.equal(controller.getState().healCount, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/pty-attach-jiggle-controller.test.mjs`
Expected: FAIL — `controller.heal is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/core/pty-attach-jiggle-controller.mjs`:

3a. Add next to `POST_RESTORE_VERIFY_MS`:

```js
/** Lifetime cap on runtime desync heals (issue #11): a persistent misdiagnosis
 * must not flicker the screen forever; after this many attempts the backstop
 * stays quiet until the controller is recreated. Consumed on heal() entry. */
const HEAL_MAX_PER_LIFETIME = 5;
```

3b. Add state next to `let g1Timer = null;`:

```js
/** Runtime heals spent (issue #11); never reset by start()/restoreAndStop(). */
let healCount = 0;
```

3c. Add the method (place after `feed`, before `restoreAndStop`):

```js
	/**
	 * Runtime desync backstop (issue #11): re-arm the shrink-and-hold protocol
	 * mid-session. Unlike start(), tuiFrameSeen is preserved (the child has
	 * rendered), G1 is not armed (frames are flowing), and the budget is
	 * lifetime-capped so a misdiagnosis cannot flicker the screen forever.
	 * Consumes one budget slot on entry, including the tiny-terminal give-up.
	 * @param {number} cols
	 * @param {number} rows
	 * @returns {boolean} true when a heal hold was armed.
	 */
	function heal(cols, rows) {
		if (healCount >= HEAL_MAX_PER_LIFETIME) return false;
		healCount++;
		clearAllTimers();
		if (held) {
			// Unwind any live hold (e.g. a previous clear-less heal) first.
			sendResize(originalCols, originalRows);
			restored = true;
			held = false;
		}
		state = createJiggleRetryState();
		carry = "";
		originalCols = cols;
		originalRows = rows;
		holdSize = resizeJiggleSize(cols, rows);
		if (!holdSize) {
			state = stopRetry(state);
			held = false;
			restored = true;
			return false;
		}
		sendResize(holdSize.cols, holdSize.rows);
		held = true;
		restored = false;
		scheduleNextRetry(); // G2 backoff re-shrinks while a renderer is seen but no clear follows
		return true;
	}
```

3d. Extend `getState()` and the return object:

```js
		getState: () => ({ ...state, held, tuiFrameSeen, originalCols, originalRows, holdSize, healCount }),
```

and add `heal` to the returned API object (`return { start, feed, heal, restoreAndStop, notifyExternalResize, getState };`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pty-attach-jiggle-controller.test.mjs`
Expected: PASS (all new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-attach-jiggle-controller.mjs test/pty-attach-jiggle-controller.test.mjs
git commit -m "feat: jiggle controller heal() runtime backstop with lifetime budget (issue #11)"
```

---

### Task 3: component wiring — probe timer, `checkDesync()`, 7 gates (A3)

**Files:**
- Modify: `src/ui/pty-attach.ts` (constants near `ATTACH_OUTPUT_RENDER_INTERVAL_MS` import; fields near `viewportTop` (~L152); `pushOutput` (~L1050); `finishAttachTransition` (~L514); `close()` (~L1100); import `detectCursorDesync`)
- Create: `test-support/desync-heal-smoke.ts`
- Create: `test/pty-attach-desync-heal.test.mjs`

**Interfaces:**
- Consumes: `detectCursorDesync` (Task 1), `controller.heal()` / `getState().healCount` (Task 2), existing `projectPtyCursor`, `bodyHeight()`, `bottomViewportTop()`, `clampViewportTop()`, `this.jiggleRetry`, `this.cols/rows`, `this.connected`, `this.attaching`, `this.send`.
- Produces (runtime-injectable for tests, same pattern detach-gate-smoke already uses): fields `lastOutputAt: number`, `lastHealAt: number`, `nowFn: () => number`, plus private methods `checkDesync(): void`, `startDesyncProbe(): void`, `stopDesyncProbe(): void`. Smoke tests call `checkDesync()` and read `jiggleRetry.getState()` via `(attach as unknown as {...})` casts.

- [ ] **Step 1: Write the failing smoke harness**

Create `test-support/desync-heal-smoke.ts` (modeled on `detach-gate-smoke.ts` — real `PtyAttachComponent`, fake tui, runtime injection of private fields):

```ts
// Desync heal wiring harness (issue #11): construct PtyAttachComponent with a
// fake TUI, drive it through Pi-like buffer states via the real socket-data
// path (pushOutput + checkClearSequence), then verify the 7 gates of
// checkDesync() and the end-to-end heal loop:
//   H1. healthy idle (cursor parked on inverse fake cursor) → no heal.
//   H2. desync (cursor parked elsewhere) + quiet window → exactly one heal
//       (shrink sent); immediate re-check is rate-limited + chain-idle-gated.
//   H3. pre-settle (attaching) → no heal.
//   H4. no TUI frame (tuiFrameSeen false) → no heal.
//   H5. cursor scrolled out of viewport → no heal.
//   H6. recent output (within DESYNC_QUIET_MS) → no heal.
//   H7. heal loop: child redraws with clear + cursor back on the fake cursor
//       → restore + no further heal.
// Timing/state facts the harness encodes (verified against the component and
// controller source):
//   - checkDesync gate 7 needs this.connected — injected true (no real socket).
//   - The controller must sit in runtime-idle state (tuiFrameSeen=true from a
//     2026h frame, then chain stopped by a detected \x1b[2J) — feed() learns
//     the frame BEFORE the clear; once clearDetected it short-circuits, and
//     within one chunk a clear wins over a frame start.
//   - The projected window is bottom-anchored (bottomViewportTop), so frames
//     sink 25 newlines first to land the cursor inside [start, start+height).
// Run via `node --experimental-transform-types` (TS parameter properties).
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const ESC = "\x1b";
/** Leading clear: stops the controller chain (runtime-idle state). */
const CLEAR = `${ESC}[2J${ESC}[H`;
/** Push content + cursor to the buffer bottom so they land inside the
 * bottom-anchored projection window (25 > 24-row viewport → 1 line scrollback). */
const SINK = "\n".repeat(25);
const tui = {
	terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const keybindings = {} as never;

type Drivable = {
	pushOutput: (data: string) => void;
	checkClearSequence: (data: string) => void;
	finishAttachTransition: () => void;
	checkDesync: () => void;
	attaching: boolean;
	viewportTop: number | null;
	jiggleRetry: { getState: () => { healCount: number; held: boolean; stopped: boolean; tuiFrameSeen: boolean }; feed: (data: string) => void };
};

function makeAttach() {
	const attach = new PtyAttachComponent(
		tui as never,
		theme as never,
		keybindings,
		() => {},
		{ socketPath: "/no/such/socket", title: "desync" },
	);
	const sent: Array<Record<string, unknown>> = [];
	(attach as unknown as { send: (msg: Record<string, unknown>) => void }).send = (msg) => sent.push(msg);
	// Gate 7 needs a live connection; the fake socketPath would never connect.
	(attach as unknown as { connected: boolean }).connected = true;
	// Injectable clock: start at t=1_000_000 so "unset" (0) timestamps always look stale.
	const clock = { now: 1_000_000 };
	(attach as unknown as { nowFn: () => number }).nowFn = () => clock.now;
	return { attach: attach as unknown as Drivable, sent, clock };
}

async function write(attach: Drivable, data: string): Promise<void> {
	// Mirror the real socket-data path (onSocketData → pushOutput + checkClearSequence):
	// checkClearSequence feeds the jiggle controller (2026h frame detection,
	// clear detection) — without it tuiFrameSeen stays false and gates have no teeth.
	attach.pushOutput(data);
	attach.checkClearSequence(data);
	await new Promise((r) => setTimeout(r, 20));
}

/** Bring the controller to the real runtime-idle state: 2026h frame seen
 * first (tuiFrameSeen=true), then a detected clear (chain stopped). */
async function primeRuntime(attach: Drivable): Promise<void> {
	await write(attach, `${ESC}[?2026h`);
	await write(attach, CLEAR);
}

/** Healthy idle frame: bottom line carries the inverse fake cursor and the
 * hardware cursor is parked ON it (CUP 24;10 == the inverse cell). */
const healthyFrame = `${SINK}> editor \u4f60\u597d${ESC}[7m ${ESC}[0m${ESC}[24;7H${ESC}[7m ${ESC}[0m${ESC}[24;7H`;
/** Desynced frame: same content, but the cursor ends parked on a PLAIN cell
 * one row above the inverse fake cursor (where a garbled differential write
 * left it). */
const desyncFrame = `${SINK}> editor \u4f60\u597d${ESC}[7m ${ESC}[0m${ESC}[24;7H${ESC}[7m ${ESC}[0m${ESC}[23;5H`;
/** Child response to a heal: fullRender-style clear + redraw + cursor parked
 * back on the inverse fake cursor. */
const healResponse = `${ESC}[?2026h${ESC}[2J${ESC}[H${SINK}> editor \u4f60\u597d${ESC}[7m ${ESC}[0m${ESC}[24;7H${ESC}[7m ${ESC}[0m${ESC}[24;7H${ESC}[?2026l`;

async function main(): Promise<void> {
	const out: Record<string, boolean> = {};

	// H1: healthy idle — no heal
	{
		const { attach, sent, clock } = makeAttach();
		await primeRuntime(attach);
		await write(attach, healthyFrame);
		attach.finishAttachTransition();
		clock.now += 10_000; // all gates open — only gate 3 (aligned) can stop it
		attach.checkDesync();
		out.healthyIdleNoHeal = attach.jiggleRetry.getState().healCount === 0 && resizes(sent) === 0;
	}

	// H2: desync + quiet → exactly one heal; immediate re-check rate-limited + chain-idle-gated
	{
		const { attach, sent, clock } = makeAttach();
		await primeRuntime(attach);
		await write(attach, desyncFrame);
		attach.finishAttachTransition();
		clock.now += 10_000; // last output now older than DESYNC_QUIET_MS
		attach.checkDesync();
		const healed = attach.jiggleRetry.getState().healCount === 1 && resizes(sent) === 1;
		attach.checkDesync(); // within 10s rate limit AND chain is active (held)
		out.desyncHealsOnce = healed && attach.jiggleRetry.getState().healCount === 1 && resizes(sent) === 1;
	}

	// H3: pre-settle (attaching true) — no heal
	{
		const { attach, sent } = makeAttach();
		await primeRuntime(attach);
		await write(attach, desyncFrame);
		// do NOT finishAttachTransition(); attaching is still true
		attach.checkDesync();
		out.preSettleNoHeal = attach.jiggleRetry.getState().healCount === 0 && resizes(sent) === 0;
	}

	// H4: no 2026h frame — no heal
	{
		const { attach, sent } = makeAttach();
		// No primeRuntime (it would set tuiFrameSeen); chain is stopped via the
		// clear so only gate 2 (no TUI frame) blocks the heal.
		await write(attach, CLEAR + "plain shell output, no TUI frame");
		attach.finishAttachTransition();
		attach.checkDesync();
		out.noFrameNoHeal = attach.jiggleRetry.getState().healCount === 0 && resizes(sent) === 0;
	}

	// H5: cursor scrolled out of the projected viewport — no heal
	{
		const { attach, sent, clock } = makeAttach();
		await primeRuntime(attach);
		// Establish scrollback well beyond the window (60 lines), leave the
		// cursor on the bottom viewport row (absolute ≈ buf.length-1), then
		// have the user scroll to the top: window [0,22) excludes the cursor.
		let scroll = "";
		for (let i = 0; i < 60; i++) scroll += `row ${i}\n`;
		await write(attach, scroll + `${ESC}[24;5H`);
		attach.finishAttachTransition();
		(attach as unknown as { viewportTop: number | null }).viewportTop = 0; // user scrolled up
		clock.now += 10_000; // all gates open — only the viewport (unknown) path can stop it
		attach.checkDesync();
		out.scrolledOutNoHeal = attach.jiggleRetry.getState().healCount === 0 && resizes(sent) === 0;
	}

	// H6: recent output (inside the quiet window) — no heal
	{
		const { attach, sent, clock } = makeAttach();
		await primeRuntime(attach);
		await write(attach, desyncFrame);
		attach.finishAttachTransition();
		clock.now += 100; // way less than DESYNC_QUIET_MS
		attach.checkDesync();
		out.recentOutputNoHeal = attach.jiggleRetry.getState().healCount === 0 && resizes(sent) === 0;
	}

	// H7: heal loop closes — child clears + parks cursor on the fake cursor again
	{
		const { attach, sent, clock } = makeAttach();
		await primeRuntime(attach);
		await write(attach, desyncFrame);
		attach.finishAttachTransition();
		clock.now += 10_000;
		attach.checkDesync();
		const shrinkSeen = attach.jiggleRetry.getState().healCount === 1;
		// Child answers the shrink with a fullRender: clear + redraw + cursor on fake cursor.
		await write(attach, healResponse);
		const restored = attach.jiggleRetry.getState().held === false && attach.jiggleRetry.getState().stopped === true;
		clock.now += 10_000; // next probe tick: aligned now, and budget intact
		attach.checkDesync();
		out.healLoopCloses = shrinkSeen && restored && attach.jiggleRetry.getState().healCount === 1 && resizes(sent) === 2; // heal shrink + controller restore
	}

	console.log(JSON.stringify(out));
	const allOk = Object.values(out).every(Boolean);
	if (!allOk) process.exitCode = 1;
}

void main();
```

- [ ] **Step 2: Write the failing wrapper test**

Create `test/pty-attach-desync-heal.test.mjs` (same execFileSync pattern as `test/pty-attach-detach-gate.test.mjs`):

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SMOKE_SCRIPT = join(ROOT_DIR, "test-support", "desync-heal-smoke.ts");

// Issue #11: runtime desync detect + rate-limited heal — component wiring gates.
test("desync heal wiring: 7 gates + heal loop", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SMOKE_SCRIPT], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out);
	assert.equal(parsed.healthyIdleNoHeal, true, "H1 healthy idle must not heal");
	assert.equal(parsed.desyncHealsOnce, true, "H2 desync must heal exactly once (rate limit + chain gate)");
	assert.equal(parsed.preSettleNoHeal, true, "H3 pre-settle must not heal");
	assert.equal(parsed.noFrameNoHeal, true, "H4 no TUI frame must not heal");
	assert.equal(parsed.scrolledOutNoHeal, true, "H5 cursor out of viewport must not heal");
	assert.equal(parsed.recentOutputNoHeal, true, "H6 recent output must not heal");
	assert.equal(parsed.healLoopCloses, true, "H7 child clear must close the heal loop without a second heal");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/pty-attach-desync-heal.test.mjs`
Expected: FAIL — compile error (`checkDesync` / `nowFn` not on the component) or assertion failures.

- [ ] **Step 4: Write the implementation**

In `src/ui/pty-attach.ts`:

4a. Extend the import from `../core/pty-attach-render.mjs` (~L10):

```ts
import { createAttachOutputRenderScheduler, detectCursorDesync, nextAttachRender, projectPtyCursor, shouldScheduleAttachRenderForMessage } from "../core/pty-attach-render.mjs";
```

4b. Add constants near the other module consts (search `GRACEFUL_SOCKET_CLOSE_MS` / `ATTACH_SETTLE_MS`):

```ts
/** Desync detection window: how long output must stay silent before a
 * misaligned cursor counts as desync (issue #11). Streaming keeps the cursor
 * on plain output cells legitimately; a healthy idle child re-parks it on the
 * inverse fake-cursor cell on its last rendered frame. */
const DESYNC_QUIET_MS = 1500;
/** How often the post-settle probe runs checkDesync() (issue #11). */
const DESYNC_PROBE_INTERVAL_MS = 2000;
/** Minimum spacing between two runtime heals (issue #11). */
const HEAL_RATELIMIT_MS = 10000;
```

4c. Add fields near `private viewportTop: number | null = null;` (~L152):

```ts
	private lastOutputAt = 0;
	private lastHealAt = 0;
	private desyncProbeTimer: ReturnType<typeof setInterval> | null = null;
	/** Injectable clock for desync gating (tests override this). */
	private nowFn: () => number = () => Date.now();
```

4d. In `pushOutput()` (~L1050), record the timestamp synchronously (add as the second statement, right after the `if (data.length === 0) return;` guard, BEFORE `term.write`):

```ts
		this.lastOutputAt = this.nowFn();
```

4e. In `finishAttachTransition()` (~L514), add at the end (after `this.scheduleRender(true);`):

```ts
		this.startDesyncProbe();
```

4f. Add the probe + check methods (place after `finishAttachTransition`):

```ts
	private startDesyncProbe(): void {
		this.stopDesyncProbe();
		// The probe is deliberately NOT hooked into the render path: rendering is
		// event-driven (socket output / keypress / resize) and stops exactly when
		// desync strikes (output goes quiet). A self-contained timer is the only
		// way an idle desynced screen gets its self-heal without user action.
		this.desyncProbeTimer = setInterval(() => this.checkDesync(), DESYNC_PROBE_INTERVAL_MS);
		this.desyncProbeTimer.unref?.();
	}

	private stopDesyncProbe(): void {
		if (this.desyncProbeTimer) {
			clearInterval(this.desyncProbeTimer);
			this.desyncProbeTimer = null;
		}
	}

	/**
	 * Runtime desync backstop (issue #11). Seven gates, cheapest first:
	 * settled+connected, child is a TUI (frame seen), misaligned cursor,
	 * output quiet, chain idle, heal rate limit. All pass → heal() re-arms
	 * shrink-and-hold; the child's fullRender clear then restores the size
	 * and repaints a consistent screen.
	 */
	private checkDesync(): void {
		if (this.closed || this.attaching || !this.connected) return; // gates 1, 7
		const chain = this.jiggleRetry.getState();
		if (!chain.tuiFrameSeen) return; // gate 2: shell/vim children never heal
		if (!chain.stopped || chain.held) return; // gate 5: attach/heal chain active
		const now = this.nowFn();
		if (now - this.lastOutputAt <= DESYNC_QUIET_MS) return; // gate 4: streaming
		if (now - this.lastHealAt <= HEAL_RATELIMIT_MS) return; // gate 6: rate limit
		const height = this.bodyHeight();
		this.clampViewportTop(height);
		const start = this.viewportTop ?? this.bottomViewportTop(height);
		const buf = this.term.buffer.active;
		if (detectCursorDesync(buf, projectPtyCursor(buf, start, height)) !== "misaligned") return; // gate 3
		this.lastHealAt = now;
		this.jiggleRetry.heal(this.cols, this.rows);
	}
```

4g. In `close()` (~L1100, next to the `attachSettleTimer` cleanup), add:

```ts
		this.stopDesyncProbe();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/pty-attach-desync-heal.test.mjs && node --test test/pty-attach-detach-gate.test.mjs`
Expected: PASS (new wiring test + existing detach-gate regression both green).

- [ ] **Step 6: Run the full suite to catch regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/pty-attach.ts test-support/desync-heal-smoke.ts test/pty-attach-desync-heal.test.mjs
git commit -m "feat: wire runtime desync probe with 7 gates into attach component (issue #11)"
```

---

### Task 4: healthy-session E2E — no false heal (A4)

**Files:**
- Create: `test-support/fake-idle-tui-pi.mjs` (idle healthy child: TUI frame with inverse fake cursor + cursor parked on it, then silent; resize → full clear + repaint, mirroring pi-tui's widthChanged → fullRender(true))
- Create: `test-support/desync-health-e2e.ts` (real runner spawn + real `PtyAttachComponent` + fake tui; attach → settle → hold ≥3 probe ticks with the child idle → assert `healCount === 0`)
- Test: `test/pty-attach-desync-health-e2e.test.mjs` (execFileSync wrapper)

**Interfaces:**
- Consumes: `atomicWriteJson` + `P.*` paths (same setup as `test/pty-attach-cold-start-e2e.test.mjs`'s `spawnRunner`), real `runner/pty-runner.mjs` protocol, `PtyAttachComponent` opts `{ socketPath, title }`.
- Produces: standalone verification that a real runner + healthy idle TUI child never triggers a heal across the full attach lifecycle (spec A4).

- [ ] **Step 1: Write the fake idle child**

Create `test-support/fake-idle-tui-pi.mjs`:

```js
#!/usr/bin/env node
/**
 * Fake healthy IDLE pi for the desync-health E2E (issue #11).
 *
 * Boots fast (no artificial delay), renders exactly like a healthy pi-tui
 * idle frame — an editor line whose cursor cell is INVERSE (the fake cursor)
 * with the hardware cursor parked ON that cell — and then goes silent.
 * Any resize away from the baseline triggers a fullRender-style clear +
 * repaint (pi-tui widthChanged → fullRender(true)), re-parking the cursor.
 * This is the child the desync probe must leave alone: aligned + quiet.
 */
const baseline = [process.stdout.columns, process.stdout.rows];

function frame() {
	// 2026h frame; editor line at row 2 col 5: inverse space = fake cursor;
	// CUP to (2,5) parks the hardware cursor ON the inverse cell.
	process.stdout.write(
		"\x1b[?2026h\x1b[2J\x1b[Hready\n> editor line\x1b[2;5H\x1b[7m \x1b[0m\x1b[2;5H\x1b[?2026l",
	);
}

process.stdout.on("resize", () => {
	const c = process.stdout.columns;
	const r = process.stdout.rows;
	if (c === baseline[0] && r === baseline[1]) return;
	baseline[0] = c;
	baseline[1] = r;
	frame();
});

frame();
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
```

- [ ] **Step 2: Write the E2E harness**

Create `test-support/desync-health-e2e.ts`:

```ts
// Healthy-session E2E (issue #11, spec A4): real runner + fake idle TUI child +
// REAL PtyAttachComponent. The attach runs its full lifecycle (shrink-and-hold
// protocol, settle, probe). With a healthy child (cursor parked on the inverse
// fake cursor, then silent) the desync probe must never heal across ≥3 probe
// ticks. Run via `node --experimental-transform-types`.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const tui = {
	terminal: { rows: 36, cols: 120, columns: 120, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const keybindings = {} as never;

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "desync-health-"));
	const viewId = "e2ehealth";
	let runner: ReturnType<typeof spawn> | null = null;
	let attach: PtyAttachComponent | null = null;
	try {
		const meta = createView(root, { id: viewId, name: "health", cwd: process.cwd() });
		atomicWriteJson(P.hostConfigPath(root, viewId), {
			root,
			viewId,
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-idle-tui-pi.mjs")],
			model: null,
			tools: null,
			env: {},
			cols: 120,
			rows: 36,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), P.hostConfigPath(root, viewId)], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		const socketPath = P.controlSocketPath(root, viewId);
		// Wait for the runner to create its control socket (same wait as cold-start E2E).
		const deadline = Date.now() + 10_000;
		while (!existsSync(socketPath) && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}

		attach = new PtyAttachComponent(
			tui as never,
			theme as never,
			keybindings,
			() => {},
			{ socketPath, title: "health" },
		);
		void attach.render(120); // drive one render so resizeIfNeeded sends the initial size

		// Settle + hold across ≥3 probe ticks (2s period) + quiet window (1.5s).
		await new Promise((r) => setTimeout(r, 9_000));

		const state = (attach as unknown as {
			jiggleRetry: { getState: () => { healCount: number; held: boolean; stopped: boolean } };
		}).jiggleRetry.getState();
		const result = { healedNever: state.healCount === 0, chainDone: state.stopped === true, held: state.held === false };
		console.log(JSON.stringify(result));
		if (!Object.values(result).every(Boolean)) process.exitCode = 1;
	} finally {
		attach?.close();
		runner?.kill("SIGTERM");
		await new Promise((r) => setTimeout(r, 200));
		rmSync(root, { recursive: true, force: true });
	}
	void createServer; // keep node:net import meaningful for parity with sibling harnesses
	void once;
}

void main();
```

Note: `P.controlSocketPath(root, viewId)` and `P.hostConfigPath(root, viewId)` are the exact helpers `test/pty-attach-cold-start-e2e.test.mjs` waits on (verified against `src/core/paths.mjs` L68 / cold-start E2E usage); `createView` is exported from `src/core/store.mjs` L420.

- [ ] **Step 3: Write the wrapper test**

Create `test/pty-attach-desync-health-e2e.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const E2E_SCRIPT = join(ROOT_DIR, "test-support", "desync-health-e2e.ts");

// Issue #11 (A4): a real runner + healthy idle TUI child must never trigger a
// runtime desync heal across the full attach lifecycle.
test("desync health e2e: healthy idle session triggers no heal", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", E2E_SCRIPT], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out);
	assert.equal(parsed.healedNever, true, "healCount must stay 0 on a healthy idle session");
	assert.equal(parsed.chainDone, true, "attach chain must complete");
	assert.equal(parsed.held, false || parsed.held === false, "no hold left armed");
});
```

- [ ] **Step 4: Run the E2E to verify it fails-or-passes honestly**

Run: `node --test test/pty-attach-desync-health-e2e.test.mjs`
Expected: PASS. If it FAILS because the harness wiring (socket path helper names, runner protocol details) is off, fix the harness until it exercises the real attach lifecycle (observable via `chainDone: true`); if it fails because `healedNever` is false, the classifier/probe has a real false-positive — debug `detectCursorDesync` against the fake child's frame, not the harness.

- [ ] **Step 5: Commit**

```bash
git add test-support/fake-idle-tui-pi.mjs test-support/desync-health-e2e.ts test/pty-attach-desync-health-e2e.test.mjs
git commit -m "test: healthy idle session never triggers desync heal (issue #11 A4)"
```

---

### Task 5: full verification + spec acceptance sweep

**Files:**
- No new files; verification only.

**Interfaces:**
- Consumes: everything from Tasks 1-4.

- [ ] **Step 1: Full test suite**

Run: `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-11-attach-runtime-desync-heal && npm test`
Expected: PASS (568+ existing + 7 A1 + 7 A2 + 1 A3 + 1 A4 new tests).

- [ ] **Step 2: TypeScript check (whatever the repo uses)**

Run: `npm run verify 2>/dev/null || npx tsc --noEmit`
Expected: clean (use `npm run verify` if defined in package.json scripts; otherwise tsc).

- [ ] **Step 3: Spec acceptance sweep (fill the table into the PR description)**

Check off each spec acceptance ID against actual evidence:
- A1 → `node --test test/pty-attach-render.test.mjs` output (7 new cases)
- A2 → `node --test test/pty-attach-jiggle-controller.test.mjs` output (7 new cases)
- A3 → `node --test test/pty-attach-desync-heal.test.mjs` output (H1-H7)
- A4 → `node --test test/pty-attach-desync-health-e2e.test.mjs` output
- U1 → mark `pending (observational, post-merge)` — daily-use watching for spurious flicker; does not block merge per spec.

- [ ] **Step 4: Commit any residual fixes**

```bash
git status --short
# fix and git add <specific files> if anything surfaced; otherwise nothing to commit
```
