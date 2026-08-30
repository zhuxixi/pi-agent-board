import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWrite, renameWithRetry } from "../src/core/atomic.mjs";

function freshDir() {
	return mkdtempSync(join(tmpdir(), "agentview-atomic-retry-"));
}

test("renameWithRetry succeeds on first attempt (happy path)", () => {
	const dir = freshDir();
	try {
		const calls = [];
		renameWithRetry("a.tmp", join(dir, "a"), {
			rename: (tmp, file) => { calls.push(1); },
			delays: [],
		});
		assert.equal(calls.length, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("renameWithRetry retries whitelisted EPERM then succeeds", () => {
	const dir = freshDir();
	try {
		let calls = 0;
		renameWithRetry("a.tmp", join(dir, "a"), {
			rename: (tmp, file) => {
				calls += 1;
				if (calls < 3) { const e = new Error("op not permitted"); e.code = "EPERM"; throw e; }
			},
			delays: [1, 1],
		});
		assert.equal(calls, 3);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("renameWithRetry does not retry non-whitelisted errors", () => {
	const dir = freshDir();
	try {
		let calls = 0;
		assert.throws(() => renameWithRetry("a.tmp", join(dir, "a"), {
			rename: () => { calls += 1; const e = new Error("is a directory"); e.code = "EISDIR"; throw e; },
			delays: [1, 1],
		}), (e) => e.code === "EISDIR");
		assert.equal(calls, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("renameWithRetry gives up after all attempts, cleans up tmp, rethrows", () => {
	const dir = freshDir();
	try {
		const tmpPath = join(dir, "gone.tmp");
		let calls = 0;
		assert.throws(() => renameWithRetry(tmpPath, join(dir, "a"), {
			rename: (tmp, file) => { calls += 1; const e = new Error("op not permitted"); e.code = "EPERM"; throw e; },
			delays: [1, 1],
		}), (e) => e.code === "EPERM");
		assert.equal(calls, 3);
		assert.equal(existsSync(tmpPath), false, "tmp cleaned up after exhaustion");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("atomicWrite writes atomically via real fs (e2e happy path)", () => {
	const dir = freshDir();
	try {
		atomicWrite(join(dir, "host.json"), "{}");
		assert.equal(readFileSync(join(dir, "host.json"), "utf8"), "{}");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
