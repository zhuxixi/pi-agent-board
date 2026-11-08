import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLaunchModelPrefs } from "../src/core/session-launch-prefs.mjs";

const line = (obj) => JSON.stringify(obj);
const D = { model: "prov/default-a", thinkingLevel: "high" };
const prefs = (text, defaults = D) => resolveLaunchModelPrefs(defaults, text);

// Decision-table row 1: no message entries at all → pass defaults.
test("missing/empty/garbage/header-only text passes defaults through", () => {
	for (const text of [null, "", "{ broken", line({ type: "session", id: "s", cwd: "/r" })]) {
		const r = prefs(text);
		assert.deepEqual(r, { model: "prov/default-a", thinkingLevel: "high", droppedModel: false, droppedThinking: false }, `text=${String(text)}`);
	}
});

// Row 3: messages exist but nothing restorable for model.
test("user-only session passes model and thinking defaults", () => {
	const text = [
		line({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }),
	].join("\n");
	const r = prefs(text);
	assert.equal(r.model, "prov/default-a");
	assert.equal(r.thinkingLevel, "high");
	assert.equal(r.droppedModel, false);
});

// Row 2: assistant message restores the model.
test("assistant message without model_change drops model but keeps thinking default", () => {
	const text = [
		line({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: "yo" } }),
	].join("\n");
	const r = prefs(text);
	assert.deepEqual(r, { model: null, thinkingLevel: "high", droppedModel: true, droppedThinking: false });
});

// Row 2: model_change restores the model (pi writes both at session creation).
test("model_change + message drops model", () => {
	const text = [
		line({ type: "model_change", id: "e1", parentId: null, provider: "prov", modelId: "picked-b" }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "hi" } }),
	].join("\n");
	const r = prefs(text);
	assert.equal(r.model, null);
	assert.equal(r.droppedModel, true);
});

// Row 3: model_change with zero messages is NOT restorable (pi gate: hasExistingSession).
test("model_change without any message entry passes model through", () => {
	const text = [line({ type: "model_change", id: "e1", parentId: null, provider: "prov", modelId: "picked-b" })].join("\n");
	const r = prefs(text);
	assert.equal(r.model, "prov/default-a");
	assert.equal(r.droppedModel, false);
});

// Thinking dimension is independent.
test("thinking_level_change + message drops thinking only", () => {
	const text = [
		line({ type: "thinking_level_change", id: "e1", parentId: null, thinkingLevel: "medium" }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "hi" } }),
	].join("\n");
	const r = prefs(text);
	assert.deepEqual(r, { model: "prov/default-a", thinkingLevel: null, droppedModel: false, droppedThinking: true });
});

test("thinking_level_change without messages passes thinking through", () => {
	const text = [line({ type: "thinking_level_change", id: "e1", parentId: null, thinkingLevel: "medium" })].join("\n");
	const r = prefs(text);
	assert.equal(r.thinkingLevel, "high");
	assert.equal(r.droppedThinking, false);
});

// Row 2+4 mixed: both dropped.
test("model_change + thinking entry + messages drops both", () => {
	const text = [
		line({ type: "thinking_level_change", id: "e1", parentId: null, thinkingLevel: "medium" }),
		line({ type: "model_change", id: "e2", parentId: "e1", provider: "prov", modelId: "picked-b" }),
		line({ type: "message", id: "e3", parentId: "e2", message: { role: "user", content: "hi" } }),
	].join("\n");
	const r = prefs(text);
	assert.deepEqual(r, { model: null, thinkingLevel: null, droppedModel: true, droppedThinking: true });
});

// Defaults already null stay null with honest dropped flags.
test("null defaults + restorable session returns nulls without dropped flags", () => {
	const text = [
		line({ type: "model_change", id: "e1", parentId: null, provider: "prov", modelId: "picked-b" }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: "yo" } }),
	].join("\n");
	const r = prefs(text, { model: null, thinkingLevel: null });
	assert.deepEqual(r, { model: null, thinkingLevel: null, droppedModel: false, droppedThinking: false });
});

// Branch semantics: an abandoned sibling's model_change must not trigger a drop.
test("forked tree: abandoned branch model_change does not drop; active chain does", () => {
	const abandoned = [
		line({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }),
		line({ type: "model_change", id: "e2b", parentId: "e1", provider: "prov", modelId: "abandoned" }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "again" } }),
		line({ type: "message", id: "e3", parentId: "e2", message: { role: "user", content: "more" } }),
	].join("\n");
	assert.equal(prefs(abandoned).model, "prov/default-a", "user-only active chain: nothing restorable");
	const active = [
		line({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "again" } }),
		line({ type: "model_change", id: "e2b", parentId: "e1", provider: "prov", modelId: "abandoned" }),
		line({ type: "message", id: "e3", parentId: "e2", message: { role: "assistant", content: "yo" } }),
	].join("\n");
	assert.equal(prefs(active).model, null, "active chain reaches an assistant message → restorable");
});
