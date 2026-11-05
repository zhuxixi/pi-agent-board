import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeFoldedSections, readFoldedSections, saveFoldedSections } from "../src/core/dashboard-prefs.mjs";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "board-prefs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("fold preferences accept only known states, deduplicate, and use display order", () => {
	assert.deepEqual(normalizeFoldedSections(["completed", "holding", "unknown", "holding", null, "working"]),
		["working", "holding", "completed"]);
	for (const value of [undefined, null, false, 1, "completed", {}]) {
		assert.deepEqual(normalizeFoldedSections(value), []);
	}
});

test("fold preferences survive reopening and can be cleared", (t) => {
	const root = fixture(t);
	assert.deepEqual(readFoldedSections(root), []);
	saveFoldedSections(root, new Set(["completed", "holding"]));
	assert.deepEqual(readFoldedSections(root), ["holding", "completed"]);
	assert.equal(JSON.parse(readFileSync(join(root, "dashboard-prefs.json"), "utf8")).version, 1);
	saveFoldedSections(root, []);
	assert.deepEqual(readFoldedSections(root), []);
});

test("missing, malformed, and invalid preference files default to expanded sections", (t) => {
	const root = fixture(t);
	for (const content of ["{", "null", "42", "[]", '{"foldedSections":"completed"}', '{"foldedSections":["unknown"]}']) {
		writeFileSync(join(root, "dashboard-prefs.json"), content);
		assert.deepEqual(readFoldedSections(root), []);
	}
});

test("preferences are scoped to the board root and saving errors surface to the UI", (t) => {
	const root = fixture(t);
	const other = fixture(t);
	saveFoldedSections(root, ["completed"]);
	assert.deepEqual(readFoldedSections(other), []);
	mkdirSync(join(other, "dashboard-prefs.json"));
	assert.throws(() => saveFoldedSections(other, ["holding"]));
	assert.deepEqual(readFoldedSections(root), ["completed"]);
});
