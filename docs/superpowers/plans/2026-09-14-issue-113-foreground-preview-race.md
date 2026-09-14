# Issue 113 — Foreground Preview Read-Your-Writes Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让交互式前台会话的 `latestAssistantPreview` / `lastAgentActivityAt` 不再被 `agent_end` 的过期磁盘重建覆盖——idle 行恢复显示 assistant 最后回复的首句，而不是 "Needs instructions"。

**Spec:** `docs/superpowers/specs/2026-09-14-issue-113-foreground-preview-race-design.md`（v2，含规则证据链与备选否决）

**Architecture:** 新增一个进程内 read-your-writes 缓存模块（模块级单例，因为 `serviceFor()` 每事件新建 service 实例）。`writeForegroundState` 把投影中的非空 preview/活动时间戳记入缓存（非空总是覆盖、空值永不覆盖）；`syncRowEvent` 在每次从磁盘重建 status 后回填空字段。归档的两个真实写入点清理缓存。coordinator-off 直写路径行为不变。

**Tech Stack:** 纯 Node ESM `.mjs`，`node --test`，无新依赖；coordinator 测试复用 `test-support/ensure-coordinator-helper.mjs`。

## Global Constraints

- `$WT=/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-113-foreground-preview-cache`；所有读写用 `$WT` 绝对路径，git 一律 `git -C $WT ...`；**绝不写主仓库**。
- 文件缩进用 tab；纯 ESM `.mjs`；JSDoc 类型注释与仓库现有风格一致。
- 测试命令 `node --test test/<file>.mjs`（聚焦）与 `npm run typecheck && npm test`（全量）。
- commit 用英文 conventional commits；`git add <显式文件>`，禁止 `git add -A`。
- **缓存必须是模块级单例**（`serviceFor()` 每次调用都 `createService`，实例级缓存会失效）。
- 测试隔离：模块级缓存跨测试存活，service 测试必须在 `beforeEach` 调用 `foregroundPreviewCache.clear()`。
- 不改 coordinator 协议、`state-commands.mjs` 决策语义、legacy 路径。
- 只覆盖 `latestAssistantPreview` / `lastAgentActivityAt` 两个字段（其余字段见 spec 非目标）。

## 验收映射（spec 验收矩阵 ↔ plan task，双向可追溯）

| Task | 验收 ID | 交付物 |
|---|---|---|
| Task 1 | A1, A2 | `src/core/foreground-preview-cache.mjs` + 单元测试 |
| Task 2 | A3, A5, A7 | service 接线（remember/backfill）+ 延迟落盘竞态测试 + 测试隔离 beforeEach |
| Task 3 | A6 | 两个归档站点 forget + 路径测试 |
| Task 4 | A4 | 真实 coordinator 不变式测试 |
| Task 5 | A8, U1 | 全量回归 + 验收对账 + 用户实测清单 |

---

### Task 1: 缓存模块与单元测试

**Files:**
- Create: `$WT/src/core/foreground-preview-cache.mjs`
- Test: `$WT/test/foreground-preview-cache.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `createForegroundPreviewCache()` → `{ remember(viewId, projection): void, backfill(viewId, status): boolean, forget(viewId): boolean, clear(): void, size(): number }`
  - `foregroundPreviewCache`（模块级共享单例）
  - 规则：`remember` 非空覆盖、空值不覆盖；`backfill` 仅填空字段、磁盘非空优先，返回是否发生回填。

- [x] **Step 1: 写失败测试**

创建 `$WT/test/foreground-preview-cache.test.mjs`：

```js
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
```

- [x] **Step 2: 运行测试确认失败**

Run: `cd $WT && node --test test/foreground-preview-cache.test.mjs`
Expected: FAIL — `Cannot find module '../src/core/foreground-preview-cache.mjs'`

- [x] **Step 3: 写最小实现**

创建 `$WT/src/core/foreground-preview-cache.mjs`：

```js
/**
 * Process-local read-your-writes cache for foreground state projections
 * (issue #113).
 *
 * Foreground turns are mirrored into state.json through the detached View
 * State Coordinator: `message_end` sets `latestAssistantPreview` /
 * `lastAgentActivityAt` and fires a fire-and-forget `sync_foreground` command;
 * the coordinator journals + fsyncs before materializing the file. The next
 * event (`agent_end`, ~7ms later) rebuilds its in-memory status from the
 * still-stale state.json, derives the "Needs instructions" fallback summary and
 * overwrites the fresher projection that was still in flight.
 *
 * This cache restores read-your-writes for the two fields whose only legitimate
 * transitions are "empty → non-empty" and "old non-empty → new non-empty":
 * a non-empty value is always remembered, an empty value never overwrites a
 * known non-empty one, and a disk rebuild backfills only empty fields (the
 * materialized file stays authoritative whenever it has a value).
 *
 * Module-level by necessity: `serviceFor()` creates a new service instance per
 * call (src/index.ts), so a per-instance cache would be discarded between
 * events.
 */

