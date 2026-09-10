import test from "node:test";
import assert from "node:assert/strict";
import { createDesyncEpisodeThrottle, rereadPair, statusRevisionDesynced } from "../src/core/status-consistency.mjs";

test("statusRevisionDesynced table", async (t) => {
	const cases = [
		{ name: "differing revisions desync", state: { materializedRevision: 2 }, status: { materializedRevision: 1 }, want: true },
		{ name: "equal revisions consistent", state: { materializedRevision: 3 }, status: { materializedRevision: 3 }, want: false },
		{ name: "state half lacks revision (legacy) skipped", state: {}, status: { materializedRevision: 1 }, want: false },
		{ name: "status half lacks revision (legacy) skipped", state: { materializedRevision: 1 }, status: {}, want: false },
		{ name: "both halves lack revision (legacy) skipped", state: {}, status: {}, want: false },
		{ name: "null state never desynced", state: null, status: { materializedRevision: 1 }, want: false },
		{ name: "null status never desynced", state: { materializedRevision: 1 }, status: null, want: false },
		{ name: "undefined halves skipped", state: undefined, status: undefined, want: false },
	];
	for (const c of cases) {
		await t.test(c.name, () => {
			assert.equal(statusRevisionDesynced(c.state, c.status), c.want);
		});
	}
});

test("extra fields do not affect the verdict", () => {
	const state = { viewId: "v", semanticState: "working", materializedRevision: 7 };
	const status = { runId: "r", endedAt: 9, materializedRevision: 8 };
	assert.equal(statusRevisionDesynced(state, status), true);
	assert.equal(statusRevisionDesynced(state, { ...status, materializedRevision: 7 }), false);
});

test("createDesyncEpisodeThrottle logs each distinct pair once per view", () => {
	const throttle = createDesyncEpisodeThrottle();
	assert.equal(throttle.shouldLog("v1", 3, 1), true, "first sight of a pair logs");
	assert.equal(throttle.shouldLog("v1", 3, 1), false, "same stuck pair is throttled");
	assert.equal(throttle.shouldLog("v1", 3, 1), false, "still throttled on later passes");
	assert.equal(throttle.shouldLog("v1", 4, 1), true, "progression to a new pair logs again");
	assert.equal(throttle.shouldLog("v1", 4, 1), false);
	assert.equal(throttle.shouldLog("v2", 3, 1), true, "views are independent");
	assert.equal(throttle.shouldLog("v1", 3, 1), true, "returning to an earlier pair logs (fresh episode after heal + re-crash)");
});

test("createDesyncEpisodeThrottle instances are independent", () => {
	const a = createDesyncEpisodeThrottle();
	const b = createDesyncEpisodeThrottle();
	assert.equal(a.shouldLog("v", 1, 1), true);
	assert.equal(b.shouldLog("v", 1, 1), true, "a separate service's throttle has its own episode memory");
});

test("rereadPair re-reads both halves fresh and re-verdicts (TOCTOU guard)", () => {
	// Scenario: the reconcile snapshot suspected a desync, but by the time the
	// re-read happens the on-disk pair has converged (e.g. a concurrent paired
	// write landed) — the fresh pair is consistent, so no action is taken.
	const consistent = {
		readState: () => ({ materializedRevision: 3 }),
		readStatus: () => ({ materializedRevision: 3 }),
	};
	const r1 = rereadPair("root", "v1", "r1", consistent);
	assert.equal(r1.desynced, false, "fresh consistent pair clears the suspicion");
	assert.equal(r1.state.materializedRevision, 3);
	assert.equal(r1.status.materializedRevision, 3);

	// The suspicion is confirmed: the fresh pair still disagrees — return the
	// FRESH values (not the stale snapshot's) so logging details are accurate.
	const desynced = {
		readState: () => ({ materializedRevision: 5 }),
		readStatus: () => ({ materializedRevision: 2 }),
	};
	const r2 = rereadPair("root", "v1", "r1", desynced);
	assert.equal(r2.desynced, true);
	assert.equal(r2.state.materializedRevision, 5);
	assert.equal(r2.status.materializedRevision, 2);
});

test("rereadPair never flags legacy pairs (missing stamps)", () => {
	const legacy = {
		readState: () => ({ semanticState: "working" }),
		readStatus: () => ({ semanticState: "completed" }),
	};
	assert.equal(rereadPair("root", "v1", "r1", legacy).desynced, false);
});

test("kick-retry tracking is independent of the diagnostic episode (CR r2 issue-4)", () => {
	const throttle = createDesyncEpisodeThrottle();
	// New episode: log fires, no retry pending.
	assert.equal(throttle.shouldLog("v1", 2, 1), true);
	assert.equal(throttle.shouldRetryKick("v1"), false);
	// Kick failed: retries flag on, diagnostic episode unchanged.
	throttle.markKickFailed("v1");
	assert.equal(throttle.shouldRetryKick("v1"), true);
	assert.equal(throttle.shouldLog("v1", 2, 1), false, "same pair does not re-log");
	// Another view is unaffected.
	throttle.markKickFailed("v2");
	assert.equal(throttle.shouldRetryKick("v1"), true);
	assert.equal(throttle.shouldRetryKick("v2"), true);
	// Successful kick clears only that view's retry flag.
	throttle.clearKickFailed("v1");
	assert.equal(throttle.shouldRetryKick("v1"), false);
	assert.equal(throttle.shouldRetryKick("v2"), true);
	// A changed pair is a new diagnostic episode regardless of kick state.
	assert.equal(throttle.shouldLog("v1", 3, 1), true);
});
