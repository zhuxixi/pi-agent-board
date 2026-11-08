# Host Restart Model Override Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop passing `--model`/`--thinking` to child pi when the session can restore them itself, so host restarts no longer reset in-session `/model` and `/thinking` choices (issue #286).

**Architecture:** Two new pure core modules — `session-entries.mjs` (JSONL parse + active-branch walk, extracted from `session-view.mjs` as the single branch-semantics source) and `session-launch-prefs.mjs` (restore-ability policy). `service.mjs` gains one thin I/O helper that reads the session file and applies the policy; the three spawn paths (`launchForView`, `startHostUnderLease`, `adoptClaimedHost`) and the issue-#90 guard switch from `meta.defaultModel` to the resolved effective values. Runners are untouched (their `if (config.model)` argv assembly already skips null).

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `assert/strict`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-08-host-restart-model-override-design.md` (v2). The decision table (§1.1), guard semantics (§1.2), and acceptance IDs live there; every task below cites its acceptance IDs.

## Global Constraints

- Tabs for indentation; English comments and commit messages (repo AGENTS.md).
- `session-launch-prefs.mjs` stays pure: no `node:fs`, no clock, no process env. File reading lives only in the `service.mjs` closure helper. Policy must NOT be inlined into the three spawn sites (spec §4).
- Runners (`runner/pty-runner.mjs`, `runner/job-runner.mjs`) get zero code changes.
- All test fixtures under temp dirs (`mkdtempSync`), never the host repository.
- `validateViewModelMeta`'s error string keeps its exact wording (tests regex `/no longer available/`).
- Conventional commit subjects (`feat`/`fix`/`refactor`/`test`/`docs`).
- Session fixture entries: every entry on the branch needs `id` + `parentId` chain; the `type: "session"` header line is NOT a tree entry.

## Review Focus

Five input classes the spec implies but per-task tests could miss — each pinned to its owning task:

1. **Torn last line** (concurrent append leaves half-written JSON): bad line is skipped, judgment uses complete lines only → Task 1 test `activeBranchEntries skips a torn trailing line`.
2. **Header-only session file** (only `type: "session"`, no entries): not restorable, pass defaults → Task 3 test case `header-only text`.
3. **`defaultModel: null` view** (launched without a model choice): `droppedModel` must stay false and `model` stays null → Task 3 case `defaults null + restorable session`; Task 4 empty-session reply variant asserts null passthrough without a diagnostic.
4. **Dashboard preheat cold start** (cursor-row preheat must not bypass the resolution): preheat reaches the same `ensureHost` → `launchHost` → `startHostUnderLease` entry → Task 4 Step 2 includes a static check that `src/ui/dashboard.ts` preheat calls `ensureHost` (no separate spawn path); the dynamic behavior is pinned by the `ensureHost` integration test.
5. **Dispatch of a brand-new view** (session file absent): effective model = `defaultModel` (today's behavior) → Task 4 reply-variant with empty session file asserts passthrough; existing dispatch tests in `test/service.test.mjs` must stay green (full suite in Task 6).

---

### Task 1: `session-entries.mjs` — shared JSONL parse + branch walk (A0)

**Files:**
- Create: `src/core/session-entries.mjs`
- Test: `test/session-entries.test.mjs` (new)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `parseSessionEntries(text: string): { header: {id,cwd}|null, entries: any[], byId: Map<string, any> }`
  - `activeBranchEntries(entries: any[], byId: Map<string, any>): any[]` (root→leaf order; leaf = last entry; cycle-safe; stops at broken `parentId`)

- [ ] **Step 1: Write the failing tests**

Create `test/session-entries.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { activeBranchEntries, parseSessionEntries } from "../src/core/session-entries.mjs";

const line = (obj) => JSON.stringify(obj);

test("parseSessionEntries extracts header, keeps entries and index, skips bad lines", () => {
	const text = [
		line({ type: "session", id: "s1", cwd: "/r" }),
		"{ not json",
		line({ type: "model_change", id: "e1", parentId: null, provider: "p", modelId: "m" }),
		line({ no: "id-field" }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "hi" } }),
		"",
	].join("\n");
	const { header, entries, byId } = parseSessionEntries(text);
	assert.deepEqual(header, { id: "s1", cwd: "/r" });
	assert.equal(entries.length, 2, "bad JSON and id-less lines are skipped");
	assert.equal(byId.size, 2);
	assert.equal(entries[0].id, "e1");
});

