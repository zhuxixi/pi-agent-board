# Monotonic Foreground State Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a stale `needs_input` projection from resurrecting the "Needs answer" group after a foreground question is answered.

**Architecture:** A new module-level, pure projection cache stores the freshest status fields with a strictly increasing per-view stamp. `writeForegroundState` stamps and remembers; `syncRowEvent` adopts the snapshot when it is strictly newer than the disk rebuild (`statusFromRow` now carries `updatedAt`).

**Tech Stack:** Node 22, `node:test` + `assert/strict`, plain ESM `.mjs`, no build step.

**Spec:** `docs/superpowers/specs/2026-10-22-issue-225-monotonic-foreground-state-design.md`

## Global Constraints

- Tabs for indentation; English comments and commit messages.
- Conventional commit subjects; the PR number is appended at merge time.
- Run `npm run verify` before claiming completion (`npm test` alone skips the perf gate and coverage thresholds).
- Do not change the reducer, `foreground-preview-cache.mjs`, the coordinator, or manual-verdict writes.
- Cache keys are view ids; a view id is never reused (ids are generated), so leftover entries are only a memory concern.

## Review Focus

- **Same-millisecond bursts**: start/end of a question inside one millisecond must still order correctly (`nextStamp`, not `Date.now`).
- **Manual verdicts**: a `completed` / `holding` row (`autoState === null`) must never be overwritten by a cached projection.
- **Clone isolation**: mutating `status.pendingQuestions` after `remember`/`adopt` must not change the cache.
- **Other views**: stamps and entries are per view id; one view's events must not order another's.
- **Non-question fields untouched**: `review` / `diagnostics` / `autoState` / `lastVisitedAt` are not copied by adoption.

---

### Task 1: `foreground-projection-cache` module (A1–A3, A6-unit)

**Files:**
- Create: `src/core/foreground-projection-cache.mjs`
- Test: `test/foreground-projection-cache.test.mjs` (new file)

**Interfaces:**
- Produces: `createForegroundProjectionCache()` → `{ nextStamp(viewId), remember(viewId, status, stamp), adopt(viewId, status), forget(viewId), clear(), size() }` and the module-level singleton `foregroundProjectionCache`.

- [ ] **Step 1: Write the failing tests**

Create `test/foreground-projection-cache.test.mjs`:

```js
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
		assert.ok(a2 === b1 || a2 > b1);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/foreground-projection-cache.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/foreground-projection-cache.mjs'`.

- [ ] **Step 3: Implement the module**

Create `src/core/foreground-projection-cache.mjs`:

