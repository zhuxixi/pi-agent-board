import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { browseTabCompletion, existingCwdCandidates, filterCwdCandidates, listDirectorySuggestions, modelRefAvailable, nextCwdPickerState, sameResolvedDir } from "../src/core/launch-options.mjs";

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

// ---- modelRefAvailable (issue #90) ----

test("modelRefAvailable matches case-insensitive exact provider/id and conservatively allows when it cannot judge", () => {
	const available = [
		{ provider: "zai-coding-cn", id: "glm-5.3" },
		{ provider: "openai", id: "gpt-5" },
	];
	assert.equal(modelRefAvailable("zai-coding-cn/glm-5.3", available), true);
	assert.equal(modelRefAvailable("ZAI-Coding-CN/GLM-5.3", available), true, "case-insensitive");
	assert.equal(modelRefAvailable("  zai-coding-cn/glm-5.3  ", available), true, "trimmed");
	assert.equal(modelRefAvailable("glm/glm-5.3", available), false, "provider mismatch (the stale-model case)");
	assert.equal(modelRefAvailable("glm-5.3", available), false, "bare id is not an exact provider/id match");
	assert.equal(modelRefAvailable("openai/gpt-4", available), false);
	assert.equal(modelRefAvailable(null, available), true, "no configured model = no constraint");
	assert.equal(modelRefAvailable("", available), true);
	assert.equal(modelRefAvailable("   ", available), true);
	assert.equal(modelRefAvailable("glm/glm-5.3", undefined), true, "no list = cannot judge, allow");
	assert.equal(modelRefAvailable("glm/glm-5.3", []), true, "empty list = cannot judge, allow");
});

// ---- issue #127: cwd picker browse-mode Tab completion helpers ----

test("sameResolvedDir: matches across trailing separator and ~; blank never matches", () => {
	const home = os.homedir();
	assert.equal(sameResolvedDir("~/work", `${home}/work/`), true);
	assert.equal(sameResolvedDir("/a/b", "/a/c"), false);
	assert.equal(sameResolvedDir("", "/a"), false);
	assert.equal(sameResolvedDir("   ", "/a"), false);
});

test("browseTabCompletion: completes highlighted suggestion with trailing separator", () => {
	const res = browseTabCompletion("/tmp/x/wo", ["/tmp/x/work"], 0);
	assert.deepEqual(res, { query: `/tmp/x/work${path.sep}`, completed: "/tmp/x/work", usedIndex: 0 });
});

test("browseTabCompletion: no-progress highlight advances cyclically", () => {
	const s = ["/tmp/x/work", "/tmp/x/work/app", "/tmp/x/work/notes"];
	const res = browseTabCompletion(`/tmp/x/work${path.sep}`, s, 0);
	assert.equal(res.usedIndex, 1);
	assert.equal(res.query, `/tmp/x/work/app${path.sep}`);
	// wraps from the last entry back to the first
	const res2 = browseTabCompletion("/tmp/x/work/notes", ["/tmp/x/work", "/tmp/x/work/notes"], 1);
	assert.equal(res2.usedIndex, 0);
	assert.equal(res2.query, `/tmp/x/work${path.sep}`);
});

test("browseTabCompletion: single self suggestion stays put (drill naturally stops)", () => {
	const res = browseTabCompletion(`/tmp/x/work${path.sep}`, ["/tmp/x/work"], 0);
	assert.equal(res.query, `/tmp/x/work${path.sep}`);
	assert.equal(res.usedIndex, 0);
});

test("browseTabCompletion: empty suggestions -> null; out-of-range index clamps", () => {
	assert.equal(browseTabCompletion("x", [], 0), null);
	assert.equal(browseTabCompletion("x", null, 0), null);
	const res = browseTabCompletion("x", ["/a"], 7);
	assert.equal(res.usedIndex, 0);
});

