/**
 * Pure decision layer for View State Coordinator commands (issue #91, spec D3).
 *
 * This module is the single source of truth for "which semantic-state mutations
 * are allowed". The coordinator process shell (runner/state-coordinator.mjs)
 * owns all side effects — journal, socket, file writes — and calls into this
 * module for every decision. No fs, no net, no Date.now(): every timestamp is
 * taken from an explicit `now` argument or from command payload fields, so
 * decisions are deterministic and exhaustively unit-testable (same pattern as
 * host-coordination.mjs from issue #70).
 *
 * Delegation contract (rules are never copied here):
 * - `auto_state_classified` → auto-state.mjs applyAutoStateToViewState/Status
 *   run on deep clones; changed fields are diffed into field patches.
 * - `run_finalized` → events.mjs finalizeRun + projectViewState run on a deep
 *   clone of the on-disk status; diffs produce the status/state patches.
 *
 * Reject reasons: "unknown_view" | "revision_conflict" | "stale_run" |
 * "manual_fence" | "busy" | "no_change".
 */
import {
	applyAutoStateToStatus,
	applyAutoStateToViewState,
	isManualCompletion,
} from "./auto-state.mjs";
import { finalizeRun, projectViewState } from "./events.mjs";

/** Command kinds accepted in PR #1 (view-state coordinator scope). */
export const STATE_COMMAND_KINDS = Object.freeze([
	"mark_completed",
	"auto_state_classified",
	"run_finalized",
]);

/** Who may originate a state command. Non-human sources are fenced by manual completions. */
export const COMMAND_SOURCES = Object.freeze([
	"dashboard-user",
	"service",
	"job-runner",
	"state-runner",
]);

/**
 * A semantic-state mutation request routed through the coordinator.
 * @typedef {Object} StateCommand
 * @property {"state_command"} type
 * @property {string} commandId Stable id — journal replays return the original result.
 * @property {string} viewId
 * @property {string} [runId] Active run this command belongs to (stale-run fenced).
 * @property {typeof COMMAND_SOURCES[number]} source
 * @property {number|null} [expectedRevision] Optimistic concurrency on materializedRevision.
 * @property {typeof STATE_COMMAND_KINDS[number]} kind
 * @property {Record<string, unknown>} payload Kind-specific; validated per kind.
 */

/**
 * Validate the command envelope plus kind-specific payload presence. Pure.
 * @param {any} raw
 * @returns {{ ok: true, command: object } | { ok: false, error: string }}
 */
export function validateCommand(raw) {
	if (!raw || raw.type !== "state_command") return { ok: false, error: "bad_type" };
	if (typeof raw.commandId !== "string" || !raw.commandId) return { ok: false, error: "missing_commandId" };
	if (typeof raw.viewId !== "string" || !raw.viewId) return { ok: false, error: "missing_viewId" };
	if (!STATE_COMMAND_KINDS.includes(raw.kind)) return { ok: false, error: "unknown_kind" };
	if (!COMMAND_SOURCES.includes(raw.source)) return { ok: false, error: "unknown_source" };
	if (raw.expectedRevision != null && typeof raw.expectedRevision !== "number") return { ok: false, error: "bad_expectedRevision" };
	if (raw.runId != null && typeof raw.runId !== "string") return { ok: false, error: "bad_runId" };
	if (raw.kind === "auto_state_classified") {
		const classification = raw.payload?.classification;
		if (!classification || typeof classification !== "object") return { ok: false, error: "missing_classification" };
		if (typeof classification.classifiedAt !== "number") return { ok: false, error: "bad_classification" };
	}
	if (raw.kind === "run_finalized") {
		if (!raw.payload || typeof raw.payload !== "object") return { ok: false, error: "missing_payload" };
		if (typeof raw.payload.exitCode !== "number" && raw.payload.exitCode !== null) return { ok: false, error: "missing_exitCode" };
		if (raw.payload.endedAt != null && typeof raw.payload.endedAt !== "number") return { ok: false, error: "bad_endedAt" };
		if (raw.payload.lastAgentActivityAt != null && typeof raw.payload.lastAgentActivityAt !== "number") return { ok: false, error: "bad_lastAgentActivityAt" };
		if (raw.payload.stoppedByUser != null && typeof raw.payload.stoppedByUser !== "boolean") return { ok: false, error: "bad_stoppedByUser" };
		if (raw.payload.stopReason != null && typeof raw.payload.stopReason !== "string") return { ok: false, error: "bad_stopReason" };
	}
	return { ok: true, command: raw };
}

