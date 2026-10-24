import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CLOCK_EPSILON_MS,
	classifyRunForRow,
	classifyRunsForRow,
	isSameSessionFile,
	parseRunHead,
	resolveWorkflowHome,
} from "../src/core/background-runs.mjs";

const V2 = (o = {}) => ({
	format: "pi-workflow-run-v2",
	index: { runId: "run-1", status: "running", parentSessionFile: "C:\\r\\sessions\\view_a.jsonl", updatedAt: "2026-10-24T01:00:00.000Z", startedAt: "2026-10-24T00:50:00.000Z", ...o },
	summary: { checkpoint: null },
	keys: [],
});

test("A1: v2 head -> status/parentSessionFile/updatedAt", () => {
	const h = parseRunHead(V2());
	assert.equal(h.runId, "run-1");
	assert.equal(h.status, "running");
	assert.equal(h.parentSessionFile, "C:\\r\\sessions\\view_a.jsonl");
	assert.equal(h.updatedAtMs, Date.parse("2026-10-24T01:00:00.000Z"));
	assert.equal(h.hasCheckpoint, false);
});

test("A1: v2 head without parentSessionFile -> null parent", () => {
	const raw = V2();
	delete raw.index.parentSessionFile;
	assert.equal(parseRunHead(raw).parentSessionFile, null);
});

test("A1: legacy flat record -> parseable but no parentSessionFile", () => {
	const h = parseRunHead({ runId: "old-1", status: "completed", startedAt: "2026-08-30T00:00:00.000Z" });
	assert.equal(h.runId, "old-1");
	assert.equal(h.status, "completed");
	assert.equal(h.parentSessionFile, null);
});

test("A1: garbage never throws and yields null", () => {
	for (const bad of [null, 42, "str", [], {}, { format: "something-else" }]) {
		assert.equal(parseRunHead(bad), null);
	}
});

test("A2: running + same session + updatedAt >= hostStartedAt -> protecting", () => {
	const h = parseRunHead(V2());
	const startedAt = Date.parse("2026-10-24T00:55:00.000Z");
	assert.equal(classifyRunForRow(h, { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: startedAt }), "protecting");
});

test("A3: stale running (updatedAt < hostStartedAt) -> irrelevant", () => {
	const h = parseRunHead(V2());
	const startedAt = Date.parse("2026-10-24T02:00:00.000Z");
	assert.equal(classifyRunForRow(h, { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: startedAt }), "irrelevant");
});

test("A3: stale running within CLOCK_EPSILON_MS still protects", () => {
	const h = parseRunHead(V2());
	const startedAt = Date.parse("2026-10-24T01:00:00.000Z") + CLOCK_EPSILON_MS - 1;
	assert.equal(classifyRunForRow(h, { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: startedAt }), "protecting");
});

test("A3: missing hostStartedAt protects; missing updatedAt protects", () => {
	const h = parseRunHead(V2());
	assert.equal(classifyRunForRow(h, { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: null }), "protecting");
	const raw = V2();
	delete raw.index.updatedAt;
	assert.equal(classifyRunForRow(parseRunHead(raw), { sessionFile: raw.index.parentSessionFile, hostStartedAt: Date.now() }), "protecting");
});

test("A4: non-running statuses never protect; paused is classified separately", () => {
	const sessionFile = "C:\\r\\sessions\\view_a.jsonl";
	for (const status of ["completed", "failed", "aborted", "pending", ""]) {
		assert.equal(classifyRunForRow(parseRunHead(V2({ status })), { sessionFile, hostStartedAt: null }), "irrelevant", status);
	}
	assert.equal(classifyRunForRow(parseRunHead(V2({ status: "paused" })), { sessionFile, hostStartedAt: null }), "paused");
});

test("A4: other session's run is irrelevant", () => {
	const h = parseRunHead(V2());
	assert.equal(classifyRunForRow(h, { sessionFile: "C:\\r\\sessions\\view_b.jsonl", hostStartedAt: null }), "irrelevant");
});

test("A5: win32 path spelling differences compare equal (platform injected)", () => {
	assert.equal(isSameSessionFile("C:\\r\\sessions\\view_a.jsonl", "c:/r/sessions/view_a.jsonl", { platform: "win32" }), true);
	assert.equal(isSameSessionFile("c:/r/sessions/view_a.jsonl", "C:\\r\\sessions\\view_b.jsonl", { platform: "win32" }), false);
	assert.equal(isSameSessionFile("/tmp/x/a.jsonl", "/tmp/x/./a.jsonl", { platform: "linux" }), true);
	assert.equal(isSameSessionFile("/tmp/x/A.jsonl", "/tmp/x/a.jsonl", { platform: "linux" }), false);
});

test("A5: missing operands -> false, never throws", () => {
	assert.equal(isSameSessionFile(null, "/a", {}), false);
	assert.equal(isSameSessionFile("/a", undefined, {}), false);
});

test("A16: workflow home precedence and tilde expansion", () => {
	const home = "/home/u";
	assert.equal(resolveWorkflowHome({ env: {}, home }), "/home/u/.pi/workflows");
	assert.equal(resolveWorkflowHome({ env: { PI_CODING_AGENT_DIR: "/custom/agent" }, home }), "/custom/agent/workflows");
	assert.equal(resolveWorkflowHome({ env: { PI_CODING_AGENT_DIR: "~/agent" }, home }), "/home/u/agent/workflows");
	assert.equal(
		resolveWorkflowHome({ env: { PI_CODING_AGENT_DIR: "/custom/agent", AGENT_BOARD_WORKFLOW_HOME: "/explicit/wf" }, home }),
		"/explicit/wf",
	);
	assert.equal(resolveWorkflowHome({ env: { AGENT_BOARD_WORKFLOW_HOME: "~/wf" }, home }), "/home/u/wf");
});

test("ReviewFocus 1: two runs in one project — only the matching session protects", () => {
	const mine = parseRunHead(V2());
	const other = parseRunHead(V2({ runId: "run-2", parentSessionFile: "C:\\r\\sessions\\view_b.jsonl" }));
	const res = classifyRunsForRow([other, mine], { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: null });
	assert.equal(res.state, "protecting");
	assert.equal(res.run.runId, "run-1");
});

test("ReviewFocus: protecting outranks paused in one scan", () => {
	const paused = parseRunHead(V2({ runId: "p", status: "paused" }));
	const running = parseRunHead(V2({ runId: "r", status: "running" }));
	assert.equal(classifyRunsForRow([paused, running], { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: null }).state, "protecting");
	assert.equal(classifyRunsForRow([paused], { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: null }).state, "paused");
	assert.equal(classifyRunsForRow([], { sessionFile: "C:\\r\\sessions\\view_a.jsonl", hostStartedAt: null }).state, "irrelevant");
});
