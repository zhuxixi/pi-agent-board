import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { existingCwdCandidates, filterCwdCandidates, listDirectorySuggestions, nextCwdPickerState } from "../src/core/launch-options.mjs";

const ranked = [
	{ path: "/home/elling", count: 107 },
	{ path: "/home/elling/git-repo/github/zima-blue-cli", count: 20 },
	{ path: "/home/elling/git-repo/github/jfox", count: 17 },
];

test("filterCwdCandidates matches case-insensitive substring anywhere in path", () => {
	assert.deepEqual(filterCwdCandidates(ranked, "jfox"), [
		{ path: "/home/elling/git-repo/github/jfox", count: 17 },
	]);
	assert.deepEqual(filterCwdCandidates(ranked, "GITHUB"), [ranked[1], ranked[2]]);
	assert.deepEqual(filterCwdCandidates(ranked, ""), ranked);
	assert.deepEqual(filterCwdCandidates(ranked, "no-such-dir"), []);
});

test("nextCwdPickerState: empty query shows full ranked favorites", () => {
	const state = nextCwdPickerState("", ranked, "/tmp");
	assert.equal(state.mode, "favorites");
	assert.deepEqual(state.suggestions, ranked.map((entry) => entry.path));
});

test("nextCwdPickerState: matching query stays favorites in ranked order", () => {
	const state = nextCwdPickerState("git-repo", ranked, "/tmp");
	assert.equal(state.mode, "favorites");
	assert.deepEqual(state.suggestions, [
		"/home/elling/git-repo/github/zima-blue-cli",
		"/home/elling/git-repo/github/jfox",
	]);
});

test("nextCwdPickerState falls back to browse when ranked is empty", () => {
	const root = mkdtempSync(join(tmpdir(), "cwd-picker-empty-"));
	try {
		const state = nextCwdPickerState("", [], root);
		assert.equal(state.mode, "browse");
		assert.deepEqual(state.suggestions, listDirectorySuggestions("", root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("existingCwdCandidates drops stale paths and keeps real dirs", () => {
	const root = mkdtempSync(join(tmpdir(), "cwd-picker-stale-"));
	try {
		const kept = existingCwdCandidates([
			{ path: root, count: 3 },
			{ path: join(root, "gone"), count: 2 },
		]);
		assert.deepEqual(kept, [{ path: root, count: 3 }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("nextCwdPickerState: unmatched query falls back to filesystem browse", () => {
	const root = mkdtempSync(join(tmpdir(), "cwd-picker-"));
	try {
		const state = nextCwdPickerState("no-such-dir-xyz", ranked, root);
		assert.equal(state.mode, "browse");
		assert.deepEqual(state.suggestions, listDirectorySuggestions("no-such-dir-xyz", root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
