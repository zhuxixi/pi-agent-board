import test from "node:test";
import assert from "node:assert/strict";
import { validateCommand, decideStateTransition, commandRejectDiagnostic, DECIDED_REJECT_REASONS, STATE_COMMAND_KINDS, COMMAND_SOURCES, TRANSIENT_KINDS, PATCHABLE_FIELDS } from "../src/core/state-commands.mjs";

const baseCmd = {
	type: "state_command", commandId: "cmd-1", viewId: "v1", runId: "r1",
	source: "state-runner", expectedRevision: null, kind: "auto_state_classified",
	payload: { classification: { version: 1, kind: "done", semanticState: "completed",
		confidence: "high", source: "model", reason: "x", question: null,
		classifiedAt: 1, lastAgentActivityAt: null, textHash: "h" } },
};
const manualCompletedState = { viewId: "v1", currentRunId: "r1", semanticState: "completed",
	processState: "exited", autoState: null, updatedAt: 1 };

test("validateCommand rejects missing commandId", () => {
	assert.equal(validateCommand({ ...baseCmd, commandId: "" }).ok, false);
});

test("auto_state_classified rejected when manual fence active", () => {
	const d = decideStateTransition(baseCmd, manualCompletedState, null);
	assert.deepEqual(d, { action: "reject", reason: "manual_fence" });
});

test("auto_state_classified rejected for stale runId", () => {
	const d = decideStateTransition(baseCmd, { ...manualCompletedState, currentRunId: "r2", semanticState: "idle", autoState: {} }, null);
	assert.equal(d.action, "reject");
	assert.equal(d.reason, "stale_run");
});

test("mark_completed rejected while agent busy", () => {
	const cmd = { ...baseCmd, source: "dashboard-user", kind: "mark_completed", payload: {} };
	const d = decideStateTransition(cmd, { ...manualCompletedState, semanticState: "working", processState: "alive" }, null);
	assert.equal(d.action, "reject");
	assert.equal(d.reason, "busy");
});

test("mark_completed applies and clears autoState (fence signal)", () => {
	const cmd = { ...baseCmd, source: "dashboard-user", kind: "mark_completed", payload: {} };
	const d = decideStateTransition(cmd, { ...manualCompletedState, semanticState: "idle", autoState: { source: "model" } }, null);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.semanticState, "completed");
	assert.equal(d.mutate.state.autoState, null);
});

test("revision_conflict when expectedRevision mismatches", () => {
	const cmd = { ...baseCmd, expectedRevision: 5 };
	const d = decideStateTransition(cmd, { ...manualCompletedState, materializedRevision: 7 }, null);
	assert.deepEqual(d, { action: "reject", reason: "revision_conflict" });
});

test("validateCommand accepts a well-formed command and exposes frozen vocabularies", () => {
	assert.equal(validateCommand(baseCmd).ok, true);
	assert.deepEqual([...STATE_COMMAND_KINDS], [
		"mark_completed", "auto_state_classified", "run_finalized",
		"mark_queued", "run_started", "run_progress", "reconcile_finalize",
		"host_run_failed", "archive_view", "adopt_session", "sync_foreground",
		"plan_ready", "followup_started", "patch_fields",
	]);
	assert.deepEqual([...COMMAND_SOURCES], ["dashboard-user", "service", "job-runner", "state-runner", "pty-runner"]);
	assert.deepEqual([...TRANSIENT_KINDS], ["run_progress"]);
	assert.deepEqual(PATCHABLE_FIELDS["job-runner"], {
		state: ["review", "evidenceSummary", "summary", "latestAssistantPreview"],
		status: ["evidenceSummary", "summary", "latestAssistantPreview"],
	});
	assert.deepEqual(PATCHABLE_FIELDS["state-runner"], { state: ["review", "evidenceSummary"], status: ["evidenceSummary"] });
	assert.deepEqual(PATCHABLE_FIELDS["service"], { state: ["lastVisitedAt"], status: [] });
});

test("validateCommand rejects bad type, kind, source, and revision shapes", () => {
	assert.equal(validateCommand(null).ok, false);
	assert.equal(validateCommand({ ...baseCmd, type: "other" }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "nope" }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, source: "nope" }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, expectedRevision: "7" }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, runId: 5 }).ok, false);
});

test("validateCommand requires a classification payload for auto_state_classified", () => {
	assert.equal(validateCommand({ ...baseCmd, payload: {} }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, payload: { classification: { classifiedAt: "x" } } }).ok, false);
});

test("validateCommand requires an exitCode payload for run_finalized", () => {
	assert.equal(validateCommand({ ...baseCmd, kind: "run_finalized", payload: {} }).ok, false);
	assert.equal(
		validateCommand({ ...baseCmd, kind: "run_finalized", payload: { exitCode: 0 } }).ok,
		true,
	);
	assert.equal(
		validateCommand({ ...baseCmd, kind: "run_finalized", payload: { exitCode: null } }).ok,
		true,
	);
});

test("validateCommand type-checks run_finalized payload fields when present", () => {
	const ok = { ...baseCmd, kind: "run_finalized" };
	assert.equal(validateCommand({ ...ok, payload: { exitCode: 0, endedAt: "100" } }).ok, false);
	assert.equal(validateCommand({ ...ok, payload: { exitCode: 0, lastAgentActivityAt: "x" } }).ok, false);
	assert.equal(validateCommand({ ...ok, payload: { exitCode: 0, stoppedByUser: "yes" } }).ok, false);
	assert.equal(validateCommand({ ...ok, payload: { exitCode: 0, stopReason: 5 } }).ok, false);
	// Nullable/optional fields stay legal:
	assert.equal(
		validateCommand({
			...ok,
			payload: { exitCode: null, endedAt: 100, lastAgentActivityAt: null, stoppedByUser: false, stopReason: null },
		}).ok,
		true,
	);
});

