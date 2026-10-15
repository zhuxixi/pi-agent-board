# X10 mouse release classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop decoding an X10/normal mouse release (`Cb = 3`) as a press, so a drag in the legacy attach path copies the selection on release instead of clearing it.

**Architecture:** One classification fix inside the pure mouse parser (`parseMouseEventPrefix`, X10 branch) plus the tests that pin it: unit rows on the exported pure functions (`parseMouseEvent`, `parseMouseInputChunk`), and a component-level scenario that drives real X10 bytes through the real `PtyAttachComponent` + runner socket and observes the OSC 52 copy. No handler change, no new export, no new env flag, no state.

**Tech Stack:** Node ESM (`.mjs` runtime, `.ts` UI), `node:test` + `assert/strict`, `@xterm/headless`, the repo's `node --experimental-transform-types` scenario pattern.

**Spec:** `docs/superpowers/specs/2026-10-15-issue-188-x10-mouse-release-design.md` (issue #188).
**Worktree / branch:** `.pi/worktrees/issue-188-x10-release` on branch `issue-188-x10-release` (baseline `main` @ `7cf0853`). Every command below runs from that worktree root.

## Global Constraints

- **One edit site.** The behaviour change lives in `parseMouseEventPrefix` (`src/core/pty-scroll.mjs:53-66`). Do not add a handler-side release rule, a new export, a new env flag, or config.
- **Do not touch the SGR branch or the passive branch** (`sgr[5] === "m"` already marks SGR/passive releases).
- **Do not touch the release branch's `shouldCopy` logic** (`src/ui/pty-attach.ts:1081-1088`): geometry-based drag detection is #187, clearing the highlight after a copy is #172. This issue changes neither.
- **Wheel stays `"press"`**: any release rule must exclude bit 6 (`64`), otherwise `64`/`65` wheel reports change classification. `mouseWheelDirection` must keep returning +1/−1 for X10 wheel up/down.
- **Tabs** for indentation, **English** comments and commit messages, conventional commit subjects with the issue number, e.g. `fix(attach): … (issue #188)`.
- **Unit test file:** extend `test/pty-scroll.test.mjs` (do not create a second parser test file).
- **Component test pair:** `test-support/pty-attach-x10-scenario.ts` + `test/pty-attach-x10.test.mjs`, modelled on `test-support/pty-attach-mouse-scenario.ts` + `test/pty-attach-mouse.test.mjs`.
- **Hermetic tests:** the scenario must stub `xclip` on `PATH` so `writePrimarySelection()` never touches the host X11 clipboard.
- **No `git add -A`**: stage files by path.
- **Definition of done:** `npm run verify` exits 0 (typecheck + perf gate + full `node --test test/*.test.mjs` + coverage thresholds + `pack:dry`).
- **Acceptance IDs** (`A1`–`A6`, `U1` from the spec §5) are referenced per task; the mapping must stay bidirectional.

### Acceptance ↔ task map

| Spec ID | What it pins | Task |
|---|---|---|
| A1 | X10 press / motion / release / modifier-release classification | Task 1 |
| A2 | Wheel, middle, right, motion+button-3, non-mouse, passive rows unchanged | Task 1 |
| A3 | Concatenated X10 reports decode in order (and a 7-byte chunk is rejected) | Task 1 |
| A4 | X10 drag release copies (OSC 52 payload) | Task 2 |
| A5 | Click / right button / wheel branches unchanged at component level | Task 2 |
| A6 | `npm run verify` (static + full suite + coverage + pack) | Task 3 |
| U1 | Optional real-terminal check (no X10-only terminal available → `pending`) | Task 3 (disposition) |

---

### Task 1: Classify the X10 release code in the parser (A1, A2, A3)

**Files:**
- Modify: `src/core/pty-scroll.mjs:53-66` (the X10 branch of `parseMouseEventPrefix`)
- Test: `test/pty-scroll.test.mjs` (append two `test(...)` blocks; existing assertions stay untouched)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseMouseEvent(data)` returns `{ encoding: "x10", button: number, col: number, row: number, action: "press" | "move" | "release" }` for 6-byte X10 reports; `parseMouseInputChunk(data)` returns the per-report array with the same `mouse` shape (unchanged signatures).

- [ ] **Step 1: Write the failing tests**

Append to `test/pty-scroll.test.mjs` (it already imports `mouseWheelDirection`, `parseMouseEvent`, `parseMouseInputChunk`):

```js
// Issue #188: in the X10/normal encoding (ESC [ M Cb Cx Cy, each byte = value
// + 32) the low two bits of Cb are the button, except value 3, which is the
// protocol's release code and carries no button identity; bit 5 is motion and
// bit 6 is wheel. Classifying 3 as a press made the attach surface clear the
// drag selection on release instead of copying it.
test("parseMouseEvent classifies X10 button codes (issue #188)", () => {
	// Cb = 0/1/2: left/middle/right press. col 1, row 2 (body row 0).
	assert.deepEqual(parseMouseEvent("\x1b[M !\""), { encoding: "x10", button: 0, col: 1, row: 2, action: "press" });
	assert.deepEqual(parseMouseEvent("\x1b[M!!\""), { encoding: "x10", button: 1, col: 1, row: 2, action: "press" });
	assert.deepEqual(parseMouseEvent("\x1b[M\"!\""), { encoding: "x10", button: 2, col: 1, row: 2, action: "press" });
	// Cb = 32: motion (col 8); Cb = 32|3: motion without a button held.
	assert.deepEqual(parseMouseEvent("\x1b[M@(\""), { encoding: "x10", button: 32, col: 8, row: 2, action: "move" });
	assert.deepEqual(parseMouseEvent("\x1b[MC!\""), { encoding: "x10", button: 35, col: 1, row: 2, action: "move" });
	// Cb = 3: release; 3|4 shift, 3|16 ctrl must stay releases.
	assert.deepEqual(parseMouseEvent("\x1b[M#!\""), { encoding: "x10", button: 3, col: 1, row: 2, action: "release" });
	assert.deepEqual(parseMouseEvent("\x1b[M#4\""), { encoding: "x10", button: 3, col: 20, row: 2, action: "release" });
	assert.deepEqual(parseMouseEvent("\x1b[M'!\""), { encoding: "x10", button: 7, col: 1, row: 2, action: "release" });
	assert.deepEqual(parseMouseEvent("\x1b[M3!\""), { encoding: "x10", button: 19, col: 1, row: 2, action: "release" });
	// Cb = 64/65: wheel, and the release rule must not capture it.
	assert.deepEqual(parseMouseEvent("\x1b[M`!\""), { encoding: "x10", button: 64, col: 1, row: 2, action: "press" });
	assert.deepEqual(parseMouseEvent("\x1b[Ma!\""), { encoding: "x10", button: 65, col: 1, row: 2, action: "press" });
	assert.equal(mouseWheelDirection("\x1b[M`!\""), 1);
	assert.equal(mouseWheelDirection("\x1b[Ma!\""), -1);
});

test("parseMouseInputChunk decodes a concatenated X10 gesture in order (issue #188)", () => {
	assert.deepEqual(parseMouseInputChunk("\x1b[M !\"\x1b[M@(\"\x1b[M#4\""), [
		{ length: 6, raw: "\x1b[M !\"", mouse: { encoding: "x10", button: 0, col: 1, row: 2, action: "press" } },
		{ length: 6, raw: "\x1b[M@(\"", mouse: { encoding: "x10", button: 32, col: 8, row: 2, action: "move" } },
		{ length: 6, raw: "\x1b[M#4\"", mouse: { encoding: "x10", button: 3, col: 20, row: 2, action: "release" } },
	]);
	// Seven bytes is not an X10 report: the all-or-nothing chunk parser rejects it
	// (#189), which is why every literal above is exactly six bytes.
	assert.equal(parseMouseInputChunk("\x1b[M !\"\x1b[M#20\""), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/pty-scroll.test.mjs`
Expected: FAIL in both new tests on the release rows, e.g. `action: 'press'` where `'release'` was expected (3 rows in the first test, 1 in the second). The wheel/middle/right/motion rows already pass.

- [ ] **Step 3: Write the minimal implementation**

Replace the X10 branch in `src/core/pty-scroll.mjs` (currently `:52-66`) with:

```js
	// X10/normal mouse: ESC [ M Cb Cx Cy. Cb is encoded as button + 32.
	if (input.startsWith("\x1b[M") && input.length >= 6) {
		// Cb packs the button (bits 0-1), modifiers (2-4), motion (5) and wheel (6),
		// except bit value 3 in bits 0-1: the protocol's release code, which carries
		// no button identity. Decoding it as a press made the attach surface clear
		// the drag selection on release instead of copying it (issue #188). Wheel
		// reports never carry a release, so bit 6 keeps the press classification.
		const button = input.charCodeAt(3) - 32;
		const motion = (button & 32) !== 0;
		const wheel = (button & 64) !== 0;
		const release = !motion && !wheel && (button & 3) === 3;
		return {
			length: 6,
			raw: input.slice(0, 6),
			mouse: {
				encoding: "x10",
				button,
				col: input.charCodeAt(4) - 32,
				row: input.charCodeAt(5) - 32,
				action: release ? "release" : motion ? "move" : "press",
			},
		};
	}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/pty-scroll.test.mjs`
Expected: PASS — every test in the file, including the pre-existing X10 rows (`\x1b[M !!"` → press, `mouseWheelDirection` wheel rows).

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-scroll.mjs test/pty-scroll.test.mjs
git commit -m "fix(attach): decode the X10 mouse release code as release (issue #188)"
```

---

### Task 2: Component-level proof that an X10 drag release copies (A4, A5)

**Files:**
- Create: `test-support/pty-attach-x10-scenario.ts`
- Create: `test/pty-attach-x10.test.mjs`

**Interfaces:**
- Consumes: Task 1's classification (the scenario fails without it — Step 3 proves that).
- Produces: a scenario that prints one JSON line on stdout:
  `{ ok, sawContent, error, cases: { drag, click, rightButton, wheel } }` where each case is `{ osc52: string[], forwarded: string[], paintedRightAfterRelease: boolean, paintedAfterWindow: boolean }`.

- [ ] **Step 1: Create the scenario**

Create `test-support/pty-attach-x10-scenario.ts`:

```ts
// Component-level X10 mouse-report coverage (issue #188): the REAL
// PtyAttachComponent against a REAL runner socket (runner/pty-runner.mjs) with a
// fake PTY (test-support/fake-pty-pi.mjs, default mode -> one "fake pi ready"
// line) and a fake TUI capturing terminal.write, driven by X10-encoded reports
// through the public handleInput seam. Verifies:
//   1. an X10 drag (press -> motion -> release) copies the selection: exactly one
//      OSC 52 write whose payload is the selected text. This is the issue #188
//      regression — before the fix the release was decoded as a non-primary
//      press, so the selection was cleared and nothing was copied;
//   2. a same-point X10 click copies nothing, keeps its 1-cell highlight right
//      after the release and loses it once the pending-click window elapsed;
//   3. an X10 right press + release copies nothing (the release finds no live
//      selection);
//   4. an X10 wheel report the local viewport cannot scroll is forwarded to the
//      child raw instead of being consumed.
// Hermetic: a PATH-stubbed xclip so writePrimarySelection() never touches the
// host X11 clipboard. Run via `node --experimental-transform-types`.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-attach-x10-"));
const viewId = "x10-e2e";

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

const meta = createView(root, { id: viewId, name: "x10 attach e2e", cwd: root });
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

// X10 reports used below (ESC [ M Cb Cx Cy, each byte = value + 32; body row 0
// is terminal row 2): press/motion/release of a full-line drag, a same-point
// click release, a right-button press, and a wheel notch.
const PRESS = "\x1b[M !\"";
const MOTION = "\x1b[M@(\"";
const RELEASE = "\x1b[M#4\"";
const CLICK_RELEASE = "\x1b[M#!\"";
const RIGHT_PRESS = "\x1b[M\"!\"";
const WHEEL_UP = "\x1b[M`!\"";

const result = {
	ok: false,
	sawContent: false,
	cases: {} as Record<string, Record<string, unknown>>,
	error: null as string | null,
};

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return (
			!!host &&
			host.state === "alive" &&
			!!host.socketPath &&
			!!host.childPid &&
			isAlive(host.runnerPid) &&
			isAlive(host.childPid)
		);
	}, 10_000);
	if (!ready) throw new Error("host never became ready");

	// Intercept component -> runner frames so a forwarded wheel report is observable.
	const frames: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") frames.push(data);
		return origWrite.call(this, data, ...rest);
	};
	const forwardedInputs = () =>
		frames
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter((msg) => !!msg && msg.type === "input" && typeof msg.data === "string")
			.map((msg) => msg.data as string);

	const writes: string[] = [];
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (d: string) => writes.push(String(d)) },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const component = new PtyAttachComponent(
		tui as never,
		theme,
		{} as never,
		() => {},
		{
			socketPath: readHost(root, viewId)!.socketPath,
			screenLogPath: P.screenLogPath(root, viewId),
			title: "x10 attach e2e",
		} as never,
	);

	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && !result.sawContent) {
		const lines = component.render(80) ?? [];
		if (lines.join("\n").includes("fake pi ready")) result.sawContent = true;
		else await sleep(40);
	}
	if (!result.sawContent) throw new Error("session content never rendered");

	const osc52Payloads = () =>
		writes
			.filter((w) => w.includes("\x1b]52;c;"))
			.map((w) => Buffer.from(w.replace(/.*\x1b]52;c;/, "").replace("\x07", ""), "base64").toString("utf8"));

	// Selection paint on the fixture line: selected cells are rendered with inverse
	// video (\x1b[0;7;…), while the bare cursor block on an empty row is a
	// different sequence (\x1b[7m), so this probe only sees a live selection.
	const selectionPainted = () => {
		const line = (component.render(80) ?? []).find((l) => l.includes("fake pi ready")) ?? "";
		return line.includes("\x1b[0;7;");
	};

	const runCase = async (name: string, sequences: string[], settleMs = 400) => {
		writes.length = 0;
		frames.length = 0;
		for (const seq of sequences.slice(0, -1)) {
			component.handleInput(seq);
			await sleep(15);
		}
		component.handleInput(sequences[sequences.length - 1]);
		// Read the immediate state in the same tick as the release: the pending-click
		// window (DOUBLE_CLICK_MS = 260) must not be able to race this probe.
		const paintedRightAfterRelease = selectionPainted();
		await sleep(settleMs);
		result.cases[name] = {
			osc52: osc52Payloads(),
			forwarded: forwardedInputs(),
			paintedRightAfterRelease,
			paintedAfterWindow: selectionPainted(),
		};
	};

	await runCase("drag", [PRESS, MOTION, RELEASE]);
	await runCase("click", [PRESS, CLICK_RELEASE]);
	await runCase("rightButton", [RIGHT_PRESS, CLICK_RELEASE]);
	await runCase("wheel", [WHEEL_UP]);

	result.ok =
		(result.cases.drag.osc52 as string[]).length === 1 &&
		(result.cases.click.osc52 as string[]).length === 0 &&
		(result.cases.rightButton.osc52 as string[]).length === 0 &&
		(result.cases.wheel.osc52 as string[]).length === 0 &&
		(result.cases.wheel.forwarded as string[]).includes(WHEEL_UP);

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

