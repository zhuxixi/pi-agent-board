import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync as realRenameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireOwnedViewLock, classifyLeaseOwner, defaultLocksFs, describeLeaseConflict, heartbeatFailureAction, isPublishConflictCode, LEASE_HEARTBEAT_STALE_MS, MAX_CONSECUTIVE_TOUCH_FAILURES, readLeaseHeartbeat, releaseWithToken, tryAcquireOwnedViewLock, withFileLockSync, withViewLockSync } from "../src/core/locks.mjs";
import * as P from "../src/core/paths.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-locks-"));
}

test("withFileLockSync runs fn and releases the lock", () => {
	const root = freshRoot();
	try {
		const lockPath = join(root, "nested", "thing.lock");
		const result = withFileLockSync(lockPath, () => 42);
		assert.equal(result, 42);
		assert.equal(existsSync(lockPath), false, "lock dir must be removed after fn");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLockSync releases the lock when fn throws", () => {
	const root = freshRoot();
	try {
		const lockPath = join(root, "thing.lock");
		assert.throws(
			() => withFileLockSync(lockPath, () => { throw new Error("boom"); }),
			/boom/,
		);
		assert.equal(existsSync(lockPath), false, "lock dir must be released in finally");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLockSync steals a stale lock instead of waiting", () => {
	const root = freshRoot();
	try {
		const lockPath = join(root, "stale.lock");
		// Pre-create a lock owned by a long-dead holder.
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 1, at: Date.now() - 60_000 }), "utf8");
		const result = withFileLockSync(lockPath, () => "stolen", { staleMs: 50 });
		assert.equal(result, "stolen");
		assert.equal(existsSync(lockPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLockSync steals a fresh lock after the stale window", () => {
	const root = freshRoot();
	try {
		const lockPath = join(root, "fresh.lock");
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 1, at: Date.now() }), "utf8");
		// Not stale (holder is "fresh"), so acquire waits ~staleMs then steals.
		const started = Date.now();
		const result = withFileLockSync(lockPath, () => "forced", { staleMs: 30 });
		assert.equal(result, "forced");
		assert.ok(Date.now() - started >= 20, "acquire should have waited for the stale window before forcing");
		assert.equal(existsSync(lockPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withViewLockSync locks on the derived view lock path", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "view-1", "dispatch");
		let lockPathSeen = null;
		const result = withViewLockSync(root, "view-1", "dispatch", () => {
			// While fn runs the lock must exist at the derived path.
			lockPathSeen = existsSync(lockPath);
			return "ok";
		});
		assert.equal(result, "ok");
		assert.equal(lockPathSeen, true);
		assert.equal(existsSync(lockPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const LOCK_FS = defaultLocksFs;

function eexist() {
	const e = new Error("EEXIST");
	e.code = "EEXIST";
	return e;
}

test("withFileLockSync throws promptly when mkdirSync keeps failing", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const fs = {
			...LOCK_FS,
			mkdirSync: (p, o) => {
				const e = new Error("EACCES");
				e.code = "EACCES";
				throw e;
			},
		};
		const started = Date.now();
		assert.throws(
			() => withFileLockSync(join(root, "x.lock"), () => "no", { fs }),
			/lock path unusable/,
		);
		assert.ok(Date.now() - started < 2000, "must fail fast, not spin");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLockSync throws and cleans up when owner.json writes keep failing", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const fs = {
			...LOCK_FS,
			writeFileSync: (file, data, opts) => {
				if (String(file).endsWith("owner.json")) {
					const e = new Error("ENOSPC");
					e.code = "ENOSPC";
					throw e;
				}
				return LOCK_FS.writeFileSync(file, data, opts);
			},
		};
		assert.throws(
			() => withFileLockSync(join(root, "w.lock"), () => "no", { fs }),
			/lock path unusable/,
		);
		assert.equal(existsSync(join(root, "w.lock")), false, "half-created lock must be cleaned up");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLockSync throws after bounded steal attempts when rmSync keeps failing", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const lockPath = join(root, "s.lock");
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 1, at: Date.now() - 60_000 }), "utf8"); // stale
		const fs = {
			...LOCK_FS,
			rmSync: (p, o) => {
				const e = new Error("EPERM");
				e.code = "EPERM";
				throw e;
			},
		};
		const started = Date.now();
		assert.throws(
			() => withFileLockSync(lockPath, () => "no", { fs, staleMs: 50 }),
			/stale lock could not be stolen/,
		);
		assert.ok(Date.now() - started < 2000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLockSync waits through transient contention and acquires", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const lockPath = join(root, "c.lock");
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 1, at: Date.now() }), "utf8"); // fresh holder
		let eexistLeft = 3;
		const fs = {
			...LOCK_FS,
			mkdirSync: (p, o) => {
				if (p === lockPath && eexistLeft-- > 0) throw eexist();
				if (p === lockPath) LOCK_FS.rmSync(lockPath, { recursive: true, force: true }); // holder releases
				return LOCK_FS.mkdirSync(p, o);
			},
		};
		const started = Date.now();
		const result = withFileLockSync(lockPath, () => "won", { fs, staleMs: 30_000 });
		assert.equal(result, "won");
		assert.ok(Date.now() - started >= 40, "should have slept through contention ticks");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("withFileLockSync self-heals a parent dir deleted mid-acquisition", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const lockPath = join(root, "del", "parent", "p.lock");
		let failedOnce = false;
		const fs = {
			...LOCK_FS,
			mkdirSync: (p, o) => {
				if (p === lockPath && !failedOnce) {
					failedOnce = true; // simulate parent deleted between ensureDir and mkdir
					const e = new Error("ENOENT");
					e.code = "ENOENT";
					throw e;
				}
				return LOCK_FS.mkdirSync(p, o);
			},
		};
		const result = withFileLockSync(lockPath, () => "healed", { fs });
		assert.equal(result, "healed");
		assert.equal(existsSync(lockPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lock timeout errors carry LOCK_TIMEOUT code and the lock path", { timeout: 5000 }, () => {
	const root = freshRoot();
	try {
		const fs = {
			...LOCK_FS,
			mkdirSync: (p, o) => {
				const e = new Error("EROFS");
				e.code = "EROFS";
				throw e;
			},
		};
		const lockPath = join(root, "code.lock");
		assert.throws(
			() => withFileLockSync(lockPath, () => "no", { fs }),
			(err) => err.code === "LOCK_TIMEOUT" && String(err.message).includes(lockPath),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("owned lease publishes complete owner record and old token cannot release new lock", () => {
	const root = freshRoot();
	try {
		const a = acquireOwnedViewLock(root, "v1", "host-start", { identity: { pid: process.pid, startToken: "a" } });
		assert.equal(a.isOwner(), true);
		const b = tryAcquireOwnedViewLock(root, "v1", "host-start", { identity: { pid: process.pid, startToken: "b" } });
		assert.equal(b.acquired, false);
		assert.equal(b.reason, "busy");
		const stale = { token: a.token, release: () => {} };
		a.release();
		const c = acquireOwnedViewLock(root, "v1", "host-start", { identity: { pid: process.pid, startToken: "c" } });
		// simulate late release from the old token by forging a release with a's token
		assert.equal(releaseWithToken(root, "v1", "host-start", a.token), false, "old token must not delete the new lock");
		assert.equal(c.isOwner(), true);
		c.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dead-owner lock is reclaimed via quarantine, unknown identity is blocked", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "host-start");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "old", pid: 99999999, identity: { pid: 99999999, startToken: "x" }, startedAt: Date.now() }));
		const got = tryAcquireOwnedViewLock(root, "v1", "host-start", { identity: { pid: process.pid, startToken: "me" } });
		assert.equal(got.acquired, true);
		got.lease.release();
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "unk", pid: process.pid, identity: null, startedAt: Date.now() }));
		const blocked = tryAcquireOwnedViewLock(root, "v1", "host-start", { identity: { pid: process.pid, startToken: "me" } });
		assert.equal(blocked.acquired, false);
		assert.equal(blocked.reason, "blocked");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---- identity-less orphan reclaim (issue #112) ------------------------------

const DEAD_PID = 99999999;
const FIXED_NOW = 1_800_000_000_000;
const livePid = () => false;
const deadPid = () => true;

test("classifyLeaseOwner: a full identity reclaims exactly when its pid is dead", () => {
	const owner = { token: "t", pid: 1, identity: { pid: 1, startToken: "s" }, startedAt: FIXED_NOW };
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid), "busy");
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, deadPid), "reclaim");
});

test("classifyLeaseOwner: identity-less owners need age AND a dead pid", () => {
	const fresh = { token: "t", pid: DEAD_PID, identity: null, startedAt: FIXED_NOW - 60_000 };
	assert.equal(classifyLeaseOwner(fresh, FIXED_NOW, deadPid), "blocked", "fresh identity-less lock stays blocked");
	const stale = { token: "t", pid: DEAD_PID, identity: null, startedAt: FIXED_NOW - 10 * 60_000 };
	assert.equal(classifyLeaseOwner(stale, FIXED_NOW, deadPid), "reclaim");
	assert.equal(classifyLeaseOwner(stale, FIXED_NOW, livePid), "busy");
});

test("classifyLeaseOwner: the age threshold is inclusive and injectable", () => {
	const atThreshold = { token: "t", pid: DEAD_PID, identity: null, startedAt: FIXED_NOW - 1000 };
	assert.equal(classifyLeaseOwner(atThreshold, FIXED_NOW, deadPid, { orphanAgeMs: 1000 }), "reclaim");
	assert.equal(classifyLeaseOwner(atThreshold, FIXED_NOW, deadPid, { orphanAgeMs: 1001 }), "blocked");
});

test("classifyLeaseOwner: unparseable, token-less, and pid-less owners never reclaim", () => {
	assert.equal(classifyLeaseOwner(null, FIXED_NOW, deadPid), "blocked");
	assert.equal(classifyLeaseOwner("nope", FIXED_NOW, deadPid), "blocked");
	assert.equal(classifyLeaseOwner({ pid: DEAD_PID, identity: null, startedAt: 0 }, FIXED_NOW, deadPid), "blocked", "no token → no reclaim");
	assert.equal(classifyLeaseOwner({ token: "t", identity: null, startedAt: 0 }, FIXED_NOW, deadPid), "blocked", "no pid → nothing to judge");
	assert.equal(classifyLeaseOwner({ identity: { pid: 1, startToken: "s" }, startedAt: 0 }, FIXED_NOW, deadPid), "blocked", "dead pid without token must not reclaim");
	assert.equal(classifyLeaseOwner({ identity: { pid: 1, startToken: "s" }, startedAt: 0 }, FIXED_NOW, livePid), "busy", "live-holder path keeps busy even without a token");
});

test("classifyLeaseOwner: null startToken (non-Linux) uses the identity-less fallback", () => {
	const stale = { token: "t", pid: DEAD_PID, identity: { pid: DEAD_PID, startToken: null }, startedAt: FIXED_NOW - 10 * 60_000 };
	assert.equal(classifyLeaseOwner(stale, FIXED_NOW, deadPid), "reclaim");
	assert.equal(classifyLeaseOwner({ ...stale, startedAt: FIXED_NOW }, FIXED_NOW, deadPid), "blocked");
});

test("stale identity-less lock (issue #112 residue) is reclaimed via quarantine", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "host-meta");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "orphan", pid: 99999999, identity: null, startedAt: Date.now() - 10 * 60_000 }));
		const got = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: { pid: process.pid, startToken: "me" } });
		assert.equal(got.acquired, true, "stale identity-less lock must be recoverable");
		got.lease.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fresh identity-less lock is still blocked (short-hold contract preserved)", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "host-meta");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "unk", pid: process.pid, identity: null, startedAt: Date.now() }));
		const blocked = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: { pid: process.pid, startToken: "me" } });
		assert.equal(blocked.acquired, false);
		assert.equal(blocked.reason, "blocked");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---- publish-rename conflict codes (issue #114) -----------------------------

test("isPublishConflictCode: rename conflict codes including Windows EPERM", () => {
	assert.equal(isPublishConflictCode("EEXIST"), true);
	assert.equal(isPublishConflictCode("ENOTEMPTY"), true, "POSIX rename onto an existing dir");
	assert.equal(isPublishConflictCode("EPERM"), true, "Windows rename onto an existing dir (errno -4048)");
	assert.equal(isPublishConflictCode("ENOENT"), false);
	assert.equal(isPublishConflictCode("EACCES"), false);
	assert.equal(isPublishConflictCode(undefined), false);
	assert.equal(isPublishConflictCode(null), false);
});

/** Windows-style publish fs: renaming onto an existing lock path throws EPERM
 *  (errno -4048) instead of POSIX's ENOTEMPTY; all other ops are real. */
function windowsPublishFs(lockPath) {
	const fs = {
		...LOCK_FS,
		renameSync: (from, to, ...rest) => {
			if (String(to) === lockPath && fs.existsSync(to)) {
				const e = new Error("EPERM: operation not permitted, rename");
				e.code = "EPERM";
				throw e;
			}
			return realRenameSync(from, to, ...rest);
		},
	};
	return fs;
}

const ME = { pid: process.pid, startToken: "me" };
const DEAD = { pid: 99999999, startToken: "dead" };

test("EPERM publish contention: dead owner with full identity is reclaimed", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "coordinator");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "t", pid: DEAD.pid, identity: DEAD, startedAt: Date.now() }));
		const got = tryAcquireOwnedViewLock(root, "v1", "coordinator", { identity: ME, fs: windowsPublishFs(lockPath) });
		assert.equal(got.acquired, true, "EPERM contention must reach reclaimOrBlock");
		assert.equal(got.lease.isOwner(), true);
		assert.equal(got.lease.release(), true, "the reclaimed lease must be the holder's to release");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("EPERM publish contention: stale identity-less owner (Windows startToken:null) is reclaimed", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "coordinator");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
			token: "t", pid: DEAD.pid,
			identity: { pid: DEAD.pid, startToken: null },
			startedAt: Date.now() - 10 * 60_000,
		}));
		const got = tryAcquireOwnedViewLock(root, "v1", "coordinator", { identity: ME, fs: windowsPublishFs(lockPath) });
		assert.equal(got.acquired, true, "issue #112 orphan reclaim must be reachable through EPERM contention");
		assert.equal(got.lease.release(), true, "the reclaimed lease must be the holder's to release");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("EPERM publish contention: live owner stays busy (no steal)", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "coordinator");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "t", pid: process.pid, identity: { pid: process.pid, startToken: "live" }, startedAt: Date.now() }));
		const got = tryAcquireOwnedViewLock(root, "v1", "coordinator", { identity: ME, fs: windowsPublishFs(lockPath) });
		assert.equal(got.acquired, false);
		assert.equal(got.reason, "busy");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("EPERM publish contention: fresh identity-less owner stays blocked", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "coordinator");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "t", pid: DEAD.pid, identity: null, startedAt: Date.now() }));
		const got = tryAcquireOwnedViewLock(root, "v1", "coordinator", { identity: ME, fs: windowsPublishFs(lockPath) });
		assert.equal(got.acquired, false);
		assert.equal(got.reason, "blocked");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---- heartbeat staleness reclaim (issue #224) -------------------------------

const HB_STALE = 60_000;
const hb = (o) => ({ heartbeatStaleMs: HB_STALE, ...o });

test("classifyLeaseOwner: declared heartbeat — stale reclaims, fresh stays busy (A3)", () => {
	const owner = { token: "t", pid: 1, identity: null, startedAt: FIXED_NOW - 2 * 60_000, heartbeatMs: 1000 };
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, hb({ heartbeatAgeMs: HB_STALE })), "reclaim");
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, hb({ heartbeatAgeMs: HB_STALE - 1 })), "busy");
});

