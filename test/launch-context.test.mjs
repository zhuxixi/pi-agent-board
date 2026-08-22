import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	canonicalModelRef,
	clampThinkingLevel,
	isThinkingLevel,
	listDirectorySuggestions,
	resolveDirectoryValue,
	resolveLaunchContext,
	sameModel,
	supportedThinkingLevels,
	THINKING_LEVELS,
} from "../src/core/launch-options.mjs";

/** @type {import("../src/core/launch-options.mjs").LaunchModelLike[]} */
const MODELS = [
	{ provider: "openai", id: "gpt-5-20250801", name: "GPT-5", reasoning: true },
	{ provider: "openai", id: "gpt-5-mini-latest", name: "GPT-5 mini", reasoning: true },
	{ provider: "anthropic", id: "opus-4-20250601", name: "Opus 4", reasoning: true },
	{ provider: "google", id: "flash", name: "Flash", reasoning: false },
];

/** Mock SettingsManager.create to return preset settings. */
function mockSettings(t, { enabledModels, defaultThinking } = {}) {
	const fake = {
		getEnabledModels: () => enabledModels,
		getDefaultThinkingLevel: () => defaultThinking,
	};
	t.mock.method(SettingsManager, "create", () => fake);
	return fake;
}

test("isThinkingLevel accepts only the seven documented levels", () => {
	for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
	assert.equal(isThinkingLevel("bogus"), false);
	assert.equal(isThinkingLevel(3), false);
	assert.equal(isThinkingLevel(""), false);
});

test("canonicalModelRef and sameModel compare provider/id identity", () => {
	assert.equal(canonicalModelRef(MODELS[0]), "openai/gpt-5-20250801");
	assert.equal(canonicalModelRef(null), "");
	assert.equal(sameModel(MODELS[0], { provider: "openai", id: "gpt-5-20250801" }), true);
	assert.equal(sameModel(MODELS[0], { provider: "openai", id: "other" }), false);
	assert.equal(sameModel(MODELS[0], null), false);
});

test("supportedThinkingLevels respects reasoning and per-level map", () => {
	assert.deepEqual(supportedThinkingLevels(MODELS[3]), ["off"], "non-reasoning models only support off");
	assert.deepEqual(supportedThinkingLevels(MODELS[0]), [...THINKING_LEVELS], "reasoning without a map supports all levels");
	const mapped = { ...MODELS[0], thinkingLevelMap: { off: null, low: "x", high: null } };
	assert.deepEqual(supportedThinkingLevels(mapped), ["minimal", "low", "medium", "xhigh", "max"]);
	assert.deepEqual(supportedThinkingLevels(null), ["off"]);
});

test("clampThinkingLevel falls back when the requested level is unsupported", () => {
	assert.equal(clampThinkingLevel(MODELS[0], "high"), "high");
	assert.equal(clampThinkingLevel(MODELS[3], "high"), "off", "non-reasoning model clamps to off");
	assert.equal(clampThinkingLevel(MODELS[0], undefined, "low"), "low", "missing request uses the fallback");
	const noHigh = { ...MODELS[0], thinkingLevelMap: { high: null } };
	assert.equal(clampThinkingLevel(noHigh, "high", "medium"), "medium", "unsupported request uses a supported fallback");
	const noHighNoMedium = { ...MODELS[0], thinkingLevelMap: { high: null, medium: null } };
	assert.equal(clampThinkingLevel(noHighNoMedium, "high", "medium"), "off", "unsupported fallback drops to first supported level");
	assert.equal(clampThinkingLevel(null, "high", "low"), "off");
});

test("resolveLaunchContext falls back to all models when no scoped patterns are set", (t) => {
	mockSettings(t, { enabledModels: undefined, defaultThinking: "medium" });
	const ctx = resolveLaunchContext("/tmp", MODELS, null, null);
	assert.equal(ctx.scopeSource, "all");
	assert.equal(ctx.choices.length, MODELS.length);
	assert.equal(ctx.thinking, "medium");
});

test("resolveLaunchContext sorts the preferred model first and applies preferred thinking", (t) => {
	mockSettings(t, { enabledModels: undefined, defaultThinking: "medium" });
	const ctx = resolveLaunchContext("/tmp", MODELS, MODELS[2], "high");
	assert.equal(ctx.scopeSource, "all");
	assert.equal(canonicalModelRef(ctx.choices[0].model), "anthropic/opus-4-20250601");
	assert.equal(canonicalModelRef(ctx.selectedModel), "anthropic/opus-4-20250601");
	assert.equal(ctx.thinking, "high");
	assert.deepEqual(ctx.thinkingOptions, [...THINKING_LEVELS]);
});

test("resolveLaunchContext resolves exact scoped patterns", (t) => {
	mockSettings(t, { enabledModels: ["openai/gpt-5-20250801"], defaultThinking: "medium" });
	const ctx = resolveLaunchContext("/tmp", MODELS, null, null);
	assert.equal(ctx.scopeSource, "scoped");
	assert.equal(ctx.choices.length, 1);
	assert.equal(canonicalModelRef(ctx.choices[0].model), "openai/gpt-5-20250801");
});

