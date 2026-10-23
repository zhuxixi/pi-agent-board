# Selected Row Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the board's selected row identifiable at rest by painting its full line (indent through the trailing pad) with the theme's `selectedBg`.

**Architecture:** One pure module-scope helper `applyRowHighlight(theme, selected, text)` decides whether to wrap a line; `renderRow` calls it on `indent + clipped body` so the highlight starts at column 0 and covers the right edge. The theme token (`selectedBg`) is pi's own selection background, so dark/light themes and 256/16-colour terminals are handled by pi. A new TS harness (`dashboard-selection-render.ts`) drives the real `DashboardComponent` and asserts the ANSI structure; the eight pre-existing `DashboardComponent` harnesses get an identity `bg` stub.

**Tech Stack:** TypeScript (src/ui), Node 20+ `node:test` + `node --experimental-transform-types` harnesses, `@earendil-works/pi-tui` (`visibleWidth`, `truncateToWidth`), pi theme tokens (`ThemeBg = "selectedBg"`).

**Spec:** `docs/superpowers/specs/2026-10-23-selected-row-highlight-design.md`

**Worktree:** `C:/Users/27499/proj/opensource/pi-agent-board/.pi/worktrees/issue-231-selected-row-highlight` — every path below is relative to it; never edit the main checkout.

## Global Constraints

- Tabs for indentation; English comments; conventional commit subjects with the issue number (`(#231)` lands on the PR, not on local commits).
- Do not change `select` mode's `◉/○`, the peek header, the flash banner, the folder-header `▌`, or `windowBody()` (open PR #226 owns the viewport).
- Highlight colour comes **only** from `theme.bg("selectedBg", …)` — no hardcoded RGB, no per-stage background, no `muted → dim` demotion.
- `\x1b[49m` (emitted by `theme.bg`) must stay inside the clipped string; the bg span must include the folder indent, the trailing pad, and the age column.
- `npm run verify` (typecheck + perf + test + coverage + pack:dry) is the gate before claiming done.
- Do not touch `research/`, `~/.github-issue-driven/`, or the main checkout; `git add <explicit files>` only.

## Review Focus

1. **Ultra-narrow terminals (`width < 24`)** — `contentWidth` has a floor of 20, so `indent + contentWidth > width` and `clip` truncates with `\x1b[0m`. The highlight may lose its closer there, but it must never leak into following rows. → A8 (Task 2).
2. **`selectedId` matching no visible row** (e.g. after a filter) — no row may be painted. → A5 zero-branch (Task 2).
3. **Folder-group indent (`indent = 4`)** — the bg opener must sit at column 0, before the indent, not after it. → A3 (Task 2).
4. **`select` mode** — the batch marker `◉/○` must remain visible and the highlight must still apply. → A6 (Task 2).
5. **Coexisting strong signals** — the flash banner keeps its own bg bar, the folder header keeps its `▌`, and the peek header stays unhighlighted. → A7 (Task 2) and U5 (manual).

---

### Task 1: Pure highlight helper

**Files:**
- Modify: `src/ui/dashboard.ts` (insert the exported helper next to `stageFg` / `ansiBg`, around the `STAGE_RGB` block at :1968-1996)
- Create: `test-support/dashboard-selection-render.ts`
- Create: `test/dashboard-selection.test.mjs`

**Interfaces:**
- Consumes: `ThemeLike` (`src/ui/dashboard.ts:50-56`, already declares `bg(color: string, text: string): string`).
- Produces:
  - `export function applyRowHighlight(theme: Pick<ThemeLike, "bg">, selected: boolean, text: string): string`
  - Harness JSON contract: `{ ok: boolean, unit: { unselectedIdentical: boolean, selectedWrapped: boolean, themeCallCount: number } }` (integration fields are added in Task 2).

- [ ] **Step 1: Write the failing test**

Create `test/dashboard-selection.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT_DIR, "test-support", "dashboard-selection-render.ts");

function runHarness() {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCRIPT], {
		encoding: "utf8",
		timeout: 30_000,
	});
	return JSON.parse(out);
}

test("applyRowHighlight is a pure pass-through when unselected and wraps once when selected (issue #231)", () => {
	const parsed = runHarness();
	assert.equal(parsed.ok, true);
	assert.equal(parsed.unit.unselectedIdentical, true, "unselected input must come back byte-identical");
	assert.equal(parsed.unit.selectedWrapped, true, "selected input must be wrapped exactly once");
	assert.equal(parsed.unit.themeCallCount, 1, "the helper must call theme.bg once per selected row, never for unselected rows");
});
```

Create `test-support/dashboard-selection-render.ts` (unit part only for now):

