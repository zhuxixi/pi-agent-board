/**
 * Reduce Pi JSON-mode worker events into an evolving RunStatus.
 *
 * Event vocabulary (verified against dist `agent-session.ts`; see docs/EXPLORATION.md §4):
 *   first line: session header {type:"session",...}
 *   message_start | message_update | message_end   (.message is an AgentMessage)
 *   tool_execution_start {toolCallId,toolName,args}
 *   tool_execution_end {toolCallId,toolName,result,isError}
 *   turn_start | turn_end | agent_start | agent_end
 * NOTE: `tool_result_end` (used by the subagent example) is never emitted — do not rely on it.
 */
import { deriveSummary, finalizeSemanticState } from "./derive.mjs";
import { assistantText, detectNeedsInput, toolPath, toolSummary, truncate } from "./heuristics.mjs";

/** @typedef {import("./types.mjs").RunConfig} RunConfig */
/** @typedef {import("./types.mjs").RunStatus} RunStatus */

const PREVIEW_MAX = 240;

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

/**
 * Compaction events tolerate a leftover failure marker in reduceEvent (I6):
 * the notice is cleared on the next real event, not on its own compaction pair.
 * Summary ownership lives in the `summaryPinned` flag instead.
 */
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
	if (existing?.phase === "failed") {
		// A retry supersedes the previous failure notice (I6). Restore the error the
		// row carried before the failed window (the marker kept it), then clear the
		// display so a successful retry cannot restore "Compaction failed: …".
		status.compaction = null;
		status.error = existing.previous?.error ?? null;
		status.summary = deriveSummary(status);
	}
	if (!status.compaction) {
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
	if (marker?.phase === "failed") {
		// A late/duplicate end after a failure must not revive a resting row.
		return;
	}
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
		// Snapshot first, like the resting branch: a row rebuilt from disk carries
		// the window's own "Compacting context…" text as currentTool.summary, so
		// re-deriving here would make that text a fixpoint until the next tool event.
		status.semanticState = "working";
		status.processState = "alive";
		status.summary = previous.summary || deriveSummary(status);
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
			// Keep the snapshot: a retry has to restore the error the row carried
			// before this window, not the compaction message (CR round-1 advisory).
			previous,
			error: facts.errorMessage,
		};
		status.summary = deriveSummary(status);
		return;
	}
	status.summary = previous.summary || deriveSummary(status);
}

/**
 * Build the initial status for a freshly-launched run.
 * @param {RunConfig} config
 * @param {number|null} pid
 * @param {number} now
 * @returns {RunStatus}
 */
export function createRunStatus(config, pid, now) {
	/** @type {RunStatus} */
	const status = {
		version: 1,
		runId: config.runId,
		viewId: config.viewId,
		pid,
		startedAt: now,
		endedAt: null,
		exitCode: null,
		kind: config.kind,
		prompt: config.prompt,
		model: config.model ?? null,
		semanticState: "queued",
		processState: "alive",
		summary: "Queued",
		lastActivityAt: now,
		currentTool: null,
		compaction: null,
		latestAssistantPreview: "",
		question: null,
		pendingQuestions: [],
		error: null,
		lastAgentActivityAt: null,
		stopReason: null,
		stoppedByUser: false,
		turns: 0,
		toolCount: 0,
		eventCount: 0,
		lastEventAt: null,
		usage: null,
		stallReason: null,
		evidenceSummary: null,
		autoState: null,
	};
	return status;
}

/**
 * Apply a single worker event to `status` (mutates in place).
 * @param {RunStatus} status
 * @param {any} event
 * @param {number} now
 * @param {{ interactive?: boolean }} [opts]
 * @returns {boolean} whether this event produced a user-visible change worth persisting.
 */
export function reduceEvent(status, event, now, opts = {}) {
	if (!event || typeof event !== "object" || typeof event.type !== "string") return false;
	let meaningful = false;
	let summaryPinned = false;
	status.eventCount = (status.eventCount ?? 0) + 1;
	status.lastEventAt = now;

	switch (event.type) {
		case "tool_execution_start": {
			const name = event.toolName ?? event.args?.name ?? "tool";
			const args = event.args ?? {};
			status.toolCount += 1;
			if (opts.interactive && isQuestionToolCall(name, args)) {
				upsertPendingQuestion(status, event.toolCallId, questionFromArgs(args));
			} else if (pendingQuestions(status).length === 0) {
				status.currentTool = { name, path: toolPath(args), summary: toolSummary(name, args) };
				status.semanticState = "working";
			}
			preservePendingQuestion(status);
			status.lastActivityAt = now;
			// Unread is keyed off the latest assistant message, not intermediate tool churn.
			meaningful = true;
			break;
		}
		case "tool_execution_end": {
			if (event.isError) status.error = `Tool ${event.toolName ?? ""} failed`.trim();
			// The end event carries no args, so a shape-matched start cannot be recognized here;
			// remove by call id instead (a no-op when this call had no pending question).
			if (opts.interactive) removePendingQuestion(status, event.toolCallId);
			status.currentTool = null;
			status.semanticState = "working";
			status.question = null;
			preservePendingQuestion(status);
			status.lastActivityAt = now;
			// Unread is keyed off the latest assistant message, not intermediate tool churn.
			meaningful = true;
			break;
		}
		case "message_start": {
			if (event.message?.role === "assistant") {
				status.semanticState = "working";
				preservePendingQuestion(status);
				status.lastActivityAt = now;
			}
			break;
		}
		case "message_end": {
			const msg = event.message;
			if (msg?.usage || event.usage) status.usage = mergeUsage(status.usage ?? null, msg?.usage ?? event.usage);
			if (msg?.role === "assistant") {
				status.turns += 1;
				if (msg.model && !status.model) status.model = msg.model;
				if (msg.stopReason) status.stopReason = msg.stopReason;
				if (msg.errorMessage) status.error = msg.errorMessage;
				else if (msg.stopReason === "stop") status.error = null;
				const text = assistantText(msg);
				let nb = { needsInput: false, question: null };
				if (text) {
					// Store the full latest text (truncated) so peek shows meaningful output;
					// deriveSummary() condenses it to a first sentence for the row.
					status.latestAssistantPreview = truncate(text, PREVIEW_MAX);
					nb = detectNeedsInput(text);
					status.question = nb.question;
				}
				status.semanticState = nb.needsInput ? "needs_input" : "working";
				preservePendingQuestion(status);
				status.lastActivityAt = now;
				status.lastAgentActivityAt = now;
				meaningful = true;
			}
			break;
		}
		case "agent_start":
		case "turn_start":
		case "turn_end":
			status.lastActivityAt = now;
			break;
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
		default:
			break;
	}

	if (meaningful) {
		// A leftover failure notice belongs to the compaction that produced it;
		// the next real activity supersedes it (invariant I6).
		if (status.compaction?.phase === "failed" && !COMPACTION_EVENT_TYPES.has(event.type)) status.compaction = null;
		if (!summaryPinned) status.summary = deriveSummary(status);
	}
	return meaningful;
}

