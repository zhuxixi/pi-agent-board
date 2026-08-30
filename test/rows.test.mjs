import assert from "node:assert/strict";
import { test } from "node:test";
import { filterRows, groupRows, groupRowsByFolder, parseFilter, rowState, rowView, stateGlyph } from "../src/core/rows.mjs";

/** @returns {import("../src/core/store.mjs").Row} */
function row(id, semanticState, extra = {}) {
	return {
		meta: {
			id,
			name: extra.name ?? id,
			cwd: extra.cwd ?? "/repo",
			repoCwd: extra.repoCwd ?? "/repo",
			worktreeMode: extra.worktreeMode ?? "off",
			pinned: extra.pinned ?? false,
			updatedAt: extra.updatedAt ?? 0,
			createdAt: extra.createdAt ?? 0,
		},
		state: {
			semanticState,
			summary: extra.summary ?? "",
			lastActivityAt: extra.lastActivityAt ?? 0,
			lastVisitedAt: extra.lastVisitedAt ?? null,
			lastAgentActivityAt: extra.lastAgentActivityAt ?? null,
		},
		alive: extra.alive ?? false,
		codeRefs: extra.codeRefs ?? null,
	};
}

test("rowState defaults to queued", () => {
	assert.equal(rowState({ meta: {}, state: null, alive: false }), "queued");
	assert.equal(rowState(row("x", "working")), "working");
});

test("groupRows orders by GROUP_ORDER and omits empty groups", () => {
	const rows = [row("a", "completed"), row("b", "needs_input"), row("c", "working")];
	const groups = groupRows(rows, 0);
	assert.deepEqual(groups.map((g) => g.state), ["working", "needs_input", "completed"]);
});

test("groupRows sorts pinned first then creation order (oldest first)", () => {
	const rows = [
		row("a", "working", { createdAt: 100 }),
		row("b", "working", { createdAt: 300 }),
		row("c", "working", { createdAt: 200, pinned: true }),
	];
	const [working] = groupRows(rows, 1000);
	assert.deepEqual(working.rows.map((r) => r.id), ["c", "a", "b"]);
});

test("groupRows ignores activity recency so order stays stable", () => {
	const rows = [
		row("a", "working", { createdAt: 100, lastActivityAt: 900 }),
		row("b", "working", { createdAt: 200, lastActivityAt: 100 }),
	];
	const [working] = groupRows(rows, 1000);
	assert.deepEqual(working.rows.map((r) => r.id), ["a", "b"]);
});

test("rows missing meta.createdAt fall back to 0, not updatedAt", () => {
	const legacy = row("a", "working", { updatedAt: 999 });
	delete legacy.meta.createdAt;
	const fresh = row("b", "working", { createdAt: 100 });
	const [working] = groupRows([legacy, fresh], 1000);
	assert.deepEqual(working.rows.map((r) => r.id), ["a", "b"]);
});

test("rowView exposes folder place for dashboard rows", () => {
	const view = rowView(row("a", "working", { repoCwd: "/Users/me/project-a" }), 0);
	assert.equal(view.place, "project-a");
	assert.equal(view.folderName, "project-a");
	assert.equal(view.folderPath, "/Users/me/project-a");
	assert.equal(rowView(row("b", "working", { repoCwd: "/Users/me/project-b", worktreeMode: "worktree" }), 0).place, "project-b⌥");
});

test("groupRowsByFolder nests rows by folder inside each stage", () => {
	const rows = [
		row("a", "working", { repoCwd: "/repo/r-code", createdAt: 300 }),
		row("b", "working", { repoCwd: "/repo/pi-agents-view", createdAt: 100 }),
		row("c", "working", { repoCwd: "/repo/r-code", createdAt: 200 }),
		row("d", "completed", { repoCwd: "/repo/r-code", createdAt: 400 }),
	];
	const groups = groupRowsByFolder(rows, 1000);
	assert.deepEqual(groups.map((g) => g.state), ["working", "completed"]);
	assert.deepEqual(groups[0].folders.map((f) => f.name), ["pi-agents-view", "r-code"]);
	assert.deepEqual(groups[0].folders[1].rows.map((r) => r.id), ["c", "a"]);
	assert.equal(groups[1].folders[0].name, "r-code");
});

