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

test("backfill fills an empty preview without touching a newer-or-equal status timestamp", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "cached", lastAgentActivityAt: 111 });
	const status = { latestAssistantPreview: "", lastAgentActivityAt: 999 };
	assert.equal(cache.backfill("v1", status), true);
	assert.equal(status.latestAssistantPreview, "cached");
	assert.equal(status.lastAgentActivityAt, 999);
});

test("a strictly newer cached entry adopts both fields over a stale rebuild", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "new", lastAgentActivityAt: 222 });
	const status = { latestAssistantPreview: "old", lastAgentActivityAt: 111 };
	assert.equal(cache.backfill("v1", status), true);
	assert.equal(status.latestAssistantPreview, "new");
	assert.equal(status.lastAgentActivityAt, 222);
});

test("a strictly newer cached entry adopts both fields when the rebuild has no timestamp", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "new", lastAgentActivityAt: 222 });
	const status = { latestAssistantPreview: "legacy text", lastAgentActivityAt: null };
	assert.equal(cache.backfill("v1", status), true);
	assert.equal(status.latestAssistantPreview, "new");
	assert.equal(status.lastAgentActivityAt, 222);
});

test("backfill leaves a strictly newer status value untouched (disk wins)", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "old", lastAgentActivityAt: 111 });
	const status = { latestAssistantPreview: "disk", lastAgentActivityAt: 222 };
	assert.equal(cache.backfill("v1", status), false);
	assert.equal(status.latestAssistantPreview, "disk");
	assert.equal(status.lastAgentActivityAt, 222);
});

test("remember with an older timestamp never degrades a newer entry", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "new", lastAgentActivityAt: 222 });
	// The stale agent_end rebuild projects the previous turn's values.
	cache.remember("v1", { latestAssistantPreview: "old", lastAgentActivityAt: 111 });
	const status = emptyStatus();
	cache.backfill("v1", status);
	assert.equal(status.latestAssistantPreview, "new");
	assert.equal(status.lastAgentActivityAt, 222);
});

test("a timestampless projection only fills gaps (never overwrites either field)", () => {
	const cache = createForegroundPreviewCache();
	cache.remember("v1", { latestAssistantPreview: "first", lastAgentActivityAt: null });
	cache.remember("v1", { latestAssistantPreview: "second", lastAgentActivityAt: null });
	const status = emptyStatus();
	assert.equal(cache.backfill("v1", status), true);
	assert.equal(status.latestAssistantPreview, "first");
	assert.equal(status.lastAgentActivityAt, null);
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
