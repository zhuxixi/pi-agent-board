# Issue #189 — mixed-input segment dispatch: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the legacy (regular-TUI) attach path, dispatch one input read segment by segment — mouse
runs to the existing mouse path, terminal-report runs to a pass-through that touches neither the
selection nor the viewport, everything else to today's keyboard chain.

**Architecture:** A new pure `splitAttachInput(data)` in `src/core/pty-scroll.mjs` (built on the
existing `parseMouseEventPrefix` plus a small, explicitly grounded report table) returns an ordered
array of `mouse | report | key` segments; `PtyAttachComponent.handleInput` becomes a dispatch loop
and the existing keyboard chain moves verbatim into a private `handleKeyInput`. All new behaviour is
covered by pure unit cases plus one component-level scenario (real runner socket + fake PTY + fake
TUI) that drives the public `handleInput` seam.

**Tech Stack:** Node.js ESM (`.mjs` pure layer), TypeScript (`src/ui/pty-attach.ts`, compiled with
`tsc --noEmit`), `node:test` + `assert/strict`, scenario harnesses run with
`node --experimental-transform-types`.

**Spec:** `docs/superpowers/specs/2026-10-14-issue-189-mixed-input-segments-design.md` (issue #189,
cross-reviewed twice, converged; sha256 `042e4efc508bab3b497083076c8359d70f259ae79fe4dd2b6758033d19084e15`).

## Global Constraints

- **Worktree only:** every change lands in
  `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-189-mixed-input-segments` (branch
  `issue-189-mixed-input-segments`). Never touch the main checkout; stage files by name (no
  `git add -A`).
- **Indentation:** tabs. **Comments and commit messages:** English. Conventional commit subjects
  (`feat`/`fix`/`docs`/`test`/`chore`/`refactor`) with the issue reference `(issue #189)`.
- **`parseMouseInputChunk` keeps its literal contract** (all-or-nothing, `null` on any non-mouse
  byte): existing assertions in `test/pty-scroll.test.mjs:83-99` and sibling issue #188's planned
  cases depend on it. It is re-expressed on a new private `parseMouseRun` but must not change.
- **Do not touch** `parseMouseEventPrefix`, its SGR/X10 branches, `parseMouseEvent`,
  `mouseWheelDirection`, `handleLocalMouseEvent`, `handleMouseInputChunk`, `handleMouse`, or any
  selection/copy/viewport logic. Sibling issues #187/#188 own edits there.
- **Testability split (hard constraint from spec §7):** all classification lives in the pure module;
  the component only switches on the segment kind; modules and helpers touched by the change use
  English JSDoc, and no test-only export may be added.
- **No new env knob, dependency, or I/O surface.** No README/CHANGELOG editing (the release tooling
  owns the changelog).
- **Definition of done:** `npm run verify` exits 0 (typecheck + perf gate + tests + coverage
  thresholds lines 85 / funcs 80 / branches 70 + `pack:dry`).
- **Node ≥ 24** is required by the toolchain; the `node_modules` symlink in the worktree points at
  the main checkout's install (gitignored — never commit it).

---

### Task 1: Pure segment classifier + report table (`splitAttachInput`)

Spec acceptance: **A1** (segment decision table), **A2** (report positives + deliberate negatives).

**Files:**
- Modify: `src/core/pty-scroll.mjs` (insert after `parseMouseInputChunk`, which ends at line 95)
- Test: `test/pty-scroll.test.mjs` (add `splitAttachInput` to the import block at lines 3-16, append
  two tests at the end of the file)

**Interfaces:**
- Consumes: existing private `parseMouseEventPrefix(data, offset)` (`src/core/pty-scroll.mjs:31`).
- Produces (Task 2 relies on these exact names/shapes):
  - `splitAttachInput(data: string)` → `Array<{kind:"mouse", events: Array<{length:number, raw:string, mouse:{encoding:string, button:number, col:number, row:number, action:string}}>} | {kind:"report", data:string} | {kind:"key", data:string}>`; returns `[]` for falsy input; consecutive same-kind segments are merged; unrecognised/partial escape sequences stay `key`.
  - `parseMouseInputChunk(data)` → unchanged behaviour, now implemented via a private `parseMouseRun(data, offset)`.

- [ ] **Step 1: Write the failing A1 test (segmentation decision table)**

