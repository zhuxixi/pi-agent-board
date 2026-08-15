# screen.log Startup GC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclaim disk from ended views' `screen.log` files via a startup GC, plus `screenLogRetentionDays` / `screenLogMaxSize` launch-prefs knobs (issue zhuxixi/pi-agent-board#1).

**Architecture:** New module `src/core/screen-log-gc.mjs` owns retention policy (`pruneScreenLogs` + prefs normalizers). `createService` triggers it deferred on dashboard startup. `launchHost` passes `screenLogMaxBytes` through `HostConfig` to `pty-runner.mjs`, which forwards it to the existing `appendBoundedScreenLog`/`reconcileScreenLog` cap logic.

**Tech Stack:** Pure Node ESM (`.mjs`), `node:test` + tmp dirs (repo test style), no new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-15-screenlog-gc-design.md` (this repo, previous commit).
- Test runner: `node --test test/*.test.mjs` (NOT bun). Full suite: `npm test`; typecheck: `npm run typecheck`.
- Indent with **tabs**, matching existing `.mjs` files.
- Commit messages: conventional commits (`feat`/`fix`/`test`/`refactor`).
- No new npm dependencies. No changes to job-runner (it never writes screen.log).
- **Active views must never be touched by GC** — runner holds an in-memory byte counter; external mutation of a live log races with it.
- Work only inside this worktree; never touch the main checkout.

---

### Task 1: `src/core/screen-log-gc.mjs` — retention policy module

**Files:**
- Create: `src/core/screen-log-gc.mjs`
- Test: `test/screen-log-gc.test.mjs`

**Interfaces:**
- Consumes: `readJson` from `src/core/atomic.mjs` (signature `readJson(path, fallback)`), path helpers from `src/core/paths.mjs` (`viewsDir`, `screenLogPath`, `hostPath`, `viewDir`).
- Produces:
  - `DEFAULT_SCREEN_LOG_RETENTION_DAYS` (const, `7`)
  - `normalizeRetentionDays(value) → number|null` — `0` → `null` (GC disabled); positive finite → floored int; anything else → default 7.
  - `normalizeScreenLogMaxBytes(value) → number|null` — positive finite → floored int; anything else → `null` (runner uses built-in default).
  - `pruneScreenLogs(root, opts?) → { scanned, removed, skippedActive, skippedFresh, bytesReclaimed, errors }` where `opts = { retentionDays?: number|null, now?: number }`.

- [ ] **Step 1: Write the failing test**

Create `test/screen-log-gc.test.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import {
	DEFAULT_SCREEN_LOG_RETENTION_DAYS,
	normalizeRetentionDays,
	pruneScreenLogs,
} from "../src/core/screen-log-gc.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agent-board-gc-"));
}

/** Create a view dir with a small meta.json, optional host.json, optional screen.log. */
function makeView(root, viewId, { host = null, logBytes = 128, logMtimeMs = null } = {}) {
	mkdirSync(P.viewDir(root, viewId), { recursive: true });
	writeFileSync(P.metaPath(root, viewId), "{}");
	if (host) atomicWriteJson(P.hostPath(root, viewId), host);
	if (logBytes > 0) {
		writeFileSync(P.screenLogPath(root, viewId), Buffer.alloc(logBytes, 65));
		if (logMtimeMs != null) {
			const secs = logMtimeMs / 1000;
			utimesSync(P.screenLogPath(root, viewId), secs, secs);
		}
	}
}