test("groupRowsByFolder keeps folder order stable regardless of activity", () => {
	const rows = [
		row("a", "working", { repoCwd: "/repo/x", createdAt: 100, lastActivityAt: 1 }),
		row("b", "working", { repoCwd: "/repo/y", createdAt: 200, lastActivityAt: 999 }),
	];
	const groups = groupRowsByFolder(rows, 1000);
	assert.deepEqual(groups[0].folders.map((f) => f.name), ["x", "y"]);
});

test("groupRowsByFolder marks showFolders only when a stage spans multiple folders", () => {
	const single = [
		row("a", "working", { repoCwd: "/repo/x" }),
		row("b", "working", { repoCwd: "/repo/x" }),
	];
	assert.equal(groupRowsByFolder(single, 0)[0].showFolders, false);
	const multi = [
		row("a", "working", { repoCwd: "/repo/x" }),
		row("b", "working", { repoCwd: "/repo/y" }),
	];
	assert.equal(groupRowsByFolder(multi, 0)[0].showFolders, true);
});

test("rowView normalizes generic status labels to current display names", () => {
	assert.equal(rowView(row("a", "working", { summary: "Working…" }), 0).summary, "Running…");
	assert.equal(rowView(row("b", "idle", { summary: "Idle" }), 0).summary, "Needs instructions");
	assert.equal(rowView(row("c", "idle", { summary: "In Progress" }), 0).summary, "Needs instructions");
	assert.equal(rowView(row("d", "needs_input", { summary: "Needs input" }), 0).summary, "Needs answer");
});

test("rowView exposes unread when newer agent activity exists", () => {
	assert.equal(rowView(row("a", "idle", { lastVisitedAt: 10, lastAgentActivityAt: 20 }), 0).unread, true);
	assert.equal(rowView(row("b", "idle", { lastVisitedAt: 30, lastAgentActivityAt: 20 }), 0).unread, false);
});

test("rowView maps no codeRefs summary to an empty refsBadge", () => {
	const view = rowView(row("a", "working"), 0);
	assert.equal(view.refsBadge, "");
	assert.equal(view.refsLowConfidence, false);
	assert.equal(view.codeRefs, null);
});

test("rowView refsBadge joins winning issue and pr with provider prefixes", () => {
	const issue = { kind: "issue", number: 40, confidence: "high" };
	const pr = { kind: "pr", number: 45, confidence: "high" };
	const summary = { provider: "github", issuePrefix: "#", prPrefix: "▸#", issue, pr, allRefs: [issue, pr] };
	const view = rowView(row("a", "working", { codeRefs: summary }), 0);
	assert.equal(view.refsBadge, "#40 ▸#45");
	assert.equal(view.refsLowConfidence, false);
	assert.deepEqual(view.codeRefs, summary);

	const issueOnly = rowView(row("b", "working", { codeRefs: { ...summary, pr: null, allRefs: [issue] } }), 0);
	assert.equal(issueOnly.refsBadge, "#40");

	const prOnly = rowView(row("c", "working", { codeRefs: { ...summary, issue: null, allRefs: [pr] } }), 0);
	assert.equal(prOnly.refsBadge, "▸#45");
});

test("rowView refsLowConfidence flags low-confidence winners", () => {
	const lowIssue = { kind: "issue", number: 40, confidence: "low" };
	const lowPr = { kind: "pr", number: 45, confidence: "low" };
	const highPr = { kind: "pr", number: 45, confidence: "high" };
	const base = { provider: "generic", issuePrefix: "#", prPrefix: "▸#" };
	assert.equal(rowView(row("a", "working", { codeRefs: { ...base, issue: lowIssue, pr: highPr, allRefs: [] } }), 0).refsLowConfidence, true);
	assert.equal(rowView(row("b", "working", { codeRefs: { ...base, issue: null, pr: lowPr, allRefs: [] } }), 0).refsLowConfidence, true);
	assert.equal(rowView(row("c", "working", { codeRefs: { ...base, issue: null, pr: highPr, allRefs: [] } }), 0).refsLowConfidence, false);
});

