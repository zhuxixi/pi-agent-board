# Issue #174 Selection Mirror + Paste Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the fullscreen select→middle-click-paste loop: mirror pi's (final) selection text into X11 PRIMARY when a selection gesture ends inside the attach view (B2), and add an opt-in `AGENT_BOARD_ATTACH_PASTE_SOURCE=primary|clipboard` paste-source override (C).

**Architecture:** Two pure decision helpers in `src/core/pty-scroll.mjs` (`resolvePasteSelectionSource`, `shouldMirrorSelectionToPrimary`); `PtyAttachComponent.handleMouse` observes left release/click (returns `undefined`, consumes nothing) and schedules a `process.nextTick` mirror that reads `TuiAltScreen.getActiveSelectionText()` and reuses `writePrimarySelection`; `pastePrimarySelection` parameterizes its `-selection` argument from the env knob. pi's own selection behavior is untouched.

**Tech Stack:** TypeScript (tabs), node:test + assert/strict, node --experimental-transform-types scenario with a PATH-stubbed bidirectional `xclip`.

**Spec:** `docs/superpowers/specs/2026-10-10-issue-174-selection-mirror-paste-source-design.md` (acceptance IDs A1–A5, U1). Cross-review waived by user decision (recorded in the issue research dir).

## Global Constraints

- Work ONLY inside the worktree `<WT>` (branch `issue-174-selection-mirror-paste-source`); never touch main.
- Tabs for indentation; English comments and commit messages; conventional commit subjects.
- Pure-function split is a hard spec constraint: both helpers take resolved values (no `process.env` reads inside); must not be re-inlined into the component.
- `handleMouse` must remain the ONLY mirror scheduling point; `writePrimarySelection`/`pastePrimarySelection` remain the only xclip touch points.
- The mirror branch must return `undefined` (observe only) — pi's fullscreen selection keeps every left-button event. No changes to #169's ownership model, #171's paste decision behavior, or regular-mode behavior.
- The kill switch `AGENT_BOARD_ATTACH_NATIVE_PASTE=0` must disable BOTH the mirror and the paste.
- Tests use `node:test` with self-contained fixtures under temp dirs; never the host repository.
- `test/` and `test-support/` are EXCLUDED from tsc — scenario files are runtime-transformed only; `src/` must stay `npm run typecheck`-clean.

---

### Task 1: Pure decision helpers (A1)

**Files:**
- Modify: `src/core/pty-scroll.mjs` (add exports next to `resolveAttachMouseAction` / `shouldOwnOuterMouseMode`)
- Test: `test/pty-scroll.test.mjs` (extend the existing import block and append tests)

**Interfaces:**
- Consumes: none.
- Produces: `resolvePasteSelectionSource(value) → "primary" | "clipboard"` (value = the raw `AGENT_BOARD_ATTACH_PASTE_SOURCE` env string or undefined; unknown → `"primary"`) and `shouldMirrorSelectionToPrimary(event, { nativePasteEnabled }) → "mirror-primary" | null`. Tasks 2–3 import both from `../core/pty-scroll.mjs`.

- [ ] **Step 1: Write the failing tests**

In `test/pty-scroll.test.mjs`, extend the existing import from `../src/core/pty-scroll.mjs` with `resolvePasteSelectionSource` and `shouldMirrorSelectionToPrimary`, then append:

```js
test("resolvePasteSelectionSource: clipboard opt-in, everything else primary", () => {
	assert.equal(resolvePasteSelectionSource(undefined), "primary");
	assert.equal(resolvePasteSelectionSource(""), "primary");
	assert.equal(resolvePasteSelectionSource("primary"), "primary");
	assert.equal(resolvePasteSelectionSource("clipboard"), "clipboard");
	assert.equal(resolvePasteSelectionSource(" CLIPBOARD "), "clipboard");
	assert.equal(resolvePasteSelectionSource("garbage"), "primary");
});

test("shouldMirrorSelectionToPrimary: only selection endings of the left button with paste enabled", () => {
	assert.equal(shouldMirrorSelectionToPrimary(ev("release", "left"), { nativePasteEnabled: true }), "mirror-primary");
	assert.equal(shouldMirrorSelectionToPrimary(ev("click", "left"), { nativePasteEnabled: true }), "mirror-primary");
	assert.equal(shouldMirrorSelectionToPrimary(ev("release", "left"), { nativePasteEnabled: false }), null);
	assert.equal(shouldMirrorSelectionToPrimary(ev("click", "left"), { nativePasteEnabled: false }), null);
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
	];
	for (const [type, button] of cases) {
		assert.equal(shouldMirrorSelectionToPrimary(ev(type, button), { nativePasteEnabled: true }), null, `${type}/${button}`);
	}
});
```

