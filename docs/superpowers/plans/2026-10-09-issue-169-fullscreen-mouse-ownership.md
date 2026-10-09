# Issue #169 Fullscreen Outer-Mouse Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `PtyAttachComponent` from writing ANY outer-terminal mouse-mode sequence in fullscreen mode (where `TuiAltScreen` owns reporting), fixing the post-detach mouse kill and the mid-attach mode downgrade, while keeping regular-mode behavior byte-identical.

**Architecture:** A pure decision helper (`shouldOwnOuterMouseMode(mode, mouseEnabled)` in `src/core/pty-scroll.mjs`) decides ownership; the component's two write choke points (`enableMouseScroll`, `disableMouseScroll`) both early-return when it says no. All existing call sites (ctor, connect, resize, close) route through those two methods, so no other code changes.

**Tech Stack:** TypeScript (tabs), node:test + assert/strict, node --experimental-transform-types scenario with a fake-TUI write spy and a nonexistent control socket.

**Spec:** `docs/superpowers/specs/2026-10-09-issue-169-fullscreen-mouse-ownership-design.md` (acceptance IDs A1–A4, U1 referenced per task). Cross-review was waived by user decision (recorded in the issue research dir).

## Global Constraints

- Work ONLY inside the worktree `<WT>` (branch `issue-169-fullscreen-mouse-ownership`); never touch main.
- Tabs for indentation; English comments and commit messages; conventional commit subjects.
- Pure-function split is a hard spec constraint: `shouldOwnOuterMouseMode` must not read `process.env` or `this.*` (call site resolves both args); must not be re-inlined into the component.
- `enableMouseScroll` / `disableMouseScroll` must remain the ONLY places that write `MOUSE_ENABLE` / `MOUSE_DISABLE` / `XTSHIFTESCAPE_SELECT` to the outer terminal.
- Regular-mode behavior must stay byte-identical (ctor disable→enable→refresh, 0/50/250ms refresh timers, connect/resize re-enable, close disable) — only the ownership gate is new.
- No behavior change for wheel/scroll/selection/middle-paste inside attach views; no changes outside the two choke points.
- Tests use `node:test` with self-contained fixtures under temp dirs; never the host repository.
- `test/` and `test-support/` are EXCLUDED from tsc — scenario files are runtime-transformed only; `src/` must stay `npm run typecheck`-clean (pi-tui 1.1.0 typings provide `TUI.mode`).

---

### Task 1: Pure decision helper `shouldOwnOuterMouseMode` (A1)

**Files:**
- Modify: `src/core/pty-scroll.mjs` (add export next to `resolveAttachMouseAction`, near the other mouse helpers)
- Test: `test/pty-scroll.test.mjs` (extend the existing import block and append tests)

**Interfaces:**
- Consumes: none.
- Produces: `shouldOwnOuterMouseMode(mode, mouseEnabled) → boolean` where `mode` is `Tui["mode"] | undefined` (string `"regular" | "fullscreen" | undefined`). Task 2's component imports this from `../core/pty-scroll.mjs`.

- [ ] **Step 1: Write the failing test**

In `test/pty-scroll.test.mjs`, extend the existing import from `../src/core/pty-scroll.mjs` with `shouldOwnOuterMouseMode`, then append:

```js
test("shouldOwnOuterMouseMode: fullscreen never owns; regular/undefined follow the switch", () => {
	assert.equal(shouldOwnOuterMouseMode("fullscreen", true), false);
	assert.equal(shouldOwnOuterMouseMode("fullscreen", false), false);
	assert.equal(shouldOwnOuterMouseMode("regular", true), true);
	assert.equal(shouldOwnOuterMouseMode("regular", false), false);
	// Old pi runtimes have no tui.mode — must behave like regular.
	assert.equal(shouldOwnOuterMouseMode(undefined, true), true);
	assert.equal(shouldOwnOuterMouseMode(undefined, false), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pty-scroll.test.mjs`
Expected: FAIL — `shouldOwnOuterMouseMode` is not exported / not a function.

- [ ] **Step 3: Implement**

In `src/core/pty-scroll.mjs`, next to `resolveAttachMouseAction`:

```js
/**
 * Issue #169: whether the attach surface should manage the OUTER terminal's
 * mouse mode. Only in regular TUI mode — in fullscreen, TuiAltScreen owns
 * mouse reporting (asserted once at startup, never re-asserted), so any write
 * from the attach surface can only downgrade or kill it. Old runtimes without
 * tui.mode behave as regular. Pure: both arguments are resolved at the call
 * site (mode from the TUI, the flag from the env-derived helper).
 */
export function shouldOwnOuterMouseMode(mode, mouseEnabled) {
	return mode !== "fullscreen" && !!mouseEnabled;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pty-scroll.test.mjs`
