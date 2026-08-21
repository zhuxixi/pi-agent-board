# Launch cwd 常用目录榜 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 launch 对话框的 cwd 选择器里加入按使用频率排名的候选目录榜（空输入显示 Top 8，输入做大小写不敏感子串匹配，tab 补全完整路径，无匹配回落文件系统浏览）。

**Architecture:** 新增纯数据模块 `src/core/cwd-stats.mjs`（持久统计 + 排名，seed 自现有 view），匹配与选择器状态决策放 `src/core/launch-options.mjs`（纯函数，可单测），`src/ui/dashboard.ts` 只做接线与渲染，`src/commands/agent-board.ts` 把 store root 传入 DashboardDeps。

**Tech Stack:** Node.js ESM（纯 node 无 Pi 依赖）、node:test、pi-tui 的 `Key`/`matchesKey`、现有 `atomic.mjs` 原子写与 `store.mjs` 容错读。

## Global Constraints

- 实现全部在 worktree `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-22-launch-cwd-favorites` 内完成并提交；**禁止**写 main 工作区（`/home/elling/git-repo/github/pi-agent-board`）。
- Worktree 的 `node_modules` 是指向主仓库的 symlink，已就绪；测试与 typecheck 命令都在 worktree 目录下执行。
- 所有 cwd 统计写入走 `src/core/atomic.mjs` 的 `atomicWriteJson`（temp + rename）；读取走 `readJson` 容错，缺失/损坏一律按空表，**永不 throw 到 UI**。
- 删除 view 不减计数；seed 仅在 `cwd-stats.json` 不存在时执行（幂等）。
- 候选匹配 = 大小写不敏感子串、路径任意部分；不做 fuzzy subsequence（spec Non-goal）。
- tab = 把高亮项完整路径补全进输入框（picker 保持打开），回车最终确认；esc 关闭 picker。
- home 目录永远在候选榜兜底（不在榜内时 count 0 排最后，不重复）。
- 保留现有 type-to-jump：launch 主对话框 cwd 字段上直接打字进入 picker 时，query = 已输入字符。
- `git add <file>` 按文件 stage，**禁止 `git add -A`**；commit message 用 conventional commits（`feat:`/`test:`/`refactor:`）。
- 验证命令（均在 worktree 内）：`npm test`（= `node --test test/*.test.mjs`）、`npm run typecheck`（= `tsc --noEmit`）。
- 文件顶部注释与 commit 用英文；UI 文案保持设计里的中文提示行。

## File Structure

| 文件 | 责任 |
| --- | --- |
| Create `src/core/cwd-stats.mjs` | cwd 使用统计持久层：read/seed/record/rank，纯 node |
| Modify `src/core/paths.mjs` | 加 `cwdStatsPath(root)` 路径函数 |
| Create `test/cwd-stats.test.mjs` | 统计模块单测（tmp dir 作 root） |
| Modify `src/core/launch-options.mjs` | 加纯函数 `filterCwdCandidates` / `nextCwdPickerState` |
| Create `test/launch-options.test.mjs` | 匹配与选择器状态决策单测 |
| Modify `src/ui/dashboard.ts` | LaunchState 字段、picker 状态机、tab 补全、seed/record 埋点、渲染 |
| Modify `src/commands/agent-board.ts` | DashboardDeps 传入 `root` |

---

### Task 1: cwd-stats 数据层（TDD）

**Files:**
- Create: `src/core/cwd-stats.mjs`
- Modify: `src/core/paths.mjs`（在 `gcHistoryPath` 之后加路径函数）
- Test: `test/cwd-stats.test.mjs`

**Interfaces:**
- Consumes: `atomicWriteJson` / `readJson`（`../core/atomic.mjs`）、`cwdStatsPath`（`../core/paths.mjs`）、`readRoster` / `readMeta`（`../core/store.mjs`）；`readMeta(root, viewId)` 返回 `{ id, cwd, updatedAt, ... } | null`，`updatedAt` 为 epoch ms。
- Produces:
  - `readCwdStats(root)` → `{ version: 1, entries: Record<string, { count: number, lastUsed: number }> }`
  - `seedCwdStatsFromViews(root)` → `void`（仅当 stats 文件不存在时写入）
  - `ensureCwdStatsSeeded(root)` → `void`（文件存在直接返回；失败吞掉）
  - `recordCwdLaunch(root, cwd)` → `void`（cwd 非目录时忽略）
  - `rankedCwdCandidates(root, limit = 8)` → `Array<{ path: string, count: number }>`（count desc、lastUsed desc；home 兜底末尾）