test("unknown view rejects", () => {
	const d = decideStateTransition(baseCmd, null, null);
	assert.deepEqual(d, { action: "reject", reason: "unknown_view" });
});

test("auto_state_classified delegates to auto-state rules and diffs a state patch", () => {
	const state = {
		viewId: "v1", currentRunId: "r1", semanticState: "in_progress", processState: "exited",
		autoState: { version: 1, kind: "in_progress", semanticState: "in_progress", confidence: "low",
			source: "heuristic", reason: "r", question: null, classifiedAt: 0, lastAgentActivityAt: null, textHash: "old" },
		summary: "Running…", latestAssistantPreview: "All done.", question: null, needsInput: false,
		hasError: false, error: null, lastActivityAt: 5, updatedAt: 5,
	};
	const d = decideStateTransition(baseCmd, state, null);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.semanticState, "completed");
	assert.equal(d.mutate.state.autoState.textHash, "h");
	assert.equal(d.mutate.state.updatedAt, 1); // defaults to classification.classifiedAt — pure, no Date.now()
	assert.equal(d.mutate.state.summary, "All done."); // deriveSummary keeps the non-generic preview
	assert.equal(d.mutate.status, undefined); // no status on disk → no status patch
});

test("auto_state_classified with no effective change rejects no_change", () => {
	const d = decideStateTransition(baseCmd, { ...manualCompletedState, semanticState: "working", processState: "alive" }, null);
	assert.deepEqual(d, { action: "reject", reason: "no_change" });
});

test("run_finalized finalizes via events.mjs and produces status+state patches", () => {
	const cmd = {
		...baseCmd, kind: "run_finalized", source: "job-runner",
		payload: { exitCode: 0, endedAt: 100, latestAssistantPreview: "Fresh final text" },
	};
	const state = {
		viewId: "v1", currentRunId: "r1", semanticState: "working", processState: "alive",
		autoState: null, summary: "Running…", latestAssistantPreview: "partial", question: null,
		needsInput: false, hasError: false, error: null, lastActivityAt: 5, updatedAt: 5,
		latestTool: { name: "Bash", path: "/x" }, pendingQuestions: [], lastVisitedAt: 9,
	};
	const status = {
		version: 1, runId: "r1", viewId: "v1", pid: 4242, startedAt: 1, endedAt: null, exitCode: null,
		kind: "dispatch", prompt: "x", model: null, semanticState: "working", processState: "alive",
		summary: "Running…", lastActivityAt: 5, currentTool: { name: "Bash", path: "/x" },
		latestAssistantPreview: "partial", question: null, pendingQuestions: [], error: null,
		lastAgentActivityAt: null, stopReason: null, stoppedByUser: false, turns: 1, toolCount: 0,
		autoState: null,
	};
	const d = decideStateTransition(cmd, state, status, 100);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.status.processState, "exited");
	assert.equal(d.mutate.status.endedAt, 100);
	assert.equal(d.mutate.status.exitCode, 0);
	assert.equal(d.mutate.status.pid, null);
	assert.equal(d.mutate.status.latestAssistantPreview, "Fresh final text");
	assert.equal(d.mutate.status.semanticState, "idle"); // exit 0, no stop reason, no needs-input signal
	assert.equal(d.mutate.state.processState, "exited");
	assert.equal(d.mutate.state.semanticState, "idle");
	assert.equal(d.mutate.state.latestTool, null);
	assert.equal(d.mutate.state.updatedAt, 100);
	assert.equal(d.mutate.state.lastVisitedAt, undefined); // preserved field unchanged → not in patch
});

test("run_finalized rejects when there is no run status to finalize", () => {
	const cmd = { ...baseCmd, kind: "run_finalized", payload: { exitCode: 0 } };
	const d = decideStateTransition(cmd, { ...manualCompletedState, semanticState: "working", processState: "alive" }, null);
	assert.deepEqual(d, { action: "reject", reason: "stale_run" });
});

test("run_finalized rejects an already-exited run (duplicate finalize)", () => {
	const cmd = { ...baseCmd, kind: "run_finalized", payload: { exitCode: 0 } };
	const state = { ...manualCompletedState, semanticState: "idle", autoState: {}, processState: "exited" };
	const d = decideStateTransition(cmd, state, { runId: "r1", processState: "exited" });
	assert.deepEqual(d, { action: "reject", reason: "stale_run" });
});

test("run_finalized overlays payload.stopReason so a fresh abort yields failed", () => {
	// The on-disk status may lag (throttled writes): stopReason null on disk,
	// but the runner observed the abort and reports it in the payload.
	const cmd = {
		...baseCmd, kind: "run_finalized", source: "job-runner",
		payload: { exitCode: null, stopReason: "aborted", endedAt: 100 },
	};
	const state = {
		viewId: "v1", currentRunId: "r1", semanticState: "working", processState: "alive",
		autoState: null, summary: "Running…", latestAssistantPreview: "partial", question: null,
		needsInput: false, hasError: false, error: null, lastActivityAt: 5, updatedAt: 5,
		latestTool: null, pendingQuestions: [], lastVisitedAt: null,
	};
	const status = {
		version: 1, runId: "r1", viewId: "v1", pid: 4242, startedAt: 1, endedAt: null, exitCode: null,
		kind: "dispatch", prompt: "x", model: null, semanticState: "working", processState: "alive",
		summary: "Running…", lastActivityAt: 5, currentTool: null,
		latestAssistantPreview: "partial", question: null, pendingQuestions: [], error: null,
		lastAgentActivityAt: null, stopReason: null, stoppedByUser: false, turns: 1, toolCount: 0,
		autoState: null,
	};
	const d = decideStateTransition(cmd, state, status, 100);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.status.stopReason, "aborted");
	assert.equal(d.mutate.status.semanticState, "failed"); // finalizeSemanticState reads status.stopReason
	assert.equal(d.mutate.state.semanticState, "failed");
});

