# attach wheel replay pseudo-scrollback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the attach wheel from spending its notches on scrollback that the snapshot hydration itself manufactured, so the first notch reaches the hosted session.

**Architecture:** Add a `historyFloor` baseline to `PtyAttachComponent`: everything below it is "pseudo history" created by hydrating a snapshot frame into a shorter local terminal. The floor is computed from the hydrated `baseY` minus the runner-authoritative scrollback line count, which the runner now carries in `snapshot_end.scrollbackLines`. All decision logic lands in pure functions in `src/core/pty-scroll.mjs`; the component only wires state.

**Tech Stack:** TypeScript (component), ESM `.mjs` core modules, `@xterm/headless`, `node:test` + `assert/strict`, `@earendil-works/pi-tui` (`TuiAltScreen`).

**Spec:** `docs/superpowers/specs/2026-10-18-attach-wheel-replay-pseudo-scrollback-design.md`

## Global Constraints

- Tabs for indentation; English comments and commit messages (repo AGENTS.md).
- No new dependencies.
- `npm run verify` must pass (typecheck + perf gate + tests + coverage thresholds lines 85 / funcs 80 / branches 70 + pack dry-run).
- Tests use `node:test` with `assert/strict`.
- Snapshots/attaches must never touch the host repository's fixtures — scenario work goes under a temp dir.
- The legacy screen-log replay path (`replayScreenLog`) must keep `historyFloor === 0`; its behaviour is unchanged.

## Review Focus

- **Old runner: `snapshot_end` without `scrollbackLines`** — hydration must still complete, `historyFloor` must be a finite number (never `NaN`), and the wheel must forward instead of silently scrolling pseudo history.
- **Resize between hydrate and assertion** — `historyFloor` must reflect the `baseY` observed inside the `term.write` callback, not a value frozen before the write.
- **`snap.empty` / `snap.resnapshot`** — after `term.reset()` the floor must return to 0, or a host restart leaves the first N lines unscrollable.
- **A snapshot that really has history (`scrollbackLines > 0`)** — that history must still scroll locally; the fix must not blanket-disable local scrolling.
- **Disconnected attach** — the wheel must still return `undefined` (hand the event back to pi) rather than returning `{handled:true}` on a forward that `send()` drops.

---

### Task 1: Pure scroll-floor helpers in `pty-scroll.mjs`

**Files:**
- Modify: `src/core/pty-scroll.mjs` (`scrollViewportTop` at ~L359; append two new exports near it)
- Test: `test/pty-scroll.test.mjs`

**Interfaces:**
- Produces:
  - `historyFloorAfterHydrate(baseYAfter: number, scrollbackLines: number|undefined) -> number`
  - `scrollableHistoryLines(baseY: number, historyFloor: number) -> number`
  - `scrollViewportTop(viewportTop: number|null, bottom: number, linesUp: number, floor?: number) -> { viewportTop: number|null, changed: boolean }`

- [ ] **Step 1: Write the failing tests**

Append to `test/pty-scroll.test.mjs` (add the two new names to the existing import list):

