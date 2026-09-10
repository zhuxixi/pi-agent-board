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
 * - `run_progress` / `followup_started` → payload.statusPatch merges onto the
 *   status clone, then projectViewState recomputes the state side (shared
 *   applyStatusProjection helper).
 * - `reconcile_finalize` → stamps finalizeRun's exact field names on the
 *   status (endedAt/exitCode/processState/pid) but does NOT run finalizeRun:
 *   the reconciler's explicitly observed semanticState governs, and a full
 *   finalize would recompute it from a possibly stale preview.
 *
 * Reject reasons: "unknown_view" | "revision_conflict" | "stale_run" |
 * "manual_fence" | "busy" | "no_change" | "field_not_allowed".
 */
import {
	applyAutoStateToStatus,
	applyAutoStateToViewState,
	isManualCompletion,
} from "./auto-state.mjs";
import { finalizeRun, projectViewState } from "./events.mjs";

/** Command kinds accepted by the View State Coordinator (issue #91 scope). */
export const STATE_COMMAND_KINDS = Object.freeze([
	"mark_completed",
	"auto_state_classified",
	"run_finalized",
	"mark_queued",
	"run_started",
	"run_progress",
	"reconcile_finalize",
	"host_run_failed",
	"archive_view",
	"adopt_session",
	"sync_foreground",
	"plan_ready",
	"followup_started",
	"patch_fields",
]);

/**
 * Kinds the coordinator applies WITHOUT journaling (plan D3/Task-3 decision:
 * run_progress is a periodic self-healing snapshot — ~4 writes/sec/run would
 * bloat the journal unboundedly; a lost beat is overwritten by the next one).
 * Transient commands still materialize and bump materializedRevision, but they
 * are not replayed and not deduped.
 */
export const TRANSIENT_KINDS = Object.freeze(["run_progress"]);

/**
 * Decision-layer reject reasons: journaled, authoritative coordinator verdicts
 * with NO recovery semantics (a retry would be decided the same way). The
 * complement — transport ambiguity ("timeout"/"connection_reset"/
 * "connection_failed"/"coordinator_unavailable") — is the only class where
 * "outcome unknown, replay will recover" diagnostics are honest (issue #91
 * hygiene). validateCommand envelope errors are first-party programmer errors
 * and are not in this set.
 */
export const DECIDED_REJECT_REASONS = Object.freeze(new Set([
	"manual_fence",
	"stale_run",
	"no_change",
	"busy",
	"revision_conflict",
	"unknown_view",
	"unknown_kind",
	"field_not_allowed",
]));

/**
 * Diagnostic fields for a non-applied command result (issue #91 hygiene):
 * decided rejects are info-level skips — the coordinator's verdict is
 * authoritative, so "outcome unknown, replay will recover" would be a lie.
 * Transport ambiguity keeps the warn with the caller's recovery hint.
 * Pure: shapes only, no I/O.
 * @param {string} code diagnostic code stem (e.g. "run_started")
 * @param {string} label human phrase for the message (e.g. "Run bootstrap")
 * @param {string|null} reason rejected reason from the command result
 * @param {string} ambiguousTail recovery hint appended ONLY for ambiguous reasons
 * @returns {{ level: "info"|"warn", code: string, message: string }}
 */
export function commandRejectDiagnostic(code, label, reason, ambiguousTail) {
	const decided = reason != null && DECIDED_REJECT_REASONS.has(reason);
	return decided
		? { level: "info", code: `${code}_skipped`, message: `${label} skipped by the coordinator (${reason}); its decision is authoritative` }
		: { level: "warn", code: `${code}_ambiguous`, message: `${label} outcome unknown (${reason}); if the command was journaled, coordinator replay will recover it; ${ambiguousTail}` };
}

/**
 * Per-source whitelist for `patch_fields` (metadata/evidence-mirror merges).
 * Anything not listed here is rejected with "field_not_allowed" — semantic
 * fields must travel through their dedicated kinds so the guard table in the
 * plan stays exhaustive.
 * @typedef {{ state: string[], status: string[] }} PatchableFields
 * @type {Record<string, PatchableFields>}
 */