test("decisions are pure: inputs are not mutated", () => {
	const state = { ...manualCompletedState, semanticState: "idle", autoState: { source: "model" } };
	const snapshot = JSON.stringify(state);
	decideStateTransition({ ...baseCmd, source: "dashboard-user", kind: "mark_completed", payload: {} }, state, null);
	assert.equal(JSON.stringify(state), snapshot);
});

// ---- Phase 2b (issue #91): lifecycle + metadata command kinds -------------

const liveState = {
	viewId: "v1", currentRunId: "r1", semanticState: "working", processState: "alive",
	autoState: { version: 1, kind: "in_progress", semanticState: "in_progress", confidence: "low",
		source: "heuristic", reason: "r", question: null, classifiedAt: 0, lastAgentActivityAt: null, textHash: "t" },
	summary: "Running…", latestAssistantPreview: "partial", question: null, needsInput: false,
	hasError: false, error: null, lastActivityAt: 5, updatedAt: 5, lastVisitedAt: 9,
	lastAgentActivityAt: null, latestTool: null, pendingQuestions: [],
};

function makeStatus(overrides = {}) {
	return {
		version: 1, runId: "r1", viewId: "v1", pid: 4242, startedAt: 1, endedAt: null, exitCode: null,
		kind: "dispatch", prompt: "x", model: null, semanticState: "working", processState: "alive",
		summary: "Running…", lastActivityAt: 5, currentTool: null,
		latestAssistantPreview: "partial", question: null, pendingQuestions: [], error: null,
		lastAgentActivityAt: null, stopReason: null, stoppedByUser: false, turns: 1, toolCount: 0,
		autoState: null, ...overrides,
	};
}

const ptyRunner = { ...baseCmd, source: "pty-runner" };

// -- envelope validation for the new kinds --

test("validateCommand enforces run_started payload status identity", () => {
	const cmd = { ...baseCmd, kind: "run_started", payload: { status: makeStatus() } };
	assert.equal(validateCommand({ ...cmd, runId: undefined }).ok, false);
	// Empty string is the degenerate falsy path (Task 2 review P2-A): the
	// statusRunId binding would silently drop the status half while acking applied.
	assert.equal(validateCommand({ ...cmd, runId: "" }).ok, false);
	assert.equal(validateCommand({ ...cmd, runId: "r1", payload: {} }).ok, false);
	assert.equal(validateCommand({ ...cmd, runId: "r1", payload: { status: { runId: "r2" } } }).ok, false);
	assert.equal(validateCommand({ ...cmd, runId: "r1", payload: { status: { runId: "r1" } } }).ok, true);
});

test("commandRejectDiagnostic: decided rejects are info skips, transport ambiguity keeps the honest warn", () => {
	const decided = commandRejectDiagnostic("run_started", "Run bootstrap", "manual_fence", "otherwise dashboard reconcile will converge the row");
	assert.deepEqual(decided, {
		level: "info",
		code: "run_started_skipped",
		message: "Run bootstrap skipped by the coordinator (manual_fence); its decision is authoritative",
	});
	const ambiguous = commandRejectDiagnostic("run_finalize", "Run finalization", "timeout", "otherwise dashboard reconcile will converge the row");
	assert.equal(ambiguous.level, "warn");
	assert.equal(ambiguous.code, "run_finalize_ambiguous");
	assert.match(ambiguous.message, /outcome unknown \(timeout\); if the command was journaled, coordinator replay will recover it; otherwise dashboard reconcile will converge the row/);
	// Every decision-layer reject reason classifies as decided.
	for (const reason of DECIDED_REJECT_REASONS) {
		assert.equal(commandRejectDiagnostic("x", "X", reason, "tail").level, "info", reason);
	}
});

test("validateCommand enforces payload shapes for lifecycle kinds", () => {
	assert.equal(validateCommand({ ...baseCmd, kind: "mark_queued", payload: {} }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "mark_queued", payload: { runId: "r9" } }).ok, true);
	assert.equal(validateCommand({ ...baseCmd, kind: "run_progress", payload: {} }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "run_progress", payload: { statusPatch: { turns: 2 } } }).ok, true);
	assert.equal(validateCommand({ ...baseCmd, kind: "followup_started", payload: {} }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "reconcile_finalize", payload: { semanticState: "stopped", summary: "x" } }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "reconcile_finalize", payload: { semanticState: "failed", reason: "host gone" } }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "reconcile_finalize", payload: { semanticState: "failed", reason: "host gone", summary: "Failed (PTY host exited)" } }).ok, true);
	assert.equal(validateCommand({ ...baseCmd, kind: "followup_started", payload: { statusPatch: { turns: 1 } } }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "followup_started", payload: { newRunId: "r2", statusPatch: { turns: 1 } } }).ok, true);
	assert.equal(validateCommand({ ...baseCmd, kind: "plan_ready", payload: {} }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "plan_ready", payload: { runId: "r1" } }).ok, true);
	assert.equal(validateCommand({ ...baseCmd, kind: "sync_foreground", payload: {} }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "sync_foreground", payload: { projection: { semanticState: "idle" } } }).ok, true);
	assert.equal(validateCommand({ ...baseCmd, kind: "patch_fields", payload: {} }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "patch_fields", payload: { state: { review: {} } } }).ok, true);
	assert.equal(validateCommand({ ...ptyRunner, kind: "host_run_failed", payload: { error: 5 } }).ok, false);
	assert.equal(validateCommand({ ...ptyRunner, kind: "host_run_failed", payload: { error: "host died", exitCode: null } }).ok, true);
	assert.equal(validateCommand({ ...ptyRunner, kind: "host_run_failed", payload: {} }).ok, true);
});

