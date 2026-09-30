# Holding Semantic State + Manual-Fence Lift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 8th semantic state `holding` (manual-only, on-hold) and fix the manual-fence regression where user input on a verdict row never lifts the fence (row shows Done/On hold while the agent runs).

**Architecture:** Two deliverables in one branch. F-hold adds a vocabulary entry, two fenced command kinds (`mark_holding`/`clear_holding`), a widened manual-verdict predicate, and UI (`h` toggle). F-lift switches the `sync_foreground` mirror's source to `dashboard-user` when the child Pi reports `InputEvent.source === "interactive"` — no new command kind, verified to pass exactly one guard (manual_fence).

**Tech Stack:** Node.js 20+ ESM (.mjs) with JSDoc types, TypeScript dashboard (`src/ui/dashboard.ts`, typecheck via `npm run typecheck`), `node:test` + `assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-29-issue-145-holding-semantic-state-design.md` — the plan argues from the spec; executors read both. Acceptance IDs (A1–A21, U1–U7) below refer to the spec's §9 matrix.

## Global Constraints

- Indentation: **tabs**. Comments and commit messages: **English**.
- Commit subjects: conventional (`feat`/`fix`/`test`/`docs`/`refactor`/`chore`), ending with `(issue #145)`; the PR number `(#N)` is appended at merge time per repo convention.
- `npm run verify` (typecheck + perf gate + tests + coverage thresholds lines 85 / funcs 80 / branches 70 + pack:dry) must pass before the branch is called done — `npm test` alone is NOT sufficient.
- Never hand-edit `CHANGELOG.md` (machine-generated from commit subjects by release tooling).
- Naming discipline (spec §4.7): no bare `hold` identifier anywhere — always `holding` / `isHolding` / `markHolding` / `toggleHold`. Comments say "on-hold semantic state", never a bare "hold" (the attach subsystem owns that word for its jiggle protocol).
- `COORDINATOR_PROTOCOL_VERSION` must be 3 before any `mark_holding`/`clear_holding` command is sent (Task 5; a live v2 coordinator answers `unknown_kind` silently — issue #108 class).
- Tests use `node:test` + `assert/strict`; anything touching git/fs gets a self-contained fixture under a temp dir. Never mutate `~/.pi/agent/agent-board` from tests.
- All work happens in this worktree (`$WT`); never touch the main checkout.

## Review Focus

Five failure modes the spec implies but individual happy-path tests don't exercise. Each is pinned to the task that owns the code:

1. **A live pre-upgrade coordinator silently rejects the new kinds** (`unknown_kind`, warn-level diagnostics only, holding writes vanish). Pinned: Task 5 asserts `COORDINATOR_PROTOCOL_VERSION >= 3` and Task 12 runs the full coordinator-client suite.
2. **A late `auto_state_classified` overwrites the user's on-hold verdict** (the #46 invariant must survive the predicate rename — a missed call site is exactly the silent clobber). Pinned: Task 6's fence test on a holding row + Task 12 keeps `test/state-coordinator.integration.test.mjs` green (A17).
3. **`reconcile()` finalizes a holding row to failed/idle after its host dies** (user loses the verdict to a recovery pass). Pinned: Task 7's reconcile-leaves-holding-untouched test.
4. **The follow-up queue auto-wakes an on-hold row** (violates "holding 不参与自动续跑"). Pinned: Task 3's `canAutoDrain` state matrix (holding false, idle/completed true — the allow-list must not become a deny-list).
5. **Programmatic input (`rpc`/`extension`) wrongly lifts the fence** (an automated injection must not clear a human verdict). Pinned: Task 8's negative tests.

---

### Task 1: Vocabulary layer — types, glyphs, colors, fallback text, STAGE_RGB

**Acceptance:** A9, A10, A11 (spec §9). Also unblocks typecheck for every later task.

**Files:**
- Modify: `src/core/types.mjs:6`, `:14`, `:40`, `:53`, `:64`
- Modify: `src/core/rows.mjs:67` (`stateGlyph`), `:93` (`stateColor`)
- Modify: `src/core/derive.mjs:16` (`GENERIC_STATUS_TEXT`), `:46` (`fallbackStatusText`)
- Modify: `src/ui/dashboard.ts:1920` (`STAGE_RGB`)
- Test: `test/rows.test.mjs`, `test/derive.test.mjs`

**Interfaces:**
- Consumes: none (first task).
- Produces: `"holding"` valid everywhere `SemanticState` is expected; `GROUP_LABELS.holding === "On hold"`; `GROUP_ORDER` = `… idle, holding, completed …`. Later tasks rely on `"holding"` typechecking.

- [ ] **Step 1: Write the failing tests**

In `test/rows.test.mjs` (after the existing glyph tests):

```js
test("holding renders with dedicated glyph/color and filters unambiguously (issue #145)", () => {
	assert.notEqual(stateGlyph("holding", false), "?", "stateGlyph must not fall through to default");
	assert.notEqual(stateColor("holding"), "text", "stateColor must not fall through to default");
	for (const q of ["s:hold", "s:onhold", "s:on", "s:holding"]) {
		assert.deepEqual(parseFilter(q).states, ["holding"], `${q} must match only holding`);
	}
});

test("GROUP_ORDER places holding between idle and completed (issue #145)", () => {
	assert.equal(GROUP_ORDER.indexOf("idle") + 1, GROUP_ORDER.indexOf("holding"));
	assert.equal(GROUP_ORDER.indexOf("holding") + 1, GROUP_ORDER.indexOf("completed"));
	assert.equal(GROUP_LABELS.holding, "On hold");
});
```

Add `GROUP_ORDER`, `GROUP_LABELS`, `parseFilter` to the file's existing import from `../src/core/rows.mjs` / `../src/core/types.mjs` (check what's already imported; extend, don't duplicate).

In `test/derive.test.mjs`:

```js
test("fallbackStatusText maps holding and recognizes it as generic (issue #145)", () => {
	assert.equal(fallbackStatusText("holding"), "On hold");
	assert.equal(isGenericStatusText("On hold"), true);
});
```

(`isGenericStatusText` is exported from `src/core/derive.mjs`; verify the export name and extend the import.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/rows.test.mjs test/derive.test.mjs`
Expected: FAIL — `stateGlyph("holding")` returns `"?"`, `parseFilter("s:hold").states` is `[]`, `GROUP_LABELS.holding` undefined.

- [ ] **Step 3: Implement**

`src/core/types.mjs`:

```js
// :6 — add "holding" to the hand-written union (second vocabulary; the spec flags this)
/** Semantic (task) state of a row. @typedef {"queued"|"working"|"needs_input"|"idle"|"holding"|"completed"|"failed"|"stopped"} SemanticState */
// :14 — EvidenceOutcome gains "holding" (the table already lists every other semantic state)
/** Evidence outcome. @typedef {"unknown"|"in_progress"|"ready"|"needs_input"|"failed"|"stopped"|"queued"|"working"|"idle"|"holding"|"completed"} EvidenceOutcome */
```

`SEMANTIC_STATES` (`:40`) and `GROUP_ORDER` (`:53`): insert `"holding",` on its own line directly after `"idle",`.

`GROUP_LABELS` (`:64`): add `holding: "On hold",` after the `idle:` entry.

`src/core/rows.mjs` — `stateGlyph` switch, after `case "idle":`:

```js
		case "holding":
			return unread ? "◒" : "◑";
```

`stateColor` switch, after `case "idle":`:

```js
		case "holding":
			return "warning";
```

`src/core/derive.mjs`:

```js
// GENERIC_STATUS_TEXT — grow-only table; holding owns its label
	holding: new Set(["On hold"]),
// fallbackStatusText switch, after case "idle":
		case "holding":
			return "On hold";
```

`src/ui/dashboard.ts` `STAGE_RGB` — insert after the `idle` line (amber, distinct from needs_input's `[245, 158, 11]`):

```ts
	holding: [251, 191, 36],
```

- [ ] **Step 4: Run tests + typecheck**

Run: `node --test test/rows.test.mjs test/derive.test.mjs && npm run typecheck`
Expected: PASS + typecheck clean (the `satisfies Record<keyof typeof GROUP_LABELS, …>` guard on `STAGE_RGB` is what makes the omission impossible).

- [ ] **Step 5: Commit**

```bash
git add src/core/types.mjs src/core/rows.mjs src/core/derive.mjs src/ui/dashboard.ts test/rows.test.mjs test/derive.test.mjs
git commit -m "feat: add holding to the semantic-state vocabulary (issue #145)"
```

---

### Task 2: `isManualVerdict` predicate

**Acceptance:** A1.

**Files:**
- Modify: `src/core/auto-state.mjs` (add `isManualVerdict` next to `isManualCompletion` — the old export is deleted in Task 6, keeping this task green)
- Test: `test/auto-state.test.mjs`

**Interfaces:**
- Produces: `isManualVerdict(state) -> boolean` — true iff `semanticState ∈ {"completed","holding"}` AND `autoState == null`. Task 4/6/8 consume it.

- [ ] **Step 1: Write the failing test**

Replace the existing `isManualCompletion distinguishes…` test (`test/auto-state.test.mjs:148-153`) with:

```js
test("isManualVerdict recognizes both manual verdict states (issue #145)", () => {
	assert.equal(isManualVerdict({ semanticState: "completed", autoState: null }), true);
	assert.equal(isManualVerdict({ semanticState: "holding", autoState: null }), true);
	assert.equal(isManualVerdict({ semanticState: "completed", autoState: { kind: "done" } }), false);
	assert.equal(isManualVerdict({ semanticState: "holding", autoState: { kind: "done" } }), false);
	assert.equal(isManualVerdict({ semanticState: "idle", autoState: null }), false);
	assert.equal(isManualVerdict(null), false);
});
```

Add `isManualVerdict` to the import from `../src/core/auto-state.mjs`. **Do not delete the `isManualCompletion` import/test yet** — 14 call sites still use it (Task 6).

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/auto-state.test.mjs`
Expected: FAIL — `isManualVerdict is not a function`.

- [ ] **Step 3: Implement**

In `src/core/auto-state.mjs`, directly above `isManualCompletion`:

```js
/**
 * Whether a row/status carries a manual verdict (issue #145): the user placed a
 * terminal judgment ("completed" or "holding") that no automated writer may
 * overwrite. mark_completed and mark_holding both clear autoState on
 * state.json and status.json, so `autoState == null` combined with a verdict
 * state is the persisted signal. Supersedes isManualCompletion (no call site
 * needs the narrow completed-only form — spec D15).
 * @param {{ semanticState?: string, autoState?: unknown|null }|null|undefined} state
 */
export function isManualVerdict(state) {
	return Boolean(state && (state.semanticState === "completed" || state.semanticState === "holding") && state.autoState == null);
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/auto-state.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/auto-state.mjs test/auto-state.test.mjs
git commit -m "feat: add isManualVerdict covering completed and holding (issue #145)"
```

---

### Task 3: Migrate `canAutoDrain` to a pure exported predicate

**Acceptance:** A8 (drain half), Review Focus #4.

**Files:**
- Modify: `src/core/warm-host-sweeper.mjs` (add `canAutoDrain`)
- Modify: `src/runtime/service.mjs:56` (import), `:2278-2281` (delete local)
- Test: `test/warm-host-sweeper.test.mjs`

**Interfaces:**
- Produces: `canAutoDrain(row) -> boolean` exported from `src/core/warm-host-sweeper.mjs`. Expression is byte-identical to the current private one: `!isAgentBusy(row) && (st === "idle" || st === "completed")`.

- [ ] **Step 1: Write the failing test**

In `test/warm-host-sweeper.test.mjs`:

```js
test("canAutoDrain is an allow-list that excludes holding (issue #145)", () => {
	const row = (semanticState, alive = false) => ({
		alive,
		state: { semanticState, processState: alive ? "alive" : "exited", pendingQuestions: [] },
	});
	assert.equal(canAutoDrain(row("holding")), false, "a user's on-hold verdict must never be woken by the queue");
	assert.equal(canAutoDrain(row("idle")), true);
	assert.equal(canAutoDrain(row("completed")), true);
	assert.equal(canAutoDrain(row("failed")), false);
	assert.equal(canAutoDrain(row("stopped")), false);
	assert.equal(canAutoDrain(row("needs_input")), false);
	assert.equal(canAutoDrain(row("working", true)), false);
});
```

Add `canAutoDrain` to the existing import from `../src/core/warm-host-sweeper.mjs`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/warm-host-sweeper.test.mjs`
Expected: FAIL — no such export.

- [ ] **Step 3: Implement**

In `src/core/warm-host-sweeper.mjs`, after `isAgentBusy`:

```js
/**
 * Whether queued follow-ups may auto-drain for this row (issue #145).
 * Deliberately an allow-list: a manual verdict state outside {idle, completed}
 * (today: holding) must never be woken by the follow-up queue — only the user
 * resumes it. Pure row predicate; co-located with isAgentBusy, which it
 * composes, so both share this unit-test home.
 * @param {import("./store.mjs").Row} row
 */
export function canAutoDrain(row) {
	const st = row.state?.semanticState;
	return !isAgentBusy(row) && (st === "idle" || st === "completed");
}
```

In `src/runtime/service.mjs`:
- `:56` — extend to `import { canAutoDrain, hasPendingQuestions, isAgentBusy, selectIdleHostsToEvict } from "../core/warm-host-sweeper.mjs";`
- Delete the local `function canAutoDrain(row) { … }` at `:2278-2281` (including its JSDoc, if any).

- [ ] **Step 4: Run tests**

Run: `node --test test/warm-host-sweeper.test.mjs test/host-input.test.mjs`
Expected: PASS (host-input's drain-gate tests must stay green — same expression, new home).

- [ ] **Step 5: Commit**

```bash
git add src/core/warm-host-sweeper.mjs src/runtime/service.mjs test/warm-host-sweeper.test.mjs
git commit -m "refactor: export canAutoDrain as a pure row predicate (issue #145)"
```

---

### Task 4: Command kinds `mark_holding` / `clear_holding` + `source_not_allowed`

**Acceptance:** A2, A3, A4, A5 (decision layer).

**Files:**
- Modify: `src/core/state-commands.mjs` — `DECIDED_REJECT_REASONS:71`, `STATE_COMMAND_KINDS:36`, new branches after `mark_completed` (`:284-304`)
- Test: `test/state-commands.test.mjs`

**Interfaces:**
- Consumes: `isManualCompletion` for the generic fence (unchanged this task — widening happens in Task 6).
- Produces: kinds `mark_holding`, `clear_holding`; reject reason `source_not_allowed`. Both apply a full field-set patch (idempotent under the coordinator's sparse `{...state, ...mutate.state}` merge).

- [ ] **Step 1: Update the vocabulary snapshot, then write the failing tests**

`test/state-commands.test.mjs:53-58` — the snapshot becomes:

```js
	assert.deepEqual([...STATE_COMMAND_KINDS], [
		"mark_completed", "mark_holding", "clear_holding", "auto_state_classified", "run_finalized",
		"mark_queued", "run_started", "run_progress", "reconcile_finalize",
		"host_run_failed", "archive_view", "adopt_session", "sync_foreground",
		"plan_ready", "followup_started", "patch_fields",
	]);
```

New tests (place after the `-- mark_completed --` block; `manualCompletedState` is the existing fixture — copy its spread pattern):

```js
// -- mark_holding / clear_holding (issue #145) --

test("mark_holding applies a manual-verdict patch mirroring mark_completed", () => {
	const cmd = { ...baseCmd, source: "dashboard-user", kind: "mark_holding", payload: {} };
	const idle = { ...manualCompletedState, semanticState: "idle", autoState: { kind: "in_progress" } };
	const d = decideStateTransition(cmd, idle, null, 20);
	assert.equal(d.action, "apply");
	assert.deepEqual(d.mutate.state, {
		semanticState: "holding",
		processState: "exited",
		needsInput: false,
		hasError: false,
		question: null,
		pendingQuestions: [],
		error: null,
		autoState: null,
	});
	assert.deepEqual(d.mutate.status, { autoState: null });
});

test("mark_holding rejects busy rows and non-user sources independently of the fence", () => {
	const alive = { ...manualCompletedState, semanticState: "idle", processState: "alive", autoState: {} };
	assert.deepEqual(
		decideStateTransition({ ...baseCmd, source: "dashboard-user", kind: "mark_holding" }, alive, null),
		{ action: "reject", reason: "busy" },
	);
	// Unfenced row: proves the source guard is its own rule, not the fence.
	assert.deepEqual(
		decideStateTransition({ ...baseCmd, source: "job-runner", kind: "mark_holding" }, { ...manualCompletedState, semanticState: "idle", autoState: {} }, null),
		{ action: "reject", reason: "source_not_allowed" },
	);
	assert.ok(DECIDED_REJECT_REASONS.has("source_not_allowed"));
});

test("clear_holding resumes to idle; non-holding rows are no_change", () => {
	const holding = { ...manualCompletedState, semanticState: "holding" };
	const d = decideStateTransition({ ...baseCmd, source: "dashboard-user", kind: "clear_holding" }, holding, null, 20);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.semanticState, "idle");
	assert.equal(d.mutate.state.autoState, null);
	assert.deepEqual(
		decideStateTransition({ ...baseCmd, source: "dashboard-user", kind: "clear_holding" }, { ...manualCompletedState }, null),
		{ action: "reject", reason: "no_change" },
	);
});

test("non-user commands stay fenced on a holding row (spec A5)", () => {
	const holding = { ...manualCompletedState, semanticState: "holding" };
	const d = decideStateTransition(baseCmd, holding, null);
	assert.deepEqual(d, { action: "reject", reason: "manual_fence" });
});
```

(The last test mirrors the existing `auto_state_classified rejected when manual fence active` at `:19-22` — `baseCmd` is that same classification command.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/state-commands.test.mjs`
Expected: FAIL — `unknown_kind` / missing reasons.

- [ ] **Step 3: Implement**

`src/core/state-commands.mjs`:

`STATE_COMMAND_KINDS` — insert `"mark_holding",` and `"clear_holding",` right after `"mark_completed",`.

`DECIDED_REJECT_REASONS` — add `"source_not_allowed",` after `"field_not_allowed",` and extend the block comment's reason list.

New branches directly after the `mark_completed` case:

```js
		case "mark_holding": {
			// Manual-only (spec D14): an on-hold verdict is a human judgment; any
			// automated source is rejected before the fence can matter.
			if (command.source !== "dashboard-user") return reject("source_not_allowed");
			if (currentState.processState === "alive") return reject("busy");
			// autoState: null on both artifacts is the manual-verdict fence signal
			// (see isManualVerdict). Full field-set patch: idempotent under the
			// coordinator's sparse merge, mirrors mark_completed's shape.
			return {
				action: "apply",
				reason: "manual_holding",
				mutate: {
					state: {
						semanticState: "holding",
						processState: "exited",
						needsInput: false,
						hasError: false,
						question: null,
						pendingQuestions: [],
						error: null,
						autoState: null,
					},
					status: { autoState: null },
				},
			};
		}
		case "clear_holding": {
			if (command.source !== "dashboard-user") return reject("source_not_allowed");
			if (currentState.semanticState !== "holding") return reject("no_change");
			if (currentState.processState === "alive") return reject("busy");
			// Un-hold returns the row to automated management (idle = the row is
			// waiting for the next directive; queued follow-ups may drain again).
			return {
				action: "apply",
				reason: "manual_resume",
				mutate: {
					state: {
						semanticState: "idle",
						processState: "exited",
						needsInput: false,
						hasError: false,
						question: null,
						pendingQuestions: [],
						error: null,
						autoState: null,
					},
					status: { autoState: null },
				},
			};
		}
```

`runner/state-coordinator.mjs:72` — `LAST_ACTIVITY_STAMP_KINDS` gains both kinds:

```js
const LAST_ACTIVITY_STAMP_KINDS = new Set(["mark_queued", "archive_view", "adopt_session", "reconcile_finalize", "plan_ready", "mark_completed", "mark_holding", "clear_holding", "host_run_failed"]);
```

- [ ] **Step 4: Run tests**

Run: `node --test test/state-commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/state-commands.mjs runner/state-coordinator.mjs test/state-commands.test.mjs
git commit -m "feat: mark_holding and clear_holding command kinds (issue #145)"
```

---

### Task 5: Coordinator protocol version 2 → 3

**Acceptance:** A13. Review Focus #1.

**Files:**
- Modify: `src/core/coordinator-protocol.mjs:12`
- Test: `test/coordinator-client.test.mjs`

**Interfaces:**
- Produces: `COORDINATOR_PROTOCOL_VERSION === 3`. Client-side `ensureCoordinator` already replaces stale instances on `< N`.

- [ ] **Step 1: Write the failing test**

In `test/coordinator-client.test.mjs` (the module already imports `COORDINATOR_PROTOCOL_VERSION`):

```js
test("protocol version gates the holding command kinds (issue #145)", () => {
	// A live v2 coordinator answers unknown_kind for mark_holding/clear_holding
	// (issue #108 class); version 3 is the floor that ships them.
	assert.ok(COORDINATOR_PROTOCOL_VERSION >= 3, `expected >= 3, got ${COORDINATOR_PROTOCOL_VERSION}`);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/coordinator-client.test.mjs`
Expected: FAIL — expected >= 3, got 2.

- [ ] **Step 3: Implement**

`src/core/coordinator-protocol.mjs`:

```js
export const COORDINATOR_PROTOCOL_VERSION = 3;
```

Extend the header comment: `Version 3 adds mark_holding / clear_holding (issue #145).`

- [ ] **Step 4: Run tests**

Run: `node --test test/coordinator-client.test.mjs`
Expected: PASS (the `:371` pong assertion references the constant by name and adapts automatically; the stale-instance tests use a literal `protocolVersion: 1` and are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/core/coordinator-protocol.mjs test/coordinator-client.test.mjs
git commit -m "feat: bump coordinator protocol to 3 for holding kinds (issue #145)"
```

---

### Task 6: Widen the fence — migrate 14 call sites to `isManualVerdict`, delete `isManualCompletion`

**Acceptance:** A5 (fence via renamed predicate), A6, A7. Review Focus #2.

**Files:**
- Modify: `src/core/auto-state.mjs` (`:214`, `:239` call sites; delete `isManualCompletion` at `:200`)
- Modify: `src/core/state-commands.mjs:31` (import), `:280` (guard)
- Modify: `src/runtime/service.mjs:12` (import), `:1466`, `:1501`
- Modify: `runner/state-runner.mjs:12` (import), `:34`
- Modify: `runner/job-runner.mjs:21` (import), `:187`, `:235`, `:240`, `:471`, `:501`, `:659`, `:680`, `:714`
- Test: `test/auto-state.test.mjs`

**Interfaces:**
- Consumes: `isManualVerdict` (Task 2).
- Produces: `isManualCompletion` **no longer exists** — this is deliberate (spec D15): a missed call site becomes a typecheck/import error instead of a silent clobber.

- [ ] **Step 1: Write the failing tests**

In `test/auto-state.test.mjs`:

```js
test("the auto-state rules never overwrite a holding verdict (spec A6)", () => {
	const classification = { kind: "needs_input", confidence: "high", source: "model", reason: "asks", question: "Q?", classifiedAt: 5 };
	const state = { viewId: "v", processState: "exited", semanticState: "holding", autoState: null, question: null, pendingQuestions: [], summary: "s" };
	assert.equal(applyAutoStateToViewState(state, classification, 6), false);
	assert.equal(state.semanticState, "holding");
	const status = { viewId: "v", processState: "exited", semanticState: "holding", autoState: null, question: null, summary: "s" };
	assert.equal(applyAutoStateToStatus(status, classification, 6), false);
	assert.equal(status.semanticState, "holding");
});

test("semanticStateForAutoKind never yields holding (spec A7)", () => {
	for (const kind of ["needs_input", "in_progress", "done"]) {
		assert.notEqual(semanticStateForAutoKind(kind), "holding");
	}
});
```

Add `semanticStateForAutoKind` to the import if absent.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/auto-state.test.mjs`
Expected: FAIL — the holding row gets overwritten (`false`/`"needs_input"` mismatch) because the guards still use the narrow predicate.

- [ ] **Step 3: Implement — mechanical rename, file by file**

In every listed file: change the import `isManualCompletion` → `isManualVerdict`, then rename each call site. Comments that say "manual completion" where they mean "manual verdict" get their wording updated in the same pass (e.g. `src/core/state-commands.mjs:278-279` becomes "Manual verdicts are user judgments…"; `runner/job-runner.mjs:499-500` "A manual verdict racing the exit chain…"). **Do not** reword comments that genuinely mean completed (there are none — verified in spec research round 2, table §4).

Then delete `isManualCompletion` from `src/core/auto-state.mjs` and remove any now-unused test import references.

Sanity net: `rg -n "isManualCompletion" src/ runner/ test/` must return **zero** hits after this step.

- [ ] **Step 4: Run tests + typecheck**

Run: `node --test test/auto-state.test.mjs test/state-commands.test.mjs && npm run typecheck`
Expected: PASS + zero dangling references (a missed site fails the import resolution, not silently).

- [ ] **Step 5: Commit**

```bash
git add src/core/auto-state.mjs src/core/state-commands.mjs src/runtime/service.mjs runner/state-runner.mjs runner/job-runner.mjs test/auto-state.test.mjs
git commit -m "refactor: widen the manual fence to isManualVerdict across all call sites (issue #145)"
```

---

### Task 7: Service layer — `holdView` / `clearHoldView` + direct-write fallbacks

**Acceptance:** feeds A21/U1/U2/U5; Review Focus #3; documents D4 (markCompletedMany on holding).

**Files:**
- Modify: `src/runtime/service.mjs` — new `holdViewDirect`/`clearHoldViewDirect` helpers next to `completeViewDirect` (`:569-591`); new `holdView`/`clearHoldView` next to `completeView` (`:600-626`); expose both on the returned service object next to `markCompleted` (`:1862`)
- Test: `test/service.test.mjs`

**Interfaces:**
- Consumes: kinds from Task 4; `isManualVerdict` (Task 6) not needed here.
- Produces: `service.holdView(viewId) -> Promise<{ok, error?}>`, `service.clearHoldView(viewId) -> Promise<{ok, error?}>` — typed automatically via `ReturnType<typeof createService>` (dashboard's `Service` alias).

- [ ] **Step 1: Write the failing tests**

In `test/service.test.mjs` (mirror the existing injected-`sendStateCommand` pattern at `:883-885`):

```js
test("holdView and clearHoldView submit user-sourced commands (issue #145)", async () => {
	const sent = [];
	const svc = service(root, { sendStateCommand: async (cmd) => { sent.push(cmd); return { status: "applied" }; } });
	assert.equal((await svc.holdView("v1")).ok, true);
	assert.equal(sent[0].kind, "mark_holding");
	assert.equal(sent[0].source, "dashboard-user");
	assert.equal((await svc.clearHoldView("v1")).ok, true);
	assert.equal(sent[1].kind, "clear_holding");
	assert.equal(sent[1].source, "dashboard-user");
});

test("holdView refuses busy rows with the same wording as markCompleted (issue #145)", async () => {
	const svc = service(root, { sendStateCommand: async () => ({ status: "rejected", reason: "busy" }) });
	const res = await svc.holdView("v1");
	assert.equal(res.ok, false);
	assert.equal(res.error, "Wait for the active run to finish before placing on hold");
});

test("markCompletedMany completes holding rows — d-key semantics need zero UI change (spec D4)", async () => {
	const svc = service(root, { sendStateCommand: async (cmd) => (cmd.kind === "mark_completed" ? { status: "applied" } : { status: "rejected", reason: "busy" }) });
	const res = await svc.markCompletedMany(["v1"]);
	assert.equal(res.completed, 1);
});

test("reconcile leaves holding rows untouched even with a terminal host record (issue #145)", async () => {
	// Seed a holding row whose host record is exited: reconcile must not
	// finalize it (looksActive allow-list skips exited/holding rows).
	const st = readState(root, "v1");
	st.semanticState = "holding";
	st.processState = "exited";
	writeState(root, st);
	writeHost(root, "v1", { state: "exited", runnerPid: null, childPid: null, instanceId: "i1", socketPath: "/no/s.sock" });
	const svc = service(root, { sendStateCommand: async () => ({ status: "rejected", reason: "manual_fence" }) });
	await svc.reconcile();
	assert.equal(readState(root, "v1").semanticState, "holding");
});
```

(Adapt fixture helpers — `readState`/`writeState`/`writeHost` — to the file's existing imports/fixtures; the fourth test needs the `writeHost` helper the service tests already use.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/service.test.mjs`
Expected: FAIL — `svc.holdView is not a function`.

- [ ] **Step 3: Implement**

Next to `completeViewDirect` in `src/runtime/service.mjs`:

```js
	/** Direct write for holdView — coordinator_disabled escape hatch only. */
	function holdViewDirect(state) {
		state.semanticState = "holding";
		state.processState = "exited";
		state.needsInput = false;
		state.hasError = false;
		state.question = null;
		state.pendingQuestions = [];
		state.error = null;
		state.autoState = null;
		state.lastActivityAt = Date.now();
		state.updatedAt = Date.now();
		writeState(root, state);
	}

	/** Direct write for clearHoldView — coordinator_disabled escape hatch only. */
	function clearHoldViewDirect(state) {
		state.semanticState = "idle";
		state.processState = "exited";
		state.needsInput = false;
		state.hasError = false;
		state.question = null;
		state.pendingQuestions = [];
		state.error = null;
		state.autoState = null;
		state.lastActivityAt = Date.now();
		state.updatedAt = Date.now();
		writeState(root, state);
	}

	/** Place an inactive session on hold (issue #145; template: completeView). */
	async function holdView(viewId) {
		const row = loadRow(root, viewId);
		if (!row) return { ok: false, error: "Unknown session" };
		if (isAgentBusy(row)) return { ok: false, error: "Wait for the active run to finish before placing on hold" };
		const state = readState(root, viewId) ?? row.state ?? blankState(viewId);
		const result = await sendStateCommandImpl(root, {
			type: "state_command",
			viewId,
			runId: state.currentRunId ?? null,
			source: "dashboard-user",
			kind: "mark_holding",
			expectedRevision: null,
			payload: {},
		});
		if (result.status === "applied") return { ok: true };
		if (result.reason === "busy") return { ok: false, error: "Wait for the active run to finish before placing on hold" };
		if (result.reason === "coordinator_disabled") {
			holdViewDirect(state);
			return { ok: true };
		}
		return { ok: false, error: result.reason ?? "state_command_failed" };
	}

	/** Resume an on-hold session back to Needs-instructions (issue #145). */
	async function clearHoldView(viewId) {
		const row = loadRow(root, viewId);
		if (!row) return { ok: false, error: "Unknown session" };
		const state = readState(root, viewId) ?? row.state ?? blankState(viewId);
		const result = await sendStateCommandImpl(root, {
			type: "state_command",
			viewId,
			runId: state.currentRunId ?? null,
			source: "dashboard-user",
			kind: "clear_holding",
			expectedRevision: null,
			payload: {},
		});
		if (result.status === "applied") return { ok: true };
		if (result.reason === "no_change") return { ok: true };
		if (result.reason === "coordinator_disabled") {
			clearHoldViewDirect(state);
			return { ok: true };
		}
		return { ok: false, error: result.reason ?? "state_command_failed" };
	}
```

On the returned service object, next to `markCompleted`:

```js
		/** @param {string} viewId @returns {Promise<{ ok: boolean, error?: string }>} */
		holdView(viewId) {
			return holdView(viewId);
		},

		/** @param {string} viewId @returns {Promise<{ ok: boolean, error?: string }>} */
		clearHoldView(viewId) {
			return clearHoldView(viewId);
		},
```

- [ ] **Step 4: Run tests**

Run: `node --test test/service.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/service.mjs test/service.test.mjs
git commit -m "feat: holdView and clearHoldView service actions (issue #145)"
```

---

### Task 8: F-lift — interactive input lifts the manual fence

**Acceptance:** A14, A15, A16, A17, A19. Review Focus #5. This is the regression fix that also unbreaks completed rows.

**Files:**
- Modify: `src/runtime/service.mjs` — `writeForegroundState` (`:745`) gains an `opts.source` override; `syncRowEvent`'s input branch (`:1444-1453`)
- Test: `test/state-commands.test.mjs` (decision level), `test/state-coordinator.integration.test.mjs` (A14/A17), `test/service.test.mjs` (A15/A16/A19)

**Interfaces:**
- Consumes: nothing new (pure source switch on an existing command).
- Produces: `writeForegroundState(row, status, opts?: { source?: string })`.

- [ ] **Step 1: Write the failing tests**

Decision level, `test/state-commands.test.mjs`:

```js
// -- F-lift (issue #145): interactive input lifts the manual fence --

test("sync_foreground as dashboard-user passes the fence; as service it stays fenced", () => {
	const holding = { ...manualCompletedState, semanticState: "holding" };
	const payload = { projection: { semanticState: "working", processState: "alive" } };
	const fenced = decideStateTransition({ ...baseCmd, source: "service", kind: "sync_foreground", payload }, holding, null);
	assert.equal(fenced.action, "reject");
	assert.equal(fenced.reason, "manual_fence");
	const lifted = decideStateTransition({ ...baseCmd, source: "dashboard-user", kind: "sync_foreground", payload }, holding, null);
	assert.equal(lifted.action, "apply");
});
```

Integration, `test/state-coordinator.integration.test.mjs` (uses the file's existing `freshRoot` / `createView` / `legacyRowState` / `startCoordinator` / `readyClient` / `waitForExit` helpers — same shape as the A8 test at `:515-580`; match that test's cleanup convention):

```js
test("interactive-input mirror lifts the fence; service-source mirrors stay fenced (issue #145, spec A14/A15)", async () => {
	const root = freshRoot();
	createView(root, { id: "v1", name: "hold", cwd: process.cwd() });
	const st = legacyRowState("v1");
	st.semanticState = "holding";
	st.autoState = null; // manual-verdict signal
	writeState(root, st);
	const child = startCoordinator(root);
	try {
		const { client } = await readyClient(root);
		const payload = { projection: { ...legacyRowState("v1"), semanticState: "working", processState: "alive", autoState: null } };
		// 1. Automated mirror (rpc/extension injection keeps source "service"): fenced.
		client.send({ type: "state_command", commandId: "f-lift-svc-1", viewId: "v1", runId: null, source: "service", kind: "sync_foreground", expectedRevision: null, payload });
		const fenced = await client.next();
		assert.equal(fenced.status, "rejected");
		assert.equal(fenced.reason, "manual_fence");
		assert.equal(readState(root, "v1").semanticState, "holding", "row keeps the verdict");
		// 2. User mirror (pi reported InputEvent.source === "interactive"): lifts.
		client.send({ type: "state_command", commandId: "f-lift-user-1", viewId: "v1", runId: null, source: "dashboard-user", kind: "sync_foreground", expectedRevision: null, payload });
		const lifted = await client.next();
		assert.equal(lifted.status, "applied");
		assert.equal(readState(root, "v1").semanticState, "working", "user speaking resumes the row");
	} finally {
		child.kill("SIGTERM");
		await waitForExit(child);
	}
});
```

Red/green self-proof: the `dashboard-user` leg fails on unmodified main (rejected manual_fence); the `service` leg must keep failing-to-apply forever (A15).

Service level, `test/service.test.mjs` (asserts the source switch itself — the unit the coordinator test can't see):

```js
test("syncRowEvent routes interactive input as dashboard-user; rpc/extension stay service (issue #145)", async () => {
	const sent = [];
	const svc = service(root, { sendStateCommand: async (cmd) => { sent.push(cmd); return { status: "applied" }; } });
	await svc.syncHostedEvent("v1", { type: "input", source: "interactive", text: "go" });
	await svc.syncHostedEvent("v1", { type: "input", source: "rpc", text: "auto" });
	await svc.syncHostedEvent("v1", { type: "agent_start" });
	// The working-state mirror is a fire-and-forget sync_foreground beat
	// (service.test.mjs:908 precedent) — poll instead of asserting immediately.
	const kinds = await waitFor(() => {
		const beats = sent.filter((c) => c.kind === "sync_foreground");
		return beats.length >= 3 ? beats : null;
	});
	assert.equal(kinds[0].source, "dashboard-user");
	assert.equal(kinds[1].source, "service");
	assert.equal(kinds[2].source, "service");
});
```

(Seed `v1` via the file's usual createView fixture first; reuse the file's existing `waitFor` helper. The completed-row variant — same input on a `completed` + `autoState: null` row, spec A16 — is the same test with the state seeded `completed`; assert the row's state converges `working` when the fake `sendStateCommand` applies only `dashboard-user` mirrors and rejects `service` ones with `manual_fence`.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/state-commands.test.mjs test/state-coordinator.integration.test.mjs test/service.test.mjs`
Expected: the F-lift tests FAIL (mirror rejected manual_fence / source still `service`).

- [ ] **Step 3: Implement**

`src/runtime/service.mjs` — `writeForegroundState`:

```js
	/**
	 * @param {import("../core/store.mjs").Row} row
	 * @param {import("../core/types.mjs").RunStatus} status
	 * @param {{ source?: string }} [opts] F-lift (issue #145): pass "dashboard-user"
	 *   when the mirror was triggered by a human submitting input — the manual
	 *   fence must not outlive the user speaking to the row.
	 * @returns {Promise<void>}
	 */
	async function writeForegroundState(row, status, opts = {}) {
```

and inside, the command's `source:` line becomes `source: opts.source ?? "service",`.

`syncRowEvent`'s first branch (`:1444`):

```js
		if (event.type === "input" || event.type === "before_agent_start" || event.type === "agent_start") {
			status.semanticState = "working";
			status.processState = "alive";
			status.currentTool = null;
			status.question = null;
			status.pendingQuestions = [];
			status.error = null;
			status.summary = "Running…";
			status.lastActivityAt = now;
			// F-lift (issue #145): pi's InputEvent carries source; "interactive"
			// means a human submitted this text (attach keystrokes, a dashboard
			// reply injected into a live host, or an auto-drained follow-up — all
			// arrive as PTY bytes, which pi classifies as interactive). A manual
			// verdict must not outlive the user speaking to the row, so this one
			// mirror travels as dashboard-user and passes the manual_fence guard.
			// Safe by construction: stale_run cannot fire (runId stays null) and
			// the coordinator shell never reads source — manual_fence is the only
			// guard this crosses. rpc/extension injections keep source "service".
			const userSpoke = event.type === "input" && event.source === "interactive";
			void writeForegroundState(row, status, userSpoke ? { source: "dashboard-user" } : {});
			return true;
		}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/state-commands.test.mjs test/state-coordinator.integration.test.mjs test/service.test.mjs`
Expected: PASS — including the pre-existing A8-invariant tests (`:308-310`, `:542-577`), which is spec A17: lifting the fence for user mirrors does not re-open the door for late classifications.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/service.mjs test/state-commands.test.mjs test/state-coordinator.integration.test.mjs test/service.test.mjs
git commit -m "fix: interactive input lifts the manual fence on verdict rows (issue #145)"
```

---

### Task 9: UI — `h` key toggles hold in list / peek / session modes

**Acceptance:** A21. Feeds U1/U2/U5.

**Files:**
- Modify: `src/ui/dashboard.ts` — `toggleHold` method; `handleListKey:355`, `handlePeekKey`, `handleSessionKey`; `renderHelp:1648` table; hint line `:1316`
- Create: `test-support/hold-key-wrap.ts`
- Test: `test/dashboard-hold-key.test.mjs`

**Interfaces:**
- Consumes: `service.holdView`/`clearHoldView` (Task 7 — typed via `Service = ReturnType<typeof createService>`).
- Produces: `h` in list/peek/session = hold ⇄ unhold. Select mode gets no `h` (spec non-goal).

- [ ] **Step 1: Write the failing test**

Create `test-support/hold-key-wrap.ts` (mirror `navigation-wrap.ts`; fake service records commands):

```ts
// Hold-key probe: construct a dashboard with a fake service, press "h" in
// list/peek/session modes, and report the submitted commands as JSON.
// Run via `node --experimental-transform-types`. Not typechecked.
const stateById: Record<string, { semanticState: string; processState: string; pendingQuestions: unknown[] }> = {
	v1: { semanticState: "idle", processState: "exited", pendingQuestions: [] },
	v2: { semanticState: "holding", processState: "exited", pendingQuestions: [] },
};
const sent: Array<[string, string]> = [];
const row = (id: string) => ({
	meta: { id, name: id, cwd: "/", sessionFile: `/s/${id}.jsonl` },
	state: stateById[id],
	alive: false, hostAlive: false, hostActive: false, hostReady: false, host: null,
});
const service = {
	rows: () => [row("v1"), row("v2")],
	holdView: async (id: string) => { sent.push(["mark_holding", id]); stateById[id].semanticState = "holding"; return { ok: true }; },
	clearHoldView: async (id: string) => { sent.push(["clear_holding", id]); stateById[id].semanticState = "idle"; return { ok: true }; },
	reconcile: async () => 0,
};
const tui = { terminal: { rows: 24, cols: 80, columns: 80, write: () => {} }, requestRender: () => {} };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const dash = new DashboardComponent(tui as never, theme as never, {} as never, () => {}, {
	service: service as never, root: "/", defaultCwd: "/", availableModels: [], currentModel: null, currentThinkingLevel: "off",
});
dash.selectedId = "v1";
dash.handleInput("h");            // list mode, idle row -> mark_holding
dash.selectedId = "v2";
dash.handleInput("h");            // list mode, holding row -> clear_holding
dash.peekId = "v2"; dash.mode = "peek";
dash.handleInput("h");            // peek mode -> (v2 was reset to idle by the previous press) mark_holding
dash.mode = "session";
dash.handleInput("h");            // session mode -> clear_holding
dash.dispose();
console.log(JSON.stringify(sent));
```

Create `test/dashboard-hold-key.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "hold-key-wrap.ts");

test("h key submits mark_holding / clear_holding across list, peek and session modes (issue #145)", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", PROBE], { encoding: "utf-8", timeout: 30_000 });
	assert.deepEqual(JSON.parse(out), [
		["mark_holding", "v1"],
		["clear_holding", "v2"],
		["mark_holding", "v2"],
		["clear_holding", "v2"],
	]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/dashboard-hold-key.test.mjs`
Expected: FAIL — `sent` is empty (`h` falls into the isPrintable notice branch).

- [ ] **Step 3: Implement**

`src/ui/dashboard.ts` — new method next to `confirmDone`:

```ts
	// On-hold toggle (issue #145): manual-only state, so the command travels as
	// dashboard-user; the coordinator's source guard rejects any other writer.
	private toggleHold(): void {
		const row = this.selectedRow();
		if (!row) return;
		const holding = row.state?.semanticState === "holding";
		if (!holding && isAgentBusy(row)) return this.notice("Wait for the active run to finish before placing on hold", "warn");
		const run = holding ? this.deps.service.clearHoldView(row.meta.id) : this.deps.service.holdView(row.meta.id);
		void Promise.resolve(run).then((res) => {
			if (!res.ok) this.notice(res.error ?? (holding ? "Resume failed" : "Hold failed"), "error");
			else this.notice(holding ? "Resumed — needs instructions" : "On hold", "info");
			this.refresh();
		});
	}
```

(`isAgentBusy` is already imported — `confirmDone` uses it.)

Key wiring — `handleListKey`, after the `d` line:

```ts
		if (data === "d") return this.confirmDone();
		if (data === "h") return this.toggleHold();
```

`handlePeekKey`, after its `d` line: `if (data === "h") return this.toggleHold();`
`handleSessionKey`, after its `d` line: `if (data === "h") return this.toggleHold();`

`renderHelp` rows — insert after the `d` row:

```ts
			["h", "Hold / unhold the selected inactive session (on-hold state)"],
```

Hint line (`:1316`) — insert `"h hold"` into the hints array right after `"d done"`.

- [ ] **Step 4: Run tests + typecheck**

Run: `node --test test/dashboard-hold-key.test.mjs test/dashboard-navigation.test.mjs && npm run typecheck`
Expected: PASS (navigation probe unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard.ts test-support/hold-key-wrap.ts test/dashboard-hold-key.test.mjs
git commit -m "feat: h key toggles the on-hold state from list, peek and session (issue #145)"
```

---

### Task 10: Evidence contract — `outcome: "holding"`, `ready: true`

**Acceptance:** A12.

**Files:**
- Modify: `src/core/evidence.mjs:223-224`
- Test: `test/evidence.test.mjs`

**Interfaces:**
- Consumes: `"holding"` in `EvidenceOutcome` (Task 1).
- Produces: `finalizeEvidence` maps holding → `outcome: "holding"`, `ready: true` (spec D8 — ready is display/filter-only, verified).

- [ ] **Step 1: Write the failing test**

In `test/evidence.test.mjs` (reuse the file's snapshot fixture helpers):

```js
test("finalizeEvidence maps holding to its own outcome and keeps ready true (issue #145)", () => {
	const snap = emptyEvidenceSnapshot({ viewId: "v", source: "hosted" });
	finalizeEvidence(snap, { viewId: "v", semanticState: "holding" }, 5);
	assert.equal(snap.outcome, "holding");
	assert.equal(snap.ready, true);
});
```

(Adapt `emptyEvidenceSnapshot`/`finalizeEvidence` to the file's existing imports.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/evidence.test.mjs`
Expected: FAIL — `ready` is false (holding is neither idle nor completed in the current expression).

- [ ] **Step 3: Implement**

`src/core/evidence.mjs:223-224`:

```js
	snapshot.outcome = status.semanticState === "idle" ? "ready" : status.semanticState;
	// holding keeps ready=true (issue #145 spec D8): an on-hold row's evidence is
	// reviewable like a completed one; `ready` feeds display + the review:ready
	// filter only (verified — no functional gate reads it).
	snapshot.ready = status.semanticState === "idle" || status.semanticState === "completed" || status.semanticState === "holding";
```

- [ ] **Step 4: Run tests**

Run: `node --test test/evidence.test.mjs test/dashboard-evidence.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/evidence.mjs test/evidence.test.mjs
git commit -m "feat: evidence outcome and ready flag for holding rows (issue #145)"
```

---

### Task 11: README — state table, key tables, filter examples

**Acceptance:** documentation for U1–U7; no automated ID (build gate in Task 12 covers the doc build).

**Files:**
- Modify: `README.md` — state table (`~:204-213`), Main list / Peek / Transcript key tables, filter example block

**Interfaces:** none.

- [ ] **Step 1: Edit the state table** — insert after the **Needs instructions** row:

```markdown
| **On hold** | The user parked this session intentionally (manual verdict, `h` to toggle). It stays out of Done until resumed; queued follow-ups do not wake it. |
```

- [ ] **Step 2: Edit the key tables** — Main list, after the `d` row:

```markdown
| `h` | Hold or unhold the selected inactive session. |
```

Peek table, after `d`-equivalent actions (Peek has no `d`; add after `e`): `| `h` | Hold or unhold the session. |`. Transcript table, after the `d` row: same line. Session actions paragraph: add "`h` toggles the on-hold state (manual verdict — automated writers are fenced)".

- [ ] **Step 3: Edit the filter examples** — add `s:hold` to the filter token example block.

- [ ] **Step 4: Verify nothing broke**

Run: `npm run typecheck && node --test test/ui-smoke.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document the on-hold state, h key and s:hold filter (issue #145)"
```

---

### Task 12: Full verification + user-acceptance handoff

**Acceptance:** A20 (build gate), A18/A17 regression evidence, U1–U7 checklist.

**Files:**
- Create: `docs/superpowers/plans/2026-09-29-issue-145-user-verification.md` (the U-item checklist, executed by the user against an installed build)

**Interfaces:** none.

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`
Expected: typecheck + perf gate + full test suite + coverage thresholds (lines 85 / funcs 80 / branches 70) + pack:dry all green. This run is the evidence for A20, and its inclusion of `runner.integration`/`state-coordinator.integration` is the regression evidence for A17/A18.

- [ ] **Step 2: Write the user-verification checklist**

`docs/superpowers/plans/2026-09-29-issue-145-user-verification.md` — one section per U item (U1–U7) copied verbatim from spec §9's user-acceptance table (operation steps + pass criteria), plus a results column left blank. State explicitly: automation passing does NOT substitute for these; mark `pending` where not yet executed.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-09-29-issue-145-user-verification.md
git commit -m "test: user-acceptance checklist for the on-hold state (issue #145)"
```

- [ ] **Step 4: Report**

Post a summary to the issue: tasks completed, A-item statuses with the commands that produced them, and the pending U items with the checklist path. Do NOT push or open a PR — that gate belongs to the human.

---

## Acceptance traceability (spec §9 ↔ tasks)

| Spec ID | Task(s) | | Spec ID | Task(s) |
|---|---|---|---|---|
| A1 | 2 | | A12 | 10 |
| A2 / A3 / A4 | 4 | | A13 | 5 |
| A5 | 4, 6 | | A14 | 8 |
| A6 / A7 | 6 | | A15 | 8 |
| A8 | 3 (+12 regression) | | A16 | 8 |
| A9 / A10 / A11 | 1 | | A17 | 8 + 12 |
| — | — | | A18 | 3 + 6 + 12 |
| — | — | | A19 | 8 + 12 |
| — | — | | A20 | 12 |
| — | — | | A21 | 9 |
| U1–U7 | 12 (checklist) | | | |
