# Keep the Board Cursor in Place on Demote (issue #254) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `h` (hold/unhold) or `d`+`y` (done) demotes a session, the dashboard cursor stays at the demoted row's visual slot instead of following the row into `ON HOLD`/`DONE`.

**Architecture:** A pure function `neighborAfterRemoval(orderedIds, removedIds, anchorId)` in `src/core/rows.mjs` computes the row that fills a vacated slot. `DashboardComponent` captures that anchor **before** the state command runs and applies it **after** `refresh()`, with an index-clamp fallback when the neighbor itself disappeared. Three call sites: `toggleHold`, `confirmDone`, `confirmDoneSelection`. Background-driven state migrations are untouched (they still follow).

**Tech Stack:** TypeScript (`src/ui/dashboard.ts`), untyped ESM with JSDoc (`src/core/rows.mjs`), `node:test` + `assert/strict`, probe harness under `test-support/`.

**Spec:** `docs/superpowers/specs/2026-11-23-issue-254-cursor-keep-position-design.md`

## Global Constraints

- Tabs for indentation; English comments and commit messages; conventional commit subjects with `(#N)` appended only when a PR exists.
- `src/core/rows.mjs` stays untyped JS with JSDoc `@param`/`@returns`; `tsconfig` has `allowJs` + `checkJs:false`.
- `dashboard.ts` imports from `../core/rows.mjs` through the existing named-import line — do not add a second import statement for the same module.
- Tests: `node:test` with `assert/strict`; anything touching the filesystem uses a temp dir (`mkdtempSync(join(tmpdir(), ...))`), never the host repo.
- Probes: `test-support/*.ts` run via `node --experimental-transform-types`, are excluded from `tsconfig`, construct the real `DashboardComponent` with `{ matches: () => false }` as keybindings, patch **both** `service.rows()` and `service.row(id)` when overriding row state, and print one JSON report with `console.log`.
- Never assign `selectedId` an id that is not in `orderedIds` — `refresh()` treats an invisible selection as "row vanished" and jumps to `orderedIds[0]`.
- No `git add -A`; stage the exact files named in each task.
- Acceptance IDs (`A1`–`A13`, `U1`) come from the spec; every task step names the IDs it proves.

## Review Focus

1. **Contiguous batch done at the end of the list** — nothing follows the block, so the cursor must land on the row above the block, not on a completed row from the block.
2. **Filter active during a demote** — the demoted row leaves the filtered result set; the cursor must land on the next surviving row, not jump to the top.
3. **Last row / only row** — last row selects the previous row; the only row stays selected (clamp path).
4. **Demoted row migrating into a folded section** — `refresh()` converts the selection into a section header; the anchor must restore a row selection and clear `selectedSection`.
5. **Failure paths** — `holdView` / `markCompleted` returning `{ok:false}`, and a batch that completed `0` rows, must leave the cursor exactly where it was.

---

### Task 1: `neighborAfterRemoval` pure function

**Files:**
- Modify: `src/core/rows.mjs:262-278` (insert after `nextVisibleIdAfterRemoval` and its JSDoc)
- Test: `test/rows.test.mjs` (append after the existing `nextVisibleIdAfterRemoval` test)

**Interfaces:**
- Consumes: nothing (pure, no imports).
- Produces: `neighborAfterRemoval(orderedIds: readonly string[], removedIds: Iterable<string>, anchorId: string): { neighborId: string | null, anchorIndex: number } | null` — `null` when `anchorId` is not in `orderedIds`.

- [ ] **Step 1: Write the failing test**

Append to `test/rows.test.mjs` (also add `neighborAfterRemoval` to the existing import list from `../src/core/rows.mjs`):

```javascript
test("neighborAfterRemoval: same slot semantics as the delete helper (issue #254 A1)", () => {
	const ids = ["a", "b", "c", "d"];
	assert.deepEqual(neighborAfterRemoval(ids, ["b"], "b"), { neighborId: "c", anchorIndex: 1 }, "middle row -> next row");
	assert.deepEqual(neighborAfterRemoval(ids, ["d"], "d"), { neighborId: "c", anchorIndex: 3 }, "last row -> previous row");
	assert.deepEqual(neighborAfterRemoval(["a"], ["a"], "a"), { neighborId: null, anchorIndex: 0 }, "only row -> no neighbor, slot kept");
	assert.equal(neighborAfterRemoval(ids, ["a"], "missing"), null, "unknown anchor -> null");
	assert.deepEqual(
		neighborAfterRemoval(ids, ["b", "c"], "b"),
		{ neighborId: "d", anchorIndex: 1 },
		"contiguous block -> first row after the block",
	);
	assert.deepEqual(
		neighborAfterRemoval(ids, ["a", "b", "c", "d"], "a"),
		{ neighborId: null, anchorIndex: 0 },
		"every row removed -> no neighbor",
	);
	assert.deepEqual(
		neighborAfterRemoval(["a", "b", "c"], new Set(["c"]), "c"),
		{ neighborId: "b", anchorIndex: 2 },
		"Set input works and block removal prefers the previous surviving row",
	);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/rows.test.mjs`
