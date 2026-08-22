import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withFileLockSync, withViewLockSync } from "../src/core/locks.mjs";
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