- [ ] **Step 1: 写失败测试**

创建 `test/cwd-stats.test.mjs`：

```js
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as P from "../src/core/paths.mjs";
import {
	ensureCwdStatsSeeded,
	rankedCwdCandidates,
	readCwdStats,
	recordCwdLaunch,
	seedCwdStatsFromViews,
} from "../src/core/cwd-stats.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "cwd-stats-"));
}

/** @param {string} root @param {Array<[string, string, number]>} views */
function writeViews(root, views) {
	for (const [viewId, cwd, updatedAt] of views) {
		mkdirSync(join(root, "views", viewId), { recursive: true });
		writeFileSync(P.metaPath(root, viewId), JSON.stringify({ id: viewId, cwd, updatedAt }));
	}
	writeFileSync(P.rosterPath(root), JSON.stringify({ version: 1, views: views.map(([viewId]) => viewId) }));
}

test("readCwdStats tolerates a missing stats file", () => {
	const root = freshRoot();
	try {
		assert.deepEqual(readCwdStats(root), { version: 1, entries: {} });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("seedCwdStatsFromViews aggregates counts and max updatedAt per cwd", () => {
	const root = freshRoot();
	try {
		writeViews(root, [
			["v1", "/a", 100],
			["v2", "/a", 300],
			["v3", "/b", 200],
		]);
		seedCwdStatsFromViews(root);
		assert.deepEqual(readCwdStats(root).entries, {
			"/a": { count: 2, lastUsed: 300 },
			"/b": { count: 1, lastUsed: 200 },
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("seedCwdStatsFromViews is a one-time no-op when the file exists", () => {
	const root = freshRoot();
	try {
		writeViews(root, [["v1", "/a", 100]]);
		seedCwdStatsFromViews(root);
		writeViews(root, [
			["v1", "/a", 100],
			["v2", "/b", 200],
		]);
		seedCwdStatsFromViews(root);
		assert.deepEqual(readCwdStats(root).entries, { "/a": { count: 1, lastUsed: 100 } });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("recordCwdLaunch increments count, sets lastUsed, ignores invalid dirs", () => {
	const root = freshRoot();
	try {
		recordCwdLaunch(root, join(root, "nope", "does", "not", "exist"));
		assert.deepEqual(readCwdStats(root).entries, {});
		recordCwdLaunch(root, root);
		let entry = readCwdStats(root).entries[root];
		assert.equal(entry.count, 1);
		const first = entry.lastUsed;
		recordCwdLaunch(root, root);
		entry = readCwdStats(root).entries[root];
		assert.equal(entry.count, 2);
		assert.ok(entry.lastUsed >= first);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rankedCwdCandidates orders by count desc, lastUsed desc, appends home fallback", () => {
	const root = freshRoot();
	try {
		writeViews(root, [
			["v1", "/rare", 100],
			["v2", "/rare", 200],
			["v3", "/common", 50],
			["v4", "/common", 60],
			["v5", "/common", 70],
			["v6", "/mid", 500],
			["v7", "/mid", 600],
		]);
		seedCwdStatsFromViews(root);
		const ranked = rankedCwdCandidates(root, 8);
		assert.deepEqual(ranked.slice(0, 3), [
			{ path: "/common", count: 3 },
			{ path: "/mid", count: 2 },
			{ path: "/rare", count: 2 },
		]);
		const last = ranked[ranked.length - 1];
		assert.equal(last.path, os.homedir());
		assert.equal(last.count, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("home fallback is not duplicated when home is already in stats", () => {
	const root = freshRoot();
	try {
		writeViews(root, [["v1", os.homedir(), 100]]);
		seedCwdStatsFromViews(root);
		const ranked = rankedCwdCandidates(root, 8);
		assert.equal(ranked.filter((entry) => entry.path === os.homedir()).length, 1);
		assert.equal(ranked[0].count, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("corrupt stats file degrades to empty and stays writable", () => {
	const root = freshRoot();
	try {
		writeFileSync(P.cwdStatsPath(root), "{not json");
		assert.deepEqual(readCwdStats(root), { version: 1, entries: {} });
		recordCwdLaunch(root, root);
		assert.equal(readCwdStats(root).entries[root].count, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureCwdStatsSeeded seeds once and is idempotent", () => {
	const root = freshRoot();
	try {
		writeViews(root, [["v1", "/a", 100]]);
		ensureCwdStatsSeeded(root);
		assert.ok(existsSync(P.cwdStatsPath(root)));
		ensureCwdStatsSeeded(root);
		assert.deepEqual(readCwdStats(root).entries, { "/a": { count: 1, lastUsed: 100 } });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/core/cwd-stats.mjs'`（paths 也还没有 `cwdStatsPath`）。

