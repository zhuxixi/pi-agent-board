# Key-Hint Doc Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync three stale key hints with the bindings already implemented in `src/ui/dashboard.ts` (issue #245): the peek footer's key list, the README Peek/Transcript tables' missing `!`, and the README's undocumented multi-select keys.

**Architecture:** One string literal in `renderPeek` plus three README edits; one render assertion added to the existing `test-support/vim-keys-wrap.ts` probe so the peek footer cannot drift again. No handler logic, no new files, no new test infrastructure.

**Tech Stack:** TypeScript (runtime), `node --test` + `--experimental-transform-types` probe (test), Markdown (docs).

**Spec:** `docs/superpowers/specs/2026-10-26-issue-245-key-hints-doc-sync-design.md` (decisions D1–D5; spec §6 option **A** — multi-select gets its own 9-row table — confirmed by the user)

## Global Constraints

- Tabs for indentation in `.ts`; English comments and commit messages.
- **Do not touch any handler logic** (spec D5): no changes to `handleListKey` / `handleSelectKey` / `handlePeekKey` / `handleSessionKey` / `handleEvidenceKey`.
- **Do not touch the `?` help overlay or the NORMAL/SELECT hint lines** — they are already correct (spec D5).
- The multi-select table is **exactly 9 rows**, one per `handleSelectKey` binding, including `?` and `!` (spec D3, hardened by cross-review R1-D1).
- Do **not** add a `!` row to the Evidence table: `handleEvidenceKey` has no `!` binding (spec §7).
- `npm run verify` must pass before the PR (AGENTS.md).
- Worktree discipline: every path under `/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-245-key-hints-doc-sync` (= `$WT`); git via `git -C $WT`. Branch `issue-245-key-hints-doc-sync`, commit subjects end with `(issue #245)` **and** the PR-number suffix `(#N)` once known.

## Review Focus

These are the conditions the spec implies but no task's tests can cover; each is pinned in the task noted.

1. **Peek footer is the last line of `renderPeek`, and `fitToHeight` slices the tail** (`src/ui/dashboard.ts:1280`). A tall peek body silently truncates the footer, making the new assertion fail for the wrong reason. Pinned by the `rows` bump in Task 1, Step 1 (cross-review R1-D3).
2. **The multi-select table count** — 9 rows, not 7. Dropping `?`/`!` re-creates the very debt this issue fixes. Pinned by Task 2, Step 3's `rg` count check (cross-review R1-D1).
3. **The Evidence table must still have no `!` row.** Pinned by Task 2, Step 3's negative check.
4. **`README.md:120`'s prose must not duplicate the new table's content** — it should point at the table instead. Pinned by Task 2, Step 4 (manual read).

---

### Task 1: Peek footer copy + render assertion

**Files:**
- Modify: `src/ui/dashboard.ts` (`renderPeek` footer, currently line 1543 — locate by the string `↑↓ prev/next · →/> attach`)
- Modify: `test-support/vim-keys-wrap.ts` (`out.copy` block, currently lines ~119-140)
- Modify: `test/dashboard-vim-keys.test.mjs` (A7 test, currently lines 38-63)

**Interfaces:**
- Consumes: existing `renderPeek(width)` and the probe's white-box `dash.mode` / `dash.peekId` / `dash.selectedId` handles (already used at `vim-keys-wrap.ts:100-110`).
- Produces: probe field `out.copy.peekRender` (string) that Task 3's verification relies on indirectly.

**Spec acceptance IDs:** A1, A2, A3, A4 (+ Review Focus 1).

- [ ] **Step 1: Add the failing assertion and the probe capture**

In `test-support/vim-keys-wrap.ts`, inside the `out.copy` block, after the `evidenceRender` capture and before `dash.mode = "list";`, add:

```ts
// Peek footer: raise the height first — fitToHeight slices the tail, and the
// footer is renderPeek's last line (cross-review R1-D3).
tui.terminal.rows = 40;
dash.mode = "peek"; dash.peekId = ids[0]; dash.selectedId = ids[0];
const peekRender = dash.render(120).join("\n");
tui.terminal.rows = 24;
```

