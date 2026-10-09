# Issue #167 Attach Middle-Click Paste (fullscreen TUI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make middle-click paste (X11 PRIMARY → session input) work in attach views under pi ≥1.0 fullscreen TUI by implementing `handleMouse` on `PtyAttachComponent`, keeping the legacy `handleInput` path and all current behaviors intact.

**Architecture:** pi-tui ≥1.0 fullscreen consumes raw SGR mouse sequences and delivers normalized events to overlays via `Component.handleMouse`. A pure decision function (`resolveAttachMouseAction` in `src/core/pty-scroll.mjs`) maps a normalized event to an action; `PtyAttachComponent.handleMouse` maps that action to the existing `pastePrimarySelection()` side effect and a `{handled:true}` result. devDependencies bump 0.79.8 → 1.1.0 makes the real API surface typecheckable.

**Tech Stack:** TypeScript (tabs), node:test + assert/strict, node --experimental-transform-types for component scenarios, PATH-stubbed `xclip` for hermetic paste tests.

**Spec:** `docs/superpowers/specs/2026-10-09-issue-167-attach-middle-paste-design.md` (acceptance IDs A1–A4, U1 referenced per task).

## Global Constraints

- Work ONLY inside the worktree `<WT>` (branch `issue-167-attach-middle-paste`); never touch main.
- Tabs for indentation; English comments and commit messages; conventional commit subjects (`fix:`/`test:`/`chore:`/`docs:`).
- devDependencies land on EXACTLY `"@earendil-works/pi-coding-agent": "1.1.0"` and `"@earendil-works/pi-tui": "1.1.0"` (no `^`).
- Pure-function split is a hard spec constraint: `resolveAttachMouseAction` must not read `process.env` (call site does) and must not be re-inlined into the component.
- `AGENT_BOARD_ATTACH_NATIVE_PASTE=0` must keep disabling the paste (decision function returns `null` → component returns `undefined`, no side effects).
- `handleMouse` must return `undefined` for EVERYTHING except `type:"press" && button:"middle"` with paste enabled — no capture, no focus, no wheel handling, no selection takeover (spec non-goals).
- No changes to outer-terminal mouse-mode writes (`MOUSE_ENABLE`/`MOUSE_DISABLE`, ctor, `close()`) — that is #169, out of scope.
- Tests use `node:test` with self-contained fixtures under temp dirs; never the host repository.
- `test/` and `test-support/` are EXCLUDED from tsc — scenario files are runtime-transformed only; `src/` must stay `npm run typecheck`-clean.

---

### Task 1: devDependencies bump to pi 1.1.0 (A3 foundation)

**Files:**
- Modify: `package.json` (devDependencies)
- Modify: `package-lock.json` (via npm install)

**Interfaces:**
- Consumes: none.
- Produces: pi-tui 1.1.0 typings available to `src/` (`TuiMouseEvent`, `TuiMouseEventResult` importable from `@earendil-works/pi-tui`); Tasks 2–3 rely on this.

- [ ] **Step 1: Bump the two devDependencies**

In `package.json` `devDependencies`, change exactly:

```json
		"@earendil-works/pi-coding-agent": "0.79.8",
		"@earendil-works/pi-tui": "0.79.8",
```

to:

```json
		"@earendil-works/pi-coding-agent": "1.1.0",
		"@earendil-works/pi-tui": "1.1.0",
```

- [ ] **Step 2: Install**

