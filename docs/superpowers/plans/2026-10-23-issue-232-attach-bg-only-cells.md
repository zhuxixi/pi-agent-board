# Attach Background-Only Cells Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `lineToAnsi()` from trimming cells that carry only a non-default background, so full-screen TUIs (nvim, lazygit, htop) keep their theme background in the attach view.

**Architecture:** The per-line scan in `lineToAnsi()` already walks every cell; it gains a `lastBg` cursor (last cell with `!isBgDefault()`), and the render bound becomes `renderEnd = max(last, lastBg)`. The main loop, the empty-line guard, and the cursor-past-content check all switch from `last` to `renderEnd`. Default-background screens keep the existing cheap path (`""` for blank lines, no padding). A component-level smoke fixture drives a real `@xterm/headless` terminal through `PtyAttachComponent.render()` and asserts the emitted ANSI.

**Tech Stack:** TypeScript (`src/ui`), Node 22/24 `node:test`, `node --experimental-transform-types` fixtures, `@xterm/headless`.

**Spec:** `docs/superpowers/specs/2026-10-23-issue-232-attach-bg-only-cells-design.md`

**Worktree:** `/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-232-attach-bg-only-cells` — every path below is relative to it; never edit the main checkout.

## Global Constraints

- Tabs for indentation; English comments; conventional commit subjects (`fix(attach): …`) with `(#232)` only on the PR title.
- Do not change selection/copy semantics, OSC-8 link handling, mouse handling, or the wide-char skip (`getWidth() === 0`).
- Padding must never be emitted for default-background cells — the cheap path for ordinary shells stays byte-identical.
- `git add <explicit files>` only; never `git add -A`.
- `npm run verify` (typecheck + perf + test + coverage + pack:dry) is the gate before claiming done.
- Fixture cells that must be background-only are produced **only** by erase sequences (`\x1b[K` / `\x1b[2J`) under an active bg; literal spaces keep `getChars()` non-empty and make the test pass on unpatched code (spec A8).

## Review Focus

1. **Blank painted line** — all cells `getChars() === ""`, `isBgDefault() === false`; the line must render as an SGR run plus padding, not `""`. → A1.
2. **Trailing paint after content** — characters end at col 1, paint starts at col 40; cols 2–39 stay default, 40–79 painted. → A2.
3. **Default-background regression** — plain text screens still serialize blank lines to `""` (no padding, no SGR). → A3.
4. **Wide chars** — `中` (cols 0–1, continuation cell skipped) followed by painted erase cells; display width must stay 80 with 78 padding spaces. → A4.
5. **Cursor inside the padded region** — exactly one `CURSOR_MARKER` and one inverse block, no double block. → A5.
6. **Selection over padding** — padded cells inside a selection render inverse (`7`); copied text is unaffected. → A9.

---

### Task 1: Fixture and failing tests (red)

**Files:**
- Create: `test-support/attach-bg-paint-smoke.ts`
- Create: `test/pty-attach-bg-paint.test.mjs`

**Interfaces:**
- Consumes: `PtyAttachComponent` (`src/ui/pty-attach.ts:162`), constructor `(tui, theme, keybindings, done, opts)`; `render(width: number): string[]` returns `[header, ...body(rows-2), footer]`.
- Produces: JSON on stdout from the fixture:

```ts
{
  blankPainted: string[];   // 10 body lines, whole screen erased with bg #1e1e2e
  contentPainted: string[]; // one row: "AB" + 38 default spaces + 40 painted cells
  plain: string[];          // ordinary text screen (default bg)
  wide: string[];           // "中" + 78 painted cells
  cursor: string[];         // painted blank row, cursor visible at col 30
  selection: string[];      // painted blank row, selection cols 20–60
}
```

