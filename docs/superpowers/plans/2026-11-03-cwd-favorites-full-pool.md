# cwd Picker Full-History Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the launch-dialog cwd picker search the full ranked history instead of the top 8 entries (issue #262).

**Architecture:** Remove the pre-filter truncation at the dashboard wiring layer and make `rankedCwdCandidates` uncapped by default; the picker's pure state machine and the 6-row render window stay unchanged. A TS probe drives the real `handleInput()` path so the truncation regression is pinned at the layer that owned the bug.

**Tech Stack:** Node ESM `.mjs` core + TypeScript TUI (`src/ui/dashboard.ts`), `node:test` + `assert/strict`, Node `--experimental-transform-types` probes.

## Global Constraints

- `rankedCwdCandidates(root, limit = Number.POSITIVE_INFINITY)`: default returns every ranked entry; an explicit numeric `limit` still caps and still appends the home fallback afterwards (existing tests pass `limit = 2`, keep them green).
- `src/ui/dashboard.ts` `openLaunchPicker` loads the pool with `existingCwdCandidates(rankedCwdCandidates(this.deps.root))` — no `, 8` and no other hard-coded cap.
- Do not change `filterCwdCandidates`, `nextCwdPickerState`, `listDirectorySuggestions`, `browseTabCompletion`, `existingCwdCandidates`, the 6-row render window, or the ranking rule (count desc → lastUsed desc).
- Non-goals: symlink directory enumeration in browse mode, fuzzy matching, manual favorites, `cwd-stats.json` format changes.
- Tabs for indentation; English comments and commit subjects; conventional commit types.
- Tests use `node:test` + `assert/strict`; acceptance commands are `node --test <file>` and `npm run verify` (typecheck + perf gate + tests + coverage + pack:dry).
- Work from: `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-262-cwd-favorites-full-pool`

---

### Task 1: Uncapped ranked candidates (core)

**Files:**
- Modify: `src/core/cwd-stats.mjs:92-108`
- Test: `test/cwd-stats.test.mjs` (append after the existing `rankedCwdCandidates appends home with its real count when sliced out by limit` test)

**Interfaces:**
- Consumes: `readCwdStats(root)` (already returns all entries), `os.homedir()`.
- Produces: `rankedCwdCandidates(root, limit = Number.POSITIVE_INFINITY) -> Array<{path: string, count: number}>` — uncapped by default.

- [ ] **Step 1: Write the failing test**

Append to `test/cwd-stats.test.mjs`:

```js
test("rankedCwdCandidates defaults to the full history with no 8-entry cap (issue #262)", () => {
	const root = freshRoot();
	try {
		const dirs = Array.from({ length: 10 }, (_, i) => `/dir-${String(i + 1).padStart(2, "0")}`);
		writeViews(root, dirs.map((dir, i) => [`v${i}`, dir, 1000 - i]));
		seedCwdStatsFromViews(root);
		const ranked = rankedCwdCandidates(root);
		assert.deepEqual(
			ranked.slice(0, 10),
			dirs.map((dir) => ({ path: dir, count: 1 })),
		);
		assert.equal(ranked.length, 11);
		assert.deepEqual(ranked[10], { path: os.homedir(), count: 0 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cwd-stats.test.mjs`
Expected: the new test FAILS — `ranked.slice(0, 10)` has only 8 recorded dirs, then the home fallback at index 8 (`ranked.length` is 9, not 11).

- [ ] **Step 3: Change the default limit**

In `src/core/cwd-stats.mjs`, replace the function header and JSDoc:

```js
/**
 * Ranked candidates: count desc, then lastUsed desc; home appended at the
 * end when absent so the user's home dir is always one keystroke away.
 * `limit` is an optional cap for callers that explicitly want one; the
 * default returns the whole history so the launch picker can search it.
 * @param {string} root @param {number=} limit
 * @returns {Array<{path: string, count: number}>}
 */
export function rankedCwdCandidates(root, limit = Number.POSITIVE_INFINITY) {
```

Leave the body unchanged: `rows.slice(0, Math.max(1, limit))` already treats `Infinity` as "no cap".

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/cwd-stats.test.mjs`
Expected: PASS — all `cwd-stats` tests green, including the existing `limit = 2` cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/cwd-stats.mjs test/cwd-stats.test.mjs
git commit -m "fix(cwd): stop capping ranked cwd candidates at 8 (issue #262)"
```

---

### Task 2: Dashboard loads the full pool + picker regression probe

**Files:**
- Modify: `src/ui/dashboard.ts:755`
- Create: `test-support/cwd-favorites-pool-probe.ts`
- Create: `test/dashboard-cwd-favorites-pool.test.mjs`
- Test: `test/launch-options.test.mjs` (append)

**Interfaces:**
- Consumes: `rankedCwdCandidates(root)` (uncapped, Task 1), `existingCwdCandidates`, `nextCwdPickerState`, `DashboardComponent.openLaunchPicker`.
- Produces: no new production API; the dashboard now stores the full existing ranked history in `launch.cwdRanked`.

- [ ] **Step 1: Write the failing integration probe**

Create `test-support/cwd-favorites-pool-probe.ts`:

```ts
// cwd favorites-pool probe (issue #262): seed more favorites than the legacy
// 8-entry cap, then type a fragment of the lowest-ranked entry through the
// public handleInput() path and report the picker state as JSON.
// Run via `node --experimental-transform-types` (dashboard.ts uses TS
// parameter properties). Not typechecked (tsconfig excludes test-support).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/runtime/service.mjs";
import { DashboardComponent } from "../src/ui/dashboard.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-cwd-pool-"));
const entries: Record<string, { count: number; lastUsed: number }> = {};
for (let i = 1; i <= 9; i++) {
	const dir = join(root, `rank-${String(i).padStart(2, "0")}`);
	mkdirSync(dir, { recursive: true });
	entries[dir] = { count: 100 - i, lastUsed: 1000 - i };
}
const target = join(root, "work", "proj", "stability", "alert-automation");
mkdirSync(target, { recursive: true });
entries[target] = { count: 1, lastUsed: 1 };
writeFileSync(join(root, "cwd-stats.json"), JSON.stringify({ version: 1, entries }));

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
	terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };

const dash = new DashboardComponent(tui, theme, {}, () => {}, {
	service,
	root,
	defaultCwd: root,
	availableModels: [],
	currentModel: null,
	currentThinkingLevel: "off",
});

// TS-private is runtime-accessible; input must be non-empty or
// openLaunchDialog() bails back to list mode and launch stays null.
dash.input = "go";
dash.openLaunchDialog();
dash.openLaunchPicker("cwd", "");
for (const ch of "aler") dash.handleInput(ch);

const out = { target, mode: dash.launch?.cwdPickerMode, suggestions: dash.launch?.cwdSuggestions };
dash.dispose();
console.log(JSON.stringify(out));
```

Create `test/dashboard-cwd-favorites-pool.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "cwd-favorites-pool-probe.ts");

test("cwd picker: favorites search covers entries ranked below the old 8-entry cap (issue #262)", () => {
	// dashboard.ts uses TS parameter properties, which strip-only mode rejects;
	// --experimental-transform-types handles them (Node 22.7+ / 24).
	const out = execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const r = JSON.parse(out);
	assert.equal(r.mode, "favorites");
	assert.deepEqual(r.suggestions, [r.target]);
});
```

- [ ] **Step 2: Run the probe test to verify it fails**

Run: `node --test test/dashboard-cwd-favorites-pool.test.mjs`
Expected: FAIL — `mode` is `"browse"` and `suggestions` is `[]`, because `dashboard.ts:755` still passes `, 8` and the rank-10 target falls outside the pool.

- [ ] **Step 3: Load the full pool in the dashboard**

In `src/ui/dashboard.ts`, inside `openLaunchPicker`, replace:

```ts
				launch.cwdRanked = existingCwdCandidates(rankedCwdCandidates(this.deps.root, 8));
```

with:

```ts
				launch.cwdRanked = existingCwdCandidates(rankedCwdCandidates(this.deps.root));
```

- [ ] **Step 4: Run the probe test to verify it passes**

Run: `node --test test/dashboard-cwd-favorites-pool.test.mjs`
Expected: PASS — `mode === "favorites"` and `suggestions === [target]`.

- [ ] **Step 5: Pin the state-machine semantics for long lists**

Append to `test/launch-options.test.mjs`:

```js
test("nextCwdPickerState searches matches below the 8th ranked entry (issue #262)", () => {
	const bigRanked = Array.from({ length: 12 }, (_, i) => ({
		path: `/ranked/dir-${String(i + 1).padStart(2, "0")}`,
		count: 100 - i,
	}));
	const state = nextCwdPickerState("dir-10", bigRanked, "/tmp");
	assert.equal(state.mode, "favorites");
	assert.deepEqual(state.suggestions, [bigRanked[9].path]);
});
```

- [ ] **Step 6: Run the focused suites**

Run: `node --test test/cwd-stats.test.mjs test/launch-options.test.mjs test/dashboard-cwd-favorites-pool.test.mjs test/dashboard-cwd-tab.test.mjs`
Expected: PASS — new coverage plus the existing browse/favorites Tab regression (A4).

- [ ] **Step 7: Run the full gate**

Run: `npm run verify`
Expected: PASS — typecheck, perf gate, full test suite, coverage thresholds, pack:dry.

- [ ] **Step 8: Commit**

```bash
git add src/ui/dashboard.ts test-support/cwd-favorites-pool-probe.ts test/dashboard-cwd-favorites-pool.test.mjs test/launch-options.test.mjs
git commit -m "fix(cwd): search the full ranked history in the launch picker (issue #262)"
```

---

## Acceptance Traceability

| Spec ID | Plan task | Verification in this plan |
| --- | --- | --- |
| A1 | Task 1 | Step 1–4 (`node --test test/cwd-stats.test.mjs`) |
| A2 | Task 2 | Step 1–4 (`node --test test/dashboard-cwd-favorites-pool.test.mjs`) |
| A3 | Task 2 | Step 5 (`node --test test/launch-options.test.mjs`) |
| A4 | Task 2 | Step 6 (focused suites incl. `test/dashboard-cwd-tab.test.mjs`) |
| A5 | Task 2 | Step 7 (`npm run verify`) |
| A6 | Task 1 / Task 2 | Existing corrupt-stats, stale-filter and empty-pool tests re-run in Steps 4 and 6 |
| U1 | post-merge | Manual TUI run per spec §8 U1 (requires updated install copy; recorded as `pending` until executed) |
