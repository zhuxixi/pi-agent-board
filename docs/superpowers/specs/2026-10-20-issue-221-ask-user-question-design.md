# Root-cause report / Spec: recognize `ask_user_question` as a pending-question tool

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-20T22:10:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-20T22:24:00+08:00 — folded in R1-D1..D5
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-21T22:10:00+08:00 — emitter identified and installed locally; U1 deployment path corrected from npm release to the git-install clone
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-21T22:22:00+08:00 — R2-D1 reference precision (blocked-event emit site)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-21T22:15:00+08:00 — user chose the hybrid guard (name OR questionnaire arg shape); design, acceptance matrix, risks and testability split updated
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-21T22:35:00+08:00 — R3-D1..D3 (deliverables list, superseded decision row, no-id fallback boundary)

- **Issue**: zhuxixi/pi-agent-board#221
- **Date**: 2026-10-20
- **Status**: draft — awaiting cross-review and user confirmation
- **Type**: bug fix (event-reducer allow-list + regression test); no data-model, schema, or UI change

## 1. Problem

A pi-style session blocked on a tool named `ask_user_question` stays in the **RUNNING**
group with the row summary `Ask_user_question`. It never reaches the **Needs answer**
group (`needs_input`, amber).

Reproduced at reducer level on `main` (9a197f4):

```
actual  ask_user_question → semanticState=working, summary="Ask_user_question",
                            pendingQuestions=[], question=null,
                            currentTool={name:"ask_user_question"}, needsInput=false
control question          → semanticState=needs_input, summary="Which approach?", needsInput=true
```

Evidence trail: `issue-221/research/root-cause.md`, issue comment 6292835562.

## 2. Root cause

`src/core/events.mjs:21` defines an exact-membership allow-list:

```js
const QUESTION_TOOL_NAMES = new Set(["ask_questions", "question", "questionnaire"]);
```

Both gates are exact membership — `events.mjs:86` (`tool_execution_start`) and
`events.mjs:100` (`tool_execution_end`). `ask_user_question` misses both, so
`tool_execution_start` takes the generic branch (`currentTool` set, `semanticState =
"working"`), `preservePendingQuestion()` has nothing to promote, and `deriveSummary()`
falls back to `capitalize(name)`.

`questionFromArgs()` (`events.mjs:232`) already handles the arg shape
(`args.questions[].question`) — no extraction change is needed.

**Emitter (confirmed 2026-10-21)**: `ask_user_question` is registered by the pi extension
`@juicesharp/rpiv-ask-user-question` — `ask-user-question.ts:84`
(`ASK_USER_QUESTION_TOOL_NAME = "ask_user_question"`), registered at `:455-459`. It is not a
pi 1.3.0 built-in (pi ships no question tool; `question`/`questionnaire` come from
`pi-question-tool`). The extension is now installed on this machine: v2.13.9,
`~/.pi/agent/settings.json:90`, `~/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question`,
and the tool is live in the session after `/reload` (session tool list contains
`question`, `questionnaire`, `ask_user_question`). Its arg schema
(`{ questions: [{ question, header, options, multiSelect }] }`) is exactly what
`questionFromArgs` already reads.

The defect stands regardless of the emitter: any unrecognized question-tool name silently
degrades grouping.

## 3. Design

### 3.1 Detection: name allow-list OR questionnaire arg shape

```js
/** Tool names whose interactive execution blocks on a user answer. */
const QUESTION_TOOL_NAMES = new Set(["ask_questions", "question", "questionnaire", "ask_user_question"]);

/** Questionnaire args shared by pi/Claude-Code style question tools. */
function isQuestionArgShape(args) {
	const questions = Array.isArray(args?.questions) ? args.questions : null;
	return Boolean(questions && questions.length > 0 && typeof questions[0]?.question === "string");
}

function isQuestionToolCall(name, args) {
	return QUESTION_TOOL_NAMES.has(name) || isQuestionArgShape(args);
}
```

Why both: the name set keeps the known tools working even with empty args
(`ask_questions` is exercised with `args: {}` at `test/events.test.mjs:137`), while the shape
check survives a renamed or newly packaged question tool as long as it keeps the
`questions[0].question` schema. Neither replaces the other.

