import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultLocksFs, withFileLockSync, withViewLockSync } from "../src/core/locks.mjs";
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