Run: `npm install` (runs `postinstall: node scripts/patch-vulns.mjs`)
Expected: completes without error; lockfile records 1.1.0 for both packages.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If errors appear, they are 0.79.8→1.1.0 drift in existing `src/` code. Fix them minimally (type-level only — no behavior changes). If more than ~5 files need non-trivial fixes, STOP and report BLOCKED with the full error list (spec's fallback decision point: local structural types without the bump).

- [ ] **Step 4: Existing suite stays green**

Run: `npm test`
Expected: PASS (fake harnesses in test/test-support are excluded from tsc; runtime should be unaffected).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump pi-tui and pi-coding-agent devDeps to 1.1.0 for fullscreen TUI typings"
```

(Include any src/ type-fix files in the same commit if Step 3 required them.)

---

### Task 2: Pure decision function `resolveAttachMouseAction` (A1)

**Files:**
- Modify: `src/core/pty-scroll.mjs` (add export near the other mouse helpers, after `parseMouseInputChunk`)
- Test: `test/pty-scroll.test.mjs` (extend the existing import block and append tests)

**Interfaces:**
- Consumes: none.
- Produces: `resolveAttachMouseAction(event, { nativePasteEnabled }) → "paste-primary" | null`, where `event` is structurally `{ type: string, button: string }` (the pi-tui `TuiMouseEvent`). Task 3's component imports this from `../core/pty-scroll.mjs`.

- [ ] **Step 1: Write the failing tests**

In `test/pty-scroll.test.mjs`, extend the existing import from `../src/core/pty-scroll.mjs` with `resolveAttachMouseAction`, then append:

```js
const ev = (type, button) => ({ type, button });

test("resolveAttachMouseAction: enabled middle press is the only paste trigger", () => {
	assert.equal(resolveAttachMouseAction(ev("press", "middle"), { nativePasteEnabled: true }), "paste-primary");
});

test("resolveAttachMouseAction: native paste kill switch disables the trigger", () => {
	assert.equal(resolveAttachMouseAction(ev("press", "middle"), { nativePasteEnabled: false }), null);
});

test("resolveAttachMouseAction: every other event falls through untouched", () => {
	const cases = [
		["press", "left"],
		["press", "right"],
		["press", "none"],
		["release", "middle"],
		["click", "middle"],
		["move", "middle"],
		["drag", "middle"],
		["wheel", "left"],
		["wheel", "middle"],
	];
	for (const [type, button] of cases) {
		assert.equal(resolveAttachMouseAction(ev(type, button), { nativePasteEnabled: true }), null, `${type}/${button}`);
	}
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/pty-scroll.test.mjs`
Expected: FAIL — `resolveAttachMouseAction` is not exported / not a function.

- [ ] **Step 3: Implement**

In `src/core/pty-scroll.mjs`, after `parseMouseInputChunk`:

```js
/**
 * Issue #167: map a normalized pi-tui mouse event on the attach surface to an
 * action. "paste-primary" = middle-click paste (read X11 PRIMARY, forward as
 * input); null = not ours, the event falls through untouched (pi's fullscreen
 * selection, the wheel defer path, and everything else keep working). Pure by
 * contract: the env flag is resolved at the call site, never read here.
 */
export function resolveAttachMouseAction(event, { nativePasteEnabled }) {
	if (!nativePasteEnabled) return null;
	if (event.type === "press" && event.button === "middle") return "paste-primary";
	return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pty-scroll.test.mjs`
Expected: PASS (new + all pre-existing cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-scroll.mjs test/pty-scroll.test.mjs
git commit -m "feat(attach): pure mouse-action decision helper for middle-click paste"
```

---

### Task 3: `PtyAttachComponent.handleMouse` + component-level scenario (A2)

**Files:**
- Modify: `src/ui/pty-attach.ts` (imports at lines 6 and 13; new `handleMouse` method placed right after the `handleInput` method)
- Create: `test-support/pty-attach-mouse-scenario.ts`
- Test: `test/pty-attach-mouse.test.mjs`

**Interfaces:**
- Consumes: `resolveAttachMouseAction(event, { nativePasteEnabled })` from Task 2; pi-tui 1.1.0 types `TuiMouseEvent`, `TuiMouseEventResult` (Task 1).
- Produces: public `PtyAttachComponent.handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined`.

- [ ] **Step 1: Write the failing integration test + scenario**

Create `test/pty-attach-mouse.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-mouse-scenario.ts");

// Component-level coverage (issue #167): the REAL PtyAttachComponent against a
// REAL runner socket, with a PATH-stubbed xclip printing a fixture string.
// Asserts the fullscreen handleMouse path pastes PRIMARY as input, the legacy
// handleInput SGR path still does (regular-mode regression), and the
// AGENT_BOARD_ATTACH_NATIVE_PASTE=0 kill switch turns both off.
test("attach mouse: middle-press handleMouse pastes PRIMARY; legacy path intact; kill switch honored", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.sawContent, true, "session content must render before mouse dispatch");
	assert.equal(parsed.fullscreenHandled, true, "handleMouse(middle press) must return {handled:true}");
	assert.equal(parsed.fullscreenInput, "primary-paste-fixture", "PRIMARY fixture must reach the attach socket as input");
	assert.equal(parsed.offUndefined, true, "kill switch: handleMouse must return undefined");
	assert.equal(parsed.offNoInput, true, "kill switch: no input may be forwarded");
	assert.equal(parsed.legacyInput, "primary-paste-fixture", "legacy SGR middle press must still paste");
});
```

Create `test-support/pty-attach-mouse-scenario.ts` (modeled on `pty-attach-protocol-scenario.ts`):

```ts
// Component-level mouse-dispatch coverage (issue #167): the REAL
// PtyAttachComponent against a REAL runner socket (fake pty child in
// steady-stream mode) with a fake TUI and a PATH-stubbed xclip that prints a
// fixture string. Verifies:
//   1. fullscreen path: handleMouse(press middle) → {handled:true} and the
//      X11 PRIMARY fixture reaches the attach socket as {type:"input"};
//   2. kill switch: AGENT_BOARD_ATTACH_NATIVE_PASTE=0 → handleMouse returns
//      undefined and forwards nothing;
//   3. legacy path (regular-mode regression): the SGR middle-press sequence
//      via handleInput behaves identically.
// Run via `node --experimental-transform-types`.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-attach-mouse-"));
const viewId = "mouse-e2e";
const FIXTURE = "primary-paste-fixture";

// Hermetic xclip stub: any invocation prints the fixture. Prepending binDir to
// PATH keeps the scenario off the host's real X11 clipboard.
const binDir = join(root, "bin");
mkdirSync(binDir);
writeFileSync(join(binDir, "xclip"), `#!/bin/sh\nprintf '%s' "${FIXTURE}"\n`);
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

const meta = createView(root, { id: viewId, name: "mouse attach e2e", cwd: root });
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
	ok: false,
	sawContent: false,
	fullscreenHandled: false,
	fullscreenInput: null as string | null,
	offUndefined: false,
	offNoInput: false,
	legacyInput: null as string | null,
	error: null as string | null,
};

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
	}, 10_000);
	if (!ready) throw new Error("host never became ready");

	// Intercept component→runner messages to observe {type:"input"} pastes.
	const sent: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") sent.push(data);
		return origWrite.call(this, data, ...rest);
	};
	const pastedInputs = () =>
		sent
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter((m) => !!m && m.type === "input" && typeof m.data === "string")
			.map((m) => m.data as string);

	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const component = new PtyAttachComponent(
		tui as never,
		theme,
		{} as never,
		() => {},
		{
			socketPath: readHost(root, viewId).socketPath,
			screenLogPath: P.screenLogPath(root, viewId),
			title: "mouse attach e2e",
		} as never,
	);

	// Wait for session content so the paste lands on a settled attach.
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && !result.sawContent) {
		const lines = component.render(80) ?? [];
		if (lines.join("\n").includes("steady-")) result.sawContent = true;
		else await sleep(40);
	}
	if (!result.sawContent) throw new Error("session content never rendered");

	// 1. Fullscreen path: normalized middle press via handleMouse.
	const middlePress = {
		type: "press",
		button: "middle",
		x: 3,
		y: 3,
		screenX: 3,
		screenY: 3,
		width: 80,
		height: 22,
		shift: false,
	};
	const before = pastedInputs().length;
	const mouseResult = (component as any).handleMouse(middlePress);
	result.fullscreenHandled = !!mouseResult && mouseResult.handled === true;
	if (await waitFor(() => pastedInputs().length > before, 3000)) {
		result.fullscreenInput = pastedInputs().at(-1) ?? null;
	}

	// 2. Kill switch: handleMouse returns undefined and forwards nothing.
	process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE = "0";
	const offBefore = pastedInputs().length;
	const offResult = (component as any).handleMouse(middlePress);
	result.offUndefined = offResult === undefined;
	await sleep(600);
	result.offNoInput = pastedInputs().length === offBefore;
	delete process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE;

	// 3. Legacy path (regular-mode regression): SGR middle press via handleInput.
	const legacyBefore = pastedInputs().length;
	component.handleInput("\x1b[<1;10;20M");
	if (await waitFor(() => pastedInputs().length > legacyBefore, 3000)) {
		result.legacyInput = pastedInputs().at(-1) ?? null;
	}

	result.ok =
		result.sawContent &&
		result.fullscreenHandled &&
		result.fullscreenInput === FIXTURE &&
		result.offUndefined &&
		result.offNoInput &&
		result.legacyInput === FIXTURE;

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

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `node --test test/pty-attach-mouse.test.mjs`
Expected: FAIL — `parsed.fullscreenHandled` false (and/or `fullscreenInput` null) because `component.handleMouse` does not exist yet. The `legacyInput` assertion may already pass; that is fine, the failure must be on the fullscreen fields.

