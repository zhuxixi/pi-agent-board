import assert from "node:assert/strict";
import { test } from "node:test";
import { createForegroundPreviewCache } from "../src/core/foreground-preview-cache.mjs";

/** @returns {{ latestAssistantPreview: string, lastAgentActivityAt: number|null }} */
function emptyStatus() {
	return { latestAssistantPreview: "", lastAgentActivityAt: null };
}

test("remember stores a non-empty projection; backfill restores it into an empty status", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "hello", lastAgentActivityAt: 111 });
	const status = emptyStatus();
	assert.equal(cache.backfill("v1", status), true);
	assert.equal(status.latestAssistantPreview, "hello");
	assert.equal(status.lastAgentActivityAt, 111);
});

test("an empty projection never overwrites a known non-empty value", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "hello", lastAgentActivityAt: 111 });
	cache.remember("v1", { latestAssistantPreview: "", lastAgentActivityAt: null });
	const status = emptyStatus();
	assert.equal(cache.backfill("v1", status), true);
	assert.equal(status.latestAssistantPreview, "hello");
	assert.equal(status.lastAgentActivityAt, 111);
});

test("a newer non-empty value overwrites an older non-empty one", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "old", lastAgentActivityAt: 111 });
	cache.remember("v1", { latestAssistantPreview: "new", lastAgentActivityAt: 222 });
	const status = emptyStatus();
	cache.backfill("v1", status);
	assert.equal(status.latestAssistantPreview, "new");
	assert.equal(status.lastAgentActivityAt, 222);
});

test("backfill leaves non-empty disk values untouched (disk is authoritative)", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "cached", lastAgentActivityAt: 111 });
	const status = { latestAssistantPreview: "disk", lastAgentActivityAt: 999 };
	assert.equal(cache.backfill("v1", status), false);
	assert.equal(status.latestAssistantPreview, "disk");
	assert.equal(status.lastAgentActivityAt, 999);
});

test("backfill fills only the empty field of a mixed status", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "cached", lastAgentActivityAt: 111 });
	const status = { latestAssistantPreview: "disk", lastAgentActivityAt: null };
	assert.equal(cache.backfill("v1", status), true);
	assert.equal(status.latestAssistantPreview, "disk");
	assert.equal(status.lastAgentActivityAt, 111);
});

test("a fully empty projection creates no entry; unknown views are no-ops", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "", lastAgentActivityAt: null });
	assert.equal(cache.size(), 0);
	const status = emptyStatus();
	assert.equal(cache.backfill("v1", status), false);
	assert.equal(cache.backfill("nope", status), false);
});

test("views are independent; forget and clear remove entries", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "one", lastAgentActivityAt: 1 });
	cache.remember("v2", { latestAssistantPreview: "two", lastAgentActivityAt: 2 });
	assert.equal(cache.size(), 2);

	assert.equal(cache.forget("v1"), true);
	assert.equal(cache.forget("v1"), false);
	assert.equal(cache.size(), 1);
	const status = emptyStatus();
	assert.equal(cache.backfill("v1", status), false);
	assert.equal(cache.backfill("v2", status), true);

	cache.clear();
	assert.equal(cache.size(), 0);
	assert.equal(cache.backfill("v2", emptyStatus()), false);
});