```js
test("historyFloorAfterHydrate keeps only scrollback that the runner vouched for", () => {
	assert.equal(historyFloorAfterHydrate(27, 0), 27);
	assert.equal(historyFloorAfterHydrate(127, 100), 27);
	assert.equal(historyFloorAfterHydrate(5, 10), 0);
	assert.equal(historyFloorAfterHydrate(0, 0), 0);
});

test("historyFloorAfterHydrate never returns NaN for unvalidated input", () => {
	assert.equal(historyFloorAfterHydrate(undefined, 0), 0);
	assert.equal(historyFloorAfterHydrate(27, undefined), 27);
	assert.equal(historyFloorAfterHydrate(Number.NaN, Number.NaN), 0);
	assert.equal(historyFloorAfterHydrate(27, Number.POSITIVE_INFINITY), 27);
});

test("scrollableHistoryLines reports only the rows above the floor", () => {
	assert.equal(scrollableHistoryLines(27, 27), 0);
	assert.equal(scrollableHistoryLines(127, 27), 100);
	assert.equal(scrollableHistoryLines(0, 0), 0);
	assert.equal(scrollableHistoryLines(5, 9), 0);
});

test("scrollViewportTop honours the floor and matches the legacy behaviour at floor 0", () => {
	// floor === bottom: nothing to scroll back to
	assert.deepEqual(scrollViewportTop(null, 27, 1, 27), { viewportTop: null, changed: false });
	assert.deepEqual(scrollViewportTop(27, 27, 1, 27), { viewportTop: null, changed: false });
	// floor 0 must reproduce the pre-change contract exactly
	assert.deepEqual(scrollViewportTop(null, 27, 1, 0), { viewportTop: 26, changed: true });
	assert.deepEqual(scrollViewportTop(27, 27, 1), { viewportTop: 26, changed: true });
	assert.deepEqual(scrollViewportTop(0, 27, 1, 0), { viewportTop: 0, changed: false });
	// floor clamps a downward scroll the same way bottom does
	assert.deepEqual(scrollViewportTop(5, 27, -5, 10), { viewportTop: 10, changed: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/pty-scroll.test.mjs`
Expected: FAIL — `historyFloorAfterHydrate is not defined` / `scrollableHistoryLines is not defined`.

- [ ] **Step 3: Implement the three functions**

In `src/core/pty-scroll.mjs`, replace `scrollViewportTop` with the floor-aware version (default `floor = 0` keeps every existing call site byte-for-byte identical):

```js
export function scrollViewportTop(viewportTop, bottom, linesUp, floor = 0) {
	const safeBottom = Math.max(0, Math.floor(bottom));
	const safeFloor = clampInt(floor, 0, safeBottom);
	const current = viewportTop == null ? safeBottom : clampInt(viewportTop, safeFloor, safeBottom);
	const next = clampInt(current - linesUp, safeFloor, safeBottom);
	return { viewportTop: next >= safeBottom ? null : next, changed: next !== current };
}
```

Add, with JSDoc explaining "hydrating a frame taller than the local terminal scrolls the top rows into scrollback; only `scrollbackLines` of them are history":

```js
export function historyFloorAfterHydrate(baseYAfter, scrollbackLines) {
	const safeBase = Number.isFinite(baseYAfter) ? Math.max(0, Math.floor(baseYAfter)) : 0;
	const safeScrollback = Number.isFinite(scrollbackLines) ? Math.max(0, Math.floor(scrollbackLines)) : 0;
	return Math.min(safeBase, Math.max(0, safeBase - safeScrollback));
}

export function scrollableHistoryLines(baseY, historyFloor) {
	const safeBase = Number.isFinite(baseY) ? Math.max(0, Math.floor(baseY)) : 0;
	const safeFloor = Number.isFinite(historyFloor) ? Math.max(0, Math.floor(historyFloor)) : 0;
	return Math.max(0, safeBase - Math.min(safeBase, safeFloor));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/pty-scroll.test.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-scroll.mjs test/pty-scroll.test.mjs
git commit -m "feat(attach): pure history-floor helpers for hydrated scrollback (issue #205)"
```

---

### Task 2: Carry `scrollbackLines` on `snapshot_end`

**Files:**
- Modify: `src/core/terminal-attach-protocol.mjs` (two `send({ type: "snapshot_end", … })` sites, ~L120 and ~L150)
- Modify: `src/core/terminal-attach-client.mjs` (`finishCollecting` emits `snapshotReady`, ~L486; header comment ~L85)
- Test: `test/terminal-attach-protocol.test.mjs`, `test/terminal-attach-client.test.mjs`

**Interfaces:**
- Produces: `snapshot_end.scrollbackLines: number` (runner) and `snapshotReady.scrollbackLines?: number` (client, key omitted when the runner did not send one).

- [ ] **Step 1: Write the failing tests**