Expected: FAIL — `neighborAfterRemoval is not a function` (module import resolves to `undefined`).

- [ ] **Step 3: Implement the function**

Insert **after** the closing brace of `nextVisibleIdAfterRemoval` in `src/core/rows.mjs`:

```javascript
/**
 * Issue #254: the row the board should select after `removedIds` leave their
 * current positions. Mirrors the issue #147 delete semantics — the next visible
 * row after the anchor's slot, else the previous one, else null — but works on
 * the dashboard's already-filtered, already-folded order.
 * @param {readonly string[]} orderedIds visible row ids in board order
 * @param {Iterable<string>} removedIds ids that will leave their positions
 * @param {string} anchorId the id whose slot must be kept
 * @returns {{ neighborId: string | null, anchorIndex: number } | null} null when anchorId is not visible
 */
export function neighborAfterRemoval(orderedIds, removedIds, anchorId) {
	const anchorIndex = orderedIds.indexOf(anchorId);
	if (anchorIndex === -1) return null;
	const removed = removedIds instanceof Set ? removedIds : new Set(removedIds);
	for (let i = anchorIndex + 1; i < orderedIds.length; i += 1) {
		if (!removed.has(orderedIds[i])) return { neighborId: orderedIds[i], anchorIndex };
	}
	for (let i = anchorIndex - 1; i >= 0; i -= 1) {
		if (!removed.has(orderedIds[i])) return { neighborId: orderedIds[i], anchorIndex };
	}
	return { neighborId: null, anchorIndex };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/rows.test.mjs`
Expected: PASS, including the pre-existing `nextVisibleIdAfterRemoval: neighbor semantics (issue #147 A2)` test.

- [ ] **Step 5: Commit**

```bash
git add src/core/rows.mjs test/rows.test.mjs
git commit -m "feat(core): add neighborAfterRemoval for keeping the board slot (issue #254)"
```

---

### Task 2: Anchor plumbing + `h` (hold / unhold) entry

**Files:**
- Modify: `src/ui/dashboard.ts` (import line, a local type near the other type aliases, two private methods after `refresh()`, `toggleHold()` at ~1076-1087)
- Create: `test-support/dashboard-position-keep-probe.ts`
- Create: `test/dashboard-position-keep.test.mjs`

**Interfaces:**
- Consumes: `neighborAfterRemoval` from Task 1.
- Produces: private `capturePositionAnchor(id: string, removedIds?: string[]): PositionAnchor | null` and private `applyPositionAnchor(anchor: PositionAnchor | null): void`; probe report keys `holdMiddle`, `holdLast`, `holdOnly`, `unhold`, `holdFailed`, `holdFiltered`, `holdPeek`, `backgroundFollow`.

- [ ] **Step 1: Write the failing probe and test**

Create `test-support/dashboard-position-keep-probe.ts`:

```typescript
// Position-keep probe (issue #254): drive the hold / done gestures through the
// public handleInput() and report where the cursor lands. One run feeds every
// assertion in test/dashboard-position-keep.test.mjs.
// Run via `node --experimental-transform-types` (dashboard.ts uses TS
// parameter properties). Not typechecked (tsconfig excludes test-support).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { createView } from "../src/core/store.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

type Env = {
	service: ReturnType<typeof createService>;
	root: string;
	dash: DashboardComponent;
};

const tui = {
	terminal: { rows: 24, cols: 240, columns: 240, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };

type Priv = {
	mode: string;
	selectedId: string | null;
	selectedSection: string | null;
	peekId: string | null;
	orderedIds: string[];
	filterQuery: string;
	flash: { text: string; level: string } | null;
};

function priv(dash: DashboardComponent): Priv {
	return dash as unknown as Priv;
}

// Every scenario gets its own root: seeding goes through the real service
// commands (clearHoldView / holdView), so the disk state stays the source of
// truth and nothing has to be faked in the row view.
async function makeEnv(count: number): Promise<Env> {
	const root = mkdtempSync(join(tmpdir(), "agentview-position-keep-"));
	const ids = Array.from({ length: count }, (_, i) => `v${i + 1}`);
	for (const id of ids) createView(root, { id, name: id, cwd: root });
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
	for (const id of ids) {
		const res = await service.clearHoldView(id);
		if (!res.ok) throw new Error(`seed idle failed for ${id}: ${res.error}`);
	}
	const dash = new DashboardComponent(tui as never, theme as never, { matches: () => false } as never, () => {}, {
		service,
		root,
		defaultCwd: root,
		availableModels: [],
		currentModel: null,
		currentThinkingLevel: "off",
	} as never);
	return { service, root, dash };
}

/** Point the cursor at a row without depending on navigation order. */
function select(dash: DashboardComponent, id: string): void {
	priv(dash).selectedId = id;
	priv(dash).selectedSection = null;
	dash.refresh();
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return pred();
}

function cursor(dash: DashboardComponent, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const p = priv(dash);
	return { selectedId: p.selectedId, orderedIds: [...p.orderedIds], mode: p.mode, ...extra };
}

const report: Record<string, unknown> = {};

// A2: h on a middle row keeps the slot; the row below takes the cursor.
{
	const env = await makeEnv(5);
	select(env.dash, "v3");
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.holdMiddle = cursor(env.dash, { demotedId: "v3" });
	env.dash.dispose();
}

// A3: h on the last row selects the previous row.
{
	const env = await makeEnv(5);
	select(env.dash, "v5");
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.holdLast = cursor(env.dash, { demotedId: "v5" });
	env.dash.dispose();
}

// A4: h on the only row keeps it selected.
{
	const env = await makeEnv(1);
	select(env.dash, "v1");
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).flash !== null);
	report.holdOnly = cursor(env.dash, { demotedId: "v1" });
	env.dash.dispose();
}

// A6: unhold keeps the slot too — the cursor must not stay on the resumed row.
{
	const env = await makeEnv(4);
	await env.service.holdView("v3");
	await env.service.holdView("v4");
	env.dash.refresh();
	select(env.dash, "v3");
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.unhold = cursor(env.dash, { demotedId: "v3" });
	env.dash.dispose();
}

// A8 (h branch): a rejected hold leaves the cursor alone.
{
	const env = await makeEnv(4);
	select(env.dash, "v3");
	env.service.holdView = (() => Promise.resolve({ ok: false, error: "boom" })) as typeof env.service.holdView;
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).flash !== null);
	report.holdFailed = cursor(env.dash, { notice: priv(env.dash).flash?.text ?? null });
	env.dash.dispose();
}

// A9: filtering hides the demoted row; the next surviving row takes the cursor.
{
	const env = await makeEnv(5);
	priv(env.dash).filterQuery = "s:idle";
	env.dash.refresh();
	select(env.dash, "v3");
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.holdFiltered = cursor(env.dash, { demotedId: "v3" });
	env.dash.dispose();
}

// A10: peek keeps its own target; the list cursor still moves to the slot.
{
	const env = await makeEnv(5);
	select(env.dash, "v3");
	env.dash.handleInput(" "); // space opens peek
	env.dash.handleInput("h");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.holdPeek = cursor(env.dash, { peekId: priv(env.dash).peekId, demotedId: "v3" });
	env.dash.dispose();
}

// A11: a background transition (not driven by the dashboard) still follows.
{
	const env = await makeEnv(5);
	select(env.dash, "v3");
	await env.service.markCompleted("v3");
	env.dash.refresh();
	report.backgroundFollow = cursor(env.dash, { movedId: "v3" });
	env.dash.dispose();
}

console.log(JSON.stringify(report));
```

