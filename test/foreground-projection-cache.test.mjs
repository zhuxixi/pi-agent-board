import assert from "node:assert/strict";
import { test } from "node:test";
import { createForegroundProjectionCache } from "../src/core/foreground-projection-cache.mjs";

function status(overrides = {}) {
	return {
		semanticState: "working",
		processState: "alive",
		summary: "Working",
		currentTool: null,
		question: null,
		pendingQuestions: [],
		error: null,
		lastActivityAt: 100,
		latestAssistantPreview: "",
		lastAgentActivityAt: null,
		updatedAt: 100,
		...overrides,
	};
}

test("adopt copies the snapshot only when the cached stamp is strictly newer", () => {
	const cache = createForegroundProjectionCache();
	cache.remember("v1", status({ semanticState: "working", summary: "Done" }), 200);
	const stale = status({ semanticState: "needs_input", question: "Q?", pendingQuestions: [{ toolCallId: "q1", question: "Q?" }] });
	assert.equal(cache.adopt("v1", stale), true);
	assert.equal(stale.semanticState, "working");
	assert.equal(stale.summary, "Done");
	assert.equal(stale.question, null);
	assert.deepEqual(stale.pendingQuestions, []);
	assert.equal(stale.updatedAt, 200);

	const equal = status({ semanticState: "needs_input" });
	equal.updatedAt = 200;
	assert.equal(cache.adopt("v1", equal), false);
	assert.equal(equal.semanticState, "needs_input");

	const newer = status({ semanticState: "completed" });
	newer.updatedAt = 300;
	assert.equal(cache.adopt("v1", newer), false);
	assert.equal(newer.semanticState, "completed");
});

test("non-whitelisted fields are never copied", () => {
	const cache = createForegroundProjectionCache();
	cache.remember("v1", status({ summary: "cached" }), 200);
	const live = status({ summary: "disk", updatedAt: 100 });
	live.review = { ready: true };
	live.diagnostics = { code: "keep" };
	live.autoState = { state: "keep" };
	cache.adopt("v1", live);
	assert.equal(live.summary, "cached");
	assert.deepEqual(live.review, { ready: true });
	assert.deepEqual(live.diagnostics, { code: "keep" });
	assert.deepEqual(live.autoState, { state: "keep" });
});

test("remember and adopt clone nested values in both directions", () => {
	const cache = createForegroundProjectionCache();
	const source = status({ currentTool: { name: "bash", path: null }, pendingQuestions: [{ toolCallId: "q1", question: "Q?" }] });
	cache.remember("v1", source, 200);
	source.pendingQuestions[0].question = "mutated";
	source.currentTool.name = "mutated";

	const target = status({ updatedAt: 100 });
	assert.equal(cache.adopt("v1", target), true);
	assert.equal(target.pendingQuestions[0].question, "Q?");
	assert.equal(target.currentTool.name, "bash");
	target.pendingQuestions[0].question = "mutated again";
	const again = status({ updatedAt: 100 });
	cache.adopt("v1", again);
	assert.equal(again.pendingQuestions[0].question, "Q?");
});

test("nextStamp is strictly increasing per view even when the clock is frozen", () => {
	const cache = createForegroundProjectionCache();
	const realNow = Date.now;
	Date.now = () => 1_700_000_000_000;
	try {
		const a1 = cache.nextStamp("v1");
		const a2 = cache.nextStamp("v1");
		const b1 = cache.nextStamp("v2");
		assert.ok(a2 > a1);
		assert.equal(a1, 1_700_000_000_000);
		assert.equal(b1, 1_700_000_000_000);
		assert.ok(a2 > b1);
	} finally {
		Date.now = realNow;
	}
});

test("forget drops the entry", () => {
	const cache = createForegroundProjectionCache();
	cache.remember("v1", status(), 200);
	assert.equal(cache.size(), 1);
	assert.equal(cache.forget("v1"), true);
	assert.equal(cache.size(), 0);
	const stale = status({ updatedAt: 100 });
	assert.equal(cache.adopt("v1", stale), false);
});