Append to `test/pty-scroll.test.mjs` (and add `splitAttachInput,` to the import list, keeping it
alphabetical between `shouldOwnOuterMouseMode` and `mouseWheelDirection`-independent entries):

```js
test("splitAttachInput decodes ordered mouse / report / key segments (issue #189)", () => {
	const kinds = (input) => splitAttachInput(input).map((segment) => segment.kind);
	const data = (input) => splitAttachInput(input).map((segment) => (segment.kind === "mouse" ? segment.events.map((entry) => entry.raw) : segment.data));

	assert.deepEqual(splitAttachInput(""), []);
	assert.deepEqual(kinds("\x1b[<64;10;20M\x1b[<65;10;20M"), ["mouse"]);
	assert.equal(splitAttachInput("\x1b[<64;10;20M\x1b[<65;10;20M")[0].events.length, 2);

	// the issue's repro, both orders
	assert.deepEqual(kinds("\x1b[<0;16;2m\x1b[I"), ["mouse", "report"]);
	assert.deepEqual(data("\x1b[<0;16;2m\x1b[I"), ["\x1b[<0;16;2m", "\x1b[I"]);
	assert.deepEqual(kinds("\x1b[I\x1b[<0;16;2m"), ["report", "mouse"]);
	assert.deepEqual(kinds("\x1b[I\x1b[O\x1b[<0;16;2m"), ["report", "mouse"]);
	assert.deepEqual(data("\x1b[I\x1b[O\x1b[<0;16;2m"), ["\x1b[I\x1b[O", "\x1b[<0;16;2m"]);

	// mouse/key and report/key adjacency, both orders
	assert.deepEqual(kinds("\x1b[<0;16;2mx"), ["mouse", "key"]);
	assert.deepEqual(kinds("x\x1b[<0;16;2m"), ["key", "mouse"]);
	assert.deepEqual(kinds("\x1b[Ix"), ["report", "key"]);
	assert.deepEqual(kinds("x\x1b[I"), ["key", "report"]);

	assert.deepEqual(kinds("hello"), ["key"]);
	assert.deepEqual(data("hello"), ["hello"]);

	// adjacent key runs merge: a key is only recognised when it is the whole read (spec §5)
	assert.deepEqual(kinds("\x1b[5~\x1b[6~"), ["key"]);
	assert.deepEqual(data("\x1b[5~\x1b[6~"), ["\x1b[5~\x1b[6~"]);

	// truncated sequences are not recognised and stay keyboard text
	assert.deepEqual(kinds("\x1b[<0;16"), ["key"]);
	assert.deepEqual(kinds("\x1b[?997;1"), ["key"]);
	assert.deepEqual(kinds("\x1b[<0;16\x1b[I"), ["key", "report"]);

	// the pre-existing all-or-nothing contract is untouched
	assert.equal(parseMouseInputChunk("\x1b[<64;10;20Mx"), null);
	assert.equal(parseMouseInputChunk("x\x1b[<64;10;20M"), null);
	assert.equal(parseMouseInputChunk(""), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/pty-scroll.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../src/core/pty-scroll.mjs' does not provide an export named 'splitAttachInput'`.

- [ ] **Step 3: Write the failing A2 test (report positives + deliberate negatives)**

Append:

```js
test("splitAttachInput classifies grounded terminal reports and keeps keys as keys (issue #189)", () => {
	const reports = [
		"\x1b[I",
		"\x1b[O",
		"\x1b[?62;4;6;22c",
		"\x1b[>0;95;0c",
		"\x1b[?1u",
		"\x1b[?997;1n",
		"\x1b[?997;2n",
		"\x1b[6;24;80t",
		"\x1b]11;rgb:0d0d/0d0d/0d0d\x07",
		"\x1b]11;rgb:0d0d/0d0d/0d0d\x1b\\",
		"\x1b]10;#ffffff\x07",
		"\x1b]4;3;rgb:0000/0000/0000\x07",
		"\x1b]7501;?\x1b\\",
	];
	for (const sequence of reports) {
		assert.deepEqual(splitAttachInput(sequence), [{ kind: "report", data: sequence }], `report: ${JSON.stringify(sequence)}`);
	}

	// deliberately not reports: a keystroke can look like them (spec §3.1(b))
	const keys = ["a", "\x1b[A", "\x1b[1;2R", "\x1b[97;5u", "\x1b[1;5D", "\x1b[200~paste\x1b[201~", "\x1bP1+r6375;6375\x1b\\"];
	for (const sequence of keys) {
		assert.equal(splitAttachInput(sequence)[0].kind, "key", `key: ${JSON.stringify(sequence)}`);
	}
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `node --test test/pty-scroll.test.mjs`
Expected: FAIL — same missing-export error.

- [ ] **Step 5: Implement the pure helpers**

In `src/core/pty-scroll.mjs`, replace the current `parseMouseInputChunk` block (lines 79-95) with
the code below (the existing doc comment on `parseMouseInputChunk` must keep stating the
all-or-nothing contract):

```js
/**
 * Read a maximal run of concatenated mouse reports starting at `offset`. Returns the decoded events
 * with their exact raw byte sequences plus the consumed length, or null when no complete report
 * starts there.
 */