/**
 * Mark a run finished and compute its terminal state + summary.
 * @param {RunStatus} status
 * @param {{ exitCode:number|null, stoppedByUser?:boolean, openEnded?:boolean }} opts
 * @param {number} now
 * @returns {RunStatus}
 */
export function finalizeRun(status, opts, now) {
	status.endedAt = now;
	status.exitCode = opts.exitCode;
	status.processState = "exited";
	status.pid = null;
	status.stoppedByUser = Boolean(opts.stoppedByUser);
	status.currentTool = null;
	status.compaction = null;

	const hadPendingQuestions = pendingQuestions(status).length > 0;
	status.pendingQuestions = [];
	const nb = detectNeedsInput(status.latestAssistantPreview);
	// An exited interactive tool can no longer accept an answer. Keep only an
	// independently detected assistant question, never the stale tool prompt.
	if (hadPendingQuestions) status.question = nb.question;
	const needsInput = nb.needsInput || Boolean(status.question);
	if (needsInput && !status.question) status.question = nb.question;

	status.semanticState = finalizeSemanticState({
		exitCode: status.exitCode,
		stopReason: status.stopReason,
		stoppedByUser: status.stoppedByUser,
		needsInput,
		openEnded: opts.openEnded,
	});
	status.lastActivityAt = now;
	status.summary = deriveSummary(status);
	return status;
}

/**
 * Project a RunStatus into the row-level ViewState written to `state.json`.
 * @param {RunStatus} status
 * @param {number} now
 * @returns {import("./types.mjs").ViewState}
 */
export function projectViewState(status, now, previousState = null) {
	return {
		version: 1,
		viewId: status.viewId,
		currentRunId: status.runId,
		semanticState: status.semanticState,
		processState: status.processState,
		summary: status.summary,
		lastActivityAt: status.lastActivityAt,
		updatedAt: now,
		needsInput: status.semanticState === "needs_input",
		hasError: status.semanticState === "failed",
		latestAssistantPreview: status.latestAssistantPreview,
		latestTool: status.currentTool ? { name: status.currentTool.name, path: status.currentTool.path } : null,
		compaction: status.compaction ?? null,
		question: status.question,
		pendingQuestions: pendingQuestions(status),
		error: status.error,
		lastVisitedAt: previousState?.lastVisitedAt ?? null,
		lastAgentActivityAt: status.lastAgentActivityAt ?? previousState?.lastAgentActivityAt ?? null,
		review: status.evidenceSummary ?? previousState?.review,
		diagnostics: previousState?.diagnostics,
		autoState: status.autoState ?? previousState?.autoState ?? null,
		followUps: previousState?.followUps,
		steering: previousState?.steering,
	};
}

/** @param {import("./types.mjs").RunStatus} status */
function pendingQuestions(status) {
	if (!Array.isArray(status.pendingQuestions)) status.pendingQuestions = [];
	return status.pendingQuestions;
}

function questionFromArgs(args) {
	if (typeof args?.question === "string" && args.question.trim()) return args.question.trim();
	for (const item of Array.isArray(args?.questions) ? args.questions : []) {
		const question = String(item?.question ?? item?.prompt ?? "").trim();
		if (question) return question;
	}
	return "Answer the pending question";
}

function upsertPendingQuestion(status, toolCallId, question) {
	const id = String(toolCallId ?? "ask_questions");
	const pending = pendingQuestions(status);
	const existing = pending.find((item) => item.toolCallId === id);
	if (existing) existing.question = question;
	else pending.push({ toolCallId: id, question });
}

function removePendingQuestion(status, toolCallId) {
	const id = String(toolCallId ?? "ask_questions");
	status.pendingQuestions = pendingQuestions(status).filter((item) => item.toolCallId !== id);
}

function preservePendingQuestion(status) {
	const first = pendingQuestions(status)[0];
	if (!first) return;
	status.currentTool = null;
	status.semanticState = "needs_input";
	status.question = first.question;
}

/** @param {import("./types.mjs").EvidenceUsage|null} current @param {any} usage */
function mergeUsage(current, usage) {
	if (!usage || typeof usage !== "object") return current;
	const input = Number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
	const output = Number(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
	const total = Number(usage.totalTokens ?? usage.total_tokens ?? input + output) || input + output;
	return {
		inputTokens: (current?.inputTokens ?? 0) + input,
		outputTokens: (current?.outputTokens ?? 0) + output,
		totalTokens: (current?.totalTokens ?? 0) + total,
	};
}
