# Question/Questionnaire Tool Grouping Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pi sessions blocked on the `question`/`questionnaire` tools group under "Needs answer" instead of "Running".

**Architecture:** Two minimal changes to `src/core/events.mjs`: (1) extend the private `questionFromArgs` helper to read pi's arg shapes; (2) replace the hardcoded `=== "ask_questions"` name checks with a `QUESTION_TOOL_NAMES` set. All downstream behavior (needs_input state, grouping, summary) already exists via `preservePendingQuestion` and `deriveSummary` — verified in spec section 3.3, nothing else changes.

**Tech Stack:** Node.js (`.mjs` ESM, no deps), `node:test` + `node:assert/strict` for tests.

## Global Constraints

- All code changes confined to `src/core/events.mjs` and `test/events.test.mjs`.
- No store/schema/type changes; no changes to `finalizeRun`, `projectViewState`, `deriveSummary`, `rows.mjs`, `service.mjs`.
- Non-interactive (detached) reduction path keeps its current behavior — the `opts.interactive` gate stays.
- Static name set, no config surface.
- Commit messages in conventional commits format; stage files individually (`git add <file>`), never `git add -A`.
- Test command: `node --test test/events.test.mjs`; project gate: `npm run verify`.
- Work in worktree `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-26-question-tool-grouping`; never touch main.

---

### Task 1: Extend `questionFromArgs` for pi arg shapes

**Files:**
- Modify: `src/core/events.mjs:229-235`
- Test: `test/events.test.mjs` (append new test near the ask_questions tests, after line 160)

**Interfaces:**
- Consumes: nothing new.
- Produces: `questionFromArgs(args)` (private) returns the first non-empty question text from: `args.question` (string), or `args.questions[]` items' `question` or `prompt` fields; falls back to `"Answer the pending question"`. Task 2's name-recognition relies on this extraction.

- [ ] **Step 1: Write the failing test**

Append to `test/events.test.mjs` (after the "interactive questions remain visible..." test):

```js
test("questionFromArgs extracts pi question/questionnaire arg shapes", () => {
	// pi `question` tool shape: args.question is a plain string.
	const s1 = createRunStatus(cfg(), 1, 1000);
	reduceEvent(s1, {
		type: "tool_execution_start",
		toolCallId: "q1",
		toolName: "ask_questions",
		args: { question: "Approve the plan?" },
	}, 2000, { interactive: true });
	assert.equal(s1.question, "Approve the plan?");

	// pi `questionnaire` tool shape: args.questions[].prompt.
	const s2 = createRunStatus(cfg(), 1, 1000);
	reduceEvent(s2, {
		type: "tool_execution_start",
		toolCallId: "q1",
		toolName: "ask_questions",
		args: { questions: [{ prompt: "Pick the scope?" }] },
	}, 2000, { interactive: true });
	assert.equal(s2.question, "Pick the scope?");
});
```

Note: the tests route through the reducer with the already-recognized `ask_questions` name because `questionFromArgs` is private and the reducer is the public surface; name recognition for the pi tools lands in Task 2.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/events.test.mjs`
Expected: FAIL — both assertions get `"Answer the pending question"` (the current extractor only reads `questions[].question`).

- [ ] **Step 3: Implement the extractor**

Replace the body of `questionFromArgs` in `src/core/events.mjs` (L229-235):

```js
function questionFromArgs(args) {
	if (typeof args?.question === "string" && args.question.trim()) return args.question.trim();
	for (const item of Array.isArray(args?.questions) ? args.questions : []) {
		const question = String(item?.question ?? item?.prompt ?? "").trim();
		if (question) return question;
	}
	return "Answer the pending question";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/events.test.mjs`
Expected: PASS (all 17 existing + 1 new test).

- [ ] **Step 5: Commit**

```bash
git add src/core/events.mjs test/events.test.mjs
git commit -m "fix: support pi question arg shapes in questionFromArgs (issue #26)"
```

---

### Task 2: Recognize `question`/`questionnaire` as pending-question tools

**Files:**
- Modify: `src/core/events.mjs:25-27` (insert set), `src/core/events.mjs:83`, `src/core/events.mjs:97`
- Test: `test/events.test.mjs` (append three tests after the Task 1 test)

**Interfaces:**
- Consumes: `questionFromArgs` extraction from Task 1.
- Produces: `QUESTION_TOOL_NAMES` (module-private `Set<string>`). `reduceEvent` treats any interactive tool_execution_start/end whose tool name is in the set as a pending-question event — `upsertPendingQuestion`/`removePendingQuestion` plus the existing `preservePendingQuestion` flow (needs_input state, `currentTool = null`).

- [ ] **Step 1: Write the failing tests**

Append to `test/events.test.mjs`:

```js
test("interactive pi question tool is treated as a pending question", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	reduceEvent(s, {
		type: "tool_execution_start",
		toolCallId: "q1",
		toolName: "question",
		args: { question: "Approve the plan?", options: [{ label: "Yes" }, { label: "No" }] },
	}, 2000, { interactive: true });
	assert.equal(s.semanticState, "needs_input");
	assert.equal(s.question, "Approve the plan?");
	assert.equal(s.currentTool, null);
	assert.equal(s.summary, "Approve the plan?");
	assert.deepEqual(s.pendingQuestions, [{ toolCallId: "q1", question: "Approve the plan?" }]);
	assert.equal(projectViewState(s, 2100).needsInput, true);

	reduceEvent(s, { type: "tool_execution_end", toolCallId: "q1", toolName: "question", isError: false }, 2400, { interactive: true });
	assert.equal(s.semanticState, "working");
	assert.equal(s.question, null);
	assert.deepEqual(s.pendingQuestions, []);
});

