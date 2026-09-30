/** F3 unit tests (issue #95): the flake black-box. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createView } from "../src/core/store.mjs";
import { capturePostmortem, formatPostmortem, waitForWithPostmortem } from "../test-support/flake-postmortem.mjs";

test("A6: formatPostmortem renders the last-observed block deterministically", () => {
	const text = formatPostmortem({
		status: { semanticState: "working", processState: "alive", endedAt: null, pid: 4242 },
		state: { semanticState: "working", currentRunId: "run_1" },
		host: null,
		diagnosticsTail: [{ code: "runner_start", at: 1 }, { code: "stop_latch_armed", at: 2 }],
		journalTail: ["{\"kind\":\"run_started\"}"],
	});
	assert.match(text, /flake postmortem/);
	assert.match(text, /"semanticState":"working"/);
	assert.match(text, /stop_latch_armed/);
	assert.match(text, /run_started/);
	assert.doesNotMatch(text, /undefined/);
});

test("A6: formatPostmortem marks absent artifacts explicitly", () => {
	const text = formatPostmortem({ status: null, state: null, host: null, diagnosticsTail: [], journalTail: [] });
	assert.match(text, /status: <absent>/);
	assert.match(text, /state: <absent>/);
	assert.match(text, /host: <absent>/);
});

test("A6: waitForWithPostmortem returns the predicate value on success", async () => {
	const value = await waitForWithPostmortem(() => 42, { timeoutMs: 100, intervalMs: 5 });
	assert.equal(value, 42);
});

test("A6: a timeout throws with the legacy prefix plus the postmortem block", async () => {
	let captured = 0;
	const err = await waitForWithPostmortem(() => false, {
		timeoutMs: 30,
		intervalMs: 5,
		capture: () => {
			captured += 1;
			return formatPostmortem({ status: { semanticState: "working", endedAt: null }, state: null, host: null, diagnosticsTail: [], journalTail: [] });
		},
	}).then(
		() => null,
		(e) => e,
	);
	assert.ok(err instanceof Error, "timeout throws");
	assert.match(err.message, /^timed out waiting/);
	assert.match(err.message, /flake postmortem/);
	assert.match(err.message, /"semanticState":"working"/);
	assert.equal(captured, 1, "capture runs exactly once, at timeout");
});

test("A6: a timeout without a capture thunk still throws the legacy error", async () => {
	const err = await waitForWithPostmortem(() => false, { timeoutMs: 20, intervalMs: 5 }).then(
		() => null,
		(e) => e,
	);
	assert.ok(err instanceof Error);
	assert.equal(err.message, "timed out waiting");
});

test("A6: capturePostmortem reads the real artifacts from a fixture root", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-pm-"));
	try {
		createView(root, { id: "v", name: "t", cwd: root });
		const snap = capturePostmortem(root, "v", null);
		assert.ok(snap.state, "state.json captured");
		assert.equal(snap.status, null, "no run status without runId");
		assert.deepEqual(snap.diagnosticsTail, []);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
