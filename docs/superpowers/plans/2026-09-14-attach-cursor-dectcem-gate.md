# Attach Cursor DECTCEM Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the attach projection paint its solid inverse PTY-cursor block only when the child terminal reports the cursor as visible (DECTCEM), while keeping the zero-width `CURSOR_MARKER` that positions the hardware cursor for IME.

**Architecture:** A new pure reader `isPtyCursorHidden(term)` in `src/core/pty-attach-render.mjs` duck-types `term._core.coreService.isCursorHidden` and falls back to "visible" for unknown shapes. `PtyAttachComponent.project()` reads it once per frame and passes a boolean into `lineToAnsi()`, which keeps position-driven `CURSOR_MARKER` emission but gates the visible inverse block (and the past-end inverse space) on that boolean.

**Tech Stack:** Node ESM (`.mjs` pure core), TypeScript UI component exercised via `node --experimental-transform-types` smoke harnesses, `@xterm/headless` ^6.0.0, `node --test`, c8 coverage gates.

**Spec of record:** `docs/superpowers/specs/2026-09-14-attach-cursor-dectcem-gate-design.md` (commit `fbc0f09`).

## Global Constraints

- No new dependencies. `@xterm/headless` stays `^6.0.0` (production dependency, already used by `src/ui/pty-attach.ts`).
- Work only inside the worktree: `$WT=/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-102-attach-cursor-dectcem-gate`. Every path in this plan is relative to `$WT`; `git` commands use `git -C $WT`. `main` stays clean.
- Do not change the contracts of `projectPtyCursor()` or `detectCursorDesync()` — the 4 regression tests from issue #24 in `test/pty-attach-render.test.mjs` must pass unchanged.
- Do not touch the `CURSOR_MARKER` / synchronized-output machinery (#24/#28) or the desync heal (#11).
- `npm test` runs `node --test test/*.test.mjs`; coverage gates are lines 85 / functions 80 / branches 70 with `src/ui/*.ts`, `test/**`, `test-support/**` excluded by `.c8rc.json`.
- `npm run verify` = `tsc --noEmit` && `npm test` && `npm run test:coverage` && `npm run pack:dry`.
- `git add <file>` per file, never `git add -A`.

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/core/pty-attach-render.mjs` | Pure projection helpers (`projectPtyCursor`, `detectCursorDesync`, render scheduler). Holds the new duck-typed DECTCEM reader. | modify (add one function) |
| `src/ui/pty-attach.ts` | Attach component: buffer projection pipeline + rendering. | modify (type field, `project()`, `lineToAnsi()`) |
| `test/pty-attach-render.test.mjs` | Pure-function unit tests. | modify (add 2 tests) |
| `test-support/cursor-visibility-smoke.ts` | New component-level smoke: feed raw PTY bytes, render the real component, report booleans. | create |
| `test/pty-attach-cursor-visibility.test.mjs` | New wrapper that spawns the smoke under `--experimental-transform-types` and asserts its booleans. | create |

Task boundaries: Task 1 delivers a testable pure function (A1/A2). Task 2 delivers the user-visible behavior change plus its component-level proof (A3/A4/A5). Task 3 runs the repo-wide gate and the acceptance ledger (A6 + U1–U3 handoff) — it can fail independently of Tasks 1–2 (coverage/typecheck/pack), so it is its own task.

---

### Task 1: DECTCEM reader as a pure function

**Files:**
- Modify: `src/core/pty-attach-render.mjs` (insert after `projectPtyCursor`, which ends at the closing brace of that function)
- Test: `test/pty-attach-render.test.mjs` (append at end of file)

**Interfaces:**
- Consumes: nothing (new leaf function).
- Produces: `isPtyCursorHidden(term) -> boolean` — `true` only when xterm explicitly reports `term._core.coreService.isCursorHidden === true`; `false` for every other shape (missing `_core`, missing `coreService`, non-boolean value, throwing accessor, `null`/`undefined` term). Exported from `src/core/pty-attach-render.mjs`; Task 2 imports it.

- [ ] **Step 1: Write the failing tests**

Append to `test/pty-attach-render.test.mjs`. First add the two imports at the top of the file (after `import test from "node:test";` and after the existing `../src/core/pty-attach-render.mjs` import block):

```js
import { Terminal } from "@xterm/headless";
```

```js
import {
	createAttachOutputRenderScheduler,
	detectCursorDesync,
	isPtyCursorHidden,
	nextAttachRender,
	projectPtyCursor,
	shouldScheduleAttachRenderForMessage,
} from "../src/core/pty-attach-render.mjs";
```

Then append the tests:

```js
test("isPtyCursorHidden tracks the child terminal's DECTCEM state", async () => {
	const term = new Terminal({ cols: 40, rows: 10 });
	assert.equal(isPtyCursorHidden(term), false, "a fresh terminal reports a visible cursor");
	await new Promise((resolve) => term.write("\x1b[?25l", resolve));
	assert.equal(isPtyCursorHidden(term), true, "?25l must read as hidden");
	await new Promise((resolve) => term.write("\x1b[?25h", resolve));
	assert.equal(isPtyCursorHidden(term), false, "?25h must read as visible again");
});

test("isPtyCursorHidden falls back to visible for unknown terminal shapes", () => {
	assert.equal(isPtyCursorHidden(undefined), false);
	assert.equal(isPtyCursorHidden(null), false);
	assert.equal(isPtyCursorHidden({}), false);
	assert.equal(isPtyCursorHidden({ _core: {} }), false);
	assert.equal(isPtyCursorHidden({ _core: { coreService: {} } }), false);
	assert.equal(isPtyCursorHidden({ _core: { coreService: { isCursorHidden: false } } }), false);
	assert.equal(isPtyCursorHidden({ _core: { coreService: { isCursorHidden: undefined } } }), false);
	assert.equal(isPtyCursorHidden({ _core: { coreService: { isCursorHidden: "true" } } }), false);
	assert.equal(
		isPtyCursorHidden({
			get _core() {
				throw new Error("upstream shape change");
			},
		}),
		false,
		"a throwing accessor must degrade to visible, not break the projection",
	);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd $WT && node --test test/pty-attach-render.test.mjs`
Expected: FAIL — `isPtyCursorHidden is not a function` (TypeError) for both new tests; the pre-existing tests pass.

- [ ] **Step 3: Implement the reader**

In `src/core/pty-attach-render.mjs`, insert the new function immediately after `projectPtyCursor()` (i.e. between that function's closing brace and the `/** Coalesce PTY parser callbacks … */` comment block of `createAttachOutputRenderScheduler`):

```js
/**
 * Duck-typed read of the child terminal's DECTCEM visibility state.
 *
 * pi-tui hides the hardware cursor (ESC[?25l) on essentially every frame and
 * still parks it for IME positioning, so the xterm cursor position outlives its
 * visibility: it is a rendering byproduct, not a request to show a cursor. The
 * attach projection must not resurrect that parked cell as a visible block, and
 * must equally not hide a cursor the child wants shown (shells, vim,
 * PI_HARDWARE_CURSOR=1). Only an explicit `true` from xterm's cursor service
 * counts as hidden; anything unknown (renamed internals, another @xterm build)
 * falls back to visible, which is the pre-#102 behavior.
 */
export function isPtyCursorHidden(term) {
	try {
		return term?._core?.coreService?.isCursorHidden === true;
	} catch {
		return false;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd $WT && node --test test/pty-attach-render.test.mjs`
Expected: PASS — all tests in the file, including the 4 `projectPtyCursor` regressions.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add src/core/pty-attach-render.mjs test/pty-attach-render.test.mjs
git -C $WT commit -m "feat(core): read the child terminal's DECTCEM cursor visibility (issue #102)"
```

---

### Task 2: Gate the visible cursor block on DECTCEM

**Files:**
- Modify: `src/ui/pty-attach.ts` (`XtermLike._core`, the import from `../core/pty-attach-render.mjs`, `project()`, `lineToAnsi()`)
- Create: `test-support/cursor-visibility-smoke.ts`
- Create: `test/pty-attach-cursor-visibility.test.mjs`

**Interfaces:**
- Consumes: `isPtyCursorHidden(term) -> boolean` from Task 1.
- Produces: `lineToAnsi(line, reusable, term, lineIndex, selection, cursor, cursorHidden = false)` — private to `src/ui/pty-attach.ts`; `cursorHidden` defaults to `false`, so a missing argument keeps today's visible behavior. No public API changes.

- [ ] **Step 1: Write the failing smoke harness**

Create `test-support/cursor-visibility-smoke.ts`:

```ts
// Cursor-visibility regression harness (issue #102): the attach projection must
// honor the child terminal's DECTCEM state. A hidden cursor must never be painted
// as a solid inverse block, while the zero-width CURSOR_MARKER (hardware cursor
// positioning for IME and PI_HARDWARE_CURSOR=1) must survive either way.
// Run via `node --experimental-transform-types` (TS parameter properties).
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const CURSOR_MARKER = "\x1b_pi:c\x07";

const tui = {
	terminal: { rows: 12, cols: 40, columns: 40, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const keybindings = {} as never;

function makeAttach(): PtyAttachComponent {
	return new PtyAttachComponent(
		tui as never,
		theme,
		keybindings,
		() => {},
		{ socketPath: "/no/such/socket", title: "cursor-visibility" },
	);
}

/** Feed raw PTY bytes, then settle the attach transition so render() projects the buffer. */
async function writeToTerm(attach: PtyAttachComponent, data: string): Promise<void> {
	await new Promise<void>((resolve) => {
		(attach as unknown as { term: { write: (d: string, cb: () => void) => void } }).term.write(data, resolve);
	});
	(attach as unknown as { receivedOutput: boolean }).receivedOutput = true;
	(attach as unknown as { finishAttachTransition: () => void }).finishAttachTransition();
}

/** SGR parameter list emitted right after the CURSOR_MARKER, or null when no marker is rendered. */
function markerSgrFields(lines: string[]): string[] | null {
	for (const line of lines) {
		const at = line.indexOf(CURSOR_MARKER);
		if (at === -1) continue;
		const sgr = line.slice(at + CURSOR_MARKER.length).match(/^\x1b\[([\d;]*)m/);
		return sgr ? sgr[1].split(";") : [];
	}
	return null;
}

function hasInverseAttribute(lines: string[]): boolean {
	return markerSgrFields(lines)?.includes("7") ?? false;
}

function hasInverseSpace(lines: string[]): boolean {
	return lines.some((line) => line.includes("\x1b[7m"));
}

async function hiddenOnContentCell(): Promise<boolean> {
	const attach = makeAttach();
	// Cursor parked on the "e" of "hello" (row 0, col 1); the child says HIDDEN.
	await writeToTerm(attach, "hello\r\x1b[2G\x1b[?25l");
	const lines = attach.render(40);
	const ok = markerSgrFields(lines) !== null && !hasInverseAttribute(lines) && !hasInverseSpace(lines);
	attach.dispose();
	return ok;
}

async function hiddenOnEmptyLine(): Promise<boolean> {
	const attach = makeAttach();
	// Cursor on the empty line below "hello": the empty-line early-return path.
	await writeToTerm(attach, "hello\r\n\x1b[?25l");
	const lines = attach.render(40);
	const ok = markerSgrFields(lines) !== null && !hasInverseAttribute(lines) && !hasInverseSpace(lines);
	attach.dispose();
	return ok;
}

async function hiddenPastEndOfLine(): Promise<boolean> {
	const attach = makeAttach();
	// Cursor one column past "abc": the past-end-of-content branch.
	await writeToTerm(attach, "abc\x1b[?25l");
	const lines = attach.render(40);
	const ok = markerSgrFields(lines) !== null && !hasInverseSpace(lines);
	attach.dispose();
	return ok;
}

async function visibleOnContentCell(): Promise<boolean> {
	const attach = makeAttach();
	await writeToTerm(attach, "hello\r\x1b[2G\x1b[?25h");
	const lines = attach.render(40);
	const ok = hasInverseAttribute(lines);
	attach.dispose();
	return ok;
}

async function visibleByDefaultOnContentCell(): Promise<boolean> {
	const attach = makeAttach();
	// No DECTCEM sequence at all: an unknown state must keep today's behavior.
	await writeToTerm(attach, "hello\r\x1b[2G");
	const lines = attach.render(40);
	const ok = hasInverseAttribute(lines);
	attach.dispose();
	return ok;
}

async function visiblePastEndOfLine(): Promise<boolean> {
	const attach = makeAttach();
	await writeToTerm(attach, "abc\x1b[?25h");
	const lines = attach.render(40);
	const ok = markerSgrFields(lines) !== null && hasInverseSpace(lines);
	attach.dispose();
	return ok;
}

const out: Record<string, boolean> = {
	hiddenOnContentCellOmitsInverseBlock: await hiddenOnContentCell(),
	hiddenOnEmptyLineKeepsMarkerWithoutBlock: await hiddenOnEmptyLine(),
	hiddenPastEndOmitsInverseSpace: await hiddenPastEndOfLine(),
	visibleOnContentCellPaintsInverseBlock: await visibleOnContentCell(),
	visibleByDefaultOnContentCell: await visibleByDefaultOnContentCell(),
	visiblePastEndPaintsInverseSpace: await visiblePastEndOfLine(),
};

console.log(JSON.stringify(out));
```

- [ ] **Step 2: Write the wrapper test**

Create `test/pty-attach-cursor-visibility.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SMOKE_SCRIPT = join(ROOT_DIR, "test-support", "cursor-visibility-smoke.ts");

// Issue #102: the projection must honor the child's DECTCEM state. pi-tui hides the
// hardware cursor (ESC[?25l) on nearly every frame, so an unconditional inverse block
// shows up as a ghost cell at the last diff-write/park position.
test("attach projection honors the child's cursor visibility (issue #102)", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SMOKE_SCRIPT], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const parsed = JSON.parse(out);
	assert.equal(parsed.hiddenOnContentCellOmitsInverseBlock, true, "a hidden cursor must not paint an inverse block on a content cell");
	assert.equal(parsed.hiddenOnEmptyLineKeepsMarkerWithoutBlock, true, "a hidden cursor on an empty line keeps the marker but paints no block");
	assert.equal(parsed.hiddenPastEndOmitsInverseSpace, true, "a hidden cursor past the line content must not append an inverse space");
	assert.equal(parsed.visibleOnContentCellPaintsInverseBlock, true, "a visible cursor still paints the inverse block");
	assert.equal(parsed.visibleByDefaultOnContentCell, true, "an unknown DECTCEM state must keep today's visible behavior");
	assert.equal(parsed.visiblePastEndPaintsInverseSpace, true, "a visible cursor past the line content still appends an inverse space");
});
```

- [ ] **Step 3: Run the smoke to verify the hidden cases fail**

Run: `cd $WT && node --test test/pty-attach-cursor-visibility.test.mjs`
Expected: FAIL — `hiddenOnContentCellOmitsInverseBlock` (false: the block is still painted), `hiddenOnEmptyLineKeepsMarkerWithoutBlock` (false), `hiddenPastEndOmitsInverseSpace` (false). The three `visible*` assertions already pass (they are regression guards).
Sanity-check the raw output too: `node --experimental-transform-types test-support/cursor-visibility-smoke.ts`

- [ ] **Step 4: Wire the visibility flag through the component**

Edit `src/ui/pty-attach.ts`.

(a) Extend the existing `_core` declaration in `interface XtermLike` (around line 78):

```ts
	_core?: {
		coreService?: { isCursorHidden?: boolean };
		_oscLinkService?: {
```

(b) Add `isPtyCursorHidden` to the existing import from `../core/pty-attach-render.mjs` (around line 10), keeping the alphabetical order used there.

(c) In `project()`, read the state once per frame and pass it down:

```ts
		const cursor = projectPtyCursor(buf, start, height);
		const cursorHidden = isPtyCursorHidden(this.term);
		for (let i = start; i < end; i++) {
			out.push(lineToAnsi(buf.getLine(i), reusable, this.term, i, selection, cursor, cursorHidden));
		}
```

(d) `lineToAnsi()`: add the parameter and split the two concerns.

```ts
function lineToAnsi(
	line: BufferLineLike | undefined,
	reusable: BufferCellLike,
	term: XtermLike,
	lineIndex: number,
	selection: NormalizedSelection | null,
	cursor: { row: number; col: number } | null,
	cursorHidden = false,
): string {
	const isCursorRow = cursor !== null && cursor.row === lineIndex;
	let last = -1;
	if (!line) {
		// No buffer line: keep the marker (IME positioning) and paint the inverse block
		// only while the child reports a visible cursor.
		if (isCursorRow && cursor!.col >= 0) return cursorHidden ? CURSOR_MARKER : CURSOR_MARKER + "\x1b[7m \x1b[0m";
		return "";
	}
	for (let x = 0; x < line.length; x++) {
		const cell = line.getCell(x, reusable);
		if (!cell || cell.getWidth() === 0) continue;
		if (cell.getChars()) last = x;
	}
	if (last < 0) {
		// Empty line: same split as above.
		if (isCursorRow && cursor!.col >= 0) return cursorHidden ? CURSOR_MARKER : CURSOR_MARKER + "\x1b[7m \x1b[0m";
		return "";
	}
```

then in the cell loop replace the cursor block with:

```ts
		// Position and visibility are separate concerns: the zero-width CURSOR_MARKER
		// (stripped by the TUI) always marks where the hardware cursor belongs for IME
		// and PI_HARDWARE_CURSOR=1 terminals, while the solid inverse block is only
		// painted when the child terminal itself reports the cursor as visible. pi-tui
		// parks a hidden cursor at a diff-write byproduct position, so painting it
		// unconditionally showed a ghost block (issue #102).
		const isCursor = isCursorRow && x === cursor!.col;
		if (isCursor) out += CURSOR_MARKER;
		const paintCursor = isCursor && !cursorHidden;
		const key = attrKey(cell, selected, paintCursor);
		if (key !== prevAttr) {
			out += attrsToAnsi(cell, selected, paintCursor);
			prevAttr = key;
		}
```

and finally the past-end branch:

```ts
	// Cursor past the end of the line content (cursorX == cols or beyond last cell):
	// append an inverse space so a VISIBLE position shows, keeping the marker either way.
	if (isCursorRow && cursor!.col > last) {
		out += CURSOR_MARKER + (cursorHidden ? "" : "\x1b[7m \x1b[0m");
	}
```

- [ ] **Step 5: Run the smoke and the neighbouring suites**

Run: `cd $WT && node --test test/pty-attach-cursor-visibility.test.mjs test/pty-attach-render.test.mjs test/pty-attach-detach-gate.test.mjs test/pty-attach-desync-heal.test.mjs test/ui-smoke.test.mjs`
Expected: PASS — all 6 smoke booleans true; the #24/#66/#11 suites unchanged.

- [ ] **Step 6: Commit**

```bash
cd $WT && git add src/ui/pty-attach.ts test-support/cursor-visibility-smoke.ts test/pty-attach-cursor-visibility.test.mjs
git -C $WT commit -m "fix(attach): stop painting the PTY cursor block for a hidden cursor (issue #102)"
```

---

### Task 3: Repo-wide gate and acceptance ledger

**Files:**
- No source changes expected. If the gate surfaces a gap, fix it in the file the gap belongs to and commit with an `fix(attach): …` message.

**Interfaces:**
- Consumes: Tasks 1–2 deliverables.
- Produces: verified evidence for spec items A1–A6 and a handoff checklist for U1–U3 (manual verification on a real terminal).

- [ ] **Step 1: Run the full gate**

Run: `cd $WT && npm run verify`
Expected: PASS — `tsc --noEmit` clean; all `test/*.test.mjs` green; c8 reports the gates (lines 85 / functions 80 / branches 70) satisfied; `pack:dry` succeeds.

- [ ] **Step 2: Confirm the new pure function is covered**

Run: `cd $WT && npm run test:coverage 2>&1 | rg -A 2 "pty-attach-render"`
Expected: `src/core/pty-attach-render.mjs` at 100% (or at least no line for `isPtyCursorHidden` in the uncovered list). `src/ui/pty-attach.ts` is intentionally absent — `.c8rc.json` excludes `src/ui/*.ts`, which is why the behavior assertions live in the component smoke.

- [ ] **Step 3: Re-run the issue-#102 reproduction harness against the fix**

Run the two research harnesses (outside the repo, so nothing gets committed):

```bash
node /home/elling/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-102/research/replay-cursor.mjs \
  ~/.pi/agent/agent-board/views/view_6e2de515c0/screen.log 120 36
cd $WT && node --experimental-transform-types \
  /home/elling/.claude/github-issue-driven/zhuxixi/pi-agent-board/issue-102/research/replay-component.ts \
  ~/.pi/agent/agent-board/views/view_6e2de515c0/screen.log 120 36
```

Expected: `isCursorHidden` still `true`; `replay-component.ts` now reports `blockPaintedAtMarker: false` with a non-empty `markerLines` array (marker kept, block gone). Record both outputs for the acceptance ledger.

- [ ] **Step 4: Fill the acceptance ledger**

Record, per spec ID, the exact command and observed result: A1/A2 (`node --test test/pty-attach-render.test.mjs`), A3/A4/A5 (`node --test test/pty-attach-cursor-visibility.test.mjs`), A6 (`npm run verify`). Mark U1/U2/U3 as `pending` with their manual steps from the spec — a green test suite does not stand in for them.

- [ ] **Step 5: Commit any gate fix**

Only if Steps 1–2 required a change. Stage the files the gate actually flagged (for example `git -C $WT add src/core/pty-attach-render.mjs`), then commit with a message naming that gap:

```bash
cd $WT && git add src/core/pty-attach-render.mjs
# or: git add src/ui/pty-attach.ts test/pty-attach-render.test.mjs
# whichever files the failing gate flagged — never `git add -A`
git -C $WT commit -m "fix(attach): cover the cursor-visibility branch the coverage gate reported (issue #102)"
```

Otherwise leave the branch at the Task 2 commit and proceed to local code review (`superpowers:requesting-code-review` or the `workflow` tool's `code-review` mode), then stop for explicit user approval before pushing/opening the PR.
