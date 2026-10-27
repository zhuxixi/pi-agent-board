# Fullscreen selection highlight clear — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the fullscreen attach view, drop pi-tui's text selection as soon as copy-on-release has run, so the inverse-video highlight does not outlive the copy (issue #172).

**Architecture:** Reuse the existing #174 deferred hook (`handleMouse` → `process.nextTick` after a left `release`/`click`) to read pi's final selection, mirror it into X11 PRIMARY as today, then clear pi's selection via a feature-detected private method and request one repaint. The predicate that schedules the hook becomes env-free; the kill switch stays where it already lives (`writePrimarySelection`). The clear is gated on `getCopyOnSelect() !== false` so users who disabled copy-on-select keep their selection for `Ctrl+X`.

**Tech Stack:** TypeScript component (`src/ui/pty-attach.ts`), a pure decision predicate in `src/core/pty-scroll.mjs`, `node:test` unit tests, a component-level scenario harness with a fake fullscreen TUI and a PATH-stubbed `xclip`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-27-issue-172-fullscreen-selection-clear-design.md` (v3).
- `clearTextSelection()` is private in pi-tui's typings → always feature-detect; degrade, never throw.
- `resetTextSelection()` must not be used (it clears `lastClick` and would break double-click word / triple-click line selection).
- Regular/legacy mode is out of scope (issue #250); do not touch `handleLocalMouseEvent`.
- Tabs for indentation, English comments, conventional commit subjects, no `git add -A`.

---

### Task 1: Replace the mirror predicate with an env-free selection-end predicate

**Files:**
- Modify: `src/core/pty-scroll.mjs:271-282`
- Test: `test/pty-scroll.test.mjs:20`, `test/pty-scroll.test.mjs:244-262`

**Interfaces:**
- Produces: `isFullscreenSelectionEnd(event) → boolean` (exported from `src/core/pty-scroll.mjs`).
- Removes: `shouldMirrorSelectionToPrimary(event, { nativePasteEnabled })`.

- [ ] **Step 1: Update the unit test first**

In `test/pty-scroll.test.mjs` replace the import name and the test block:

```js
test("isFullscreenSelectionEnd: only the left button's release/click ends a fullscreen selection", () => {
	assert.equal(isFullscreenSelectionEnd(ev("release", "left")), true);
	assert.equal(isFullscreenSelectionEnd(ev("click", "left")), true);
	const cases = [
		["press", "left"],
		["move", "left"],
		["drag", "left"],
		["wheel", "left"],
		["release", "middle"],
		["release", "right"],
		["release", "none"],
		["click", "middle"],
		["click", "none"],
		["press", "middle"],
	];
	for (const [type, button] of cases) {
		assert.equal(isFullscreenSelectionEnd(ev(type, button)), false, `${type}/${button}`);
	}
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pty-scroll.test.mjs`
Expected: FAIL — `isFullscreenSelectionEnd is not a function`.

- [ ] **Step 3: Replace the helper**

```js
/**
 * Issue #174 (B2) / #172: whether a normalized mouse event ends a fullscreen text
 * selection gesture the attach overlay must settle — mirror the selection into X11
 * PRIMARY (#174) and drop pi's highlight once copy-on-select has run (#172). Only
 * release/click of the left button ends a selection in TuiAltScreen; pi owns the
 * gesture, so the overlay observes without consuming. Pure: the native-paste kill
 * switch is applied by writePrimarySelection, not here.
 */
export function isFullscreenSelectionEnd(event) {
	return (event.type === "release" || event.type === "click") && event.button === "left";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pty-scroll.test.mjs`
Expected: PASS (all cases, no import errors).

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-scroll.mjs test/pty-scroll.test.mjs
git commit -m "refactor(attach): selection-end predicate for fullscreen settle (issue #172)"
```

---

### Task 2: Clear pi's selection in the deferred settle hook

**Files:**
- Modify: `src/ui/pty-attach.ts:17` (import), `:521-530` (schedule branch), `:1376-1381` (settle method)
- Test: `test-support/pty-attach-selection-mirror-scenario.ts`, `test/pty-attach-selection-mirror.test.mjs`

**Interfaces:**
- Consumes: `isFullscreenSelectionEnd(event)` from Task 1.
- Produces: `private settleFullscreenSelection(nativePasteEnabled: boolean): void`; type `FullscreenSelectionHost`.

- [ ] **Step 1: Extend the scenario with clear hooks and cases**

In `test-support/pty-attach-selection-mirror-scenario.ts`:

1. Add module-level knobs next to `selectionText`:

```ts
let copyOnSelect = true;
let clearAvailable = true;
let clearCalls = 0;
```

2. Give the fake TUI the two new members (the conditional spread must be inside the object literal):

```ts
	const tui = {
		mode: "fullscreen",
		getActiveSelectionText: () => selectionText,
		getCopyOnSelect: () => copyOnSelect,
		...(clearAvailable
			? {
					clearTextSelection: () => {
						clearCalls += 1;
						selectionText = undefined; // prove read-before-clear: a wrong order yields no PRIMARY write
					},
				}
			: {}),
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
	};
```

3. Add result fields and one reset helper:

```ts
	releaseClears: -1,
	clickClears: -1,
	emptyClears: -1,
	killSwitchClears: -1,
	nonEndingClears: -1,
	copyOnSelectOffWrites: -1,
	copyOnSelectOffClears: -1,
	fallbackError: null as string | null,
	fallbackWrites: -1,
```

```ts
const resetFixture = (text: string | undefined = "mirror-fixture-text") => {
	selectionText = text;
	copyOnSelect = true;
	clearAvailable = true;
	clearCalls = 0;
};
```

4. Call `resetFixture()` at the start of every existing case, and record the clear deltas:

- case 1 (release): `result.releaseClears = clearCalls;`
- case 2 (click): `result.clickClears = clearCalls;`
- case 3 (empty): set `resetFixture(undefined)`, then `result.emptyClears = clearCalls;`
- case 4 (kill switch): `resetFixture()`, then `result.killSwitchClears = clearCalls;`
- case 5 (press/move): `resetFixture()`, then `result.nonEndingClears = clearCalls;`
- new case 6 (`copyOnSelect = false`): `resetFixture(); copyOnSelect = false;` handle release; assert writes 1 and clears 0.
- new case 7 (no `clearTextSelection`): `resetFixture(); clearAvailable = false;` wrap the call in try/catch, capture `fallbackError`, and record `fallbackWrites`.

5. The middle-click paste case stays last and must also call `resetFixture()`.

- [ ] **Step 2: Run the scenario test to verify it fails**

Run: `node --test test/pty-attach-selection-mirror.test.mjs`
Expected: FAIL on the new assertions (`releaseClears` is 0, because the component never clears yet).

- [ ] **Step 3: Wire the component**

Import (line 17): replace `shouldMirrorSelectionToPrimary` with `isFullscreenSelectionEnd`.

Replace the schedule branch:

```ts
		const nativePasteEnabled = process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE !== "0";
		if (isFullscreenSelectionEnd(event)) {
			// Observe only — pi's fullscreen selection keeps the event. Overlays are
			// dispatched before TuiAltScreen finalizes (and copies) the selection for
			// this event, so settling must run deferred (issue #174).
			process.nextTick(() => this.settleFullscreenSelection(nativePasteEnabled));
			return undefined;
		}
```

Add the structural type near the other top-level types in the file:

```ts
/** The pi-tui members the attach view reads without a public typing contract:
 * getActiveSelectionText/clearTextSelection are private in TuiAltScreen's d.ts
 * (runtime-reachable), getCopyOnSelect is public. All are feature-detected. */
interface FullscreenSelectionHost {
	getActiveSelectionText?: () => string | undefined;
	getCopyOnSelect?: () => boolean;
	clearTextSelection?: () => void;
}
```

Rename `mirrorFullscreenSelectionToPrimary` to `settleFullscreenSelection` and extend it:

```ts
	/** Issue #174 (B2) + #172: a selection gesture ended inside this overlay and pi has
	 * finalized (and copied) its selection. Mirror the text into X11 PRIMARY so
	 * middle-click paste closes the loop, then drop pi's selection so the inverse-video
	 * highlight does not outlive the copy. Clearing is skipped when copy-on-select is
	 * off (the user copies later with pi's Ctrl+X) and when the pi-tui method is absent
	 * (older/newer runtime) — that degrades to the previous behaviour instead of
	 * throwing. clearTextSelection preserves pi's multi-click history; resetTextSelection
	 * would reset lastClick and break double-click word / triple-click line selection. */
	private settleFullscreenSelection(nativePasteEnabled: boolean): void {
		if (this.closed) return;
		const alt = this.tui as FullscreenSelectionHost;
		const text = alt.getActiveSelectionText?.();
		if (typeof text !== "string" || text.length === 0) return;
		if (nativePasteEnabled) this.writePrimarySelection(text);
		if (alt.getCopyOnSelect?.() === false) return;
		if (typeof alt.clearTextSelection !== "function") return;
		alt.clearTextSelection();
		this.scheduleRender();
	}
```

- [ ] **Step 4: Update the test assertions**

In `test/pty-attach-selection-mirror.test.mjs`, keep every existing assertion and add:

```js
	assert.equal(parsed.releaseClears, 1, "the highlight must be cleared once the copy has run");
	assert.equal(parsed.clickClears, 1, "a click ending with a live selection clears too");
	assert.equal(parsed.emptyClears, 0, "an empty selection must not clear");
	assert.equal(parsed.killSwitchClears, 1, "the highlight clear is not governed by NATIVE_PASTE");
	assert.equal(parsed.nonEndingClears, 0, "press/move must not clear");
	assert.equal(parsed.copyOnSelectOffWrites, 1, "the PRIMARY mirror still runs with copy-on-select off");
	assert.equal(parsed.copyOnSelectOffClears, 0, "copy-on-select off keeps the selection for Ctrl+X");
	assert.equal(parsed.fallbackError, null, "a missing clearTextSelection must not throw");
	assert.equal(parsed.fallbackWrites, 1, "the PRIMARY mirror still runs without the clear method");
```

- [ ] **Step 5: Run the scenario test to verify it passes**

Run: `node --test test/pty-attach-selection-mirror.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/pty-attach.ts test-support/pty-attach-selection-mirror-scenario.ts test/pty-attach-selection-mirror.test.mjs
git commit -m "fix(attach): clear the fullscreen selection highlight after copy-on-release (issue #172)"
```

---

### Task 3: Full verification

**Files:** none.

- [ ] **Step 1: Run the repository gate**

Run: `npm run verify`
Expected: typecheck, perf gate, tests, coverage thresholds, pack:dry all pass.

- [ ] **Step 2: Confirm no scope drift**

Run: `git diff --stat origin/main`
Expected: only the spec, the plan, `src/ui/pty-attach.ts`, `src/core/pty-scroll.mjs`, `test/pty-scroll.test.mjs`, `test-support/pty-attach-selection-mirror-scenario.ts`, `test/pty-attach-selection-mirror.test.mjs`. `handleLocalMouseEvent` and `test-support/pty-attach-legacy-drag-scenario.ts` untouched.