- [ ] **Step 3: Implement `handleMouse` on the component**

In `src/ui/pty-attach.ts`:

Line 6 — extend the type import:

```ts
import type { Component, KeybindingsManager, RgbColor, TUI, TerminalColorScheme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
```

Line 13 — extend the core import:

```ts
import { clampInt, parseMouseInputChunk, resolveAttachMouseAction, resolveWheelLines, scrollViewportTop, selectionDragScrollLines } from "../core/pty-scroll.mjs";
```

Immediately after the existing `handleInput(data: string): void { ... }` method, add:

```ts
	/** Issue #167: fullscreen TUI (pi ≥1.0) consumes raw SGR mouse sequences in
	 * TuiAltScreen and delivers normalized events to overlays here instead — the
	 * legacy handleInput mouse path never runs in that mode. Only the
	 * middle-click paste is ours; every other event returns undefined so pi's
	 * own fullscreen selection and the wheel defer path keep working. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const action = resolveAttachMouseAction(event, {
			nativePasteEnabled: process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE !== "0",
		});
		if (action !== "paste-primary") return undefined;
		this.clearPendingClick();
		this.clearSelection();
		this.pastePrimarySelection();
		return { handled: true, render: false };
	}
```

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `node --test test/pty-attach-mouse.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the unit tests too**

Run: `node --test test/pty-scroll.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/pty-attach.ts test-support/pty-attach-mouse-scenario.ts test/pty-attach-mouse.test.mjs
git commit -m "fix(attach): middle-click paste via handleMouse under fullscreen TUI (issue #167)"
```

---

### Task 4: Full verify + coverage gate (A3, A4)

**Files:**
- Modify: whatever Task 1–3 fallout requires (expected: none).

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: green `npm run verify` — the PR-ready state.

- [ ] **Step 1: Run the full verify pipeline**

Run: `npm run verify` (= typecheck + perf gate + tests + coverage + pack:dry)
Expected: PASS end-to-end. Coverage thresholds: lines 85 / funcs 80 / branches 70 — the new pure function is fully covered by Task 2; `handleMouse` by Task 3's scenario is exercised at runtime (coverage counts only files it instruments via c8 — if the new component lines show as uncovered, extend `test/pty-scroll.test.mjs`-style unit reach only if c8 actually flags them; do not add coverage-only hacks).

- [ ] **Step 2: Fix any fallout, then re-run**

Run: `npm run verify`
Expected: PASS. If the perf gate (A11) or a pre-existing flaky real-process test blocks, re-run that single test once; if still red, STOP and report BLOCKED with the failure output (do not paper over CI-known flakes — see issue #95).

- [ ] **Step 3: Commit (only if Step 2 needed changes)**

```bash
git add <changed files>
git commit -m "test: verify fallout fixes for issue #167"
```

---

## Acceptance traceability

| Spec ID | Covered by |
| --- | --- |
| A1 (unit decision table) | Task 2 |
| A2 (component-level integration) | Task 3 |
| A3 (static/build) | Task 1 + Task 4 |
| A4 (existing suite regression) | Task 1 Step 4 + Task 4 |
| U1 (user manual: real terminal) | Post-implementation checklist for the user (fullscreen middle-click paste, regular mode unchanged, kill switch) — executed after the branch is merged or from the worktree install |