test("parseSessionEntries tolerates null/empty text", () => {
	assert.deepEqual(parseSessionEntries(null), { header: null, entries: [], byId: new Map() });
	assert.deepEqual(parseSessionEntries(""), { header: null, entries: [], byId: new Map() });
});

test("activeBranchEntries walks root→leaf from the last entry", () => {
	const text = [
		line({ type: "session", id: "s1", cwd: "/r" }),
		line({ type: "thinking_level_change", id: "e1", parentId: null, thinkingLevel: "high" }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "hi" } }),
		line({ type: "message", id: "e3", parentId: "e2", message: { role: "assistant", content: "yo" } }),
	].join("\n");
	const { entries, byId } = parseSessionEntries(text);
	const branch = activeBranchEntries(entries, byId);
	assert.deepEqual(branch.map((e) => e.id), ["e1", "e2", "e3"]);
});

test("activeBranchEntries excludes an abandoned sibling branch", () => {
	// e2 forks: abandoned child e2b, active chain continues through e3 (last entry).
	const text = [
		line({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }),
		line({ type: "model_change", id: "e2b", parentId: "e1", provider: "p", modelId: "abandoned" }),
		line({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "again" } }),
		line({ type: "message", id: "e3", parentId: "e2", message: { role: "assistant", content: "yo" } }),
	].join("\n");
	const { entries, byId } = parseSessionEntries(text);
	const branch = activeBranchEntries(entries, byId);
	assert.deepEqual(branch.map((e) => e.id), ["e1", "e2", "e3"], "the abandoned model_change e2b must not be on the branch");
});

test("activeBranchEntries stops at a broken parentId and survives a cycle", () => {
	const orphan = [{ id: "e9", parentId: "missing", type: "message" }];
	assert.deepEqual(activeBranchEntries(orphan, new Map([["e9", orphan[0]]])).map((e) => e.id), ["e9"], "broken parentId ends the walk, reachable entry still returned");
	const a = { id: "a", parentId: "b", type: "message" };
	const b = { id: "b", parentId: "a", type: "message" };
	const branch = activeBranchEntries([a, b], new Map([["a", a], ["b", b]]));
	assert.ok(branch.length <= 2, "cycle guard terminates the walk");
});

