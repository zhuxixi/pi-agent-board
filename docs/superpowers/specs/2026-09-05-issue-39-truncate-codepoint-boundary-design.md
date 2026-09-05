# Spec: issue #39 — truncate() cuts surrogate pairs, producing lone surrogates (U+FFFD) and wrap-misaligned dashboard rows

## Problem

`src/core/heuristics.mjs` `truncate(s, n)` uses `str.length` and `str.slice()`
(UTF-16 code units). When the cut lands inside a surrogate pair (e.g. emoji,
2 units), the output keeps a lone high surrogate → renders as U+FFFD →
pi-tui counts it 1 column while WezTerm renders 2 → line over-wide → terminal
wrap → TUI diff-render row misalignment → stacked stale frames on the
dashboard (issue's repro chain).

`truncate` feeds `deriveSummary` (max=80), `events.mjs`
(`latestAssistantPreview`), `evidence.mjs`, `auto-state.mjs` — all display
text paths.

## Decision (fix direction A, repo-side)

Two changes inside `truncate`:

1. **Code-point-safe cut (cut-point back-off, NOT code-point budget).** Keep
   the existing UTF-16 unit budget `n` (all callers pass display budgets; CJK
   chars occupy 2 units — switching to a code-point count would double the
   effective width of CJK summaries from 80 to ~160 columns and *reintroduce*
   over-wide lines). Instead: if the character just before the cut point is a
   high surrogate whose low surrogate is the first dropped unit, back the cut
   off by one unit so the pair stays whole. Output length only shrinks by one
   unit in that rare case; the ellipsis still fits the budget.

2. **Defensive lone-surrogate strip on output.** Input text (from agent
   output stored in status.json) may already contain lone surrogates; strip
   them from the returned string on both the short path and the truncated
   path (`/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g` and the mirrored
   low-surrogate regex).

Out of scope (per goal boundary): pi-tui width-table changes for Ambiguous
characters (fix direction B) and terminal-side clamping (direction C) —
upstream/external. Completion here = truncate no longer produces or passes
through lone surrogates; "visual overlap fully gone" additionally depends on
those upstream items.

## Non-goals

- No `Intl.Segmenter` grapheme segmentation (ZWJ emoji families remain
  multi-codepoint; the defect being fixed is lone surrogates, not grapheme
  splitting).
- No caller changes; no width-function changes.

## Acceptance matrix

| ID | Feature point | Acceptance | Concrete verification | Pass criteria |
|----|---------------|------------|----------------------|---------------|
| A1 | Cut never splits a surrogate pair | Automated (unit) | New tests in `test/heuristics.test.mjs`: e.g. `truncate("a👍b", 3) === "a…"` (back-off) and a long-string case whose cut lands on an emoji; assert output matches `/\uD83D$/` never (no trailing lone high surrogate) | Tests pass |
| A2 | Output is lone-surrogate-free even when input isn't | Automated (unit) | `truncate("ab\ud83d", 10) === "ab"`, `truncate("ab\udc4dzzzzzzzzzz", 5)` has no lone low surrogate | Tests pass |
| A3 | Existing behavior preserved for ASCII and CJK | Automated (unit) | Existing tests unchanged (`truncate("hello world", 5) === "hell…"`) + new: `truncate("一二三四五", 5) === "一二…"` (2-unit budget semantics kept) | Tests pass |
| A4 | Full regression | Automated (integration) | Full `npm test` | All green |
| A5 | Scope | Automated (static) | `git diff main -- src/ test/` | Only `src/core/heuristics.mjs` (truncate) and `test/heuristics.test.mjs` |

## Testability split design

`truncate` is already a pure exported function — tests exercise it directly
at unit level. Two internal helpers (back-off check, lone-surrogate strip)
stay private; they are covered through truncate's public behavior at the
exact boundaries (cut on high surrogate, lone surrogate in input on both
paths).