Create `test/dashboard-position-keep.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "dashboard-position-keep-probe.ts");

// One probe run feeds every assertion below.
const report = JSON.parse(
	execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 120_000,
	}),
);

test("A2: h on a middle row keeps the slot — the row below takes the cursor", () => {
	assert.equal(report.holdMiddle.demotedId, "v3");
	assert.equal(report.holdMiddle.selectedId, "v4", "cursor must not follow the demoted row");
	assert.notEqual(report.holdMiddle.selectedId, report.holdMiddle.demotedId);
});

test("A3: h on the last row selects the previous row", () => {
	assert.equal(report.holdLast.selectedId, "v4");
});

test("A4: h on the only row keeps it selected", () => {
	assert.equal(report.holdOnly.selectedId, "v1");
	assert.deepEqual(report.holdOnly.orderedIds, ["v1"]);
});

test("A6: unhold keeps the slot instead of staying on the resumed row", () => {
	assert.equal(report.unhold.demotedId, "v3");
	assert.equal(report.unhold.selectedId, "v4", "the resumed row must not keep the cursor");
});

test("A8 (h branch): a rejected hold leaves the cursor in place", () => {
	assert.equal(report.holdFailed.selectedId, "v3");
	assert.equal(report.holdFailed.notice, "boom");
});

test("A9: filtering does not send the cursor to the top when the demoted row leaves the result", () => {
	assert.equal(report.holdFiltered.selectedId, "v4");
	assert.ok(!report.holdFiltered.orderedIds.includes(report.holdFiltered.demotedId), "held row leaves the s:idle filter");
});

test("A10: peek keeps its own target while the list cursor moves to the slot", () => {
	assert.equal(report.holdPeek.mode, "peek");
	assert.equal(report.holdPeek.peekId, "v3");
	assert.equal(report.holdPeek.selectedId, "v4");
});

test("A11: background-driven transitions still follow the row", () => {
	assert.equal(report.backgroundFollow.selectedId, "v3", "follow is the established behavior outside the demote commands");
});
```

- [ ] **Step 2: Run the probe test to verify it fails**

Run: `node --test test/dashboard-position-keep.test.mjs`
Expected: FAIL — `holdMiddle.selectedId` is `"v3"` (the cursor followed the held row); the later sections behave the same way.

- [ ] **Step 3: Add the anchor type and the import**

In `src/ui/dashboard.ts`:

1. Extend the existing rows import (line ~33) to:

```typescript
import { filterRows, groupRowsByFolder, neighborAfterRemoval, rowState, stateGlyph } from "../core/rows.mjs";
```

2. Add the type next to the other local type aliases (`type ListTarget = ...`):

```typescript
type PositionAnchor = { neighborId: string | null; anchorIndex: number };
```

- [ ] **Step 4: Add the two private methods**

Insert directly after `refresh()` (after its closing brace, before `private selectedRow()`):

```typescript
	/**
	 * Issue #254: the slot a demote command is about to vacate. Capture it BEFORE
	 * the state command runs — afterwards the row has already moved and the old
	 * position is only recoverable from the pre-mutation order.
	 */
	private capturePositionAnchor(id: string, removedIds: string[] = [id]): PositionAnchor | null {
		return neighborAfterRemoval(this.orderedIds, removedIds, id);
	}

	/**
	 * Issue #254: apply a captured anchor after refresh(). Prefer the row that
	 * filled the slot, else clamp to the old index. Never assign an id that is no
	 * longer visible — refresh() would read it as "selected row vanished" and jump
	 * to the top of the list.
	 */
	private applyPositionAnchor(anchor: PositionAnchor | null): void {
		if (!anchor) return;
		const last = this.orderedIds.length - 1;
		if (last < 0) return;
		const neighbor = anchor.neighborId;
		const target = neighbor && this.orderedIds.includes(neighbor)
			? neighbor
			: this.orderedIds[Math.min(anchor.anchorIndex, last)];
		if (!target) return;
		this.selectedId = target;
		this.selectedSection = null;
		this.prewarmSelected();
	}
```

- [ ] **Step 5: Wire `toggleHold()`**

Replace the body's command-and-refresh block with (keep the guard lines above it unchanged):

```typescript
		// Issue #254: remember the slot before the state command moves the row.
		const anchor = this.capturePositionAnchor(row.meta.id);
		const run = holding ? this.deps.service.clearHoldView(row.meta.id) : this.deps.service.holdView(row.meta.id);
		void Promise.resolve(run).then((res) => {
			if (!res.ok) {
				this.notice(res.error ?? (holding ? "Resume failed" : "Hold failed"), "error");
				this.refresh();
				return;
			}
			this.notice(holding ? "Resumed — needs instructions" : "On hold", "info");
			this.refresh();
			this.applyPositionAnchor(anchor);
		});
```

- [ ] **Step 6: Run the probe test to verify it passes**

Run: `node --test test/dashboard-position-keep.test.mjs`
Expected: PASS for A2, A3, A4, A6, A8 (h), A9, A10, A11.