test("activeBranchEntries skips a torn trailing line (concurrent append)", () => {
	const text = [
		line({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }),
		'{"type":"message","id":"e2","par', // torn last line
	].join("\n");
	const { entries, byId } = parseSessionEntries(text);
	assert.equal(entries.length, 1, "torn line is dropped by the parser");
	assert.deepEqual(activeBranchEntries(entries, byId).map((e) => e.id), ["e1"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session-entries.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/session-entries.mjs'`.

- [ ] **Step 3: Write `src/core/session-entries.mjs`**

Create `src/core/session-entries.mjs`:

```js
/**
 * Shared session-JSONL structure primitives — the single source of branch
 * semantics for everything agent-board reads out of a pi session file.
 * Extracted verbatim from session-view.mjs (issue #286); display code and
 * launch-prefs policy both consume these so they can never drift apart.
 *
 * The file is a tree: every entry has `id` + `parentId`; the active branch is
 * the root→leaf path ending at the last entry (pi's SessionManager.getBranch
 * picks the same leaf when no explicit leaf is recorded).
 */

/**
 * Parse raw JSONL text into a header plus a tree index.
 * Malformed lines, non-objects, and id-less entries are skipped.
 * @param {string} text
 * @returns {{ header: { id: string, cwd: string } | null, entries: any[], byId: Map<string, any> }}
 */
export function parseSessionEntries(text) {
	/** @type {{ id: string, cwd: string } | null} */
	let header = null;
	/** @type {any[]} */
	const entries = [];
	/** @type {Map<string, any>} */
	const byId = new Map();

	for (const rawLine of String(text || "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type === "session") {
			header = { id: String(entry.id || ""), cwd: String(entry.cwd || "") };
			continue;
		}
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
		entries.push(entry);
		byId.set(entry.id, entry);
	}

	return { header, entries, byId };
}

/**
 * Walk from the last entry to the root following parentId pointers.
 * Root→leaf order. A broken parentId ends the walk; a seen-set guards cycles.
 * @param {any[]} entries
 * @param {Map<string, any>} byId
 * @returns {any[]}
 */
export function activeBranchEntries(entries, byId) {
	if (!entries.length) return [];
	/** @type {any[]} */
	const out = [];
	const seen = new Set();
	let cur = entries[entries.length - 1];
	while (cur && typeof cur.id === "string" && !seen.has(cur.id)) {
		out.push(cur);
		seen.add(cur.id);
		cur = cur.parentId ? byId.get(cur.parentId) ?? null : null;
	}
	out.reverse();
	return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session-entries.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/session-entries.mjs test/session-entries.test.mjs
git commit -m "feat: extract session-entries primitives shared by view and launch prefs"
```

---

### Task 2: Refactor `session-view.mjs` onto the shared primitives (A2)

**Files:**
- Modify: `src/core/session-view.mjs` (parse loop + local `activeBranch`)
- Test: `test/session-view.test.mjs` (extend; 2 new cases)

**Interfaces:**
- Consumes: `parseSessionEntries`, `activeBranchEntries` from `./session-entries.mjs` (Task 1).
- Produces: unchanged `parseSessionText(text)` / `loadSessionView(sessionFile)` signatures and `SessionViewData` shape.

- [ ] **Step 1: Add the two regression cases to `test/session-view.test.mjs`**

Append (keep existing imports; the file already imports `parseSessionText`):

```js
test("parseSessionText keeps the session header extraction (refactor guard, issue #286)", () => {
	const text = [
		JSON.stringify({ type: "session", id: "s42", cwd: "/work" }),
		JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }),
	].join("\n");
	const view = parseSessionText(text);
	assert.equal(view.header?.id, "s42");
	assert.equal(view.header?.cwd, "/work");
});

test("parseSessionText skips id-less entries when building the branch (refactor guard, issue #286)", () => {
	const text = [
		JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }),
		JSON.stringify({ type: "message", parentId: "e1", message: { role: "assistant", content: "ghost" } }), // no id
	].join("\n");
	const view = parseSessionText(text);
	assert.equal(view.items.length, 1, "id-less entry does not reach display items");
});
```

- [ ] **Step 2: Run tests (new ones must pass on current code — they pin pre-refactor behavior)**

Run: `node --test test/session-view.test.mjs`
Expected: PASS (4 tests). If a new case fails BEFORE the refactor, the assumption about current behavior is wrong — stop and reconcile with the current parse loop before refactoring.

- [ ] **Step 3: Refactor `parseSessionText` to use the shared module**

In `src/core/session-view.mjs`:
1. Add import at top: `import { activeBranchEntries, parseSessionEntries } from "./session-entries.mjs";`
2. Replace the body of `parseSessionText`'s parsing/branch section so it reads:

```js
export function parseSessionText(text) {
	const { header, entries, byId } = parseSessionEntries(text);
	if (entries.length === 0) return { header, items: [], error: null };
	const branch = activeBranchEntries(entries, byId);
	const items = branch.flatMap(displayItemsForEntry);
	return { header, items, error: null };
}
```

3. Delete the now-unused local `activeBranch` function and the old inline parse loop (header/entries/byId accumulation). Keep `loadSessionView`, `displayItemsForEntry`, `contentText` untouched.

- [ ] **Step 4: Run tests to verify refactor is behavior-identical**

Run: `node --test test/session-view.test.mjs test/session-entries.test.mjs`
Expected: PASS (4 + 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/session-view.mjs test/session-view.test.mjs
git commit -m "refactor: session-view consumes shared session-entries primitives"
```

---

### Task 3: `session-launch-prefs.mjs` — restore-ability policy (A1)

**Files:**
- Create: `src/core/session-launch-prefs.mjs`
- Test: `test/session-launch-prefs.test.mjs` (new)

**Interfaces:**
- Consumes: `parseSessionEntries`, `activeBranchEntries` (Task 1).
- Produces: `resolveLaunchModelPrefs(defaults: { model: string|null, thinkingLevel: string|null }, text: string|null): { model: string|null, thinkingLevel: string|null, droppedModel: boolean, droppedThinking: boolean }` — Task 4 consumes exactly this.

- [ ] **Step 1: Write the failing tests**

Create `test/session-launch-prefs.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session-launch-prefs.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/core/session-launch-prefs.mjs`**

```js
import { activeBranchEntries, parseSessionEntries } from "./session-entries.mjs";

/**
 * Pure launch-prefs policy (issue #286): decide per dimension whether an
 * explicit --model / --thinking flag must be passed when spawning a child pi,
 * or whether the flag must be omitted so pi restores the session's own last
 * selection (pi only restores a dimension when no explicit flag is given).
 *
 * Mirrors pi 1.5.0 createAgentSession's restore gates on the normal path:
 * - model restores when the branch has >=1 message entry AND (a model_change
 *   entry OR an assistant message entry);
 * - thinking restores (to the session's own value) only when the branch has a
 *   thinking_level_change entry (otherwise pi would restore the SETTINGS
 *   default, not the view's defaultThinking — keep passing the explicit flag).
 * Pure policy: no fs, no clock. The caller owns reading the session file.
 * @param {{ model: string|null, thinkingLevel: string|null }} defaults view launch defaults (meta.defaultModel/defaultThinking)
 * @param {string|null} text raw session JSONL, or null when unreadable/missing
 */
export function resolveLaunchModelPrefs(defaults, text) {
	const model = defaults?.model ?? null;
	const thinkingLevel = defaults?.thinkingLevel ?? null;
	let droppedModel = false;
	let droppedThinking = false;

	if (text) {
		const { entries, byId } = parseSessionEntries(text);
		const branch = activeBranchEntries(entries, byId);
		const hasMessage = branch.some((e) => e.type === "message");
		if (hasMessage) {
			const modelRestorable = branch.some(
				(e) => e.type === "model_change" || (e.type === "message" && e.message?.role === "assistant"),
			);
			const thinkingRestorable = branch.some((e) => e.type === "thinking_level_change");
			droppedModel = modelRestorable && model !== null;
			droppedThinking = thinkingRestorable && thinkingLevel !== null;
		}
	}

	return {
		model: droppedModel ? null : model,
		thinkingLevel: droppedThinking ? null : thinkingLevel,
		droppedModel,
		droppedThinking,
	};
}
```

Note: `droppedModel` is only true when a real default was actually withheld — a null default staying null is not a "drop" (Task 4's diagnostic fires only on real drops; Task 3's null-defaults case asserts this).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session-launch-prefs.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/session-launch-prefs.mjs test/session-launch-prefs.test.mjs
git commit -m "feat: session launch-prefs policy for issue #286 restore-vs-flag decision"
```

---

### Task 4: `service.mjs` integration — three spawn paths + #90 guard (A3, A4)

**Files:**
- Modify: `src/runtime/service.mjs` (`:7` import, new closure helper near `validateViewModelMeta`, `launchForView` :240-265, `startHostUnderLease` :337-380, `adoptClaimedHost` :1413-1460)
- Test: `test/host-resolver.test.mjs` (extend guard section + adopt), `test/service.test.mjs` (extend reply/json-runner section)

**Interfaces:**
- Consumes: `resolveLaunchModelPrefs` (Task 3), existing `appendDiagnostic`, `existsSync`, `readFileSync` (add to the `node:fs` import).
- Produces: closure helper `resolveViewLaunchPrefs(meta) -> { model, thinkingLevel, droppedModel, droppedThinking }`; `validateViewModelMeta(effectiveModel)` (signature change, private to service.mjs); diagnostic code `launch_prefs_from_session`.

- [ ] **Step 1: Write the failing tests — host-resolver (A4 + ensureHost A3)**

In `test/host-resolver.test.mjs`, inside the `---- stale defaultModel launch guard (issue #90) ----` section, add (helpers `freshRoot`, `resolverService`, `hostRecord`, and imports `readDiagnostics`, `writeFileSync` already exist in the file):

```js
test("ensureHost leaves model/thinking to session restore when the session can provide them (issue #286)", () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "restorable", cwd: "/r", defaultModel: "prov/default-a", defaultThinking: "high" });
		writeFileSync(meta.sessionFile, [
			JSON.stringify({ type: "session", id: "s1", cwd: "/r" }),
			JSON.stringify({ type: "thinking_level_change", id: "e1", parentId: null, thinkingLevel: "medium" }),
			JSON.stringify({ type: "model_change", id: "e2", parentId: "e1", provider: "prov", modelId: "picked-b" }),
			JSON.stringify({ type: "message", id: "e3", parentId: "e2", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "message", id: "e4", parentId: "e3", message: { role: "assistant", content: "yo" } }),
		].join("\n") + "\n");
		const spawns = [];
		const svc = resolverService(root, {
			launchHost: (_root, config) => {
				spawns.push({ config });
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		const res = svc.ensureHost("v1");
		assert.equal(res.ok, true);
		assert.equal(spawns.length, 1);
		assert.equal(spawns[0].config.model, null, "model flag must be omitted so pi restores it");
		assert.equal(spawns[0].config.thinkingLevel, null, "thinking flag must be omitted so pi restores it");
		const diags = readDiagnostics(root, "v1");
		assert.ok(diags.some((d) => d.code === "launch_prefs_from_session"), "drop is recorded in diagnostics");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureHost launches a restorable session even when defaultModel is provably unavailable (issue #286 + #90)", () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "stale-but-restorable", cwd: "/r", defaultModel: "glm/glm-5.3", defaultThinking: "high" });
		writeFileSync(meta.sessionFile, [
			JSON.stringify({ type: "session", id: "s1", cwd: "/r" }),
			JSON.stringify({ type: "model_change", id: "e1", parentId: null, provider: "zai-coding-cn", modelId: "glm-5.3" }),
			JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "message", id: "e3", parentId: "e2", message: { role: "assistant", content: "yo" } }),
		].join("\n") + "\n");
		const spawns = [];
		const svc = resolverService(root, {
			availableModels: () => [{ provider: "zai-coding-cn", id: "glm-5.3" }],
			launchHost: (_root, config) => {
				spawns.push({ config });
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		const res = svc.ensureHost("v1");
		assert.equal(res.ok, true, "a dead defaultModel must not block a session that restores its own model");
		assert.equal(spawns.length, 1);
		assert.equal(spawns[0].config.model, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("guard still blocks a dead defaultModel on an unrestorable session (issue #90 unchanged, issue #286)", () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "stale-empty", cwd: "/r", defaultModel: "glm/glm-5.3" });
		writeFileSync(meta.sessionFile, [
			JSON.stringify({ type: "session", id: "s1", cwd: "/r" }),
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" } }),
		].join("\n") + "\n");
		const spawns = [];
		const svc = resolverService(root, {
			availableModels: () => [{ provider: "zai-coding-cn", id: "glm-5.3" }],
			launchHost: (_root, config) => {
				spawns.push({ config });
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		const res = svc.ensureHost("v1");
		assert.equal(res.ok, false);
		assert.match(res.error, /no longer available/);
		assert.equal(spawns.length, 0, "user-only session cannot restore a model — the explicit dead one must not spawn");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("adoption of a stale claim also resolves launch prefs from the session (issue #286)", () => {
	const root = freshRoot();
	try {
		const meta = createView(root, { id: "v1", name: "adopt", cwd: "/r", defaultModel: "prov/default-a", defaultThinking: "high" });
		writeFileSync(meta.sessionFile, [
			JSON.stringify({ type: "session", id: "s1", cwd: "/r" }),
			JSON.stringify({ type: "model_change", id: "e1", parentId: null, provider: "prov", modelId: "picked-b" }),
			JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "hi" } }),
		].join("\n") + "\n");
		hostRecord(root, "v1", {
			instanceId: "i1",
			state: "starting",
			claimAt: Date.now() - HOST_START_GRACE_MS - 5_000,
			claimPid: process.pid,
			runnerSpawnedAt: null,
		});
		const probe = scriptProbe(["missing", "missing", "ready"]);
		const spawns = [];
		const svc = resolverService(root, {
			probeHostFn: probe.fn,
			sleepFn: instantSleep,
			launchHost: (_root, config) => {
				spawns.push({ config });
				return { pid: process.pid, configPath: config.configPath };
			},
		});
		const result = await svc.resolveAttachTarget("v1", { timeoutMs: 2_000 });
		assert.equal(result.kind, "pty");
		assert.equal(spawns.length, 1, "the stale claim is adopted and spawned");
		assert.equal(spawns[0].config.model, null, "adopted spawn omits the model flag");
		assert.equal(spawns[0].config.thinkingLevel, "high", "no thinking entry in session → keep view default");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

Mark the adoption test `async` in its declaration: `test("adoption of a stale claim ...", async () => {`.

- [ ] **Step 2: Write the failing tests — service reply/json-runner path (A3, launchForView)**

In `test/service.test.mjs`, next to the existing `drainNextFollowUp` test (~:1636), add two variants (reuse the file's existing helpers `freshRoot`, `service`, `createView`, `readState`, `writeState`, `readDiagnostics` — import `readDiagnostics` from `../src/core/diagnostics.mjs` and `writeFileSync` from `node:fs` if not already imported):

```js
async function replyDrainCapture(root, sessionText) {
	const meta = createView(root, { id: "v1", name: "r", cwd: "/r", defaultModel: "prov/default-a", defaultThinking: "high" });
	if (sessionText !== null) writeFileSync(meta.sessionFile, sessionText);
	const st = readState(root, "v1");
	st.semanticState = "working";
	st.processState = "alive";
	writeState(root, st);
	const launched = [];
	const svc = service(root, {
		ptySupport: () => ({ ok: false, reason: "test" }),
		launch: (_root, config) => {
			launched.push(config);
			return { pid: null, configPath: "/no/config.json" };
		},
	});
	const queued = await svc.reply("v1", "next step");
	assert.equal(queued.ok, true);
	const idle = readState(root, "v1");
	idle.semanticState = "idle";
	idle.processState = "exited";
	writeState(root, idle);
	const drained = await svc.drainNextFollowUp("v1");
	assert.equal(drained.ok, true);
	assert.equal(launched.length, 1);
	return { launched: launched[0], svc };
}

test("json-runner follow-up on a restorable session omits model/thinking flags (issue #286)", async () => {
	const root = freshRoot();
	try {
		const sessionText = [
			JSON.stringify({ type: "session", id: "s1", cwd: "/r" }),
			JSON.stringify({ type: "thinking_level_change", id: "e1", parentId: null, thinkingLevel: "medium" }),
			JSON.stringify({ type: "model_change", id: "e2", parentId: "e1", provider: "prov", modelId: "picked-b" }),
			JSON.stringify({ type: "message", id: "e3", parentId: "e2", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "message", id: "e4", parentId: "e3", message: { role: "assistant", content: "yo" } }),
		].join("\n") + "\n";
		const { launched } = await replyDrainCapture(root, sessionText);
		assert.equal(launched.model, null);
		assert.equal(launched.thinkingLevel, null);
		assert.ok(readDiagnostics(root, "v1").some((d) => d.code === "launch_prefs_from_session"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("json-runner follow-up on an empty session keeps launch defaults (issue #286)", async () => {
	const root = freshRoot();
	try {
		const { launched } = await replyDrainCapture(root, "");
		assert.equal(launched.model, "prov/default-a");
		assert.equal(launched.thinkingLevel, "high");
		assert.ok(!readDiagnostics(root, "v1").some((d) => d.code === "launch_prefs_from_session"), "no drop → no diagnostic");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

(If `freshRoot` does not exist under that name in `service.test.mjs`, use the file's own temp-root helper — do not invent a second one; the existing tests around :1636 show the canonical setup to copy.)

- [ ] **Step 3: Static preheat check (Review Focus #4)**

Run: `rg -n "ensureHost|launchHost" src/ui/dashboard.ts | head -20`
Expected: preheat path funnels into the service `ensureHost`/`launchHost` API (no direct runner spawn, no separate config build). If a preheat path builds a config another way, STOP — the spec's three-spawn-path inventory is incomplete and must be revisited before implementation.

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `node --test test/host-resolver.test.mjs test/service.test.mjs`
Expected: the four new host-resolver tests and two new service tests FAIL (config carries `defaultModel` verbatim / guard blocks the restorable+dead case); all pre-existing tests still PASS.

- [ ] **Step 5: Implement the service integration**

In `src/runtime/service.mjs`:

1. Line ~7: `import { existsSync } from "node:fs";` → `import { existsSync, readFileSync } from "node:fs";`
2. Add import near the other core imports: `import { resolveLaunchModelPrefs } from "../core/session-launch-prefs.mjs";`
3. Above `validateViewModelMeta` (~:309), add the closure helper:

```js
	/**
	 * Effective launch prefs for a view (issue #286): read the session file and
	 * let the pure policy decide, per dimension, whether the explicit
	 * --model/--thinking flag must be withheld so pi restores the session's own
	 * last selection. Missing/unreadable session → both flags pass through
	 * (today's behavior). Real drops are recorded in diagnostics.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @returns {{ model: string|null, thinkingLevel: string|null, droppedModel: boolean, droppedThinking: boolean }}
	 */
	function resolveViewLaunchPrefs(meta) {
		let text = null;
		try {
			text = existsSync(meta.sessionFile) ? readFileSync(meta.sessionFile, "utf8") : null;
		} catch {
			text = null;
		}
		const prefs = resolveLaunchModelPrefs(
			{ model: meta.defaultModel ?? null, thinkingLevel: meta.defaultThinking ?? null },
			text,
		);
		if (prefs.droppedModel || prefs.droppedThinking) {
			appendDiagnostic(root, meta.id, {
				source: "service",
				code: "launch_prefs_from_session",
				message: "Launch model/thinking left to session restore",
				details: { droppedModel: prefs.droppedModel, droppedThinking: prefs.droppedThinking },
			});
		}
		return prefs;
	}
```

4. Change `validateViewModelMeta(meta)` to take the effective model (update its JSDoc; keep the error string byte-identical):

```js
	/**
	 * Actionable error when the model we are about to spawn with is provably
	 * unavailable (issue #90): launching a child with a dead model id makes it
	 * exit 1 on every start, so attach would loop cold starts forever. With
	 * issue #286 the input is the EFFECTIVE model — null when the session
	 * restores its own selection, in which case there is nothing to validate.
	 * Only fires when a model is configured AND a live model list is injectable.
	 * @param {string|null} effectiveModel
	 * @returns {string|null}
	 */
	function validateViewModelMeta(effectiveModel) {
		const model = effectiveModel ?? null;
		if (!model || !availableModelsImpl) return null;
		let available;
		try {
			available = availableModelsImpl();
		} catch {
			return null;
		}
		if (modelRefAvailable(model, available)) return null;
		return `Model "${model}" configured for this session is no longer available — update the view's model (or clear defaultModel) and retry attach.`;
	}
```

5. `launchForView` (~:240): resolve before building the config, then use it:

```js
	async function launchForView(meta, prompt, kind) {
		const runId = newRunId();
		const launchPrefs = resolveViewLaunchPrefs(meta);
		/** @type {import("../core/types.mjs").RunConfig} */
		const config = {
			/* …unchanged fields… */
			model: launchPrefs.model,
			thinkingLevel: launchPrefs.thinkingLevel,
			tools: null,
		};
```

(Only the two lines `model:` / `thinkingLevel:` change plus the two added lines.)

6. `startHostUnderLease` (~:337): resolve before the guard, pass effective model to the guard, use prefs in the config:

```js
		// Fail fast BEFORE claiming (issue #90) — on the EFFECTIVE model (issue #286):
		// a session that restores its own model must not be blocked by a dead
		// defaultModel we are not going to pass anyway.
		const launchPrefs = resolveViewLaunchPrefs(meta);
		const modelError = validateViewModelMeta(launchPrefs.model);
		if (modelError) return { ok: false, error: modelError };
```

and in the config literal (~:368):

```js
			model: launchPrefs.model,
			thinkingLevel: launchPrefs.thinkingLevel,
```

7. `adoptClaimedHost` (~:1413): same pattern — resolve before the guard (~:1429), pass `launchPrefs.model` to `validateViewModelMeta`, and set `model: launchPrefs.model, thinkingLevel: launchPrefs.thinkingLevel` in the config literal (~:1445).

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `node --test test/host-resolver.test.mjs test/service.test.mjs`
Expected: PASS — new tests green, all pre-existing tests green (the two issue-#90 tests at :717/:744 use empty session files, so their guard behavior is unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/runtime/service.mjs test/host-resolver.test.mjs test/service.test.mjs
git commit -m "fix: leave model/thinking to session restore on host restart (issue #286)"
```

---

### Task 5: Runner argv mapping assertions (A5)

**Files:**
- Test: `test/runner.integration.test.mjs` (extend; no runner code changes)

**Interfaces:**
- Consumes: existing `makeConfig`/`FAKE_PI` harness; `launchRun` from `../src/core/launch.mjs`; the `worker_spawn` diagnostic (already carries `redactWorkerArgs(args)` — `--model` is not redacted).
- Produces: nothing (pure test coverage).

- [ ] **Step 1: Add the argv-mapping test**

In `test/runner.integration.test.mjs` (after the existing `makeConfig` helper; imports `readDiagnostics` from `../src/core/diagnostics.mjs` — add if missing):

```js
test("worker argv carries --model/--thinking only when configured (issue #286)", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-argv-"));
	try {
		await startCoordinator(root);
		const meta = createView(root, { id: "v1", name: "argv", cwd: root });
		const base = { root, viewId: "v1", runId: "run-argv", kind: "reply", sessionFile: meta.sessionFile, cwd: root, prompt: "do it", piCommand: process.execPath, piArgsPrefix: [FAKE_PI] };

		// Null prefs (restorable session) → no flags in argv.
		const nullCfg = { ...base, runId: "run-argv-null", model: null, thinkingLevel: null };
		launchRun(root, nullCfg, { runnerScript: RUNNER });
		await waitFor(() => readStatus(root, "v1")?.runId === "run-argv-null" && readStatus(root, "v1")?.processState !== "alive");
		const nullSpawn = readDiagnostics(root, "v1").find((d) => d.code === "worker_spawn" && d.runId === "run-argv-null");
		assert.ok(nullSpawn, "worker_spawn diagnostic recorded");
		assert.ok(!nullSpawn.details.args.includes("--model"), "null model → no --model flag");
		assert.ok(!nullSpawn.details.args.includes("--thinking"), "null thinking → no --thinking flag");

		// Configured values → flags present (proves the mapping direction).
		const setCfg = { ...base, runId: "run-argv-set", model: "prov/picked-b", thinkingLevel: "high" };
		launchRun(root, setCfg, { runnerScript: RUNNER });
		await waitFor(() => readStatus(root, "v1")?.runId === "run-argv-set" && readStatus(root, "v1")?.processState !== "alive");
		const setSpawn = readDiagnostics(root, "v1").find((d) => d.code === "worker_spawn" && d.runId === "run-argv-set");
		assert.ok(setSpawn, "worker_spawn diagnostic recorded");
		const args = setSpawn.details.args;
		assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "prov/picked-b", "model flag passed through");
		assert.ok(args.includes("--thinking") && args[args.indexOf("--thinking") + 1] === "high", "thinking flag passed through");
	} finally {
		await killDetached(readPid(root, "v1")?.pid ?? null);
		rmSync(root, { recursive: true, force: true });
	}
});
```

(Adapt helper names to what the file already exports/uses — `readStatus`, `readPid`, `startCoordinator`, `waitFor`, `killDetached`, `RUNNER`, `FAKE_PI` all exist in this file; if `readPid` returns a different shape, follow the file's own kill pattern from other tests.)

- [ ] **Step 2: Run to verify it passes (code already correct — this pins it)**

Run: `node --test test/runner.integration.test.mjs`
Expected: PASS — the new test and all existing runner tests.

- [ ] **Step 3: Commit**

```bash
git add test/runner.integration.test.mjs
git commit -m "test: pin worker argv model/thinking flag mapping (issue #286)"
```

---

### Task 6: Full verification gate (A0–A5 总闸)

**Files:** none (verification only)

- [ ] **Step 1: Full suite + typecheck + coverage + pack**

Run: `npm run verify`
Expected: typecheck clean; all tests pass (including perf gate and coverage thresholds lines 85 / funcs 80 / branches 70); `pack:dry` clean. New test files count toward coverage of the new modules — if the branches threshold drops because `session-entries`/`session-launch-prefs` have uncovered error paths, add the missing case to the owning task's test file rather than loosening thresholds.

- [ ] **Step 2: Cross-check acceptance matrix against evidence**

For each of A0–A5, confirm the specific command above ran green in Step 1's output (A0/A1/A2/A5 via their `node --test` files inside the suite; A3/A4 via `test/service.test.mjs` + `test/host-resolver.test.mjs`). Record U1/U2 as `pending` (user verification, post-merge).

- [ ] **Step 3: No commit needed** — Task 6 produces evidence only.
