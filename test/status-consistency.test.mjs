import test from "node:test";
import assert from "node:assert/strict";
import { statusRevisionDesynced } from "../src/core/status-consistency.mjs";

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