In `test/terminal-attach-protocol.test.mjs`, add a case asserting the empty-baseline end message:

```js
assert.deepEqual(lastSent(), { type: "snapshot_end", nextSeq: 1, scrollbackLines: 0 });
```

and, for a model with scrollback, that the value equals `dto.scrollback.length` (reuse whichever existing fixture builds a model with fed output; assert `typeof msg.scrollbackLines === "number"` and `msg.scrollbackLines === <expected rows>`).

In `test/terminal-attach-client.test.mjs`, update the existing `deepEqual` at L94-95 to include the new key **only on the case that supplies it**, and add a case proving the key is absent when the runner omits it:

```js
assert.deepEqual(eventsOf(events, "snapshotReady"), [
	{ frame: "FRAME", empty: undefined, resnapshot: undefined, nextSeq: 6 },
]);
// with scrollbackLines on the wire:
client.handleMessage({ ...end(6), scrollbackLines: 100 });
assert.equal(eventsOf(events, "snapshotReady")[0].scrollbackLines, 100);
```

Also update the payload shape comment at `terminal-attach-client.mjs` ~L85 to `{ frame?, empty?, resnapshot?, nextSeq, scrollbackLines? }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/terminal-attach-protocol.test.mjs test/terminal-attach-client.test.mjs`
Expected: FAIL — `scrollbackLines` missing from the sent end message / from the emitted event.

- [ ] **Step 3: Implement**

Protocol, empty branch (~L120): `send({ type: "snapshot_end", nextSeq: lastSeq + 1, scrollbackLines: 0 })`.
Protocol, normal branch (~L150): `send({ type: "snapshot_end", nextSeq: lastSeq + 1, scrollbackLines: dto.scrollback.length })`.

Client `finishCollecting` (~L486) — omit the key rather than writing `undefined`, because the existing `deepEqual` pins the exact shape:

```js
emit("snapshotReady", {
	frame: partial.frame ?? undefined,
	empty: partial.empty || undefined,
	resnapshot: partial.resnapshot || undefined,
	nextSeq,
	...(typeof msg.scrollbackLines === "number" ? { scrollbackLines: msg.scrollbackLines } : {}),
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/terminal-attach-protocol.test.mjs test/terminal-attach-client.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/terminal-attach-protocol.mjs src/core/terminal-attach-client.mjs test/terminal-attach-protocol.test.mjs test/terminal-attach-client.test.mjs
git commit -m "feat(attach): carry snapshot scrollback line count on snapshot_end (issue #205)"
```

---

### Task 3: Wire `historyFloor` into `PtyAttachComponent`

**Files:**
- Modify: `src/ui/pty-attach.ts` (`pushOutput` ~L1682, `handleAttachEvent` snapshotReady ~L1596, `resizeIfNeeded` ~L1384, `tryScrollBy` ~L1421, `tryScrollToTop` ~L1428, `clampViewportTop` ~L1465, imports ~L16)
- Test: `test/pty-attach-wheel.test.mjs` (regression only — the positive path lands in Task 4)

**Interfaces:**
- Consumes: `historyFloorAfterHydrate`, `scrollableHistoryLines`, `scrollViewportTop(…, floor)` from Task 1.
- Produces: private `historyFloor: number`, private `scrollFloorStart(height: number): number`.

- [ ] **Step 1: Write the failing test**

In `test/pty-attach-wheel.test.mjs`, add a case that hydrates an authoritative frame taller than the component's rows through the public event path and asserts the floor suppresses local scrolling. Anchor it on the existing component fixture in that file:

```js
test("a hydrated frame taller than the viewport does not create scrollable history", () => {
	// component rendered at 80x24 → rows = 22; hydrate a 40-row frame
	// so the write scrolls 18 rows into the local buffer.
	// (drive pushOutput with { authoritative: true, scrollbackLines: 0 } and await the write callback)
	assert.equal(component.term.buffer.active.baseY, 18);
	assert.equal(component.scrollFloorStart(component.bodyHeight()), component.bottomViewportTop(component.bodyHeight()));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pty-attach-wheel.test.mjs`