Expected: PASS (new + all pre-existing cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/pty-scroll.mjs test/pty-scroll.test.mjs
git commit -m "feat(attach): pure outer-mouse-mode ownership decision helper"
```

---

### Task 2: Component gating + runner-free ownership scenario (A2)

**Files:**
- Modify: `src/ui/pty-attach.ts` (import line ~13; new private method near `mouseScrollEnabled` (~:862); guards in `enableMouseScroll` (~:852) and `disableMouseScroll` (~:882))
- Create: `test-support/pty-attach-mouse-mode-scenario.ts`
- Test: `test/pty-attach-mouse-mode.test.mjs`

**Interfaces:**
- Consumes: `shouldOwnOuterMouseMode(mode, mouseEnabled)` from Task 1; `this.tui.mode` (typed `readonly mode: TuiMode` by pi-tui 1.1.0; absent at runtime on old hosts); `this.mouseScrollEnabled()` (existing private).
- Produces: private `ownsOuterMouseMode(): boolean`; gated `enableMouseScroll`/`disableMouseScroll`.

- [ ] **Step 1: Write the failing test + scenario**

Create `test/pty-attach-mouse-mode.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-mouse-mode-scenario.ts");

// Component-level outer-mouse-mode ownership coverage (issue #169): the REAL
// PtyAttachComponent against a fake TUI write spy and a nonexistent control
// socket. Asserts zero mouse-mode writes in fullscreen across ctor + refresh
// window + close, the preserved regular-mode pairing, zero writes under the
// kill switch (incl. close — the previously unguarded disable), and old-runtime
// (mode absent) behaving like regular.
test("attach mouse-mode ownership: fullscreen writes nothing; regular pairing kept; kill switch silent", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.fullscreen.writes, 0, "fullscreen: zero mouse-mode/XTSHIFTESCAPE writes across ctor+timers+close");
	assert.equal(parsed.fullscreen.enableAtCtor, false, "fullscreen: no MOUSE_ENABLE at ctor");
	assert.equal(parsed.fullscreen.disableAtClose, false, "fullscreen: no MOUSE_DISABLE at close");
	assert.equal(parsed.regular.enableAtCtor, true, "regular: MOUSE_ENABLE at ctor preserved");
	assert.equal(parsed.regular.disableAtClose, true, "regular: MOUSE_DISABLE at close preserved");
	assert.equal(parsed.off.writes, 0, "AGENT_BOARD_ATTACH_MOUSE=0: zero writes including close");
	assert.equal(parsed.legacy.enableAtCtor, true, "old runtime (no mode): behaves like regular");
	assert.equal(parsed.legacy.disableAtClose, true, "old runtime (no mode): close disables like regular");
});
```

Create `test-support/pty-attach-mouse-mode-scenario.ts`:

```ts
// Component-level outer-mouse-mode ownership coverage (issue #169): the REAL
// PtyAttachComponent with a fake TUI whose terminal.write collects bytes, run
// against a nonexistent control socket (on non-Windows, connect() short-
// circuits to its reconnect loop before creating a socket — no socket churn).
// Four cases:
//   1. mode "fullscreen"       → ZERO mouse-mode/XTSHIFTESCAPE writes across
//      ctor + the 0/50/250ms refresh window + close() (TuiAltScreen owns it);
//   2. mode "regular"          → today's pairing preserved (MOUSE_ENABLE at
//      ctor, MOUSE_DISABLE at close);
//   3. mode "regular" + AGENT_BOARD_ATTACH_MOUSE=0 → zero writes including
//      close() (fixes the previously unguarded disable);
//   4. mode absent (old pi)    → behaves like regular.
// Run via `node --experimental-transform-types`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MOUSE_BYTE_RE = /\x1b\[\?(1000|1002|1003|1004|1006)[hl]/;
const XTSHIFTESCAPE_RE = /\x1b\[>0s/;

interface CaseResult {
	writes: number;
	enableAtCtor: boolean;
	disableAtClose: boolean;
}

async function runCase(mode: string | undefined, env: Record<string, string> | undefined): Promise<CaseResult> {
	const writes: string[] = [];
	const tui = {
		mode,
		terminal: { rows: 24, cols: 80, columns: 80, write: (s: string) => { writes.push(s); } },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const root = mkdtempSync(join(tmpdir(), "agentview-mouse-mode-"));
	const socketPath = join(root, "nonexistent.sock");
	const prevEnv: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env ?? {})) {
		prevEnv[k] = process.env[k];
		process.env[k] = v;
	}
	let component: PtyAttachComponent | null = null;
	try {
		component = new PtyAttachComponent(
			tui as never,
			theme as never,
			{} as never,
			() => {},
			{ socketPath, title: "mouse mode e2e" } as never,
		);
		const enableAtCtor = writes.some((s) => s.includes("\x1b[?1000h"));
		await sleep(400); // past the 250ms refresh window
		try { component.dispose(); } catch {}
		await sleep(100);
		const disableAtClose = writes.some((s) => s.includes("\x1b[?1000l"));
		return {
			writes: writes.filter((s) => MOUSE_BYTE_RE.test(s) || XTSHIFTESCAPE_RE.test(s)).length,
			enableAtCtor,
			disableAtClose,
		};
	} finally {
		try { component?.dispose(); } catch {}
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); } catch {}
	}
}

