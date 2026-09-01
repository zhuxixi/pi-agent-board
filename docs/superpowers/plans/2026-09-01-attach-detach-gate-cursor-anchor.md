# ← Detach Gate Cursor-Anchor Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #66 — `←` must detach when the Pi editor line is empty even while the terminal cursor rests on working/output lines (attach / streaming).

**Architecture:** Replace the cursor-line anchor in `PtyAttachComponent.childInputLooksEmpty()` with a bottom-up scan for Pi's inverse-video fake-cursor cell (`ESC[7m`, persists in the xterm buffer across differential frames), with a prompt-glyph fallback and a "treat as empty" escape fallback. Add a pure helper `isProbablyPiInputLine` for glyph detection.

**Tech Stack:** TypeScript (pty-attach.ts, run via `node --experimental-transform-types` in tests), plain ESM (pty-input.mjs), `node:test` runner, @xterm/headless.

**Spec:** `docs/superpowers/specs/2026-09-01-attach-detach-gate-cursor-anchor-design.md`

## Global Constraints

- Coverage gates: lines 85 / funcs 80 / branches 70 (c8, `npm run test:coverage`); Node 22/24 both green (CI).
- `isProbablyPiInputLine` glyph set must stay identical to `isProbablyEmptyPiInputLine`'s trim charset: `›>┃│|┆╎╏:`.
- Do not change `ctrl+]` semantics (passes through to Pi since v0.5.1) and do not make `←` unconditionally detach (keeps the edit-protection gate — spec §3).
- Do not modify `src/core/pty-input.mjs`'s existing `isProbablyEmptyPiInputLine` behavior.
- All edits inside worktree `WT=.pi/worktrees/issue-66-attach-detach-gate-cursor-anchor`; git ops via `git -C $WT`.

---

### Task 1: Add `isProbablyPiInputLine` pure helper + unit tests

**Files:**
- Modify: `src/core/pty-input.mjs` (append glyph const + function after existing helper)
- Test: `test/pty-input.test.mjs`

**Interfaces:**
- Produces: `export function isProbablyPiInputLine(line: string): boolean` — true iff the line, after trimming leading whitespace, starts with a prompt/continuation glyph.

- [ ] **Step 1: Write the failing test**

Append to `test/pty-input.test.mjs` (keep existing tests untouched):

```js
import { isProbablyEmptyPiInputLine, isProbablyPiInputLine } from "../src/core/pty-input.mjs";

test("isProbablyPiInputLine recognizes Pi prompt / continuation lines", () => {
	assert.equal(isProbablyPiInputLine("> "), true);
	assert.equal(isProbablyPiInputLine("  ┃ edit me"), true);
	assert.equal(isProbablyPiInputLine("  │ second line"), true);
	assert.equal(isProbablyPiInputLine("› draft"), true);
});

test("isProbablyPiInputLine rejects content lines and empty lines", () => {
	assert.equal(isProbablyPiInputLine("chat content"), false);
	assert.equal(isProbablyPiInputLine("────── ◊◊ ──────"), false);
	assert.equal(isProbablyPiInputLine(""), false);
	assert.equal(isProbablyPiInputLine("   "), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pty-input.test.mjs`
Expected: FAIL — `isProbablyPiInputLine is not a function` (import error).

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/pty-input.mjs` (before `isProbablyEmptyPiInputLine` or after — any top-level position):

```js
/** Glyphs Pi uses to render editor prompt / continuation lines (`>` main prompt,
 * `›`/`┃`/`│` and variants in older releases). Must stay in sync with the
 * trim charset of isProbablyEmptyPiInputLine below. */
const PROMPT_GLYPHS = "›>┃│|┆╎╏:";

/**
 * Whether the given terminal line looks like a Pi editor input line: leading
 * whitespace followed by a prompt/continuation glyph. The attach surface uses
 * this to locate the editor line inside the buffer instead of trusting the
 * terminal cursor, which wanders onto output/working lines while Pi streams
 * (issue #66).
 * @param {string} line
 * @returns {boolean}
 */