(`ev` helper already exists in this file from #171 — reuse it, do not redefine.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/pty-scroll.test.mjs`
Expected: FAIL — the two helpers are not exported.

- [ ] **Step 3: Implement**

In `src/core/pty-scroll.mjs`, next to `resolveAttachMouseAction`:

```js
/**
 * Issue #174 (C): which X11 selection buffer middle-click paste reads.
 * "primary" = classic X11 middle-click semantics (default); "clipboard" =
 * escape hatch for environments where PRIMARY never updates (e.g. WSLg).
 * Unknown or unset values fall back to "primary". Pure: the raw env value is
 * read at the call site.
 */
export function resolvePasteSelectionSource(value) {
	return typeof value === "string" && value.trim().toLowerCase() === "clipboard" ? "clipboard" : "primary";
}

/**
 * Issue #174 (B2): whether a normalized mouse event ends a selection gesture
 * we should mirror into the X11 PRIMARY selection. Only release/click of the
 * left button with native paste enabled (pi's fullscreen selection owns the
 * gesture; we observe without consuming). Pure by contract.
 */
export function shouldMirrorSelectionToPrimary(event, { nativePasteEnabled }) {
	if (!nativePasteEnabled) return null;
	if ((event.type === "release" || event.type === "click") && event.button === "left") return "mirror-primary";
	return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pty-scroll.test.mjs`
Expected: PASS (new + all pre-existing cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-scroll.mjs test/pty-scroll.test.mjs
git commit -m "feat(attach): pure decision helpers for selection mirror and paste source"
```

---

### Task 2: B2 — mirror wiring + runner-free scenario (A2)

**Files:**
- Modify: `src/ui/pty-attach.ts` (import line ~13; `handleMouse` :376; new private method near `writePrimarySelection` ~:1150)
- Create: `test-support/pty-attach-selection-mirror-scenario.ts`
- Test: `test/pty-attach-selection-mirror.test.mjs`

**Interfaces:**
- Consumes: `shouldMirrorSelectionToPrimary(event, { nativePasteEnabled })` from Task 1; `this.writePrimarySelection(text)` (existing private); `this.tui` cast `as { getActiveSelectionText?: () => string | undefined }`.
- Produces: private `mirrorFullscreenSelectionToPrimary(): void`; the observe-branch in `handleMouse`.

- [ ] **Step 1: Write the failing test + scenario**

Create `test/pty-attach-selection-mirror.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-selection-mirror-scenario.ts");

// Component-level coverage (issue #174 B2): the REAL PtyAttachComponent with a
// fake fullscreen TUI (getActiveSelectionText fixture) and a PATH-stubbed
// bidirectional xclip that records reads/writes to a log. Asserts the mirror
// fires on left release/click (deferred one tick), never consumes the event,
// skips empty selections, honors the kill switch, and ignores non-endings.
test("attach selection mirror: left release/click mirrors pi's selection into PRIMARY", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.releaseResultUndefined, true, "release(left) must return undefined (observe only)");
	assert.equal(parsed.mirrorWrites, 1, "exactly one PRIMARY write for the drag-style release");
	assert.equal(parsed.mirrorText, "mirror-fixture-text", "the mirrored text is getActiveSelectionText()'s value");
	assert.equal(parsed.clickResultUndefined, true, "click(left) must return undefined");
	assert.equal(parsed.clickMirrorWrites, 1, "the click case also mirrors (selection non-empty)");
	assert.equal(parsed.emptyWrites, 0, "empty selection must not write");
	assert.equal(parsed.killSwitchWrites, 0, "NATIVE_PASTE=0 must disable the mirror");
	assert.equal(parsed.nonEndingWrites, 0, "press/move must not trigger the mirror");
});
```

Create `test-support/pty-attach-selection-mirror-scenario.ts`:

```ts
// Component-level selection-mirror coverage (issue #174 B2): the REAL
// PtyAttachComponent with a fake fullscreen TUI whose getActiveSelectionText
// returns a controllable fixture, run against a nonexistent control socket,
// with a PATH-stubbed bidirectional xclip that appends every invocation
// (args + stdin for writes) to a log file and prints a read fixture for -o.
// Run via `node --experimental-transform-types`.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const READ_FIXTURE = "read-fixture-text";

