import test from "node:test";
import assert from "node:assert/strict";
import { validateCommand, decideStateTransition, STATE_COMMAND_KINDS, COMMAND_SOURCES, TRANSIENT_KINDS, PATCHABLE_FIELDS } from "../src/core/state-commands.mjs";

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
	assert.deepEqual(PATCHABLE_FIELDS["job-runner"], { state: ["review", "evidenceSummary"], status: ["evidenceSummary"] });
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
	assert.equal(validateCommand({ ...cmd, runId: "r1", payload: {} }).ok, false);
	assert.equal(validateCommand({ ...cmd, runId: "r1", payload: { status: { runId: "r2" } } }).ok, false);
	assert.equal(validateCommand({ ...cmd, runId: "r1", payload: { status: { runId: "r1" } } }).ok, true);
});

test("validateCommand enforces payload shapes for lifecycle kinds", () => {
	assert.equal(validateCommand({ ...baseCmd, kind: "mark_queued", payload: {} }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "mark_queued", payload: { runId: "r9" } }).ok, true);
	assert.equal(validateCommand({ ...baseCmd, kind: "run_progress", payload: {} }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "run_progress", payload: { statusPatch: { turns: 2 } } }).ok, true);
	assert.equal(validateCommand({ ...baseCmd, kind: "followup_started", payload: {} }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "reconcile_finalize", payload: { semanticState: "stopped" } }).ok, false);
	assert.equal(validateCommand({ ...baseCmd, kind: "reconcile_finalize", payload: { semanticState: "failed", reason: "host gone" } }).ok, true);
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
	const cmd = { ...baseCmd, kind: "reconcile_finalize", payload: { semanticState: "failed", reason: "PTY host exited unexpectedly", exitCode: null } };
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
	const cmd = { ...baseCmd, kind: "reconcile_finalize", payload: { semanticState: "idle" } };
	const d = decideStateTransition(cmd, { ...liveState, processState: "exited", semanticState: "idle" }, makeStatus({ processState: "exited" }), 80);
	assert.deepEqual(d, { action: "reject", reason: "no_change" });
});

// -- host_run_failed: the PR #1 residual-risk closure (manual fence) --

test("host_run_failed fails the row and its status", () => {
	const cmd = { ...ptyRunner, kind: "host_run_failed", payload: { error: "host died", exitCode: null } };
	const d = decideStateTransition(cmd, liveState, makeStatus(), 90);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.semanticState, "failed");
	assert.equal(d.mutate.state.processState, "exited");
	assert.equal(d.mutate.state.error, "host died");
	assert.equal(d.mutate.status.semanticState, "failed");
	assert.equal(d.mutate.status.processState, "exited");
	assert.equal(d.mutate.status.error, "host died");
});

test("host_run_failed is fenced by a manual completion (PR #1 residual risk #2)", () => {
	const cmd = { ...ptyRunner, kind: "host_run_failed", payload: { error: "host died" } };
	const d = decideStateTransition(cmd, manualCompletedState, null, 90);
	assert.deepEqual(d, { action: "reject", reason: "manual_fence" });
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

test("plan_ready stamps needs-input on a live row", () => {
	const cmd = { ...baseCmd, kind: "plan_ready", payload: { question: "Approve this plan?" } };
	const d = decideStateTransition(cmd, liveState, makeStatus(), 60);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.state.needsInput, true);
	assert.equal(d.mutate.state.question, "Approve this plan?");
});

test("plan_ready is no_change on an exited row (per plan table)", () => {
	const cmd = { ...baseCmd, kind: "plan_ready", payload: { question: "Approve this plan?" } };
	const d = decideStateTransition(cmd, { ...liveState, processState: "exited", semanticState: "idle" }, null, 60);
	assert.deepEqual(d, { action: "reject", reason: "no_change" });
});

// -- followup_started --

test("followup_started creates the follow-up run status and re-points the row", () => {
	// The command carries the PARENT runId (generic stale-run guard); the new
	// run identity travels in the status patch.
	const cmd = {
		...baseCmd, kind: "followup_started",
		payload: { statusPatch: makeStatus({ runId: "r2", semanticState: "queued", summary: "Queued", startedAt: 70, lastActivityAt: 70 }) },
	};
	const d = decideStateTransition(cmd, { ...liveState, semanticState: "completed", processState: "exited" }, null, 70);
	assert.equal(d.action, "apply");
	assert.equal(d.mutate.status.runId, "r2");
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

test("new kinds keep decisions pure: inputs are not mutated", () => {
	const state = JSON.parse(JSON.stringify(liveState));
	const status = makeStatus();
	const snapshot = JSON.stringify({ state, status });
	decideStateTransition({ ...baseCmd, kind: "run_progress", payload: { statusPatch: { turns: 9 } } }, state, status, 50);
	decideStateTransition({ ...baseCmd, source: "service", kind: "sync_foreground", payload: { projection: { semanticState: "idle" } } }, state, null, 50);
	decideStateTransition({ ...baseCmd, kind: "patch_fields", payload: { state: { review: { x: 1 } } } }, state, status, 50);
	assert.equal(JSON.stringify({ state, status }), snapshot);
});