**End gate becomes name-agnostic**: `tool_execution_end` carries no `args`, so a
shape-matched start cannot be recognized at end time. Replace
`opts.interactive && QUESTION_TOOL_NAMES.has(event.toolName ?? "")` with
`opts.interactive` and let `removePendingQuestion(status, event.toolCallId)` filter by call
id (it is already a no-op when the id is not pending). Tool-call ids are unique per call, so
this cannot clear someone else's question.

The guarantee is exact for real worker events, which always carry `toolCallId`
(`pi` dist `agent-session` emits `{toolCallId,toolName,result,isError}`). The pre-existing
no-id fallback (`events.mjs:242/250` map a missing id to the literal `"ask_questions"`) is
unchanged; a malformed event without an id could therefore clear a pending entry that also
lacked one. That path is unreachable from the real event stream and is left as-is.

No other module reads question-tool names (`rg ask_questions src/` → only `events.mjs`).

### 3.2 Regression guard

Two new reducer tests in `test/events.test.mjs`, next to the existing
`interactive pi question tool …` test:

**Test A — name path (`ask_user_question`), pinned to the literal name**

- interactive start → `needs_input`, summary/question = first question text,
  `pendingQuestions` length 1, `currentTool === null`, `projectViewState().needsInput === true`;
- interactive end for the same `toolCallId` → `working`, `question === null`,
  `pendingQuestions === []`;
- detached reduction (no `interactive`) → `working`, `currentTool.name === "ask_user_question"`,
  `pendingQuestions === []`.

**Test B — shape path (unknown name), plus the negative guard**

- interactive start with `toolName: "mystery_questionnaire"` and
  `args: { questions: [{ question: "Ship it?", header: "Release", options: [{ label: "Yes" }] }] }`
  → `needs_input`, question `"Ship it?"`, one pending entry;
- interactive end with the **same unknown name** → `working`, cleared (proves the end gate is
  call-id based, not name based);
- negative cases that must stay `working` with an empty `pendingQuestions`:
  `{ questions: [] }`, `{ questions: "nope" }`, and a non-question tool (`bash`).

The literal name in Test A plus the unknown-name case in Test B are the guards: dropping the
name or the shape check fails `npm test` instead of silently regressing the dashboard.

### 3.3 Alternatives considered

| Alternative | Verdict | Reason |
|---|---|---|
| Arg-shape detection instead of a name set | Rejected | `ask_questions` is exercised with `args: {}` (`test/events.test.mjs:135`) and must still be `needs_input`; shape alone cannot cover it. |
| Hybrid (`set OR questions[] shape`) at drafting | Rejected, then superseded | Drafting-time verdict was to keep the diff minimal; the user gate on 2026-10-21 chose the hybrid, so this row is history only — the authoritative decision is the Adopted row below. |
| Configurable allow-list | Rejected | No config surface exists for reducer behavior; over-engineering for a one-name gap. |
| Export the set for tests | Rejected | The reducer is the public surface; tests already drive it directly. Exporting a private constant adds API for no gain. |
| Upstream `rpiv:ask-user:blocked` event instead of name detection | Rejected | Constant defined at `events.ts:38`, emitted at `ask-user-question.ts:64` (`pi.events.emit`) — an in-process bus event on the extension host. The board consumes JSON-mode worker stdout, which never carries pi bus events, so the channel is unreachable. |
| Name set OR arg-shape fallback | **Adopted** (user decision, 2026-10-21) | Survives a rename or a newly packaged question tool as long as the schema stays `questions[0].question`. Cost: any interactive tool with that exact shape is treated as a pending question; bounded by requiring a non-empty `questions[0].question` string and by the `opts.interactive` gate. |

### 3.4 Data flow (unchanged, verified)

| Step | Location | Result |
|---|---|---|
| interactive start, name in set OR questionnaire shape | `events.mjs:86` → `upsertPendingQuestion` → `preservePendingQuestion` | `needs_input`, `currentTool=null`, `question` = first question |
| summary | `derive.mjs:103` | question text wins over tool name |
| projection | `events.mjs:209` | `needsInput: true` |
| interactive end | `events.mjs:100` → `removePendingQuestion` (by call id) | back to `working`, `question=null` |
| inline reply while pending | `src/ui/dashboard.ts:2054 isAgentBusy` + `README.md:167/299` | reply rejected; answer via attach (pre-existing contract, now also applies to this name) |
| detached start/end | `opts.interactive` gate | unchanged `currentTool` behavior |