const result = {
	error: null as string | null,
	fullscreen: null as CaseResult | null,
	regular: null as CaseResult | null,
	off: null as CaseResult | null,
	legacy: null as CaseResult | null,
};

try {
	result.fullscreen = await runCase("fullscreen", undefined);
	result.regular = await runCase("regular", undefined);
	result.off = await runCase("regular", { AGENT_BOARD_ATTACH_MOUSE: "0" });
	result.legacy = await runCase(undefined, undefined);
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
}
console.log(JSON.stringify(result));
process.exit(0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pty-attach-mouse-mode.test.mjs`
Expected: FAIL — `parsed.fullscreen.writes` > 0 (ctor writes `MOUSE_DISABLE`+`XTSHIFTESCAPE`+`MOUSE_ENABLE`, refresh timers re-enable) and/or `parsed.off.writes` > 0 (unguarded disable). The `regular`/`legacy` assertions may already pass — the failure must be on the fullscreen/off fields.

- [ ] **Step 3: Implement the gating**

In `src/ui/pty-attach.ts`:

Import line (~13) — extend the core import (keep alphabetical order):

```ts
import { clampInt, parseMouseInputChunk, resolveAttachMouseAction, resolveWheelLines, scrollViewportTop, selectionDragScrollLines, shouldOwnOuterMouseMode } from "../core/pty-scroll.mjs";
```

Near `mouseScrollEnabled()` (~:862), add the private method:

```ts
	/** Issue #169: in fullscreen mode TuiAltScreen owns outer-terminal mouse
	 * reporting (asserted once at startup, never re-asserted) — writing any
	 * mouse-mode sequence from here can only downgrade or kill it. tui.mode is
	 * typed non-optional but old pi runtimes lack it; the strict inequality
	 * then keeps today's (regular) behavior. */
	private ownsOuterMouseMode(): boolean {
		return shouldOwnOuterMouseMode(this.tui.mode, this.mouseScrollEnabled());
	}
```

In `enableMouseScroll()` (~:852), replace the guard:

```ts
	private enableMouseScroll(): void {
		if (!this.ownsOuterMouseMode()) return;
		try {
			this.tui.terminal.write(XTSHIFTESCAPE_SELECT);
			this.tui.terminal.write(MOUSE_ENABLE);
		} catch {
			/* best-effort: some terminals reject these sequences; mouse reporting is optional */
		}
	}
```

In `disableMouseScroll()` (~:882), add the guard as the first statement:

```ts
	private disableMouseScroll(): void {
		if (!this.ownsOuterMouseMode()) return;
		try {
			this.tui.terminal.write(MOUSE_DISABLE);
		} catch {
			/* best-effort: terminal may already be gone at teardown */
		}
	}
```

Do NOT change any other call site (ctor :278-280, connect :487, resize :1203, close :1524 route through these methods unchanged).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pty-attach-mouse-mode.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the unit tests + typecheck**

Run: `node --test test/pty-scroll.test.mjs && npm run typecheck`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add src/ui/pty-attach.ts test-support/pty-attach-mouse-mode-scenario.ts test/pty-attach-mouse-mode.test.mjs
git commit -m "fix(attach): stop writing outer-terminal mouse mode in fullscreen (issue #169)"
```

---

### Task 3: Full verify + coverage gate (A3, A4)

**Files:**
- Modify: whatever Tasks 1–2 fallout requires (expected: none).

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: green `npm run verify` — the PR-ready state.

- [ ] **Step 1: Run the full verify pipeline**

Run: `npm run verify` (= typecheck + perf gate + tests + coverage + pack:dry)
Expected: PASS end-to-end. Coverage thresholds: lines 85 / funcs 80 / branches 70 — `shouldOwnOuterMouseMode` is fully unit-covered (Task 1); the component gate lines are exercised by the Task 2 scenario at runtime (c8 does not instrument test-support, same as #171 — no coverage hacks).

- [ ] **Step 2: Fix any fallout, then re-run**

Run: `npm run verify`
Expected: PASS. If a pre-existing flaky real-process test blocks (issue #95), re-run that single test once; if still red, STOP and report BLOCKED with the failure output.

- [ ] **Step 3: Commit (only if Step 2 needed changes)**

```bash
git add <changed files>
git commit -m "test: verify fallout fixes for issue #169"
```

---

## Acceptance traceability

| Spec ID | Covered by |
| --- | --- |
| A1 (unit decision table) | Task 1 |
| A2 (component-level ownership scenario) | Task 2 |
| A3 (static/build) | Task 3 (+ typecheck in Task 2 Step 5) |
| A4 (existing suite regression) | Task 3 |
| U1 (user manual: detach-then-select survives; 5-step checklist) | Post-implementation checklist for the user — executed after merge or from the worktree install |