/** @typedef {{ latestAssistantPreview: string, lastAgentActivityAt: number|null }} KnownForegroundFields */

/**
 * @returns {{
 *   remember: (viewId: string, projection: { latestAssistantPreview?: unknown, lastAgentActivityAt?: unknown }) => void,
 *   backfill: (viewId: string, status: { latestAssistantPreview?: unknown, lastAgentActivityAt?: unknown }) => boolean,
 *   forget: (viewId: string) => boolean,
 *   clear: () => void,
 *   size: () => number,
 * }}
 */
export function createForegroundPreviewCache() {
	/** @type {Map<string, KnownForegroundFields>} */
	const known = new Map();

	function remember(viewId, projection) {
		if (!viewId || !projection) return;
		const preview = projection.latestAssistantPreview;
		const activityAt = projection.lastAgentActivityAt;
		const hasPreview = typeof preview === "string" && preview.length > 0;
		const hasActivity = activityAt != null;
		if (!hasPreview && !hasActivity) return;
		const entry = known.get(viewId) ?? { latestAssistantPreview: "", lastAgentActivityAt: null };
		if (hasPreview) entry.latestAssistantPreview = preview;
		if (hasActivity) entry.lastAgentActivityAt = activityAt;
		known.set(viewId, entry);
	}

	function backfill(viewId, status) {
		if (!viewId || !status) return false;
		const entry = known.get(viewId);
		if (!entry) return false;
		let changed = false;
		if (entry.latestAssistantPreview && !status.latestAssistantPreview) {
			status.latestAssistantPreview = entry.latestAssistantPreview;
			changed = true;
		}
		if (entry.lastAgentActivityAt != null && status.lastAgentActivityAt == null) {
			status.lastAgentActivityAt = entry.lastAgentActivityAt;
			changed = true;
		}
		return changed;
	}

	function forget(viewId) {
		return known.delete(viewId);
	}

	function clear() {
		known.clear();
	}

	function size() {
		return known.size;
	}

	return { remember, backfill, forget, clear, size };
}

/** Shared cache used by the runtime service (module-level: see module doc). */
export const foregroundPreviewCache = createForegroundPreviewCache();
```

- [x] **Step 4: 运行测试确认通过**

Run: `cd $WT && node --test test/foreground-preview-cache.test.mjs`
Expected: PASS（7 tests）

- [x] **Step 5: typecheck**

Run: `cd $WT && npm run typecheck`
Expected: 无错误（若 JSDoc 报错，修正类型注释而非跳过）

- [x] **Step 6: Commit**

```bash
cd $WT
git -C $WT add src/core/foreground-preview-cache.mjs test/foreground-preview-cache.test.mjs
git -C $WT commit -m "feat(core): add foreground preview read-your-writes cache (issue #113)"
```

---

### Task 2: service 接线 + 竞态回归测试（含测试隔离）

**Files:**
- Modify: `$WT/src/runtime/service.mjs`（import 段；`writeForegroundState`；`syncRowEvent`）
- Test: `$WT/test/service.test.mjs`（import 段；顶部加 `beforeEach` 与 fake helper；新增竞态用例）

**Interfaces:**
- Consumes: Task 1 的 `foregroundPreviewCache`（`remember` / `backfill` / `clear`）。
- Produces: `writeForegroundState` 每次投影后写缓存；`syncRowEvent` 每次磁盘重建后回填。测试 helper `delayedMaterializingSendStateCommand(root, opts)`。

- [x] **Step 1: 写失败测试（红证）**

在 `$WT/test/service.test.mjs` 中：

(a) 修改 `node:test` import 行，加入 `beforeEach`：

```js
import { test, beforeEach } from "node:test";
```

(b) 在 `import { createService, shouldProbePtySupport } from "../src/runtime/service.mjs";` 之后新增：

```js
import { foregroundPreviewCache } from "../src/core/foreground-preview-cache.mjs";
```

(c) 在 `startTrackedCoordinator` helper 之后新增两个 helper：

```js
/** Reset the module-level preview cache between tests (issue #113). */
beforeEach(() => {
	foregroundPreviewCache.clear();
});

