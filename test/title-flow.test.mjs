import assert from "node:assert/strict";
import { test } from "node:test";
import { runTitleFlow, TITLE_POLL_INTERVAL_MS, TITLE_POLL_BUDGET_MS } from "../src/core/title-flow.mjs";

const baseConfig = () => ({ root: "/r", viewId: "v1", cwd: "/r", prompt: "hello", fallbackName: "slug-name", piCommand: "pi", piArgsPrefix: [], model: null });

/** Deterministic deps: clock advances only via sleep; meta lives in a store. */
function makeDeps(overrides = {}) {
	const state = { now: 0, meta: { id: "v1", name: "slug-name" }, sessionText: null, oneShotImpl: null, sleeps: 0 };
	const pending = [];
	const deps = {
		now: () => state.now,
		sleep: async (ms) => { state.now += ms; state.sleeps++; },
		readMeta: () => (state.meta ? { ...state.meta } : null),
		commitMeta: (meta) => { state.meta = { ...meta }; state.committed = meta.name; },
		readSessionText: () => state.sessionText,
		runOneShot: (prompt) => {
			state.prompts = [...(state.prompts ?? []), prompt];
			if (state.oneShotImpl) return state.oneShotImpl(prompt);
			return Promise.resolve("Generated Title");
		},
		...overrides,
	};
	return { deps, state };
}

test("A4① greeting → poll hit → generates from substantive message and commits", async () => {
	const { deps, state } = makeDeps();
	// substantive message appears before the first tick
	deps.readSessionText = () => '{"type":"session","id":"s","cwd":"/r"}\n' +
		'{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n' +
		'{"type":"message","id":"m2","parentId":"m1","message":{"role":"user","content":[{"type":"text","text":"deploy api"}]}}\n';
	await runTitleFlow(baseConfig(), deps);
	assert.equal(state.prompts?.[0], "deploy api");
	assert.equal(state.meta.name, "Generated Title");
});

test("A4② manual rename during polling wins", async () => {
	const { deps, state } = makeDeps();
	let ticks = 0;
	deps.sleep = async (ms) => { state.now += ms; ticks++; if (ticks === 1) state.meta.name = "My Own Name"; };
	deps.readSessionText = () => '{"type":"message","id":"m2","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"deploy api"}]}}\n';
	await runTitleFlow(baseConfig(), deps);
	assert.equal(state.committed, undefined);
	assert.equal(state.meta.name, "My Own Name");
});

test("A4③ budget exhausted → no model call, no commit, quiet return", async () => {
	const { deps, state } = makeDeps();
	state.sessionText = null;
	const cfg = { ...baseConfig(), pollIntervalMs: 100, pollBudgetMs: 250 };
	await runTitleFlow(cfg, deps);
	assert.equal(state.sleeps, 3); // ticks at 100/200/(250 stop) — 3 sleeps before deadline check fails
	assert.equal(state.prompts, undefined);
	assert.equal(state.committed, undefined);
});

test("A4④ non-greeting → immediate generation, no polling", async () => {
	const { deps, state } = makeDeps();
	await runTitleFlow({ ...baseConfig(), prompt: "fix bug now" }, deps);
	assert.equal(state.sleeps, 0);
	assert.equal(state.prompts?.[0], "fix bug now");
	assert.equal(state.meta.name, "Generated Title");
});

test("A4⑤ empty / null / fallback-equal one-shot output → no commit", async () => {
	for (const out of ["", null, "slug-name"]) {
		const { deps, state } = makeDeps();
		state.oneShotImpl = () => Promise.resolve(out);
		await runTitleFlow({ ...baseConfig(), prompt: "fix bug now" }, deps);
		assert.equal(state.committed, undefined, `out=${JSON.stringify(out)}`);
	}
});

test("A4⑥ readMeta null at write time → no commit", async () => {
	const { deps, state } = makeDeps();
	state.meta = null;
	await runTitleFlow({ ...baseConfig(), prompt: "fix bug now" }, deps);
	assert.equal(state.committed, undefined);
});

test("A4⑦ manual rename while one-shot pending still wins", async () => {
	const { deps, state } = makeDeps();
	let release;
	state.oneShotImpl = () => new Promise((resolve) => { release = () => resolve("Late Title"); });
	const flowing = runTitleFlow({ ...baseConfig(), prompt: "fix bug now" }, deps);
	await new Promise((r) => setTimeout(r, 0));
	state.meta.name = "Renamed Mid Flight";
	release();
	await flowing;
	assert.equal(state.committed, undefined);
	assert.equal(state.meta.name, "Renamed Mid Flight");
});

test("A4⑧ runOneShot rejection propagates out of the flow", async () => {
	const { deps, state } = makeDeps();
	state.oneShotImpl = () => Promise.reject(new Error("spawn fail"));
	await assert.rejects(() => runTitleFlow({ ...baseConfig(), prompt: "fix bug now" }, deps), /spawn fail/);
	assert.equal(state.committed, undefined);
});

test("A4⑨ multiline one-shot output uses only the last line (both paths)", async () => {
	{
		const { deps, state } = makeDeps();
		state.oneShotImpl = () => Promise.resolve("Thinking…\nLast Line Wins");
		await runTitleFlow({ ...baseConfig(), prompt: "fix bug now" }, deps);
		assert.equal(state.meta.name, "Last Line Wins");
	}
	{
		const { deps, state } = makeDeps();
		state.oneShotImpl = () => Promise.resolve("Thinking…\nLast Line Wins");
		deps.readSessionText = () => '{"type":"message","id":"m2","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"deploy api"}]}}\n';
		await runTitleFlow(baseConfig(), deps);
		assert.equal(state.meta.name, "Last Line Wins");
	}
});

test("poll constants match the spec", () => {
	assert.equal(TITLE_POLL_INTERVAL_MS, 15000);
	assert.equal(TITLE_POLL_BUDGET_MS, 300000);
});
