import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as P from "../src/core/paths.mjs";
import {
	ensureCwdStatsSeeded,
	rankedCwdCandidates,
	readCwdStats,
	recordCwdLaunch,
	seedCwdStatsFromViews,
} from "../src/core/cwd-stats.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "cwd-stats-"));
}

/** @param {string} root @param {Array<[string, string, number]>} views */
function writeViews(root, views) {
	for (const [viewId, cwd, updatedAt] of views) {
		mkdirSync(join(root, "views", viewId), { recursive: true });
		writeFileSync(P.metaPath(root, viewId), JSON.stringify({ id: viewId, cwd, updatedAt }));
	}
	writeFileSync(P.rosterPath(root), JSON.stringify({ version: 1, views: views.map(([viewId]) => viewId) }));
}

test("readCwdStats tolerates a missing stats file", () => {
	const root = freshRoot();
	try {
		assert.deepEqual(readCwdStats(root), { version: 1, entries: {} });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("seedCwdStatsFromViews aggregates counts and max updatedAt per cwd", () => {
	const root = freshRoot();
	try {
		writeViews(root, [
			["v1", "/a", 100],
			["v2", "/a", 300],
			["v3", "/b", 200],
		]);
		seedCwdStatsFromViews(root);
		assert.deepEqual(readCwdStats(root).entries, {
			"/a": { count: 2, lastUsed: 300 },
			"/b": { count: 1, lastUsed: 200 },
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("seedCwdStatsFromViews is a one-time no-op when the file exists", () => {
	const root = freshRoot();
	try {
		writeViews(root, [["v1", "/a", 100]]);
		seedCwdStatsFromViews(root);
		writeViews(root, [
			["v1", "/a", 100],
			["v2", "/b", 200],
		]);
		seedCwdStatsFromViews(root);
		assert.deepEqual(readCwdStats(root).entries, { "/a": { count: 1, lastUsed: 100 } });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("recordCwdLaunch increments count, sets lastUsed, ignores invalid dirs", () => {
	const root = freshRoot();
	try {
		recordCwdLaunch(root, join(root, "nope", "does", "not", "exist"));
		assert.deepEqual(readCwdStats(root).entries, {});
		recordCwdLaunch(root, root);
		let entry = readCwdStats(root).entries[root];
		assert.equal(entry.count, 1);
		const first = entry.lastUsed;
		recordCwdLaunch(root, root);
		entry = readCwdStats(root).entries[root];
		assert.equal(entry.count, 2);
		assert.ok(entry.lastUsed >= first);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rankedCwdCandidates orders by count desc, lastUsed desc, appends home fallback", () => {
	const root = freshRoot();
	try {
		writeViews(root, [
			["v1", "/rare", 100],
			["v2", "/rare", 200],
			["v3", "/common", 50],
			["v4", "/common", 60],
			["v5", "/common", 70],
			["v6", "/mid", 500],
			["v7", "/mid", 600],
		]);
		seedCwdStatsFromViews(root);
		const ranked = rankedCwdCandidates(root, 8);
		assert.deepEqual(ranked.slice(0, 3), [
			{ path: "/common", count: 3 },
			{ path: "/mid", count: 2 },
			{ path: "/rare", count: 2 },
		]);
		const last = ranked[ranked.length - 1];
		assert.equal(last.path, os.homedir());
		assert.equal(last.count, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("home fallback is not duplicated when home is already in stats", () => {
	const root = freshRoot();
	try {
		writeViews(root, [["v1", os.homedir(), 100]]);
		seedCwdStatsFromViews(root);
		const ranked = rankedCwdCandidates(root, 8);
		assert.equal(ranked.filter((entry) => entry.path === os.homedir()).length, 1);
		assert.equal(ranked[0].count, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("corrupt stats file degrades to empty and stays writable", () => {
	const root = freshRoot();
	try {
		writeFileSync(P.cwdStatsPath(root), "{not json");
		assert.deepEqual(readCwdStats(root), { version: 1, entries: {} });
		recordCwdLaunch(root, root);
		assert.equal(readCwdStats(root).entries[root].count, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureCwdStatsSeeded seeds once and is idempotent", () => {
	const root = freshRoot();
	try {
		writeViews(root, [["v1", "/a", 100]]);
		ensureCwdStatsSeeded(root);
		assert.ok(existsSync(P.cwdStatsPath(root)));
		ensureCwdStatsSeeded(root);
		assert.deepEqual(readCwdStats(root).entries, { "/a": { count: 1, lastUsed: 100 } });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rankedCwdCandidates keeps home fallback when the list saturates", () => {
	const root = freshRoot();
	try {
		writeViews(root, [
			["v1", "/d1", 100],
			["v2", "/d2", 200],
			["v3", "/d3", 300],
		]);
		seedCwdStatsFromViews(root);
		const ranked = rankedCwdCandidates(root, 2);
		assert.deepEqual(ranked, [
			{ path: "/d3", count: 1 },
			{ path: "/d2", count: 1 },
			{ path: os.homedir(), count: 0 },
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rankedCwdCandidates appends home with its real count when sliced out by limit", () => {
	const root = freshRoot();
	try {
		writeViews(root, [
			["v1", os.homedir(), 100],
			["v2", "/d1", 200],
			["v3", "/d2", 300],
		]);
		seedCwdStatsFromViews(root);
		const ranked = rankedCwdCandidates(root, 2);
		assert.deepEqual(ranked, [
			{ path: "/d2", count: 1 },
			{ path: "/d1", count: 1 },
			{ path: os.homedir(), count: 1 },
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