export function isProbablyPiInputLine(line) {
	const withoutLeftPadding = String(line || "").replace(/^[\s\u00a0]+/u, "");
	return withoutLeftPadding.length > 0 && PROMPT_GLYPHS.includes(withoutLeftPadding[0]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pty-input.test.mjs`
Expected: PASS (4 tests: 2 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add test/pty-input.test.mjs src/core/pty-input.mjs
git commit -m "feat: add isProbablyPiInputLine helper (issue #66)"
```

---

### Task 2: Rework `childInputLooksEmpty()` anchor + smoke scenarios

**Files:**
- Modify: `src/ui/pty-attach.ts` (import line ~8; `childInputLooksEmpty()` ~line 319; add private helper near it)
- Modify: `test-support/detach-gate-smoke.ts` (scenarios B/B1/B2/B3 + new E)
- Modify: `test/pty-attach-detach-gate.test.mjs` (assertions)

**Interfaces:**
- Consumes: `isProbablyPiInputLine` from Task 1; existing `isProbablyEmptyPiInputLine`.
- Produces: private `findLastInverseCellLine(active): number | null` — bottom-most line index containing an `isInverse()` cell; `null` when none.

- [ ] **Step 1: Write the failing smoke scenarios**

In `test-support/detach-gate-smoke.ts`:

1. Change scenario **B** (line ~76) so the draft line carries a fake cursor, then add B3 (cursor off the empty input line) and E (empty input line without fake cursor). Replace the current B block and append:

```ts
// B. ← must NOT detach while attached with a draft in the editor line (child
// is mid-draft and ← is also the editor's cursor-left key). The draft line
// carries Pi's inverse-video fake cursor (ESC[7m).
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> \x1b[7m草\x1b[27m稿");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftStaysGatedOnNonEmptyLine = !didDetach() && sent.length === 1 && sent[0].type === "input" && sent[0].data === "\x1b[D";
	attach.dispose();
}

// B3. The streaming case from issue #66: the editor line is empty (bottom of
// the buffer, with its fake cursor) but the terminal cursor rests on the
// working line because Pi's differential frames only repaint the changed
// line. The gate must be judged from the fake-cursor line, not the cursor.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n> \x1b[7m \x1b[27m");
	await writeToTerm(attach, "\x1b[2;1H⠙ Working...");
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesWhenCursorOffEmptyInputLine = didDetach() && sent.length === 0;
	attach.dispose();
}

// E. Empty input line rendered WITHOUT a fake cursor: no inverse cell and no
// glyph anywhere, and the terminal cursor sits on a non-empty output line.
// Falls through to the escape fallback — treat as empty, detach.
{
	const { attach, sent, didDetach } = makeAttach();
	await writeToTerm(attach, "chat content\r\n");
	await writeToTerm(attach, "\x1b[1;1H"); // park the cursor on the non-empty line
	(attach as unknown as { connected: boolean }).connected = true;
	attach.handleInput("\x1b[D");
	out.leftDetachesOnEmptyInputWithoutFakeCursor = didDetach() && sent.length === 0;
	attach.dispose();
}
```

2. Update the B1 header comment (scenario text already fits) and ensure B1 (`────── ◊◊ ──────` garbled buffer) stays as-is — it now asserts escape-on-garbled-buffer.

- [ ] **Step 2: Run smoke to verify new scenarios fail**

Run: `node --experimental-transform-types test-support/detach-gate-smoke.ts`
Expected: `leftDetachesWhenCursorOffEmptyInputLine` is `false` (old cursor-line anchor reads the Working line) and `leftDetachesOnEmptyInputWithoutFakeCursor` is `false` (old anchor reads last non-empty line `chat content`? — verify output); `leftStaysGatedOnNonEmptyLine` true.

- [ ] **Step 3: Write the implementation**

In `src/ui/pty-attach.ts`:

1. Update import (line ~8):

```ts
import { isProbablyEmptyPiInputLine, isProbablyPiInputLine } from "../core/pty-input.mjs";
```

2. Replace the `childInputLooksEmpty()` method (currently ~line 319) and add the helper above it:

```ts
	/** Bottom-most line whose cells include an inverse-video cell — Pi renders
	 * its editor cursor as an inverse "fake cursor" (`ESC[7m`), and the cell
	 * persists in the buffer even while streaming differential frames skip
	 * repainting the editor line. */
	private findLastInverseCellLine(active: {
		baseY: number;
		length: number;
		getLine(index: number): BufferLineLike | undefined;
	}): number | null {
		for (let y = active.baseY + active.length - 1; y >= active.baseY; y--) {
			const line = active.getLine(y);
			if (!line) continue;
			for (let x = 0; x < line.length; x++) {
				if (line.getCell(x)?.isInverse()) return y;
			}
		}
		return null;
	}

	private childInputLooksEmpty(): boolean {
		if (!this.receivedOutput) return true;
		const active = this.term.buffer.active;
		// The terminal cursor is not a reliable anchor for the editor line:
		// while Pi streams output (or right after attach) the cursor rests on
		// working/output lines, never the input line, so a genuinely empty
		// editor was misread as non-empty and ← stopped detaching (issue #66).
		// Pi's editor line always carries an inverse-video fake-cursor cell,
		// so anchor on that instead.
		const fakeCursorLine = this.findLastInverseCellLine(active);
		if (fakeCursorLine !== null) {
			const line = active.getLine(fakeCursorLine)?.translateToString(true) ?? "";
			return isProbablyEmptyPiInputLine(line);
		}
		// Fallback: Pi variants that render no fake cursor — look for a
		// prompt-glyph line.
		for (let y = active.baseY + active.length - 1; y >= active.baseY; y--) {
			const line = active.getLine(y)?.translateToString(true) ?? "";
			if (isProbablyPiInputLine(line)) return isProbablyEmptyPiInputLine(line);
		}
		// No editor line recoverable (e.g. a garbled replay buffer): treat the
		// input as empty — ← is the only detach key left on the attach surface,
		// so it must always escape rather than trap the user.
		return true;
	}
```

- [ ] **Step 4: Update gate assertions**

In `test/pty-attach-detach-gate.test.mjs`, add to the existing test (after `leftDetachesOnEmptyInput`):

```js
	assert.equal(parsed.leftDetachesWhenCursorOffEmptyInputLine, true, "← must detach when the editor line is empty even if the cursor sits on a working line");
	assert.equal(parsed.leftDetachesOnEmptyInputWithoutFakeCursor, true, "← must detach when an empty editor line renders no fake cursor");
```

- [ ] **Step 5: Run tests to verify pass**

Run: `node --test test/pty-attach-detach-gate.test.mjs test/pty-input.test.mjs`
Expected: PASS — all gate assertions true, including the three new ones.

- [ ] **Step 6: Commit**

```bash
git add src/ui/pty-attach.ts test-support/detach-gate-smoke.ts test/pty-attach-detach-gate.test.mjs
git commit -m "fix: anchor ← detach gate on Pi's fake-cursor line, not terminal cursor (issue #66)"
```

---

### Task 3: Full regression (A6)

**Files:** none (verification only).

- [ ] **Step 1: Run verify**

Run (in worktree): `npm run verify`
Expected: typecheck clean; all `node --test test/*.test.mjs` pass (325+ tests, none of the pre-existing ones changed semantics); c8 coverage above gates (lines ≥85 / funcs ≥80 / branches ≥70); `npm pack --dry-run` succeeds.

- [ ] **Step 2: Commit any incidental fixes**

If verify surfaced issues, fix and commit with a message referencing issue #66. Otherwise nothing to commit.

---

### Task 4: Post-implementation manual verification (U1, U2)

**Files:** none (user verification; report back into the PR).

- [ ] **Step 1: U1 — attach-then-←**

1. Start agent-board, attach into an existing pi session (or create a new one).
2. As soon as the attach surface paints, press `←`.
Expected: returns to the dashboard immediately, no ↑/↓ or type-then-delete needed.

- [ ] **Step 2: U2 — ← while Pi is thinking**

1. Attach into a session and send a prompt that triggers Pi streaming (`⠹ Working...` animation visible).
2. While the animation is running, press `←`.
Expected: returns to the dashboard. (Fails before this fix — the exact reported symptom.)

- [ ] **Step 3: Sanity — ← does not steal the editor's cursor-left**

1. Attach, type a draft in the input box.
2. Press `←`.
Expected: cursor moves left inside the draft (key forwarded), NOT detach.

- [ ] **Step 4: Record results**

Write the U1/U2/U3 outcomes into the PR description (or a PR comment) before merge.
