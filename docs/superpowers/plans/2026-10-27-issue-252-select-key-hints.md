# SELECT In-App Copy Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two in-app SELECT surfaces (`listHints()`'s SELECT case and the `?` overlay's `In select` row) name every binding `handleSelectKey` implements, add the missing `?` help row, and unify the `!` wording on "fix steps" across README + overlay (issue #252).

**Architecture:** Four string/row edits inside `src/ui/dashboard.ts` (`listHints()` tokens, two `renderHelp` rows, one new row), six README word swaps, and one added probe capture (`selectWide`) with one new `node:test` case. No handler logic, no new files, no render-pipeline change.

**Tech Stack:** TypeScript (runtime), `node --test` + `--experimental-transform-types` probe (test), Markdown (docs).

**Spec:** `docs/superpowers/specs/2026-10-27-issue-252-select-key-hints-design.md` (decisions D1–D5; convergence recorded in the issue's step-4 comments)

## Global Constraints

- Tabs for indentation in `.ts`; English comments and commit messages.
- **Do not touch handler logic**: `handleSelectKey` and every other mode handler stay byte-identical (spec D5).
- **Do not touch `renderPtyHelp`'s labels** (`Fix:` / `Suggested steps`) — D4 treats them as the canonical vocabulary.
- **Do not touch `#246`'s height handling**: no `fitToHeight` / `renderCenteredBox` changes; the help box simply grows from 32 to 33 lines (D3).
- Exact strings are part of the acceptance: the three in-app strings below are literal contract, not paraphrase.
- `npm run verify` must pass before the PR (AGENTS.md).
- Worktree discipline: every path under `/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-252-select-key-hints` (= `$WT`); git via `git -C $WT`. Branch `issue-252-select-key-hints`; commit subjects end with `(issue #252)` and, once known, the PR-number suffix `(#N)`.

## Review Focus

Conditions the spec implies but no single test step can cover; each is pinned where noted.

1. **The SELECT hint line is at its width budget.** 131 visible columns is the target (A3 allows ≤132). Adding a token without compressing another breaks A3 and pushes `m/esc cancel` out of view on a 120-column terminal. Pinned by Task 1, Step 2 (A3 assertion) and the exact token list in Step 4.
2. **`selectWide` must be captured with `rows = 40` and width 160.** At the probe's default 24 rows / 120 columns, `clip()` truncates the tail (the line is 131 columns), so A1 would fail for the wrong reason. Pinned by Task 1, Step 1.
3. **The new `?` row goes between the `/` row and the `!` row.** Row order controls what survives on short terminals: `fitToHeight` slices the tail, so rows near the bottom (the `In *` family) are the first to disappear. Keeping `?` mid-list means a 24-row terminal still shows it. Pinned by Task 1, Step 4 and Review Focus 3's manual check in Task 3.
4. **The `In select` row must fit the box without widening it past the 120-column cap.** It renders 101 columns (of the 114-column `width - 6` cap), so it stays visible at 120 columns; a longer row would be clipped there and A4 would fail. Pinned by Task 1, Step 2 (A4 regex runs against the 120-column overlay capture).
5. **README wording is not test-covered** (no test reads `README.md`). Task 2's `grep -c` counts are the only automated guard; the user test U1 covers the rest.

---

### Task 1: In-app surfaces (hint line + help overlay) with probe assertions

**Files:**
- Modify: `src/ui/dashboard.ts` — `listHints()` SELECT branch (currently lines 1348-1357), `renderHelp()` rows array (currently line 1723 `In select`, insert new row after line 1715 `/`)
- Modify: `test-support/vim-keys-wrap.ts` (capture after line 130; `out.copy` at line 146)
- Modify: `test/dashboard-vim-keys.test.mjs` (append one new `test(...)`)

**Interfaces:**
- Consumes: existing `render(width)` / `listHints()` / `renderHelp(width)`; the probe's white-box `dash.mode` handle and `tui.terminal.rows` handle already used at `vim-keys-wrap.ts:122-126`.
- Produces: probe field `out.copy.selectWide` (string) — the SELECT screen at 160 columns, consumed by Task 3's verification and by future key-copy assertions.

**Spec acceptance IDs:** A1, A2, A3, A4, A5, A6, A7 (Task 3 covers A8, A9).

- [ ] **Step 1: Add the failing probe capture**

In `test-support/vim-keys-wrap.ts`, immediately after `const selectRender = dash.render(120).join("\n");` (line 130) add:

```ts
// The SELECT hint line is >120 columns; render wider so the tail is observable.
tui.terminal.rows = 40;
const selectWide = dash.render(160).join("\n");
tui.terminal.rows = 24;
```

Then extend the single-line `out.copy` initializer (line 146) to include `selectWide`:

```ts
out.copy = { help120, listRender, selectRender, selectWide, sessionRender, evidenceRender, peekRender, help80Lines: help80.length };
```

- [ ] **Step 2: Add the failing test**

Append to `test/dashboard-vim-keys.test.mjs`:

```js
test("SELECT surfaces document every binding and the help overlay gains a ? row (issue #252)", () => {
	const out = JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", PROBE], { encoding: "utf8", timeout: 30_000 }));
	const { selectWide, help120 } = out.copy;
	// A1: the SELECT hint line names every binding, not just five.
	for (const token of ["↑↓/j/k move", "space toggle", "a all visible", "u clear", "d done", "ctrl+x delete", "m/esc cancel", "? help", "! pty"]) {
		assert.ok(selectWide.includes(token), `SELECT hint line must name ${token}`);
	}
	assert.match(selectWide, /· \? help · ! pty/);
	// A2: the stale wording is gone.
	assert.doesNotMatch(selectWide, /d move done/);
	assert.doesNotMatch(selectWide, /ctrl\+x delete done/);
	// A3: the line stays inside its width budget (131 columns today).
	const selectLine = selectWide.split("\n").find((line) => line.includes("[SELECT]"));
	assert.ok(selectLine, "SELECT hint line must be present");
	assert.ok(selectLine.trimEnd().length <= 132, `SELECT hint line grew to ${selectLine.trimEnd().length}`);
	// A4: the overlay's In select row catches up with the handler.
	assert.match(help120, /In select\s+↑↓\/j\/k move · space toggle · a all · u clear · d done · ctrl\+x delete · m\/esc cancel/);
	assert.doesNotMatch(help120, /a select all/);
	// A5: the overlay finally explains ?.
	assert.match(help120, /\?\s+Open the key help overlay \(list and multi-select\)/);
	// A6: one canonical ! wording in-app.
	assert.match(help120, /Open node-pty diagnostics and fix steps/);
	assert.doesNotMatch(help120, /repair hints/);
});
```

- [ ] **Step 3: Run it and confirm it fails for the right reasons**

Run: `node --test test/dashboard-vim-keys.test.mjs`
Expected: FAIL. A1 reports a missing token (the first is `d done`), A4/A5 fail, A6's `repair hints` negative already passes today. No TypeScript or probe crash.

- [ ] **Step 4: Implement the three in-app edits**

`src/ui/dashboard.ts`, `listHints()` SELECT branch — replace the token array so it reads exactly:

```ts
		if (this.mode === "select") {
			return this.hintLine("SELECT", "accent", [
				`${this.selectionCount()} selected`,
				...(unread > 0 ? [`•${unread} unread`] : []),
				"↑↓/j/k move",
				"space toggle",
				"a all visible",
				"u clear",
				"d done",
				"ctrl+x delete",
				"m/esc cancel",
				"? help",
				"! pty",
			]);
		}
```

In the same file, `renderHelp()` rows array: replace the `In select` row and insert the `?` row after the `/` row:

```ts
			["/", "Filter in normal mode; use i then / for slash commands"],
			["?", "Open the key help overlay (list and multi-select)"],
			["!", "Open node-pty diagnostics and fix steps"],
```

```ts
			["In select", "↑↓/j/k move · space toggle · a all · u clear · d done · ctrl+x delete · m/esc cancel"],
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test test/dashboard-vim-keys.test.mjs`
Expected: PASS, both the pre-existing `#229`/`#245` cases and the new `#252` case.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: green (perf gate is opt-in and stays skipped here).

- [ ] **Step 7: Commit**

```bash
git -C "$WT" add src/ui/dashboard.ts test-support/vim-keys-wrap.ts test/dashboard-vim-keys.test.mjs
git -C "$WT" commit -m "docs(ui): document every SELECT binding in hints and help; add the ? row (issue #252)"
```

---

### Task 2: README `!` wording

**Files:**
- Modify: `README.md` — lines 148, 166, 180, 200 (tables), 289, 368 (prose)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by code; the canonical wording decision (D4) lives here.

**Spec acceptance IDs:** A8.

- [ ] **Step 1: Swap the six occurrences**

```bash
grep -n 'repair hints' README.md
```

Expect exactly six lines: 148, 166, 180, 200 (`| \`!\` | Open node-pty diagnostics and repair hints. |`) and 289, 368 (prose). Replace `repair hints` with `fix steps` in all six; leave the surrounding sentence structure intact, so line 289 reads `Press \`!\` in the dashboard for diagnosis and fix steps.` and line 368 reads `… open the diagnostic panel and follow its fix steps.`

- [ ] **Step 2: Verify the counts**

Run: `grep -c 'repair hints' README.md` → expect `0` (and a non-zero exit status; that is expected here).
Run: `grep -c 'fix steps' README.md` → expect `6`.

- [ ] **Step 3: Commit**

```bash
git -C "$WT" add README.md
git -C "$WT" commit -m "docs: unify the ! panel wording on fix steps (issue #252)"
```

---

### Task 3: Verification gate (coordinator)

**Files:** none.

**Spec acceptance IDs:** A7 (re-run), A8 (re-check), A9, plus the U1 record.

- [ ] **Step 1: Full repository gate**

Run: `npm run verify` (from `$WT`)
Expected: typecheck, perf gate 3/3, full test suite, coverage thresholds (lines 85 / funcs 80 / branches 70), and `pack:dry` all pass.

- [ ] **Step 2: Re-check the README counts and the in-app strings**

Run: `grep -c 'repair hints' README.md` (0) and `grep -c 'fix steps' README.md` (6).
Run: `grep -n 'm/esc cancel' src/ui/dashboard.ts` → expect two hits (hint line + `In select` row).

- [ ] **Step 3: Record U1 as `pending`**

U1 needs the merged code loaded by a fresh pi session, so it cannot run before merge. Record it on the issue as `pending` with the spec's prerequisites (pull, checkout auto-discovery, restart pi) instead of claiming it passed.

- [ ] **Step 4: Manual width spot-check (Review Focus 3)**

Render the overlay at 24 rows and confirm the new `?` row is still visible while the `In *` rows are clipped — i.e. `?` sits above the cut line. A one-off probe script outside the repo is the cheapest way; do not commit it.