function parseMouseRun(data, offset = 0) {
	const events = [];
	let position = offset;
	for (;;) {
		const parsed = parseMouseEventPrefix(data, position);
		if (!parsed) break;
		events.push(parsed);
		position += parsed.length;
	}
	return events.length > 0 ? { events, length: position - offset } : null;
}

/**
 * Parse an input chunk that consists entirely of one or more concatenated mouse reports.
 * Returns each decoded event with its exact raw byte sequence, or null if any non-mouse
 * bytes are present in the chunk (all-or-nothing contract, pinned by unit tests and by the
 * X10 acceptance of issue #188 — do not relax it).
 */
export function parseMouseInputChunk(data) {
	if (!data) return null;
	const run = parseMouseRun(data);
	return run && run.length === data.length ? run.events : null;
}

/**
 * Issue #189: terminal *report* sequences, i.e. bytes the real terminal sends in answer to a query
 * instead of in answer to the user. Every query this stack forwards to the real terminal (child
 * OSC 11 probes, the host's colour batch, kitty protocol negotiation) is answered on the same stdin
 * stream the user types on, so a report is routinely coalesced with keys or mouse reports into one
 * read. Reports carry no user intent: they must reach the child unchanged, but they must not be
 * treated as typing (no selection clear, no viewport reset).
 *
 * Grounding of each pattern (pi-tui 1.x, the face this extension runs against):
 *  - focus in/out: DECSET 1004, enabled by pi's fullscreen TUI; reachable in regular mode only
 *    through leaked terminal state.
 *  - `CSI ? ... c`: DA1 reply — the host sends `\x1b[c` as the trailing sentinel of its colour
 *    batch (`pi-tui tui.js:57`).
 *  - `CSI ? ... u`: kitty keyboard flag reply to `\x1b[?u` (`pi-tui terminal.js:210`).
 *  - `CSI ? ... n`: mode/status reports, including the colour-scheme report `\x1b[?997;1n` that Pi
 *    parses (`pi-tui terminal-colors.js:19`).
 *  - `CSI ... t`: XTWINOPS replies — the host asks for the cell size with `\x1b[16t`
 *    (`pi-tui tui.js:603`) and consumes `CSI 6;h;wt`.
 *  - `OSC ... BEL|ST`: colour replies (OSC 10/11/12, OSC 4) and other reply bodies such as the
 *    program-status reply (OSC 7501); bodies are capped at 4096 bytes like the query carry.
 *  - `CSI > ... c` (DA2) has **no** source in this stack — kept as a defensive extra only, because
 *    no keystroke encodes as a `>`-prefixed CSI.
 *
 * Deliberately NOT matched, because a keystroke can look like them: `CSI ... R` (cursor-position
 * report but also modifier-F3), any `u` final without the `?` prefix (kitty key events),
 * `CSI ... $ y` (DECRPM — nothing in this stack queries modes), and DCS replies (no in-repo DCS
 * query). Unrecognised bytes keep today's keyboard semantics.
 */