const root = mkdtempSync(join(tmpdir(), "agentview-sel-mirror-"));
const binDir = join(root, "bin");
mkdirSync(binDir);
const logPath = join(root, "xclip.log");
writeFileSync(logPath, "");
writeFileSync(
	join(binDir, "xclip"),
	[
		"#!/bin/sh",
		`if [ "$1" = "-o" ]; then`,
		`  echo "read $*" >> "${logPath}"`,
		`  printf '%s' "${READ_FIXTURE}"`,
		"else",
		'  text="$(cat)"',
		`  echo "write $* text=$text" >> "${logPath}"`,
		"fi",
	].join("\n"),
);
chmodSync(join(binDir, "xclip"), 0o755);
process.env.PATH = `${binDir}:${process.env.PATH}`;

// The selection pi would have finalized by the time the deferred mirror runs.
let selectionText: string | undefined = "mirror-fixture-text";

const writes = () =>
	readFileSync(logPath, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("write "));

const leftEvent = (type: "release" | "click" | "press" | "move") => ({
	type,
	button: "left",
	x: 3,
	y: 3,
	screenX: 3,
	screenY: 3,
	width: 80,
	height: 22,
	shift: false,
});

async function withComponent(env: Record<string, string> | undefined, fn: (c: PtyAttachComponent) => Promise<void>): Promise<void> {
	const prevEnv: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env ?? {})) {
		prevEnv[k] = process.env[k];
		process.env[k] = v;
	}
	const tui = {
		mode: "fullscreen",
		getActiveSelectionText: () => selectionText,
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	let component: PtyAttachComponent | null = null;
	try {
		component = new PtyAttachComponent(
			tui as never,
			theme as never,
			{} as never,
			() => {},
			{ socketPath: join(root, "nonexistent.sock"), title: "sel mirror e2e" } as never,
		);
		await fn(component);
	} finally {
		try { component?.dispose(); } catch {}
		await sleep(50);
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const result = {
	error: null as string | null,
	releaseResultUndefined: false,
	mirrorWrites: -1,
	mirrorText: null as string | null,
	clickResultUndefined: false,
	clickMirrorWrites: -1,
	emptyWrites: -1,
	killSwitchWrites: -1,
	nonEndingWrites: -1,
};

try {
	// 1. Drag-style release mirrors the selection exactly once, unconsumed.
	await withComponent(undefined, async (c) => {
		const before = writes().length;
		const r = (c as any).handleMouse(leftEvent("release"));
		result.releaseResultUndefined = r === undefined;
		await sleep(80); // nextTick + xclip spawn
		const ws = writes();
		result.mirrorWrites = ws.length - before;
		result.mirrorText = ws.length > before ? ws[ws.length - 1].replace(/^write .*?text=/, "") : null;
	});

	// 2. Click ending (non-empty selection) mirrors too, unconsumed.
	await withComponent(undefined, async (c) => {
		const before = writes().length;
		const r = (c as any).handleMouse(leftEvent("click"));
		result.clickResultUndefined = r === undefined;
		await sleep(80);
		result.clickMirrorWrites = writes().length - before;
	});

	// 3. Empty selection: no write.
	await withComponent(undefined, async (c) => {
		const prev = selectionText;
		selectionText = undefined;
		const before = writes().length;
		(c as any).handleMouse(leftEvent("release"));
		await sleep(80);
		result.emptyWrites = writes().length - before;
		selectionText = prev;
	});

	// 4. Kill switch: no write.
	await withComponent({ AGENT_BOARD_ATTACH_NATIVE_PASTE: "0" }, async (c) => {
		const before = writes().length;
		(c as any).handleMouse(leftEvent("release"));
		await sleep(80);
		result.killSwitchWrites = writes().length - before;
	});

	// 5. Non-endings (press/move): no write.
	await withComponent(undefined, async (c) => {
		const before = writes().length;
		(c as any).handleMouse(leftEvent("press"));
		(c as any).handleMouse(leftEvent("move"));
		await sleep(80);
		result.nonEndingWrites = writes().length - before;
	});
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
}

try {
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
} catch {}
console.log(JSON.stringify(result));
process.exit(0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pty-attach-selection-mirror.test.mjs`
Expected: FAIL — `mirrorWrites` 0 (≠1), `releaseResultUndefined` still true (returns undefined today for everything), so the failing assertion is `mirrorWrites === 1` / `mirrorText`. The kill-switch/empty/non-ending cases pass trivially; the failure must be on the mirror fields.

- [ ] **Step 3: Implement the mirror**

In `src/ui/pty-attach.ts`:

Import line (~13) — extend the core import (alphabetical):

```ts
import { clampInt, parseMouseInputChunk, resolveAttachMouseAction, resolveWheelLines, scrollViewportTop, selectionDragScrollLines, shouldMirrorSelectionToPrimary, shouldOwnOuterMouseMode } from "../core/pty-scroll.mjs";
```

`handleMouse` (:376) — hoist the flag, add the observe-branch before the paste logic:

```ts
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const nativePasteEnabled = process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE !== "0";
		if (shouldMirrorSelectionToPrimary(event, { nativePasteEnabled })) {
			// Observe only — pi's fullscreen selection keeps the event. Mirroring must
			// run after TuiAltScreen finalizes the selection for this event (overlays
			// are dispatched before the selection logic), hence the deferred tick.
			process.nextTick(() => this.mirrorFullscreenSelectionToPrimary());
			return undefined;
		}
		const action = resolveAttachMouseAction(event, { nativePasteEnabled });
		if (action !== "paste-primary") return undefined;
		this.clearPendingClick();
		this.clearSelection();
		this.pastePrimarySelection();
		return { handled: true, render: false };
	}
```

Near `writePrimarySelection` (~:1150), add:

```ts
	/** Issue #174 (B2): after a selection gesture ends inside this overlay, copy
	 * pi's final selection text into the X11 PRIMARY selection so the classic
	 * select-then-middle-click-paste loop works in fullscreen. Runs on nextTick
	 * because overlays are dispatched before TuiAltScreen finalizes the
	 * selection for the same event. No-op in regular mode (no
	 * getActiveSelectionText) and under the native-paste kill switch. */
	private mirrorFullscreenSelectionToPrimary(): void {
		if (this.closed) return;
		const alt = this.tui as { getActiveSelectionText?: () => string | undefined };
		const text = alt.getActiveSelectionText?.();
		if (typeof text === "string" && text.length > 0) this.writePrimarySelection(text);
	}
```

Do NOT touch anything else (paste decision, ownership gating, legacy paths).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pty-attach-selection-mirror.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the unit tests + typecheck**

Run: `node --test test/pty-scroll.test.mjs && npm run typecheck`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add src/ui/pty-attach.ts test-support/pty-attach-selection-mirror-scenario.ts test/pty-attach-selection-mirror.test.mjs
git commit -m "feat(attach): mirror pi's fullscreen selection into X11 PRIMARY (issue #174)"
```

---

### Task 3: C — paste-source override + scenario case (A3)

**Files:**
- Modify: `src/ui/pty-attach.ts` (`pastePrimarySelection` ~:1120, one line)
- Modify: `test-support/pty-attach-selection-mirror-scenario.ts` (one more case)
- Modify: `test/pty-attach-selection-mirror.test.mjs` (assertions for the new case)

**Interfaces:**
- Consumes: `resolvePasteSelectionSource(value)` from Task 1.
- Produces: paste reads `-selection primary|clipboard` per `AGENT_BOARD_ATTACH_PASTE_SOURCE`.

- [ ] **Step 1: Extend the scenario + test first**

In `test-support/pty-attach-selection-mirror-scenario.ts`, add a reads-counter helper next to `writes` and one more case before the catch (after case 5):

```ts
const reads = () =>
	readFileSync(logPath, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("read "));
```

and inside the `result` object add `clipboardReads: -1, clipboardReadSource: null as string | null`. Then after case 5:

```ts
	// 6. Paste source override: middle paste reads CLIPBOARD when configured.
	await withComponent({ AGENT_BOARD_ATTACH_PASTE_SOURCE: "clipboard" }, async (c) => {
		const before = reads().length;
		const r = (c as any).handleMouse({ type: "press", button: "middle", x: 3, y: 3, screenX: 3, screenY: 3, width: 80, height: 22, shift: false });
		result.middleHandled = r?.handled === true;
		await sleep(200); // xclip spawn + close
		const rs = reads();
		result.clipboardReads = rs.length - before;
		result.clipboardReadSource = rs.length > before ? rs[rs.length - 1] : null;
	});
```

(declare `middleHandled: false` in `result` too). In `test/pty-attach-selection-mirror.test.mjs`, append:

```js
	assert.equal(parsed.middleHandled, true, "middle press still pastes (handled)");
	assert.equal(parsed.clipboardReads, 1, "PASTE_SOURCE=clipboard: exactly one clipboard read");
	assert.equal(parsed.clipboardReadSource, "read -o -selection clipboard", "the read targets the clipboard selection");
```

- [ ] **Step 2: Run to verify the new assertions fail**

Run: `node --test test/pty-attach-selection-mirror.test.mjs`
Expected: FAIL — `clipboardReadSource` is `read -o -selection primary` (the hardcoded value).

- [ ] **Step 3: Implement**

In `pastePrimarySelection()` (~:1120), change the spawn line:

```ts
			const child = spawn("xclip", ["-o", "-selection", resolvePasteSelectionSource(process.env.AGENT_BOARD_ATTACH_PASTE_SOURCE)], { stdio: ["ignore", "pipe", "ignore"] });
```

(extend the existing `../core/pty-scroll.mjs` import with `resolvePasteSelectionSource` — alphabetical placement).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/pty-attach-selection-mirror.test.mjs && node --test test/pty-attach-mouse.test.mjs`
Expected: PASS (the #171 scenario pins the default primary source — still green).

- [ ] **Step 5: Commit**

```bash
git add src/ui/pty-attach.ts test-support/pty-attach-selection-mirror-scenario.ts test/pty-attach-selection-mirror.test.mjs
git commit -m "feat(attach): AGENT_BOARD_ATTACH_PASTE_SOURCE paste-source override (issue #174)"
```

---

### Task 4: Full verify + coverage gate (A4, A5)

**Files:**
- Modify: whatever Tasks 1–3 fallout requires (expected: none).

- [ ] **Step 1: Run the full verify pipeline**

Run: `npm run verify`
Expected: PASS end-to-end (typecheck + perf gate + tests + coverage lines 85 / funcs 80 / branches 70 + pack:dry).

- [ ] **Step 2: Fix any fallout, then re-run** (known pre-existing flake: `pty-runner.integration.test.mjs`, issue #95 — re-run once; still red → STOP and report BLOCKED)

- [ ] **Step 3: Commit (only if fixes were needed)**

```bash
git add <changed files>
git commit -m "test: verify fallout fixes for issue #174"
```

---

## Acceptance traceability

| Spec ID | Covered by |
| --- | --- |
| A1 (unit decision tables) | Task 1 |
| A2 (B2 mirror wiring, integration) | Task 2 |
| A3 (C paste source, integration) | Task 3 |
| A4 (static/build) | Task 4 (+ typecheck in Tasks 2–3) |
| A5 (existing suite regression) | Task 4 |
| U1 (user manual: 5-step real-terminal checklist) | Post-implementation checklist for the user — executed after merge or from the worktree install |
