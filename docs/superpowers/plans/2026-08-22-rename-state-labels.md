# Rename State Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename dashboard state labels so each waiting state names the user action it waits for: `needs_input` → "Needs answer", `idle` → "Needs instructions", plus header wording "awaiting input" → "needs answer".

**Architecture:** Display-only rename riding the existing label pipeline: `GROUP_LABELS` (group headers, confirm prompts, filter aliases) and `fallbackStatusText` (row summaries) are the two label sources; persisted summaries normalize at render time via `normalizeGenericStatusText` + `GENERIC_STATUS_TEXT` legacy sets, so old rows migrate visually with zero data writes.

**Tech Stack:** Node.js ESM (`.mjs`) core + TypeScript UI file, `node --test` test runner, JSDoc typedefs.

## Global Constraints

- No changes to `SEMANTIC_STATES`, store schemas, state transitions, or classifier internals (issue #14's scope).
- `GENERIC_STATUS_TEXT` sets only ever GROW — "Needs input", "Idle", "In Progress" must remain recognized legacy texts.
- Do NOT edit `PRD.md` or `IMPLEMENTATION_PLAN.md` (historical point-in-time docs).
- Commit messages in English, conventional-commits format; stage files explicitly (never `git add -A`).
- All work happens in the worktree `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-15-rename-state-labels` (branch `issue-15-rename-state-labels`). Never touch the main checkout.
- Exact new labels: `"Needs answer"` (needs_input), `"Needs instructions"` (idle), header `"needs answer"` / compact `"answer"`.

---

### Task 1: Core label constants and normalization (types.mjs, derive.mjs)

**Files:**
- Modify: `src/core/types.mjs:65,70` (`GROUP_LABELS`)
- Modify: `src/core/derive.mjs:19-20,52-54` (`GENERIC_STATUS_TEXT`, `fallbackStatusText`)
- Test: `test/derive.test.mjs:92-98`, `test/rows.test.mjs:85-88`

**Interfaces:**
- Consumes: none (leaf change).
- Produces: `GROUP_LABELS.needs_input === "Needs answer"`, `GROUP_LABELS.idle === "Needs instructions"`; `fallbackStatusText("needs_input") === "Needs answer"`, `fallbackStatusText("idle") === "Needs instructions"`; `normalizeGenericStatusText` recognizes "Needs input" → needs_input label, {"Idle","In Progress"} → idle label.

- [ ] **Step 1: Update the failing tests**

In `test/derive.test.mjs`, extend the import (line 3) and replace/extend the fallback test:

```js
import { deriveSummary, fallbackStatusText, finalizeSemanticState, normalizeGenericStatusText } from "../src/core/derive.mjs";
```

```js
test("fallbackStatusText", () => {
	assert.equal(fallbackStatusText("queued"), "Queued");
	assert.equal(fallbackStatusText("working"), "Running…");
	assert.equal(fallbackStatusText("needs_input"), "Needs answer");
	assert.equal(fallbackStatusText("idle"), "Needs instructions");
});

test("normalizeGenericStatusText maps legacy labels to current ones", () => {
	assert.equal(normalizeGenericStatusText("idle", "Idle"), "Needs instructions");
	assert.equal(normalizeGenericStatusText("idle", "In Progress"), "Needs instructions");
	assert.equal(normalizeGenericStatusText("needs_input", "Needs input"), "Needs answer");
	assert.equal(normalizeGenericStatusText("idle", "Custom summary"), "Custom summary");
});
```

In `test/rows.test.mjs`, replace the existing normalization test (lines 85-88) with:

```js
test("rowView normalizes generic status labels to current display names", () => {
	assert.equal(rowView(row("a", "working", { summary: "Working…" }), 0).summary, "Running…");
	assert.equal(rowView(row("b", "idle", { summary: "Idle" }), 0).summary, "Needs instructions");
	assert.equal(rowView(row("c", "idle", { summary: "In Progress" }), 0).summary, "Needs instructions");
	assert.equal(rowView(row("d", "needs_input", { summary: "Needs input" }), 0).summary, "Needs answer");
});
```

(`row(id, state, overrides)` is the existing test helper in that file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-15-rename-state-labels && npm ci --no-audit --no-fund && node --test test/derive.test.mjs test/rows.test.mjs`
Expected: FAIL — fallbackStatusText/rowView assertions return "Needs input"/"In Progress". (Skip `npm ci` if node_modules already exists.)

- [ ] **Step 3: Implement**

`src/core/types.mjs` — in `GROUP_LABELS`:

```js
needs_input: "Needs answer",
```
```js
idle: "Needs instructions",
```

`src/core/derive.mjs` — legacy sets (keep old entries, add new):

```js
needs_input: new Set(["Needs input", "Needs answer"]),
idle: new Set(["Idle", "In Progress", "Needs instructions"]),
```

`fallbackStatusText` cases:

```js
		case "needs_input":
			return "Needs answer";
		case "idle":
			return "Needs instructions";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/derive.test.mjs test/rows.test.mjs`
Expected: PASS (all tests in both files).

- [ ] **Step 5: Commit**

```bash
git add src/core/types.mjs src/core/derive.mjs test/derive.test.mjs test/rows.test.mjs
git commit -m "feat: rename needs_input/idle labels to Needs answer/Needs instructions (issue #15)"
```

### Task 2: Call-site labels and header wording (service.mjs, dashboard.ts, README)

**Files:**
- Modify: `src/runtime/service.mjs:961` (reconciled-host summary)
- Modify: `src/ui/dashboard.ts:926` (compat-guard blank state summary), `src/ui/dashboard.ts:1757` (header stage part)
- Modify: `README.md:65` (state list)
- Test: none new — grep-confirmed zero test assertions on these exact strings; suite must stay green.

**Interfaces:**
- Consumes: Task 1 label values (only literals here; no imports of the strings).
- Produces: none.

- [ ] **Step 1: Edit the four call sites**

`src/runtime/service.mjs` (~L961, inside `reconcile()`):
```js
s.summary = failed ? "Failed (PTY host exited)" : "Needs instructions";
```

`src/ui/dashboard.ts` (~L926, blank-state compat guard):
```js
			summary: "Needs instructions",
```

`src/ui/dashboard.ts` (~L1757, `headerStageSummary`):
```js
		headerStagePart(theme, "needs_input", counts.needs, compact ? "answer" : "needs answer"),
```

`README.md` (L65):
```markdown
- Watch rows move through `Queued`, `Running`, `Needs answer`, `Needs instructions`, `Done`, `Failed`, and `Stopped`.
```

- [ ] **Step 2: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — `node --test test/*.test.mjs` all green, `tsc --noEmit` clean.

- [ ] **Step 3: Commit**

```bash
git add src/runtime/service.mjs src/ui/dashboard.ts README.md
git commit -m "feat: apply Needs answer/Needs instructions wording to service, header, and README (issue #15)"
```

### Task 3: Full verification gate

**Files:**
- Modify: none (verification only; fix and amend-with-new-commit if anything fails).

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: verified branch ready for review.

- [ ] **Step 1: Run the project's standard gate**

Run: `npm run verify`
Expected: typecheck + full test suite + pack:dry all pass.

- [ ] **Step 2: Sweep for stale label strings**

Run: `grep -rn '"In Progress"' src/ README.md; grep -rn 'awaiting input' src/`
Expected: "In Progress" appears ONLY in `src/core/derive.mjs` legacy set; "awaiting input" zero hits.

- [ ] **Step 3: Confirm clean tree**

Run: `git status --short && git log --oneline main..HEAD`
Expected: clean tree; commits = spec + task 1 + task 2.