test("classifyLeaseOwner: threshold is max(staleMs, 3 × period) — both sides (A3)", () => {
	const owner = { token: "t", pid: 1, identity: null, startedAt: FIXED_NOW - 10 * 60_000, heartbeatMs: 20_000 };
	// (a) staleMs (90s) dominates 3 × period (60s)
	const a = hb({ heartbeatStaleMs: 90_000, heartbeatAgeMs: 90_000 });
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, a), "reclaim");
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, { ...a, heartbeatAgeMs: 89_999 }), "busy");
	// (b) 3 × period (60s) dominates a 10s staleMs
	const b = hb({ heartbeatStaleMs: 10_000, heartbeatAgeMs: 60_000 });
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, b), "reclaim");
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, { ...b, heartbeatAgeMs: 59_999 }), "busy");
});

test("classifyLeaseOwner: declared bypasses the identity-less age gate (A3b)", () => {
	const young = { token: "t", pid: 1, identity: null, startedAt: FIXED_NOW - 30_000, heartbeatMs: 1000 };
	assert.equal(classifyLeaseOwner(young, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 120_000 })), "reclaim");
});

test("classifyLeaseOwner: declared runs before the hasIdentity busy path (A3, Linux shape)", () => {
	const linux = { token: "t", pid: 1, identity: { pid: 1, startToken: "s" }, startedAt: FIXED_NOW - 60_000, heartbeatMs: 1000 };
	assert.equal(classifyLeaseOwner(linux, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 120_000 })), "reclaim");
	assert.equal(classifyLeaseOwner(linux, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 0 })), "busy");
});