and extend the `out.copy` initializer on the following line to include `peekRender`:

```ts
out.copy = { help120, listRender, selectRender, sessionRender, evidenceRender, peekRender, help80Lines: help80.length };
```

In `test/dashboard-vim-keys.test.mjs`, in the A7 test: add `peekRender` to the destructuring line, and append before the closing `});`:

```js
	// #245 A1/A3: the peek footer advertises j/k and l, and the old wording is gone.
	assert.match(peekRender, /↑↓\/j\/k prev\/next/);
	assert.match(peekRender, /→\/l attach/);
	assert.doesNotMatch(peekRender, /↑↓ prev\/next · →\/> attach/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd $WT && node --test test/dashboard-vim-keys.test.mjs`
Expected: FAIL — `/↑↓\/j\/k prev\/next/` does not match, because the footer still reads `↑↓ prev/next`.

- [ ] **Step 3: Change the footer copy**

In `src/ui/dashboard.ts`, `renderPeek`'s else-branch (currently line 1543), replace:

```ts
			out.push(clip(t.fg("dim", "↑↓ prev/next · →/> attach · d done · v transcript · e evidence · r reply · esc back"), width));
```

with:

```ts
			out.push(clip(t.fg("dim", "↑↓/j/k prev/next · →/l attach · d done · v transcript · e evidence · r reply · esc back"), width));
```