```js
/**
 * Process-local read-your-writes cache for foreground status projections
 * (issue #225).
 *
 * `syncRowEvent` rebuilds its status from `state.json` on every event, while
 * `writeForegroundState` is fire-and-forget: two events can have two
 * `sync_foreground` commands in flight, and an older projection can materialize
 * last. Because the rebuilt status carries no freshness signal, the next event
 * reduces onto the stale state and writes it back — a cleared question comes
 * back as `needs_input` until a terminal event lands.
 *
 * This cache stores the freshest whitelisted status fields with a strictly
 * increasing per-view stamp (`nextStamp`), so a disk rebuild that is older than
 * the last write is corrected before the new event is reduced.
 *
 * Module-level by necessity: `serviceFor()` creates a new service instance per
 * call (src/index.ts), so a per-instance cache would be discarded between
 * events.
 */

/** Fields a cached snapshot may restore on a stale rebuild. */
const CACHED_FIELDS = [
	"semanticState",
	"processState",
	"summary",
	"currentTool",
	"question",
	"pendingQuestions",
	"error",
	"lastActivityAt",
	"latestAssistantPreview",
	"lastAgentActivityAt",
];

/** @param {any} value */
function cloneValue(value) {
	if (value === null || typeof value !== "object") return value;
	return JSON.parse(JSON.stringify(value));
}

/** @param {any} status */
function snapshot(status) {
	/** @type {Record<string, unknown>} */
	const fields = {};
	for (const key of CACHED_FIELDS) fields[key] = cloneValue(status?.[key]);
	return fields;
}

export function createForegroundProjectionCache() {
	/** @type {Map<string, { stamp: number, fields: Record<string, unknown> }>} */
	const known = new Map();
	/** @type {Map<string, number>} */
	const stamps = new Map();

	function nextStamp(viewId) {
		const stamp = Math.max(Date.now(), (stamps.get(viewId) ?? 0) + 1);
		stamps.set(viewId, stamp);
		return stamp;
	}

	function remember(viewId, status, stamp) {
		if (!viewId || !status || typeof stamp !== "number" || !Number.isFinite(stamp)) return;
		known.set(viewId, { stamp, fields: snapshot(status) });
	}

	function adopt(viewId, status) {
		if (!viewId || !status) return false;
		const entry = known.get(viewId);
		if (!entry) return false;
		const at = typeof status.updatedAt === "number" ? status.updatedAt : 0;
		if (entry.stamp <= at) return false;
		for (const key of CACHED_FIELDS) status[key] = cloneValue(entry.fields[key]);
		status.updatedAt = entry.stamp;
		return true;
	}

	function forget(viewId) {
		stamps.delete(viewId);
		return known.delete(viewId);
	}

	function clear() {
		known.clear();
		stamps.clear();
	}

	function size() {
		return known.size;
	}

	return { nextStamp, remember, adopt, forget, clear, size };
}

/** Shared cache used by the runtime service (module-level: see module doc). */
export const foregroundProjectionCache = createForegroundProjectionCache();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/foreground-projection-cache.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/foreground-projection-cache.mjs test/foreground-projection-cache.test.mjs
git commit -m "feat: foreground projection cache with monotonic per-view stamps (#225)"
```

---

### Task 2: Wire the cache into the service (A4–A7, A8)

**Files:**
- Modify: `src/runtime/service.mjs` (`statusFromRow` :814, `writeForegroundState` :854, `syncRowEvent` :1540, eviction `:775` and `:2131`)
- Modify: `src/core/types.mjs` (`RunStatus` typedef)
- Test: `test/service.test.mjs` (append after the existing foreground-sync tests)

**Interfaces:**
- Consumes: `foregroundProjectionCache` from Task 1 (`nextStamp` / `remember` / `adopt` / `forget`).
- Produces: no public API change; `RunStatus` gains optional `updatedAt`.

- [ ] **Step 1: Write the failing integration tests**

Append to `test/service.test.mjs`:

```js
test("a stale needs_input snapshot cannot resurrect a cleared question (issue #225)", async () => {
	const root = freshRoot();
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", "off");
	const realNow = Date.now;
	Date.now = () => 1_700_000_000_000;
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const svc = service(root);
		assert.equal(await svc.syncHostedEvent("v1", {
			type: "tool_execution_start",
			toolCallId: "q1",
			toolName: "ask_questions",
			args: { questions: [{ question: "Choose a mode?" }] },
		}), true);
		const stale = readState(root, "v1");
		assert.equal(stale.semanticState, "needs_input");

		assert.equal(await svc.syncHostedEvent("v1", { type: "tool_execution_end", toolCallId: "q1", toolName: "ask_questions", isError: false }), true);
		// Simulate the older projection materializing after the newer one.
		writeState(root, stale);

		assert.equal(await svc.syncHostedEvent("v1", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } }), true);
		const next = readState(root, "v1");
		assert.equal(next.semanticState, "working");
		assert.equal(next.needsInput, false);
		assert.deepEqual(next.pendingQuestions, []);
	} finally {
		Date.now = realNow;
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a manual verdict survives a foreground tool event (issue #225)", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const done = readState(root, "v1");
		done.semanticState = "completed";
		done.processState = "exited";
		done.autoState = null;
		done.summary = "Done";
		done.updatedAt = Date.now() - 1000;
		writeState(root, done);

		const svc = service(root, { sendStateCommand: async () => ({ status: "rejected", reason: "manual_fence" }) });
		await svc.syncHostedEvent("v1", { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
		const next = readState(root, "v1");
		assert.equal(next.semanticState, "completed");
		assert.equal(next.autoState, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run them to verify the first fails**

Run: `node --test --test-name-pattern="issue #225" test/service.test.mjs`
Expected: the stale-snapshot test FAILS with `actual: 'needs_input'`, `expected: 'working'` (pre-fix the disk rebuild wins); the manual-verdict test passes (it is a regression guard).

- [ ] **Step 3: Add `updatedAt` to `RunStatus`**

In `src/core/types.mjs`, inside the `RunStatus` typedef, after `lastEventAt`:

```js
 * @property {number} [updatedAt] In-memory foreground rebuild freshness (issue #225);
 *   not persisted on run status files.
```

- [ ] **Step 4: Wire `statusFromRow`**

In `statusFromRow`, after `lastActivityAt: s.lastActivityAt,` add:

```js
			updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
```

- [ ] **Step 5: Stamp and remember in `writeForegroundState`**

Replace the first two statements of `writeForegroundState`:

```js
	async function writeForegroundState(row, status, opts = {}) {
		const projected = projectViewState(status, Date.now(), readState(root, row.meta.id) ?? row.state ?? null);
```

with:

```js
	async function writeForegroundState(row, status, opts = {}) {
		// Issue #225: a strictly increasing stamp makes the background rebuild able
		// to tell a stale disk snapshot from this write, even within one millisecond.
		const stamp = foregroundProjectionCache.nextStamp(row.meta.id);
		const projected = projectViewState(status, stamp, readState(root, row.meta.id) ?? row.state ?? null);
		foregroundProjectionCache.remember(row.meta.id, status, stamp);
```

- [ ] **Step 6: Adopt in `syncRowEvent`**

After `foregroundPreviewCache.backfill(row.meta.id, status);` add:

```js
		// Issue #225: correct a stale disk rebuild before the new event is reduced.
		foregroundProjectionCache.adopt(row.meta.id, status);
```

- [ ] **Step 7: Evict alongside the preview cache**

At `archiveView` (next to `foregroundPreviewCache.forget(viewId);`) and at `archiveByState` (next to `foregroundPreviewCache.forget(row.meta.id);`) add the matching call:

```js
		foregroundProjectionCache.forget(viewId);
```

```js
				foregroundProjectionCache.forget(row.meta.id);
```

- [ ] **Step 8: Add the import**

At the top of `src/runtime/service.mjs`, next to the preview-cache import:

```js
import { foregroundProjectionCache } from "../core/foreground-projection-cache.mjs";
```

- [ ] **Step 9: Run the tests**

Run: `node --test --test-name-pattern="issue #225" test/service.test.mjs`
Expected: PASS (both).

Then run: `npm test`
Expected: PASS — all existing foreground-sync, preview-cache, archive, and reducer tests stay green. (A7)

- [ ] **Step 10: Run the full gate**

Run: `npm run verify`
Expected: PASS — typecheck, perf gate, tests, coverage thresholds (85/80/70), pack dry-run. (A8)

- [ ] **Step 11: Commit**

```bash
git add src/runtime/service.mjs src/core/types.mjs test/service.test.mjs
git commit -m "fix: keep foreground rows monotonic across out-of-order state writes (#225)"
```

---

### Task 3: Post-merge live verification (manual, not a code task)

**Files:** none.

- [ ] **Step 1: Update the board clone the running process loads**

```bash
cd ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board
git checkout -- package-lock.json
git pull
git log -1 --oneline
```

- [ ] **Step 2: Restart Pi / the board service**, open the dashboard.

- [ ] **Step 3: Trigger a question** (`ask_user_question` or `question`), answer it, and keep watching.

Expected: the row returns to **RUNNING** within about a second, not at turn end. (U1)