test("classifyLeaseOwner: legacy heartbeat requires age >= orphanAgeMs (A1b/A1c pure shape)", () => {
	const young = { token: "t", pid: 1, identity: null, startedAt: FIXED_NOW - 30_000 };
	assert.equal(classifyLeaseOwner(young, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 120_000 })), "blocked");
	const aged = { ...young, startedAt: FIXED_NOW - 10 * 60_000 };
	assert.equal(classifyLeaseOwner(aged, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 120_000 })), "reclaim");
	assert.equal(classifyLeaseOwner(aged, FIXED_NOW, livePid, hb({ heartbeatAgeMs: 0 })), "busy");
});

test("classifyLeaseOwner: negative heartbeat age counts as fresh (A5)", () => {
	const owner = { token: "t", pid: 1, identity: null, startedAt: FIXED_NOW - 10 * 60_000, heartbeatMs: 1000 };
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid, hb({ heartbeatAgeMs: -5000 })), "busy");
});

const HOUR = 3_600_000;
const ME_NULL = { pid: process.pid, startToken: null };   // Windows coordinator identity

function seedLock(root, viewId, name, owner, heartbeatAgeMs) {
	const lockPath = P.viewLockPath(root, viewId, name);
	mkdirSync(lockPath, { recursive: true });
	writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner));
	if (heartbeatAgeMs != null) {
		writeFileSync(join(lockPath, `heartbeat.${owner.token}`), JSON.stringify({ at: Date.now() - heartbeatAgeMs }));
	}
	return lockPath;
}