const REPORT_PREFIXES = [
	/^\x1b\[[IO]/,
	/^\x1b\[\?\d+(?:;\d+)*c/,
	/^\x1b\[>\d+(?:;\d+)*c/,
	/^\x1b\[\?\d+(?:;\d+)*u/,
	/^\x1b\[\?\d+(?:;\d+)*n/,
	/^\x1b\[\d+(?:;\d+)*t/,
	/^\x1b\][^\x07\x1b]{0,4096}(?:\x07|\x1b\\)/,
];

/** Issue #189: the complete report sequence starting at `offset`, or null. */
function parseReportPrefix(data, offset = 0) {
	const input = data.slice(offset);
	for (const pattern of REPORT_PREFIXES) {
		const match = pattern.exec(input);
		if (match) return match[0];
	}
	return null;
}

/** Issue #189: the maximal run of concatenated report sequences at `offset`, or null. */
function parseReportRun(data, offset = 0) {
	let position = offset;
	for (;;) {
		const report = parseReportPrefix(data, position);
		if (!report) break;
		position += report.length;
	}
	return position > offset ? data.slice(offset, position) : null;
}

/** Merge a segment into the previous one when it has the same kind, else append it. */
function pushSegment(segments, segment) {
	const last = segments[segments.length - 1];
	if (last && last.kind === segment.kind) {
		if (last.kind === "mouse") last.events.push(...segment.events);
		else last.data += segment.data;
		return;
	}
	segments.push(segment);
}

/**
 * Issue #189: split one input read into ordered segments so the attach surface can dispatch per
 * kind instead of all-or-nothing. Mouse reports, terminal reports and everything else are returned
 * in arrival order, consecutive segments of the same kind merged.
 *
 * A partial escape sequence (a sequence split across reads) is not recognised and becomes keyboard
 * text — the same bytes the all-or-nothing parser used to forward.
 *
 * @param {string} data
 * @returns {Array<{kind: "mouse", events: Array<{length: number, raw: string, mouse: {encoding: string, button: number, col: number, row: number, action: string}}>} | {kind: "report", data: string} | {kind: "key", data: string}>}
 */
export function splitAttachInput(data) {
	if (!data) return [];
	const segments = [];
	let offset = 0;
	while (offset < data.length) {
		const mouse = parseMouseRun(data, offset);
		if (mouse) {
			pushSegment(segments, { kind: "mouse", events: mouse.events });
			offset += mouse.length;
			continue;
		}
		const report = parseReportRun(data, offset);
		if (report) {
			pushSegment(segments, { kind: "report", data: report });
			offset += report.length;
			continue;
		}
		// Neither a mouse report nor a terminal report: keyboard text up to the next escape.
		const next = data.indexOf("\x1b", offset + 1);
		const end = next === -1 ? data.length : next;
		pushSegment(segments, { kind: "key", data: data.slice(offset, end) });
		offset = end;
	}
	return segments;
}
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/pty-scroll.test.mjs`
Expected: PASS — the two new tests plus every pre-existing case (including the three
`parseMouseInputChunk` assertions) are green.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (the `.mjs` inference must keep `splitAttachInput`'s union narrowable).

- [ ] **Step 8: Commit**

```bash
git add src/core/pty-scroll.mjs test/pty-scroll.test.mjs
git commit -m "feat(attach): split legacy input reads into mouse/report/key segments (issue #189)"
```

---

### Task 2: Component dispatch + component-level scenario

Spec acceptance: **A3** (both orders of the issue's repro), **A4** (report-only reads), **A5**
(viewport/wheel on a scrollable buffer), **A6** (keyboard semantics + classifier boundary), **A9**
(mid-read detach guard).

**Files:**
- Modify: `src/ui/pty-attach.ts` (import line 15; `handleInput` at lines 297-376)
- Create: `test-support/pty-attach-mixed-input-scenario.ts`
- Create: `test/pty-attach-mixed-input.test.mjs`

**Interfaces:**
- Consumes: `splitAttachInput(data)` from Task 1 with the exact return shape documented there.
- Produces: `PtyAttachComponent.handleInput(data)` (public, unchanged signature) and a private
  `handleKeyInput(data: string): void` holding the former keyboard chain.

- [ ] **Step 1: Write the failing component test**

Create `test/pty-attach-mixed-input.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-mixed-input-scenario.ts");

// Component-level coverage (issue #189): the REAL PtyAttachComponent against a REAL runner socket
// and a fake PTY. Asserts that a read mixing mouse reports with terminal reports is dispatched per
// segment: the gesture still copies (OSC 52) and keeps its selection, no raw mouse bytes reach the
// child, a spontaneous report clears neither selection nor viewport, and the mid-read detach guard
// stops the rest of the read.
test("attach mixed input: per-segment dispatch keeps copy/selection/viewport; reports pass through", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 120_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	for (const [name, passed] of Object.entries(parsed.checks)) {
		assert.equal(passed, true, `check failed: ${name}`);
	}
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/pty-attach-mixed-input.test.mjs`
Expected: FAIL — the scenario file does not exist yet (`Cannot find module ... pty-attach-mixed-input-scenario.ts`).

- [ ] **Step 3: Write the scenario harness**

Create `test-support/pty-attach-mixed-input-scenario.ts`:

```ts
// Component-level coverage (issue #189): one input read that mixes mouse reports with terminal
// reports must be dispatched per segment — the gesture is still processed (OSC 52 copy + selection
// kept), no raw mouse bytes reach the child, and a spontaneous report clears neither the selection
// nor the viewport. Modelled on test-support/pty-attach-mouse-scenario.ts (real runner socket, fake
// PTY from test-support/fake-pty-pi.mjs, fake TUI capturing terminal.write).
// Run via `node --experimental-transform-types`; prints one JSON line: { error, checks }.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-attach-mixed-"));
const viewId = "mixed-e2e";
const SELECTED_TEXT = "fake pi ready";
const OSC52_COPY = `\x1b]52;c;${Buffer.from(SELECTED_TEXT, "utf8").toString("base64")}\x07`;
const OSC11_REPLY = "\x1b]11;rgb:0d0d/0d0d/0d0d\x07";

// Hermetic xclip stub: the scenario must never touch the host clipboard.
const binDir = join(root, "bin");
mkdirSync(binDir);
writeFileSync(join(binDir, "xclip"), "#!/bin/sh\nexit 0\n");
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

const meta = createView(root, { id: viewId, name: "mixed attach e2e", cwd: root });
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

const checks: Record<string, boolean> = {};
const result = { error: null as string | null, checks };

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
	}, 10_000);
	if (!ready) throw new Error("host never became ready");

	// Observe component→runner frames so forwarded input is visible.
	const sent: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") sent.push(data);
		return origWrite.call(this, data, ...rest);
	};
	const forwardedInput = (): string[] =>
		sent
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter((msg) => !!msg && msg.type === "input" && typeof msg.data === "string")
			.map((msg) => msg.data as string);

	// Observe terminal writes so OSC 52 copies are visible.
	const writes: string[] = [];
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (data: string) => writes.push(data) },
		requestRender: () => {},
	};
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const component: any = new PtyAttachComponent(
		tui as never,
		theme,
		{} as never,
		() => {},
		{
			socketPath: readHost(root, viewId).socketPath,
			screenLogPath: P.screenLogPath(root, viewId),
			title: "mixed attach e2e",
		} as never,
	);

	const rendered = () => (component.render(80) ?? []).join("\n");
	const firstBurstLine = (): number | null => {
		const match = /burstline-(\d{4})/.exec(rendered());
		return match ? Number(match[1]) : null;
	};
	const copies = () => writes.filter((write) => write === OSC52_COPY).length;
	const selectionPresent = () => component.selection !== null;
	const drag = (fromCol: number, toCol: number) => {
		component.handleInput(`\x1b[<0;${fromCol};2M`);
		component.handleInput(`\x1b[<32;${toCol};2M`);
	};

	checks.sawContent = await waitFor(() => rendered().includes(SELECTED_TEXT), 8000);
	if (!checks.sawContent) throw new Error("session content never rendered");

	// A3 control: a canonical drag in separate reads still copies.
	const controlCopies = copies();
	drag(1, 16);
	component.handleInput("\x1b[<0;16;2m");
	await waitFor(() => copies() > controlCopies, 3000);
	checks.controlCopies = copies() === controlCopies + 1;

	// A3 case 1 (the issue's repro): release + focus report coalesced into ONE read.
	const mixedCopies = copies();
	const mixedFrames = forwardedInput().length;
	drag(1, 16);
	component.handleInput("\x1b[<0;16;2m\x1b[I");
	await waitFor(() => copies() > mixedCopies, 3000);
	checks.mixedCopies = copies() === mixedCopies + 1;
	checks.mixedForwardedOnlyReport = forwardedInput().slice(mixedFrames).every((frame) => frame === "\x1b[I");
	// The pending-click window (DOUBLE_CLICK_MS = 260) is what used to wipe the selection: nothing to
	// await here, so this wait is the assertion's own window.
	await sleep(400);
	checks.selectionSurvivesMixed = selectionPresent();

	// A3 case 2: report FIRST, release after, still ONE read.
	const reportFirstCopies = copies();
	const reportFirstFrames = forwardedInput().length;
	drag(1, 16);
	component.handleInput("\x1b[I\x1b[<0;16;2m");
	await waitFor(() => copies() > reportFirstCopies, 3000);
	checks.reportFirstCopies = copies() === reportFirstCopies + 1;
	checks.reportFirstForwardedOnlyReport = forwardedInput().slice(reportFirstFrames).every((frame) => frame === "\x1b[I");

	// A4: a report alone mid-drag keeps the selection and copies nothing.
	const reportOnlyCopies = copies();
	const reportOnlyFrames = forwardedInput().length;
	drag(1, 16);
	component.handleInput("\x1b[I");
	await sleep(150);
	checks.reportOnlyKeepsSelection = selectionPresent();
	checks.reportOnlyNoCopy = copies() === reportOnlyCopies;
	checks.reportOnlyForwarded = forwardedInput().slice(reportOnlyFrames).every((frame) => frame === "\x1b[I");

	// A4 variant: an OSC 11 reply (an answer to a forwarded child query) behaves the same.
	const oscCopies = copies();
	const oscFrames = forwardedInput().length;
	drag(1, 16);
	component.handleInput(OSC11_REPLY);
	await sleep(150);
	checks.oscReplyKeepsSelection = selectionPresent();
	checks.oscReplyNoCopy = copies() === oscCopies;
	checks.oscReplyForwarded = forwardedInput().slice(oscFrames).every((frame) => frame === OSC11_REPLY);

	// A5: viewport semantics on a scrollable buffer. "burst" makes the fixture emit 200 numbered lines.
	component.handleInput("burst");
	await waitFor(() => firstBurstLine() === 200, 10_000);
	const settle = async (): Promise<number | null> => {
		let last = firstBurstLine();
		for (;;) {
			await sleep(60);
			const now = firstBurstLine();
			if (now === last) return now;
			last = now;
		}
	};
	const atBottom = await settle();
	for (let i = 0; i < 3; i++) component.handleInput("\x1b[<64;10;3M");
	const scrolled = (await waitFor(() => firstBurstLine() !== null && firstBurstLine()! < (atBottom ?? 0), 3000)) ? firstBurstLine() : null;
	component.handleInput("\x1b[I");
	// Nothing to await: the assertion is that a spontaneous report moves nothing.
	await sleep(150);
	checks.viewportKeptOnReport = scrolled !== null && firstBurstLine() === scrolled;

	const wheelFrames = forwardedInput().length;
	const beforeWheel = firstBurstLine();
	component.handleInput("\x1b[<64;10;3M\x1b[I");
	checks.wheelScrolledInMixedRead = await waitFor(() => firstBurstLine() !== null && firstBurstLine()! < (beforeWheel ?? 0), 3000);
	checks.wheelMixedForwardedOnlyReport = forwardedInput().slice(wheelFrames).every((frame) => frame === "\x1b[I");

	// A6: a real key still clears the selection (typing semantics unchanged) …
	const keyCopies = copies();
	drag(1, 16);
	component.handleInput("x");
	await sleep(80);
	checks.keyStillClears = !selectionPresent() && copies() === keyCopies;

	// … and ambiguous escape shapes stay keys (the classifier boundary).
	drag(1, 16);
	component.handleInput("\x1b[1;2R");
	await sleep(80);
	const clearedByShiftF3 = !selectionPresent();
	drag(1, 16);
	component.handleInput("\x1b[97;5u");
	await sleep(80);
	checks.ambiguousEscapesStayKeys = clearedByShiftF3 && !selectionPresent() && copies() === keyCopies;

	// A9 (last: it closes the component): a detach chord matched in a mixed read must stop the rest
	// of that read. The trailing segment is a KEY, not a report: once detach() closes the socket a
	// trailing report's send() is a silent no-op, so only a key can prove the loop stopped (it would
	// otherwise clearSelection() and wipe the highlight). The read is three segments — detach chord /
	// focus report / trailing key — because adjacent key runs merge: a bare `"\x1b[1;5D" + "x"` is
	// ONE key segment `"\x1b[1;5Dx"` and the chord would never match.
	drag(1, 16);
	component.handleInput("\x1b[1;5D" + "\x1b[I" + "x");
	await sleep(150);
	checks.detachStopsRead = component.closed === true;
	checks.detachTrailingSegmentStopped = selectionPresent();

	try {
		component.dispose();
	} catch {}
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
}

