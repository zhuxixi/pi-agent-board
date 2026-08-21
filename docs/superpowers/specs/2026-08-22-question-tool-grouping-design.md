# Spec: Recognize pi `question`/`questionnaire` tools as pending-question sources

- **Issue**: zhuxixi/pi-agent-board#26
- **Date**: 2026-08-22
- **Status**: draft — awaiting user confirmation before implementation
- **Type**: bug fix (event reducer + arg extraction), no data-model change

## 1. Problem

A pi session blocked on the built-in `question` (or `questionnaire`) tool shows a
"Question" summary but stays in the **RUNNING** group instead of **NEEDS ANSWER**.

Observed 2026-08-22 01:26 on view `view_e809b1a3a2` ("jfox moc密度PR审查与监控"):
row summary "Question", `semanticState=working`, `pendingQuestions=[]`.

## 2. Root cause

The reducer only recognizes ONE question-tool name — `ask_questions`
(`src/core/events.mjs` L83/L97). Pi's actual question tools are named
`question` and `questionnaire` (user extensions:
`~/.pi/agent/extensions/question.ts`, `questionnaire.ts`).

When `tool_execution_start` arrives with `toolName: "question"`:
1. Name check fails → `else if (pendingQuestions.length === 0)` branch runs →
   `semanticState = "working"`, `currentTool.summary = toolSummary("question")` =
   `capitalize("question")` = `"Question"` (heuristics.mjs default branch).
2. `preservePendingQuestion` finds no pending question → no-op.
3. Result: row grouped by `semanticState` = "working" → RUNNING, summary "Question".

Correction to issue body: the "design gap B" claim (pending questions don't affect
grouping) is **wrong** — `preservePendingQuestion` already sets
`semanticState = "needs_input"` when `pendingQuestions` is non-empty. The ONLY gap is
tool-name recognition (plus arg-shape extraction). See research/root-cause.md.

## 3. Design

All changes in `src/core/events.mjs` + tests. No store/schema/type changes.

### 3.1 Question-tool name set

```js
const QUESTION_TOOL_NAMES = new Set(["ask_questions", "question", "questionnaire"]);
```

Replace both `name === "ask_questions"` checks (tool_execution_start L83,
tool_execution_end L97) with `QUESTION_TOOL_NAMES.has(name)` /
`QUESTION_TOOL_NAMES.has(event.toolName ?? "")`.

Rationale: static set matches the existing hardcoded-name precedent; all three names
are in the family of pi/agent question tools. A configurable list is deferred (4.2).

### 3.2 `questionFromArgs` — support pi arg shapes

Current: reads `args.questions[].question` (ask_questions shape).

Extend to:

| Tool | Args shape | Extract from |
|---|---|---|
| `ask_questions` | `{ questions: [{ question }] }` | `item.question` |
| `question` (pi) | `{ question: string, options: [...] }` | `args.question` |
| `questionnaire` (pi) | `{ questions: [{ prompt, options }] }` | `item.prompt`, fallback `item.question` |

Priority in `questions[]` items: `item.question ?? item.prompt`. Keep the
"Answer the pending question" fallback.

### 3.3 Downstream flow (already correct — verify, don't change)

- `tool_execution_start` (interactive, question tool): `upsertPendingQuestion` →
  `preservePendingQuestion` → `semanticState = "needs_input"`, `currentTool = null`,
  `question = first.question`. Row moves to NEEDS ANSWER group; summary shows the
  question text (deriveSummary: needs_input + question).
- `tool_execution_end` (interactive, question tool): `removePendingQuestion`,
  `semanticState = "working"`, `question = null` — back to RUNNING after the answer.
- Non-interactive (detached worker) path: `opts.interactive` gate unchanged →
  question tools keep the old generic behavior (no pending-question tracking).

### 3.4 Tests (`test/events.test.mjs`)

Mirror the existing `ask_questions` coverage (L109-160):

1. `tool_execution_start` with `toolName: "question"` (args `{ question: "Approve?" }`),
   interactive → `pendingQuestions = [{ toolCallId, question: "Approve?" }]`,
   `semanticState === "needs_input"`, `currentTool === null`, summary = question text.
2. Same for `toolName: "questionnaire"` with args `{ questions: [{ prompt: "Pick scope" }] }`
   → extracted question "Pick scope".
3. `tool_execution_end` with `toolName: "question"` → pendingQuestions empty,
   `semanticState === "working"`.
4. Detached (no `interactive`) `question` start → unchanged legacy behavior
   (`currentTool.name === "question"`, `pendingQuestions = []`).

## 4. Non-goals / deferred

1. No configurable question-tool list (env/config escape hatch). Add later only if a
   harness with a different question-tool name appears. Keeping the set static avoids
   new config surface.
2. No changes to `finalizeRun`, `projectViewState`, `deriveSummary`, or grouping logic.
3. Non-interactive path behavior unchanged.
4. No i18n / label changes.

## 5. Edge cases

- Two concurrent question tool calls: keyed by `toolCallId`; first pending question wins
  display. Unchanged from `ask_questions` behavior.
- Non-TUI pi question tool returns an error result immediately → start/end pair clears
  the pending question within the same cycle; transient needs_input is harmless.
- `agent_start` / `input` events already clear `pendingQuestions` in the foreground
  path (service.mjs L524-535) — no interaction.

## 6. Verification

- `npm run verify` (project gate) with the new events tests.
- Manual: start a pi session under the board, have it call the `question` tool →
  row shows the question text in NEEDS ANSWER group; answer it → row returns to RUNNING.