test("rowView refsBadge uses provider-specific prefixes (gitlab PRs)", () => {
	const pr = { kind: "pr", number: 12, confidence: "high" };
	const view = rowView(row("a", "working", { codeRefs: { provider: "gitlab", issuePrefix: "#", prPrefix: "!", issue: null, pr, allRefs: [pr] } }), 0);
	assert.equal(view.refsBadge, "!12");
});

test("parseFilter splits state + terms", () => {
	const f = parseFilter("s:working auth bug");
	assert.deepEqual(f.states, ["working"]);
	assert.deepEqual(f.terms, ["auth", "bug"]);
});

test("parseFilter prefix matches multiple states", () => {
	const f = parseFilter("s:need");
	assert.deepEqual(f.states, ["needs_input", "idle"]);
});

test("parseFilter accepts display-label aliases", () => {
	assert.deepEqual(parseFilter("s:run").states, ["working"]);
	assert.deepEqual(parseFilter("s:needs-instructions").states, ["idle"]);
});

test("filterRows by state", () => {
	const rows = [row("a", "working"), row("b", "completed")];
	assert.deepEqual(filterRows(rows, "s:working").map((r) => r.meta.id), ["a"]);
});

test("filterRows by free text over name/summary/cwd (AND)", () => {
	const rows = [
		row("a", "working", { name: "auth-fix", summary: "editing middleware" }),
		row("b", "working", { name: "ui-thing", summary: "styling" }),
	];
	assert.deepEqual(filterRows(rows, "auth").map((r) => r.meta.id), ["a"]);
	assert.deepEqual(filterRows(rows, "auth middleware").map((r) => r.meta.id), ["a"]);
	assert.deepEqual(filterRows(rows, "auth styling").map((r) => r.meta.id), []);
});

test("filterRows empty query returns all", () => {
	const rows = [row("a", "working"), row("b", "completed")];
	assert.equal(filterRows(rows, "").length, 2);
});

test("stateGlyph distinguishes alive working", () => {
	assert.equal(stateGlyph("working", true), "●");
	assert.equal(stateGlyph("working", false), "◐");
	assert.equal(stateGlyph("needs_input", false), "◇");
});

test("stateGlyph uses stronger variants for unread rows", () => {
	assert.equal(stateGlyph("queued", false, false, true), "◎");
	assert.equal(stateGlyph("working", true, false, true), "◉");
	assert.equal(stateGlyph("needs_input", false, false, true), "◆");
	assert.equal(stateGlyph("completed", false, false, true), "✔");
	assert.equal(stateGlyph("idle", false, false, true), "●");
});

test("rowView marks staleHost when host.json says alive but the process is gone and the heartbeat is stale", () => {
	const now = 1_000_000;
	const base = row("a", "idle");
	const host = { version: 1, viewId: "a", state: "alive", lastSeenAt: now - 60_000, runnerPid: 999999, childPid: null, socketPath: "/x", startedAt: now - 3_600_000, endedAt: null, exitCode: null, error: null, cols: 80, rows: 24, attachedClients: 0, attachedEver: true };
	assert.equal(rowView({ ...base, host, hostAlive: false }, now).staleHost, true);
});

test("rowView does not mark staleHost for fresh heartbeats, terminal states, or live hosts", () => {
	const now = 1_000_000;
	const base = row("a", "idle");
	const host = { version: 1, viewId: "a", state: "alive", lastSeenAt: now - 60_000, runnerPid: 999999, childPid: null, socketPath: "/x", startedAt: now - 3_600_000, endedAt: null, exitCode: null, error: null, cols: 80, rows: 24, attachedClients: 0, attachedEver: true };
	const fresh = { ...host, lastSeenAt: now - 1_000 };
	assert.equal(rowView({ ...base, host: fresh, hostAlive: false }, now).staleHost, false);
	const exited = { ...host, state: "exited" };
	assert.equal(rowView({ ...base, host: exited, hostAlive: false }, now).staleHost, false);
	assert.equal(rowView({ ...base, host: fresh, hostAlive: true }, now).staleHost, false);
	assert.equal(rowView({ ...base, host: null, hostAlive: false }, now).staleHost, false);
});
