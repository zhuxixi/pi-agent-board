import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import {
	DEFAULT_SCREEN_LOG_RETENTION_DAYS,
	normalizeRetentionDays,
	pruneScreenLogs,
} from "../src/core/screen-log-gc.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agent-board-gc-"));
}

/** Create a view dir with a small meta.json, optional host.json, optional screen.log. */
function makeView(root, viewId, { host = null, logBytes = 128, logMtimeMs = null } = {}) {
	mkdirSync(P.viewDir(root, viewId), { recursive: true });
	writeFileSync(P.metaPath(root, viewId), "{}");
	if (host) atomicWriteJson(P.hostPath(root, viewId), host);
	if (logBytes > 0) {
		writeFileSync(P.screenLogPath(root, viewId), Buffer.alloc(logBytes, 65));
		if (logMtimeMs != null) {
			const secs = logMtimeMs / 1000;
			utimesSync(P.screenLogPath(root, viewId), secs, secs);
		}
	}
}

test("normalizeRetentionDays maps prefs values", () => {
	assert.equal(normalizeRetentionDays(0), null); // disabled
	assert.equal(normalizeRetentionDays(7), 7);
	assert.equal(normalizeRetentionDays("3"), 3);
	assert.equal(normalizeRetentionDays(2.9), 2);
	assert.equal(normalizeRetentionDays(-2), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
	assert.equal(normalizeRetentionDays(NaN), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
	assert.equal(normalizeRetentionDays(undefined), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
});

test("removes screen.log of ended views past retention, keeps other files", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "old", { host: { state: "exited", endedAt: now - 10 * DAY_MS }, logBytes: 4096 });
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.removed, 1);
		assert.equal(stats.bytesReclaimed, 4096);
		assert.equal(existsSync(P.screenLogPath(root, "old")), false);
		assert.equal(existsSync(P.metaPath(root, "old")), true); // history row survives
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("active views are never touched, even with old logs", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "live", {
			host: { state: "alive", endedAt: null },
			logBytes: 4096,
			logMtimeMs: now - 30 * DAY_MS, // mtime says ancient; host says live — live wins
		});
		makeView(root, "starting", { host: { state: "starting", endedAt: null }, logBytes: 4096 });
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.skippedActive, 2);
		assert.equal(stats.removed, 0);
		assert.equal(existsSync(P.screenLogPath(root, "live")), true);
		assert.equal(existsSync(P.screenLogPath(root, "starting")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("recently ended views are kept", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "fresh", { host: { state: "exited", endedAt: now - 1 * DAY_MS } });
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.removed, 0);
		assert.equal(stats.skippedFresh, 1);
		assert.equal(existsSync(P.screenLogPath(root, "fresh")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("retentionDays 0 disables GC entirely", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "old", { host: { state: "exited", endedAt: now - 365 * DAY_MS } });
		const stats = pruneScreenLogs(root, { retentionDays: 0, now });
		assert.equal(stats.removed, 0);
		assert.equal(existsSync(P.screenLogPath(root, "old")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing host.json falls back to screen.log mtime", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "stale", { host: null, logMtimeMs: now - 30 * DAY_MS });
		makeView(root, "recent", { host: null, logMtimeMs: now - 1 * DAY_MS });
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.removed, 1);
		assert.equal(stats.skippedFresh, 1);
		assert.equal(existsSync(P.screenLogPath(root, "stale")), false);
		assert.equal(existsSync(P.screenLogPath(root, "recent")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unlink failure does not abort the sweep", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		// A directory named screen.log: statSync succeeds with size>0, unlinkSync fails (EISDIR).
		makeView(root, "broken", { host: { state: "exited", endedAt: now - 10 * DAY_MS }, logBytes: 0 });
		mkdirSync(P.screenLogPath(root, "broken"));
		makeView(root, "normal", { host: { state: "exited", endedAt: now - 10 * DAY_MS } });
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.errors, 1);
		assert.equal(stats.removed, 1);
		assert.equal(existsSync(P.screenLogPath(root, "normal")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
