# Spec: Rename state labels — needs_input → "Needs answer", idle → "Needs instructions"

- **Issue**: zhuxixi/pi-agent-board#15
- **Date**: 2026-08-22
- **Status**: approved (2026-08-22) — implemented on branch issue-15-rename-state-labels
- **Type**: display-only rename, no data-model change

## 1. Problem

Dashboard semantic-state labels mislead. `idle` shows as "In Progress" but means *run ended, nothing asked, not confidently done* — the opposite of active work implied next to "Running". `needs_input` shows as "Needs input" but its distinct user action is *answering an explicit question*. The header collides lexically: needs_input counts read "awaiting input" while idle rows group under "In Progress".

History (research): upstream `5c67518` renamed idle "Idle" → "In Progress" and introduced the legacy-text normalization mechanism; `99691e1` later made idle the auto-state classifier's "ended but not done" bucket, at which point the label started systematically misleading. Issue #14 (open) will make idle the default terminal bucket, increasing exposure.

## 2. Goals

- Each waiting state's label names the user action it waits for:
  - `needs_input` → **"Needs answer"** — agent asked a question; it needs your reply.
  - `idle` → **"Needs instructions"** — run ended cleanly; it needs your next directive (follow-up, new task, or mark-done).
- Header needs_input stage reads "needs answer" (compact "answer") — no "awaiting" wording for needs_input, so "awaiting"-family ambiguity disappears.
- Persisted rows display the new labels with zero migration.

## 3. Non-goals

- No changes to `SEMANTIC_STATES` internal names, store schemas (`meta.json`/`state.json`/`status.json`), state transitions, or the auto-state classifier internals — that is issue #14's scope.
- No changes to historical docs (`PRD.md`, `IMPLEMENTATION_PLAN.md`) — they are point-in-time records.
- No i18n layer.

## 4. Design

### 4.1 Label sources (code changes)

| File | Change |
|---|---|
| `src/core/types.mjs` | `GROUP_LABELS.needs_input: "Needs input"` → `"Needs answer"`; `GROUP_LABELS.idle: "In Progress"` → `"Needs instructions"` |
| `src/core/derive.mjs` | `fallbackStatusText("needs_input")` → `"Needs answer"`; `fallbackStatusText("idle")` → `"Needs instructions"` |
| `src/runtime/service.mjs` (~L961) | reconciled-host summary `"In Progress"` → `"Needs instructions"` |
| `src/ui/dashboard.ts` (~L926) | placeholder row summary `"In Progress"` → `"Needs instructions"` |
| `src/ui/dashboard.ts` (~L1755) | headerStageSummary needs_input part: `"awaiting input"`/`"awaiting"` → `"needs answer"`/`"answer"` |
| `README.md` (L65) | state list: `Needs answer`, `Needs instructions` |

Stage headers render via `renderStageHeader` → `label.toUpperCase()`: displays "NEEDS ANSWER" / "NEEDS INSTRUCTIONS".

### 4.2 Backward compatibility (reuse the 5c67518 pattern)

`GENERIC_STATUS_TEXT` in `derive.mjs` is the recognized-legacy set consumed by `normalizeGenericStatusText(state, text)`, which `rowView()` (`rows.mjs`) applies at render time. Extend the sets; never shrink them:

```js
needs_input: new Set(["Needs input", "Needs answer"]),
idle: new Set(["Idle", "In Progress", "Needs instructions"]),
```

Effect: rows persisted with any historical generic summary ("Idle", "In Progress", "Needs input") auto-display the current label. Non-generic summaries (real question text, error text) pass through untouched. No data migration, no store write.

### 4.3 Auto-following surfaces (verify only)

- Delete-confirm prompt and notices use `GROUP_LABELS[state].toLowerCase()` → "delete 3 needs instructions sessions?" (grammar acceptable).
- Filter aliases (`rows.mjs`) = `[stateName, GROUP_LABELS[state]]` → "needs answer", "idle", "needs instructions" match; "in progress" stops matching (accepted; state name "idle" still matches).
- Peek panel and header counts render derived values only.

### 4.4 Tests

Update string expectations:
- `test/derive.test.mjs:96-97` — fallbackStatusText for both states.
- `test/rows.test.mjs:87` — rowView normalization (legacy "Idle" → "Needs instructions").
- `test/service.test.mjs` (~L334) — summary assertions touching "Needs input".

Add normalization coverage:
- legacy "In Progress" → "Needs instructions"; legacy "Needs input" → "Needs answer" (render-level, via rowView).
- New fallback values appear for fresh runs.

## 5. Error handling / edge cases

- Old dashboard process + new code reading same store: summaries normalize on read; safe.
- Rows whose summary was manually set to a non-generic string: untouched (pass-through preserved).
- Classifier (`auto-state.mjs`) and steering prompts use internal kind names (`needs_input`/`in_progress`/`done`), not display labels — unaffected.

## 6. Verification

- `npm run verify` (project's standard gate) with updated tests.
- Manual: open dashboard with pre-existing rows carrying old summaries → group headers and row summaries show new labels; header shows "needs answer".