- [ ] **Step 1: Write the fixture.** Model it on `test-support/hyperlink-cell-smoke.ts` (stub `tui` with `terminal: { rows: 12, cols: 80, columns: 80, write: () => {} }`, identity `theme`, `socketPath: "/no/such/socket"`, `dispose()` in `finally`). Cast the component to expose `term`, `receivedOutput`, `finishAttachTransition`, and `selection`.

  Per scenario:
  - `blankPainted`: `\x1b[48;2;30;30;46m\x1b[2J` then `\x1b[?25l` (hide cursor).
  - `contentPainted`: default-bg rows, then `AB\x1b[41G\x1b[48;2;30;30;46m\x1b[K` on one row; hide cursor.
  - `plain`: `hello\r\nworld` only; hide cursor.
  - `wide`: `中\x1b[48;2;30;30;46m\x1b[K`; hide cursor.
  - `cursor`: painted blank row (`\x1b[48;2;30;30;46m\x1b[2J`), then park the cursor visibly at row 5 col 30 via `\x1b[6;31H`; do **not** send `\x1b[?25l`.
  - `selection`: painted blank screen; set the private `selection = { anchor: { line: 5, col: 20 }, focus: { line: 5, col: 60 } }` (type `MouseSelection`, `src/ui/pty-attach.ts:159`) before `finishAttachTransition()`.

  Return `attach.render(80).slice(1, -1)` per scenario (the component's body lines; height comes from `tui.terminal.rows - 2`).

- [ ] **Step 2: Write the assertions** in `test/pty-attach-bg-paint.test.mjs`, spawning the fixture with `execFileSync(process.execPath, ["--experimental-transform-types", FIXTURE], { encoding: "utf8", timeout: 30_000 })` exactly like `test/pty-attach-hyperlinks.test.mjs`:
  - A1: every `blankPainted` line is non-empty and includes `48;2;30;30;46`.
  - A2: the `contentPainted` line containing `AB` has exactly 38 spaces before the next SGR, and the paint run covers 40 cells.
  - A3: in `plain`, the blank body lines are exactly `""`.
  - A4: the `wide` line contains `中`, ends with 78 spaces plus `\x1b[0m`, and has display width 80.
  - A5: the cursor row contains exactly one `\x1b_pi:c\x07` and one `\x1b[7m \x1b[0m`.
  - A9: the selection row contains an SGR that includes `7` (e.g. `\x1b[0;7;`) inside the padded region.

- [ ] **Step 3: Run the tests and record the red output.**

```bash
node --test test/pty-attach-bg-paint.test.mjs
```

Expected: A1, A2, A4, A5, A9 fail against the unpatched `lineToAnsi` (blank painted lines are `""`, padding absent). A3 passes. Save the output — it is the A8 "red" evidence for the PR description.

---

### Task 2: Patch `lineToAnsi()` (green)

**Files:**
- Modify: `src/ui/pty-attach.ts` (`lineToAnsi`, `:1962-2026`)

**Interfaces:**
- Consumes: `BufferCellLike.isBgDefault()` (`:142`), already on the interface.
- Produces: no signature change.

- [ ] **Step 1: Add the painted-extent scan (C1).** After the `if (!line)` early return, declare `let lastBg = -1;`, and inside the scan loop add `if (!cell.isBgDefault()) lastBg = x;` after the `getChars()` check. Compute `const renderEnd = Math.max(last, lastBg);` and make the empty-line guard test `renderEnd < 0`.

- [ ] **Step 2: Render through the painted extent (C2).** Change the main loop bound to `x <= renderEnd`.

- [ ] **Step 3: Fix the cursor bound (C3).** Change the post-loop check to `cursor!.col > renderEnd` and update the adjacent comment to say "painted region" rather than "line content".

- [ ] **Step 4: Add the explanatory comment** above `lastBg` (English): full-screen TUIs paint an explicit theme bg over empty regions; trimming at the last character drops it and lets the host terminal's default bg show through (issue #232). Keep it to 3–4 lines.

- [ ] **Step 5: Run the new tests.**

```bash
node --test test/pty-attach-bg-paint.test.mjs
```

Expected: all pass, including A3 (plain screen unchanged).

- [ ] **Step 6: Commit.**

```bash
git add src/ui/pty-attach.ts test-support/attach-bg-paint-smoke.ts test/pty-attach-bg-paint.test.mjs
git commit -m "fix(attach): render cells that only carry a background (#232)"
```

---

### Task 3: Red-green mutation proof (A8)

- [ ] **Step 1:** Temporarily change the main loop bound back to `x <= last` (leave `renderEnd` in place).
- [ ] **Step 2:** Run `node --test test/pty-attach-bg-paint.test.mjs`; expect A1/A2/A4 to fail.
- [ ] **Step 3:** Restore `x <= renderEnd`; re-run; expect all pass.
- [ ] **Step 4:** Record both outputs (commands + failure names) for the PR description. Do not commit the reverted state.

---

### Task 4: Full gate

- [ ] **Step 1:** `npm run typecheck` → exit 0 (A6; note `test-support/` is outside `tsconfig`, so fixture types surface through Task 1 instead).
- [ ] **Step 2:** `npm run verify` → typecheck + perf gate + full suite + coverage thresholds (lines 85 / funcs 80 / branches 70) + pack dry-run (A7).

---

### Task 5: Manual acceptance (U1, after the PR branch is installable)

- [ ] **Step 1:** Confirm the worktree HEAD equals the PR head (`git log -1`).
- [ ] **Step 2:** `npm install` in the worktree; load the checkout with `pi install "$(pwd)"`; **restart pi**.
- [ ] **Step 3:** `/agent-board` → attach to an nvim session with catppuccin-mocha; observe the empty buffer area (`#1e1e2e`) and the cursorline (highlight spans the full row).
- [ ] **Step 4:** `pi remove "$(pwd)"`; report the observation in the PR/issue.

---

## Acceptance traceability

| Spec ID | Plan task |
| --- | --- |
| A1, A2, A3, A4, A5, A9 | Task 1 (red) + Task 2 Step 5 (green) |
| A8 | Task 3 (+ Task 1 Step 3 red output) |
| A6 | Task 4 Step 1 |
| A7 | Task 4 Step 2 |
| U1 | Task 5 |