Expected: FAIL — `scrollFloorStart is not a function` (or the two numbers differ).

- [ ] **Step 3: Implement the wiring**

1. Import the two helpers from `../core/pty-scroll.mjs` next to the existing import (L16).
2. Field: `private historyFloor = 0;` near the other viewport state (`viewportTop`).
3. `pushOutput(data, opts)` — extend the opts type with `scrollbackLines?: number` and, inside the existing `this.term.write(data, () => { … })` callback, add:

```ts
if (opts.authoritative) {
	this.historyFloor = historyFloorAfterHydrate(this.term.buffer.active.baseY, opts.scrollbackLines);
}
```

4. `handleAttachEvent("snapshotReady")`:
   - frame branch → `this.pushOutput(snap.frame, { authoritative: true, scrollbackLines: snap.scrollbackLines });`
   - extend the payload cast to `{ frame?: string; empty?: boolean; resnapshot?: boolean; scrollbackLines?: number }`
   - `snap.empty || snap.resnapshot` branch → after `this.term.reset();` add `this.historyFloor = 0;`
5. `resizeIfNeeded` — after `this.term.resize(this.cols, this.rows);` add `this.historyFloor = this.term.buffer.active.baseY;`.
6. New helper:

```ts
private scrollFloorStart(height: number): number {
	const bottom = this.bottomViewportTop(height);
	return Math.max(0, bottom - scrollableHistoryLines(this.term.buffer.active.baseY, this.historyFloor));
}
```

7. Use it as the scroll lower bound:
   - `tryScrollBy`: `scrollViewportTop(this.viewportTop, this.bottomViewportTop(this.bodyHeight()), linesUp, this.scrollFloorStart(this.bodyHeight()))`
   - `tryScrollToTop`: bail when `this.scrollFloorStart(height) <= 0 || this.viewportTop === this.scrollFloorStart(height)`
   - `clampViewportTop`: clamp to `[this.scrollFloorStart(height), this.bottomViewportTop(height)]`
   - Leave `project()`'s `start = this.viewportTop ?? this.bottomViewportTop(height)` unchanged (display alignment).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pty-attach-wheel.test.mjs test/pty-attach-alt-wheel.test.mjs test/pty-attach-wheel-fallback.test.mjs`
Expected: PASS — the new case passes and the existing wheel suites stay green (legacy path unaffected: `historyFloor` stays 0 there).

- [ ] **Step 5: Commit**

```bash
git add src/ui/pty-attach.ts test/pty-attach-wheel.test.mjs
git commit -m "fix(attach): ignore snapshot-hydration scrollback when scrolling the wheel (issue #205)"
```

---

### Task 4: Production-topology scenario for frame overflow

**Files:**
- Create: `test-support/pty-attach-frame-overflow-scenario.ts`
- Create: `test/pty-attach-frame-overflow.test.mjs`

**Interfaces:**
- Consumes: the component from Task 3; `captureTerminalSnapshot` / `synthesizeFullRedrawFrame` from `src/core/terminal-snapshot.mjs`; `createTerminalModel` / `feedOutput` / `whenIdle` from `src/core/terminal-model.mjs`.
- Produces: a JSON line on stdout with `{ attachBaseY, historyFloor, scrollableHistoryLines, firstForwardAt, firstForwardData, viewportTop, realHistoryCase, resetCase, resizeCase, missingFieldCase }`.

- [ ] **Step 1: Write the failing test**

Create `test/pty-attach-frame-overflow.test.mjs`:

```js
test("a snapshot frame taller than the attach viewport forwards the first wheel notch", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], { encoding: "utf8", timeout: 90_000 });
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.attachBaseY, 27, "topology pin: a 65-row frame in a 38-row terminal scrolls 27 rows");
	assert.equal(parsed.historyFloor, 27);
	assert.equal(parsed.scrollableHistoryLines, 0);
	assert.equal(parsed.firstForwardAt, 1, "the first notch must reach the child");
	assert.equal(parsed.firstForwardData, "\x1b[<64;4;3M");
	assert.equal(parsed.viewportTop, null, "follow-bottom is preserved");
	assert.equal(parsed.realHistoryCase.scrollable, 100, "runner-vouched history still scrolls locally");
	assert.equal(parsed.realHistoryCase.firstForwardAt, 101);
	assert.equal(parsed.resetCase.historyFloor, 0, "empty/resnapshot resets the floor");
	assert.equal(parsed.resizeCase.historyFloor, parsed.resizeCase.baseY, "resize re-bases the floor on the new baseY");
	assert.equal(parsed.resizeCase.scrollableHistoryLines, 0);
	assert.equal(parsed.missingFieldCase.historyFloor, parsed.missingFieldCase.attachBaseY, "a runner without scrollbackLines disables local history instead of NaN");
	assert.equal(parsed.missingFieldCase.firstForwardAt, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pty-attach-frame-overflow.test.mjs`
Expected: FAIL — scenario file missing.

- [ ] **Step 3: Implement the scenario**

`test-support/pty-attach-frame-overflow-scenario.ts` must, in one process:

1. Build a **runner-side** `createTerminalModel({ cols: 300, rows: 65, scrollback: 2000 })` and `feedOutput` a synthetic 65-row alternate/normal screen (no dependency on a live session). `await whenIdle(model)`.
2. `const dto = await captureTerminalSnapshot(model)`; `const frame = await synthesizeFullRedrawFrame(dto)`; require `dto.scrollback.length === 0`.
3. Serve a real named pipe (`net.createServer`) that answers `subscribe_terminal` with `snapshot_begin` / `snapshot_frame` / `snapshot_end` carrying `scrollbackLines: dto.scrollback.length`. **Ignore any `resize` control message** — the frame must stay 65 rows (spec §6 "帧投递接缝", option 1).
4. Build a fake TUI (`mode: "fullscreen"`, `terminal: { rows: 40, cols: 300 }`) and a real `PtyAttachComponent` with that pipe; `await` until `component.attachMode === "protocol"` **and** `component.receivedOutput`.
5. `await new Promise((resolve) => component.term.write("", resolve))` to drain the async parse before asserting.
6. Record `attachBaseY` (`component.term.buffer.active.baseY`), `historyFloor`, `scrollableHistoryLines` (call the pure helper with those two values).
7. Drive `component.handleMouse({ type: "wheel", wheelDelta: -1, x: 3, y: 3, screenX: 3, screenY: 3, width: 80, height: 22, shift: false, alt: false, ctrl: false })` and capture the forwarded `{type:"input"}` via the `Socket.prototype.write` interception pattern from `test-support/pty-attach-wheel-fallback-scenario.ts:113-119`.
8. Repeat the same flow with a model that first `feedOutput`s 100 lines of plain text (so `dto.scrollback.length === 100`), driving up to 120 notches and recording the first forwarded index into `realHistoryCase.firstForwardAt`.
9. Deliver one `snapshotReady` with `{ empty: true }` (call the component's attach-event handler or send a `snapshot_begin{empty}`+`snapshot_end` pair through the fake runner) and record `resetCase.historyFloor`.
10. **Resize case (A6)**: after the initial hydrate, call `component.render(120)` (a narrower width forces `resizeIfNeeded` → `term.resize`), drain the write queue, and record `resizeCase = { baseY, historyFloor, scrollableHistoryLines }`.
11. **Missing-field case (A7)**: repeat the hydrate with a fake runner that omits `scrollbackLines` from `snapshot_end`; record `missingFieldCase = { attachBaseY, historyFloor, firstForwardAt }`.
12. Print exactly one JSON line and exit 0; catch errors into `{ error }` and exit 0 so the test reports them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pty-attach-frame-overflow.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test-support/pty-attach-frame-overflow-scenario.ts test/pty-attach-frame-overflow.test.mjs
git commit -m "test(attach): pin the snapshot-hydration wheel topology (issue #205)"
```

---

### Task 5: Fullscreen dispatch smoke through the real `TuiAltScreen`

**Files:**
- Modify: `test-support/pty-attach-frame-overflow-scenario.ts` (new `tuiDispatch` section)
- Modify: `test/pty-attach-frame-overflow.test.mjs` (new assertions)

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: `tuiDispatch: { handleMouseCalls: number, firstForwardAt: number }` in the scenario JSON.

- [ ] **Step 1: Write the failing test**

```js
assert.ok(parsed.tuiDispatch.handleMouseCalls >= 1, "the wheel must reach the overlay component");
assert.equal(parsed.tuiDispatch.firstForwardAt, 1);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/pty-attach-frame-overflow.test.mjs`
Expected: FAIL — `parsed.tuiDispatch` undefined.

- [ ] **Step 3: Implement**

In the scenario, build `const tui = new TuiAltScreen(stubTerminal, false, undefined, { mouse: true, wheelScrollLines: 1 })`, `tui.showOverlay(component, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 })`, populate layouts with `tui.render(300)` + `tui.compositeOverlays(tui.render(300), 300, 40)`, then feed `"\x1b[<64;10;10M"` and read `(tui as any).renderedOverlayLayouts` / the component's `handleMouse` call count. The stub terminal needs `columns`, `rows`, `kittyProtocolActive`, `start`/`stop`/`drainInput` no-ops, `write`/`moveBy`/`hideCursor`/`showCursor`/`clearLine`/`clearFromCursor`/`clearScreen`/`setTitle`/`setProgress`/`setProgramStatus` no-ops.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/pty-attach-frame-overflow.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test-support/pty-attach-frame-overflow-scenario.ts test/pty-attach-frame-overflow.test.mjs
git commit -m "test(attach): drive the wheel through the real fullscreen dispatcher (issue #205)"
```