## 4. Acceptance matrix

| ID | Feature point | Verification | Concrete check | Pass criteria |
|----|---------------|--------------|----------------|---------------|
| A1 | `ask_user_question` start is treated as a pending question | automated (unit) | `npm test` — new test in `test/events.test.mjs` | `semanticState==="needs_input"`, `summary`/`question` equal `"Which approach?"`, `pendingQuestions.length===1`, `currentTool===null`, `projectViewState(s).needsInput===true` |
| A2 | `ask_user_question` end clears the pending question | automated (unit) | same test | `semanticState==="working"`, `question===null`, `pendingQuestions` empty |
| A3 | Detached reduction keeps legacy behavior | automated (unit) | same test (no `interactive` opt) | `semanticState==="working"`, `currentTool.name==="ask_user_question"`, `pendingQuestions` empty |
| A4 | No regression for the existing three names | automated (unit) | `npm test` (existing tests at `test/events.test.mjs:109/135/163/206/220`) | all pass unchanged |
| A5 | Shape fallback: unknown tool name with questionnaire args becomes a pending question | automated (unit) | Test B in `test/events.test.mjs` | `semanticState==="needs_input"`, question `"Ship it?"`, `pendingQuestions.length===1`, `currentTool===null` |
| A6 | End gate clears shape-matched calls without a name match | automated (unit) | Test B — `tool_execution_end` with the same unknown `toolName`/`toolCallId` | `semanticState==="working"`, `question===null`, `pendingQuestions` empty |
| A7 | Misleading args do not trigger the shape fallback | automated (unit) | Test B negative cases: `{questions: []}`, `{questions: "nope"}`, and `bash` | `semanticState==="working"`, `pendingQuestions` empty in all three |
| A8 | Repo-level static gate stays green | automated (static) | `npm run typecheck` | exit 0. Note: `tsconfig.json:9` sets `checkJs:false`, so this gate covers the `.ts` surface and is a repo regression check, not proof of this `.mjs` change; A1–A7 are the real proof |
| U1 | A real board session blocked on `ask_user_question` renders under Needs answer | user test | see §5 | row under **Needs answer** with the question text as summary; end of call returns it to RUNNING |

Full gate: `npm run verify` (typecheck + perf gate + tests + coverage thresholds + pack dry-run).

Failure branches: A2/A6 assert clear-on-end, A3 asserts detached stays generic, A7 asserts the
false-positive guard. No error path is added by this change, so no error-path item is owed.

## 5. User test (U1) — steps and timing

Now executable on this machine: the emitter is installed (`@juicesharp/rpiv-ask-user-question`
2.13.9) and the tool is live after `/reload`. The remaining precondition is the **board code**
itself — the board process loads from the git-install clone, not from this working checkout and
not from npm:

- `pi list` → `git:github.com/zhuxixi/pi-agent-board` at
  `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board` (`~/.pi/agent/settings.json:85`), HEAD
  `9a197f4` (= `main` at drafting time). That clone currently has a dirty `package-lock.json`
  (4 deleted `"peer": true` lines), which must be discarded before pulling.

Timing: after the fix merges to `main`.

1. Update the clone the board actually loads, then restart the board/Pi:
   `cd ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board && git checkout -- package-lock.json && git pull`
   (or re-run `pi install git:github.com/zhuxixi/pi-agent-board`); confirm
   `git log -1 --oneline` is the merged commit.
2. Restart Pi / the board service (an already-running pi process keeps the old extension code).
3. Dispatch a board session whose prompt forces a decision, so the model calls
   `ask_user_question` with `questions[0].question` containing a short decision question
   (e.g. "Which approach?"). The extension is user-level, so every session sees the tool.
4. Open the dashboard, then answer via attach.

Expected observation: the row sits under **Needs answer** (amber) with the question text as
its summary, `pendingQuestions` holds one entry, inline reply is refused (pre-existing
contract); after answering, the row returns to **RUNNING**.

