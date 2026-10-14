/** F3 unit tests (issue #95): the flake black-box. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as P from "../src/core/paths.mjs";
import { createView } from "../src/core/store.mjs";
import { SCREEN_LOG_TAIL_BYTES, capturePostmortem, formatPostmortem, tailSlice, waitForWithPostmortem } from "../test-support/flake-postmortem.mjs";

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

test("A5: tailSlice keeps short text verbatim and truncates to the byte budget", () => {
	assert.equal(tailSlice("abc", 10), "abc");
	assert.equal(tailSlice("abcdef", 3), "def", "keeps the tail, measured in bytes");
	assert.equal(tailSlice("", 3), "");
});

test("A5: tailSlice never splits a multi-byte character at the cut point", () => {
	// Each CJK character is 3 bytes; a 4-byte budget must not emit a partial char.
	const text = "中文字符";
	assert.equal(Buffer.byteLength(text, "utf8"), 12);
	const sliced = tailSlice(text, 4);
	assert.equal(sliced, "符", "cuts at the character boundary, not mid-sequence");
	assert.doesNotMatch(sliced, /\uFFFD/, "no replacement character from a split character");
	// 3 bytes is exactly one whole character: the last one survives intact.
	assert.equal(tailSlice(text, 3), "符");
	// 2 bytes lands inside that character: it is dropped, never half-emitted.
	assert.equal(tailSlice(text, 2), "");
	assert.doesNotMatch(tailSlice(text, 2), /\uFFFD/);
});

test("A5: formatPostmortem renders the screenLogTail line and marks it absent", () => {
	const present = formatPostmortem({
		status: null,
		state: null,
		host: null,
		diagnosticsTail: [],
		journalTail: [],
		screenLogTail: "fake pi ready\n",
	});
	assert.match(present, /screenLogTail: "fake pi ready\\n"/);
	const absent = formatPostmortem({ status: null, state: null, host: null, diagnosticsTail: [], journalTail: [] });
	assert.match(absent, /screenLogTail: <absent>/, "a snapshot without the field renders <absent>");
	assert.doesNotMatch(absent, /undefined/);
});

test("A5: capturePostmortem tails a real screen.log without splitting characters", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-pm-log-"));
	try {
		createView(root, { id: "v", name: "t", cwd: root });
		const oversized = "x".repeat(SCREEN_LOG_TAIL_BYTES + 500) + "中文字符";
		writeFileSync(P.screenLogPath(root, "v"), oversized);
		const snap = capturePostmortem(root, "v", null);
		assert.ok(typeof snap.screenLogTail === "string", "tail captured");
		assert.ok(Buffer.byteLength(snap.screenLogTail, "utf8") <= SCREEN_LOG_TAIL_BYTES, "bounded by the byte budget");
		assert.equal(snap.screenLogTail.endsWith("中文字符"), true, "the tail is the newest output");
		assert.doesNotMatch(snap.screenLogTail, /\uFFFD/);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("A5: capturePostmortem reports an absent screen.log as null", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-pm-nolog-"));
	try {
		createView(root, { id: "v", name: "t", cwd: root });
		assert.equal(capturePostmortem(root, "v", null).screenLogTail, null);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
