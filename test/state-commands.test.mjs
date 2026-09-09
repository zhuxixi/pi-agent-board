import test from "node:test";
import assert from "node:assert/strict";
import { validateCommand, decideStateTransition, STATE_COMMAND_KINDS, COMMAND_SOURCES } from "../src/core/state-commands.mjs";

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
	assert.deepEqual([...STATE_COMMAND_KINDS], ["mark_completed", "auto_state_classified", "run_finalized"]);
	assert.deepEqual([...COMMAND_SOURCES], ["dashboard-user", "service", "job-runner", "state-runner"]);
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
