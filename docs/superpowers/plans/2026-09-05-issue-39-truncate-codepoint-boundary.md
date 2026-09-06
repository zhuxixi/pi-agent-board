# Issue #39 Truncate Surrogate-Safe Cut — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `truncate()` in `src/core/heuristics.mjs` never split a surrogate pair (cut-point back-off within the UTF-16 unit budget) and never emit lone surrogates, eliminating the U+FFFD → width-mismatch → wrap → stacked-frames chain at its repo-side root.

**Architecture:** Pure-function change inside `truncate` only: check whether the unit before the cut point is a high surrogate whose low surrogate is being dropped; if so, back the cut off by one unit. Strip any lone surrogates from the returned string on both paths via a small private regex helper.

**Tech Stack:** Node built-in test runner; no new dependencies.

## Global Constraints

- Keep the UTF-16 unit budget semantics of `n` (spec Decision 1) — do NOT switch to code-point counting.
- Only `src/core/heuristics.mjs` (truncate + private helper) and `test/heuristics.test.mjs` change (spec A5).
- Existing tests must pass unmodified (spec A3).
- Test command: `npm test`.

**Execution mode:** inline (executing-plans).

---

### Task 1: Red tests at the surrogate boundaries

**Files:**
- Modify: `test/heuristics.test.mjs` (extend the existing "truncate adds ellipsis" test block or add a new test after it)

**Interfaces:**
- Consumes: `truncate(s, n)` exported from `src/core/heuristics.mjs`.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the failing tests (red)**

Replace the existing block:

```js
test("truncate adds ellipsis", () => {
	assert.equal(truncate("hello", 10), "hello");
	assert.equal(truncate("hello world", 5), "hell…");
});
```

with:

```js
test("truncate adds ellipsis", () => {
	assert.equal(truncate("hello", 10), "hello");
	assert.equal(truncate("hello world", 5), "hell…");
	assert.equal(truncate("一二三四五六", 5), "一二三四…");
});

test("truncate never splits a surrogate pair", () => {
	// Cut point lands between the high and low surrogate of 👍: back off.
	assert.equal(truncate("a👍b", 3), "a…");
	// Long string whose 80-unit cut lands inside the emoji (issue #39 repro shape).
	const s = "x".repeat(59) + "完成 — LGTM " + "👍" + "y".repeat(10);
	const out = truncate(s, 80);
	assert.ok(!/[\uD800-\uDBFF]$/.test(out.replace(/…$/, "")), "no trailing lone high surrogate before ellipsis");
	// The pair survives whole when it fits the budget.
	assert.equal(truncate("👍", 2), "👍");
	assert.equal(truncate("a👍", 3), "a👍");
});

test("truncate strips lone surrogates from input", () => {
	assert.equal(truncate("ab\ud83d", 10), "ab"); // lone high surrogate, short path
	assert.equal(truncate("ab\ud83dcd", 4), "abc…"); // lone high surrogate, truncated path
	assert.equal(truncate("\udc4dab", 10), "ab"); // lone low surrogate, short path
});
```

Note on `"ab\ud83dcd"` with n=4: units are a,b,\ud83d,c,d (length 5 > 4) → cut end=3 → slice = "ab\ud83d" → the high surrogate is last-but-0 with no following unit in the *kept* slice; input's `\ud83d` is followed by `c` (not a low surrogate), so it is a lone surrogate in the input and must be stripped → expected "ab…". If the implementation instead computes end=3, sees charCodeAt(2) is a high surrogate and charCodeAt(3)="c" is not a low surrogate, no pair back-off applies (no pair to preserve) — the strip helper removes it → "ab…". Both reasonings converge; assert the observable "ab…".

- [ ] **Step 2: Run, verify red**

Run: `node --test test/heuristics.test.mjs`
Expected: the two new tests FAIL (current implementation splits pairs / keeps lone surrogates), "truncate adds ellipsis" still passes.

### Task 2: Implement the surrogate-safe truncate

**Files:**
- Modify: `src/core/heuristics.mjs` (replace `truncate`)

- [ ] **Step 3: New implementation**

Replace the existing `truncate` function with:

```js
const LONE_HIGH_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LOW_SURROGATE_RE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** @param {string} s */
function stripLoneSurrogates(s) {
	if (!s) return s;
	return s.replace(LONE_HIGH_SURROGATE_RE, "").replace(LONE_LOW_SURROGATE_RE, "");
}

/**
 * Truncate to `n` chars with an ellipsis (counts characters, not display width).
 * The budget `n` is in UTF-16 units. The cut never splits a surrogate pair
 * (backs off one unit when it would), and lone surrogates in the input are
 * stripped from the result — a lone surrogate renders as U+FFFD, whose
 * terminal width can disagree with the computed width and misalign rows.
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
export function truncate(s, n) {
	const str = String(s ?? "");
	if (str.length <= n) return stripLoneSurrogates(str);
	let end = Math.max(0, n - 1);
	const lastUnit = str.charCodeAt(end - 1);
	const nextUnit = str.charCodeAt(end);
	if (lastUnit >= 0xd800 && lastUnit <= 0xdbff && nextUnit >= 0xdc00 && nextUnit <= 0xdfff) end -= 1;
	return `${stripLoneSurrogates(str.slice(0, end))}…`;
}
```

- [ ] **Step 4: Run the file, verify green**

Run: `node --test test/heuristics.test.mjs`
Expected: all pass, including the two new tests and the unchanged originals.

- [ ] **Step 5: Full suite (A4)**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Verify A5 scope**

Run: `git diff main -- src/ test/`
Expected: only `src/core/heuristics.mjs` and `test/heuristics.test.mjs`.

- [ ] **Step 7: Commit**

```bash
git add src/core/heuristics.mjs test/heuristics.test.mjs
git commit -m "fix: truncate never splits surrogate pairs or emits lone surrogates (issue #39)"
```

## Self-Review

- Spec coverage: A1 (Task 1 red + Task 2), A2 (lone-surrogate tests), A3 (unchanged originals + CJK case), A4 (Step 5), A5 (Step 6). Covered.
- Placeholder scan: full code shown.
- Type consistency: `stripLoneSurrogates` string→string; `charCodeAt` unit checks match the surrogate ranges used in the regexes.