If the merge has not happened by completion time, U1 is reported as `pending` (not passed);
A1–A5 still prove the reducer contract.

## 6. Non-goals

- No change to `detectNeedsInput()` text heuristics or `message_end` classification.
- The shape fallback does **not** apply to detached (non-interactive) runs: headless sessions
  cannot answer, so they keep `currentTool` display.
- No rename of the `"ask_questions"` fallback ids in `upsertPendingQuestion` /
  `removePendingQuestion` (`events.mjs:242/250`).
- No config surface or UI affordance for arbitrary question-tool names.
- No change to attach/reply/answer transport; only reducer classification changes.

## 7. Risks and boundaries

- **False positive (accepted)**: any interactive tool whose args are
  `{ questions: [{ question: <string> }] }` is treated as a pending question, even if it is
  not asking the user. Bounded by the `opts.interactive` gate and by requiring a non-empty
  first `question` string. No installed extension is known to declare that shape for a
  non-question purpose today (research §4), but absence over third-party code is not provable,
  so the guard is the bound itself, not a completeness claim.
- **End gate is now name-agnostic**: every interactive `tool_execution_end` calls
  `removePendingQuestion(id)`. For real worker events (which always carry `toolCallId`) ids are
  unique per call, so this clears the matching entry or does nothing; it cannot clear another
  call's question (covered by A6 and by the existing multi-question test at
  `test/events.test.mjs:135`). The legacy no-id fallback is unchanged and is documented in §3.1
  as the only way a cross-clear could occur.
- **Shape fallback is a heuristic**: a tool that renames its `questions` payload field
  (e.g. to `prompts`) still regresses. Accepted; a schema change is a protocol change, not a
  rename, and cannot be absorbed by a reducer heuristic.
- **Detached runs** are unaffected — headless sessions cannot answer, so they must keep
  `currentTool` display.
- **Only JSON-mode worker events reach the reducer.** The extension's own
  `rpiv:ask-user:blocked` bus event is in-process and never appears in worker stdout, so the
  board cannot rely on it.
- **Inline reply is rejected while the question is pending** (`README.md:167/299`,
  `src/ui/dashboard.ts:2054 isAgentBusy`). This is pre-existing behavior for pending
  questions and now applies to `ask_user_question` rows too; answer via attach. Expected,
  not a regression.

## 8. Testability split

The reducer is already a pure-function seam: `createRunStatus(config, pid, now)` builds
state, `reduceEvent(status, event, now, opts)` mutates it, `projectViewState(status, now)`
projects it. Two new module-private pure helpers carry the new logic —
`isQuestionArgShape(args)` and `isQuestionToolCall(name, args)` — and are driven through
`reduceEvent`, the public surface, exactly like the existing `questionFromArgs` (which is
also private and tested through the reducer).

Planned split:

| Unit | Purity | Test seam |
|---|---|---|
| `isQuestionArgShape(args)` | pure, no I/O | via `reduceEvent` start events (Test B positives/negatives) |
| `isQuestionToolCall(name, args)` | pure, no I/O | via `reduceEvent`; name path in Test A, shape path in Test B |
| start handler branch | side-effect-free over `RunStatus` | `reduceEvent` + `projectViewState` assertions |
| end handler (call-id removal) | side-effect-free over `RunStatus` | `reduceEvent` end events (Test A, Test B, existing multi-question test) |

Test boundary: `test/events.test.mjs` only. No export is added to `src/core/events.mjs`;
the helpers stay private and are covered through the reducer, matching the existing pattern.

## 9. Deliverables

- `src/core/events.mjs` — add `ask_user_question` to `QUESTION_TOOL_NAMES`; add the private
  `isQuestionArgShape(args)` / `isQuestionToolCall(name, args)` helpers; gate
  `tool_execution_start` on `isQuestionToolCall`; make `tool_execution_end` clear by
  `toolCallId` under `opts.interactive` only.
- `test/events.test.mjs` — Test A (name path) and Test B (shape path + negative guards).
- `docs/superpowers/specs/2026-10-20-issue-221-ask-user-question-design.md` — this design,
  committed with the fix (repo precedent: #213/#214/#215 each ship their spec with the PR).