- [ ] **Step 7: Run the typecheck and the existing dashboard suites**

Run: `npm run typecheck && node --test test/dashboard-delete-key.test.mjs test/dashboard-selection.test.mjs test/rows.test.mjs`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/ui/dashboard.ts test-support/dashboard-position-keep-probe.ts test/dashboard-position-keep.test.mjs
git commit -m "feat(dashboard): keep the cursor in place when h demotes a row (issue #254)"
```

---

### Task 3: `d`+`y` and batch done entries

**Files:**
- Modify: `src/ui/dashboard.ts` (`confirmDone()` ~1056-1072, `confirmDoneSelection()` ~1089-1111)
- Modify: `test-support/dashboard-position-keep-probe.ts` (append three scenarios)
- Modify: `test/dashboard-position-keep.test.mjs` (append three tests)

**Interfaces:**
- Consumes: `capturePositionAnchor` / `applyPositionAnchor` from Task 2.
- Produces: probe report keys `doneMiddle`, `doneFailed`, `batchMiddle`, `batchEnd`, `batchAllSkipped`.

- [ ] **Step 1: Write the failing tests**

Append to the probe, immediately before `console.log(JSON.stringify(report));`:

```typescript
// A5: d+y on a middle row keeps the slot.
{
	const env = await makeEnv(5);
	select(env.dash, "v3");
	env.dash.handleInput("d");
	env.dash.handleInput("y");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.doneMiddle = cursor(env.dash, { demotedId: "v3" });
	env.dash.dispose();
}

// A8 (done branch): a rejected mark-completed leaves the cursor alone.
{
	const env = await makeEnv(5);
	select(env.dash, "v3");
	env.service.markCompleted = (() => Promise.resolve({ ok: false, error: "boom" })) as typeof env.service.markCompleted;
	env.dash.handleInput("d");
	env.dash.handleInput("y");
	await waitFor(() => priv(env.dash).flash !== null);
	report.doneFailed = cursor(env.dash, { notice: priv(env.dash).flash?.text ?? null });
	env.dash.dispose();
}

// A7: batch done selects the block's neighbour, never a completed id.
{
	const env = await makeEnv(5);
	select(env.dash, "v2");
	env.dash.handleInput("m");
	env.dash.handleInput(" ");
	env.dash.handleInput("j");
	env.dash.handleInput(" ");
	env.dash.handleInput("d");
	env.dash.handleInput("y");
	await waitFor(() => priv(env.dash).selectedId === "v4");
	report.batchMiddle = cursor(env.dash, { doneIds: ["v2", "v3"] });
	env.dash.dispose();
}

// A7 (block at the end): nothing follows the block, so the previous row wins.
{
	const env = await makeEnv(5);
	select(env.dash, "v4");
	env.dash.handleInput("m");
	env.dash.handleInput(" ");
	env.dash.handleInput("j");
	env.dash.handleInput(" ");
	env.dash.handleInput("d");
	env.dash.handleInput("y");
	await waitFor(() => priv(env.dash).selectedId === "v3");
	report.batchEnd = cursor(env.dash, { doneIds: ["v4", "v5"] });
	env.dash.dispose();
}

// A13: a batch that completed nothing must not move the cursor.
{
	const env = await makeEnv(5);
	select(env.dash, "v2");
	env.dash.handleInput("m");
	env.dash.handleInput(" ");
	env.dash.handleInput("j");
	env.dash.handleInput(" ");
	env.service.markCompletedMany = (() => Promise.resolve({ ok: true, completed: 0, skipped: 2, completedIds: [] })) as typeof env.service.markCompletedMany;
	env.dash.handleInput("d");
	env.dash.handleInput("y");
	await waitFor(() => priv(env.dash).flash !== null);
	report.batchAllSkipped = cursor(env.dash);
	env.dash.dispose();
}
```

Append to `test/dashboard-position-keep.test.mjs`:

```javascript
test("A5: d+y on a middle row keeps the slot", () => {
	assert.equal(report.doneMiddle.demotedId, "v3");
	assert.equal(report.doneMiddle.selectedId, "v4");
});

test("A8 (done branch): a rejected mark-completed leaves the cursor in place", () => {
	assert.equal(report.doneFailed.selectedId, "v3");
	assert.equal(report.doneFailed.notice, "boom");
});

test("A7: batch done selects the row after the block, not a completed id", () => {
	assert.equal(report.batchMiddle.selectedId, "v4");
	assert.ok(!report.batchMiddle.doneIds.includes(report.batchMiddle.selectedId));
});