test("normalizeRetentionDays maps prefs values", () => {
	assert.equal(normalizeRetentionDays(0), null); // disabled
	assert.equal(normalizeRetentionDays(7), 7);
	assert.equal(normalizeRetentionDays("3"), 3);
	assert.equal(normalizeRetentionDays(2.9), 2);
	assert.equal(normalizeRetentionDays(-2), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
	assert.equal(normalizeRetentionDays(NaN), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
	assert.equal(normalizeRetentionDays(undefined), DEFAULT_SCREEN_LOG_RETENTION_DAYS);
});

test("removes screen.log of ended views past retention, keeps other files", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "old", { host: { state: "exited", endedAt: now - 10 * DAY_MS }, logBytes: 4096 });
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.removed, 1);
		assert.equal(stats.bytesReclaimed, 4096);
		assert.equal(existsSync(P.screenLogPath(root, "old")), false);
		assert.equal(existsSync(P.metaPath(root, "old")), true); // history row survives
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("active views are never touched, even with old logs", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "live", {
			host: { state: "alive", endedAt: null },
			logBytes: 4096,
			logMtimeMs: now - 30 * DAY_MS, // mtime says ancient; host says live — live wins
		});
		makeView(root, "starting", { host: { state: "starting", endedAt: null }, logBytes: 4096 });
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.skippedActive, 2);
		assert.equal(stats.removed, 0);
		assert.equal(existsSync(P.screenLogPath(root, "live")), true);
		assert.equal(existsSync(P.screenLogPath(root, "starting")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("recently ended views are kept", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "fresh", { host: { state: "exited", endedAt: now - 1 * DAY_MS } });
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.removed, 0);
		assert.equal(stats.skippedFresh, 1);
		assert.equal(existsSync(P.screenLogPath(root, "fresh")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("retentionDays 0 disables GC entirely", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "old", { host: { state: "exited", endedAt: now - 365 * DAY_MS } });
		const stats = pruneScreenLogs(root, { retentionDays: 0, now });
		assert.equal(stats.removed, 0);
		assert.equal(existsSync(P.screenLogPath(root, "old")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing host.json falls back to screen.log mtime", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		makeView(root, "stale", { host: null, logMtimeMs: now - 30 * DAY_MS });
		makeView(root, "recent", { host: null, logMtimeMs: now - 1 * DAY_MS });
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.removed, 1);
		assert.equal(stats.skippedFresh, 1);
		assert.equal(existsSync(P.screenLogPath(root, "stale")), false);
		assert.equal(existsSync(P.screenLogPath(root, "recent")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unlink failure does not abort the sweep", () => {
	const root = freshRoot();
	try {
		const now = Date.now();
		// A directory named screen.log: statSync succeeds with size>0, unlinkSync fails (EISDIR).
		makeView(root, "broken", { host: { state: "exited", endedAt: now - 10 * DAY_MS }, logBytes: 0 });
		mkdirSync(P.screenLogPath(root, "broken"));
		makeView(root, "normal", { host: { state: "exited", endedAt: now - 10 * DAY_MS } });
		const stats = pruneScreenLogs(root, { now });
		assert.equal(stats.errors, 1);
		assert.equal(stats.removed, 1);
		assert.equal(existsSync(P.screenLogPath(root, "normal")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/screen-log-gc.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/screen-log-gc.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `src/core/screen-log-gc.mjs`:

```js
/**
 * Startup GC for per-view PTY replay logs.
 *
 * screen.log write-path growth is already bounded by screen-log.mjs (cap + tail
 * compaction inside pty-runner). This module reclaims the other half: logs of
 * views whose session ENDED long ago — no runner will ever touch them again,
 * so without a sweep they sit on disk forever.
 *
 * Safety rules:
 * - Only screen.log is removed; meta/state/evidence stay so the dashboard row survives.
 * - Views with a live host (state alive/starting, endedAt null) are never touched:
 *   pty-runner holds an in-memory byte counter for its log and external mutation
 *   would race with it. Live logs are bounded by the runner's own cap.
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { readJson } from "./atomic.mjs";
import * as P from "./paths.mjs";

export const DEFAULT_SCREEN_LOG_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize the `screenLogRetentionDays` pref.
 * @param {unknown} value
 * @returns {number|null} days, or null when GC is disabled (pref = 0)
 */
export function normalizeRetentionDays(value) {
	if (value === 0 || value === "0") return null;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_SCREEN_LOG_RETENTION_DAYS;
	return Math.floor(n);
}

/**
 * Normalize the `screenLogMaxSize` pref.
 * @param {unknown} value
 * @returns {number|null} bytes, or null to keep the runner's built-in default
 */
export function normalizeScreenLogMaxBytes(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Delete screen.log of ended views older than the retention window.
 * Best-effort: a per-file failure is counted and skipped, never thrown.
 * @param {string} root
 * @param {{ retentionDays?: number|null, now?: number }} [opts]
 * @returns {{ scanned: number, removed: number, skippedActive: number, skippedFresh: number, bytesReclaimed: number, errors: number }}
 */
export function pruneScreenLogs(root, opts = {}) {
	const stats = { scanned: 0, removed: 0, skippedActive: 0, skippedFresh: 0, bytesReclaimed: 0, errors: 0 };
	const retentionDays = normalizeRetentionDays(opts.retentionDays);
	if (retentionDays === null) return stats;
	const now = Number.isFinite(opts.now) ? opts.now : Date.now();
	const cutoff = now - retentionDays * DAY_MS;
	/** @type {import("node:fs").Dirent[]} */
	let entries;
	try {
		entries = readdirSync(P.viewsDir(root), { withFileTypes: true });
	} catch {
		return stats; // no views dir yet — nothing to do
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const logFile = P.screenLogPath(root, entry.name);
		/** @type {number} */
		let size;
		try {
			size = statSync(logFile).size;
		} catch {
			continue; // no screen.log (job-runner views never have one)
		}
		if (size <= 0) continue;
		stats.scanned++;
		const basis = ageBasisMs(root, entry.name, logFile);
		if (basis === "active") {
			stats.skippedActive++;
			continue;
		}
		if (basis === null || basis > cutoff) {
			stats.skippedFresh++;
			continue;
		}
		try {
			unlinkSync(logFile);
			stats.removed++;
			stats.bytesReclaimed += size;
		} catch {
			stats.errors++;
		}
	}
	return stats;
}

/**
 * Age basis for one view's log: host endedAt when known, else the log's mtime.
 * @param {string} root @param {string} viewId @param {string} logFile
 * @returns {number|null|"active"} epoch ms, "active" for live views, null when unknown
 */
function ageBasisMs(root, viewId, logFile) {
	const host = readJson(P.hostPath(root, viewId), null);
	if (host && host.endedAt == null && (host.state === "alive" || host.state === "starting")) return "active";
	if (host && Number.isFinite(host.endedAt)) return host.endedAt;
	try {
		return statSync(logFile).mtimeMs;
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/screen-log-gc.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/screen-log-gc.mjs test/screen-log-gc.test.mjs
git commit -m "feat: add startup GC module for ended views' screen logs (issue #1)"
```

---

### Task 2: launch-prefs carry the two new knobs

**Files:**
- Modify: `src/core/types.mjs` (LaunchPrefs typedef, ~line 369)
- Modify: `src/core/store.mjs` (`readLaunchPrefs` ~line 56, `writeLaunchPrefs` ~line 61)
- Test: `test/store.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `LaunchPrefs` gains optional `screenLogRetentionDays: number|null` and `screenLogMaxSize: number|null` (both `null` = unset). Task 3 reads them via the existing `readLaunchPrefs(root)`.

- [ ] **Step 1: Write the failing test**

Append to `test/store.test.mjs` (reuse its existing `freshRoot()` helper; add `readLaunchPrefs, writeLaunchPrefs` to its `../src/core/store.mjs` import if not already imported):

```js
test("launch prefs carry screen log knobs with null defaults", () => {
	const root = freshRoot();
	try {
		const prefs = readLaunchPrefs(root);
		assert.equal(prefs.screenLogRetentionDays, null);
		assert.equal(prefs.screenLogMaxSize, null);
		writeLaunchPrefs(root, { cwd: "/tmp/x", screenLogRetentionDays: 3, screenLogMaxSize: 2048 });
		const next = readLaunchPrefs(root);
		assert.equal(next.screenLogRetentionDays, 3);
		assert.equal(next.screenLogMaxSize, 2048);
		assert.equal(next.cwd, "/tmp/x"); // existing fields untouched
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/store.test.mjs`
Expected: FAIL — `assert.equal(prefs.screenLogRetentionDays, null)` gets `undefined`

- [ ] **Step 3: Write minimal implementation**

In `src/core/types.mjs`, extend the LaunchPrefs typedef (null = unset; consumers apply defaults):

```js
/**
 * Persisted launch dialog defaults (`launch-prefs.json`).
 * @typedef {Object} LaunchPrefs
 * @property {number} version
 * @property {string|null} cwd
 * @property {string|null} model
 * @property {"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|null} thinkingLevel
 * @property {number|null} screenLogRetentionDays days before an ended view's screen.log is GC'd; 0 disables GC
 * @property {number|null} screenLogMaxSize per-view screen.log write cap in bytes; null = built-in default
 */
```

In `src/core/store.mjs`:

```js
/** @param {string} root @returns {LaunchPrefs} */
export function readLaunchPrefs(root) {
	return readJson(P.launchPrefsPath(root), {
		version: 1,
		cwd: null,
		model: null,
		thinkingLevel: null,
		screenLogRetentionDays: null,
		screenLogMaxSize: null,
	});
}

/** @param {string} root @param {Partial<LaunchPrefs>} prefs */
export function writeLaunchPrefs(root, prefs) {
	atomicWriteJson(P.launchPrefsPath(root), {
		version: 1,
		cwd: prefs.cwd ?? null,
		model: prefs.model ?? null,
		thinkingLevel: prefs.thinkingLevel ?? null,
		screenLogRetentionDays: prefs.screenLogRetentionDays ?? null,
		screenLogMaxSize: prefs.screenLogMaxSize ?? null,
	});
}
```

(The `writeLaunchPrefs` change is load-bearing: without it, saving launch dialog prefs would silently drop the new fields.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/store.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/types.mjs src/core/store.mjs test/store.test.mjs
git commit -m "feat: add screen log retention knobs to launch prefs (issue #1)"
```

---

### Task 3: service wiring — GC trigger + HostConfig passthrough

**Files:**
- Modify: `src/runtime/service.mjs` (imports, `createService` top ~line 60, `launchHost` config ~line 107, opts JSDoc ~line 55)
- Modify: `src/core/types.mjs` (HostConfig typedef ~line 200)
- Test: `test/service.test.mjs` (append)

**Interfaces:**
- Consumes: `pruneScreenLogs`, `normalizeScreenLogMaxBytes` from Task 1; `readLaunchPrefs` (already imported in service.mjs); prefs fields from Task 2.
- Produces:
  - `createService` opts gains optional `pruneScreenLogs?: typeof pruneScreenLogs` (test injection point).
  - `HostConfig` gains `screenLogMaxBytes: number|null` — Task 4 reads it in the runner.

- [ ] **Step 1: Write the failing tests**

Append to `test/service.test.mjs` (reuses its `service(root, overrides)` helper — it spreads `...overrides` into `createService`; also reuse `createView`, and add `readLaunchPrefs, writeLaunchPrefs` / `atomicWriteJson` imports as needed):

```js
test("createService schedules screen log GC with the prefs retention", async () => {
	const root = freshRoot();
	try {
		writeLaunchPrefs(root, { screenLogRetentionDays: 3 });
		const calls = [];
		service(root, { pruneScreenLogs: (r, o) => calls.push([r, o]) });
		// GC is deferred via setImmediate; one tick is enough (FIFO order).
		await new Promise((r) => setImmediate(r));
		assert.equal(calls.length, 1);
		assert.equal(calls[0][0], root);
		assert.deepEqual(calls[0][1], { retentionDays: 3 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failing screen log GC does not break createService", async () => {
	const root = freshRoot();
	try {
		const svc = service(root, {
			pruneScreenLogs: () => {
				throw new Error("gc boom");
			},
		});
		await new Promise((r) => setImmediate(r));
		assert.equal(typeof svc.row, "function"); // service still constructed fine
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureHost passes screenLogMaxBytes from prefs into HostConfig", async () => {
	const root = freshRoot();
	try {
		writeLaunchPrefs(root, { screenLogMaxSize: 2048 });
		const meta = createView(root, { id: "gc1", name: "gc1", cwd: process.cwd() });
		writeFileSync(meta.sessionFile, "");
		let captured = null;
		const svc = service(root, {
			ptySupport: () => ({ ok: true }),
			launchHost: (r, config) => {
				captured = config;
				return { pid: null, configPath: "/no/host-config.json" };
			},
		});
		const result = svc.ensureHost("gc1");
		assert.equal(result.ok, true);
		assert.equal(captured.screenLogMaxBytes, 2048);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

(`ensureHost` requires: view exists, not busy, session file exists, `ptySupport` ok — the setup above satisfies all four. `svc.ensureHost` is the public method at service.mjs:657 calling internal `launchHost`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/service.test.mjs`
Expected: FAIL — GC tests: `calls.length` is 0 (no such opt); ensureHost test: `captured.screenLogMaxBytes` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/runtime/service.mjs`:

1. Add import (near the other core imports):

```js
import { normalizeScreenLogMaxBytes, pruneScreenLogs } from "../core/screen-log-gc.mjs";
```

2. Extend the `createService` opts JSDoc block with one line:

```
 *   pruneScreenLogs?: typeof pruneScreenLogs,
```

3. Right after the existing `const ptyRunnerScript = ...; const titleRunnerScript = ...;` lines at the top of `createService`, add:

```js
	const pruneScreenLogsImpl = opts.pruneScreenLogs ?? pruneScreenLogs;
	// Reclaim replay logs of long-ended views on dashboard startup. Deferred via
	// setImmediate so the first frame is unaffected; any failure must not break
	// the dashboard.
	setImmediate(() => {
		try {
			pruneScreenLogsImpl(root, { retentionDays: readLaunchPrefs(root).screenLogRetentionDays });
		} catch {}
	}).unref?.();
```

4. In `launchHost(meta, initialPrompt, launchOpts)`, add one field to the `config` object literal (after `rows`):

```js
			screenLogMaxBytes: normalizeScreenLogMaxBytes(readLaunchPrefs(root).screenLogMaxSize),
```

In `src/core/types.mjs`, extend the HostConfig typedef (after `@property {number} rows`):

```
 * @property {number|null} screenLogMaxBytes per-view screen.log write cap; null = runner default
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/service.test.mjs`
Expected: PASS (new 3 + existing)

- [ ] **Step 5: Commit**

```bash
git add src/runtime/service.mjs src/core/types.mjs test/service.test.mjs
git commit -m "feat: run screen log GC on service startup and pass max size to hosts (issue #1)"
```

---

### Task 4: pty-runner honors `screenLogMaxBytes`

**Files:**
- Modify: `runner/pty-runner.mjs` (main() config read ~line 41, onData append ~line 122)
- Test: `test/pty-runner.integration.test.mjs` (append)

**Interfaces:**
- Consumes: `HostConfig.screenLogMaxBytes` from Task 3; existing `reconcileScreenLog(file, { maxBytes })` / `appendBoundedScreenLog(file, data, bytes, { maxBytes })` from `src/core/screen-log.mjs` (both already accept `opts.maxBytes`; `undefined` falls back to the built-in 5 MB default, and `retainBytes` is clamped to `min(100 KB, maxBytes)`).
- Produces: runner-side cap honoring the pref. Old host-config.json files without the field keep today's behavior.

- [ ] **Step 1: Write the failing test**

Append to `test/pty-runner.integration.test.mjs` (reuses its `freshRoot`, `waitFor`, `send` helpers and the `createConnection` socket pattern from the existing test):

```js
test("pty-runner honors screenLogMaxBytes from host config", async () => {
	const root = freshRoot();
	let runner;
	try {
		const meta = createView(root, { id: "cap1", name: "cap", cwd: process.cwd() });
		const configPath = P.hostConfigPath(root, "cap1");
		atomicWriteJson(configPath, {
			root,
			viewId: "cap1",
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
			model: null,
			tools: null,
			env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1" },
			cols: 80,
			rows: 24,
			screenLogMaxBytes: 2048,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		await waitFor(() => existsSync(P.controlSocketPath(root, "cap1")) && readHost(root, "cap1")?.state === "alive");

		const socket = createConnection(P.controlSocketPath(root, "cap1"));
		await once(socket, "connect");
		// ~8 KB of echoed output → well over the 2 KB cap → runner must compact.
		send(socket, { type: "input", data: `${"x".repeat(8192)}\n` });
		await waitFor(() => {
			try {
				return statSync(P.screenLogPath(root, "cap1")).size > 0;
			} catch {
				return false;
			}
		});
		send(socket, { type: "input", data: "exit\n" });
		await waitFor(() => readHost(root, "cap1")?.endedAt != null);
		// Compaction happens synchronously inside onData; size must settle ≤ cap.
		const size = await waitFor(() => {
			try {
				const s = statSync(P.screenLogPath(root, "cap1")).size;
				return s <= 2048 ? s : false;
			} catch {
				return false;
			}
		});
		assert.ok(size > 0 && size <= 2048, `screen.log should be compacted to <=2048 bytes, got ${size}`);
		socket.end();
	} finally {
		try { runner?.kill(); } catch {}
		rmSync(root, { recursive: true, force: true });
	}
});
```

(Add `statSync` to the `node:fs` import at the top of the test file if missing.)

Note: the fake pi echoes input (`echo:<text>`), so an 8192-char input produces >8 KB of output, exceeding the 2048-byte cap and forcing compaction. Compaction runs synchronously in `appendBoundedScreenLog` before the broadcast, so by the time `endedAt` is set the file is already bounded.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pty-runner.integration.test.mjs`
Expected: FAIL — the new test's `waitFor(size <= 2048)` times out (runner ignores the unknown field today, log stays >8 KB).

- [ ] **Step 3: Write minimal implementation**

In `runner/pty-runner.mjs`, inside `main()`:

Replace:

```js
	const screenLog = P.screenLogPath(config.root, config.viewId);
	let screenLogBytes = reconcileScreenLog(screenLog);
```

with:

```js
	const screenLog = P.screenLogPath(config.root, config.viewId);
	// Optional per-install cap override from launch prefs (screenLogMaxSize).
	// undefined → screen-log.mjs falls back to its built-in default.
	const screenLogMaxBytes =
		Number.isFinite(config.screenLogMaxBytes) && config.screenLogMaxBytes > 0
			? Math.floor(config.screenLogMaxBytes)
			: undefined;
	const screenLogLimits = { maxBytes: screenLogMaxBytes };
	let screenLogBytes = reconcileScreenLog(screenLog, screenLogLimits);
```

And in `child.onData`, replace:

```js
		screenLogBytes = appendBoundedScreenLog(screenLog, data, screenLogBytes);
```

with:

```js
		screenLogBytes = appendBoundedScreenLog(screenLog, data, screenLogBytes, screenLogLimits);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pty-runner.integration.test.mjs`
Expected: PASS (new + existing; the existing test's config has no `screenLogMaxBytes`, covering backward compat)

- [ ] **Step 5: Commit**

```bash
git add runner/pty-runner.mjs test/pty-runner.integration.test.mjs
git commit -m "feat: honor screenLogMaxSize pref in pty-runner log cap (issue #1)"
```

---

### Task 5: Full verification + issue comment

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: clean (new JSDoc typedefs must typecheck)

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass (existing 133+ plus ~12 new)

- [ ] **Step 3: Pack dry run**

Run: `npm run pack:dry`
Expected: `src/core/screen-log-gc.mjs` appears in the tarball file list (it's under `src/`, so it should be included automatically)

- [ ] **Step 4: Comment verification results on the issue**

```bash
gh issue comment 1 --repo zhuxixi/pi-agent-board --body "Implementation done on branch issue-1-screenlog-gc: startup GC + screenLogRetentionDays/screenLogMaxSize prefs. Verify: typecheck+tests+pack clean."
```
