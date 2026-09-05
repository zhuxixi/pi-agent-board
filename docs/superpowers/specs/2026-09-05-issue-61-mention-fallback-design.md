# Spec: issue #61 — mention fallback lifts placeholder numbers (no left-boundary guard, kind-blind, code-span-blind)

## Problem

The Rule 6 bare `#N` mention fallback (`src/core/code-refs.mjs`
`mentionFallback`, L767) misfires on internal-platform sessions: the real
work object was internal issue `#18` (only `acli` commands — no builtin rules
for that CLI), while a skill doc's example placeholder `#1378` won the
fallback and was written into `github.json` as the session's issue
(`strength: mention, confidence: low`).

Four gaps (issue G1-G4):

- **G2** `MENTION_RE = /#(\d{1,7})/g` has no left boundary: `##1378`
  (markdown heading / double-hash typo) still matches `#1378` as a substring.
- **G4** mention counting does not distinguish prose from inline code spans:
  `` `monitor pr #1378` `` (a doc example) counts the same as a real
  reference.
- **G3** counting is kind-blind: `monitor pr #1378` — explicitly PR context —
  feeds the *issue* candidate.
- **G1** no documented `providers.json` example for internal-platform CLIs,
  so such sessions systematically slide into the fallback at all.

## Decision (issue's fixes 1-4)

In `src/core/code-refs.mjs`:

1. **Left-boundary guard (G2):** `MENTION_RE = /(?<![#\w])#(\d{1,7})/g` —
   rejects a preceding `#` or word character; `#18`, `( #18 )`, `text #18`
   still match.
2. **Code-span exclusion (G4):** before counting, strip inline code spans
   from each assistant text (`text.replace(/`[^`\n]*`/g, " ")`).
3. **Kind-aware counting (G3):** for each surviving match, inspect a small
   window before the match (16 chars); if it contains a standalone
   `pr|pull|mr|merge` token (case-insensitive, word-bounded), the match does
   not count toward the issue fallback (PR-context numbers must not lift an
   issue). Dropped, not reclassified — the fallback is issue-only by design;
   fabricating a PR mention candidate is out of scope.
4. **Docs (G1):** README "Evidence and Code References" gains a compact
   `providers.json` example: an internal-platform provider with a claim
   strength rule (e.g. `acli issue update #N --assignee`) and a hosts entry,
   so users can configure claim/action rules in five minutes and such
   sessions stop depending on the fallback at all.

## Non-goals

- No new builtin rules for any specific internal CLI (that's per-user config).
- No PR-side mention fallback (issue-only fallback stays).
- No fenced-block stripping (assistantTexts are prose; inline spans are the
  observed vector).

## Acceptance matrix

| ID | Feature point | Acceptance | Concrete verification | Pass criteria |
|----|---------------|------------|----------------------|---------------|
| A1 | Left boundary guard | Automated (unit) | New tests: `##1378` and `a#1`-style texts produce no mention winner; plain `#18` texts still win | Tests pass |
| A2 | Code-span exclusion | Automated (unit) | `` `monitor pr #1378` `` inside backticks contributes zero counts | Tests pass |
| A3 | Kind-aware skip | Automated (unit) | Prose `monitor pr #1378` ×5 does not produce an issue winner | Tests pass |
| A4 | Issue repro shape regresses fixed | Automated (unit) | Composite fixture: placeholder `#1378` only in guarded forms (heading / code span / pr-context) + real `#18` prose ×3 → winner is 18; without the `#18` prose → no winner | Tests pass |
| A5 | Existing fallback behavior preserved | Automated (unit + integration) | Existing tests ("picks #40 (5x) over #7 (2x)", "no winner when tied") unchanged and green; full `npm test` green | All green |
| A6 | providers.json example documented | Automated (static) | README Evidence section contains a valid `providers.json` example with a claim rule for an internal CLI + `hosts` | grep + render check |
| A7 | Scope | Automated (static) | `git diff main -- src/ README.md test/` | Only `src/core/code-refs.mjs` (MENTION_RE + mentionFallback), README Evidence section, and `test/code-refs-extract.test.mjs` |

## Testability split design

`mentionFallback` is exercised through the public `extractCodeRefs` (same
seam as all existing mention tests) — no new export needed. Guards are pure
regex/substring logic on the existing pure function; each gap gets one
focused test plus one composite repro test (A4). The providers.json example
is docs; its JSON validity is asserted by pasting it through
`validateProvider` in a unit test (bonus guard, cheap).