console.log(JSON.stringify(result));
```

- [ ] **Step 2: Create the test driver**

Create `test/pty-attach-x10.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-x10-scenario.ts");

// Component-level coverage (issue #188): the REAL PtyAttachComponent against a
// REAL runner socket with a fake PTY, driven with X10-encoded mouse reports
// through the legacy handleInput path. Pins the copy-on-release effect (#188)
// and the unchanged click / right-button / wheel branches.
test("attach X10 mouse: drag release copies; click, right button and wheel do not (issue #188)", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.sawContent, true, "session content must render before mouse dispatch");

	// A4: the X10 drag copies exactly once, with the selected text as payload.
	assert.deepEqual(parsed.cases.drag.osc52, ["fake pi ready"], "X10 drag release must copy the selection");

	// A5: a same-point click copies nothing and its highlight clears after the window.
	assert.deepEqual(parsed.cases.click.osc52, []);
	assert.equal(parsed.cases.click.paintedRightAfterRelease, true, "the click keeps its 1-cell highlight during the pending-click window");
	assert.equal(parsed.cases.click.paintedAfterWindow, false, "the pending-click window clears the click highlight");

	// A5: right press + release copies nothing.
	assert.deepEqual(parsed.cases.rightButton.osc52, []);

	// A5: an X10 wheel report the local viewport cannot use is forwarded raw.
	assert.deepEqual(parsed.cases.wheel.osc52, []);
	assert.deepEqual(parsed.cases.wheel.forwarded, ["\x1b[M`!\""]);

	assert.equal(parsed.ok, true);
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `node --test test/pty-attach-x10.test.mjs`
Expected: PASS (`ok 1`). If the drag assertion fails, the parser rule from Task 1 is not in place — do not weaken the assertion.

