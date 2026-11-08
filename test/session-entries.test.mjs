import assert from "node:assert/strict";
import { test } from "node:test";
import { activeBranchEntries, parseSessionEntries } from "../src/core/session-entries.mjs";

const line = (obj) => JSON.stringify(obj);

test("parseSessionEntries extracts header, keeps entries and index, skips bad lines", () => {
	const text = [
		line({ type: "session", id: "s1", cwd: "/r" }),
		"{ not json",
		line({ type: "model_change", id: "e1", parentId: null, provider: "p", modelId: "m" }),
		line({ no: "id-field" }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "hi" } }),
		"",
	].join("\n");
	const { header, entries, byId } = parseSessionEntries(text);
	assert.deepEqual(header, { id: "s1", cwd: "/r" });
	assert.equal(entries.length, 2, "bad JSON and id-less lines are skipped");
	assert.equal(byId.size, 2);
	assert.equal(entries[0].id, "e1");
});

test("parseSessionEntries tolerates null/empty text", () => {
	assert.deepEqual(parseSessionEntries(null), { header: null, entries: [], byId: new Map() });
	assert.deepEqual(parseSessionEntries(""), { header: null, entries: [], byId: new Map() });
});

test("activeBranchEntries walks root→leaf from the last entry", () => {
	const text = [
		line({ type: "session", id: "s1", cwd: "/r" }),
		line({ type: "thinking_level_change", id: "e1", parentId: null, thinkingLevel: "high" }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "hi" } }),
		line({ type: "message", id: "e3", parentId: "e2", message: { role: "assistant", content: "yo" } }),
	].join("\n");
	const { entries, byId } = parseSessionEntries(text);
	const branch = activeBranchEntries(entries, byId);
	assert.deepEqual(branch.map((e) => e.id), ["e1", "e2", "e3"]);
});

test("activeBranchEntries excludes an abandoned sibling branch", () => {
	// e2 forks: abandoned child e2b, active chain continues through e3 (last entry).
	const text = [
		line({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }),
		line({ type: "model_change", id: "e2b", parentId: "e1", provider: "p", modelId: "abandoned" }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "again" } }),
		line({ type: "message", id: "e3", parentId: "e2", message: { role: "assistant", content: "yo" } }),
	].join("\n");
	const { entries, byId } = parseSessionEntries(text);
	const branch = activeBranchEntries(entries, byId);
	assert.deepEqual(branch.map((e) => e.id), ["e1", "e2", "e3"], "the abandoned model_change e2b must not be on the branch");
});

test("activeBranchEntries stops at a broken parentId and survives a cycle", () => {
	const orphan = [{ id: "e9", parentId: "missing", type: "message" }];
	assert.deepEqual(activeBranchEntries(orphan, new Map([["e9", orphan[0]]])).map((e) => e.id), ["e9"], "broken parentId ends the walk, reachable entry still returned");
	const a = { id: "a", parentId: "b", type: "message" };
	const b = { id: "b", parentId: "a", type: "message" };
	const branch = activeBranchEntries([a, b], new Map([["a", a], ["b", b]]));
	assert.ok(branch.length <= 2, "cycle guard terminates the walk");
});

test("activeBranchEntries skips a torn trailing line (concurrent append)", () => {
	const text = [
		line({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }),
		'{"type":"message","id":"e2","par', // torn last line
	].join("\n");
	const { entries, byId } = parseSessionEntries(text);
	assert.equal(entries.length, 1, "torn line is dropped by the parser");
	assert.deepEqual(activeBranchEntries(entries, byId).map((e) => e.id), ["e1"]);
});