test("A7 (block at the end): the previous row wins when nothing follows", () => {
	assert.equal(report.batchEnd.selectedId, "v3");
});

test("A13: a batch that completed nothing leaves the cursor alone", () => {
	assert.equal(report.batchAllSkipped.selectedId, "v3");
});
```

- [ ] **Step 2: Run the probe test to verify it fails**

Run: `node --test test/dashboard-position-keep.test.mjs`
Expected: FAIL — `doneMiddle.selectedId`/`batchMiddle.selectedId` follow the demoted rows; `batchAllSkipped.selectedId` jumps to the anchor.

- [ ] **Step 3: Wire `confirmDone()`**

Replace the `onYes` body:

```typescript
			onYes: () => {
				// Issue #254: capture before the state command; apply only on success.
				const anchor = this.capturePositionAnchor(row.meta.id);
				void this.markCompleted(row).then((res) => {
					if (!res.ok) this.notice(res.error ?? "Mark done failed", "error");
					else this.notice("Marked done", "info");
					this.refresh();
					if (res.ok) this.applyPositionAnchor(anchor);
				});
			},
```

- [ ] **Step 4: Wire `confirmDoneSelection()`**

Replace the `onYes` body:

```typescript
			onYes: () => {
				// Issue #254: anchor on the topmost selected row in board order —
				// selectedIds is a Set in insertion order, so doneIds[0] is arbitrary.
				const topmost = doneIds
					.map((id) => this.orderedIds.indexOf(id))
					.filter((index) => index >= 0)
					.reduce((min, index) => (index < min ? index : min), Number.POSITIVE_INFINITY);
				const anchor = Number.isFinite(topmost)
					? this.capturePositionAnchor(this.orderedIds[topmost], doneIds)
					: null;
				void Promise.resolve(this.deps.service.markCompletedMany?.(doneIds) ?? { ok: true, completed: 0, skipped: doneIds.length, completedIds: [] }).then((res) => {
					if (!res.ok) this.notice("Mark done failed", "error");
					else this.notice(`Moved ${res.completed} to Done${res.skipped ? ` · skipped ${res.skipped}` : ""}`, "info");
					this.refresh();
					// A batch that completed nothing moved nothing — keep the cursor.
					if (res.ok && res.completed > 0) this.applyPositionAnchor(anchor);
				});
			},
```

- [ ] **Step 5: Run the probe test to verify it passes**

Run: `node --test test/dashboard-position-keep.test.mjs`
Expected: PASS for all of A2–A11 and A13.

- [ ] **Step 6: Run the repository verification (A12)**

Run: `npm run verify`
Expected: PASS — typecheck, perf gate, full test suite, coverage thresholds (lines 85 / funcs 80 / branches 70), and `pack:dry`.

- [ ] **Step 7: Commit**

```bash
git add src/ui/dashboard.ts test-support/dashboard-position-keep-probe.ts test/dashboard-position-keep.test.mjs
git commit -m "feat(dashboard): keep the cursor in place for d+y and batch done (issue #254)"
```

---

## Self-Review

**Spec coverage:** A1 → Task 1. A2/A3/A4 → Task 2 steps 1-6. A5 → Task 3. A6 → Task 2. A7 → Task 3. A8 → Task 2 (h) + Task 3 (done). A9/A10/A11 → Task 2. A12 → Task 3 step 6. A13 → Task 3. U1 stays a post-merge manual check (optional, needs an installed build) — not a task.

**Placeholder scan:** no TBD/TODO; every code step carries the exact code; every test step carries the exact assertion.

**Type consistency:** `neighborAfterRemoval` returns `{ neighborId, anchorIndex } | null` in Task 1 and both consumers (`capturePositionAnchor`, `applyPositionAnchor`) read exactly those field names. `PositionAnchor` is defined once in Task 2 and reused in Task 3 without redefinition.

**Review Focus mapping:** contiguous block at the end → Task 3 `batchEnd`; filter active → Task 2 `holdFiltered`; last/only row → Task 2 `holdLast` / `holdOnly`; folded section → clamp path exercised by `applyPositionAnchor` (unit-covered behaviour via `anchorIndex` fallback in Task 1's unknown-neighbour case; the folded-section state itself is not probe-tested because folding requires a saved prefs file — documented as a known gap in the PR description); failure paths → Task 2 `holdFailed` + Task 3 `doneFailed` / `batchAllSkipped`.