```ts
// Dashboard selected-row harness: renders real DashboardComponent frames with a
// recording/ANSI-emitting theme stub and prints JSON flags the .mjs test asserts
// on. Unit checks for the pure helper live here too so one process proves both.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createView } from "../src/core/store.mjs";
import { createService } from "../src/runtime/service.mjs";
import { applyRowHighlight, DashboardComponent } from "../src/ui/dashboard.ts";

const BG_OPEN = "\x1b[48;2;1;2;3m";
const BG_CLOSE = "\x1b[49m";

const root = mkdtempSync(join(tmpdir(), "agentview-selection-render-"));
try {
	let bgCalls = 0;
	const theme = {
		fg: (token: string, text: string) => {
			fgCalls.push([token, text]);
			return text;
		},
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		bg: (_color: string, text: string) => {
			bgCalls += 1;
			return `${BG_OPEN}${text}${BG_CLOSE}`;
		},
	};
	const fgCalls: Array<[string, string]> = [];

	// --- unit: the pure helper -------------------------------------------
	const identity = "plain line";
	const untouched = applyRowHighlight(theme, false, identity);
	const callsAfterUnselected = bgCalls;
	const wrapped = applyRowHighlight(theme, true, identity);

	console.log(
		JSON.stringify({
			ok: true,
			unit: {
				unselectedIdentical: untouched === identity && callsAfterUnselected === 0,
				selectedWrapped: wrapped === `${BG_OPEN}${identity}${BG_CLOSE}`,
				themeCallCount: bgCalls,
			},
		}),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
```

