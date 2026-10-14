# Issue #187 — motion-less drag classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the legacy/regular-mode attach path, classify a mouse release as a drag from the gesture's
*screen* geometry (or a motion event) instead of only from the "a move event arrived" flag, so a Warp
fast flick (press + release, zero motion) copies the selection instead of falling into the click path.

**Architecture:** The decision becomes a pure helper in `src/core/pty-scroll.mjs`
(`selectionReleaseIsDrag`, with `sameScreenCell`); the component records the raw reported screen cell
at press (`selection.screenAnchor`) and feeds both cells to the helper on release. Buffer-space
points stay in charge of the selection range only — they must never be compared across two events,
because the viewport base drifts while a session streams. The copy branch itself is unchanged, so
#172's "highlight stays until the next click" contract is preserved.

**Tech Stack:** TypeScript (`src/ui/pty-attach.ts`), ESM JavaScript (`src/core/pty-scroll.mjs`),
`node:test` + `assert/strict`, component-level scenarios run through
`node --experimental-transform-types`, `@xterm/headless`, real runner socket (`runner/pty-runner.mjs`)
with the fake PTY child (`test-support/fake-pty-pi.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-14-issue-187-motionless-drag-design.md` (reviewed v4,
sha256 `2092b5d83bcf3da0109a2d8020a636aa3b0459af68e420a75f83533a5ede947e`).

## Global Constraints

- Work in this worktree only: `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-187-attach-legacy-motionless-drag`
  (all paths below are relative to it). Never touch the main checkout.
- Baseline: `origin/main` @ `3624007`. The reviewed spec cites `f81949d` line numbers; `#190` added 25
  lines above `handleLocalMouseEvent`, so **use the line numbers in this plan**, which are current.
- `node_modules` is a symlink to the main checkout — do not run `npm install` in the worktree.
- Tabs for indentation. English comments and commit messages. Conventional commit subjects
  (`feat`/`fix`/`test`/`docs`), no `(#N)` suffix until the PR exists.
- Stage files individually (`git add <file>`); never `git add -A`.
- Definition of done: `npm run verify` (typecheck + perf gate + tests + coverage + pack:dry) passes
  from the worktree root.
- The two existing harness patterns to copy from (do not invent a third):
  `test-support/pty-attach-mouse-scenario.ts` (+ `test/pty-attach-mouse.test.mjs`) and
  `test-support/pty-attach-alt-wheel-scenario.ts` (+ `test/pty-attach-alt-wheel.test.mjs`).
- Out of scope (unchanged, do not "fix while you are here"): the selection range storage, the
  press/move branches, autoscroll, middle-click paste, the PRIMARY mirror semantics, wheel handling,
  the fullscreen `handleMouse` path, and the double-click comparison (still buffer-space by design —
  see the spec's guarantee boundaries). #188/#189 stay broken; do not build on their fix.

## File structure

| Path | Responsibility | Action |
| --- | --- | --- |
| `src/core/pty-scroll.mjs` | pure mouse/geometry decision helpers | modify: move `sameMousePoint` in, add `sameScreenCell`, `selectionReleaseIsDrag` |
| `src/ui/pty-attach.ts` | attach component; owns selection state and the copy branch | modify: import the helpers, drop the local `sameMousePoint`, record `screenAnchor`, use the decision |
| `test/pty-scroll.test.mjs` | unit decision tables | modify: A1 cases |
| `test-support/pty-attach-legacy-drag-scenario.ts` | component-level legacy gesture harness (default-mode PTY) | create |
| `test/pty-attach-legacy-drag.test.mjs` | asserts the four static-PTY cases (A2/A3/A4/A6) | create |
| `test-support/pty-attach-legacy-drag-drift-scenario.ts` | component-level drift harness (`steady` PTY) | create |
| `test/pty-attach-legacy-drag-drift.test.mjs` | asserts the drift negative control (A5) | create |

Acceptance traceability (spec ID → task/step):

| Spec ID | Covered by |
| --- | --- |
| A1 | Task 1 (steps 1–4) |
| A2 | Task 2 (steps 1–5, case 1) |
| A3 | Task 2 (step 6, case 2) |
| A4 | Task 2 (step 6, case 3) |
| A6 | Task 2 (step 6, case 4) |
| A5 | Task 3 (steps 1–5) |
| A7 / A8 | Task 4 (steps 1–3) |
| U1 / U2 / U3 | Task 4 (step 4 — manual runbook handed to the operator) |

---

### Task 1: pure gesture-decision helpers (A1)

**Files:**
- Modify: `src/core/pty-scroll.mjs` (append at end of file)
- Modify: `src/ui/pty-attach.ts` (import line 15; delete local `sameMousePoint` at lines 1700-1702)
- Test: `test/pty-scroll.test.mjs` (append at end of file)

**Interfaces:**
- Consumes: nothing.
- Produces: `sameMousePoint(a, b) -> boolean` (buffer points `{line, col}`, 1-cell col slack),
  `sameScreenCell(a, b) -> boolean` (screen cells `{row, col}`, 1-cell col slack),
  `selectionReleaseIsDrag({dragging, pressScreen, releaseScreen}) -> boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pty-scroll.test.mjs` (and add `sameMousePoint`, `sameScreenCell`,
`selectionReleaseIsDrag` to the existing import block at the top — keep the list alphabetical):

```js
test("sameMousePoint: same buffer line within the 1-cell slack", () => {
	assert.equal(sameMousePoint({ line: 4, col: 10 }, { line: 4, col: 10 }), true);
	assert.equal(sameMousePoint({ line: 4, col: 10 }, { line: 4, col: 11 }), true);
	assert.equal(sameMousePoint({ line: 4, col: 10 }, { line: 4, col: 12 }), false);
	assert.equal(sameMousePoint({ line: 4, col: 10 }, { line: 5, col: 10 }), false);
});

test("sameScreenCell: same screen row within the 1-cell slack", () => {
	assert.equal(sameScreenCell({ row: 2, col: 1 }, { row: 2, col: 1 }), true);
	assert.equal(sameScreenCell({ row: 2, col: 1 }, { row: 2, col: 2 }), true);
	assert.equal(sameScreenCell({ row: 2, col: 1 }, { row: 2, col: 3 }), false);
	assert.equal(sameScreenCell({ row: 2, col: 1 }, { row: 3, col: 1 }), false);
});

test("selectionReleaseIsDrag: geometry decides in screen cells; missing geometry degrades to a click", () => {
	const press = { row: 2, col: 1 };
	// a motion event always wins
	assert.equal(selectionReleaseIsDrag({ dragging: true, pressScreen: press, releaseScreen: press }), true);
	assert.equal(selectionReleaseIsDrag({ dragging: true, pressScreen: null, releaseScreen: null }), true);
	// a stationary gesture is a click, including the 1-cell report slack
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: { row: 2, col: 1 } }), false);
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: { row: 2, col: 2 } }), false);
	// motion-less drags: horizontally past the slack, or any vertical movement
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: { row: 2, col: 16 } }), true);
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: { row: 3, col: 1 } }), true);
	// an out-of-body release compares RAW reported cells, never the clamped buffer point
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: { row: 30, col: 16 } }), true);
	// missing geometry degrades to the pre-fix answer
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: null, releaseScreen: press }), false);
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: null }), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/pty-scroll.test.mjs`
Expected: FAIL — `sameMousePoint is not defined` / `sameScreenCell is not defined` /
`selectionReleaseIsDrag is not defined` (import resolution error), existing tests still listed.

- [ ] **Step 3: Implement the helpers**

Append to `src/core/pty-scroll.mjs`:

```js
/**
 * Issue #187: two mouse points are "the same" within the 1-cell coordinate slack
 * terminals report. Buffer-space comparison ({line, col}) — shared by double-click
 * detection. Moved here from pty-attach.ts so both comparisons have one definition.
 * Pure by contract.
 */
export function sameMousePoint(a, b) {
	return a.line === b.line && Math.abs(a.col - b.col) <= 1;
}

/**
 * Issue #187: two SCREEN cells are "the same" within the same 1-cell slack. Screen
 * space ({row, col}) is what the pointer actually did; buffer space drifts while a
 * session streams (the viewport base moves), which is why the drag/click decision must
 * not compare buffer points captured at two different moments. Pure by contract.
 */
export function sameScreenCell(a, b) {
	return a.row === b.row && Math.abs(a.col - b.col) <= 1;
}

/**
 * Issue #187: whether a mouse release ends a real selection drag. Terminals such as
 * Warp deliver a fast drag as press + release with zero motion events, so the move flag
 * alone is not sufficient — the gesture geometry decides. Both points are SCREEN cells
 * as reported by the terminal (never the clamped buffer point). Missing geometry (no
 * screen anchor recorded) degrades to the pre-fix answer: not a drag. Pure by contract.
 */
export function selectionReleaseIsDrag({ dragging, pressScreen, releaseScreen }) {
	if (dragging) return true;
	if (!pressScreen || !releaseScreen) return false;
	return !sameScreenCell(pressScreen, releaseScreen);
}
```

- [ ] **Step 4: Delete the local copy and import the moved helper**

In `src/ui/pty-attach.ts`:
- line 15 import: add `sameMousePoint` (alphabetical: after `resolveWheelLines`, before `scrollViewportTop`)
- delete the local definition at lines 1700-1702:

```ts
function sameMousePoint(a: MousePoint, b: MousePoint): boolean {
	return a.line === b.line && Math.abs(a.col - b.col) <= 1;
}
```

`isDoubleClickCandidate` (line 1120) keeps calling `sameMousePoint` unchanged — same function, new home.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `node --test test/pty-scroll.test.mjs && node --test test/pty-attach-mouse.test.mjs && npm run typecheck`
Expected: all PASS (the new cases green, the component scenarios unaffected by the move).

- [ ] **Step 6: Commit**

```bash
git add src/core/pty-scroll.mjs src/ui/pty-attach.ts test/pty-scroll.test.mjs
git commit -m "refactor(attach): pure gesture-decision helpers in pty-scroll

Move sameMousePoint next to its peers and add sameScreenCell plus
selectionReleaseIsDrag so the drag/click decision has a testable pure
core. No behaviour change yet: the component still decides on the move
flag alone (issue #187)."
```

---

### Task 2: screen-space wiring + component-level gesture coverage (A2, A3, A4, A6)

**Files:**
- Modify: `src/ui/pty-attach.ts` (type at line 153, selection field at line 223, press branch at
  lines 1059-1060, release branch at line 1079, import line 15)
- Create: `test-support/pty-attach-legacy-drag-scenario.ts`
- Create: `test/pty-attach-legacy-drag.test.mjs`

**Interfaces:**
- Consumes: `selectionReleaseIsDrag` from Task 1.
- Produces: `MouseSelection` gains an optional `screenAnchor: { row: number; col: number }`;
  the scenario prints one JSON line with the fields the test asserts
  (`sawContent`, `motionlessOsc52`, `motionlessPrimary`, `motionlessSelectionSurvives`,
  `motionlessForwardedInput`, `movefulOsc52`, `clickPressedSelection`, `clickOsc52`,
  `clickSelectionCleared`, `doubleOsc52`, `doubleSelectionIsWord`).

- [ ] **Step 1: Write the failing component scenario**

Create `test-support/pty-attach-legacy-drag-scenario.ts`. It drives the REAL component against a REAL
runner socket (default fake-PTY mode: one stable `fake pi ready` line, no output during the gestures)
with a fake TUI capturing `terminal.write`, and a PATH-stubbed `xclip` that logs its writes:

```ts
// Component-level legacy-path drag coverage (issue #187): the REAL
// PtyAttachComponent against a REAL runner socket (fake pty child in default
// mode, so the buffer holds one stable line) with a fake TUI capturing
// terminal.write and a PATH-stubbed xclip logging PRIMARY writes. Verifies:
//   1. press + release with ZERO motion events across 15 columns copies the line
//      (OSC 52 payload + PRIMARY mirror) and the selection survives the 260 ms
//      pending-click timer — the Warp fast-flick byte stream;
//   2. the same gesture with a motion event in between copies the SAME text;
//   3. a same-cell press+release still behaves as a click (no copy, cleared);
//   4. two rapid same-cell clicks still select the word under the pointer and
//      copy it — the click path this change routes through.
// Run via `node --experimental-transform-types`.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-legacy-drag-"));
const viewId = "legacy-drag-e2e";
const prevPath = process.env.PATH;

// Hermetic xclip stub: log every write (args + stdin) so the PRIMARY mirror is
// observable and the host clipboard is never touched.
const binDir = join(root, "bin");
mkdirSync(binDir);
const xclipLog = join(root, "xclip.log");
writeFileSync(xclipLog, "");
writeFileSync(
	join(binDir, "xclip"),
	["#!/bin/sh", 'text="$(cat)"', `echo "write $* text=$text" >> "${xclipLog}"`].join("\n"),
);
chmodSync(join(binDir, "xclip"), 0o755);
process.env.PATH = `${binDir}:${process.env.PATH}`;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await sleep(25);
	}
	return false;
}

const meta = createView(root, { id: viewId, name: "legacy drag e2e", cwd: root });
const configPath = P.hostConfigPath(root, viewId);
atomicWriteJson(configPath, {
	root,
	viewId,
	sessionFile: meta.sessionFile,
	cwd: process.cwd(),
	initialPrompt: null,
	piCommand: process.execPath,
	piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
	model: null,
	tools: null,
	env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1" },
	cols: 80,
	rows: 22,
});

const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], {
	stdio: ["ignore", "pipe", "pipe"],
});
runner.stderr.resume();

const result = {
	error: null as string | null,
	sawContent: false,
	motionlessOsc52: null as string | null,
	motionlessPrimary: null as string | null,
	motionlessSelectionSurvives: false,
	motionlessForwardedInput: false,
	movefulOsc52: null as string | null,
	clickPressedSelection: false,
	clickOsc52: null as string | null,
	clickSelectionCleared: false,
	doubleOsc52: null as string | null,
	doubleSelectionIsWord: false,
};

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
	}, 15_000);
	if (!ready) throw new Error("host never became ready");

	// Intercept component→runner messages: mouse events must never arrive as input.
	const sent: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") sent.push(data);
		return origWrite.call(this, data, ...rest);
	};
	const forwardedInputs = () =>
		sent
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter((m) => !!m && m.type === "input" && typeof m.data === "string");

	const writes: string[] = [];
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (s: string) => void writes.push(s) },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const component: any = new PtyAttachComponent(
		tui as never,
		theme as never,
		{} as never,
		() => {},
		{
			socketPath: readHost(root, viewId).socketPath,
			screenLogPath: P.screenLogPath(root, viewId),
			title: "legacy drag e2e",
		} as never,
	);

	// Wait for session content so the gesture lands on a settled attach (an empty
	// buffer would make the copy a silent no-op and the case vacuous).
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && !result.sawContent) {
		const lines = component.render(80) ?? [];
		if (lines.join("\n").includes("fake pi ready")) result.sawContent = true;
		else await sleep(40);
	}
	if (!result.sawContent) throw new Error("session content never rendered");

	const osc52Since = (from: number) =>
		writes
			.slice(from)
			.filter((s) => s.includes("\x1b]52;"))
			.map((s) => {
				const m = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(s);
				return m ? Buffer.from(m[1], "base64").toString("utf8") : `<unparsed:${JSON.stringify(s)}>`;
			});
	const mirroredWrites = () =>
		readFileSync(xclipLog, "utf8")
			.split("\n")
			.filter((l) => l.startsWith("write ") && l.includes("-selection primary"));
	const lastMirrored = () => {
		const lines = mirroredWrites();
		return lines.length ? (lines.at(-1) as string).replace(/^write .*?text=/, "") : null;
	};
	// A previous case's pending-click timer must never fire inside the next case.
	const resetGestureState = () => {
		component.clearPendingClick();
		component.selection = null;
		component.selectionDragging = false;
	};

	// Case 1 (A2): the reported bug — press + release, zero motion events, 15 columns.
	resetGestureState();
	const from1 = writes.length;
	const mirroredBefore1 = mirroredWrites().length;
	component.handleInput("\x1b[<0;1;2M");
	await sleep(20);
	component.handleInput("\x1b[<0;16;2m");
	await sleep(400);
	result.motionlessOsc52 = osc52Since(from1).at(-1) ?? null;
	result.motionlessSelectionSurvives = !!component.selection;
	result.motionlessForwardedInput = forwardedInputs().length > 0;
	await waitFor(() => mirroredWrites().length > mirroredBefore1, 2000);
	result.motionlessPrimary = lastMirrored();

	// Case 2 (A3): the canonical gesture (a motion event in the middle) must agree.
	resetGestureState();
	const from2 = writes.length;
	component.handleInput("\x1b[<0;1;2M");
	component.handleInput("\x1b[<32;8;2M");
	component.handleInput("\x1b[<0;16;2m");
	await sleep(400);
	result.movefulOsc52 = osc52Since(from2).at(-1) ?? null;

	// Case 3 (A4): a same-cell press+release stays a click.
	resetGestureState();
	const from3 = writes.length;
	component.handleInput("\x1b[<0;1;2M");
	await sleep(20);
	result.clickPressedSelection = !!component.selection;
	component.handleInput("\x1b[<0;1;2m");
	await sleep(400);
	result.clickOsc52 = osc52Since(from3).at(-1) ?? null;
	result.clickSelectionCleared = !component.selection;

	// Case 4 (A6): two rapid same-cell clicks still select and copy the word.
	resetGestureState();
	const from4 = writes.length;
	component.handleInput("\x1b[<0;1;2M");
	component.handleInput("\x1b[<0;1;2m");
	await sleep(60);
	component.handleInput("\x1b[<0;1;2M");
	component.handleInput("\x1b[<0;1;2m");
	await sleep(400);
	result.doubleOsc52 = osc52Since(from4).at(-1) ?? null;
	result.doubleSelectionIsWord =
		!!component.selection &&
		component.selection.anchor.line === 0 &&
		component.selection.anchor.col === 0 &&
		component.selection.focus.col === 3;

	try {
		component.dispose();
	} catch {}
} catch (err) {
	result.error = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
}

try {
	const host = readHost(root, viewId);
	if (host?.childPid) process.kill(host.childPid, "SIGKILL");
} catch {}
try {
	runner.kill("SIGKILL");
} catch {}
await sleep(80);
process.env.PATH = prevPath;
try {
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
} catch {}
console.log(JSON.stringify(result));
```

Create `test/pty-attach-legacy-drag.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-legacy-drag-scenario.ts");

// Component-level legacy drag coverage (issue #187): a motion-less press+release
// (Warp fast flick) must copy; the canonical move-ful gesture must copy the same
// text; a same-cell click must stay a click; the double-click path the fix routes
// through must still select and copy the word.
test("attach legacy drag: a motion-less press→release copies; clicks still behave as clicks", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const p = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(p.error, null, `scenario error: ${p.error}`);
	assert.equal(p.sawContent, true, "session content must render before the gesture (no empty-buffer race)");
	// A2
	assert.equal(p.motionlessOsc52, "fake pi ready", "a motion-less drag must copy the selected line via OSC 52");
	assert.equal(p.motionlessPrimary, "fake pi ready", "the copy must also mirror into X11 PRIMARY");
	assert.equal(p.motionlessSelectionSurvives, true, "the selection must survive the 260 ms pending-click timer");
	assert.equal(p.motionlessForwardedInput, false, "mouse events must never be forwarded to the child as input");
	// A3
	assert.equal(p.movefulOsc52, "fake pi ready", "the move-ful drag must copy the same text");
	assert.equal(p.movefulOsc52, p.motionlessOsc52, "both drag shapes must produce the same payload");
	// A4
	assert.equal(p.clickPressedSelection, true, "the press must create a selection (otherwise this case is vacuous)");
	assert.equal(p.clickOsc52, null, "a stationary click must not copy");
	assert.equal(p.clickSelectionCleared, true, "the pending-click timer must clear the selection");
	// A6
	assert.equal(p.doubleOsc52, "fake", "a double click must select and copy the word under the pointer");
	assert.equal(p.doubleSelectionIsWord, true, "the word selection must stay past the pending-click window");
});
```

- [ ] **Step 2: Run the scenario test to verify it fails on the real bug**

Run: `node --test test/pty-attach-legacy-drag.test.mjs`
Expected: FAIL on the first A2 assertion — `motionlessOsc52` is `null` (no copy happens today for a
zero-motion gesture). The scenario itself must not error (`p.error === null`), which proves the harness
and the empty-buffer precondition are sound.

- [ ] **Step 3: Record the screen anchor at press**

In `src/ui/pty-attach.ts`:

```ts
// line 152-154
type MousePoint = { line: number; col: number };
type ScreenCell = { row: number; col: number };
/** Issue #187: `screenAnchor` is the RAW reported cell of the press; the drag/click
 * decision compares it against the release cell, because buffer coordinates drift
 * while the session streams. Absent on word selections (they are created on release). */
type MouseSelection = { anchor: MousePoint; focus: MousePoint; screenAnchor?: ScreenCell };
```

and in the press branch (line 1059):

```ts
			this.selection = { anchor: point, focus: point, screenAnchor: { row: mouse.row, col: mouse.col } };
```

- [ ] **Step 4: Use the decision on release**

In `src/ui/pty-attach.ts` line 1079, replace

```ts
			const shouldCopy = this.selectionDragging;
```

with

```ts
			// Issue #187: a Warp fast flick arrives as press + release with no motion
			// event, so the move flag alone cannot decide. Compare the RAW reported
			// screen cells (never the clamped buffer points, whose base drifts as the
			// session streams).
			const shouldCopy = selectionReleaseIsDrag({
				dragging: this.selectionDragging,
				pressScreen: this.selection.screenAnchor,
				releaseScreen: { row: mouse.row, col: mouse.col },
			});
```

and add `selectionReleaseIsDrag` to the `../core/pty-scroll.mjs` import on line 15 (alphabetical:
after `resolveWheelLines`, before `shouldMirrorSelectionToPrimary`).

- [ ] **Step 5: Run the scenario test to verify it passes**

Run: `node --test test/pty-attach-legacy-drag.test.mjs`
Expected: PASS — all eleven assertions, including the A2 reproduction, the A3 equivalence, the A4
negative control and the A6 double-click case.

- [ ] **Step 6: Commit**

```bash
git add src/ui/pty-attach.ts test-support/pty-attach-legacy-drag-scenario.ts test/pty-attach-legacy-drag.test.mjs
git commit -m "fix(attach): classify the legacy gesture by screen geometry

A drag delivered as press + release with no motion event (Warp fast
flicks) took the click path: no copy, and the selection was wiped by the
260 ms pending-click timer. Decide from the raw reported screen cells
recorded at press instead of the move flag alone, so the gesture lands on
the existing copy branch and #172's highlight-retention contract is
preserved."
```

---

### Task 3: viewport-drift negative control (A5)

**Files:**
- Create: `test-support/pty-attach-legacy-drag-drift-scenario.ts`
- Create: `test/pty-attach-legacy-drag-drift.test.mjs`

**Interfaces:**
- Consumes: the wired component from Task 2.
- Produces: a scenario printing `{ error, sawContent, bufferGrew, pressCreatedSelection, osc52, selectionCleared }`.

- [ ] **Step 1: Write the failing-first scenario**

The drift case only becomes meaningful once the buffer really moves between press and release, so the
scenario asserts that movement itself. Create
`test-support/pty-attach-legacy-drag-drift-scenario.ts` (same harness, `FAKE_PTY_STREAM_MODE: "steady"`,
no xclip stub needed because this case must not copy — but keep the stub to stay hermetic):

```ts
// Component-level drift coverage (issue #187, review finding R1-G1): the REAL
// PtyAttachComponent against a REAL runner whose fake pty child streams a line
// every 25 ms (FAKE_PTY_STREAM_MODE=steady). A stationary click — same screen
// cell for press and release — must stay a click even though the stream moves
// the viewport base between the two events, so the buffer-space line of the
// release differs from the press. xclip is PATH-stubbed so the host clipboard
// is never touched and any copy would still be visible in the log.
// Run via `node --experimental-transform-types`.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-legacy-drag-drift-"));
const viewId = "legacy-drag-drift-e2e";
const prevPath = process.env.PATH;
const binDir = join(root, "bin");
mkdirSync(binDir);
const xclipLog = join(root, "xclip.log");
writeFileSync(xclipLog, "");
writeFileSync(join(binDir, "xclip"), ["#!/bin/sh", 'text="$(cat)"', `echo "write $* text=$text" >> "${xclipLog}"`].join("\n"));
chmodSync(join(binDir, "xclip"), 0o755);
process.env.PATH = `${binDir}:${process.env.PATH}`;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await sleep(25);
	}
	return false;
}

const meta = createView(root, { id: viewId, name: "legacy drag drift e2e", cwd: root });
const configPath = P.hostConfigPath(root, viewId);
atomicWriteJson(configPath, {
	root,
	viewId,
	sessionFile: meta.sessionFile,
	cwd: process.cwd(),
	initialPrompt: null,
	piCommand: process.execPath,
	piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
	model: null,
	tools: null,
	env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_STREAM_MODE: "steady" },
	cols: 80,
	rows: 22,
});

const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], {
	stdio: ["ignore", "pipe", "pipe"],
});
runner.stderr.resume();

const result = {
	error: null as string | null,
	sawContent: false,
	bufferGrew: false,
	bufferGrowth: 0,
	pressCreatedSelection: false,
	osc52: null as string | null,
	selectionCleared: false,
	mirroredWrites: 0,
};

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
	}, 15_000);
	if (!ready) throw new Error("host never became ready");

	const sent: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") sent.push(data);
		return origWrite.call(this, data, ...rest);
	};

	const writes: string[] = [];
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (s: string) => void writes.push(s) },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const component: any = new PtyAttachComponent(
		tui as never,
		theme as never,
		{} as never,
		() => {},
		{
			socketPath: readHost(root, viewId).socketPath,
			screenLogPath: P.screenLogPath(root, viewId),
			title: "legacy drag drift e2e",
		} as never,
	);

	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && !result.sawContent) {
		const lines = component.render(80) ?? [];
		if (lines.join("\n").includes("steady-")) result.sawContent = true;
		else await sleep(40);
	}
	if (!result.sawContent) throw new Error("streaming session content never rendered");

	component.clearPendingClick();
	component.selection = null;
	component.selectionDragging = false;
	const from = writes.length;
	const bufferBefore = component.term.buffer.active.length;

	// Same SCREEN cell for press and release: the stream must be the only reason the
	// two events map to different buffer lines.
	component.handleInput("\x1b[<0;1;2M");
	await sleep(20);
	result.pressCreatedSelection = !!component.selection;
	await sleep(180);
	const bufferAtRelease = component.term.buffer.active.length;
	component.handleInput("\x1b[<0;1;2m");
	await sleep(400);

	result.bufferGrowth = bufferAtRelease - bufferBefore;
	result.bufferGrew = result.bufferGrowth >= 3;
	result.osc52 = writes
		.slice(from)
		.filter((s) => s.includes("\x1b]52;"))
		.at(-1) ?? null;
	result.selectionCleared = !component.selection;
	result.mirroredWrites = readFileSync(xclipLog, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("write ") && l.includes("-selection primary")).length;

	try {
		component.dispose();
	} catch {}
} catch (err) {
	result.error = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
}

try {
	const host = readHost(root, viewId);
	if (host?.childPid) process.kill(host.childPid, "SIGKILL");
} catch {}
try {
	runner.kill("SIGKILL");
} catch {}
await sleep(80);
process.env.PATH = prevPath;
try {
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
} catch {}
console.log(JSON.stringify(result));
```

Create `test/pty-attach-legacy-drag-drift.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-legacy-drag-drift-scenario.ts");

// Drift negative control (issue #187, finding R1-G1): with the session streaming,
// a stationary click maps press and release to different BUFFER lines while the
// screen cell is identical. Classifying on screen cells keeps it a click; a
// buffer-space comparison would copy and never clear. The case asserts the buffer
// really moved, otherwise it proves nothing.
test("attach legacy drag drift: a stationary click stays a click while the viewport drifts", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const p = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(p.error, null, `scenario error: ${p.error}`);
	assert.equal(p.sawContent, true, "streaming content must render before the gesture");
	assert.equal(p.bufferGrew, true, `the buffer must have drifted during the gesture (grew ${p.bufferGrowth} lines)`);
	assert.equal(p.pressCreatedSelection, true, "the press must create a selection (otherwise this case is vacuous)");
	assert.equal(p.osc52, null, "a stationary click must not copy, however far the viewport drifted");
	assert.equal(p.selectionCleared, true, "the pending-click timer must clear the selection");
	assert.equal(p.mirroredWrites, 0, "no PRIMARY write may happen for a click");
});
```

- [ ] **Step 2: Run it to verify the control is sound**

Run: `node --test test/pty-attach-legacy-drag-drift.test.mjs`
Expected: PASS with `bufferGrowth >= 3`. If `bufferGrew` is false the case is not exercising drift —
increase the `await sleep(180)` pause rather than loosening the assertion.

- [ ] **Step 3: Prove the case has discriminating power**

Temporarily (do not commit) restore the buffer-space comparison the review rejected, by feeding the
helper buffer lines as if they were screen rows in `src/ui/pty-attach.ts`:

```ts
			const shouldCopy = selectionReleaseIsDrag({
				dragging: this.selectionDragging,
				pressScreen: { row: this.selection.anchor.line, col: this.selection.anchor.col },
				releaseScreen: point ? { row: point.line, col: point.col } : null,
			});
```

Run: `node --test test/pty-attach-legacy-drag-drift.test.mjs`
Expected: FAIL on the `osc52` assertion — the drifted buffer lines make the stationary click look like a
drag, which is exactly the R1-G1 regression this case exists to catch. Revert the temporary edit
(`git checkout -- src/ui/pty-attach.ts` is wrong here: it would drop Task 2's committed work — re-apply
the Step 4 text by hand), run the test again and confirm it passes, then confirm
`git diff origin/main...HEAD --stat` still shows only the intended files.

- [ ] **Step 4: Commit**

```bash
git add test-support/pty-attach-legacy-drag-drift-scenario.ts test/pty-attach-legacy-drag-drift.test.mjs
git commit -m "test(attach): drift negative control for the legacy drag decision

Pin the review finding that killed the buffer-space comparison: with the
session streaming, a stationary click maps press and release to different
buffer lines, so only a screen-cell decision keeps it a click."
```

---

### Task 4: full verification and the manual runbook (A7, A8, U1, U2, U3)

**Files:**
- No source changes expected. Any failure found here is fixed in the owning task's files, then this
  task's steps are re-run.

**Interfaces:**
- Consumes: everything above.
- Produces: the verification record pasted into the PR / issue, plus the manual steps for the operator.

- [ ] **Step 1: Run the aggregate gate**

Run: `npm run verify`
Expected: PASS end to end — `tsc --noEmit`, perf gate, `node --test test/*.test.mjs` (including the two
new scenario tests), `c8` coverage above lines 85 / funcs 80 / branches 70, `npm pack --dry-run`.

- [ ] **Step 2: Record the acceptance evidence**

Run: `npm run test:coverage 2>&1 | tail -30`
Expected: every suite green; paste the coverage summary and the two new test names into the PR body as
the A1–A6/A8 evidence.

- [ ] **Step 3: Confirm the deliverables and the scope guard**

Run: `git diff --stat origin/main...HEAD` and `git status --short`
Expected: only the seven files from the file-structure table (plus the spec/plan docs) appear; nothing
staged but uncommitted; no stray fixture files. Confirm by reading the diff that the selection range
storage, the press/move branches, autoscroll, middle-click paste, PRIMARY mirroring and wheel handling
are untouched.

- [ ] **Step 4: Hand the manual runbook to the operator (U1/U2/U3)**

These run **after the branch is merged and the extension checkout is updated** — the operator's pi
loads the board from `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board` (registered as
`git:github.com/zhuxixi/pi-agent-board` in `~/.pi/agent/settings.json`; entry `index.ts`, no build
step), so a worktree build is never what a real session loads.

```bash
# 0. prerequisite: that checkout is currently on f81949d with a dirty package-lock.json
git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board status --short
git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board pull
# then restart pi.
```

- **U1 (regression, real terminal)**: `pi --tui-mode regular` → `/agent-board` → attach any session →
  left-drag over some text and release → middle-click paste. Pass: the pasted text equals the selection;
  the highlight still stays until the next click (#172 behaviour).
- **U2 (the exact reported byte stream)**: inside tmux, `pi --tui-mode regular` → `/agent-board` →
  attach, then inject the Warp press/release pair with no motion event:
  ```bash
  tmux send-keys -H 1b 5b 3c 30 3b 31 3b 32 4d   # press  (col 1, row 2)
  tmux send-keys -H 1b 5b 3c 30 3b 31 36 3b 32 6d # release(col 16, row 2)
  ```
  Pass: the line under the gesture reaches the clipboard (OSC 52 / PRIMARY) and the highlight stays.
  If the real regular-mode TUI does not hand those bytes to the attach overlay, record the observation
  and mark U2 `pending` — A2 stays the evidence for the fix.
- **U3 (drift regression)**: same environment; make the attached session stream
  (`while :; do date; sleep 0.2; done`), then click plain text several times while it scrolls, then
  stop the stream and double-click a word as a control. Pass: clicks never change the clipboard and
  never open a link; the post-stream double-click selects and copies the word. Double-click *during*
  the stream missing is pre-existing behaviour (see the spec's guarantee boundaries) and is not a
  failure of this change.

- [ ] **Step 5: Report**

Post the `npm run verify` result, the coverage summary, the A-item evidence and the U1/U2/U3 outcome
(including any `pending`) into issue #187 before opening the PR. Do not merge until the reviewer's
Zima CR converged (process step 9).

---

## Self-review

1. **Spec coverage** — A1→Task 1; A2/A3/A4/A6→Task 2; A5→Task 3; A7/A8→Task 4 steps 1–3;
   U1/U2/U3→Task 4 step 4. Every design decision in the spec has a task: the pure helpers (Task 1),
   the `screenAnchor` recording and the release decision (Task 2 steps 3–4), the raw-not-clamped rule
   (A1 case + Task 2 step 4 comment), the preserved #172 contract (copy branch untouched, asserted by
   A2's "selection survives"), and the documented double-click boundary (asserted by A6 in the
   no-drift fixture, and by U3's control step).
2. **Placeholder scan** — no TBD/TODO; every code step ships the full text of the file or the exact
   patch; every run step names the command and the expected outcome.
3. **Type consistency** — `sameMousePoint`/`sameScreenCell` take `{line, col}`/`{row, col}`
   respectively; `selectionReleaseIsDrag` receives `{dragging, pressScreen, releaseScreen}` in the
   helper, the unit tests and the component call site; `MouseSelection.screenAnchor` is the only new
   field and it is optional everywhere it is read (`selectWordAtPoint` does not set it).