export const PATCHABLE_FIELDS = Object.freeze({
	// summary/latestAssistantPreview: the post-exit model-summary persist routes
	// through patch_fields (controller ruling R1 — plan oversight, Task 3).
	"job-runner": Object.freeze({ state: Object.freeze(["review", "evidenceSummary", "summary", "latestAssistantPreview"]), status: Object.freeze(["evidenceSummary", "summary", "latestAssistantPreview"]) }),
	"state-runner": Object.freeze({ state: Object.freeze(["review", "evidenceSummary"]), status: Object.freeze(["evidenceSummary"]) }),
	"service": Object.freeze({ state: Object.freeze(["lastVisitedAt"]), status: Object.freeze([]) }),
	// lastVisitedAt (markVisited): visiting is a user action, so it routes as
	// dashboard-user — the manual fence only fences non-human sources, and
	// legacy stamped lastVisitedAt unconditionally (visit-recency tracking
	// must keep working on manually-completed rows).
	"dashboard-user": Object.freeze({ state: Object.freeze(["lastVisitedAt"]), status: Object.freeze([]) }),
});

/** Who may originate a state command. Non-human sources are fenced by manual completions. */
export const COMMAND_SOURCES = Object.freeze([
	"dashboard-user",
	"service",
	"job-runner",
	"state-runner",
	"pty-runner",
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
	// Transient kinds have no idempotency semantics — the shell neither dedupes
	// nor replays them, so commandId is optional there (echoed in the reply only).
	if ((typeof raw.commandId !== "string" || !raw.commandId) && !TRANSIENT_KINDS.includes(raw.kind)) {
		return { ok: false, error: "missing_commandId" };
	}
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
	switch (raw.kind) {
		case "mark_queued":
			// runId may be null (PTY host launch pins no run — legacy
			// markQueued(id, null)); the key must be present, and when non-null
			// it must be a non-empty string.
			if (!raw.payload || !("runId" in raw.payload)) return { ok: false, error: "missing_runId" };
			if (raw.payload.runId != null && (typeof raw.payload.runId !== "string" || !raw.payload.runId)) return { ok: false, error: "missing_runId" };
			break;
		case "run_started": {
			// Non-empty string (not just != null): a degenerate runId passes the
			// null guard, then the statusRunId binding silently drops the status
			// half while the ack still says "applied" (Task 2 review P2-A).
			if (typeof raw.runId !== "string" || !raw.runId) return { ok: false, error: "missing_runId" };
			const status = raw.payload?.status;
			if (!status || typeof status !== "object") return { ok: false, error: "missing_status" };
			if (typeof status.runId !== "string" || status.runId !== raw.runId) return { ok: false, error: "bad_status" };
			break;
		}
		case "run_progress":
			if (!raw.payload || typeof raw.payload.statusPatch !== "object" || raw.payload.statusPatch == null) return { ok: false, error: "missing_statusPatch" };
			break;
		case "followup_started":
			// The command carries NO runId (a null runId skips the generic stale-run
			// guard against the finished parent run); the NEW run's id travels here
			// and governs the state-side currentRunId (ruling R2).
			if (!raw.payload || typeof raw.payload.statusPatch !== "object" || raw.payload.statusPatch == null) return { ok: false, error: "missing_statusPatch" };
			if (typeof raw.payload.newRunId !== "string" || !raw.payload.newRunId) return { ok: false, error: "missing_newRunId" };
			break;
		case "reconcile_finalize": {
			// Project mode (service.mjs dead-runner path): the run's terminal status
			// exists but the row was never materialized from it — the status itself
			// is the verdict, so semanticState/summary are derived, not passed.
			if (raw.payload?.project === true) {
				if (raw.payload.reason != null && typeof raw.payload.reason !== "string") return { ok: false, error: "bad_reason" };
				break;
			}
			const semanticState = raw.payload?.semanticState;
			if (semanticState !== "failed" && semanticState !== "idle") return { ok: false, error: "bad_semanticState" };
			// The reconciler's summary is caller-provided (legacy parity: both
			// service reconcile sites always stamp a summary, ruling R4).
			if (typeof raw.payload?.summary !== "string" || !raw.payload.summary) return { ok: false, error: "missing_summary" };
			if (raw.payload.reason != null && typeof raw.payload.reason !== "string") return { ok: false, error: "bad_reason" };
			if (raw.payload.exitCode != null && typeof raw.payload.exitCode !== "number") return { ok: false, error: "bad_exitCode" };
			break;
		}
		case "host_run_failed":
			if (raw.payload?.error != null && typeof raw.payload.error !== "string") return { ok: false, error: "bad_error" };
			if (raw.payload?.exitCode != null && typeof raw.payload.exitCode !== "number") return { ok: false, error: "bad_exitCode" };
			break;
		case "sync_foreground":
			if (!raw.payload?.projection || typeof raw.payload.projection !== "object") return { ok: false, error: "missing_projection" };
			break;
		case "plan_ready":
			// The producer (job-runner's plan-ready pass) fires post-finalization and
			// re-points the row at the plan-producing run (ruling R3).
			if (raw.payload?.question != null && typeof raw.payload.question !== "string") return { ok: false, error: "bad_question" };
			if (typeof raw.payload?.runId !== "string" || !raw.payload.runId) return { ok: false, error: "missing_runId" };
			break;
		case "patch_fields": {
			const hasState = raw.payload?.state != null && typeof raw.payload.state === "object";
			const hasStatus = raw.payload?.status != null && typeof raw.payload.status === "object";
			if (!hasState && !hasStatus) return { ok: false, error: "missing_payload" };
			break;
		}
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
	// Generic stale-run guard: a command for a run other than the row's current
	// run is stale. run_started is EXEMPT — it carries its own liveness-scoped
	// guard below (launch-order inversion, cold-start race): the runner is
	// authoritative that its run just started, so a bootstrap landing on a
	// not-alive row applies and re-pins currentRunId. Only two SIMULTANEOUS live
	// runs on one view are the hazard this guard exists for.
	if (
		command.kind !== "run_started" &&
		command.runId &&
		currentState.currentRunId &&
		command.runId !== currentState.currentRunId
	) {
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
		case "mark_queued": {
			return {
				action: "apply",
				reason: command.kind,
				mutate: {
					state: {
						currentRunId: command.payload.runId,
						semanticState: "queued",
						processState: "alive",
						summary: "Queued",
						needsInput: false,
						hasError: false,
						question: null,
						pendingQuestions: [],
						error: null,
						autoState: null,
					},
				},
			};
		}
		case "run_started": {
			// Liveness-scoped stale guard (the generic guard above exempts this
			// kind): only TWO LIVE RUNS on one view are the hazard — a bootstrap for
			// a different runId while this row already runs something else is
			// out-of-order and rejected. When the row is NOT alive, the runner is
			// authoritative that its run just started: apply and re-pin
			// currentRunId. This covers the cold-start race where run_started lands
			// before mark_queued (the runner was spawned first), and re-launches of
			// rows still pointing at the previous run.
			if (
				currentState.processState === "alive" &&
				currentState.currentRunId &&
				currentState.currentRunId !== command.runId
			) {
				return reject("stale_run");
			}
			const statusAfter = cloneJson(command.payload.status);
			return {
				action: "apply",
				reason: command.kind,
				mutate: {
					state: {
						processState: "alive",
						semanticState: "working",
						currentRunId: command.runId,
					},
					status: diffFields(currentStatus, statusAfter),
				},
			};
		}
		case "run_progress": {
			// Liveness semantics: only the row's current live run may move forward.
			// Late/duplicate progress from a finished run is dropped (next run's
			// progress supersedes it anyway — this kind is transient by design).
			//
			// A missing status file splits two ways (F2, split by the hard-down
			// residual closure): a QUALIFIED beat from the row's current live run —
			// full-shaped patch carrying processState/semanticState and the same
			// runId — bootstraps the file, because the coordinator may have been
			// down through the runner's boot window (mark_queued applied,
			// run_started lost): without the bootstrap the row can never converge
			// (beats and finalize both reject forever). Anything else — exited or
			// re-pointed rows, sparse patches that would materialize an
			// undefined-shaped status — stays stale_run (F2's original exposure).
			if (!currentStatus) {
				// P2 hardening: the bootstrap is keyed on command.runId (it becomes the
				// status-file identity), so a degenerate null==null row match must never
				// bootstrap — the shell would silently drop the status half. The check
				// lives here beside its sibling liveness guards (runId semantics for
				// run_progress are decision-layer; envelope validation stays minimal,
				// matching the generic stale-run guard's decision-side read).
				const rowMatches = typeof command.runId === "string" && command.runId.length > 0
					&& currentState.currentRunId === command.runId
					&& currentState.processState === "alive";
				if (!rowMatches || !beatPatchQualifiesForBootstrap(command)) return reject("stale_run");
				// The patch itself is the base: it is the runner's authoritative
				// full in-memory status, so applyStatusProjection's merge-onto-empty
				// materializes exactly the patch (validated full-shaped above).
				return applyStatusProjection(command, currentState, null, now);
			}
			if (currentState.currentRunId !== command.runId || currentState.processState !== "alive") return reject("stale_run");
			return applyStatusProjection(command, currentState, currentStatus, now);
		}
		case "followup_started": {
			// No liveness guard and no command.runId: the follow-up starts from a
			// just-finalized parent run, so the generic stale-run guard must not fire
			// against it. The NEW run's identity (payload.newRunId) governs the
			// state-side currentRunId regardless of what the status patch carries,
			// and a follow-up starting is definitionally the row running again —
			// pin processState so a sparse bootstrap patch can never materialize
			// an undefined (key-dropping) processState on a re-pointed row.
			const result = applyStatusProjection(command, currentState, currentStatus, now);
			return {
				...result,
				mutate: { ...result.mutate, state: { ...result.mutate.state, currentRunId: command.payload.newRunId, processState: "alive" } },
			};
		}
		case "reconcile_finalize": {
			if (currentState.processState !== "alive") return reject("no_change");
			const at = now ?? 0;
			if (command.payload.project === true) {
				// Project mode: faithfully re-materialize the row from the run's
				// terminal status (projectViewState delegation — never copied rules).
				// A missing status means there is nothing to project — stale.
				if (!currentStatus) return reject("stale_run");
				const projected = projectViewState(cloneJson(currentStatus), at, currentState);
				return { action: "apply", reason: command.kind, mutate: { state: diffFields(currentState, projected) } };
			}
			const failed = command.payload.semanticState === "failed";
			const stateClone = cloneJson(currentState);
			stateClone.semanticState = command.payload.semanticState;
			stateClone.processState = "exited";
			// Derived-field clearing at legacy parity (service.mjs reconcile sites,
			// ruling R4): both legacy branches always stamp these fields.
			stateClone.needsInput = false;
			stateClone.hasError = failed;
			stateClone.question = null;
			stateClone.pendingQuestions = [];
			stateClone.error = command.payload.reason ?? null;
			stateClone.summary = command.payload.summary;
			const mutate = { state: diffFields(currentState, stateClone) };
			if (currentStatus) {
				const statusClone = cloneJson(currentStatus);
				// Same field names finalizeRun stamps, minus the semantic recomputation:
				// the reconciler observed the outcome explicitly and its verdict governs.
				statusClone.endedAt = at;
				statusClone.exitCode = command.payload.exitCode ?? null;
				statusClone.processState = "exited";
				statusClone.pid = null;
				statusClone.semanticState = command.payload.semanticState;
				mutate.status = diffFields(currentStatus, statusClone);
			}
			return { action: "apply", reason: command.kind, mutate };
		}
		case "host_run_failed": {
			// No kind-specific guard: the generic manual_fence above is exactly the
			// PR #1 residual-risk closure — a late host crash must not flip a row
			// the user already completed by hand.
			const message = command.payload?.error ?? "PTY host failed";
			const mutate = {
				state: {
					semanticState: "failed",
					processState: "exited",
					// Legacy parity with markRowFailedDirect (runner/pty-runner-legacy.mjs):
					// both summary and error carry the message, hasError/needsInput are
					// stamped so row rendering and warm-host eviction match the direct era.
					summary: message,
					hasError: true,
					needsInput: false,
					error: command.payload?.error ?? null,
				},
			};
			if (currentStatus) {
				mutate.status = {
					semanticState: "failed",
					processState: "exited",
					error: command.payload?.error ?? null,
				};
			}
			return { action: "apply", reason: command.kind, mutate };
		}
		case "archive_view": {
			// Busy rows are allowed: archiving a working row stops it (matches the
			// legacy archiveView behavior this kind replaces).
			return {
				action: "apply",
				reason: command.kind,
				mutate: {
					state: {
						semanticState: "stopped",
						processState: "exited",
						needsInput: false,
						hasError: false,
						question: null,
						pendingQuestions: [],
						error: null,
						autoState: null,
						summary: "Stopped",
					},
				},
			};
		}
		case "adopt_session": {
			if (currentState.processState === "alive") return reject("busy");
			// Derived-field clearing at legacy parity (service.mjs adoptSession reuse
			// path, ruling R4). autoState is intentionally untouched: the legacy
			// adopt path leaves it alone.
			return {
				action: "apply",
				reason: command.kind,
				mutate: {
					state: {
						semanticState: "idle",
						processState: "exited",
						needsInput: false,
						hasError: false,
						question: null,
						pendingQuestions: [],
						error: null,
						summary: "Backgrounded session",
					},
				},
			};
		}
		case "sync_foreground": {
			// Foreground mirrors never own a background run: the projection is the
			// caller's, but currentRunId stays null regardless of what it carries.
			const stateClone = cloneJson(currentState);
			Object.assign(stateClone, command.payload.projection);
			stateClone.currentRunId = null;
			return { action: "apply", reason: command.kind, mutate: { state: diffFields(currentState, stateClone) } };
		}
		case "plan_ready": {
			// The producer (job-runner's plan-ready pass) fires POST-finalization:
			// the run has exited by the time a plan is ready for approval, so a live
			// row means out-of-order delivery — drop it (ruling R3 inverts the guard).
			if (currentState.processState === "alive") return reject("no_change");
			// Exact legacy parity with runner/job-runner.mjs's plan-ready write.
			return {
				action: "apply",
				reason: command.kind,
				mutate: {
					state: {
						semanticState: "needs_input",
						processState: "exited",
						needsInput: true,
						question: command.payload?.question ?? "Approve this plan?",
						summary: "Plan ready for approval",
						currentRunId: command.payload.runId,
					},
				},
			};
		}
		case "patch_fields": {
			const allowed = PATCHABLE_FIELDS[command.source];
			if (!allowed) return reject("field_not_allowed");
			const requestedState = command.payload.state ?? {};
			const requestedStatus = command.payload.status ?? {};
			for (const key of Object.keys(requestedState)) {
				if (!allowed.state.includes(key)) return reject("field_not_allowed");
			}
			for (const key of Object.keys(requestedStatus)) {
				if (!allowed.status.includes(key)) return reject("field_not_allowed");
			}
			const stateClone = cloneJson(currentState);
			Object.assign(stateClone, requestedState);
			const statePatch = diffFields(currentState, stateClone);
			let statusPatch;
			if (currentStatus && Object.keys(requestedStatus).length > 0) {
				const statusClone = cloneJson(currentStatus);
				Object.assign(statusClone, requestedStatus);
				statusPatch = diffFields(currentStatus, statusClone);
			}
			if (Object.keys(statePatch).length === 0 && (!statusPatch || Object.keys(statusPatch).length === 0)) {
				return reject("no_change");
			}
			return { action: "apply", reason: command.kind, mutate: statusPatch ? { state: statePatch, status: statusPatch } : { state: statePatch } };
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

/**
 * Whether a run_progress beat may bootstrap a missing status file: the patch
 * must be full-shaped — carrying processState and semanticState (so the
 * materialized status never has an undefined shape) and pinned to the same
 * runId as the command (so a foreign run's snapshot can never masquerade as
 * this run's bootstrap). Sparse or mismatched patches stay stale_run.
 * @param {object} command
 */
function beatPatchQualifiesForBootstrap(command) {
	const patch = command.payload?.statusPatch;
	return Boolean(
		patch &&
		typeof patch === "object" &&
		typeof patch.processState === "string" &&
		typeof patch.semanticState === "string" &&
		patch.runId === command.runId,
	);
}

/**
 * Shared body for the status-patch kinds (`run_progress`, `followup_started`):
 * merge payload.statusPatch onto the materialized status, then let
 * projectViewState recompute the state side — the projection rules live in
 * events.mjs and are never copied here (same delegation contract as
 * run_finalized).
 *
 * A missing status file is tolerated: the patch merges onto an empty object so
 * the coordinator materializes a fresh status from the patch fields (this is
 * the followup_started bootstrap path — a new run's status file does not exist
 * yet). The caller should send enough fields to make that object meaningful.
 *
 * Pure; timestamp comes from `now`, falling back to the patch's
 * lastActivityAt (payload-carried determinism, same rule as run_finalized).
 *
 * @param {object} command
 * @param {object} currentState
 * @param {object|null} currentStatus
 * @param {number|undefined} now
 */
function applyStatusProjection(command, currentState, currentStatus, now) {
	const patch = command.payload.statusPatch;
	const at = now ?? patch.lastActivityAt ?? 0;
	const statusClone = cloneJson(currentStatus) ?? {};
	Object.assign(statusClone, patch);
	const projectedState = projectViewState(statusClone, at, currentState);
	return {
		action: "apply",
		reason: command.kind,
		mutate: {
			state: diffFields(currentState, projectedState),
			status: diffFields(currentStatus ?? {}, statusClone),
		},
	};
}
