# Detach-Gate Tier-2 Glyph Fallback Tightening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the attach-surface `←` detach gate's tier-2 glyph fallback so content glyph lines (markdown table rows / quotes / drafts) no longer trap the user when `editor_state` is unavailable (issue #69).

**Architecture:** One-line condition change in `PtyAttachComponent.childInputLooksEmpty()` (src/ui/pty-attach.ts): the tier-2 loop now only treats an EMPTY prompt-glyph line as proof of an empty editor (`isProbablyPiInputLine(line) && isProbablyEmptyPiInputLine(line)`), skipping content glyph lines; loop-end escape stays authoritative. Tier-1 (inverse fake-cursor anchor), the `editor_state` authoritative path (#71), and all protocol/public API surfaces are untouched. Behavior is pinned by two new detach-gate smoke scenarios (K1/K2) asserted inside the existing `test/pty-attach-detach-gate.test.mjs` case.

**Tech Stack:** TypeScript (Node `--experimental-transform-types`), node:test, @xterm/headless in-memory smoke harness.

**Spec:** `docs/superpowers/specs/2026-09-03-detach-gate-glyph-fallback-design.md` (accepted 2026-09-03, Option B).

**Acceptance traceability:** Task 1 → A1, A2, A3, A4 (automated). Task 2 → U1, U2 (manual, human-executed after push, before merge). No orphan tasks, no orphan acceptance IDs.

## Global Constraints

- Work only inside this worktree: `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-69-detach-gate-glyph-fallback`. Never edit the main checkout at `/home/elling/git-repo/github/pi-agent-board` (`node_modules` there is only the read-only symlink target).
- Commit messages: English, conventional commits, suffix `(issue #69)`.
- Stage files explicitly (`git add <file> ...`); never `git add -A`.
- Do NOT touch: tier-1 inverse anchor, `editor_state` path (`resolveEditorEmpty`, reporter, runner), README.md, or the pure helpers in `src/core/pty-input.mjs` (spec non-goals).
- Do NOT extract new pure functions — the tightened tier-2 is constant-true by design; the discriminating tests live at smoke level (spec §4).
- Every new online-gate smoke scenario MUST pin `connected=true` explicitly before `handleInput` (B-section convention; otherwise the disconnected-escape semantics fire instead of the online gate).
- `node --test` case count stays 437: the new smoke keys are assertions inside the existing test case in `test/pty-attach-detach-gate.test.mjs`, not new `test()` blocks.
- Verification commands: `npm test` (expect 437 pass, 0 fail) and `npm run typecheck` (expect 0 errors). Faster smoke-only loop: `node --experimental-transform-types test-support/detach-gate-smoke.ts` (prints a JSON of scenario keys).

---

### Task 1: Tighten tier-2 glyph fallback (TDD) — covers A1, A2, A3, A4

**Files:**
- Modify: `src/ui/pty-attach.ts` (the tier-2 loop inside `childInputLooksEmpty()`, right after the `// Fallback: Pi variants that render no fake cursor` comment, line 359)
- Test: `test-support/detach-gate-smoke.ts` (insert two scenarios after the J-scenario block, before the `// E2.` comment)
- Test: `test/pty-attach-detach-gate.test.mjs` (two assertions after the `leftHelloNullResetsStaleEditorState` assertion)

**Interfaces:**
- Consumes: `isProbablyPiInputLine(line)`, `isProbablyEmptyPiInputLine(line)` from `src/core/pty-input.mjs` (both already imported in `pty-attach.ts`); smoke harness helpers `makeAttach()`, `writeToTerm(attach, data)` (already defined in the smoke file).
- Produces: smoke output keys `leftDetachesOnTableRowsWithoutFakeCursor` (A1) and `leftDetachesOnContentGlyphFallback` (A2) in the JSON printed by `test-support/detach-gate-smoke.ts`.

- [ ] **Step 1: Write the failing smoke scenarios (A1, A2)**

In `test-support/detach-gate-smoke.ts`, insert these two blocks immediately BEFORE the line starting with `// E2. A terminal at the minimum supported size`:

```ts
// K1. Issue #69 real-world shape: zero inverse cells anywhere in the buffer,
// the chat area carries a markdown table row (`│ … │`) and a quote line
// (`> …`) that isProbablyPiInputLine misreads as a draft-bearing input line,
// and editor_state never arrives (editorEmpty stays null — child without the
// reporter). tier-2 must skip content glyph lines and ← must detach: the
// gate philosophy is "never trap the user" (issues #42/#48).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n│ Issue #778 │ open │\r\n> quote line\r\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesOnTableRowsWithoutFakeCursor = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}

// K2. The deliberate flip side of K1 — pair with scenario B: the SAME draft
// shape (`> draft`) is gated when the fake cursor is present (tier-1, scenario
// B) but detaches when the buffer carries no inverse cells (tier-2 fallback
// cannot tell a real draft from a table row; a spurious detach beats a trapped
// user, and detach never loses the draft — the child session keeps running).
// This pins the intentional loss of fallback draft protection (issue #69);
// restoring it needs the mid-term dock-structure anchor, not a revert.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> draft\r\n");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesOnContentGlyphFallback = didDetach() && sent.length === 1 && sent[0].type === "detach";
	attach.dispose();
}
```

In `test/pty-attach-detach-gate.test.mjs`, insert these two assertions immediately AFTER the `assert.equal(parsed.leftHelloNullResetsStaleEditorState, true, ...)` line:

```js
	assert.equal(parsed.leftDetachesOnTableRowsWithoutFakeCursor, true, "← must detach when a zero-inverse buffer holds only table/quote glyph lines and editor_state is unknown (issue #69)");
	assert.equal(parsed.leftDetachesOnContentGlyphFallback, true, "← must detach on a content glyph line in the no-fake-cursor fallback — spurious detach beats trapping (issue #69)");
```

- [ ] **Step 2: Run to verify both fail (A1, A2 red)**

Run: `node --experimental-transform-types test-support/detach-gate-smoke.ts`
Expected: JSON contains `"leftDetachesOnTableRowsWithoutFakeCursor":false` and `"leftDetachesOnContentGlyphFallback":false` (all pre-existing keys stay `true`).

- [ ] **Step 3: Implement the tier-2 tightening (minimal change)**

In `src/ui/pty-attach.ts`, inside `childInputLooksEmpty()`, replace this exact block:

```ts
		// Fallback: Pi variants that render no fake cursor — look for a
		// prompt-glyph line.
		for (let y = active.baseY + active.length - 1; y >= active.baseY; y--) {
			const line = active.getLine(y)?.translateToString(true) ?? "";
			if (isProbablyPiInputLine(line)) return isProbablyEmptyPiInputLine(line);
		}
```

with:

```ts
		// Fallback: Pi variants that render no fake cursor — look for an EMPTY
		// prompt-glyph line. Only an empty glyph line proves an empty editor:
		// content glyph lines (markdown table rows `│ … │`, quotes `> …`, or a
		// real draft in a no-fake-cursor Pi variant) cannot be told apart, and
		// trapping the user is worse than a spurious detach (issue #69) — skip
		// them and keep scanning; the loop-end escape below stays authoritative.
		for (let y = active.baseY + active.length - 1; y >= active.baseY; y--) {
			const line = active.getLine(y)?.translateToString(true) ?? "";
			if (isProbablyPiInputLine(line) && isProbablyEmptyPiInputLine(line)) return true;
		}
```

- [ ] **Step 4: Run smoke to verify the fix (A1, A2 green)**

Run: `node --experimental-transform-types test-support/detach-gate-smoke.ts`
Expected: EVERY key in the JSON is `true`, including the two new ones.

- [ ] **Step 5: Full automated acceptance (A3, A4)**

Run: `npm test`
Expected: `pass 437`, `fail 0` (count unchanged — the new keys are assertions inside the existing test case).

Run: `npm run typecheck`
Expected: exit 0, no output errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/pty-attach.ts test-support/detach-gate-smoke.ts test/pty-attach-detach-gate.test.mjs
git commit -m "fix: tighten ← detach tier-2 glyph fallback to empty-only lines (issue #69)"
```

### Task 2: Manual verification U1/U2 (human-executed; after PR branch is pushed, before merge) — covers U1, U2

> Not a subagent task. The controller surfaces this checklist to the human partner at the pre-merge gate.

**Environment:** the running extension copy is the git-source clone at `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board` (currently at 0.5.1 / fac9e91). Steps:

- [ ] **Step 1:** `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board fetch origin && git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board checkout issue-69-detach-gate-glyph-fallback`
- [ ] **Step 2:** Restart pi IN ANOTHER TERMINAL (restarting kills the session running this agent — do not run inside the controlling session's pi instance).
- [ ] **Step 3 (U1):** Open dashboard → attach a warm session whose chat area contains markdown table output (`│ … │` rows) → with an empty input box press `←`. Pass = returns to dashboard, not trapped.
- [ ] **Step 4 (U2):** In the same or another reporter-active hosted session, type a draft → press `←`. Pass = cursor moves left inside the draft, no detach (same as #67 U3).
- [ ] **Step 5:** `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board checkout main` and restart pi to restore the running copy.
