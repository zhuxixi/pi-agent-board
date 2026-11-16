# Greeting-Aware Title Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session whose first message is a bare greeting gets its title generated from the first substantive user message (polled from the session JSONL) instead of being frozen as "Simple greeting".

**Architecture:** Pure classifier/resolver/projection functions in `src/core/title.mjs`; a new orchestration module `src/core/title-flow.mjs` with every effect injected; `runner/title-runner.mjs` becomes a thin shell that resolves env settings, early-exits on `off`, and wires real deps. `service.mjs` is untouched.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `assert/strict`, JSDoc types checked by `tsc --noEmit` (allowJs, checkJs off — JSDoc typedefs required for exported `.mjs` signatures).

**Spec:** `docs/superpowers/specs/2026-11-16-greeting-title-poll-design.md` (issue #295). Every task lists the acceptance IDs it implements. A1–A8 are automated; U1 is the post-merge manual check (Task 9).

## Global Constraints

- Tabs for indentation; English comments and commit messages; conventional commit subjects (`feat`/`fix`/`test`/`refactor`/`docs`), PR number appended as `(#N)` only at merge time — do not invent one.
- Never touch `src/runtime/service.mjs` (spec non-goal).
- Preserve the write-back guard semantics exactly: re-read meta, `meta.name !== config.fallbackName` → no write (manual rename wins, including during polling and during a pending one-shot).
- Preserve the last-line-only extraction: `out.trim().split("\n").slice(-1)[0]?.trim()`.
- The flow module (`title-flow.mjs`) must not read `process.env`; the shell must not regain decision logic (testability split is a hard constraint).
- No new env knobs; keep `AGENT_BOARD_TITLE_MODEL ?? AGENT_VIEW_TITLE_MODEL` precedence and `off` semantics verbatim.
- Do not `git add -A`; stage files explicitly.
- Work from: `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-295-greeting-title-poll` (all paths below are repo-relative).

---

### Task 1: Lift `contentText` into session-entries [A3]

**Files:**
- Modify: `src/core/session-entries.mjs`
- Modify: `src/core/session-view.mjs`
- Test: existing suite (no new tests; behavior must be identical)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function contentText(content)` in `src/core/session-entries.mjs` — `contentText(content: string|any[]|unknown): string`, returns trimmed text-block projection (verbatim from session-view).

- [ ] **Step 1: Move the function**

Cut this block from `src/core/session-view.mjs` (bottom of file):

```js
/**
 * Convert Pi message/content blocks to plain text.
 * @param {any} content
 * @returns {string}
 */
function contentText(content) {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n")
		.trim();
}
```

Paste it into `src/core/session-entries.mjs` with `export function contentText(content)` (same JSDoc, same body, unchanged). In `src/core/session-view.mjs`, extend the existing import:

```js
import { activeBranchEntries, contentText, parseSessionEntries } from "./session-entries.mjs";
```

- [ ] **Step 2: Run the affected suites**

Run: `node --test test/session-view.test.mjs test/service.test.mjs 2>&1 | tail -5` (use `ls test/ | grep -E 'session|title'` to pick the exact existing session-view test file name if different; if none exists, run `npm test`).
Expected: PASS (zero behavior change).

- [ ] **Step 3: Commit**

```bash
git add src/core/session-entries.mjs src/core/session-view.mjs
git commit -m "refactor: lift contentText into session-entries (issue #295)"
```

---

### Task 2: `isGreetingPrompt` classifier [A1]

**Files:**
- Modify: `src/core/title.mjs`
- Test: `test/title.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function isGreetingPrompt(text)` — `isGreetingPrompt(text: string|null|undefined): boolean`.

- [ ] **Step 1: Write the failing tests** (append to `test/title.test.mjs`; add `isGreetingPrompt` to the existing import from `../src/core/title.mjs`):

```js
test("isGreetingPrompt matches pure greetings", () => {
	const en = ["hello", "Hello!", "HI", "hey", "hiya", "yo", "sup", "howdy", "greetings", "morning",
		"good morning", "Good Morning!", "good afternoon", "good evening", "good day"];
	const zh = ["你好", "您好", "嗨", "哈喽", "哈啰", "在吗", "在么", "早上好", "上午好", "早安", "下午好", "晚上好", "晚安"];
	const variants = ["hello hello", "嗨嗨", "hi there", "你好呀", " hello? ", "hello!!!", "hello,hello", "hi呀"];
	for (const s of [...en, ...zh, ...variants]) assert.equal(isGreetingPrompt(s), true, s);
});

test("isGreetingPrompt rejects non-greetings", () => {
	const cases = ["hello, please fix X", "helloX", "你好请修复", "there", "呀", "there hello",
		"good", "fix the bug", "", " ", "hi, what is the cache hit rate for redis"];
	for (const s of cases) assert.equal(isGreetingPrompt(s), false, JSON.stringify(s));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/title.test.mjs`
Expected: FAIL — `isGreetingPrompt` is not exported.

- [ ] **Step 3: Implement** (append to `src/core/title.mjs`):

```js
/** Characters stripped from the edges of a message before greeting matching. */
const GREETING_EDGE_PUNCT = "！!？?。.,，、~～…;；:：";

/** Multi-word/multi-char greeting vocabulary (greedy longest-match units). */
const GREETINGS = [
	"good morning", "good afternoon", "good evening", "good day",
	"hello", "hi", "hey", "hiya", "yo", "sup", "howdy", "greetings", "morning",
	"你好", "您好", "嗨", "哈喽", "哈啰", "在吗", "在么",
	"早上好", "上午好", "早安", "下午好", "晚上好", "晚安",
];

/** Particles that may only appear after a greeting unit (suffix fillers). */
const GREETING_PARTICLES = ["there", "呀", "啊", "哦"];

const GREETING_SEPARATOR = new Set([" ", ...GREETING_EDGE_PUNCT.split("")]);

/**
 * True iff the ENTIRE message is greeting material: a greeting-first greedy
 * longest-match consume over the normalized string (issue #295). The first
 * consumed unit must be a GREETINGS entry; later units may be GREETINGS or
 * particles; adjacent duplicates need no separator.
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function isGreetingPrompt(text) {
	const normalized = String(text ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(new RegExp(`^[${escapeForCharClass(GREETING_EDGE_PUNCT)} ]+|[${escapeForCharClass(GREETING_EDGE_PUNCT)} ]+$`, "g"), "");
	if (!normalized) return false;
	let i = 0;
	let consumedGreeting = false;
	let first = true;
	while (i < normalized.length) {
		if (GREETING_SEPARATOR.has(normalized[i])) {
			i++;
			continue;
		}
		const unit = longestUnitAt(normalized, i, first);
		if (!unit) return false;
		if (unit.fromGreetings) consumedGreeting = true;
		first = false;
		i += unit.text.length;
	}
	return consumedGreeting;
}

/** @param {string} s @param {number} i @param {boolean} first */
function longestUnitAt(s, i, first) {
	const pool = first ? GREETINGS : [...GREETINGS, ...GREETING_PARTICLES];
	const sorted = [...pool].sort((a, b) => b.length - a.length);
	for (const candidate of sorted) {
		if (s.startsWith(candidate, i)) return { text: candidate, fromGreetings: GREETINGS.includes(candidate) };
	}
	return null;
}

/** @param {string} chars */
function escapeForCharClass(chars) {
	return chars.replace(/[\\\]^-]/g, "\\$&");
}
```

Note: sort inside `longestUnitAt` runs per position — fine at greeting lengths; if you prefer, precompute the sorted pools once at module level (recommended: `const GREETINGS_BY_LENGTH = [...]`, `const UNITS_BY_LENGTH = [...]`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/title.test.mjs`
Expected: PASS (all, including the pre-existing three tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/title.mjs test/title.test.mjs
git commit -m "feat: add isGreetingPrompt greeting classifier (issue #295)"
```

---

### Task 3: `resolveTitleSettings` env resolver [A5]

**Files:**
- Modify: `src/core/title.mjs`
- Test: `test/title.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_TITLE_MODEL`, `DEFAULT_TITLE_THINKING_LEVEL` (already in `title.mjs`).
- Produces: `export function resolveTitleSettings(env, configModel)` — `resolveTitleSettings(env: Record<string, string|undefined>, configModel: string|null|undefined): { enabled: boolean, model: string, thinking: string }`.

- [ ] **Step 1: Write the failing tests** (append; import `resolveTitleSettings`):

```js
test("resolveTitleSettings keeps env precedence and off semantics", () => {
	assert.deepEqual(resolveTitleSettings({}, null), { enabled: true, model: DEFAULT_TITLE_MODEL, thinking: DEFAULT_TITLE_THINKING_LEVEL });
	assert.equal(resolveTitleSettings({ AGENT_BOARD_TITLE_MODEL: "off" }, "x/y").enabled, false);
	assert.equal(resolveTitleSettings({ AGENT_VIEW_TITLE_MODEL: "off" }, null).enabled, false);
	assert.deepEqual(resolveTitleSettings({ AGENT_BOARD_TITLE_MODEL: "a/b", AGENT_VIEW_TITLE_MODEL: "c/d" }, null).model, "a/b");
	assert.deepEqual(resolveTitleSettings({ AGENT_VIEW_TITLE_MODEL: "c/d" }, null).model, "c/d");
	assert.deepEqual(resolveTitleSettings({ AGENT_VIEW_TITLE_MODEL: "c/d" }, "cfg/m").model, "cfg/m");
	assert.deepEqual(resolveTitleSettings({}, null).thinking, DEFAULT_TITLE_THINKING_LEVEL);
	assert.deepEqual(resolveTitleSettings({ AGENT_BOARD_TITLE_THINKING_LEVEL: "high" }, null).thinking, "high");
	assert.deepEqual(resolveTitleSettings({ AGENT_VIEW_TITLE_THINKING_LEVEL: "low" }, null).thinking, "low");
	assert.deepEqual(resolveTitleSettings({ AGENT_BOARD_TITLE_THINKING_LEVEL: "off" }, null).thinking, "off");
});
```

Add `DEFAULT_TITLE_MODEL`/`DEFAULT_TITLE_THINKING_LEVEL` to the import from `../src/core/title.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/title.test.mjs`
Expected: FAIL — `resolveTitleSettings` not exported.

- [ ] **Step 3: Implement** (append to `src/core/title.mjs`):

```js
/**
 * Resolve title-generation settings from env, preserving the runner's
 * historical precedence exactly (issue #295): board var wins over the legacy
 * view var; `off` disables even when a config model is set.
 * @param {Record<string, string|undefined>} env
 * @param {string|null|undefined} configModel
 * @returns {{ enabled: boolean, model: string, thinking: string }}
 */
export function resolveTitleSettings(env, configModel) {
	const configured = env.AGENT_BOARD_TITLE_MODEL ?? env.AGENT_VIEW_TITLE_MODEL;
	const thinking = env.AGENT_BOARD_TITLE_THINKING_LEVEL ?? env.AGENT_VIEW_TITLE_THINKING_LEVEL ?? DEFAULT_TITLE_THINKING_LEVEL;
	if (configured === "off") return { enabled: false, model: "", thinking };
	return { enabled: true, model: configModel ?? configured ?? DEFAULT_TITLE_MODEL, thinking };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/title.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/title.mjs test/title.test.mjs
git commit -m "feat: add resolveTitleSettings env resolver for titles (issue #295)"
```

---

### Task 4: `firstSubstantiveUserPrompt` projection [A2]

**Files:**
- Modify: `src/core/title.mjs` (add `import { activeBranchEntries, contentText, parseSessionEntries } from "./session-entries.mjs";` at top)
- Test: `test/title.test.mjs`

**Interfaces:**
- Consumes: `parseSessionEntries`, `activeBranchEntries`, `contentText` (Task 1), `isGreetingPrompt` (Task 2).
- Produces: `export function firstSubstantiveUserPrompt(sessionJsonlText)` — `firstSubstantiveUserPrompt(sessionJsonlText: string): string|null`.

- [ ] **Step 1: Write the failing tests** (append; import `firstSubstantiveUserPrompt`; local fixture builder):

```js
/** @param {{id: string, role: string, text: string, parentId?: string, contentKind?: string}[]} msgs */
function sessionJsonl(msgs) {
	const lines = [JSON.stringify({ type: "session", id: "s1", cwd: "/tmp" })];
	for (const m of msgs) {
		const content = m.contentKind === "tool_result"
			? [{ type: "tool_result", id: "tr", content: "ignored" }]
			: [{ type: "text", text: m.text }];
		lines.push(JSON.stringify({ type: "message", id: m.id, parentId: m.parentId ?? null, message: { role: m.role, content } }));
	}
	return lines.join("\n") + "\n";
}

test("firstSubstantiveUserPrompt picks the first substantive user message on the active branch", () => {
	const jsonl = sessionJsonl([
		{ id: "m1", role: "user", text: "hello", parentId: null },
		{ id: "m2", role: "assistant", text: "Hi!", parentId: "m1" },
		{ id: "m3", role: "user", text: "", contentKind: "tool_result", parentId: "m2" },
		{ id: "m4", role: "user", text: "deploy api", parentId: "m3" },
	]);
	assert.equal(firstSubstantiveUserPrompt(jsonl), "deploy api");
});

test("firstSubstantiveUserPrompt returns null when nothing substantive exists", () => {
	assert.equal(firstSubstantiveUserPrompt(sessionJsonl([{ id: "m1", role: "user", text: "hi", parentId: null }])), null);
	assert.equal(firstSubstantiveUserPrompt(""), null);
	assert.equal(firstSubstantiveUserPrompt("{}\n"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/title.test.mjs`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** (append to `src/core/title.mjs`):

```js
/**
 * First substantive (non-greeting, non-empty) user message on the active
 * branch of a session JSONL, or null (issue #295). Tool-result user entries
 * project to empty text and are skipped by contentText.
 * @param {string} sessionJsonlText
 * @returns {string|null}
 */
export function firstSubstantiveUserPrompt(sessionJsonlText) {
	const { entries, byId } = parseSessionEntries(sessionJsonlText);
	for (const entry of activeBranchEntries(entries, byId)) {
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const text = contentText(entry.message?.content);
		if (!text || isGreetingPrompt(text)) continue;
		return text;
	}
	return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/title.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/title.mjs test/title.test.mjs
git commit -m "feat: add firstSubstantiveUserPrompt session projection (issue #295)"
```

---

### Task 5: `runTitleFlow` orchestration [A4]

**Files:**
- Create: `src/core/title-flow.mjs`
- Test: `test/title-flow.test.mjs` (new)

**Interfaces:**
- Consumes: `isGreetingPrompt`, `firstSubstantiveUserPrompt`, `titlePrompt`, `normalizeGeneratedTitle` (all from `./title.mjs`).
- Produces:
  - `export const TITLE_POLL_INTERVAL_MS = 15_000;`
  - `export const TITLE_POLL_BUDGET_MS = 300_000;`
  - `export async function runTitleFlow(config, deps)` where `config` is `TitleConfig` (with optional `pollIntervalMs`/`pollBudgetMs`) and `deps = { now(): number, sleep(ms: number): Promise<void>, readMeta(root: string, viewId: string): any|null, commitMeta(meta: any): void, readSessionText(config: any): string|null, runOneShot(prompt: string): Promise<string|null> }`.

- [ ] **Step 1: Write the failing tests** (`test/title-flow.test.mjs`, new file):

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/title-flow.test.mjs`
Expected: FAIL — module not found.

**Binding seam decision:** `deps.runOneShot(prompt)` receives the **raw user prompt**; `titlePrompt()` wrapping happens in the shell's real wiring (Task 6). The flow module does not import `titlePrompt`.

- [ ] **Step 3: Implement `src/core/title-flow.mjs`** (new file):

```js
/**
 * Title-generation orchestration with fully injected effects (issue #295).
 * The runner shell owns env resolution and real I/O; this module owns
 * sequencing and the write-back guard so it is unit-testable with a fake clock.
 */
import { firstSubstantiveUserPrompt, isGreetingPrompt, normalizeGeneratedTitle } from "./title.mjs";

/** Default poll interval while waiting for a substantive user message. */
export const TITLE_POLL_INTERVAL_MS = 15_000;

/** Default total budget for the greeting poll loop. */
export const TITLE_POLL_BUDGET_MS = 300_000;

/**
 * @typedef {Object} TitleFlowDeps
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(root: string, viewId: string) => any|null} readMeta
 * @property {(meta: any) => void} commitMeta
 * @property {(config: any) => string|null} readSessionText
 * @property {(prompt: string) => Promise<string|null>} runOneShot
 */

/**
 * Generate a title for a view. Non-greeting prompts generate immediately
 * (today's behavior). Greeting prompts poll the session file for the first
 * substantive user message until the budget runs out, then exit quietly.
 * @param {import("./types.mjs").TitleConfig} config
 * @param {TitleFlowDeps} deps
 */
export async function runTitleFlow(config, deps) {
	if (!isGreetingPrompt(config.prompt)) {
		await generateOnce(config, deps, config.prompt);
		return;
	}
	const interval = config.pollIntervalMs ?? TITLE_POLL_INTERVAL_MS;
	const deadline = deps.now() + (config.pollBudgetMs ?? TITLE_POLL_BUDGET_MS);
	while (deps.now() < deadline) {
		await deps.sleep(interval);
		const text = deps.readSessionText(config);
		const prompt = text ? firstSubstantiveUserPrompt(text) : null;
		if (prompt) {
			await generateOnce(config, deps, prompt);
			return;
		}
	}
}

/**
 * One guarded title generation: last-line extraction, normalize, fallback-only
 * write (manual renames always win — meta is re-read right before the guard).
 * @param {import("./types.mjs").TitleConfig} config
 * @param {TitleFlowDeps} deps
 * @param {string} prompt
 */
async function generateOnce(config, deps, prompt) {
	const out = await deps.runOneShot(prompt);
	const last = out?.trim().split("\n").slice(-1)[0]?.trim() ?? "";
	const title = normalizeGeneratedTitle(last, config.fallbackName);
	if (!title || title === config.fallbackName) return;
	const meta = deps.readMeta(config.root, config.viewId);
	if (!meta) return;
	if (meta.name !== config.fallbackName) return;
	meta.name = title;
	deps.commitMeta(meta);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/title-flow.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/title-flow.mjs test/title-flow.test.mjs
git commit -m "feat: add greeting-aware title flow with injected effects (issue #295)"
```

---

### Task 6: Runner shell rewiring + hermetic smoke [A6]

**Files:**
- Modify: `runner/title-runner.mjs`
- Modify: `src/core/types.mjs` (TitleConfig JSDoc: optional `pollIntervalMs`/`pollBudgetMs`)
- Create: `test-support/fake-title-pi.mjs`
- Create: `test/title-runner-smoke.test.mjs`

**Interfaces:**
- Consumes: `runTitleFlow` (+constants) from `../src/core/title-flow.mjs`; `resolveTitleSettings`, `titlePrompt` from `../src/core/title.mjs`; `readMeta`/`writeMeta` from `../src/core/store.mjs`.
- Produces: `TitleConfig` gains `pollIntervalMs?: number` and `pollBudgetMs?: number` (JSDoc, optional, test-only setters — service never sets them).

- [ ] **Step 1: Create the fixture `test-support/fake-title-pi.mjs`**

```js
#!/usr/bin/env node
/**
 * Hermetic stand-in for `pi --mode json -p` in title-runner smoke tests
 * (issue #295). Prints one assistant message_end whose text echoes the task
 * from the titlePrompt payload ("T: <task>"), writes a marker file when
 * invoked, then exits 0.
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const taskIdx = argv.lastIndexOf("--");
const payload = argv[argv.length - 1] ?? "";
const match = /Task: (.*)$/m.exec(payload);
const task = match ? match[1].trim() : "unknown";
if (process.env.FAKE_TITLE_PI_MARKER) {
	try { appendFileSync(process.env.FAKE_TITLE_PI_MARKER, "called\n"); } catch { /* best effort */ }
}
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `T: ${task}` }] } }));
```

(`taskIdx` is unused — drop that line.)

- [ ] **Step 2: Write the failing smoke tests `test/title-runner-smoke.test.mjs`**

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import { metaPath, sessionFilePath, titleConfigPath, viewDir } from "../src/core/paths.mjs";

const ROOT_DIR = join(import.meta.dirname, "..");
const RUNNER = join(ROOT_DIR, "runner", "title-runner.mjs");
const FAKE_PI = join(ROOT_DIR, "test-support", "fake-title-pi.mjs");

function freshRoot() { return mkdtempSync(join(tmpdir(), "agentview-title-smoke-")); }

function seedView(root, { prompt, name, sessionLines, extra = {} }) {
	const viewId = "view_smoke";
	mkdirSync(viewDir(root, viewId), { recursive: true });
	writeFileSync(metaPath(root, viewId), JSON.stringify({ id: viewId, name, cwd: root, sessionFile: sessionFilePath(root, viewId) }));
	if (sessionLines) {
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(sessionFilePath(root, viewId), sessionLines);
	}
	atomicWriteJson(titleConfigPath(root, viewId), {
		root, viewId, cwd: root, prompt, fallbackName: name,
		piCommand: process.execPath, piArgsPrefix: [FAKE_PI], model: null, ...extra,
	});
	return viewId;
}

function runRunner(root, viewId, env = {}) {
	return spawnSync(process.execPath, [RUNNER, titleConfigPath(root, viewId)], {
		env: { ...process.env, FAKE_TITLE_PI_MARKER: join(root, "marker"), ...env },
		timeout: 20000,
	});
}

const substantiveJsonl = [
	JSON.stringify({ type: "session", id: "s", cwd: "/r" }),
	JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
	JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "user", content: [{ type: "text", text: "deploy api" }] } }),
].join("\n") + "\n";

test("A6① non-greeting prompt generates immediately via the real runner", () => {
	const root = freshRoot();
	try {
		const viewId = seedView(root, { prompt: "fix bug now", name: "fix-bug-now" });
		const res = runRunner(root, viewId);
		assert.equal(res.status, 0);
		const meta = JSON.parse(readFileSync(metaPath(root, viewId), "utf8"));
		assert.equal(meta.name, "T: fix bug now");
		assert.ok(existsSync(join(root, "marker")));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("A6② greeting prompt polls and titles from the substantive message", () => {
	const root = freshRoot();
	try {
		const viewId = seedView(root, { prompt: "hello", name: "slug-name", sessionLines: substantiveJsonl, extra: { pollIntervalMs: 50, pollBudgetMs: 5000 } });
		const res = runRunner(root, viewId);
		assert.equal(res.status, 0);
		const meta = JSON.parse(readFileSync(metaPath(root, viewId), "utf8"));
		assert.equal(meta.name, "T: deploy api");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("A6③ off (board and legacy) exits without model call or rename", () => {
	for (const env of [{ AGENT_BOARD_TITLE_MODEL: "off" }, { AGENT_VIEW_TITLE_MODEL: "off" }]) {
		const root = freshRoot();
		try {
			const viewId = seedView(root, { prompt: "fix bug now", name: "keep-me" });
			const res = runRunner(root, viewId, env);
			assert.equal(res.status, 0);
			const meta = JSON.parse(readFileSync(metaPath(root, viewId), "utf8"));
			assert.equal(meta.name, "keep-me");
			assert.equal(existsSync(join(root, "marker")), false, JSON.stringify(env));
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});
```

- [ ] **Step 3: Run to verify A6② fails on the old runner**

Run: `node --test test/title-runner-smoke.test.mjs`
Expected: A6① and A6③ PASS; **A6② FAIL** — the old runner titles the greeting itself (`meta.name === "T: hello"`).

- [ ] **Step 4: Rewire `runner/title-runner.mjs`**

Replace the body (keep the header comment, update it to mention the greeting poll) with:

```js
#!/usr/bin/env node
/**
 * Detached title-runner shim (issue #295): non-greeting prompts generate a
 * title immediately (previous behavior); greeting prompts poll the session
 * file for the first substantive user message. Best-effort only — the manual
 * rename always wins. All orchestration lives in src/core/title-flow.mjs.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readJson } from "../src/core/atomic.mjs";
import { readMeta, writeMeta } from "../src/core/store.mjs";
import { runTitleFlow } from "../src/core/title-flow.mjs";
import { resolveTitleSettings, titlePrompt } from "../src/core/title.mjs";

function main() {
	const configPath = process.argv[2];
	if (!configPath) process.exit(2);
	/** @type {import("../src/core/types.mjs").TitleConfig|null} */
	const config = readJson(configPath, null);
	if (!config?.viewId || !config.prompt) process.exit(2);

	const settings = resolveTitleSettings(process.env, config.model);
	if (!settings.enabled) return;

	runTitleFlow(config, realDeps(config, settings))
		.catch(() => {})
		.finally(() => process.exit(0));
}

/**
 * @param {import("../src/core/types.mjs").TitleConfig} config
 * @param {{ enabled: boolean, model: string, thinking: string }} settings
 */
function realDeps(config, settings) {
	return {
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		readMeta: (root, viewId) => readMeta(root, viewId),
		commitMeta: (meta) => writeMeta(config.root, meta),
		readSessionText: () => {
			const meta = readMeta(config.root, config.viewId);
			if (!meta?.sessionFile) return null;
			return existsSync(meta.sessionFile) ? readFileSync(meta.sessionFile, "utf8") : null;
		},
		runOneShot: (prompt) => {
			const args = [...(config.piArgsPrefix ?? []), "--mode", "json", "-p", "--no-session", "--model", settings.model];
			if (settings.thinking && settings.thinking !== "off") args.push("--thinking", settings.thinking);
			args.push(titlePrompt(prompt));
			return runOneShot(config.piCommand, args, 15000);
		},
	};
}

function runOneShot(command, args, timeoutMs = 20000) {
	// … keep the existing implementation verbatim (spawn, JSON line scan, timeout) …
}

main();
```

Keep the existing `runOneShot` function exactly as it is today. Delete the old `maybeGenerateTitle`. Also update `src/core/types.mjs` `TitleConfig` JSDoc: add

```js
	 * Optional poll tuning for tests; production never sets these (issue #295).
	 * @property {number} [pollIntervalMs]
	 * @property {number} [pollBudgetMs]
```

inside the existing `@typedef {Object} TitleConfig` block.

- [ ] **Step 5: Run all title tests**

Run: `node --test test/title.test.mjs test/title-flow.test.mjs test/title-runner-smoke.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add runner/title-runner.mjs src/core/types.mjs test-support/fake-title-pi.mjs test/title-runner-smoke.test.mjs
git commit -m "feat: greeting-aware title runner with hermetic smoke tests (issue #295)"
```

---

### Task 7: Full verification [A7, A8]

**Files:** none (verification only; fix fallout if any)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors. If TS complains about the new `.mjs` exports (allowJs inference), add JSDoc `@typedef`/`@param` annotations per the existing files' style (known repo gotcha: `.mjs` option-object params only infer destructured-with-default properties — annotate explicitly).

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: all green (includes the new files and every pre-existing test).

- [ ] **Step 3: Verify gate (worktree has node_modules symlinked to the main checkout)**

Run: `npm run verify`
Expected: typecheck + perf gate + tests + coverage (lines 85 / funcs 80 / branches 70) + pack:dry all pass. If coverage dips on new branches, add cases in the existing new test files (not new files).

- [ ] **Step 4: Commit any fixes** (conventional subject, e.g. `fix: ...` or `test: ...`).

---

### Task 8 (post-merge, user-executed): U1 manual verification [U1]

Not implementable in the worktree — U1 verifies the deployed checkout. When the PR is merged:

1. `git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board pull --ff-only` (the checkout Pi actually loads; record SHA).
2. Fully exit and restart Pi.
3. Title-model health check: `pi --mode json -p --no-session --model openai-codex/gpt-5.5 'Reply with: ok'` → exit 0, assistant `message_end`, then `agent_end`, no auth errors.
4. The four U1 scenarios from the spec (greeting→substantive→~30s title; immediate non-greeting; rename-during-window wins; greeting-only keeps slug).

Record results back on issue #295.

---

## Acceptance ↔ Task traceability

| ID | Task(s) |
|---|---|
| A1 | Task 2 |
| A2 | Task 4 |
| A3 | Task 1 |
| A4 | Task 5 |
| A5 | Task 3 |
| A6 | Task 6 |
| A7 | Task 7 |
| A8 | Task 7 |
| U1 | Task 8 (post-merge) |