- [ ] **Step 3: 实现 paths.mjs 路径函数**

`src/core/paths.mjs`，在 `gcHistoryPath` 之后插入（文件已有同款注释风格）：

```js
/** @param {string} root */
export const gcHistoryPath = (root) => path.join(root, "gc-history.jsonl");
```

改为：

```js
/** @param {string} root */
export const gcHistoryPath = (root) => path.join(root, "gc-history.jsonl");
/** @param {string} root */
export const cwdStatsPath = (root) => path.join(root, "cwd-stats.json");
```

- [ ] **Step 4: 实现 cwd-stats.mjs**

创建 `src/core/cwd-stats.mjs`：

```js
/**
 * Persistent cwd usage stats for the launch dialog's directory favorites.
 *
 * Counts every successfully dispatched session per cwd, independent of the
 * view lifecycle (deleting a view does not decrement). The dashboard reads
 * the ranked list for the cwd picker's favorites mode. Pure node, no Pi imports.
 */
import { existsSync } from "node:fs";
import * as os from "node:os";
import { atomicWriteJson, readJson } from "./atomic.mjs";
import * as P from "./paths.mjs";
import { readMeta, readRoster } from "./store.mjs";

/**
 * @typedef {Object} CwdStatsEntry
 * @property {number} count
 * @property {number} lastUsed  epoch ms, like meta.updatedAt
 */

/** @returns {{version: number, entries: Record<string, CwdStatsEntry>}} */
function emptyStats() {
	return { version: 1, entries: {} };
}

/** @param {string} root @returns {{version: number, entries: Record<string, CwdStatsEntry>}} */
export function readCwdStats(root) {
	const raw = readJson(P.cwdStatsPath(root), null);
	if (!raw || typeof raw !== "object" || typeof raw.entries !== "object" || raw.entries === null) return emptyStats();
	/** @type {Record<string, CwdStatsEntry>} */
	const entries = {};
	for (const [dir, entry] of Object.entries(raw.entries)) {
		if (!entry || typeof entry.count !== "number") continue;
		entries[dir] = {
			count: Math.max(0, Math.floor(entry.count)),
			lastUsed: typeof entry.lastUsed === "number" ? entry.lastUsed : 0,
		};
	}
	return { version: 1, entries };
}

/**
 * One-time seed: aggregate cwd counts from every roster view's meta.json.
 * No-op when cwd-stats.json already exists.
 * @param {string} root
 */
export function seedCwdStatsFromViews(root) {
	if (existsSync(P.cwdStatsPath(root))) return;
	/** @type {Record<string, CwdStatsEntry>} */
	const entries = {};
	for (const viewId of readRoster(root).views ?? []) {
		const meta = readMeta(root, viewId);
		const cwd = meta?.cwd;
		if (!cwd) continue;
		const lastUsed = typeof meta.updatedAt === "number" ? meta.updatedAt : Date.now();
		const existing = entries[cwd];
		if (existing) {
			existing.count += 1;
			existing.lastUsed = Math.max(existing.lastUsed, lastUsed);
		} else {
			entries[cwd] = { count: 1, lastUsed };
		}
	}
	atomicWriteJson(P.cwdStatsPath(root), { version: 1, entries });
}

/**
 * Seed when the stats file is missing; tolerate every failure (dashboard UX
 * must never break because of stats bookkeeping).
 * @param {string} root
 */
export function ensureCwdStatsSeeded(root) {
	if (existsSync(P.cwdStatsPath(root))) return;
	try {
		seedCwdStatsFromViews(root);
	} catch {
		/* best effort */
	}
}

/**
 * Record one successful dispatch for `cwd`. Invalid dirs are ignored.
 * @param {string} root @param {string} cwd
 */
export function recordCwdLaunch(root, cwd) {
	if (!cwd || !existsSync(cwd)) return;
	const stats = readCwdStats(root);
	const existing = stats.entries[cwd] ?? { count: 0, lastUsed: 0 };
	stats.entries[cwd] = { count: existing.count + 1, lastUsed: Date.now() };
	atomicWriteJson(P.cwdStatsPath(root), stats);
}

/**
 * Ranked candidates: count desc, then lastUsed desc; home appended at the
 * end when absent so the user's home dir is always one keystroke away.
 * @param {string} root @param {number=} limit
 * @returns {Array<{path: string, count: number}>}
 */
export function rankedCwdCandidates(root, limit = 8) {
	const stats = readCwdStats(root);
	const rows = Object.entries(stats.entries).map(([dir, entry]) => ({
		path: dir,
		count: entry.count,
		lastUsed: entry.lastUsed,
	}));
	rows.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed);
	const out = rows.map(({ path, count }) => ({ path, count }));
	const home = os.homedir();
	if (!out.some((entry) => entry.path === home)) out.push({ path: home, count: 0 });
	return out.slice(0, Math.max(1, limit));
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test`
Expected: PASS（8 个新用例 + 既有用例全绿）。