- [ ] **Step 4: Prove the test is a real regression test**

Run (restores the pre-fix parser from Task 1's parent commit, then brings the fix back):

```bash
git checkout HEAD~1 -- src/core/pty-scroll.mjs
node --test test/pty-attach-x10.test.mjs   # expect FAIL: "X10 drag release must copy the selection"
git checkout HEAD -- src/core/pty-scroll.mjs
node --test test/pty-attach-x10.test.mjs   # expect PASS
git diff --exit-code src/core/pty-scroll.mjs
```

Expected: the first run fails with the drag assertion (`[]` instead of `["fake pi ready"]`), the second passes, and the final `git diff --exit-code` prints nothing (the tree is back to the committed rule).

- [ ] **Step 5: Commit**

```bash
git add test-support/pty-attach-x10-scenario.ts test/pty-attach-x10.test.mjs
git commit -m "test(attach): drive real X10 press/motion/release through the component (issue #188)"
```

---

### Task 3: Repo gate and acceptance reconciliation (A6, U1 disposition)

**Files:**
- No source changes expected. If coverage thresholds fail, extend `test/pty-scroll.test.mjs` (Task 1's style) — never weaken or delete assertions.

**Interfaces:**
- Consumes: Task 1's parser rule, Task 2's scenario + driver.
- Produces: a recorded A1–A6 evidence set and the U1 disposition for the issue comment / PR body.

- [ ] **Step 1: Run the repo gate**

Run: `npm run verify`
Expected: exit code 0 — `typecheck`, the perf gate, the full `node --test test/*.test.mjs` suite, coverage thresholds (lines 85 / funcs 80 / branches 70), and `pack:dry`.

- [ ] **Step 2: If coverage or the suite fails**

Read the failing output and fix the cause in the tests, not by loosening thresholds or `assert` calls. A coverage dip on `src/core/pty-scroll.mjs` means an X10 branch is unreached: add the missing case to Task 1's unit block (for example a modifier+wheel combination) and re-run `npm run verify`.

- [ ] **Step 3: Record the acceptance evidence**

Collect, verbatim, for the issue comment and PR body:

```bash
node --test test/pty-scroll.test.mjs 2>&1 | tail -5
node --test test/pty-attach-x10.test.mjs 2>&1 | tail -5
npm run verify 2>&1 | tail -5
git log --oneline 7cf0853..HEAD
```

Map them to the spec matrix: A1–A3 → the `pty-scroll` run; A4–A5 → the `pty-attach-x10` run; A6 → `npm run verify`. Mark **U1 as `pending`** with its reason and recipe pointer (spec §6.3: no X10-only terminal on this machine; the component-level scenario drives the same byte stream through the real socket), and state that it is non-blocking by design.

- [ ] **Step 4: Commit (only if Step 2 changed files)**

```bash
git add test/pty-scroll.test.mjs
git commit -m "test(attach): cover the remaining X10 classification branches (issue #188)"
```

If Steps 1–2 left the tree clean, skip this step — the branch is ready for local code review with two commits (plus the spec commit).

---

## Self-Review

**1. Spec coverage:**
- §3.1 classification contract → Task 1 Step 3 (exact code, `(button & 96) === 0` and `(button & 3) === 3` rule, wheel/motion exclusion).
- §3.2 parser-layer (no handler patch) → Global Constraints "One edit site".
- §3.3 alternatives → not implemented by design; the handler-side alternative stays rejected.
- §5 A1/A2/A3 → Task 1 Step 1 rows (press, middle `\x1b[M!!"`, right `\x1b[M"!"`, motion `\x1b[M@("`, motion+3 `\x1b[MC!"`, release `\x1b[M#!"`/`\x1b[M#4"`, shift `\x1b[M'!"`, ctrl `\x1b[M3!"`, wheel `\x1b[M\`!"`/`\x1b[Ma!"`, `parseMouseEvent("x")` and the passive rows already covered by the pre-existing test block, chunk + 7-byte rejection).
- §5 A4/A5 → Task 2 (drag copies via OSC 52 payload; click highlight window, right button, wheel forward).
- §5 A6 → Task 3 Step 1.
- §5 U1 → Task 3 Step 3 disposition (`pending`, non-blocking, recipe pointer).
- §6.1 not-changed list → A2's middle/right/wheel rows plus Global Constraints on SGR/passive and `shouldCopy`.
- §6.2 #187/#172/#189 boundaries → Global Constraints ("do not touch `shouldCopy`", chunk all-or-nothing pinned in A3) and Task 2's click row (no retention assertion).
- §6.3 guarantee boundary → no code change needed; A2 pins the unchanged rows.
- §7 testability split → Task 1 (pure, no I/O) vs Task 2 (component seam, public `handleInput`, no private-field assertions; the render probe reads the public `render()` output).
- §8 risks → the wheel regression risk is pinned by A2; the #187/#172 rebases are handled by Task 3 Step 1 re-running `npm run verify`.

**2. Placeholder scan:** no TBD/TODO/"handle edge cases" steps; every code step carries the full code, every command carries its expected result.

**3. Type consistency:** `parseMouseEvent`/`parseMouseInputChunk` shapes are used identically in Task 1 and Task 2 (`{ encoding, button, col, row, action }`); the scenario's JSON keys (`osc52`, `forwarded`, `paintedRightAfterRelease`, `paintedAfterWindow`, `cases.drag|click|rightButton|wheel`, `ok`, `sawContent`, `error`) match between the scenario and the driver assertion by assertion.

---

## Errata (post-implementation, 2026-10-15)

Two deviations from the task text above happened during execution; the committed code is authoritative.

1. **Task 2's `selectionPainted()` had to strip SGR sequences before locating the fixture line.** The plan's contiguous `includes("fake pi ready")` cannot match a 1-cell selection at column 0, because the attribute reset splits the text (`\x1b[0;7;39;49mf\x1b[0;39;49make pi ready`), so the probe would have returned `false` for a correctly painted click. The committed probe matches the fixture text on an SGR-stripped copy and still runs the `\x1b[0;7;` paint test on the raw line (`test-support/pty-attach-x10-scenario.ts`). Approved by the controller mid-task; recorded in `task-2-report.md`.
2. **One unit row was added after the final whole-branch review.** The review found the `!wheel` guard was not load-bearing in any test (wheel `Cb` 64/65 have low bits 0/1); a row for `Cb = 67` (`64|3`, horizontal wheel) → `"press"` now pins it in Task 1's block (`test/pty-scroll.test.mjs`), commit `ae581b7`.

Commit sequence as executed: `5af72cb` (spec), `79cd179` (plan), `e16179f` (parser fix + A1–A3), `be3dade` (A4–A5 component scenario), `ae581b7` (review hardening). Everything else ran as written; A6 (`npm run verify`) is green at `ae581b7` (1175 tests, 1172 pass, 0 fail; coverage 91.97 / 81.47 / 89.23).