(Matches the `↑↓/j/k … · →/l …` house style that #237 established for the session/evidence footers at `:1565` / `:1600`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd $WT && node --test test/dashboard-vim-keys.test.mjs`
Expected: PASS — both tests, including the three new assertions.

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/ui/dashboard.ts test-support/vim-keys-wrap.ts test/dashboard-vim-keys.test.mjs
git -C $WT commit -m "docs(ui): advertise j/k and l in the peek footer (issue #245)"
```

---

### Task 2: README — `!` rows and the multi-select table

**Files:**
- Modify: `README.md` (multi-select prose `:120`; Peek table `:152-167`; Transcript table `:169-183`; new `### Multi-select` section after the Main list table)

**Interfaces:**
- Consumes: Task 1's copy as the source of truth for the peek footer wording (the README Peek table must not contradict it).
- Produces: the documentation surface Task 3's U1 checklist walks.

**Spec acceptance IDs:** U1 (the `!` rows + 9-row table), Review Focus 2, 3, 4.

- [ ] **Step 1: Add `!` to the Peek table**

In `README.md`'s Peek table, insert after the `h` row and before the `Up` / `Down` / `j` / `k` row:

```markdown
| `!` | Open node-pty diagnostics and repair hints. |
```

- [ ] **Step 2: Add `!` to the Transcript table**

In the Transcript table, insert after the `h` row and before the `Left` / `Esc` / `<` row:

```markdown
| `!` | Open node-pty diagnostics and repair hints. |
```

(Wording is copied verbatim from the Main list table's `!` row so the same feature reads the same everywhere.)

- [ ] **Step 3: Add the `### Multi-select` section**

Insert this section immediately after the Main list table and before `### Peek`:

```markdown
### Multi-select

Press `m` in the main list to act on several sessions at once.

| Key | Action |
| --- | --- |
| `Up` / `Down` / `j` / `k` | Move the selection. |
| `Space` | Toggle the current row. |
| `a` | Select all visible rows. |
| `u` | Clear the selection. |
| `d` | Confirm marking the selected inactive rows Done. |
| `Ctrl+X` | Delete the selected Done rows (confirmation prompt). |
| `m` / `Esc` / `Ctrl+C` | Leave multi-select mode. |
| `?` | Open the help overlay. |
| `!` | Open node-pty diagnostics and repair hints. |
```

- [ ] **Step 4: Point the prose at the new table instead of duplicating it**

Replace the existing `README.md:120` line:

```markdown
- `m` enters multi-select mode. Use `Space` to toggle rows, `a` to select all visible rows, `u` to clear the selection, `d` to mark inactive rows Done, or `Ctrl+X` to delete selected Done rows.
```

with:

```markdown
- `m` enters multi-select mode; see [Multi-select](#multi-select) for its keys.
```

- [ ] **Step 5: Verify the tables by counting, not by eye**

Run each check and confirm the stated output:

```bash
cd $WT
# 9 rows in the multi-select table (excluding header + separator)
sed -n '/^### Multi-select/,/^### Peek/p' README.md | grep -c '^| `'
# expect: 9
# `!` documented three times: main list, peek, transcript — and NOT in evidence
grep -c '^| `!`' README.md
# expect: 3
sed -n '/^### Evidence/,/^### PTY attach/p' README.md | grep -c '^| `!`'
# expect: 0
```

- [ ] **Step 6: Commit**

```bash
git -C $WT add README.md
git -C $WT commit -m "docs: document ! and multi-select keys in the README (issue #245)"
```

---

### Task 3: Full gate + manual verification checklist

**Files:** none modified — this task runs the gate and records results.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: the A5 evidence and the U1/U2 record posted to issue #245.

**Spec acceptance IDs:** A5, U1, U2.

- [ ] **Step 1: Run the full verification gate**

Run: `cd $WT && npm run verify`
Expected: PASS — typecheck, perf gate, all tests (currently 1404: 1401 pass / 3 opt-in skips), coverage thresholds (lines 85 / funcs 80 / branches 70), `pack:dry`.

- [ ] **Step 2: Re-read the diff for the spec's non-goals**

Run: `cd $WT && git diff --stat main...HEAD && git diff main...HEAD -- src/ui/dashboard.ts`
Expected: `src/ui/dashboard.ts` shows **exactly one changed line** (the peek footer). If any handler, the help overlay, or the NORMAL/SELECT hint lines appear in the diff, revert that hunk — it violates spec D5.

- [ ] **Step 3: U1 — walk the README against the live dashboard (after merge)**

Deploy prelude (spec R1-D2): merge the PR, `git pull` on the main checkout, restart pi (the local checkout loads via auto-discovery, README "Development auto-discovery"), then `pi /agent-board`. Note: the `!` bindings themselves already ship in v0.13.0, so steps ① and ② can be sanity-checked on an older install — only the README text must be the merged version.

① Open Peek, press `!`, confirm the node-pty diagnostics view opens.
② Open the transcript (`v`), press `!`, same.
③ Enter multi-select (`m`) and walk all 9 rows of the new table: movement (`↑`/`↓`/`j`/`k`), `Space` toggle, `a`, `u`, `d`, `Ctrl+X`, `m`/`Esc`/`Ctrl+C` exit, `?`, `!`.

- [ ] **Step 4: U2 — the peek footer on screen (after merge)**

`space` to open Peek; read the footer.
Expected: `↑↓/j/k prev/next · →/l attach · d done · v transcript · e evidence · r reply · esc back`.

- [ ] **Step 5: Record results on issue #245**

Post the A5 command + result, then the U1/U2 observations. If any U item cannot run yet, mark it `pending` — do not claim full acceptance.

---

## Self-Review Notes

- **Spec coverage:** D1 → Task 1; D2 → Task 2 Steps 1-2; D3 → Task 2 Steps 3-4 (option A, 9 rows); D4 → Task 1 Step 1; D5 → Task 3 Step 2's revert check. A1/A3 → Task 1; A2 → Task 1 Steps 2/4; A4 → Task 3 Step 1; A5 → Task 3 Step 1; U1/U2 → Task 3 Steps 3-5. Every acceptance ID has an owning task; no task lacks an ID.
- **Placeholder scan:** none — every step carries the literal text to write or the exact command with its expected output.
- **Type consistency:** `peekRender` is named identically in the probe (`out.copy.peekRender`), the test destructuring, and the assertions.
- **Unresolved spec item:** §6 asked A vs B; the user chose **A**, recorded in `authorization.md` (`Scope: design-approved (D3 = option A…)`). The plan implements A only.