// -- mark_queued --

test("mark_queued resets the row to a fresh queued run", () => {
	const cmd = { ...baseCmd, source: "service", kind: "mark_queued", payload: { runId: "r9" } };
	const d = decideStateTransition(cmd, { ...manualCompletedState, semanticState: "idle", autoState: {} }, null, 20);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.currentRunId, "r9");
	assert.equal(d.mutate.state.semanticState, "queued");
	assert.equal(d.mutate.state.processState, "alive");
	assert.equal(d.mutate.state.summary, "Queued");
	assert.equal(d.mutate.state.autoState, null);
	assert.equal(d.mutate.status, undefined);
});

// -- run_started --

test("run_started creates the status and flips the row to working", () => {
	const cmd = { ...baseCmd, kind: "run_started", payload: { status: makeStatus({ semanticState: "queued", summary: "Queued" }) } };
	const d = decideStateTransition(cmd, { ...liveState, processState: "exited", semanticState: "idle", currentRunId: null }, null, 10);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.status.runId, "r1");
	assert.equal(d.mutate.status.processState, "alive");
	assert.equal(d.mutate.state.processState, "alive");
	assert.equal(d.mutate.state.semanticState, "working");
	assert.equal(d.mutate.state.currentRunId, "r1");
});

// -- run_progress --

test("run_progress merges the status patch and projects the state side", () => {
	const cmd = { ...baseCmd, kind: "run_progress", payload: { statusPatch: { latestAssistantPreview: "advanced", turns: 2, lastActivityAt: 50 } } };
	const d = decideStateTransition(cmd, liveState, makeStatus(), 50);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.status.latestAssistantPreview, "advanced");
	assert.equal(d.mutate.status.turns, 2);
	assert.equal(d.mutate.status.lastActivityAt, 50);
	assert.equal(d.mutate.state.latestAssistantPreview, "advanced");
	assert.equal(d.mutate.state.lastActivityAt, 50);
	assert.equal(d.mutate.state.updatedAt, 50);
	assert.equal(d.mutate.state.semanticState, undefined); // unchanged → not in patch
});

test("run_progress rejects a dead or re-pointed run (liveness semantics)", () => {
	const cmd = { ...baseCmd, kind: "run_progress", payload: { statusPatch: { turns: 2 } } };
	assert.deepEqual(decideStateTransition(cmd, { ...liveState, processState: "exited" }, makeStatus(), 50), { action: "reject", reason: "stale_run" });
	assert.deepEqual(decideStateTransition(cmd, { ...liveState, currentRunId: null }, null, 50), { action: "reject", reason: "stale_run" });
});

// -- reconcile_finalize --

test("reconcile_finalize finalizes a dead-run row and syncs the status half", () => {
	const cmd = { ...baseCmd, kind: "reconcile_finalize", payload: { semanticState: "failed", reason: "PTY host exited unexpectedly", exitCode: null, summary: "Failed (PTY host exited)" } };
	const d = decideStateTransition(cmd, { ...liveState, processState: "alive" }, makeStatus(), 80);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.semanticState, "failed");
	assert.equal(d.mutate.state.processState, "exited");
	assert.equal(d.mutate.state.error, "PTY host exited unexpectedly");
	assert.equal(d.mutate.status.processState, "exited");
	assert.equal(d.mutate.status.endedAt, 80);
	assert.equal(d.mutate.status.pid, null);
	assert.equal(d.mutate.status.semanticState, "failed");
});

test("reconcile_finalize is a no_change on an already-exited row", () => {
	const cmd = { ...baseCmd, kind: "reconcile_finalize", payload: { semanticState: "idle", summary: "Needs instructions" } };
	const d = decideStateTransition(cmd, { ...liveState, processState: "exited", semanticState: "idle" }, makeStatus({ processState: "exited" }), 80);
	assert.deepEqual(d, { action: "reject", reason: "no_change" });
});

// -- host_run_failed: the PR #1 residual-risk closure (manual fence) --

test("host_run_failed fails the row and its status (legacy-parity summary/hasError/needsInput, final-review F4)", () => {
	const cmd = { ...ptyRunner, kind: "host_run_failed", payload: { error: "host died", exitCode: null } };
	const d = decideStateTransition(cmd, liveState, makeStatus(), 90);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.semanticState, "failed");
	assert.equal(d.mutate.state.processState, "exited");
	assert.equal(d.mutate.state.error, "host died");
	assert.equal(d.mutate.state.summary, "host died", "summary carries the message like legacy markRowFailedDirect");
	assert.equal(d.mutate.state.hasError, true);
	assert.equal(d.mutate.state.needsInput, false);
	assert.equal(d.mutate.status.semanticState, "failed");
	assert.equal(d.mutate.status.processState, "exited");
	assert.equal(d.mutate.status.error, "host died");
});

test("host_run_failed is fenced by a manual completion (PR #1 residual risk #2)", () => {
	const cmd = { ...ptyRunner, kind: "host_run_failed", payload: { error: "host died" } };
	const d = decideStateTransition(cmd, manualCompletedState, null, 90);
	assert.deepEqual(d, { action: "reject", reason: "manual_fence" });
});

// -- final-review F1/F2: re-launching a manually completed row; launch-order inversion --