/**
 * Issue 113 fixture: a sendStateCommand stand-in that materializes
 * sync_foreground projections after a delay — the coordinator's fsync +
 * socket latency in miniature. Commands land in arrival order, exactly like
 * the real single writer. Non-sync kinds resolve a decided rejection.
 */
function delayedMaterializingSendStateCommand(root, { delayMs = 20 } = {}) {
	const applied = [];
	return {
		applied,
		send: (targetRoot, command) =>
			new Promise((resolve) => {
				if (command.kind !== "sync_foreground") {
					resolve({ status: "rejected", reason: "no_change", materializedRevision: 0 });
					return;
				}
				setTimeout(() => {
					const projection = command.payload?.projection ?? {};
					const current = readState(root, command.viewId) ?? {};
					writeState(root, { ...current, ...projection });
					applied.push(command);
					resolve({ status: "applied", reason: command.kind, materializedRevision: applied.length });
				}, delayMs);
			}),
	};
}
```

(d) 在既有用例 `test("syncForegroundEvent auto-completes foreground turn when auto-done flag is off", ...)` 之后新增竞态用例：

```js
test("issue 113: agent_end rebuild cannot clobber the in-flight message_end preview", async () => {
	const root = freshRoot();
	const prevCoordinator = setEnv("AGENT_BOARD_COORDINATOR", undefined);
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		const fake = delayedMaterializingSendStateCommand(root, { delayMs: 20 });
		const text = "All done with the long task.";
		// Mirror production: serviceFor() builds a fresh service per event, so the
		// cache must survive across instances.
		await service(root, { sendStateCommand: fake.send }).syncForegroundEvent(meta.sessionFile, { type: "agent_start" });
		await service(root, { sendStateCommand: fake.send }).syncForegroundEvent(meta.sessionFile, {
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
		});
		// agent_end reads state.json synchronously while the message_end write is
		// still delayed — the exact 0.7.0 race window.
		await service(root, { sendStateCommand: fake.send }).syncForegroundEvent(meta.sessionFile, { type: "agent_end" });

		const final = await waitFor(() => {
			const s = readState(root, "v1");
			return s?.semanticState === "idle" && s?.latestAssistantPreview === text ? s : null;
		}, 3000);
		assert.ok(final, "the last materialized projection keeps the assistant preview");
		assert.equal(final.summary, text);
		assert.equal(final.lastAgentActivityAt != null, true);
	} finally {
		setEnv("AGENT_BOARD_COORDINATOR", prevCoordinator);
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `cd $WT && node --test --test-name-pattern "issue 113: agent_end rebuild" test/service.test.mjs`
Expected: FAIL — `the last materialized projection keeps the assistant preview`（磁盘最终 preview 为空、summary 为 "Needs instructions"）。这就是 bug 的确定性复现。

- [x] **Step 3: 接线实现**

在 `$WT/src/runtime/service.mjs`：

(a) import 段（`follow-up-queue.mjs` import 之后）新增：

```js
import { foregroundPreviewCache } from "../core/foreground-preview-cache.mjs";
```

(b) `writeForegroundState` 中，`projected.currentRunId = null;` 之后、`if (coordinatorDisabled())` 之前新增：

```js
		foregroundPreviewCache.remember(row.meta.id, projected);
```

(c) `syncRowEvent` 中，`const status = statusFromRow(row);` 之后新增：

```js
		foregroundPreviewCache.backfill(row.meta.id, status);
```

- [x] **Step 4: 运行新测试与既有前台回归**

Run: `cd $WT && node --test --test-name-pattern "issue 113: agent_end rebuild" test/service.test.mjs`
Expected: PASS

Run: `cd $WT && node --test --test-name-pattern "syncForegroundEvent" test/service.test.mjs`
Expected: 全部 PASS（A5：直写模式与既有行为不回归）

- [x] **Step 5: Commit**

```bash
cd $WT
git -C $WT add src/runtime/service.mjs test/service.test.mjs
git -C $WT commit -m "fix(service): keep foreground preview across coordinator write lag (issue #113)"
```

---

### Task 3: 归档清理（两个真实站点）

**Files:**
- Modify: `$WT/src/runtime/service.mjs`（`archiveView`、`archiveByState`）
- Test: `$WT/test/service.test.mjs`（新增两个用例）

**Interfaces:**
- Consumes: Task 1 的 `foregroundPreviewCache.forget`。
- Produces: 归档后缓存无该 viewId 条目（`archive` / `archiveMany`→`archiveView`、`archiveByState` 两条路径）。

- [x] **Step 1: 写失败测试**

在 `$WT/test/service.test.mjs` 新增（紧邻 Task 2 的用例之后）：

```js
test("issue 113: archiving a row evicts its preview cache entry", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		createView(root, { id: "v2", name: "b", cwd: "/r" });
		foregroundPreviewCache.remember("v1", { latestAssistantPreview: "one", lastAgentActivityAt: 1 });
		foregroundPreviewCache.remember("v2", { latestAssistantPreview: "two", lastAgentActivityAt: 2 });

		const res = await service(root).archive("v1");
		assert.equal(res.ok, true);
		assert.equal(foregroundPreviewCache.size(), 1, "only the archived view's entry is evicted");
		assert.equal(foregroundPreviewCache.backfill("v1", { latestAssistantPreview: "", lastAgentActivityAt: null }), false);
		assert.equal(foregroundPreviewCache.backfill("v2", { latestAssistantPreview: "", lastAgentActivityAt: null }), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("issue 113: archiveByState evicts preview cache entries for archived rows", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		createView(root, { id: "v2", name: "b", cwd: "/r" });
		foregroundPreviewCache.remember("v1", { latestAssistantPreview: "one", lastAgentActivityAt: 1 });
		foregroundPreviewCache.remember("v2", { latestAssistantPreview: "two", lastAgentActivityAt: 2 });
		const s = readState(root, "v1");
		s.semanticState = "completed";
		s.processState = "exited";
		writeState(root, s);

		const res = service(root).archiveByState("completed");
		assert.equal(res.archived, 1);
		assert.equal(foregroundPreviewCache.size(), 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `cd $WT && node --test --test-name-pattern "evicts" test/service.test.mjs`
Expected: FAIL — `expected 1 to be 2`（缓存未清理）

- [x] **Step 3: 实现 forget**

在 `$WT/src/runtime/service.mjs`：

(a) `archiveView` 中，`row.meta.archived = true;` 之前新增：

```js
		foregroundPreviewCache.forget(viewId);
```

(b) `archiveByState` 循环中，`row.meta.archived = true;` 之前新增：

```js
				foregroundPreviewCache.forget(row.meta.id);
```

- [x] **Step 4: 运行测试确认通过**

Run: `cd $WT && node --test --test-name-pattern "evicts" test/service.test.mjs`
Expected: PASS（2 tests）

- [x] **Step 5: Commit**

```bash
cd $WT
git -C $WT add src/runtime/service.mjs test/service.test.mjs
git -C $WT commit -m "fix(service): evict preview cache on archive (issue #113)"
```

---

### Task 4: 真实 coordinator 不变式测试

**Files:**
- Test: `$WT/test/service.test.mjs`（新增用例）
- 复用: `startTrackedCoordinator` / `waitFor`（同文件顶部），`test-support/ensure-coordinator-helper.mjs`

**Interfaces:**
- Consumes: Task 2 的 service 接线。
- Produces: 真实 coordinator（fsync + socket 往返）下的不变式验证——任何时序下最终状态 preview 必须保留。

- [x] **Step 1: 写测试**

在 `$WT/test/service.test.mjs` 新增（紧邻 Task 3 的用例之后）：

```js
test("issue 113: real coordinator keeps the assistant preview through a foreground turn", async () => {
	const root = freshRoot();
	const { coord, restore } = await startTrackedCoordinator(root);
	try {
		const meta = createView(root, { id: "v1", name: "a", cwd: "/r" });
		const text = "Coordinator round trip keeps this preview.";
		await service(root).syncForegroundEvent(meta.sessionFile, { type: "agent_start" });
		await service(root).syncForegroundEvent(meta.sessionFile, {
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
		});
		await service(root).syncForegroundEvent(meta.sessionFile, { type: "agent_end" });

		const final = await waitFor(() => {
			const s = readState(root, "v1");
			return s?.latestAssistantPreview === text ? s : null;
		});
		assert.ok(final, "preview survives the real coordinator round trip");
		assert.notEqual(final.summary, "Needs instructions");
		assert.equal(final.lastAgentActivityAt != null, true);
		// Let in-flight fire-and-forget beats settle against the tracked
		// coordinator before kill (see the input-mirror test above).
		await new Promise((resolve) => setTimeout(resolve, 150));
	} finally {
		await coord.kill();
		restore();
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [x] **Step 2: 运行测试确认通过**

Run: `cd $WT && node --test --test-name-pattern "real coordinator keeps the assistant preview" test/service.test.mjs`
Expected: PASS

- [x] **Step 3: 红/绿自证（可选但推荐）**

临时注释掉 Task 2 Step 3(c) 的 `backfill` 行 → 运行该用例与 A3 用例，确认二者失败 → 恢复该行 → 再次确认通过。**不要提交注释状态**。

- [x] **Step 4: Commit**

```bash
cd $WT
git -C $WT add test/service.test.mjs
git -C $WT commit -m "test(service): real-coordinator preview invariant (issue #113)"
```

---

### Task 5: 全量回归与验收对账（含用户实测清单）

**Files:**
- 无生产代码改动（除非回归暴露问题，那就回到对应 Task 修复）

**Interfaces:**
- Consumes: Task 1–4 的全部改动。
- Produces: 全量绿 + 逐项验收证据；U1 用户实测清单。

- [x] **Step 1: 全量回归**

Run: `cd $WT && npm run typecheck && npm test`
Expected: 全绿（A8）。若有失败，回到对应 Task 修复后重跑。

- [x] **Step 2: 逐项验收对账**

按 spec 验收矩阵逐条记录实际执行的命令与结果：

| ID | 命令 | 结果 |
|---|---|---|
| A1 / A2 | `node --test test/foreground-preview-cache.test.mjs` | PASS（记录数量） |
| A3 | `node --test --test-name-pattern "issue 113" test/service.test.mjs` | PASS（含移除缓存时失败的已验证红证） |
| A4 | 同上（真实 coordinator 用例） | PASS |
| A5 | 既有 `syncForegroundEvent*` 用例 | PASS |
| A6 | 归档两用例 | PASS |
| A7 | `beforeEach` 清缓存已落地（service.test.mjs） | 已落地 |
| A8 | `npm run typecheck && npm test` | PASS |

- [x] **Step 3: 记录 U1 用户实测清单（交给用户执行）**

实操步骤与通过标准：

1. 将修复安装到实际运行的扩展（或从 worktree 链接/安装），**重启 pi 会话**（进程内缓存只对新代码加载后的事件生效）。
2. 在一个交互式（前台）会话里完成一轮带 assistant 文本回复的对话，等待该行进入 idle。
3. 观察 dashboard 行摘要：应显示 assistant 最后回复的首句；不应为 "Needs instructions"。
4. 可选核对：`~/.pi/.../views/<viewId>/state-journal.jsonl` 中该 run 的 `sync_foreground` 序列里，最终一条的 `projection.latestAssistantPreview` 非空。
5. **前提**：修复前已被写坏的行（磁盘 preview 为空）不会追溯治愈；需等该会话下一轮 `message_end` 才会恢复正常显示。

- [x] **Step 4: 交付说明（写入 issue 评论草稿，供 PR 阶段使用）**

内容包含：修复机制一句话、A1–A8 实测证据、U1 前提与清单、遗留边界（见 spec 非目标）。

- [x] **Step 5: Commit（如有对账文档产物则提交，否则本 task 无 commit）**

```bash
cd $WT
git -C $WT status --short
# 若产生文档改动（例如 plan 勾选状态）：
git -C $WT add docs/superpowers/plans/2026-09-14-issue-113-foreground-preview-race.md
git -C $WT commit -m "docs(plan): mark issue 113 acceptance reconciliation"
```

---

## Self-Review 记录（写完计划后自查）

- **Spec 覆盖**：A1–A8、U1 全部映射到 Task 1–5（见顶部映射表）；spec 的"模块级单例""测试隔离""两个归档站点""延迟落盘 fake""真实 coordinator 不变式"分别落到 Task 1/2/3/4。
- **占位符扫描**：无 TBD/TODO；所有测试与实现代码均为可执行内容；断言基于已核实的行为（`deriveSummary` 对单句文本返回全文，`applyAutoStateToStatus` 之后 summary 仍为首句）。
- **类型一致性**：`createForegroundPreviewCache` 的 `remember/backfill/forget/clear/size` 在 Task 1 定义，Task 2/3 与测试使用的名称与签名一致；测试 helper `delayedMaterializingSendStateCommand` 在 Task 2 定义并在 Task 2 用例中使用（Task 4 不用它）。