try {
	const pid = readHost(root, viewId)?.childPid;
	if (pid) process.kill(pid, "SIGKILL");
} catch {}
try {
	runner.kill("SIGKILL");
} catch {}
await sleep(50);
try {
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
} catch {}
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(0);
```

- [ ] **Step 4: Run the scenario to confirm it fails on the current code**

Run: `node --test test/pty-attach-mixed-input.test.mjs`
Expected: FAIL with the failing checks (`mixedCopies`, `reportFirstCopies`, `selectionSurvivesMixed`,
`reportOnlyKeepsSelection`, `oscReplyKeepsSelection`, `viewportKeptOnReport`,
`wheelScrolledInMixedRead`) — that is the reproduced defect on `f81949d`.

- [ ] **Step 5: Implement the dispatch loop**

In `src/ui/pty-attach.ts`:

(a) Line 15 — swap the import (`splitAttachInput` replaces `parseMouseInputChunk`):

```ts
import { clampInt, resolveAttachMouseAction, resolvePasteSelectionSource, resolveWheelLines, scrollViewportTop, selectionDragScrollLines, shouldMirrorSelectionToPrimary, shouldOwnOuterMouseMode, splitAttachInput, wheelScrollLinesUp } from "../core/pty-scroll.mjs";
```

(b) Replace the first two statements of `handleInput` (lines 297-298) with the dispatch loop, and
open the extracted keyboard handler — the rest of the old body (every `matchesKey` branch, including
the `detach()` early returns and the final default branch) stays **verbatim** inside it:

```ts
	handleInput(data: string): void {
		// Issue #189: dispatch per segment instead of all-or-nothing. A read that mixes mouse
		// reports with other bytes used to fall through to the keyboard branch as a whole: the
		// gesture was dropped, an in-progress selection cleared, the viewport reset, and the raw
		// mouse bytes forwarded into the hosted session as typed input.
		for (const segment of splitAttachInput(data)) {
			if (segment.kind === "mouse") this.handleMouseInputChunk(segment.events);
			else if (segment.kind === "report") this.send({ type: "input", data: segment.data });
			else this.handleKeyInput(segment.data);
			// A detach/close inside a segment must stop the rest of this read.
			if (this.closed) return;
		}
	}

	/** Keyboard branch of `handleInput` (issue #189: one segment of the read at a time). Terminal
	 * *reports* never arrive here — `handleInput` forwards them without touching the selection or
	 * the viewport, because they carry no user intent (focus events, query replies). */
	private handleKeyInput(data: string): void {
		if (matchesKey(data, Key.pageUp)) {
```

The `report` branch is deliberately just `send(...)`: no `clearPendingClick()`, no
`clearSelection()`, no `scrollToBottom()` — that omission is the fix for the second half of the
issue (spec §3.2).

- [ ] **Step 6: Run the component test and the unit tests**

Run: `node --test test/pty-attach-mixed-input.test.mjs test/pty-scroll.test.mjs`
Expected: PASS — every check in the scenario plus both new unit blocks.

- [ ] **Step 7: Run the pre-existing attach suites (regression)**

Run: `node --test test/pty-attach-mouse.test.mjs test/pty-attach-wheel.test.mjs test/pty-attach-selection-mirror.test.mjs test/pty-attach-mouse-mode.test.mjs`
Expected: PASS (these cover #167 middle-click dispatch, the wheel, #174 PRIMARY mirroring and #173
mouse-mode ownership through the same seams).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/ui/pty-attach.ts test-support/pty-attach-mixed-input-scenario.ts test/pty-attach-mixed-input.test.mjs
git commit -m "fix(attach): dispatch mixed input reads per segment and pass terminal reports through (issue #189)"
```

---

### Task 3: Full verification and traceability sweep

Spec acceptance: **A7** (typecheck/build/pack), **A8** (no regression across the repo).

**Files:** none (verification only).

- [ ] **Step 1: Run the full repo verification**

Run: `npm run verify`
Expected: exit 0 — typecheck, perf gate, `node --test test/*.test.mjs`, coverage thresholds
(lines 85 / funcs 80 / branches 70), `pack:dry`.

- [ ] **Step 2: Confirm the coverage numbers**

Run: `npm run test:coverage 2>&1 | tail -20`
Expected: thresholds met; `src/core/pty-scroll.mjs` and `src/ui/pty-attach.ts` do not drop below the
configured floors (if they do, extend the unit cases — never lower the thresholds).

- [ ] **Step 3: Byte-level spec/plan traceability sweep**

Run:

```bash
grep -n "splitAttachInput\|handleKeyInput" src/core/pty-scroll.mjs src/ui/pty-attach.ts
grep -n "is not recognised and becomes keyboard text\|all-or-nothing contract" src/core/pty-scroll.mjs
```

Expected: `splitAttachInput` exported exactly once and imported once by the component;
`parseMouseInputChunk` still present with its all-or-nothing doc comment; no other call site changed.

- [ ] **Step 4: Re-read the spec's acceptance matrix and record the evidence**

For every row A1–A9 write down the command that produced the evidence and its result in the issue
comment prepared for step 9/10 (spec §6). `U1`/`U2` stay pending until Task 4 runs.

- [ ] **Step 5: Commit (only if Step 1-3 forced changes)**

```bash
git add -p   # stage only the fixes made in this task
git commit -m "test(attach): keep the segment coverage at the configured floors (issue #189)"
```

---

### Task 4: Manual verification on a real terminal (post-merge, operator-run)

Spec acceptance: **U1** (byte injection in regular TUI mode), **U2** (optional daily-use check).

This task runs **after** the PR is merged (the board loads from a git package checkout, so a
pre-merge worktree would not be the loaded code). It is the operator's step; the agent prepares the
commands and records the result — it must be reported as `pending` until actually executed.

- [ ] **Step 1: Deploy the merged code into the loaded package**

```bash
git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board stash   # local package-lock.json change
git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board pull
git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board log --oneline -1
```

Then restart `pi --tui-mode regular` (the legacy path only runs in regular TUI mode).

- [ ] **Step 2: Inject the exact mixed byte stream inside tmux**

```bash
tmux send-keys -H 1b 5b 3c 30 3b 31 3b 32 4d                       # press (col 1, row 2)
tmux send-keys -H 1b 5b 3c 33 32 3b 38 3b 32 4d                    # move  (col 8, row 2)
tmux send-keys -H 1b 5b 3c 30 3b 31 36 3b 32 6d 1b 5b 49           # release + focus-in, ONE frame
xclip -o -selection primary
```

Expected: the highlight from the release survives until the next click (#172 contract), the selected
text (`fake pi ready`) is in the clipboard/PRIMARY, and the hosted session shows no echoed mouse
bytes. If tmux splits the third injection into several reads, record that honestly and mark the row
`pending` — A3 (component level) remains the primary evidence.

- [ ] **Step 3: Record U1/U2 in the issue**

Comment the observed result (pass/fail/pending with the exact commands and outputs). U2 (daily use:
a selection is no longer wiped by a spontaneous report) is optional and non-blocking; report it as
`pending` if not exercised.

---

## Self-review checklist (run before handing the plan to implementers)

- **Spec coverage:** A1/A2 → Task 1; A3–A6/A9 → Task 2; A7/A8 → Task 3; U1/U2 → Task 4. Spec §3.1
  (pure layer) → Task 1 Steps 1-8; §3.2 (component wiring) → Task 2 Steps 5-9; §7 testability split →
  Global Constraints + both test files; §8 boundaries → Global Constraints (no `parseMouseEventPrefix`
  / `handleLocalMouseEvent` edits).
- **Placeholder scan:** every step carries real code or a real command with an expected result.
- **Type consistency:** `splitAttachInput`'s `{kind, events|data}` discriminated union is used
  identically in the JSDoc (Task 1), the dispatch loop (Task 2 Step 5) and the unit tests
  (Task 1 Step 1).