test("F1: mark_queued as dashboard-user lifts the manual fence; the new run's lifecycle commands apply", () => {
	// User re-launch (reply/dispatch/attach) on a done row: mark_queued travels
	// as dashboard-user and MUST pass the fence — launching is the user changing
	// their verdict.
	const queued = decideStateTransition(
		{ ...baseCmd, source: "dashboard-user", kind: "mark_queued", payload: { runId: "r2" } },
		{ ...manualCompletedState }, null, 20,
	);
	assert.equal(queued.action, "apply");
	assert.equal(queued.mutate.state.semanticState, "queued");
	assert.equal(queued.mutate.state.currentRunId, "r2");
	// After mark_queued the row is no longer a manual completion, so the new
	// run's job-runner lifecycle commands pass the fence normally.
	const queuedRow = { ...manualCompletedState, ...queued.mutate.state, materializedRevision: 3 };
	const started = decideStateTransition(
		{ ...baseCmd, runId: "r2", kind: "run_started", payload: { status: makeStatus({ runId: "r2", semanticState: "queued", summary: "Queued" }) } },
		queuedRow, null, 21,
	);
	assert.equal(started.action, "apply");
	assert.equal(started.mutate.state.semanticState, "working");
	assert.equal(started.mutate.state.currentRunId, "r2");
});

test("F1: the fence still blocks non-user mark_queued (A8 invariant on manually completed rows)", () => {
	const d = decideStateTransition(
		{ ...baseCmd, source: "service", kind: "mark_queued", payload: { runId: "r2" } },
		{ ...manualCompletedState }, null, 20,
	);
	assert.deepEqual(d, { action: "reject", reason: "manual_fence" });
});

test("F2a: run_started landing before mark_queued bootstraps a non-alive row and re-pins currentRunId", () => {
	// Cold-start inversion: the detached runner boots faster than the service's
	// fire-and-forget mark_queued. The row still points at the PREVIOUS run and
	// is not alive — the runner is authoritative that its run just started.
	const staleRow = { ...manualCompletedState, currentRunId: "r0", semanticState: "idle", autoState: {} };
	const started = decideStateTransition(
		{ ...baseCmd, runId: "r1", kind: "run_started", payload: { status: makeStatus() } },
		staleRow, null, 10,
	);
	assert.equal(started.action, "apply");
	assert.equal(started.mutate.state.currentRunId, "r1");
	assert.equal(started.mutate.state.processState, "alive");
	// The later mark_queued (same run) converges instead of being fenced by
	// stale_run against the OLD run id.
	const queued = decideStateTransition(
		{ ...baseCmd, source: "dashboard-user", kind: "mark_queued", payload: { runId: "r1" } },
		{ ...staleRow, ...started.mutate.state, materializedRevision: 3 }, null, 11,
	);
	assert.equal(queued.action, "apply");
	assert.equal(queued.mutate.state.currentRunId, "r1");
});

test("F2b: run_started for a different run while the row is alive with another run is still stale_run", () => {
	const liveOther = { ...liveState, currentRunId: "rA", processState: "alive", semanticState: "working" };
	const d = decideStateTransition(
		{ ...baseCmd, runId: "rB", kind: "run_started", payload: { status: makeStatus({ runId: "rB" }) } },
		liveOther, makeStatus({ runId: "rA" }), 10,
	);
	assert.deepEqual(d, { action: "reject", reason: "stale_run" });
});

// -- archive_view --

test("archive_view marks a busy row stopped (busy rows are allowed)", () => {
	const cmd = { ...baseCmd, source: "service", kind: "archive_view", payload: {} };
	const d = decideStateTransition(cmd, liveState, null, 30);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.semanticState, "stopped");
	assert.equal(d.mutate.state.processState, "exited");
	assert.equal(d.mutate.state.summary, "Stopped");
	assert.equal(d.mutate.state.autoState, null);
});

// -- adopt_session --

test("adopt_session rejects a busy row and adopts an exited one", () => {
	const cmd = { ...baseCmd, source: "service", kind: "adopt_session", payload: {} };
	assert.deepEqual(decideStateTransition(cmd, liveState, null, 30), { action: "reject", reason: "busy" });
	const d = decideStateTransition(cmd, { ...liveState, processState: "exited", semanticState: "working" }, null, 30);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.semanticState, "idle");
	assert.equal(d.mutate.state.processState, "exited");
	assert.equal(d.mutate.state.summary, "Backgrounded session");
});

// -- sync_foreground --

test("sync_foreground applies the caller projection but forces currentRunId null", () => {
	const cmd = {
		...baseCmd, source: "service", kind: "sync_foreground",
		payload: { projection: { semanticState: "idle", processState: "exited", summary: "Backgrounded session", currentRunId: "should-be-dropped" } },
	};
	const d = decideStateTransition(cmd, liveState, null, 40);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.currentRunId, null); // forced: projection carried a runId
	assert.equal(d.mutate.state.semanticState, "idle");
	assert.equal(d.mutate.state.processState, "exited");
});

// -- plan_ready --

test("plan_ready stamps needs-input on an exited row with legacy parity (R3)", () => {
	const cmd = { ...baseCmd, kind: "plan_ready", payload: { runId: "r1" } };
	const exited = { ...liveState, semanticState: "idle", processState: "exited" };
	const d = decideStateTransition(cmd, exited, null, 60);
	assert.equal(d.action, "apply");
	assert.deepEqual(d.mutate.state, {
		semanticState: "needs_input",
		processState: "exited",
		needsInput: true,
		question: "Approve this plan?",
		summary: "Plan ready for approval",
		currentRunId: "r1",
	});
	// payload.question overrides the legacy default
	const override = decideStateTransition({ ...cmd, payload: { runId: "r1", question: "Approve plan X?" } }, exited, null, 60);
	assert.equal(override.mutate.state.question, "Approve plan X?");
});