(Keep `createView`, `createService`, `DashboardComponent` and `visibleWidth` imported even though the unit part does not use them yet — Task 2 fills in the integration section, and the typecheck gate excludes `test-support/` anyway.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/dashboard-selection.test.mjs`
Expected: FAIL — the harness throws because `applyRowHighlight` is not exported from `../src/ui/dashboard.ts` (or `parsed.ok` is missing).

- [ ] **Step 3: Implement `applyRowHighlight` in `src/ui/dashboard.ts`**

Place it next to `stageFg`:

```ts
/**
 * Issue #231: the selected row's full-line background. Pure (the theme is
 * injected) so the wrap/close contract is unit-testable, and an unselected row
 * is returned byte-identical.
 */
export function applyRowHighlight(
	theme: Pick<ThemeLike, "bg">,
	selected: boolean,
	text: string,
): string {
	return selected ? theme.bg("selectedBg", text) : text;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/dashboard-selection.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard.ts test/dashboard-selection.test.mjs test-support/dashboard-selection-render.ts
git commit -m "feat(ui): add pure selected-row highlight helper (issue #231)"
```

---

### Task 2: Paint the row, cover the indent, and keep every existing harness green

**Files:**
- Modify: `src/ui/dashboard.ts:1459-1483` (`renderRow` return path)
- Modify: `test-support/dashboard-selection-render.ts` (add the integration section and its JSON fields)
- Modify: `test/dashboard-selection.test.mjs` (assert the integration fields)
- Modify (stub only): `test-support/dashboard-delete-key-probe.ts`, `test-support/cwd-browse-tab-probe.ts`, `test-support/dashboard-shrink-render.ts`, `test-support/dashboard-refs-render.ts`, `test-support/dashboard-prewarm-smoke.ts`, `test-support/navigation-wrap.ts`, `test-support/hold-key-wrap.ts`, `test-support/ui-smoke.ts`, `test-support/attach-delete-flow-probe.ts`

**Interfaces:**
- Consumes: `applyRowHighlight` from Task 1.
- Produces: `renderRow` output whose selected-row string begins with the theme's bg opener and ends with `\x1b[49m`; harness JSON gains `integration: { selectedStartsAtCol0, selectedWidth, unselectedHasNoOpener, selectedHasArrow, unselectedHasNoArrow, selectedCloserLast, selectedCloserCount, firstFrameBgCalls, zeroSelectionBgCalls, selectMarkerPresent, selectUnselectedCircle, selectHasBg, peekHasNoOpener, peekHeaderUsesAccent, narrowMaxWidth, narrowLeaked, unselectedUsesMuted, unselectedNameIsDim }` (`firstFrameBgCalls` is the per-frame `bgCalls` counter of the selected-row render; `zeroSelectionBgCalls` is the same counter with a `selectedId` that matches no visible row).

- [ ] **Step 1: Write the failing integration assertions**

Append to `test-support/dashboard-selection-render.ts`, inside the `try` block, after the unit section, and change the single `console.log` to emit both `unit` and `integration`:

```ts
	// --- integration: real render frames ---------------------------------
	createView(root, { id: "v1", name: "alpha session", cwd: join(root, "proj-a") });
	createView(root, { id: "v2", name: "beta session", cwd: join(root, "proj-b") });
	const service = createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: root,
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
	});
	const tui = {
		terminal: { rows: 40, cols: 160, columns: 160, write: () => {} },
		requestRender: () => {},
	};
	const makeDash = () =>
		new DashboardComponent(tui as never, theme as never, {} as never, () => {}, {
			service,
			root,
			defaultCwd: root,
			availableModels: [],
			currentModel: null,
			currentThinkingLevel: "off",
		});

	// Two cwds ⇒ showFolders=true ⇒ rows carry indent 4.
	bgCalls = 0;
	const dash = makeDash();
	const lines = dash.render(160);
	const selectedLine = lines.find((line) => line.includes("alpha session")) ?? "";
	const otherLine = lines.find((line) => line.includes("beta session")) ?? "";

	const selectedStartsAtCol0 = selectedLine.startsWith(BG_OPEN);
	const selectedWidth = visibleWidth(selectedLine);
	const unselectedHasNoOpener = !otherLine.includes(BG_OPEN);
	const selectedHasArrow = selectedLine.includes("›");
	const unselectedHasNoArrow = !otherLine.includes("›");
	const firstFrameBgCalls = bgCalls;

	// select mode: press `m`, then space to batch-mark the current row.
	dash.handleInput("m");
	dash.handleInput(" ");
	const selectLines = dash.render(160);
	const selectMarkerPresent = selectLines.some((line) => line.includes("◉"));
	const selectHasBg = selectLines.find((line) => line.includes("alpha session"))?.includes(BG_OPEN) ?? false;
	dash.handleInput("\x1b");

	// peek: space in list mode opens the peek header (must stay unhighlighted).
	const peekDash = makeDash();
	peekDash.handleInput(" ");
	const peekHasNoOpener = !peekDash.render(160).some((line) => line.includes(BG_OPEN));

	// ultra-narrow: width 23 with indent 4 overflows (4 + max(20, 19) = 24 > 23).
	const narrowLines = dash.render(23);
	const narrowMaxWidth = Math.max(...narrowLines.map((line) => visibleWidth(line)));
	const narrowLeaked = narrowLines.some((line) => !line.includes("alpha session") && line.includes(BG_OPEN));

	// D4: unselected rows keep `muted`, never `dim`, for name/summary.
	const unselectedUsesMuted = fgCalls.some(([token, text]) => token === "muted" && text.includes("beta session"));
	const unselectedNameIsDim = fgCalls.some(([token, text]) => token === "dim" && text.includes("beta session"));
```

Then replace the `console.log(JSON.stringify({ ok: true, unit: {...} }))` with:

```ts
	console.log(
		JSON.stringify({
			ok: true,
			unit: {
				unselectedIdentical: untouched === identity && callsAfterUnselected === 0,
				selectedWrapped: wrapped === `${BG_OPEN}${identity}${BG_CLOSE}`,
				themeCallCount: bgCallsBeforeIntegration,
			},
			integration: {
				selectedStartsAtCol0,
				selectedWidth,
				unselectedHasNoOpener,
				selectedHasArrow,
				unselectedHasNoArrow,
				firstFrameBgCalls,
				selectMarkerPresent,
				selectHasBg,
				peekHasNoOpener,
				narrowMaxWidth,
				narrowLeaked,
				unselectedUsesMuted,
				unselectedNameIsDim,
			},
		}),
	);
```

where `bgCallsBeforeIntegration` is captured right after the unit section (`const bgCallsBeforeIntegration = bgCalls;`).

Add to `test/dashboard-selection.test.mjs`:

```js
test("renderRow paints the selected row from column 0 through the padded right edge (issue #231)", () => {
	const parsed = runHarness();
	const it = parsed.integration;
	assert.equal(it.selectedStartsAtCol0, true, "bg must open before the folder indent");
	assert.equal(it.selectedWidth, 160, "bg span must reach the padded right edge");
	assert.equal(it.unselectedHasNoOpener, true, "unselected rows must have no bg");
	assert.equal(it.selectedHasArrow, true, "the › cursor marker stays on the selected row");
	assert.equal(it.unselectedHasNoArrow, true, "no › on unselected rows");
	assert.equal(it.firstFrameBgCalls, 1, "exactly one row is painted per frame");
});

test("selected-row highlight coexists with select mode, peek, and narrow terminals (issue #231)", () => {
	const parsed = runHarness();
	const it = parsed.integration;
	assert.equal(it.selectMarkerPresent, true, "select mode's ◉ batch marker survives");
	assert.equal(it.selectHasBg, true, "select mode keeps the row highlight");
	assert.equal(it.peekHasNoOpener, true, "peek header is not highlighted");
	assert.ok(it.narrowMaxWidth <= 23, "no line may exceed the requested width");
	assert.equal(it.narrowLeaked, false, "narrow clipping must not leak bg into other rows");
});

test("unselected rows keep muted name/summary, not dim (issue #231 decision D4)", () => {
	const parsed = runHarness();
	assert.equal(parsed.integration.unselectedUsesMuted, true);
	assert.equal(parsed.integration.unselectedNameIsDim, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/dashboard-selection.test.mjs`
Expected: FAIL — `selectedStartsAtCol0` is false (no bg is emitted yet) and `firstFrameBgCalls` is 0.

- [ ] **Step 3: Wire `applyRowHighlight` into `renderRow`**

Replace the last return of `renderRow` (`src/ui/dashboard.ts:1481-1483`):

```ts
		line = padTo(line, contentWidth - visibleWidth(ageRaw));
		line += t.fg("dim", ageRaw);
		const body = clip(line, contentWidth);
		const painted = applyRowHighlight(t, selected, `${" ".repeat(indent)}${body}`);
		return clip(painted, width);
```

Add the identity `bg` stub to each pre-existing harness theme literal, e.g.:

```ts
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, italic: (t: string) => t, strikethrough: (t: string) => t, bg: (_c: string, t: string) => t };
```

Apply the same one-line addition to the nine files listed in **Files** above (grep `fg: (` in `test-support/*.ts` to find each literal).

- [ ] **Step 4: Run the focused tests, then the full suite**

Run: `node --test test/dashboard-selection.test.mjs`
Expected: PASS (4 tests).

Run: `node --test test/dashboard-*.test.mjs test/ui-smoke.test.mjs`
Expected: PASS — this is where a missed `bg` stub would surface as `theme.bg is not a function`.

Run: `npm test`
Expected: PASS (no new failures; pre-existing environment failures, if any, must be identical to a clean `git stash` baseline).

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard.ts test/dashboard-selection.test.mjs test-support/dashboard-selection-render.ts \
  test-support/dashboard-delete-key-probe.ts test-support/cwd-browse-tab-probe.ts \
  test-support/dashboard-shrink-render.ts test-support/dashboard-refs-render.ts \
  test-support/dashboard-prewarm-smoke.ts test-support/navigation-wrap.ts \
  test-support/hold-key-wrap.ts test-support/ui-smoke.ts test-support/attach-delete-flow-probe.ts
git commit -m "feat(ui): paint the selected board row with selectedBg (issue #231)"
```

---

### Task 3: Full verification gate

**Files:**
- No source changes expected. If `npm run verify` fails, fix in the owning file from Task 1/2 and amend the Task 2 commit rather than adding a new fixup commit.

**Interfaces:**
- Consumes: both earlier tasks.
- Produces: a branch whose `npm run verify` is green.

- [ ] **Step 1: Run the repo gate**

Run: `npm run verify`
Expected: `typecheck` clean, `test:perf` 3 passed, `npm test` green, `test:coverage` above lines 85 / funcs 80 / branches 70, `pack:dry` lists `src/ui/dashboard.ts`.

- [ ] **Step 2: Confirm the packed tarball still ships the touched file**

Run: `npm pack --dry-run 2>&1 | grep -E "src/ui/dashboard.ts|test-support"`
Expected: `src/ui/dashboard.ts` present; `test-support/` absent (it is not in `files`).

- [ ] **Step 3: Record the manual-check handoff**

Write the U1–U5 steps from the spec into the PR description (they need a live pi session and cannot run in CI). Do not claim them as passed.

- [ ] **Step 4: Commit any gate fixes (only if needed)**

```bash
git add -A -- src test test-support
git commit -m "test(ui): keep the selection harness green under the full gate (issue #231)"
```

---

## Self-Review

- **Spec coverage:** D1 → Task 1 + Task 2 A1/A2; D2 → A10 (Task 2); D3 → A3 (Task 2); D4 → A11 (Task 2). A1–A4, A6–A8, A10, A11 → Task 2; A5 → Task 1 (unit call count) + Task 2 (per-frame count); A9 → Task 3; U1–U5 → PR handoff (Task 3 Step 3). No spec requirement is unassigned.
- **Step scan:** each step names one file and one checkable result; no "handle edge cases" placeholders.
- **Type consistency:** `applyRowHighlight(theme, selected, text)` is defined and consumed with the same three parameters in both tasks; `BG_OPEN`/`BG_CLOSE` and the JSON field names used by the `.mjs` assertions match the harness emission.
- **Review Focus:** each of the five lines has an owning assertion (A8, A5-zero, A3, A6, A7/A5) in Task 2, plus U5 in the PR handoff.
- **Proportion:** the plan is shorter than the spec and contains only signatures, assertions and the one-line stub shape.
