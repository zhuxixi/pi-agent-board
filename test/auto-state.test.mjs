import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAutoStateToStatus, autoStateDoneDisabled, autoStateFromModelOrHeuristic, buildAutoStatePrompt, heuristicAutoState, parseAutoStateModelOutput } from "../src/core/auto-state.mjs";

test("parseAutoStateModelOutput normalizes model JSON", () => {
	const c = parseAutoStateModelOutput('{"state":"done","confidence":"high","reason":"tests passed","question":null}', {
		latestAssistantText: "Done. Tests passed.",
		lastAgentActivityAt: 42,
	});
	assert.equal(c.kind, "in_progress");
	assert.equal(c.semanticState, "idle");
	assert.match(c.reason, /auto-done is disabled/i);
	assert.equal(c.source, "model");
	assert.equal(c.confidence, "high");
	assert.equal(c.lastAgentActivityAt, 42);
});

test("autoStateFromModelOrHeuristic falls back to question heuristic", () => {
	const c = autoStateFromModelOrHeuristic("not json", "Which deployment target should I use?");
	assert.equal(c.kind, "needs_input");
	assert.equal(c.semanticState, "needs_input");
	assert.match(c.question, /deployment target/i);
});

test("heuristicAutoState detects done and in-progress turns", () => {
	assert.equal(heuristicAutoState("Done. Fixed the bug and tests pass.").kind, "in_progress");
	assert.equal(heuristicAutoState("I updated one file. Next step is to add tests.").kind, "in_progress");
});

test("heuristicAutoState restores done classification when auto-done flag is off", () => {
	assert.equal(
		heuristicAutoState("Done. Fixed the bug and tests pass.", { env: { AGENT_BOARD_AUTO_STATE_NO_DONE: "0" } }).kind,
		"done",
	);
	assert.equal(autoStateDoneDisabled({}), true);
	assert.equal(autoStateDoneDisabled({ AGENT_BOARD_AUTO_STATE_NO_DONE: "0" }), false);
	assert.equal(autoStateDoneDisabled({ AGENT_BOARD_AUTO_STATE_NO_DONE: "off" }), false);
});

test("applyAutoStateToStatus keeps clean terminal run idle by default", () => {
	const status = {
		processState: "exited",
		semanticState: "idle",
		currentTool: null,
		question: null,
		error: null,
		latestAssistantPreview: "Done. Fixed the bug and tests pass.",
		summary: "Done. Fixed the bug and tests pass.",
	};
	const changed = applyAutoStateToStatus(status, heuristicAutoState(status.latestAssistantPreview), 100);
	assert.equal(changed, true);
	assert.equal(status.semanticState, "idle");
	assert.equal(status.autoState.kind, "in_progress");
});

test("applyAutoStateToStatus moves clean terminal run to completed when auto-done flag is off", () => {
	const status = {
		processState: "exited",
		semanticState: "idle",
		currentTool: null,
		question: null,
		error: null,
		latestAssistantPreview: "Done. Fixed the bug and tests pass.",
		summary: "Done. Fixed the bug and tests pass.",
	};
	const changed = applyAutoStateToStatus(
		status,
		heuristicAutoState(status.latestAssistantPreview, { env: { AGENT_BOARD_AUTO_STATE_NO_DONE: "0" } }),
		100,
	);
	assert.equal(changed, true);
	assert.equal(status.semanticState, "completed");
	assert.equal(status.autoState.kind, "done");
});

test("parseAutoStateModelOutput keeps done when auto-done flag is off", () => {
	const c = parseAutoStateModelOutput('{"state":"done","confidence":"high","reason":"tests passed","question":null}', {
		latestAssistantText: "Done. Tests passed.",
		lastAgentActivityAt: 42,
		env: { AGENT_BOARD_AUTO_STATE_NO_DONE: "0" },
	});
	assert.equal(c.kind, "done");
	assert.equal(c.semanticState, "completed");
});

test("buildAutoStatePrompt omits done option by default and restores it when flag off", () => {
	assert.ok(!/^- done:/m.test(buildAutoStatePrompt("Fix the bug.")));
	assert.ok(/^- done:/m.test(buildAutoStatePrompt("Fix the bug.", { AGENT_BOARD_AUTO_STATE_NO_DONE: "0" })));
});

test("applyAutoStateToStatus never overwrites a manually completed row", () => {
	const status = {
		processState: "exited",
		semanticState: "completed",
		currentTool: null,
		question: null,
		error: null,
		latestAssistantPreview: "Done. Fixed the bug and tests pass.",
		summary: "Done.",
	};
	const changed = applyAutoStateToStatus(status, heuristicAutoState(status.latestAssistantPreview), 100);
	assert.equal(changed, false);
	assert.equal(status.semanticState, "completed");
	assert.equal(status.autoState, undefined);
});
