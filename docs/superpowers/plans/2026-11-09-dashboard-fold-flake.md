# Dashboard-fold harness flake fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `test/dashboard-fold.test.mjs` immune to the trailing-age second flip between `render()` and `renderRows()` (issue #279), and add a deterministic regression leg that fails on the unfixed probe.

**Architecture:** Test-only change. (1) A `--import` preload module advances a fake clock +1000ms per `Date.now()` call, turning the CI-only flake into a deterministic red. (2) `frame()` in `test-support/dashboard-fold.ts` switches from full-string `includes` to the 20-column visible-prefix comparison already used by `dashboard-scroll.ts` / `dashboard-tui-modes.ts`, which excludes the trailing age column while still proving the selected target is visible in the windowed frame.

**Tech Stack:** node:test, execFileSync probe subprocesses, `--experimental-transform-types`, c8.

**Spec:** `docs/superpowers/specs/2026-11-09-dashboard-fold-flake-design.md` (acceptance IDs A1–A5, U1 quoted below).

## Global Constraints

- Test-only: the final diff must not touch `src/` (A3's temporary mutation is reverted before commit).
- Tabs for indentation; English comments and commit messages.
- New filenames kebab-case (`tick-clock.mjs`).
- Conventional commit subject for the final change: `test(dashboard): …issue #279`.
- The tick leg and the probe fix land in **one atomic commit** (a tick-leg-only commit would leave the suite red).
- Work from: `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-279-dashboard-fold-flake` (branch `issue-279-dashboard-fold-flake`, base `608a22a`). `node_modules` is symlinked from the main checkout — do not run `npm install`.

---

### Task 1: Deterministic red leg (tick-clock loader + test case)

**Files:**
- Create: `test-support/tick-clock.mjs`
- Modify: `test/dashboard-fold.test.mjs`

**Interfaces:**
- Consumes: existing `PROBE` constant and execFileSync pattern in `test/dashboard-fold.test.mjs`.
- Produces: `test-support/tick-clock.mjs` (side-effect-only preload, no exports) referenced by name in Task 2's verification and by spec A2.

- [ ] **Step 1: Write the loader**

Create `test-support/tick-clock.mjs` with exactly:

```js
// Issue #279: advance a fake clock by 1000ms on every Date.now() call, so any
// two render passes that read the clock independently land on different seconds
// (the CI flake condition, made deterministic). Side-effect-only preload module
// for `node --import`; exports nothing.
const base = Date.now();
let calls = 0;
Date.now = () => base + calls++ * 1000;
```

- [ ] **Step 2: Add the test case**

In `test/dashboard-fold.test.mjs`, append after the existing first test:

```js
test("folding stays deterministic when the clock advances between render passes", () => {
	const loader = fileURLToPath(new URL("../test-support/tick-clock.mjs", import.meta.url));
	const out = execFileSync(process.execPath, ["--experimental-transform-types", "--import", loader, PROBE], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(JSON.parse(out).ok, true);
});
```

(`fileURLToPath`, `execFileSync`, `process`, `assert`, `test`, `PROBE` are already imported/defined at the top of the file — no new imports.)

- [ ] **Step 3: Run the new case, verify it fails at the exact CI assertion**

Run: `node --test --test-name-pattern "clock advances" test/dashboard-fold.test.mjs`
Expected: FAIL — child probe aborts with `AssertionError: selected session/header must never be hidden by an indicator` at `frame (test-support/dashboard-fold.ts:56)`. Record the failure output verbatim for the PR body (spec A2's "can fail" evidence).

- [ ] **Step 4: Do NOT commit yet**

Task 1 and Task 2 form one atomic change; the commit happens in Task 2 Step 4.

### Task 2: Prefix-compare fix in the probe

**Files:**
- Modify: `test-support/dashboard-fold.ts:52-57` (the `frame` helper)

**Interfaces:**
- Consumes: nothing from Task 1 (independent edit; same atomic commit).
- Produces: a `frame()` whose visibility assertion compares 20-column visible prefixes (spec A1).

- [ ] **Step 1: Replace the full-string comparison**

In `test-support/dashboard-fold.ts`, replace the `frame` helper (currently at lines ~52-60) with:

```ts
	// Issue #279: a row's trailing age column flips whole seconds, so two render
	// passes can differ even with no state change. Compare the 20-column visible
	// prefix instead (same convention as dashboard-scroll.ts / dashboard-tui-modes.ts):
	// it still proves the selected target is visible in the windowed frame — a
	// scroll marker never shares a row's prefix.
	const visiblePrefix = (line: string) => line.trimEnd().slice(0, 20);
	const frame = (width = 120) => {
		const lines: string[] = dash.render(width);
		assert.equal(lines.length, tui.terminal.rows);
		assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
		if (dash.listTargets.length > 0) {
			const body: string[] = dash.renderRows(width).map(stripVTControlCharacters);
			const prefix = visiblePrefix(body[dash.selectedBodyLine]);
			assert.ok(lines.map(stripVTControlCharacters).some((line: string) => visiblePrefix(line) === prefix), "selected session/header must never be hidden by an indicator");
		}
		return lines.map(stripVTControlCharacters);
	};
```

(Tab indentation, matching the file. The `visiblePrefix` helper sits immediately above `frame`, at the same depth.)

- [ ] **Step 2: Run the whole file, verify green**

Run: `node --test test/dashboard-fold.test.mjs`
Expected: PASS, all cases including the new tick leg.

- [ ] **Step 3: Commit the atomic change**

```bash
git add test-support/tick-clock.mjs test-support/dashboard-fold.ts test/dashboard-fold.test.mjs
git commit -m "test(dashboard): keep dashboard-fold deterministic across second boundaries (issue #279)"
```

### Task 3: A3 mutation check (assertion still has teeth) — no commit

**Files:**
- Temporarily modify then revert: `src/ui/dashboard.ts` (`windowBody`, ~line 1846)

- [ ] **Step 1: Break the windowing guard**

In `src/ui/dashboard.ts`, inside `windowBody`, comment out the two clamp lines:

```ts
		// MUTATION (issue #279 A3, revert immediately): if (selLine < this.scrollTop + margin) this.scrollTop = selLine - margin;
		// MUTATION: if (selLine >= this.scrollTop + capacity - margin) this.scrollTop = selLine - capacity + margin + 1;
```

- [ ] **Step 2: Run the probe, verify the prefix assertion fails**

Run: `node --experimental-transform-types test-support/dashboard-fold.ts`
Expected: FAIL with `selected session/header must never be hidden by an indicator` (the selected row scrolls out of the window and no frame line shares its prefix). Record the output verbatim.

- [ ] **Step 3: Revert the mutation**

Run: `git checkout -- src/ui/dashboard.ts && git status --short`
Expected: clean (no `src/` changes).

### Task 4: Acceptance battery (A1 / A4 / A5) — no commit

- [ ] **Step 1: A1 stress — real-clock test file ×20**

Run: `for i in $(seq 1 20); do node --test test/dashboard-fold.test.mjs >/dev/null || { echo "fail run $i"; exit 1; }; done; echo 20/20`
Expected: `20/20`.

- [ ] **Step 2: A4 suite + threshold gate + probe-under-c8 stress**

Run: `npm test` (full suite) — expect pass.
Run: `npm run test:coverage` — expect pass, thresholds met.
Run: `for i in $(seq 1 20); do npx c8 --check-coverage=false node --experimental-transform-types test-support/dashboard-fold.ts >/dev/null || { echo "fail run $i"; exit 1; }; done; echo 20/20`
Expected: `20/20`.

- [ ] **Step 3: A5 full gate**

Run: `npm run verify`
Expected: typecheck + perf gate + tests + coverage + pack:dry all pass.

- [ ] **Step 4: Record evidence**

Paste the recorded outputs (Task 1 Step 3 red leg, Task 3 mutation red + revert, Task 4 loops) into the PR body under per-acceptance-ID headings.