/**
 * Decide whether a command may mutate the view state, and which field patches
 * to apply. Pure: deep-clones inputs before delegating, never mutates arguments,
 * never touches the clock (pass `now` for wall-clock timestamps; falls back to
 * payload-provided timestamps for determinism).
 *
 * @param {object} command
 * @param {object|null} currentState ViewState as currently materialized (state.json).
 * @param {object|null} currentStatus RunStatus for command.runId as currently
 *   materialized (status.json), when a status file exists; null otherwise.
 * @param {number} [now] Wall-clock epoch ms supplied by the coordinator shell.
 * @returns {{ action: "apply", mutate: { state?: object, status?: object }, reason: string }
 *          | { action: "reject", reason: string }}
 *   `mutate.state`/`mutate.status` are sparse field patches — only fields whose
 *   value actually changed. The coordinator merges them onto the materialized
 *   files and stamps the shared materializedRevision.
 */
export function decideStateTransition(command, currentState, currentStatus, now = undefined) {
	if (!currentState) return reject("unknown_view");
	if (command.expectedRevision != null && command.expectedRevision !== (currentState.materializedRevision ?? 0)) {
		return reject("revision_conflict");
	}
	if (command.runId && currentState.currentRunId && command.runId !== currentState.currentRunId) {
		return reject("stale_run");
	}
	// Manual completions are user verdicts: only a human source may act on a
	// fenced row (this is the #46 invariant — late classifications lose).
	if (command.source !== "dashboard-user" && isManualCompletion(currentState)) {
		return reject("manual_fence");
	}
	switch (command.kind) {
		case "mark_completed": {
			if (currentState.processState === "alive") return reject("busy");
			// autoState: null on both artifacts is the manual-completion fence
			// signal that later auto-state commands (and the auto-state rules
			// themselves) key off — see isManualCompletion().
			return {
				action: "apply",
				reason: "manual_completion",
				mutate: {
					state: {
						semanticState: "completed",
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
		case "auto_state_classified": {
			const classification = command.payload?.classification;
			const at = now ?? classification?.classifiedAt;
			const stateClone = cloneJson(currentState);
			const statusClone = cloneJson(currentStatus);
			const stateChanged = applyAutoStateToViewState(stateClone, classification, at);
			const statusChanged = statusClone ? applyAutoStateToStatus(statusClone, classification, at) : false;
			if (!stateChanged && !statusChanged) return reject("no_change");
			return { action: "apply", reason: command.kind, mutate: buildPatches(currentState, stateClone, stateChanged, currentStatus, statusClone, statusChanged) };
		}
		case "run_finalized": {
			const payload = command.payload ?? {};
			// Only a live run record for this view's current run may be finalized;
			// anything else is stale (duplicate finalize commands included).
			if (!currentStatus) return reject("stale_run");
			if (currentState.currentRunId !== command.runId) return reject("stale_run");
			if (currentState.processState !== "alive") return reject("stale_run");
			const at = now ?? payload.endedAt ?? 0;
			const statusClone = cloneJson(currentStatus);
			// Overlay fresher fields the throttled on-disk write may lag behind.
			// stopReason must be overlaid onto the status itself: finalizeSemanticState
			// reads status.stopReason (finalizeRun's opts have no stopReason slot), so
			// a fresh "aborted" reported by the runner would otherwise be lost and the
			// run would land on "idle" instead of "failed".
			if (typeof payload.latestAssistantPreview === "string") statusClone.latestAssistantPreview = payload.latestAssistantPreview;
			if (payload.lastAgentActivityAt != null) statusClone.lastAgentActivityAt = payload.lastAgentActivityAt;
			if (payload.stopReason != null) statusClone.stopReason = payload.stopReason;
			finalizeRun(statusClone, {
				exitCode: payload.exitCode,
				stoppedByUser: payload.stoppedByUser,
				stopReason: payload.stopReason,
				openEnded: payload.openEnded,
			}, at);
			const projectedState = projectViewState(statusClone, at, currentState);
			return {
				action: "apply",
				reason: command.kind,
				mutate: {
					state: diffFields(currentState, projectedState),
					status: diffFields(currentStatus, statusClone),
				},
			};
		}
		default:
			// validateCommand already rejects unknown kinds; defensive only.
			return reject("unknown_kind");
	}
}

/** @param {string} reason @returns {{ action: "reject", reason: string }} */
function reject(reason) {
	return { action: "reject", reason };
}

/** JSON round-trip clone: patches stay JSON-serializable (they are written to disk). */
function cloneJson(value) {
	return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Shallow top-level field diff (deep-equality per field via JSON form), so a
 * cloned-but-unchanged nested object never lands in a patch.
 * @param {object|null} before
 * @param {object} after
 */
function diffFields(before, after) {
	const patch = {};
	for (const key of Object.keys(after)) {
		if (JSON.stringify(before?.[key]) !== JSON.stringify(after[key])) patch[key] = after[key];
	}
	return patch;
}

/** @param {boolean} stateChanged @param {boolean} statusChanged */
function buildPatches(currentState, stateClone, stateChanged, currentStatus, statusClone, statusChanged) {
	const mutate = {};
	if (stateChanged) mutate.state = diffFields(currentState, stateClone);
	if (statusChanged) mutate.status = diffFields(currentStatus, statusClone);
	return mutate;
}