test("plan_ready is no_change on a live row (producer fires post-finalization only)", () => {
	const cmd = { ...baseCmd, kind: "plan_ready", payload: { runId: "r1" } };
	assert.deepEqual(decideStateTransition(cmd, liveState, makeStatus(), 60), { action: "reject", reason: "no_change" });
});

// -- followup_started --

test("followup_started creates the follow-up run status and re-points the row (R2)", () => {
	// The command carries NO runId (the generic stale-run guard must not fire
	// against the finished parent run); the NEW run identity travels in
	// payload.newRunId and governs the state-side currentRunId even when the
	// status patch itself carries no runId.
	const cmd = {
		...baseCmd, runId: null, kind: "followup_started",
		payload: { newRunId: "r2", statusPatch: { semanticState: "queued", summary: "Queued", lastActivityAt: 70 } },
	};
	const d = decideStateTransition(cmd, { ...liveState, semanticState: "completed", processState: "exited" }, null, 70);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.currentRunId, "r2");
	assert.equal(d.mutate.state.semanticState, "queued");
	assert.equal(d.mutate.state.processState, "alive");
});

// -- patch_fields --

test("patch_fields applies whitelisted mirror fields per source", () => {
	const cmd = {
		...baseCmd, kind: "patch_fields",
		payload: { state: { review: { toolCount: 3 } }, status: { evidenceSummary: { toolCount: 3 } } },
	};
	const d = decideStateTransition(cmd, liveState, makeStatus({ evidenceSummary: null }), 55);
	assert.equal(d.action, "apply");
	assert.deepEqual(d.mutate.state.review, { toolCount: 3 });
	assert.deepEqual(d.mutate.status.evidenceSummary, { toolCount: 3 });
});

test("patch_fields rejects out-of-whitelist fields, unknown sources, and no-op patches", () => {
	const offWhitelist = { ...baseCmd, kind: "patch_fields", payload: { state: { lastVisitedAt: 42 } } };
	assert.deepEqual(decideStateTransition(offWhitelist, liveState, null, 55), { action: "reject", reason: "field_not_allowed" });

	const fromDashboard = { ...baseCmd, source: "dashboard-user", kind: "patch_fields", payload: { state: { review: {} } } };
	assert.deepEqual(decideStateTransition(fromDashboard, liveState, null, 55), { action: "reject", reason: "field_not_allowed" });

	const statusSide = { ...baseCmd, kind: "patch_fields", payload: { status: { summary: "x" } } };
	assert.deepEqual(decideStateTransition(statusSide, liveState, makeStatus(), 55), { action: "reject", reason: "field_not_allowed" });

	const noOp = { ...baseCmd, kind: "patch_fields", payload: { state: { review: liveState.review } } };
	assert.deepEqual(decideStateTransition(noOp, liveState, null, 55), { action: "reject", reason: "no_change" });
});

test("patch_fields honors the stale-run guard when payload.runId is set", () => {
	const cmd = { ...baseCmd, kind: "patch_fields", runId: "rOld", payload: { state: { review: {} } } };
	assert.deepEqual(decideStateTransition(cmd, liveState, null, 55), { action: "reject", reason: "stale_run" });
});

// ---- Controller-ruling corrections (R1-R4) -------------------------------

// R1: job-runner patch_fields whitelist gains summary + latestAssistantPreview
// (the post-exit model-summary persist routes through patch_fields in Task 3).
test("R1: job-runner patch_fields accepts summary and latestAssistantPreview on both sides", () => {
	const cmd = {
		...baseCmd, source: "job-runner", kind: "patch_fields",
		payload: {
			state: { summary: "Refactored the parser", latestAssistantPreview: "final text" },
			status: { summary: "Refactored the parser", latestAssistantPreview: "final text" },
		},
	};
	const d = decideStateTransition(cmd, liveState, makeStatus(), 55);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.summary, "Refactored the parser");
	assert.equal(d.mutate.state.latestAssistantPreview, "final text");
	assert.equal(d.mutate.status.summary, "Refactored the parser");
	assert.equal(d.mutate.status.latestAssistantPreview, "final text");
	// state-runner keeps the narrower mirror-only whitelist
	assert.deepEqual(PATCHABLE_FIELDS["state-runner"], { state: ["review", "evidenceSummary"], status: ["evidenceSummary"] });
});

// R2: followup_started validates newRunId and the null command.runId skips the
// generic stale-run guard even when the row still points at the parent run.
test("R2: followup_started re-points currentRunId with the stale-run guard skipped", () => {
	const cmd = {
		...baseCmd, runId: null, kind: "followup_started",
		payload: { newRunId: "r2", statusPatch: { semanticState: "queued", summary: "Queued", lastActivityAt: 70 } },
	};
	const parentState = { ...liveState, semanticState: "completed", processState: "exited", currentRunId: "r1" };
	const d = decideStateTransition(cmd, parentState, null, 70);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.currentRunId, "r2"); // from payload.newRunId, not the patch
	assert.equal(d.mutate.state.semanticState, "queued");
});

// R3: plan_ready guard inverted (producer fires post-finalization) + exact
// legacy parity with runner/job-runner.mjs's plan-ready write.
test("R3: plan_ready applies post-exit with legacy parity and rejects a live row", () => {
	const cmd = { ...baseCmd, kind: "plan_ready", payload: { runId: "r1" } };
	const exited = { ...liveState, semanticState: "idle", processState: "exited", needsInput: false, question: null };
	const d = decideStateTransition(cmd, exited, null, 60);
	assert.equal(d.action, "apply");
	assert.deepEqual(d.mutate.state, {
		semanticState: "needs_input",
		processState: "exited",
		needsInput: true,
		question: "Approve this plan?",
		summary: "Plan ready for approval",
		currentRunId: "r1",
	});
	assert.deepEqual(decideStateTransition(cmd, liveState, makeStatus(), 60), { action: "reject", reason: "no_change" });
	const override = decideStateTransition({ ...cmd, payload: { runId: "r1", question: "Approve plan X?" } }, exited, null, 60);
	assert.equal(override.mutate.state.question, "Approve plan X?");
});