- [ ] **Step 6: Commit**

```bash
git add src/core/paths.mjs src/core/cwd-stats.mjs test/cwd-stats.test.mjs
git commit -m "feat: add persistent cwd usage stats with view seeding (issue #22)"
```

---

### Task 2: 候选匹配与选择器状态纯函数（TDD）

**Files:**
- Modify: `src/core/launch-options.mjs`（文件末尾追加两个导出）
- Test: `test/launch-options.test.mjs`

**Interfaces:**
- Consumes: 同文件内已导出的 `listDirectorySuggestions(query, baseCwd)`。
- Produces:
  - `filterCwdCandidates(candidates: Array<{path, count}>, query: string)` → 过滤后的同形数组（空 query 返回原数组；大小写不敏感子串，路径任意部分；保持传入顺序）
  - `nextCwdPickerState(query, ranked, baseCwd)` → `{ mode: "favorites" | "browse", suggestions: string[] }`（query 空或候选有匹配 → favorites 返回匹配项 path；否则 browse 返回 `listDirectorySuggestions(query, baseCwd)`）

- [ ] **Step 1: 写失败测试**

创建 `test/launch-options.test.mjs`：

```js
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { filterCwdCandidates, listDirectorySuggestions, nextCwdPickerState } from "../src/core/launch-options.mjs";

const ranked = [
	{ path: "/home/elling", count: 107 },
	{ path: "/home/elling/git-repo/github/zima-blue-cli", count: 20 },
	{ path: "/home/elling/git-repo/github/jfox", count: 17 },
];

test("filterCwdCandidates matches case-insensitive substring anywhere in path", () => {
	assert.deepEqual(filterCwdCandidates(ranked, "jfox"), [
		{ path: "/home/elling/git-repo/github/jfox", count: 17 },
	]);
	assert.deepEqual(filterCwdCandidates(ranked, "GITHUB"), [ranked[1], ranked[2]]);
	assert.deepEqual(filterCwdCandidates(ranked, ""), ranked);
	assert.deepEqual(filterCwdCandidates(ranked, "no-such-dir"), []);
});

test("nextCwdPickerState: empty query shows full ranked favorites", () => {
	const state = nextCwdPickerState("", ranked, "/tmp");
	assert.equal(state.mode, "favorites");
	assert.deepEqual(state.suggestions, ranked.map((entry) => entry.path));
});

test("nextCwdPickerState: matching query stays favorites in ranked order", () => {
	const state = nextCwdPickerState("git-repo", ranked, "/tmp");
	assert.equal(state.mode, "favorites");
	assert.deepEqual(state.suggestions, [
		"/home/elling/git-repo/github/zima-blue-cli",
		"/home/elling/git-repo/github/jfox",
	]);
});

test("nextCwdPickerState: unmatched query falls back to filesystem browse", () => {
	const root = mkdtempSync(join(tmpdir(), "cwd-picker-"));
	try {
		const state = nextCwdPickerState("no-such-dir-xyz", ranked, root);
		assert.equal(state.mode, "browse");
		assert.deepEqual(state.suggestions, listDirectorySuggestions("no-such-dir-xyz", root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `filterCwdCandidates` / `nextCwdPickerState` not exported。

- [ ] **Step 3: 实现两个纯函数**

`src/core/launch-options.mjs` 文件末尾追加（`existsDir` 函数之后）：

```js
/**
 * @typedef {Object} CwdCandidate
 * @property {string} path
 * @property {number} count
 */