---

### Task 6: Docs + full verification gate

**Files:**
- Modify: `README.md` (attach paragraph, ~L201: document that the wheel forwards when the local scrollback is hydration residue)
- Modify: `CHANGELOG.md` — **not by hand**; skip unless `npm run verify` reports a missing PR after merge (repo AGENTS.md).

**Interfaces:**
- Consumes: all previous tasks.

- [ ] **Step 1: Update the README attach paragraph**

Append one sentence after the existing wheel description: the attach viewport only scrolls scrollback the hosted session actually produced; a snapshot hydration that is taller than the local window is not scrollable, and the wheel is forwarded to the session instead.

- [ ] **Step 2: Run the full gate**

Run: `npm run verify`
Expected: PASS — typecheck, perf gate, tests, coverage thresholds, pack dry-run.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(attach): explain wheel forwarding when hydrated scrollback is synthetic (issue #205)"
```

---

### Task 7: Post-implementation manual verification (U1)

**Files:** none (verification only)

**Interfaces:**
- Consumes: the merged branch loaded by a real pi process.

- [ ] **Step 1: Merge + refresh the pi git package**

After the PR merges: `cd C:/Users/27499/proj/opensource/pi-agent-board && git pull`, then `pi update` (or restart pi so it re-clones), then confirm
`git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board log --oneline -1` contains the merge commit.

- [ ] **Step 2: Restart pi completely**

The running process holds module caches; a hot reload does not pick up `src/` changes.

- [ ] **Step 3: Attach a long session and roll the wheel once**

pi fullscreen → `/agent-board` → attach a session whose `screen.log` exceeds 60 KB → one wheel notch up.

- [ ] **Step 4: Record the result**

PASS: the first notch shows the previous line of the child's transcript; no editor-row fragments; PageUp still behaves as before.
FAIL: record the observed baseY/historyFloor in the issue and reopen.