test("interactive questionnaire tool extracts prompt and clears on end", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	reduceEvent(s, {
		type: "tool_execution_start",
		toolCallId: "q1",
		toolName: "questionnaire",
		args: { questions: [{ prompt: "Pick the scope?" }] },
	}, 2000, { interactive: true });
	assert.equal(s.semanticState, "needs_input");
	assert.equal(s.question, "Pick the scope?");
	reduceEvent(s, { type: "tool_execution_end", toolCallId: "q1", toolName: "questionnaire", isError: false }, 2400, { interactive: true });
	assert.equal(s.semanticState, "working");
});

test("detached question tool keeps legacy currentTool behavior", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	reduceEvent(s, { type: "tool_execution_start", toolCallId: "q1", toolName: "question", args: { question: "Approve?" } }, 2000);
	assert.equal(s.semanticState, "working");
	assert.equal(s.currentTool.name, "question");
	assert.deepEqual(s.pendingQuestions, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/events.test.mjs`
Expected: FAIL — question/questionnaire names are not recognized: first test asserts `needs_input` but gets `working` with `currentTool.name === "question"`.

- [ ] **Step 3: Add the name set and wire the two checks**

Insert after the imports at the top of `src/core/events.mjs` (before `createRunStatus`, ~L25):

```js
/** Tool names whose interactive execution blocks on a user answer. */
const QUESTION_TOOL_NAMES = new Set(["ask_questions", "question", "questionnaire"]);
```

Replace L83:

```js
			if (opts.interactive && QUESTION_TOOL_NAMES.has(name)) {
```

Replace L97:

```js
			if (opts.interactive && QUESTION_TOOL_NAMES.has(event.toolName ?? "")) removePendingQuestion(status, event.toolCallId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/events.test.mjs`
Expected: PASS (21 tests total: 17 existing + 1 Task 1 + 3 new). Existing `ask_questions` tests must pass unchanged.

- [ ] **Step 5: Full project gate**

Run: `npm run verify`
Expected: typecheck, all tests, and pack dry-run pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/events.mjs test/events.test.mjs
git commit -m "fix: recognize question/questionnaire tools as pending questions (issue #26)"
```

---

## Self-Review

**Spec coverage:**
- Spec 3.1 (QUESTION_TOOL_NAMES replacing both hardcoded checks) → Task 2 steps 3. ✓
- Spec 3.2 (questionFromArgs pi shapes: `args.question`, `items[].prompt`, fallback `item.question`) → Task 1 step 3. ✓
- Spec 3.4 tests 1-4 (question start→needs_input, questionnaire extraction, end→working, detached unchanged) → Task 2 step 1 + Task 1 step 1. ✓
- Spec 3.3 downstream flow unchanged → asserted via `summary`/`needsInput` in Task 2 test 1; no production code touched outside `events.mjs`. ✓

**Placeholder scan:** every step carries concrete code or exact commands; no TBD/TODO/"similar to". ✓

**Type consistency:** `QUESTION_TOOL_NAMES` used identically in both replace steps; arg fields (`question`, `questions[].prompt`) match the pi extension schemas (`~/.pi/agent/extensions/question.ts`, `questionnaire.ts`). ✓