test("resolveLaunchContext resolves scoped patterns with a thinking suffix", (t) => {
	mockSettings(t, { enabledModels: ["openai/gpt-5-20250801:high"], defaultThinking: "medium" });
	const ctx = resolveLaunchContext("/tmp", MODELS, null, null);
	assert.equal(ctx.scopeSource, "scoped");
	assert.equal(ctx.choices[0].thinkingLevel, "high");
	// Known edge: when no preferred model is supplied, the selected choice is the
	// first scoped entry but its thinking suffix is not promoted into `thinking` —
	// the default level wins. Dashboard callers always pass a preferred model
	// (currentModel fallback), so this path is an edge case, locked as-is.
	assert.equal(ctx.thinking, "medium");
});

test("resolveLaunchContext resolves glob scoped patterns across provider/id", (t) => {
	mockSettings(t, { enabledModels: ["openai/*"], defaultThinking: "off" });
	const ctx = resolveLaunchContext("/tmp", MODELS, null, null);
	assert.equal(ctx.scopeSource, "scoped");
	assert.deepEqual(
		ctx.choices.map((c) => canonicalModelRef(c.model)).sort(),
		["openai/gpt-5-20250801", "openai/gpt-5-mini-latest"],
	);
});

test("resolveLaunchContext dedups overlapping patterns and prefers aliases", (t) => {
	mockSettings(t, { enabledModels: ["gpt-5-mini", "gpt-5-mini"], defaultThinking: "off" });
	const ctx = resolveLaunchContext("/tmp", MODELS, null, null);
	assert.equal(ctx.scopeSource, "scoped");
	assert.equal(ctx.choices.length, 1, "duplicate pattern must not duplicate the choice");
	assert.equal(canonicalModelRef(ctx.choices[0].model), "openai/gpt-5-mini-latest", "alias id wins over dated id");
});

test("resolveLaunchContext falls back to all models when no scoped pattern matches", (t) => {
	mockSettings(t, { enabledModels: ["mystery/x-20240101"], defaultThinking: "off" });
	const ctx = resolveLaunchContext("/tmp", MODELS, null, null);
	assert.equal(ctx.scopeSource, "all");
	assert.equal(ctx.choices.length, MODELS.length);
});

test("resolveLaunchContext tolerates invalid glob patterns", (t) => {
	// "[z-a]" is an invalid character range — matchGlob must swallow the regex
	// error instead of throwing.
	mockSettings(t, { enabledModels: ["[z-a]"], defaultThinking: "off" });
	const ctx = resolveLaunchContext("/tmp", MODELS, null, null);
	assert.equal(ctx.scopeSource, "all");
});

test("resolveLaunchContext survives ambiguous duplicate model references", (t) => {
	const dup = [...MODELS, { ...MODELS[0] }];
	mockSettings(t, { enabledModels: ["openai/gpt-5-20250801"], defaultThinking: "off" });
	const ctx = resolveLaunchContext("/tmp", dup, null, null);
	// A canonical reference that matches two identical models is treated as
	// ambiguous and conservatively falls back to the full model list.
	assert.equal(ctx.scopeSource, "all");
	assert.equal(ctx.choices.length, dup.length);
});

test("resolveDirectoryValue resolves absolute, relative, and home paths", (t) => {
	const root = mkdtempSync(join(tmpdir(), "launch-dir-"));
	try {
		mkdirSync(join(root, "sub"));
		const sub = join(root, "sub");
		assert.equal(resolveDirectoryValue(sub, root), sub);
		assert.equal(resolveDirectoryValue("sub", root), sub);
		assert.equal(resolveDirectoryValue("", root), root);
		assert.equal(resolveDirectoryValue("missing", root), null);
		assert.equal(resolveDirectoryValue("/definitely/not/here", root), null);
		// ~ expansion (HOME is always set in the test environment).
		const prevHome = process.env.HOME;
		try {
			process.env.HOME = root;
			assert.equal(resolveDirectoryValue("~/sub", "/elsewhere"), sub);
			assert.equal(resolveDirectoryValue("~", "/elsewhere"), root);
		} finally {
			process.env.HOME = prevHome;
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveDirectoryValue returns null when baseCwd itself does not exist", () => {
	assert.equal(resolveDirectoryValue("", "/definitely/not/here"), null);
});

test("listDirectorySuggestions lists children and matches fragments", () => {
	const root = mkdtempSync(join(tmpdir(), "launch-sugg-"));
	try {
		mkdirSync(join(root, "alpha"));
		mkdirSync(join(root, "beta"));
		writeFileSync(join(root, "not-a-dir.txt"), "x");
		const empty = listDirectorySuggestions("", root);
		assert.equal(empty[0], root);
		assert.deepEqual(empty.slice(1), [join(root, "alpha"), join(root, "beta")]);
		assert.equal(empty.includes(join(root, "not-a-dir.txt")), false, "files are excluded");

		const fragment = listDirectorySuggestions("alp", root);
		assert.deepEqual(fragment, [join(root, "alpha")]);

		const missing = listDirectorySuggestions("no-such", root);
		assert.equal(missing.length, 0);

		const limited = listDirectorySuggestions("", root, 2);
		assert.equal(limited.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
