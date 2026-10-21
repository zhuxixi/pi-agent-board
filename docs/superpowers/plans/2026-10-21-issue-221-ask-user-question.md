# Recognize `ask_user_question` (name OR questionnaire shape) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an interactive run blocked on `ask_user_question` — or on any tool using the questionnaire arg shape — group under "Needs answer" instead of "RUNNING".

**Architecture:** Two private helpers in `src/core/events.mjs` (`isQuestionArgShape`, `isQuestionToolCall`); the start gate uses `isQuestionToolCall(name, args)`, the end gate becomes name-agnostic and removes by `toolCallId`. Two reducer tests in `test/events.test.mjs` drive the public surface (`createRunStatus` / `reduceEvent` / `projectViewState`).

**Tech Stack:** Node 22, `node:test` + `assert/strict`, plain ESM `.mjs` (no build step).

**Spec:** `docs/superpowers/specs/2026-10-20-issue-221-ask-user-question-design.md`

## Global Constraints

- Tabs for indentation; English comments and commit messages.
- Conventional commit subject with the PR number appended as `(#N)` (this branch's PR number is filled in at PR time; use `(#221)` for the issue-numbered commits that predate the PR).
- Run `npm run verify` before claiming completion — `npm test` alone skips the perf gate and coverage thresholds.
- Do not touch `detectNeedsInput()`, `message_end` classification, or the `"ask_questions"` no-id fallback ids (`events.mjs:242/250`).
- Detached (non-interactive) runs must keep the legacy `currentTool` behavior.

## Review Focus

- A tool whose args are `{ questions: [] }` or `{ questions: "…" }` must **not** be treated as awaiting input (shape check needs a non-empty array whose first item has a string `question`).
- Detached runs: the shape fallback must never produce `needs_input` (headless sessions cannot answer).
- Parallel calls: ending one question must not clear another pending one (existing multi-question test at `test/events.test.mjs:135`).
- An end event for a non-question tool must be a no-op for `pendingQuestions`.
- `args` missing entirely on a question-tool start (`ask_questions` with `{}`) must still count via the name set.

---

### Task 1: Hybrid question-tool detection

**Files:**
- Modify: `src/core/events.mjs:20-21` (set), `:86` (start gate), `:100` (end gate), add helpers near `questionFromArgs` (`:232`)
- Test: `test/events.test.mjs` (append after the existing `interactive pi question tool …` test at `:185-204`)

**Interfaces:**
- Consumes: `createRunStatus(config, pid, now)`, `reduceEvent(status, event, now, opts)`, `projectViewState(status, now)` from `src/core/events.mjs`.
- Produces: module-private `isQuestionArgShape(args: unknown): boolean` and `isQuestionToolCall(name: string, args: unknown): boolean`; no exports change.

- [ ] **Step 1: Write the failing tests**

Append to `test/events.test.mjs`:

```js
test("interactive ask_user_question waits for input and clears on end", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	reduceEvent(s, {
		type: "tool_execution_start",
		toolCallId: "q1",
		toolName: "ask_user_question",
		args: { questions: [{ question: "Which approach?", header: "Approach", options: [{ label: "A", description: "a" }] }] },
	}, 2000, { interactive: true });
	assert.equal(s.semanticState, "needs_input");
	assert.equal(s.summary, "Which approach?");
	assert.equal(s.question, "Which approach?");
	assert.equal(s.currentTool, null);
	assert.deepEqual(s.pendingQuestions, [{ toolCallId: "q1", question: "Which approach?" }]);
	assert.equal(projectViewState(s, 2100).needsInput, true);

	reduceEvent(s, { type: "tool_execution_end", toolCallId: "q1", toolName: "ask_user_question", isError: false }, 2400, { interactive: true });
	assert.equal(s.semanticState, "working");
	assert.equal(s.question, null);
	assert.deepEqual(s.pendingQuestions, []);

	const detached = createRunStatus(cfg(), 1, 1000);
	reduceEvent(detached, {
		type: "tool_execution_start",
		toolCallId: "q1",
		toolName: "ask_user_question",
		args: { questions: [{ question: "Which approach?" }] },
	}, 2000);
	assert.equal(detached.semanticState, "working");
	assert.equal(detached.currentTool.name, "ask_user_question");
	assert.deepEqual(detached.pendingQuestions, []);
});

test("interactive unknown questionnaire shape is treated as a pending question", () => {
	const s = createRunStatus(cfg(), 1, 1000);
	reduceEvent(s, {
		type: "tool_execution_start",
		toolCallId: "q1",
		toolName: "mystery_questionnaire",
		args: { questions: [{ question: "Ship it?", header: "Release", options: [{ label: "Yes" }] }] },
	}, 2000, { interactive: true });
	assert.equal(s.semanticState, "needs_input");
	assert.equal(s.question, "Ship it?");
	assert.equal(s.currentTool, null);
	assert.deepEqual(s.pendingQuestions, [{ toolCallId: "q1", question: "Ship it?" }]);

	reduceEvent(s, { type: "tool_execution_end", toolCallId: "q1", toolName: "mystery_questionnaire", isError: false }, 2400, { interactive: true });
	assert.equal(s.semanticState, "working");
	assert.equal(s.question, null);
	assert.deepEqual(s.pendingQuestions, []);

	for (const args of [{ questions: [] }, { questions: "nope" }, { command: "ls" }]) {
		const negative = createRunStatus(cfg(), 1, 1000);
		reduceEvent(negative, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args }, 2000, { interactive: true });
		assert.equal(negative.semanticState, "working", JSON.stringify(args));
		assert.deepEqual(negative.pendingQuestions, []);
	}
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="ask_user_question|unknown questionnaire"`
Expected: FAIL — the first test reports `semanticState === "working"` / `summary === "Ask_user_question"`; the second reports `semanticState === "working"` for `mystery_questionnaire`.

- [ ] **Step 3: Implement the detection helpers**

In `src/core/events.mjs`, replace the set definition:

```js
/** Tool names whose interactive execution blocks on a user answer. */
const QUESTION_TOOL_NAMES = new Set(["ask_user_question", "ask_questions", "question", "questionnaire"]);

/** Questionnaire args shared by pi/Claude-Code style question tools. */
function isQuestionArgShape(args) {
	const questions = Array.isArray(args?.questions) ? args.questions : null;
	return Boolean(questions && questions.length > 0 && typeof questions[0]?.question === "string");
}

/** A start event is a question when its name is known or its args carry the questionnaire shape. */
function isQuestionToolCall(name, args) {
	return QUESTION_TOOL_NAMES.has(name) || isQuestionArgShape(args);
}
```

- [ ] **Step 4: Wire the start and end gates**

In the `tool_execution_start` case, replace

```js
			if (opts.interactive && QUESTION_TOOL_NAMES.has(name)) {
```

with

```js
			if (opts.interactive && isQuestionToolCall(name, args)) {
```

In the `tool_execution_end` case, replace

```js
			if (opts.interactive && QUESTION_TOOL_NAMES.has(event.toolName ?? "")) removePendingQuestion(status, event.toolCallId);
```

with

```js
			// The end event carries no args, so a shape-matched start cannot be recognized here;
			// remove by call id instead (a no-op when this call had no pending question).
			if (opts.interactive) removePendingQuestion(status, event.toolCallId);
```

- [ ] **Step 5: Run the reducer tests and the whole suite**

Run: `npm test`
Expected: PASS — the two new tests plus the existing `ask_questions` / `question` / `questionnaire` / parallel-question tests stay green. (A1–A4, A5–A7)

- [ ] **Step 6: Run the full gate**

Run: `npm run verify`
Expected: PASS — typecheck, perf gate, tests, coverage thresholds (85/80/70), pack dry-run. (A8)

- [ ] **Step 7: Commit**

```bash
git add src/core/events.mjs test/events.test.mjs
git commit -m "fix: recognize ask_user_question and questionnaire-shaped tools as pending questions (#221)"
```

---

### Task 2: Post-merge live verification (manual, not a code task)

**Files:** none.

- [ ] **Step 1: Update the board clone the running process loads**

```bash
cd ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board
git checkout -- package-lock.json
git pull
git log -1 --oneline
```

Expected: HEAD is the merged commit from this branch.

- [ ] **Step 2: Restart Pi / the board service**, then open the dashboard.

- [ ] **Step 3: Dispatch a session that blocks on `ask_user_question`** (the `@juicesharp/rpiv-ask-user-question` extension is installed at user level), answer it via attach.

Expected: the row sits under **Needs answer** with the question text as summary; after answering it returns to **RUNNING**. (U1)

If the merge has not happened yet, record U1 as `pending` — do not mark it passed.
