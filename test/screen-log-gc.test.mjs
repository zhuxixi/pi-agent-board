import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import {
	DEFAULT_SCREEN_LOG_RETENTION_DAYS,
	normalizeRetentionDays,
	normalizeScreenLogMaxBytes,
	pruneScreenLogs,
} from "../src/core/screen-log-gc.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agent-board-gc-"));
}

/** Create a view dir with a small meta.json, optional host.json, optional screen.log. */
function makeView(root, viewId, { host = null, hostMtimeMs = null, logBytes = 128, logMtimeMs = null } = {}) {
	mkdirSync(P.viewDir(root, viewId), { recursive: true });
	writeFileSync(P.metaPath(root, viewId), "{}");
	if (host) {
		atomicWriteJson(P.hostPath(root, viewId), host);
		// host.json is written fresh; backdate when the scenario needs the heartbeat
		// grace window to have expired (a live runner rewrites it every second).
		if (hostMtimeMs != null) {
			const secs = hostMtimeMs / 1000;
			utimesSync(P.hostPath(root, viewId), secs, secs);
		}
	}
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
	assert.equal(normalizeRetentionDays(null), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
	// Every zero form disables — a floored-to-0 retention must never reach the sweep
	// (cutoff would equal now and delete every ended view's log regardless of age).
	assert.equal(normalizeRetentionDays(0.5), null);
	assert.equal(normalizeRetentionDays("0.0"), null);
	assert.equal(normalizeRetentionDays(" 0"), null);
	// Garbage values are hand-edit accidents: default window, never a silent disable.
	assert.equal(normalizeRetentionDays(""), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
	assert.equal(normalizeRetentionDays(" "), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
	assert.equal(normalizeRetentionDays(false), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
	assert.equal(normalizeRetentionDays([]), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
	assert.equal(normalizeRetentionDays("abc"), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
});

test("normalizeScreenLogMaxBytes maps prefs values", () => {
	assert.equal(normalizeScreenLogMaxBytes(2048), 2048);
	assert.equal(normalizeScreenLogMaxBytes("4096"), 4096);
	// Fractions in (0,1) floor to 0 and must become null, not a 0-byte cap.
	assert.equal(normalizeScreenLogMaxBytes(0.5), null);
	assert.equal(normalizeScreenLogMaxBytes(0), null);
	assert.equal(normalizeScreenLogMaxBytes(-5), null);
	assert.equal(normalizeScreenLogMaxBytes("x"), null);
	assert.equal(normalizeScreenLogMaxBytes(null), null);
	assert.equal(normalizeScreenLogMaxBytes(undefined), null);
	// Garbage values must not coerce into a pathological cap (true → 1 byte).
	assert.equal(normalizeScreenLogMaxBytes(true), null);
	assert.equal(normalizeScreenLogMaxBytes([2048]), null);
});

test("removes screen.log of ended views past retention, keeps other files", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "old", {
			host: { state: "exited", endedAt: now - 10 * DAY_MS },
			hostMtimeMs: now - 10 * DAY_MS, // heartbeat stopped at exit
			logBytes: 4096,
		});
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

test("stale-alive view with a dead runner pid is reclaimed", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		// A runner killed by SIGKILL/OOM leaves host.json saying "alive" forever.
		const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid;
		makeView(root, "crashed", {
			host: { state: "alive", endedAt: null, runnerPid: deadPid },
			hostMtimeMs: now - 30 * DAY_MS, // no heartbeat since the crash
			logBytes: 4096,
			logMtimeMs: now - 30 * DAY_MS,
		});
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.removed, 1);
		assert.equal(existsSync(P.screenLogPath(root, "crashed")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a live runner pid keeps the view exempt even with a stale host.json", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "live", {
			host: { state: "alive", endedAt: null, runnerPid: process.pid, lastSeenAt: now },
			hostMtimeMs: now - 30 * DAY_MS, // heartbeat file timestamp somehow stalled
			logBytes: 4096,
			logMtimeMs: now - 30 * DAY_MS,
		});
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.removed, 0);
		assert.equal(stats.skippedActive, 1);
		assert.equal(existsSync(P.screenLogPath(root, "live")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a live pid with an ancient lastSeenAt does not exempt the view (pid recycling)", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		// Runner died long ago; its pid was recycled by an unrelated process (process.pid
		// is alive), but the "alive" claim is 30 days stale — do not trust it.
		makeView(root, "recycled", {
			host: { state: "alive", endedAt: null, runnerPid: process.pid, lastSeenAt: now - 30 * DAY_MS },
			hostMtimeMs: now - 30 * DAY_MS,
			logBytes: 4096,
			logMtimeMs: now - 30 * DAY_MS,
		});
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.removed, 1);
		assert.equal(existsSync(P.screenLogPath(root, "recycled")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("foreign directories without any view marker are skipped and counted", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		const foreign = join(P.viewsDir(root), "not-a-view");
		mkdirSync(foreign, { recursive: true });
		writeFileSync(P.screenLogPath(root, "not-a-view"), Buffer.alloc(4096, 65));
		const old = (now - 30 * DAY_MS) / 1000;
		utimesSync(P.screenLogPath(root, "not-a-view"), old, old);
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.scanned, 0);
		assert.equal(stats.skippedForeign, 1);
		assert.equal(stats.removed, 0);
		assert.equal(existsSync(P.screenLogPath(root, "not-a-view")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a stray or foreign host.json does not make a directory sweepable", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		const oldSecs = (now - 30 * DAY_MS) / 1000;
		// Variant 1: unparseable host.json
		mkdirSync(P.viewDir(root, "stray-garbage"), { recursive: true });
		writeFileSync(P.hostPath(root, "stray-garbage"), "not json{");
		writeFileSync(P.screenLogPath(root, "stray-garbage"), Buffer.alloc(4096, 65));
		utimesSync(P.screenLogPath(root, "stray-garbage"), oldSecs, oldSecs);
		// Variant 2: parseable host.json but for a DIFFERENT view
		mkdirSync(P.viewDir(root, "stray-mismatch"), { recursive: true });
		atomicWriteJson(P.hostPath(root, "stray-mismatch"), { viewId: "someone-else", state: "exited", endedAt: now - 30 * DAY_MS });
		utimesSync(P.hostPath(root, "stray-mismatch"), oldSecs, oldSecs);
		writeFileSync(P.screenLogPath(root, "stray-mismatch"), Buffer.alloc(4096, 65));
		utimesSync(P.screenLogPath(root, "stray-mismatch"), oldSecs, oldSecs);
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.removed, 0);
		assert.equal(stats.skippedForeign, 2);
		assert.equal(existsSync(P.screenLogPath(root, "stray-garbage")), true);
		assert.equal(existsSync(P.screenLogPath(root, "stray-mismatch")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a view whose meta.json was deleted externally stays reclaimable via host.json", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		// meta.json gone, a valid host.json for THIS view survives: still sweepable.
		mkdirSync(P.viewDir(root, "orphan"), { recursive: true });
		atomicWriteJson(P.hostPath(root, "orphan"), { viewId: "orphan", state: "exited", endedAt: now - 10 * DAY_MS });
		writeFileSync(P.screenLogPath(root, "orphan"), Buffer.alloc(4096, 65));
		const old = (now - 10 * DAY_MS) / 1000;
		utimesSync(P.hostPath(root, "orphan"), old, old);
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.removed, 1);
		assert.equal(existsSync(P.screenLogPath(root, "orphan")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("recently ended views are kept", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "fresh", {
			host: { state: "exited", endedAt: now - 1 * DAY_MS },
			hostMtimeMs: now - 1 * DAY_MS,
		});
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
		makeView(root, "broken", {
			host: { state: "exited", endedAt: now - 10 * DAY_MS },
			hostMtimeMs: now - 10 * DAY_MS,
			logBytes: 0,
		});
		mkdirSync(P.screenLogPath(root, "broken"));
		makeView(root, "normal", {
			host: { state: "exited", endedAt: now - 10 * DAY_MS },
			hostMtimeMs: now - 10 * DAY_MS,
		});
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.errors, 1);
		assert.equal(stats.removed, 1);
		assert.equal(existsSync(P.screenLogPath(root, "normal")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
