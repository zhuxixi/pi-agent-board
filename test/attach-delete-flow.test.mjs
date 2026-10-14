// test/attach-delete-flow.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "attach-delete-flow-probe.ts");

function runProbe(mode) {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, ...(mode ? { DEL_FLOW_MODE: mode } : {}) },
	});
	return JSON.parse(out.trim().split("\n").filter(Boolean).at(-1));
}

// A5: the loop archives the deleted row, preserves its session file, and the
// reopened board receives the neighbor id + the Deleted notice.
test("attach delete flow: archive + board reopen params (issue #147 A5)", () => {
	const r = runProbe();
	assert.equal(r.error, null);
	assert.equal(r.archived, true, "v2 must be archived");
	assert.equal(r.sessionExists, true, "session file must be preserved");
	assert.deepEqual(r.archiveCalls, ["v2"], "exactly one archive call for the deleted view");
	assert.ok(!r.rowsAfter.includes("v2"), "archived row leaves the board list");
	assert.equal(r.boardDeps.length, 2, "two board opens (attach pick + post-delete reopen)");
	assert.equal(r.boardDeps[1].initialSelectedId, "v3", "neighbor id lands on the reopened board");
	assert.equal(r.boardDeps[1].initialNotice, 'Deleted "two"', "the notice lands on the reopened board");
	assert.deepEqual(r.notifications, [], "no notifications on the happy path");
});

// A6: archive failure is not silent — an error notify fires, the loop still
// reopens the board, and nothing throws.
test("attach delete flow: archive failure notifies (issue #147 A6)", () => {
	const r = runProbe("archive-fail");
	assert.equal(r.error, null);
	assert.deepEqual(r.archiveCalls, ["v2"]);
	assert.ok(r.notifications.some((n) => n.level === "error" && n.text.includes("boom")), "error notify fires");
	assert.equal(r.boardDeps.length, 2, "board still reopens after the failure");
	assert.equal(r.archived, false, "row stays (archive stubbed to fail)");
});