/**
 * Filter ranked cwd candidates by case-insensitive substring match anywhere
 * in the path (empty query keeps the full ranked list).
 * @param {CwdCandidate[]} candidates
 * @param {string} query
 * @returns {CwdCandidate[]}
 */
export function filterCwdCandidates(candidates, query) {
	const q = String(query ?? "").trim().toLowerCase();
	if (!q) return candidates;
	return candidates.filter((entry) => entry.path.toLowerCase().includes(q));
}

/**
 * Decide cwd picker mode + suggestions for a query: favorites when the query
 * is empty or matches ranked candidates, filesystem browse otherwise.
 * @param {string} query
 * @param {CwdCandidate[]} ranked
 * @param {string} baseCwd
 * @returns {{mode: "favorites"|"browse", suggestions: string[]}}
 */
export function nextCwdPickerState(query, ranked, baseCwd) {
	const matches = filterCwdCandidates(ranked, query);
	if (String(query ?? "").trim() === "" || matches.length > 0) {
		return { mode: "favorites", suggestions: matches.map((entry) => entry.path) };
	}
	return { mode: "browse", suggestions: listDirectorySuggestions(query, baseCwd) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/launch-options.mjs test/launch-options.test.mjs
git commit -m "feat: add cwd candidate filter and picker state resolver (issue #22)"
```

---

### Task 3: dashboard 接线与埋点（deps.root / picker 状态机 / tab 补全 / seed+record）

**Files:**
- Modify: `src/commands/agent-board.ts`（传 `root`）
- Modify: `src/ui/dashboard.ts`（imports、类型、openLaunchDialog/openLaunchPicker/handleLaunchPickerKey/submitDispatch）

**Interfaces:**
- Consumes: `ensureCwdStatsSeeded` / `rankedCwdCandidates` / `recordCwdLaunch`（`../core/cwd-stats.mjs`）、`filterCwdCandidates` / `nextCwdPickerState`（`../core/launch-options.mjs`）、pi-tui `Key.tab`（已存在，`matchesKey(data, Key.tab)`）。
- Produces: `DashboardDeps.root: string`；`LaunchState.cwdRanked: CwdCandidate[]`、`LaunchState.cwdPickerMode: "favorites" | "browse"`（Task 4 渲染消费这两个字段）。

此任务无新增单测（repo 现有 UI 层无 DashboardComponent 单测，行为由 Task 1/2 纯函数测试 + Task 5 手工验收覆盖），但**必须** `npm test` + `npm run typecheck` 全绿。

- [ ] **Step 1: agent-board.ts 传入 root**

`src/commands/agent-board.ts`，DashboardComponent 构造处：

```ts
				const comp = new DashboardComponent(tui, theme as never, keybindings, wrappedDone, {
					service,
					defaultCwd: ctx.cwd,
```

改为：

```ts
				const comp = new DashboardComponent(tui, theme as never, keybindings, wrappedDone, {
					service,
					root: opts.root,
					defaultCwd: ctx.cwd,
```

- [ ] **Step 2: dashboard.ts 加 imports**

`src/ui/dashboard.ts`，`prewarm-schedule` import 之后插入：

```ts
import { createPrewarmScheduler } from "../core/prewarm-schedule.mjs";
```

改为：

```ts
import { createPrewarmScheduler } from "../core/prewarm-schedule.mjs";
import { ensureCwdStatsSeeded, rankedCwdCandidates, recordCwdLaunch } from "../core/cwd-stats.mjs";
```

`launch-options.mjs` import 块：

```ts
import {
	canonicalModelRef,
	clampThinkingLevel,
	listDirectorySuggestions,
	resolveDirectoryValue,
	resolveLaunchContext,
	supportedThinkingLevels,
} from "../core/launch-options.mjs";
```

改为：

```ts
import {
	canonicalModelRef,
	clampThinkingLevel,
	listDirectorySuggestions,
	nextCwdPickerState,
	resolveDirectoryValue,
	resolveLaunchContext,
	supportedThinkingLevels,
} from "../core/launch-options.mjs";
```

- [ ] **Step 3: 类型定义**

`LaunchState` 接口前加候选类型，接口内加两个字段：

```ts
interface LaunchState {
	fieldIndex: number;
	picker: LaunchPicker;
	action: "background" | "attach";
	cwd: string;
	cwdQuery: string;
	cwdSuggestions: string[];
	cwdSuggestionIndex: number;
```

改为：

```ts
interface CwdCandidate {
	path: string;
	count: number;
}

interface LaunchState {
	fieldIndex: number;
	picker: LaunchPicker;
	action: "background" | "attach";
	cwd: string;
	cwdQuery: string;
	cwdSuggestions: string[];
	cwdSuggestionIndex: number;
	cwdRanked: CwdCandidate[];
	cwdPickerMode: "favorites" | "browse";
```

`DashboardDeps`：

```ts
export interface DashboardDeps {
	service: Service;
	defaultCwd: string;
```

改为：

```ts
export interface DashboardDeps {
	service: Service;
	root: string;
	defaultCwd: string;
```

- [ ] **Step 4: buildLaunchState 初始化新字段，移除 homeLaunchRoot 依赖**

`buildLaunchState` 中：

```ts
		const initialBrowserCwd = homeLaunchRoot(cwd);
		const modelFiltered = filterLaunchChoices(context.choices, "");
```

改为：

```ts
		const modelFiltered = filterLaunchChoices(context.choices, "");
```

返回对象：

```ts
		return {
			fieldIndex: 0,
			picker: null,
			action: "background",
			cwd,
			cwdQuery: initialBrowserCwd,
			cwdSuggestions: listDirectorySuggestions(initialBrowserCwd, cwd),
			cwdSuggestionIndex: 0,
```

改为：

```ts
		return {
			fieldIndex: 0,
			picker: null,
			action: "background",
			cwd,
			cwdQuery: "",
			cwdSuggestions: [],
			cwdSuggestionIndex: 0,
			cwdRanked: [],
			cwdPickerMode: "browse",
```

删除已无引用的 `homeLaunchRoot`：

```ts
function homeLaunchRoot(fallback: string): string {
	return process.env.HOME || process.env.USERPROFILE ? "~" : fallback;
}
```

整体删除该函数。验证无残留引用：`rg -n "homeLaunchRoot|initialBrowserCwd" src/` → 无输出。

- [ ] **Step 5: openLaunchDialog 加 lazy seed**

```ts
	private openLaunchDialog(): void {
		const prompt = this.input.trim();
		if (!prompt) return this.toListMode();
		const defaults = this.launchDefaults();
		this.launch = this.buildLaunchState(defaults.cwd, defaults.model, defaults.thinking);
```

改为：

```ts
	private openLaunchDialog(): void {
		const prompt = this.input.trim();
		if (!prompt) return this.toListMode();
		const defaults = this.launchDefaults();
		try {
			ensureCwdStatsSeeded(this.deps.root);
		} catch {
			/* best effort: favorites degrade to browse mode */
		}
		this.launch = this.buildLaunchState(defaults.cwd, defaults.model, defaults.thinking);
```

- [ ] **Step 6: openLaunchPicker("cwd") 初始化 favorites 状态（保留 seed 语义）**

```ts
		if (picker === "cwd") {
			launch.cwdQuery = seed ?? launch.cwdQuery ?? homeLaunchRoot(launch.cwd);
			launch.cwdSuggestions = listDirectorySuggestions(launch.cwdQuery, launch.cwd);
			launch.cwdSuggestionIndex = 0;
			return;
		}
```

改为：

```ts
		if (picker === "cwd") {
			try {
				ensureCwdStatsSeeded(this.deps.root);
				launch.cwdRanked = rankedCwdCandidates(this.deps.root, 8);
			} catch {
				launch.cwdRanked = [];
			}
			launch.cwdQuery = seed ?? "";
			const state = nextCwdPickerState(launch.cwdQuery, launch.cwdRanked, launch.cwd);
			launch.cwdPickerMode = state.mode;
			launch.cwdSuggestions = state.suggestions;
			launch.cwdSuggestionIndex = 0;
			return;
		}
```

- [ ] **Step 7: handleLaunchPickerKey 加 tab 补全分支**

在 enter 处理分支结束、cwd 输入分支开始之间插入（锚点文本唯一）：

```ts
		}
		if (launch.picker === "cwd") {
			const next = this.applyLaunchQueryInput(launch.cwdQuery, data);
```

改为：

```ts
		}
		if (launch.picker === "cwd" && matchesKey(data, Key.tab)) {
			if (launch.cwdPickerMode === "favorites" && launch.cwdSuggestions.length > 0) {
				const completed = launch.cwdSuggestions[launch.cwdSuggestionIndex] ?? launch.cwdSuggestions[0];
				launch.cwdQuery = completed;
				const state = nextCwdPickerState(launch.cwdQuery, launch.cwdRanked, launch.cwd);
				launch.cwdPickerMode = state.mode;
				launch.cwdSuggestions = state.suggestions;
				launch.cwdSuggestionIndex = Math.max(0, state.suggestions.indexOf(completed));
			}
			return;
		}
		if (launch.picker === "cwd") {
			const next = this.applyLaunchQueryInput(launch.cwdQuery, data);
```

- [ ] **Step 8: cwd 输入分支切换到状态机**

```ts
		if (launch.picker === "cwd") {
			const next = this.applyLaunchQueryInput(launch.cwdQuery, data);
			if (next !== null) {
				launch.cwdQuery = next;
				launch.cwdSuggestions = listDirectorySuggestions(next, launch.cwd);
				launch.cwdSuggestionIndex = 0;
			}
			return;
		}
```

改为：

```ts
		if (launch.picker === "cwd") {
			const next = this.applyLaunchQueryInput(launch.cwdQuery, data);
			if (next !== null) {
				launch.cwdQuery = next;
				const state = nextCwdPickerState(next, launch.cwdRanked, launch.cwd);
				launch.cwdPickerMode = state.mode;
				launch.cwdSuggestions = state.suggestions;
				launch.cwdSuggestionIndex = 0;
			}
			return;
		}
```

（up/down/enter 处理不需要改：两个模式都走 `cwdSuggestions` + `cwdSuggestionIndex`，enter 的 `resolveDirectoryValue` 兜底逻辑不变。）

- [ ] **Step 9: submitDispatch 成功分支埋点**

```ts
		if (!res.ok) this.notice(res.error ?? "Dispatch failed", "error");
		else {
			this.lastLaunchPrefs = { ...this.deps.service.getLaunchPrefs?.(), cwd: launchCwd, model: launchModel, thinkingLevel: launchThinking };
```

改为：

```ts
		if (!res.ok) this.notice(res.error ?? "Dispatch failed", "error");
		else {
			this.lastLaunchPrefs = { ...this.deps.service.getLaunchPrefs?.(), cwd: launchCwd, model: launchModel, thinkingLevel: launchThinking };
			try {
				recordCwdLaunch(this.deps.root, launchCwd);
			} catch {
				/* best effort: stats must never block dispatch */
			}
```

- [ ] **Step 10: 验证**

Run: `npm test && npm run typecheck`
Expected: 全 PASS、typecheck 无错误。

- [ ] **Step 11: Commit**

```bash
git add src/commands/agent-board.ts src/ui/dashboard.ts
git commit -m "feat: wire cwd favorites state machine into launch picker (issue #22)"
```

---

### Task 4: 渲染（favorites 行带计数 + 模式提示文案）

**Files:**
- Modify: `src/ui/dashboard.ts`（`renderLaunch` 的 cwd picker 分支）

**Interfaces:**
- Consumes: `launch.cwdPickerMode` / `launch.cwdRanked`（Task 3 产出）、同文件私有 `renderLaunchSuggestions`、`displayPath`。

- [ ] **Step 1: renderLaunch cwd 分支按模式渲染**

```ts
		if (launch.picker === "cwd") {
			lines.push(t.fg("warning", `cwd› ${singleLineInput(launch.cwdQuery)}${cursor()}`));
			lines.push(...this.renderLaunchSuggestions(inner, launch.cwdSuggestions, launch.cwdSuggestionIndex, (value) => displayPath(value)));
			lines.push("");
			lines.push(t.fg("dim", "type to filter folders · enter choose · esc back"));
		} else if (launch.picker === "model") {
```

改为：

```ts
		if (launch.picker === "cwd") {
			lines.push(t.fg("warning", `cwd› ${singleLineInput(launch.cwdQuery)}${cursor()}`));
			if (launch.cwdPickerMode === "favorites") {
				const counts = new Map(launch.cwdRanked.map((entry) => [entry.path, entry.count]));
				lines.push(...this.renderLaunchSuggestions(inner, launch.cwdSuggestions, launch.cwdSuggestionIndex, (value) => {
					const count = counts.get(value) ?? 0;
					return `${displayPath(value)}${count > 0 ? `  ${count}×` : ""}`;
				}));
				lines.push("");
				lines.push(t.fg("dim", "常用目录 · type to search · tab complete · enter choose · esc back"));
			} else {
				lines.push(...this.renderLaunchSuggestions(inner, launch.cwdSuggestions, launch.cwdSuggestionIndex, (value) => displayPath(value)));
				lines.push("");
				lines.push(t.fg("dim", "type to filter folders · enter choose · esc back"));
			}
		} else if (launch.picker === "model") {
```

- [ ] **Step 2: 验证**

Run: `npm test && npm run typecheck`
Expected: 全 PASS、typecheck 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/ui/dashboard.ts
git commit -m "feat: render favorites rows with counts and mode hints (issue #22)"
```

---

### Task 5: 全量验证与手工验收

**Files:** 无代码改动；按需修 bug 并单独 commit。

- [ ] **Step 1: 全量检查**

Run: `npm run verify`（= typecheck + test + pack:dry）
Expected: 全部通过。

- [ ] **Step 2: 手工验收（本地 dev 加载）**

Dev 加载方式（README 记载）：`ln -sf "$(pwd)" ~/.pi/agent/extensions/agent-board`（指向 worktree 目录），重启 Pi 后 `/agent-board`。验收清单：

1. 打开 dashboard → 输入任务 → enter → launch 对话框 → cwd 字段 enter 进入选择器：
   - 未输入时列表 = 频率榜 Top 8（本机应见 `~ 107×`、zima-blue-cli、jfox 等），home 兜底在列
   - 首项高亮，↑↓ 移动，enter 直接选中
2. 输入 `jfox` → 列表只剩 `~/git-repo/github/jfox 17×`；**tab** → 输入框变为完整路径、picker 仍打开；回车 → 选中，字段显示 `~/git-repo/github/jfox`
3. 输入 `~` 或 `/tmp/xxx` → 回落文件系统浏览（旧行为），提示行变为 `type to filter folders …`
4. 主对话框 cwd 字段上直接打字（如 `j`）→ 直接带 seed 进入 picker 且匹配候选（type-to-jump 保留）
5. 发起一个 session 后：`jq . ~/.pi/agent/agent-board/cwd-stats.json` 中对应 cwd 计数 +1、lastUsed 更新；再次打开 picker 排名反映新计数
6. 删除某个 view 后计数不变（stats 独立）
7. `rm ~/.pi/agent/agent-board/cwd-stats.json` 后再打开 launch 对话框 → 自动从现有 views 重新 seed

- [ ] **Step 3: 验收通过后收尾**

```bash
git status --short   # 确认无意外文件；node_modules 为 symlink 不在版本控制
git log --oneline    # 确认本分支提交序列
```

提交 PR（工作流第 9 步 zima-pr-monitor 负责，不在此 plan 内）：推分支 `issue-22-launch-cwd-favorites` → 开 PR → 打 `zima:needs-review`。

---

## Notes

- 任务间依赖：Task 3 依赖 Task 1/2 的导出；Task 4 依赖 Task 3 的字段。必须顺序执行。
- 每步 `npm test` 都在 worktree 根目录运行；`node_modules` symlink 已就绪，无需 `npm install`。
- 若手工验收发现交互瑕疵（如 tab 补全后高亮索引错位），回到对应任务修，禁止直接改主仓库。