test("#224 A1: reused pid + stale heartbeat + aged lock is reclaimed", () => {
	const root = freshRoot();
	try {
		seedLock(root, "_coordinator", "state-coordinator", {
			token: "stranded", pid: process.pid,
			identity: { pid: process.pid, startToken: null },
			startedAt: Date.now() - 48 * HOUR,
		}, 24 * HOUR);
		const got = tryAcquireOwnedViewLock(root, "_coordinator", "state-coordinator", { identity: ME_NULL });
		assert.equal(got.acquired, true);
		assert.equal(got.lease.reclaimed.eligibility, "legacy");
		assert.ok(got.lease.reclaimed.heartbeatAgeMs >= 24 * HOUR - 1000);
		got.lease.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A1b: young lock with a heartbeat file stays blocked", () => {
	const root = freshRoot();
	try {
		seedLock(root, "v1", "host-meta", { token: "boot", pid: process.pid, identity: null, startedAt: Date.now() - 30_000 }, 29_000);
		const got = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: ME });
		assert.equal(got.acquired, false);
		assert.equal(got.reason, "blocked");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A1c: aged lock with a fresh heartbeat stays busy", () => {
	const root = freshRoot();
	try {
		seedLock(root, "v1", "host-meta", { token: "slow", pid: process.pid, identity: null, startedAt: Date.now() - 10 * 60_000 }, 0);
		const got = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: ME });
		assert.equal(got.acquired, false);
		assert.equal(got.reason, "busy");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A2: declared period reaches owner.json and a fresh heartbeat stays busy", () => {
	const root = freshRoot();
	try {
		const got = tryAcquireOwnedViewLock(root, "_coordinator", "state-coordinator", { identity: ME_NULL, heartbeatMs: 1000 });
		assert.equal(got.acquired, true);
		const ownerPath = join(P.viewLockPath(root, "_coordinator", "state-coordinator"), "owner.json");
		assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).heartbeatMs, 1000);
		got.lease.release();
		seedLock(root, "_coordinator", "state-coordinator", {
			token: "declared", pid: process.pid, identity: { pid: process.pid, startToken: null },
			startedAt: Date.now() - 30_000, heartbeatMs: 1000,
		}, 0);
		const held = tryAcquireOwnedViewLock(root, "_coordinator", "state-coordinator", { identity: ME_NULL });
		assert.equal(held.acquired, false);
		assert.equal(held.reason, "busy");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A5b: readLeaseHeartbeat clamps a future timestamp to 0", () => {
	const now = Date.now();
	const fakeFs = { ...defaultLocksFs, readFileSync: () => JSON.stringify({ at: now + 5000 }) };
	assert.equal(readLeaseHeartbeat("/nonexistent/lock", "t", fakeFs, now), 0);
});