// R4: derived-field clearing at legacy parity (service.mjs markQueued /
// adoptSession / reconcile sites).
test("R4: mark_queued clears derived fields at legacy parity (exact patch)", () => {
	const cmd = { ...baseCmd, source: "service", kind: "mark_queued", payload: { runId: "r9" } };
	const dirty = {
		...manualCompletedState, semanticState: "failed", needsInput: true, hasError: true,
		question: "old?", pendingQuestions: [{ toolCallId: "t", question: "q" }], error: "old error", summary: "Failed",
	};
	const d = decideStateTransition(cmd, dirty, null, 20);
	assert.equal(d.action, "apply");
	assert.deepEqual(d.mutate.state, {
		currentRunId: "r9",
		semanticState: "queued",
		processState: "alive",
		summary: "Queued",
		needsInput: false,
		hasError: false,
		question: null,
		pendingQuestions: [],
		error: null,
		autoState: null,
	});
});

test("R4: adopt_session clears derived fields at legacy parity (exact patch)", () => {
	const cmd = { ...baseCmd, source: "service", kind: "adopt_session", payload: {} };
	const dirty = {
		...liveState, semanticState: "working", processState: "exited", needsInput: true, hasError: true,
		question: "old?", pendingQuestions: [{ toolCallId: "t", question: "q" }], error: "old error",
	};
	const d = decideStateTransition(cmd, dirty, null, 30);
	assert.equal(d.action, "apply");
	assert.deepEqual(d.mutate.state, {
		semanticState: "idle",
		processState: "exited",
		needsInput: false,
		hasError: false,
		question: null,
		pendingQuestions: [],
		error: null,
		summary: "Backgrounded session",
	});
	// autoState is NOT touched: the legacy adopt path leaves it alone.
	assert.equal(d.mutate.state.autoState, undefined);
});

test("R4: reconcile_finalize clears derived fields at legacy parity", () => {
	const dirty = {
		...liveState, needsInput: true, hasError: true, error: "old error",
		question: "old?", pendingQuestions: [{ toolCallId: "t", question: "q" }],
	};
	const failedCmd = {
		...baseCmd, kind: "reconcile_finalize",
		payload: { semanticState: "failed", reason: "PTY host exited unexpectedly", exitCode: null, summary: "Failed (PTY host exited)" },
	};
	const d = decideStateTransition(failedCmd, dirty, null, 80);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.needsInput, false);
	assert.equal(d.mutate.state.question, null);
	assert.deepEqual(d.mutate.state.pendingQuestions, []);
	assert.equal(d.mutate.state.hasError, undefined); // stays true → unchanged → not in patch
	assert.equal(d.mutate.state.error, "PTY host exited unexpectedly");
	assert.equal(d.mutate.state.summary, "Failed (PTY host exited)");

	const idleCmd = { ...baseCmd, kind: "reconcile_finalize", payload: { semanticState: "idle", summary: "Needs instructions" } };
	const idle = decideStateTransition(idleCmd, dirty, null, 80);
	assert.equal(idle.action, "apply");
	assert.equal(idle.mutate.state.hasError, false);
	assert.equal(idle.mutate.state.error, null);
	assert.equal(idle.mutate.state.summary, "Needs instructions");
});

test("new kinds keep decisions pure: inputs are not mutated", () => {
	const state = JSON.parse(JSON.stringify(liveState));
	const status = makeStatus();
	const snapshot = JSON.stringify({ state, status });
	decideStateTransition({ ...baseCmd, kind: "run_progress", payload: { statusPatch: { turns: 9 } } }, state, status, 50);
	decideStateTransition({ ...baseCmd, source: "service", kind: "sync_foreground", payload: { projection: { semanticState: "idle" } } }, state, null, 50);
	decideStateTransition({ ...baseCmd, kind: "patch_fields", payload: { state: { review: { x: 1 } } } }, state, status, 50);
	assert.equal(JSON.stringify({ state, status }), snapshot);
});

// -- Task 2: transient-command contracts (shell support lives in the coordinator) --

