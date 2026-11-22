# Compaction Mirror Implementation Plan (issue #297)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror pi's compaction window into the board row so `/compact` shows `working` instead of the stale pre-compaction state.

**Architecture:** One persisted `compaction` window field (`{phase, reason, startedAt, previous, error}`) carried on `RunStatus`/`ViewState`. Two pure helpers in `src/core/events.mjs` (`beginCompaction`/`endCompaction`) own every transition and are the only summary producer while a window is open. The extension hook path (`syncRowEvent`) and the JSON stream path (`reduceEvent`) both call the same helpers; `isAgentBusy` is untouched and picks the row up from `semanticState === "working"`.

**Tech Stack:** Node ESM `.mjs` core, TypeScript extension entry (`src/index.ts`), `node:test` + `assert/strict`, fake-pi harness for runner integration.

**Spec:** `docs/superpowers/specs/2026-11-22-issue-297-compaction-mirror-design.md` (issue #297 spec v2-final)

## Global Constraints

- Tabs for indentation; English comments and commit subjects (`feat:` / `fix:` / `test:` / `docs:`).
- Never edit `CHANGELOG.md` by hand; never touch `src/core/state-commands.mjs` (`PATCHABLE_FIELDS` and the decision layer stay as-is).
- `isAgentBusy()` semantics must not change: the fix works only by setting `semanticState: "working"`.
- `compaction` must be nullable and tolerated when absent on legacy rows (`?? null`); no migration, no version bump.
- Legacy rows and rows with `compaction === null` must keep byte-identical behavior outside the window.
- Commits are staged per file (`git add <path>`), never `git add -A`.
- Existing test files keep passing unmodified except where a task explicitly adds cases.

## Review Focus

- A `/compact` that fails in milliseconds ("Nothing to compact", "Already compacted") must never leave the row stuck at `working` + `Compacting context…` — the begin write may still be in flight when the end hook lands.
- An idle row must come back byte-for-byte to its pre-compaction shape after a successful compaction, including `processState: "exited"` and the old `summary`.
- A compaction that happens mid-run (threshold/overflow) must not drop the row out of `working` before the run actually ends.
- A failed compaction must surface pi's `errorMessage` on the row without fabricating `semanticState: "failed"`.
- The JSON runner path (`compaction_start`/`compaction_end`) must behave identically to the interactive path, including summary ownership.

---

### Task 1: Core window model (helpers, derive, types, projection)

**Files:**
- Modify: `src/core/types.mjs` (CompactionWindow typedef; `ViewState.compaction`; `RunStatus.compaction`)
- Modify: `src/core/derive.mjs:100-130` (`deriveSummary` compaction branch)
- Modify: `src/core/events.mjs:70-110` (`createRunStatus`), `:144-215` (`reduceEvent`), `:225-260` (`finalizeRun`), `:262-300` (`projectViewState`), plus new helpers
- Test: `test/derive.test.mjs`, `test/events.test.mjs`

**Interfaces:**
- Produces: `beginCompaction(status, facts, now)`, `endCompaction(status, facts, now)` exported from `src/core/events.mjs`; `facts = { reason?, willRetry?, aborted?, errorMessage? }`.
- Produces: `RunStatus.compaction` / `ViewState.compaction` shape `{ phase: "running"|"failed", reason, startedAt, previous, error }`.

- [ ] **Step 1: Write the failing derive test**

Append to `test/derive.test.mjs` (import already includes `deriveSummary`):

```js
test("deriveSummary renders the compaction window (issue #297)", () => {
	const base = {
		semanticState: "working",
		processState: "alive",
		currentTool: { name: "bash", summary: "bash: npm test" },
		latestAssistantPreview: "Old preview text that must not win.",
	};
	assert.equal(deriveSummary({ ...base, compaction: { phase: "running" } }), "Compacting context…");
	assert.equal(
		deriveSummary({ ...base, compaction: { phase: "failed", error: "Compaction failed: Nothing to compact (session too small)" } }),
		"Compaction failed: Nothing to compact (session too small)",
	);
	assert.equal(deriveSummary({ ...base, compaction: null }), "bash: npm test");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/derive.test.mjs`
Expected: FAIL — the first assertion returns `bash: npm test`.

- [ ] **Step 3: Implement the derive branch**

In `src/core/derive.mjs`, at the top of `deriveSummary` (before the active-tool branch):

```js
	// 0. A compaction window owns the summary (issue #297, invariant I8).
	if (s.compaction) {
		if (s.compaction.phase === "failed" && s.compaction.error) return truncate(s.compaction.error, max);
		return "Compacting context…";
	}
```

- [ ] **Step 4: Run the derive test**

Run: `node --test test/derive.test.mjs`
Expected: PASS (new test + all existing ones).

- [ ] **Step 5: Write the failing reducer tests**

Append to `test/events.test.mjs` (imports `createRunStatus, finalizeRun, projectViewState, reduceEvent` already exist — add `beginCompaction, endCompaction`):

```js
test("beginCompaction snapshots the pre-compaction state once and opens the window", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	s.semanticState = "idle";
	s.processState = "exited";
	s.summary = "Needs instructions";
	s.question = null;
	beginCompaction(s, { reason: "manual" }, 2000);
	assert.equal(s.semanticState, "working");
	assert.equal(s.processState, "alive");
	assert.equal(s.summary, "Compacting context…");
	assert.equal(s.compaction.phase, "running");
	assert.equal(s.compaction.reason, "manual");
	assert.equal(s.compaction.startedAt, 2000);
	assert.deepEqual(s.compaction.previous, {
		semanticState: "idle",
		processState: "exited",
		summary: "Needs instructions",
		question: null,
		error: null,
	});
	// Idempotent while running: the original snapshot survives.
	beginCompaction(s, { reason: "threshold" }, 2500);
	assert.equal(s.compaction.reason, "manual");
	assert.equal(s.compaction.startedAt, 2000);
	assert.equal(s.compaction.previous.semanticState, "idle");
});

test("beginCompaction treats a leftover failed marker as a fresh window", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	s.semanticState = "idle";
	s.processState = "exited";
	s.compaction = { phase: "failed", reason: "manual", startedAt: 1500, previous: null, error: "Compaction failed: x" };
	beginCompaction(s, { reason: "manual" }, 2000);
	assert.equal(s.compaction.phase, "running");
	assert.equal(s.compaction.previous.semanticState, "idle");
	assert.equal(s.compaction.previous.processState, "exited");
});

test("endCompaction restores a resting pre-state verbatim", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	s.semanticState = "idle";
	s.processState = "exited";
	s.summary = "Needs instructions";
	s.question = null;
	beginCompaction(s, {}, 2000);
	endCompaction(s, { willRetry: false, aborted: false, errorMessage: null }, 3000);
	assert.equal(s.semanticState, "idle");
	assert.equal(s.processState, "exited", "processState must come back to the snapshot value");
	assert.equal(s.summary, "Needs instructions");
	assert.equal(s.compaction, null);
});

test("endCompaction keeps a mid-run row working", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	s.semanticState = "working";
	s.processState = "alive";
	beginCompaction(s, { reason: "threshold" }, 2000);
	endCompaction(s, { willRetry: false }, 3000);
	assert.equal(s.semanticState, "working");
	assert.equal(s.processState, "alive");
	assert.equal(s.compaction, null);
});

test("endCompaction keeps willRetry rows working and drops the error", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	s.semanticState = "idle";
	s.processState = "exited";
	s.summary = "Needs instructions";
	beginCompaction(s, { reason: "overflow" }, 2000);
	endCompaction(s, { willRetry: true, aborted: false, errorMessage: "Compaction failed: boom" }, 3000);
	assert.equal(s.semanticState, "working");
	assert.equal(s.error, null, "a retry supersedes its error");
	assert.equal(s.compaction, null);
});

test("endCompaction restores on abort without an error", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	s.semanticState = "needs_input";
	s.processState = "exited";
	s.summary = "Approve this plan?";
	s.question = "Approve this plan?";
	beginCompaction(s, { reason: "manual" }, 2000);
	endCompaction(s, { aborted: true, errorMessage: "Compaction failed: ignored" }, 3000);
	assert.equal(s.semanticState, "needs_input");
	assert.equal(s.question, "Approve this plan?");
	assert.equal(s.error, null);
	assert.equal(s.compaction, null);
});

test("endCompaction surfaces a real failure without faking a failed run", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	s.semanticState = "idle";
	s.processState = "exited";
	s.summary = "Needs instructions";
	beginCompaction(s, { reason: "manual" }, 2000);
	endCompaction(s, { aborted: false, errorMessage: "Compaction failed: Nothing to compact (session too small)" }, 3000);
	assert.equal(s.semanticState, "idle", "the session itself is still usable");
	assert.equal(s.error, "Compaction failed: Nothing to compact (session too small)");
	assert.equal(s.compaction.phase, "failed");
	assert.equal(s.compaction.previous, null);
	assert.equal(s.summary, "Compaction failed: Nothing to compact (session too small)");
});

test("endCompaction without a snapshot stays working instead of throwing", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	s.semanticState = "working";
	s.compaction = null;
	endCompaction(s, { willRetry: false }, 3000);
	assert.equal(s.semanticState, "working");
	assert.equal(s.compaction, null);
});

test("reduceEvent mirrors compaction_start/compaction_end and owns the summary", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	assert.equal(reduceEvent(s, { type: "compaction_start", reason: "threshold" }, 2000), true);
	assert.equal(s.semanticState, "working");
	assert.equal(s.processState, "alive");
	assert.equal(s.summary, "Compacting context…");
	assert.equal(reduceEvent(s, { type: "compaction_end", reason: "threshold", result: { summary: "x" }, aborted: false, willRetry: false }, 3000), true);
	assert.equal(s.compaction, null);
	assert.equal(s.semanticState, "working", "was mid-run");
});

test("a failed compaction notice survives until the next real event", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	s.semanticState = "idle";
	s.processState = "exited";
	s.summary = "Needs instructions";
	reduceEvent(s, { type: "compaction_start", reason: "manual" }, 2000);
	reduceEvent(s, { type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false, errorMessage: "Compaction failed: boom" }, 3000);
	assert.equal(s.compaction.phase, "failed");
	assert.equal(s.summary, "Compaction failed: boom");
	reduceEvent(s, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } }, 4000);
	assert.equal(s.compaction, null, "the next real event drops the failure notice");
});

test("finalizeRun and projectViewState handle the window field", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	beginCompaction(s, { reason: "manual" }, 2000);
	const projected = projectViewState(s, 2000);
	assert.equal(projected.compaction.phase, "running");
	assert.equal(projected.compaction.previous.semanticState, "queued");
	finalizeRun(s, { exitCode: 0 }, 3000);
	assert.equal(s.compaction, null);
	assert.equal(projectViewState(s, 3000).compaction, null);
	const legacy = { ...s };
	delete legacy.compaction;
	assert.equal(projectViewState(legacy, 4000).compaction, null);
});
```

- [ ] **Step 6: Run the reducer tests and watch them fail**

Run: `node --test test/events.test.mjs`
Expected: FAIL — `beginCompaction is not a function`.

- [ ] **Step 7: Implement the helpers, reduceEvent cases and field plumbing**

`src/core/events.mjs` — add after the `QUESTION_TOOL_NAMES` block:

```js
/** Compaction event types whose summary is owned by begin/endCompaction (I8). */
const COMPACTION_EVENT_TYPES = new Set(["compaction_start", "compaction_end"]);

/**
 * Open (or refresh) a compaction window on a status (issue #297).
 * The pre-compaction snapshot is taken once per window: a repeated
 * before_compact/compaction_start keeps the original, while a leftover
 * `failed` marker counts as a new window (the user retried).
 * @param {any} status @param {{reason?: "manual"|"threshold"|"overflow"}} facts @param {number} now
 */
export function beginCompaction(status, facts = {}, now) {
	const existing = status.compaction;
	if (!existing || existing.phase === "failed") {
		status.compaction = {
			phase: "running",
			reason: facts.reason ?? "manual",
			startedAt: now,
			previous: {
				semanticState: status.semanticState,
				processState: status.processState,
				summary: status.summary,
				question: status.question ?? null,
				error: status.error ?? null,
			},
			error: null,
		};
	}
	status.semanticState = "working";
	status.processState = "alive";
	status.lastActivityAt = now;
	status.summary = deriveSummary(status);
}

/**
 * Close a compaction window and restore what it replaced (issue #297).
 * Resting pre-states restore verbatim (including processState, R1-G3); a
 * mid-run pre-state or willRetry stays working so the continuing run owns the
 * row until agent_end. A genuine failure restores the row and leaves a
 * `failed` marker so the summary keeps showing pi's message (R1-G1).
 * @param {any} status @param {{willRetry?: boolean, aborted?: boolean, errorMessage?: string|null}} facts @param {number} now
 */
export function endCompaction(status, facts = {}, now) {
	const marker = status.compaction ?? null;
	const previous = marker?.previous ?? null;
	status.compaction = null;
	status.lastActivityAt = now;
	if (!previous) {
		// No snapshot survived (late/duplicate end): stay working; agent_end or
		// reconcile converges the row.
		status.semanticState = "working";
		status.summary = deriveSummary(status);
		return;
	}
	if (facts.willRetry || previous.semanticState === "queued" || previous.semanticState === "working") {
		// The run continues (threshold/overflow) or is retried; a retry
		// supersedes its own error, so dropping errorMessage here is deliberate.
		status.semanticState = "working";
		status.processState = "alive";
		status.summary = deriveSummary(status);
		return;
	}
	status.semanticState = previous.semanticState;
	status.processState = previous.processState;
	status.question = previous.question;
	status.error = previous.error;
	if (!facts.aborted && facts.errorMessage) {
		status.error = facts.errorMessage;
		status.compaction = {
			phase: "failed",
			reason: marker?.reason ?? "manual",
			startedAt: marker?.startedAt ?? now,
			previous: null,
			error: facts.errorMessage,
		};
		status.summary = deriveSummary(status);
		return;
	}
	status.summary = previous.summary || deriveSummary(status);
}
```

In `createRunStatus`, add `compaction: null,` after `currentTool: null,`.

In `reduceEvent`, add `let summaryPinned = false;` beside `let meaningful = false;`, add the two cases before `default:`:

```js
		case "compaction_start": {
			beginCompaction(status, { reason: event.reason }, now);
			summaryPinned = true;
			meaningful = true;
			break;
		}
		case "compaction_end": {
			endCompaction(status, {
				willRetry: Boolean(event.willRetry),
				aborted: Boolean(event.aborted),
				errorMessage: event.errorMessage ?? null,
			}, now);
			summaryPinned = true;
			meaningful = true;
			break;
		}
```

and replace the tail `if (meaningful) status.summary = deriveSummary(status);` with:

```js
	if (meaningful) {
		// A leftover failure notice belongs to the compaction that produced it;
		// the next real activity supersedes it (invariant I6).
		if (status.compaction?.phase === "failed" && !COMPACTION_EVENT_TYPES.has(event.type)) status.compaction = null;
		if (!summaryPinned) status.summary = deriveSummary(status);
	}
```

In `finalizeRun`, add `status.compaction = null;` after `status.currentTool = null;`.

In `projectViewState`, add `compaction: status.compaction ?? null,` after `latestTool`.

`src/core/types.mjs` — add before the `ViewState` typedef:

```js
/**
 * Compaction window mirrored from pi (issue #297).
 * @typedef {Object} CompactionWindow
 * @property {"running"|"failed"} phase
 * @property {"manual"|"threshold"|"overflow"} reason
 * @property {number} startedAt
 * @property {{semanticState:SemanticState, processState:ProcessState, summary:string, question:string|null, error:string|null}|null} previous
 *   Pre-compaction snapshot; non-null only while running.
 * @property {string|null} error pi's errorMessage, only on phase "failed".
 */
```

and add `@property {CompactionWindow|null} [compaction] Compaction window mirrored from pi (issue #297).` to both `ViewState` and `RunStatus`.

- [ ] **Step 8: Run the reducer + derive tests**

Run: `node --test test/derive.test.mjs test/events.test.mjs`
Expected: PASS.

- [ ] **Step 9: Run the whole suite to catch projection regressions**

Run: `npm test`
Expected: PASS (the coordinator leak gate included).

- [ ] **Step 10: Commit**

```bash
git add src/core/types.mjs src/core/derive.mjs src/core/events.mjs test/derive.test.mjs test/events.test.mjs
git commit -m "fix: model the compaction window in the row reducer (issue #297)"
```

---

### Task 2: Foreground/hosted mirror (extension hooks, cache whitelist, static guard)

**Files:**
- Modify: `src/index.ts:238-244` (three hook registrations)
- Modify: `src/runtime/service.mjs:874-895` (`blankState`), `:906-937` (`statusFromRow`), `:1834-1930` (`syncRowEvent`)
- Modify: `src/core/foreground-projection-cache.mjs:22-33` (`CACHED_FIELDS`)
- Test: `test/service.test.mjs`, new `test/index-compaction-events.test.mjs`

**Interfaces:**
- Consumes: `beginCompaction`, `endCompaction` from Task 1.
- Produces: `syncHostedEvent(viewId, event)` / `syncForegroundEvent(sessionFile, event)` accept the three compaction hook events; `state.json.compaction` mirrors the window.

- [ ] **Step 1: Write the failing service tests**

Append to `test/service.test.mjs` (helpers `service`, `freshRoot`, `readState`, `writeState`, `setEnv`, `waitFor`, `delayedMaterializingSendStateCommand` already exist in that file):

```js
test("syncHostedEvent mirrors a compaction window end to end (issue #297)", async () => {
	const root = freshRoot();
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", "off");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const svc = service(root);
		const s = readState(root, "v1");
		s.semanticState = "idle";
		s.processState = "exited";
		s.summary = "Needs instructions";
		writeState(root, s);

		assert.equal(await svc.syncHostedEvent("v1", { type: "session_before_compact", reason: "manual", willRetry: false }), true);
		const compacting = readState(root, "v1");
		assert.equal(compacting.semanticState, "working");
		assert.equal(compacting.processState, "alive");
		assert.equal(compacting.summary, "Compacting context…");
		assert.equal(compacting.compaction.phase, "running");
		assert.equal(compacting.compaction.previous.semanticState, "idle");
		assert.equal(service(root).row("v1").alive, true);
		// The busy guards now see the row (they key on semanticState only).
		assert.equal((await service(root).markCompleted("v1")).ok, false);
		assert.equal((await service(root).holdView("v1")).ok, false);

		assert.equal(await svc.syncHostedEvent("v1", { type: "session_compact", reason: "manual", willRetry: false, fromExtension: false }), true);
		const restored = readState(root, "v1");
		assert.equal(restored.semanticState, "idle");
		assert.equal(restored.processState, "exited");
		assert.equal(restored.summary, "Needs instructions");
		assert.equal(restored.compaction, null);
		assert.equal(service(root).row("v1").alive, false);
	} finally {
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed compaction surfaces pi's message and never fakes a failed run (issue #297)", async () => {
	const root = freshRoot();
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", "off");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const svc = service(root);
		const s = readState(root, "v1");
		s.semanticState = "idle";
		s.processState = "exited";
		s.summary = "Needs instructions";
		writeState(root, s);

		await svc.syncHostedEvent("v1", { type: "session_before_compact", reason: "manual", willRetry: false });
		await svc.syncHostedEvent("v1", {
			type: "session_compact_failed",
			reason: "manual",
			aborted: false,
			willRetry: false,
			errorMessage: "Compaction failed: Nothing to compact (session too small)",
			fromExtension: false,
		});
		const failed = readState(root, "v1");
		assert.equal(failed.semanticState, "idle");
		assert.equal(failed.processState, "exited");
		assert.equal(failed.error, "Compaction failed: Nothing to compact (session too small)");
		assert.equal(failed.compaction.phase, "failed");
		assert.match(failed.summary, /^Compaction failed: /);

		// The next real activity drops the notice (invariant I6).
		await svc.syncHostedEvent("v1", { type: "input", text: "try again" });
		const resumed = readState(root, "v1");
		assert.equal(resumed.compaction, null);
		assert.equal(resumed.semanticState, "working");
		assert.equal(resumed.summary, "Running…");
	} finally {
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		rmSync(root, { recursive: true, force: true });
	}
});

test("an aborted compaction restores the pre-compaction row silently (issue #297)", async () => {
	const root = freshRoot();
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", "off");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const svc = service(root);
		const s = readState(root, "v1");
		s.semanticState = "needs_input";
		s.processState = "exited";
		s.summary = "Approve this plan?";
		s.question = "Approve this plan?";
		s.pendingQuestions = [{ toolCallId: "q1", question: "Approve this plan?" }];
		writeState(root, s);

		await svc.syncHostedEvent("v1", { type: "session_before_compact", reason: "manual", willRetry: false });
		await svc.syncHostedEvent("v1", { type: "session_compact_failed", reason: "manual", aborted: true, willRetry: false, errorMessage: undefined });
		const restored = readState(root, "v1");
		assert.equal(restored.semanticState, "needs_input");
		assert.equal(restored.question, "Approve this plan?");
		assert.equal(restored.error, null);
		assert.equal(restored.compaction, null);
	} finally {
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a fast-failing compaction cannot strand an idle row in working (issue #297, R1-G2)", async () => {
	const root = freshRoot();
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", "off");
	const fake = delayedMaterializingSendStateCommand(root, { delayMs: 20 });
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		const st = readState(root, "v1");
		st.semanticState = "idle";
		st.processState = "exited";
		st.summary = "Needs instructions";
		writeState(root, st);

		// Back-to-back hooks while the begin projection is still in flight.
		await service(root, { sendStateCommand: fake.send }).syncForegroundEvent(meta.sessionFile, { type: "session_before_compact", reason: "manual" });
		await service(root, { sendStateCommand: fake.send }).syncForegroundEvent(meta.sessionFile, {
			type: "session_compact_failed",
			reason: "manual",
			aborted: false,
			willRetry: false,
			errorMessage: "Compaction failed: Nothing to compact (session too small)",
		});

		const settled = await waitFor(() => {
			const s = readState(root, "v1");
			return s.compaction?.phase === "failed" ? s : null;
		});
		assert.ok(settled, "the failure notice materialized");
		assert.equal(settled.semanticState, "idle", "never stranded on working");
		assert.equal(settled.processState, "exited");
	} finally {
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Add the static registration guard test**

Create `test/index-compaction-events.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Issue #297: the compaction hooks live in the extension registration layer,
 * which the service harness never exercises — a typo there would only surface
 * in a manual run, so pin the three names as static text. */
test("the extension registers every compaction hook (issue #297)", () => {
	const source = readFileSync(ENTRY, "utf8");
	for (const hook of ["session_before_compact", "session_compact", "session_compact_failed"]) {
		assert.match(source, new RegExp(`pi\\.on\\("${hook}"`), `missing pi.on("${hook}") registration`);
	}
});
```

- [ ] **Step 3: Run the new tests and watch them fail**

Run: `node --test test/service.test.mjs test/index-compaction-events.test.mjs`
Expected: FAIL — the row stays `idle` after `session_before_compact`, and the extension registration is missing.

- [ ] **Step 4: Implement the foreground mirror**

`src/core/foreground-projection-cache.mjs` — add `"compaction",` to `CACHED_FIELDS` (after `"lastAgentActivityAt",` or alphabetically near `"currentTool"`; keep the list's existing style).

`src/runtime/service.mjs` — add the import (near the existing `events.mjs` import): `beginCompaction, endCompaction`; add a module-level `const COMPACTION_EVENTS = new Set(["session_before_compact", "session_compact", "session_compact_failed"]);`

In `blankState`, add `compaction: null,` after `latestTool: null,`.
In `statusFromRow`, add `compaction: s.compaction ?? null,` after `latestTool`.

In `syncRowEvent`, right after the `foregroundProjectionCache.adopt(...)` call, add:

```js
		// Issue #297: only the three compaction hooks keep the window marker; any
		// other event supersedes a leftover failure notice.
		if (status.compaction && !COMPACTION_EVENTS.has(event.type)) status.compaction = null;
```

and after the existing `input | before_agent_start | agent_start` branch, before the `agent_end` branch:

```js
		if (event.type === "session_before_compact") {
			beginCompaction(status, { reason: event.reason }, now);
			// Throughput path: periodic self-healing mirror, fire-and-forget.
			void writeForegroundState(row, status);
			return true;
		}

		if (event.type === "session_compact" || event.type === "session_compact_failed") {
			endCompaction(status, {
				willRetry: Boolean(event.willRetry),
				aborted: Boolean(event.aborted),
				errorMessage: event.errorMessage ?? null,
			}, now);
			void writeForegroundState(row, status);
			return true;
		}
```

`src/index.ts` — after the `agent_end` registration:

```ts
	// Issue #297: compaction is work in progress. Registered separately from the
	// AgentSessionEvent stream because these three hooks are what a live pi
	// session actually emits to extensions.
	pi.on("session_before_compact", async (event, ctx) => syncForeground(event, ctx));
	pi.on("session_compact", async (event, ctx) => syncForeground(event, ctx));
	pi.on("session_compact_failed", async (event, ctx) => syncForeground(event, ctx));
```

- [ ] **Step 5: Run the service + static tests**

Run: `node --test test/service.test.mjs test/index-compaction-events.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/runtime/service.mjs src/core/foreground-projection-cache.mjs test/service.test.mjs test/index-compaction-events.test.mjs
git commit -m "fix: mirror the compaction window from live pi sessions (issue #297)"
```

---

### Task 3: JSON runner path (fake-pi mode + end-to-end assertion)

**Files:**
- Modify: `test-support/fake-pi.mjs` (new `compact` mode)
- Test: `test/runner.integration.test.mjs`

**Interfaces:**
- Consumes: `beginCompaction`/`endCompaction` wired into `reduceEvent` by Task 1 (no runner code change needed: the progress beat ships the whole in-memory status).
- Produces: `FAKE_PI_MODE=compact` fixture; `FAKE_PI_COMPACT_MS` overrides the window length (default 1200).

- [ ] **Step 1: Add the fake-pi mode**

In `test-support/fake-pi.mjs`, after the first `message_end` block and before the `if (mode === "abort")` block:

```js
	if (mode === "compact") {
		// Mid-run threshold compaction: the run continues afterwards, so the row
		// must stay working across the window (issue #297, A4).
		emit({ type: "compaction_start", reason: "threshold" });
		await sleep(Number(process.env.FAKE_PI_COMPACT_MS || 1200));
		emit({
			type: "compaction_end",
			reason: "threshold",
			result: { summary: "older context compacted", tokensBefore: 4096, firstKeptEntryId: "u0000001" },
			aborted: false,
			willRetry: false,
		});
	}
```

- [ ] **Step 2: Write the failing integration test**

Append to `test/runner.integration.test.mjs`, following the completed-run fixture (tracked coordinator, `makeConfig`, `launchRun`, `killDetached`):

```js
test("runner mirrors a mid-run compaction window into the row (issue #297)", { timeout: 30000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-compact-"));
	process.env.FAKE_PI_MODE = "compact";
	process.env.FAKE_PI_COMPACT_MS = "1500";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	let runnerPid = null;
	const coord = await startCoordinator(root);
	try {
		const meta = createView(root, { id: "view_1", name: "compact", cwd: root });
		const config = makeConfig(root, "view_1", "run_1", meta.sessionFile, root, "compact the context");
		const st = readState(root, "view_1");
		st.currentRunId = "run_1";
		const { writeState } = await import("../src/core/store.mjs");
		writeState(root, st);

		runnerPid = launchRun(root, config, { runnerScript: RUNNER }).pid;
		assert.ok(runnerPid && runnerPid > 0, "runner spawned");

		const during = await waitFor(() => {
			const state = readState(root, "view_1");
			const status = readStatus(root, "view_1", "run_1");
			return state?.compaction?.phase === "running" && status?.compaction?.phase === "running" ? { state, status } : null;
		});
		assert.equal(during.state.semanticState, "working");
		assert.equal(during.state.processState, "alive");
		assert.equal(during.state.summary, "Compacting context…");
		assert.equal(during.status.semanticState, "working");

		const done = await waitFor(() => {
			const status = readStatus(root, "view_1", "run_1");
			return status && status.endedAt ? status : null;
		});
		assert.equal(done.compaction, null, "the window is cleared once the run finishes");
		await waitFor(() => (isAlive(runnerPid) ? null : true), 15000);
		const finalState = readState(root, "view_1");
		assert.equal(finalState.compaction, null);
		assert.notEqual(finalState.semanticState, "working");
	} finally {
		await killDetached(runnerPid);
		await coord.kill();
		delete process.env.FAKE_PI_MODE;
		delete process.env.FAKE_PI_COMPACT_MS;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test test/runner.integration.test.mjs`
Expected: FAIL — `during` never becomes truthy (no `compaction` field is written by the runner path before Task 1 is wired; with Task 1 done this passes, so if it fails now the failure proves the fixture/wiring gap).

- [ ] **Step 4: Fix whatever the failure names**

The only expected causes are: the fake mode not emitting (step 1 missed), or `reduceEvent` not receiving the events (Task 1's cases missing). Do not add runner-specific code — the beat ships the whole status by design.

- [ ] **Step 5: Run the integration test again**

Run: `node --test test/runner.integration.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test-support/fake-pi.mjs test/runner.integration.test.mjs
git commit -m "test: cover the JSON runner compaction window (issue #297)"
```

---

### Task 4: Full verification and acceptance reconciliation

**Files:**
- No source changes expected. If `npm run verify` reports a genuine defect, fix it inside the owning task's files and re-commit.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: the A1–A6 evidence table for the PR body and the issue comment.

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`
Expected: typecheck + perf gate + tests + coverage thresholds + pack:dry all pass.

- [ ] **Step 2: Run the coverage-only command if verify failed on thresholds**

Run: `npm run test:coverage`
Expected: lines ≥ 85 / functions ≥ 80 / branches ≥ 70.

- [ ] **Step 3: Record the acceptance evidence**

Write the A1–A6 rows with the exact commands run and their outcomes into the PR body draft (`docs/superpowers/plans/2026-11-22-issue-297-compaction-mirror.md` is the plan; the evidence goes into the PR description and the issue comment). U1 stays `pending` until a human runs a real `/compact`.

- [ ] **Step 4: Commit any fixes, then hand off**

```bash
git status --short
```

Expected: clean. Then post the implementation summary comment to the issue and open the PR in `github-issue-driven` step 9.