test("#224 A6: broken heartbeat fails closed for legacy, falls back for declared", () => {
	const root = freshRoot();
	try {
		const legacyPath = seedLock(root, "v1", "host-meta", { token: "b", pid: process.pid, identity: null, startedAt: Date.now() - 10 * 60_000 }, null);
		writeFileSync(join(legacyPath, "heartbeat.b"), "{not json");
		const legacy = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: ME });
		assert.equal(legacy.acquired, false);
		assert.equal(legacy.reason, "busy", "unreadable heartbeat grants no eligibility");

		seedLock(root, "v2", "host-meta", {
			token: "d", pid: process.pid, identity: { pid: process.pid, startToken: null },
			startedAt: Date.now() - 10 * 60_000, heartbeatMs: 1000,
		}, null);
		writeFileSync(join(P.viewLockPath(root, "v2", "host-meta"), "heartbeat.d"), "{not json");
		const declared = tryAcquireOwnedViewLock(root, "v2", "host-meta", { identity: ME });
		assert.equal(declared.acquired, true, "declared leases fall back to startedAt");
		declared.lease.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A7: a successor's lock is never deleted by a stale reclaim", () => {
	const root = freshRoot();
	try {
		const lockPath = seedLock(root, "v1", "host-meta", { token: "old", pid: process.pid, identity: null, startedAt: Date.now() - 10 * 60_000 }, 120_000);
		const successor = { token: "new", pid: process.pid, identity: null, startedAt: Date.now() };
		const racingFs = {
			...defaultLocksFs,
			renameSync: (from, to) => {
				// A concurrent winner publishes between our read and our quarantine rename.
				if (String(from) === lockPath) writeFileSync(join(lockPath, "owner.json"), JSON.stringify(successor));
				return realRenameSync(from, to);
			},
		};
		const got = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: ME, fs: racingFs });
		assert.equal(got.acquired, false);
		assert.equal(got.reason, "busy");
		assert.equal(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).token, "new");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A8: describeLeaseConflict returns exactly six fields", () => {
	const root = freshRoot();
	try {
		seedLock(root, "_coordinator", "state-coordinator", {
			token: "t", pid: process.pid, identity: { pid: process.pid, startToken: null },
			startedAt: Date.now() - 1000,
		}, 0);
		const world = describeLeaseConflict(root, "_coordinator", "state-coordinator");
		assert.deepEqual(
			Object.keys(world).sort(),
			["hasIdentity", "heartbeatAgeMs", "heartbeatMs", "lockAgeMs", "ownerPid", "reason"],
		);
		assert.equal(world.reason, "blocked", "young identity-less lock is fail-closed");
		assert.equal(world.ownerPid, process.pid);
		assert.equal(world.hasIdentity, false);
		assert.equal(world.heartbeatMs, null);
		assert.ok(world.lockAgeMs >= 0 && world.lockAgeMs < 60_000);
		assert.ok(world.heartbeatAgeMs != null && world.heartbeatAgeMs >= 0);
		assert.equal(describeLeaseConflict(root, "_coordinator", "absent"), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#224 A9/A9b: step-down boundary and its relationship to the stale threshold", () => {
	assert.equal(heartbeatFailureAction(2, 3), "continue");
	assert.equal(heartbeatFailureAction(3, 3), "abandon");
	assert.ok(MAX_CONSECUTIVE_TOUCH_FAILURES * 1000 < LEASE_HEARTBEAT_STALE_MS, "step down before anyone can reclaim us");
});