test("run_progress without a materialized status: qualified live-run beat bootstraps, everything else stays stale_run (F2 split)", () => {
	// Hard-down residual (issue #91): if the coordinator was down through the
	// runner's boot window, run_started was lost while mark_queued landed — the
	// row is alive with the run pinned but no status file exists. The first
	// beat after recovery carries the runner's FULL in-memory status; a
	// qualified beat bootstraps the file (otherwise the row can never converge:
	// beats and finalize both reject forever). Everything else keeps F2's
	// stale_run: non-matching/exited rows, and sparse patches that would
	// materialize an undefined-shaped status.
	const fullPatch = makeStatus({ lastActivityAt: 50, latestAssistantPreview: "advanced" });
	const bootstrap = decideStateTransition(
		{ ...baseCmd, kind: "run_progress", payload: { statusPatch: fullPatch } },
		liveState, null, 50,
	);
	assert.equal(bootstrap.action, "apply");
	assert.equal(bootstrap.reason, "run_progress");
	// mutate.status carries the full patch (every field that differs from nothing).
	for (const key of ["runId", "viewId", "pid", "semanticState", "processState", "lastActivityAt"]) {
		assert.equal(bootstrap.mutate.status[key], fullPatch[key], `status patch carries ${key}`);
	}
	assert.ok(!("materializedRevision" in bootstrap.mutate.status), "file stamp never travels in a patch");
	// State side: projected from the bootstrapped status (delegation, not copied rules).
	assert.equal(bootstrap.mutate.state.semanticState, undefined); // working → working unchanged
	assert.equal(bootstrap.mutate.state.latestAssistantPreview, "advanced");
	assert.equal(bootstrap.mutate.state.lastActivityAt, 50);

	// Sparse patch (no processState/semanticState) on a matching live row: stale_run —
	// projecting it would materialize an undefined-shaped status (F2's original exposure).
	const sparse = { ...baseCmd, kind: "run_progress", payload: { statusPatch: { turns: 2 } } };
	assert.deepEqual(decideStateTransition(sparse, liveState, null, 50), { action: "reject", reason: "stale_run" });

	// Full patch but the row is not on this run (exited / re-pointed): stale_run.
	assert.deepEqual(
		decideStateTransition({ ...baseCmd, kind: "run_progress", payload: { statusPatch: fullPatch } }, { ...liveState, processState: "exited" }, null, 50),
		{ action: "reject", reason: "stale_run" },
	);
	assert.deepEqual(
		decideStateTransition({ ...baseCmd, kind: "run_progress", payload: { statusPatch: fullPatch } }, { ...liveState, currentRunId: "r2" }, null, 50),
		{ action: "reject", reason: "stale_run" },
	);

	// Full-shaped but carrying a DIFFERENT run's identity: stale_run (identity guard).
	assert.deepEqual(
		decideStateTransition({ ...baseCmd, kind: "run_progress", payload: { statusPatch: makeStatus({ runId: "r2" }) } }, liveState, null, 50),
		{ action: "reject", reason: "stale_run" },
	);

	// P2 hardening: a degenerate null==null identity can never bootstrap — the
	// materialized status file is keyed on command.runId, so a runId-less beat
	// has nothing legitimate to create (pre-hardening it returned "applied"
	// while the shell silently dropped the status half).
	const nullRunBeat = { type: "state_command", viewId: "v1", runId: null, source: "job-runner", kind: "run_progress", payload: { statusPatch: makeStatus({ runId: null }) } };
	assert.deepEqual(
		decideStateTransition(nullRunBeat, { ...liveState, currentRunId: null }, null, 50),
		{ action: "reject", reason: "stale_run" },
	);
});

test("transient kinds may omit commandId; journaled kinds may not", () => {
	const progress = { type: "state_command", viewId: "v1", runId: "r1", source: "job-runner", kind: "run_progress", payload: { statusPatch: { turns: 2 } } };
	assert.equal(validateCommand(progress).ok, true, "run_progress has no idempotency semantics — commandId optional");
	const finalized = { type: "state_command", viewId: "v1", runId: "r1", source: "job-runner", kind: "run_finalized", payload: { exitCode: 0 } };
	assert.equal(validateCommand(finalized).ok, false, "journaled kinds still require commandId for dedupe/replay");
});

// -- Task 6: service-migration extensions (dashboard-user patch whitelist,
//    nullable mark_queued runId, reconcile_finalize project mode) --

test("patch_fields allows dashboard-user lastVisitedAt and still rejects semantic fields", () => {
	const cmd = { ...baseCmd, source: "dashboard-user", kind: "patch_fields", payload: { state: { lastVisitedAt: 123 } } };
	assert.equal(validateCommand(cmd).ok, true);
	const d = decideStateTransition(cmd, { ...liveState, semanticState: "completed", autoState: null }, null, 50);
	assert.equal(d.action, "apply", "visiting a manually-completed row keeps stamping lastVisitedAt (legacy parity — fence is for non-human sources)");
	assert.equal(d.mutate.state.lastVisitedAt, 123);
	const semantic = { ...cmd, payload: { state: { semanticState: "working" } } };
	assert.deepEqual(decideStateTransition(semantic, { ...liveState, semanticState: "completed", autoState: null }, null, 50), { action: "reject", reason: "field_not_allowed" });
});

test("mark_queued accepts a null runId (PTY host launch pins no run)", () => {
	const cmd = { type: "state_command", commandId: "c1", viewId: "v1", runId: null, source: "service", kind: "mark_queued", expectedRevision: null, payload: { runId: null } };
	assert.equal(validateCommand(cmd).ok, true);
	const d = decideStateTransition(cmd, { ...liveState, processState: "exited", currentRunId: null }, null, 50);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.currentRunId, null);
	assert.equal(d.mutate.state.semanticState, "queued");
	const badType = { ...cmd, payload: { runId: 7 } };
	assert.equal(validateCommand(badType).ok, false);
});

test("reconcile_finalize project mode derives the verdict from the materialized status", () => {
	const terminalStatus = makeStatus();
	terminalStatus.semanticState = "completed";
	terminalStatus.processState = "exited";
	terminalStatus.endedAt = 40;
	const cmd = { ...baseCmd, runId: "r1", source: "service", kind: "reconcile_finalize", payload: { project: true } };
	assert.equal(validateCommand(cmd).ok, true, "project mode needs no semanticState/summary");
	const d = decideStateTransition(cmd, { ...liveState, currentRunId: "r1" }, terminalStatus, 50);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.semanticState, "completed", "the status's own verdict governs — never forced to failed/idle");
	assert.equal(d.mutate.state.processState, "exited");
	// No status to project from → nothing faithful to materialize.
	assert.deepEqual(decideStateTransition(cmd, { ...liveState, currentRunId: "r1" }, null, 50), { action: "reject", reason: "stale_run" });
});
