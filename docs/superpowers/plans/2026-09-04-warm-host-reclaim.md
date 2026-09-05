# Warm-Host Sweep Reclaim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让空闲 PTY host 的回收（TTL 10min / MAX_WARM 4，设计已有但只惰性触发）真正生效：周期 sweep + 宿主启动即 sweep + session_shutdown 清理，消除 detach 后无限期进程泄漏（实测 8.5h）。

**Architecture:** 把淘汰判定提取为纯函数 `selectIdleHostsToEvict`（新增 graceMs 豁免防 attach 竞态）→ 新增调度器 `createWarmHostSweeper`（周期 + unref）→ `attachWarmHostSweeper` 生命周期接线函数（非 child 宿主启动即 sweep、session_shutdown 清理；isHostedChild no-op）→ service.mjs 暴露 `pruneWarmHosts` 服务方法供接线调用。

**Tech Stack:** Node ≥20（node:test，mjs），pi 扩展（pi.on 事件 API），无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-04-warm-host-reclaim-design.md`

## Global Constraints

- 本仓库测试命令：`node --test test/*.test.mjs`（Windows 本机直接可跑；既有基线含 16-17 个已知环境性失败，见知识库笔记，**以无新增失败为准**）；typecheck：`npm run typecheck`
- 所有源文件为 .mjs（node:test）；`src/index.ts` 是唯一 .ts 改动点（类型不严，import mjs 无类型可容忍）
- 现有环境变量别名必须保留：`AGENT_BOARD_*` 主名 + `AGENT_VIEW_*` legacy 别名（envInt 第五参 legacyName）
- **isHostedChild 必须 no-op**：child pi 内 sweep 会向自己的 runner 发 terminate（自杀链），环境变量 `AGENT_BOARD_CHILD=1` / `AGENT_VIEW_CHILD=1`
- 淘汰判定语义（spec §2 M1，与原 pruneWarmHosts 等价）：idle = hostAlive && !isAgentBusy && attachedClients===0 && 非 keepViewId；TTL 淘汰 → survivors 按 idleSince 升序超额淘汰；`maxWarm===0 && ttlMs===0` = 整体禁用
- **Spec 偏差记录**：spec §2 M4（dashboard POLL_MS 轮询顺带 prune）**取消**——POLL_MS=700ms 周期做全量 listRows（每行读 meta/state/host 三文件）磁盘 IO 不划算；60s 周期 sweep 已覆盖 dashboard 打开场景。不引入对应代码与验收。
- 验收矩阵（spec §4）：A1-A5 unit / A6-A7 integration / A8 全量回归 / U1 用户实测

---

### Task 1: 纯判定函数 `selectIdleHostsToEvict` + busy 判定迁入新模块

**Files:**
- Create: `src/core/warm-host-sweeper.mjs`
- Create: `test/warm-host-sweeper.test.mjs`
- Modify: `src/runtime/service.mjs`（isAgentBusy/hasPendingQuestions 本地定义删除，改为 import；仅此，pruneWarmHosts 重构在 Task 3）

**Interfaces:**
- Produces: `selectIdleHostsToEvict(rows, opts) -> { ttlEvicted: string[], excessEvicted: string[] }`；`isAgentBusy(row) -> boolean`；`hasPendingQuestions(row) -> boolean`
- Consumes: `listRows(root)` 的 Row 结构（`{ meta:{id,updatedAt}, alive, hostAlive, host:{state,attachedClients,startedAt,runnerPid}|null, state:{semanticState,lastActivityAt,pendingQuestions,processState,currentRunId}|null }`）

**验收:** A1, A2, A3, A4（unit）

- [ ] **Step 1: 写 failing 测试** `test/warm-host-sweeper.test.mjs`

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAgentBusy, selectIdleHostsToEvict } from "../src/core/warm-host-sweeper.mjs";

// ---- rows fixture helpers（内存构造，不触盘）----
const NOW = 1_800_000_000_000;
const now = () => NOW;
/** idle 可淘汰 host：hostAlive、非 busy、无客户端、startedAt 很久以前 */
function idleRow(id, overrides = {}) {
	return {
		meta: { id, updatedAt: NOW - 3600_000 },
		alive: false,
		hostAlive: true,
		host: { state: "alive", attachedClients: 0, startedAt: NOW - 3600_000, runnerPid: 9999 },
		state: { semanticState: "completed", processState: "exited", lastActivityAt: NOW - 3600_000, pendingQuestions: [] },
		...overrides,
	};
}
const opts = (overrides = {}) => ({ now: now(), maxWarm: 4, ttlMs: 600_000, graceMs: 30_000, keepViewId: null, ...overrides });

test("A1: ttl 到期的 idle host 进入 ttlEvicted", () => {
	const r = selectIdleHostsToEvict([idleRow("v1")], opts());
	assert.deepEqual(r.ttlEvicted, ["v1"]);
	assert.deepEqual(r.excessEvicted, []);
});

test("A1: ttl 未到期（lastActivity 距今 < ttl）保留", () => {
	const r = selectIdleHostsToEvict([idleRow("v1", { state: { semanticState: "completed", processState: "exited", lastActivityAt: NOW - 60_000, pendingQuestions: [] } })], opts());
	assert.deepEqual(r.ttlEvicted, []);
	assert.deepEqual(r.excessEvicted, []);
});

test("A1: keepViewId 豁免", () => {
	const r = selectIdleHostsToEvict([idleRow("v1")], opts({ keepViewId: "v1" }));
	assert.deepEqual(r.ttlEvicted, []);
});

test("A2: busy host 永不淘汰（queued/working/pendingQuestions）", () => {
	for (const [label, patch] of [
		["working", { alive: true, state: { semanticState: "working", processState: "alive", pendingQuestions: [], lastActivityAt: NOW - 3600_000 } }],
		["queued", { alive: true, state: { semanticState: "queued", processState: "alive", pendingQuestions: [], lastActivityAt: NOW - 3600_000 } }],
		["pendingQuestions", { alive: true, state: { semanticState: "idle", processState: "alive", pendingQuestions: ["q"], lastActivityAt: NOW - 3600_000 } }],
	]) {
		const r = selectIdleHostsToEvict([idleRow("v1", patch)], opts());
		assert.deepEqual(r.ttlEvicted, [], label);
	}
});

test("A2: attachedClients>0 永不淘汰", () => {
	const r = selectIdleHostsToEvict([idleRow("v1", { host: { state: "alive", attachedClients: 1, startedAt: NOW - 3600_000, runnerPid: 9999 } })], opts());
	assert.deepEqual(r.ttlEvicted, []);
	assert.deepEqual(r.excessEvicted, []);
});

test("A2: hostAlive=false 不淘汰", () => {
	const r = selectIdleHostsToEvict([idleRow("v1", { hostAlive: false })], opts());
	assert.deepEqual(r.ttlEvicted, []);
});

test("A3: graceMs 豁免窗口内（startedAt 距今 < grace）不淘汰；窗口外淘汰", () => {
	const fresh = idleRow("v1", { host: { state: "alive", attachedClients: 0, startedAt: NOW - 5_000, runnerPid: 9999 } });
	assert.deepEqual(selectIdleHostsToEvict([fresh], opts()).ttlEvicted, []);
	const aged = idleRow("v1", { host: { state: "alive", attachedClients: 0, startedAt: NOW - 120_000, runnerPid: 9999 } });
	assert.deepEqual(selectIdleHostsToEvict([aged], opts()).ttlEvicted, ["v1"]);
});

test("A3: startedAt 缺失时不做 grace 豁免（按 ttl 判）", () => {
	const noStarted = idleRow("v1", { host: { state: "alive", attachedClients: 0, runnerPid: 9999 } });
	assert.deepEqual(selectIdleHostsToEvict([noStarted], opts()).ttlEvicted, ["v1"]);
});

test("A4: maxWarm 超额淘汰最旧 survivors（idleSince 升序）", () => {
	const older = idleRow("old", { state: { semanticState: "completed", processState: "exited", lastActivityAt: NOW - 100_000, pendingQuestions: [] } });
	const newer = idleRow("new", { state: { semanticState: "completed", processState: "exited", lastActivityAt: NOW - 50_000, pendingQuestions: [] } });
	// ttl 600s 内都不触发 ttl；maxWarm=1 → 淘汰最旧的 old
	const r = selectIdleHostsToEvict([newer, older], opts({ maxWarm: 1 }));
	assert.deepEqual(r.excessEvicted, ["old"]);
});

test("A4: maxWarm=0 且 ttlMs=0 返回空（整体禁用语义在调用方；此处按传入参数执行）", () => {
	// 纯函数无早退：ttlMs=0 不走 ttl（保持原逻辑 ttlMs>0 条件），maxWarm=0 → 全淘汰
	const r = selectIdleHostsToEvict([idleRow("v1")], opts({ maxWarm: 0, ttlMs: 0 }));
	assert.deepEqual(r.ttlEvicted, []);
	assert.deepEqual(r.excessEvicted, ["v1"]);
});

test("isAgentBusy 语义保持", () => {
	assert.equal(isAgentBusy(idleRow("x")), false);
	assert.equal(isAgentBusy(idleRow("x", { alive: true, state: { semanticState: "working", processState: "alive", pendingQuestions: [] } })), true);
	assert.equal(isAgentBusy(idleRow("x", { alive: true, state: { semanticState: "idle", processState: "alive", pendingQuestions: ["q"] } })), true);
});
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `node --test test/warm-host-sweeper.test.mjs`
Expected: FAIL（模块不存在，ERR_MODULE_NOT_FOUND）

- [ ] **Step 3: 实现 `src/core/warm-host-sweeper.mjs`**

```js
/**
 * Warm-host sweep reclaim (issue #75).
 *
 * Idle PTY hosts must not live forever: after detach the runner is a detached
 * orphan that nothing else will reap (Windows has no parent-death cascade, and
 * the dashboard host may exit without a cleanup hook). The design intent
 * (AGENT_BOARD_WARM_HOST_TTL_MS / MAX_WARM_HOSTS) already exists in
 * service.mjs pruneWarmHosts but only fires lazily on attach/prewarm/dispatch.
 * This module extracts the pure eviction decision plus a periodic sweeper so
 * the TTL actually runs.
 */

/** @param {import("./store.mjs").Row} row */
export function hasPendingQuestions(row) {
	return Array.isArray(row.state?.pendingQuestions) && row.state.pendingQuestions.length > 0;
}

/**
 * Busy = an agent run is active (queued/working) or the session is waiting on
 * user questions. Idle/completed/failed/stopped are never busy.
 * @param {import("./store.mjs").Row} row
 */
export function isAgentBusy(row) {
	const st = row.state?.semanticState;
	return Boolean(row.alive && (st === "queued" || st === "working" || hasPendingQuestions(row)));
}

/**
 * Pure eviction decision for warm PTY hosts. No IO, no env: every threshold is
 * passed in so the logic is directly unit-testable.
 *
 * idle = host alive && !busy && no attached clients && not keepViewId.
 * graceMs exempts freshly started hosts (attach handoff race: ensureHost has
 * started a host but the client has not connected yet).
 * TTL eviction runs first; survivors over maxWarm are evicted oldest-first by
 * idleSince (state.lastActivityAt ?? host.startedAt ?? meta.updatedAt).
 *
 * @param {Array<import("./store.mjs").Row>} rows
 * @param {{ now: number, maxWarm: number, ttlMs: number, graceMs?: number, keepViewId?: string|null }} o
 * @returns {{ ttlEvicted: string[], excessEvicted: string[] }} viewIds, ttl group first
 */
export function selectIdleHostsToEvict(rows, { now, maxWarm, ttlMs, graceMs = 0, keepViewId = null }) {
	const idle = [];
	for (const row of rows) {
		if (keepViewId != null && row.meta.id === keepViewId) continue;
		if (!row.hostAlive) continue;
		if (isAgentBusy(row)) continue;
		if ((row.host?.attachedClients ?? 0) !== 0) continue;
		const startedAt = row.host?.startedAt;
		if (graceMs > 0 && startedAt != null && now - startedAt < graceMs) continue;
		const idleSince = row.state?.lastActivityAt ?? startedAt ?? row.meta.updatedAt;
		idle.push({ id: row.meta.id, idleSince });
	}
	const ttlEvicted = [];
	const survivors = [];
	for (const it of idle) {
		// Keep the historical semantics: ttlMs === 0 disables the ttl branch
		// (only the maxWarm cap applies); both zero disables eviction entirely.
		if (ttlMs > 0 && now - it.idleSince > ttlMs) ttlEvicted.push(it.id);
		else survivors.push(it);
	}
	survivors.sort((a, b) => a.idleSince - b.idleSince);
	const excess = Math.max(0, survivors.length - maxWarm);
	return { ttlEvicted, excessEvicted: survivors.slice(0, excess).map((it) => it.id) };
}
```

- [ ] **Step 4: 切换 service.mjs 的 busy 判定为 import（删除本地重复定义）**

在 `src/runtime/service.mjs`：
1. imports 区（约 35 行 `import { normalizeScreenLogMaxBytes...` 之后）加：

```js
import { isAgentBusy, selectIdleHostsToEvict } from "../core/warm-host-sweeper.mjs";
```

2. 删除模块尾部两个本地函数（1098 行附近）：

```js
/** @param {import("../core/store.mjs").Row} row */
function hasPendingQuestions(row) {
	return Array.isArray(row.state?.pendingQuestions) && row.state.pendingQuestions.length > 0;
}

/** @param {import("../core/store.mjs").Row} row */
function isAgentBusy(row) {
	const st = row.state?.semanticState;
	return Boolean(row.alive && (st === "queued" || st === "working" || hasPendingQuestions(row)));
}
```

（hasPendingQuestions 一并删除：`isAgentBusy` 新实现内置同逻辑；先确认 service.mjs 无其他 hasPendingQuestions 引用：`grep -n "hasPendingQuestions" src/runtime/service.mjs` 应只剩删除区两行。）

- [ ] **Step 5: 全量跑测试确认无回归**

Run: `node --test test/*.test.mjs`
Expected: 与基线一致（本机基线含已知 Windows 环境性失败 16-17 个；`test/warm-host-sweeper.test.mjs` 全过）

- [ ] **Step 6: Commit**

```bash
git add src/core/warm-host-sweeper.mjs test/warm-host-sweeper.test.mjs src/runtime/service.mjs
git commit -m "feat: pure warm-host eviction selector with grace exemption (issue #75)"
```

---

### Task 2: 调度器 `createWarmHostSweeper` + 生命周期接线函数

**Files:**
- Modify: `src/core/warm-host-sweeper.mjs`（追加两个导出）
- Modify: `test/warm-host-sweeper.test.mjs`（追加用例）

**Interfaces:**
- Produces: `createWarmHostSweeper({ sweep, intervalMs }) -> { start(), stop(), sweepNow(), active }`；`attachWarmHostSweeper(pi, { isHostedChild, sweep, intervalMs }) -> { dispose(), active }`
- Consumes: Task 1 模块；调用方（Task 4 index.ts）提供 sweep 闭包与 intervalMs

**验收:** A5（unit），A6 的接线语义部分（child no-op / 启动即 sweep / shutdown 时 sweepNow+stop，用 fake pi 与 fake sweep）

- [ ] **Step 1: 写 failing 测试（追加到 `test/warm-host-sweeper.test.mjs`）**

```js
import { attachWarmHostSweeper, createWarmHostSweeper } from "../src/core/warm-host-sweeper.mjs";

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test("A5: createWarmHostSweeper 周期触发 sweep；stop 后不再触发；sweepNow 立即执行", async () => {
	let calls = 0;
	const sweeper = createWarmHostSweeper({ sweep: () => { calls += 1; }, intervalMs: 20 });
	sweeper.start();
	await sleepMs(75); // ≥3 个周期
	assert.ok(calls >= 2, `expected >=2 periodic sweeps, got ${calls}`);
	sweeper.stop();
	const after = calls;
	await sleepMs(50);
	assert.equal(calls, after, "stop 后不得再触发");
	sweeper.sweepNow();
	assert.equal(calls, after + 1);
});

test("A5: intervalMs<=0 时 start 不启周期，sweepNow 仍可用", async () => {
	let calls = 0;
	const sweeper = createWarmHostSweeper({ sweep: () => { calls += 1; }, intervalMs: 0 });
	sweeper.start();
	await sleepMs(40);
	assert.equal(calls, 0);
	sweeper.sweepNow();
	assert.equal(calls, 1);
});

test("A5: start 幂等（重复 start 不叠加定时器）", async () => {
	let calls = 0;
	const sweeper = createWarmHostSweeper({ sweep: () => { calls += 1; }, intervalMs: 20 });
	sweeper.start();
	sweeper.start();
	await sleepMs(60);
	assert.ok(calls >= 1);
	sweeper.stop();
});

test("A6(接线): 非 child：启动即 sweep 一次 + 注册 session_shutdown；shutdown 触发 sweepNow+stop", async () => {
	const events = {};
	const fakePi = { on: (ev, fn) => { events[ev] = fn; } };
	let sweeps = 0;
	const attached = attachWarmHostSweeper(fakePi, {
		isHostedChild: false,
		sweep: () => { sweeps += 1; },
		intervalMs: 0, // 关周期，只验启动与 shutdown 语义
	});
	assert.equal(sweeps, 1, "启动即 sweep 一次");
	assert.equal(typeof events.session_shutdown, "function", "注册了 session_shutdown");
	events.session_shutdown();
	assert.equal(sweeps, 2, "shutdown 时 sweepNow");
	attached.dispose();
});

test("A6(接线): child：完全 no-op（不 sweep、不注册、active=false）", () => {
	const events = {};
	const fakePi = { on: (ev, fn) => { events[ev] = fn; } };
	let sweeps = 0;
	const attached = attachWarmHostSweeper(fakePi, {
		isHostedChild: true,
		sweep: () => { sweeps += 1; },
		intervalMs: 1000,
	});
	assert.equal(attached.active, false);
	assert.equal(sweeps, 0);
	assert.equal(events.session_shutdown, undefined);
	attached.dispose();
});
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `node --test test/warm-host-sweeper.test.mjs`
Expected: FAIL（createWarmHostSweeper / attachWarmHostSweeper 未定义）

- [ ] **Step 3: 实现（追加到 `src/core/warm-host-sweeper.mjs` 尾部）**

```js
/**
 * Periodic sweeper for warm hosts. The interval timer is unref'd so it never
 * holds the host pi's event loop open on exit. intervalMs <= 0 disables the
 * periodic part; sweepNow() always works.
 * @param {{ sweep: () => void, intervalMs: number }} o
 */
export function createWarmHostSweeper({ sweep, intervalMs }) {
	let timer = null;
	let stopped = false;
	return {
		active: true,
		start() {
			if (stopped || timer !== null) return;
			if (intervalMs > 0) {
				timer = setInterval(() => {
					try { sweep(); } catch { /* best-effort */ }
				}, intervalMs);
				if (typeof timer.unref === "function") timer.unref();
			}
		},
		sweepNow() {
			if (stopped) return;
			try { sweep(); } catch { /* best-effort */ }
		},
		stop() {
			stopped = true;
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}

/**
 * Wire the sweeper to a host pi extension lifetime: sweep once on attach
 * (reclaims hosts leaked by a previous host that died without cleanup), run
 * periodically, and sweep again on session_shutdown (host pi exiting or the
 * extension instance being reloaded for a session switch).
 *
 * Child pi processes (AGENT_BOARD_CHILD=1 / AGENT_VIEW_CHILD=1) must never
 * sweep: they share the same board root and would terminate their own runner
 * (suicide chain). They get a strict no-op.
 *
 * @param {{ on?: (event: string, fn: () => void) => unknown }} pi
 * @param {{ isHostedChild: boolean, sweep: () => void, intervalMs: number }} o
 */
export function attachWarmHostSweeper(pi, { isHostedChild, sweep, intervalMs }) {
	if (isHostedChild) {
		return { active: false, dispose() {} };
	}
	const sweeper = createWarmHostSweeper({ sweep, intervalMs });
	const onShutdown = () => {
		sweeper.sweepNow();
		sweeper.stop();
	};
	pi.on?.("session_shutdown", onShutdown);
	sweeper.start();
	sweeper.sweepNow(); // 回收上一个宿主（可能非正常退出）遗留的 warm hosts
	return {
		active: true,
		dispose() {
			onShutdown();
		},
	};
}
```

- [ ] **Step 4: 跑测试确认过**

Run: `node --test test/warm-host-sweeper.test.mjs`
Expected: 全部 PASS（真定时器 20ms 周期测试约需 200ms 实耗）

- [ ] **Step 5: Commit**

```bash
git add src/core/warm-host-sweeper.mjs test/warm-host-sweeper.test.mjs
git commit -m "feat: periodic warm-host sweeper + host-pi lifecycle wiring (issue #75)"
```

---

### Task 3: service.mjs 的 pruneWarmHosts 重构（纯函数调用 + grace env）+ 暴露服务方法

**Files:**
- Modify: `src/runtime/service.mjs`
  - `pruneWarmHosts` 函数体（现 404-432 行附近）
  - createService 返回对象尾部（`row(viewId)` 方法之后、`};` 之前，约 1090 行）加服务方法
  - `envInt` 加 export（1177 行）

**Interfaces:**
- Consumes: Task 1 `selectIdleHostsToEvict`；现有 `envInt`、`listRows`、`loadRow`、`sendHostMessage`（均 service.mjs 闭包内）
- Produces: createService 返回值新增方法 `pruneWarmHosts(pruneOpts?: { keepViewId?: string|null }) -> void`；`export function envInt`（index.ts Task 4 用）

**验收:** A3（env 接线），A8（重构等价回归）

- [ ] **Step 1: 重构 `pruneWarmHosts`（替换现有 404-432 行函数体）**

现有函数（含 warm pool 注释与 maxWarm/ttlMs 读取）替换为：

```js
	/**
	 * Evict idle warm PTY hosts past TTL / over the warm pool cap.
	 * Idle = host alive, not agent-busy, no attached clients.
	 * Called lazily from dispatch/ensureHost (keepViewId = the view being used)
	 * and periodically / on shutdown by the warm-host sweeper (issue #75).
	 * @param {{ keepViewId?: string|null }} [pruneOpts]
	 */
	function pruneWarmHosts(pruneOpts = {}) {
		const maxWarm = envInt("AGENT_BOARD_MAX_WARM_HOSTS", 4, 0, 50, "AGENT_VIEW_MAX_WARM_HOSTS");
		const ttlMs = envInt("AGENT_BOARD_WARM_HOST_TTL_MS", 10 * 60 * 1000, 0, 24 * 60 * 60 * 1000, "AGENT_VIEW_WARM_HOST_TTL_MS");
		if (maxWarm === 0 && ttlMs === 0) return;
		const graceMs = envInt("AGENT_BOARD_WARM_HOST_GRACE_MS", 30 * 1000, 0, 24 * 60 * 60 * 1000, "AGENT_VIEW_WARM_HOST_GRACE_MS");
		const { ttlEvicted, excessEvicted } = selectIdleHostsToEvict(listRows(root), {
			now: Date.now(),
			maxWarm,
			ttlMs,
			graceMs,
			keepViewId: pruneOpts.keepViewId ?? null,
		});
		for (const viewId of [...ttlEvicted, ...excessEvicted]) {
			const row = loadRow(root, viewId);
			if (row?.hostAlive) sendHostMessage(row, { type: "terminate" });
		}
	}
```

注意：原实现直接对 listRows 结果发 terminate（行即最新）；改为淘汰后按 viewId `loadRow` 复查 `hostAlive`——**消除 listRows 与发消息之间的竞态窗口**（原实现同样竞态，此行改动是净改善且行为等价：host 已死则跳过）。

- [ ] **Step 2: createService 返回对象暴露服务方法**（`row(viewId)` 方法后加）

```js
		/**
		 * Evict idle warm PTY hosts (TTL / warm-pool cap). Safe to call anytime:
		 * busy and attached hosts are never touched.
		 * @param {{ keepViewId?: string|null }} [pruneOpts]
		 */
		pruneWarmHosts(pruneOpts = {}) {
			pruneWarmHosts(pruneOpts);
		},
```

（方法体内裸标识符 `pruneWarmHosts` 词法解析到闭包函数——方法名不在方法体内自绑定，合法且无歧义。）

- [ ] **Step 3: envInt 加 export**（1177 行 `function envInt` → `export function envInt`）

- [ ] **Step 4: 验证**

Run: `node --test test/*.test.mjs`
Expected: 无新增失败（与基线一致）；新用例暂无——Task 4 的 integration 测试覆盖本任务产出

- [ ] **Step 5: Commit**

```bash
git add src/runtime/service.mjs
git commit -m "refactor: pruneWarmHosts via pure selector + grace env, expose service method (issue #75)"
```

---

### Task 4: integration 测试——真实行 + net server 捕获 terminate

**Files:**
- Create: `test/warm-host-sweep.integration.test.mjs`

**Interfaces:**
- Consumes: Task 1-3（`createService(...).pruneWarmHosts`、store 基建 `createView/writeState/writeHost/writeHostPid`、`P.controlSocketPath`）；Task 2 `attachWarmHostSweeper`
- Produces: 无（纯验证）

**验收:** A6（integration：idle 收 terminate / busy 不收 / 启动即 sweep）、A7（session_shutdown 触发 sweepNow）

- [ ] **Step 1: 写测试**

```js
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "../src/runtime/service.mjs";
import { createView, readState, writeState, writeHost, writeHostPid } from "../src/core/store.mjs";
import * as P from "../src/core/paths.mjs";
import { attachWarmHostSweeper } from "../src/core/warm-host-sweeper.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentboard-warmhost-"));
}

function makeService(root) {
	return createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: process.cwd(),
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
	});
}

/** 起一个监听 viewId socketPath 的 net server，返回 { server, received } */
async function captureHostSocket(root, viewId) {
	const received = [];
	const server = createServer((socket) => {
		let buf = "";
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			for (const line of buf.split("\n")) {
				if (!line.trim()) continue;
				try { received.push(JSON.parse(line)); } catch { /* ignore */ }
			}
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(P.controlSocketPath(root, viewId), resolve);
	});
	return { server, received };
}

const waitFor = async (pred, timeoutMs = 3000) => {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return pred();
};

function idleView(root, id) {
	createView(root, { id, name: id, cwd: "/r" });
	const s = readState(root, id);
	s.semanticState = "completed";
	s.processState = "exited";
	s.lastActivityAt = Date.now() - 3600_000;
	writeState(root, s);
	writeHost(root, {
		viewId: id,
		mode: "pty",
		state: "alive",
		runnerPid: process.pid, // hostAlive 判定用（isAlive(process.pid)=true）
		socketPath: P.controlSocketPath(root, id),
		startedAt: Date.now() - 3600_000,
		attachedClients: 0,
		lastSeenAt: Date.now(),
	});
	writeHostPid(root, id, process.pid);
}

test("A6: 周期/手动 sweep 后 idle host 收到 terminate、busy host 不收", async () => {
	const root = freshRoot();
	const oldTtl = process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
	const oldGrace = process.env.AGENT_BOARD_WARM_HOST_GRACE_MS;
	process.env.AGENT_BOARD_WARM_HOST_TTL_MS = "1"; // 立即过期
	process.env.AGENT_BOARD_WARM_HOST_GRACE_MS = "0";
	try {
		idleView(root, "idle1");
		const { server, received } = await captureHostSocket(root, "idle1");
		const svc = makeService(root);
		svc.pruneWarmHosts();
		const got = await waitFor(() => received.some((m) => m.type === "terminate"));
		assert.equal(got, true, "idle host 应收到 terminate");
		server.close();
	} finally {
		if (oldTtl === undefined) delete process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
		else process.env.AGENT_BOARD_WARM_HOST_TTL_MS = oldTtl;
		if (oldGrace === undefined) delete process.env.AGENT_BOARD_WARM_HOST_GRACE_MS;
		else process.env.AGENT_BOARD_WARM_HOST_GRACE_MS = oldGrace;
		rmSync(root, { recursive: true, force: true });
	}
});

test("A6: busy host 不被 sweep 触碰", async () => {
	const root = freshRoot();
	const oldTtl = process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
	process.env.AGENT_BOARD_WARM_HOST_TTL_MS = "1";
	try {
		createView(root, { id: "busy1", name: "busy1", cwd: "/r" });
		const s = readState(root, "busy1");
		s.semanticState = "working";
		s.processState = "alive";
		s.lastActivityAt = Date.now() - 3600_000;
		writeState(root, s);
		writeHost(root, {
			viewId: "busy1", mode: "pty", state: "alive", runnerPid: process.pid,
			socketPath: P.controlSocketPath(root, "busy1"),
			startedAt: Date.now() - 3600_000, attachedClients: 0, lastSeenAt: Date.now(),
		});
		writeHostPid(root, "busy1", process.pid);
		const { server, received } = await captureHostSocket(root, "busy1");
		const svc = makeService(root);
		svc.pruneWarmHosts();
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(received.some((m) => m.type === "terminate"), false, "busy host 不得收 terminate");
		server.close();
	} finally {
		if (oldTtl === undefined) delete process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
		else process.env.AGENT_BOARD_WARM_HOST_TTL_MS = oldTtl;
		rmSync(root, { recursive: true, force: true });
	}
});

test("A7: session_shutdown 触发 sweepNow（lifecycle 接线端到端）", async () => {
	const root = freshRoot();
	const oldTtl = process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
	const oldGrace = process.env.AGENT_BOARD_WARM_HOST_GRACE_MS;
	process.env.AGENT_BOARD_WARM_HOST_TTL_MS = "1";
	process.env.AGENT_BOARD_WARM_HOST_GRACE_MS = "0";
	try {
		idleView(root, "idle1");
		const { server, received } = await captureHostSocket(root, "idle1");
		const events = {};
		const fakePi = { on: (ev, fn) => { events[ev] = fn; } };
		const svc = makeService(root);
		const attached = attachWarmHostSweeper(fakePi, {
			isHostedChild: false,
			sweep: () => svc.pruneWarmHosts(),
			intervalMs: 0,
		});
		// 启动即 sweep 已发 terminate（A6）；验证 shutdown 再次 sweep（幂等 terminate 无害）
		const got1 = await waitFor(() => received.some((m) => m.type === "terminate"));
		assert.equal(got1, true);
		received.length = 0;
		events.session_shutdown();
		const got2 = await waitFor(() => received.some((m) => m.type === "terminate"));
		assert.equal(got2, true, "shutdown sweep 应再次发 terminate");
		attached.dispose();
		server.close();
	} finally {
		if (oldTtl === undefined) delete process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
		else process.env.AGENT_BOARD_WARM_HOST_TTL_MS = oldTtl;
		if (oldGrace === undefined) delete process.env.AGENT_BOARD_WARM_HOST_GRACE_MS;
		else process.env.AGENT_BOARD_WARM_HOST_GRACE_MS = oldGrace;
		rmSync(root, { recursive: true, force: true });
	}
});
```

（Windows 平台注意：`P.controlSocketPath` 为命名管道（`\\.\pipe\pi-agent-board-<viewId>`），`net.createServer().listen(pipePath)` 直接支持；本机即 Windows。）

- [ ] **Step 2: 跑测试**

Run: `node --test test/warm-host-sweep.integration.test.mjs`
Expected: 3 个用例全 PASS（若 `writeHostPid` 未被 store.mjs 导出则改由 `writeHost` 的 runnerPid 字段承载——`loadRow` 用 `host?.runnerPid ?? readHostPid`，两者其一即可；测试已两者都写）

- [ ] **Step 3: Commit**

```bash
git add test/warm-host-sweep.integration.test.mjs
git commit -m "test: integration coverage for warm-host sweep terminate path (issue #75)"
```

---

### Task 5: index.ts 接线（宿主扩展生命周期挂 sweeper）

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: Task 2 `attachWarmHostSweeper`；Task 3 `envInt`（service.mjs export）；本文件已有 `isHostedChild`/`root`/`commandOpts`
- Produces: 宿主 pi（非 child）加载扩展即注册周期 sweep + session_shutdown 清理

**验收:** A6 接线真环境（typecheck + Task 4 lifecycle 测试佐证），A8

- [ ] **Step 1: imports（index.ts 顶部现有 import 区加两行）**

```ts
import { attachWarmHostSweeper } from "./core/warm-host-sweeper.mjs";
import { createService, envInt } from "./runtime/service.mjs";
```

（注意替换现有 `import { createService } from "./runtime/service.mjs";` 行——合并成一个 import。）

- [ ] **Step 2: piAgentBoard(pi) 函数内、`registerAgentBoardCommand` 之前加接线**

```ts
	// Warm-host reclaim (issue #75): idle PTY hosts must not leak forever after
	// detach. Sweep once now (reclaims hosts orphaned by a previous host pi that
	// exited without cleanup), then periodically; sweep again on shutdown.
	// Child pi processes skip entirely (they share the board root and would
	// terminate their own runner).
	attachWarmHostSweeper(pi, {
		isHostedChild,
		sweep: () => {
			try {
				serviceForContext().pruneWarmHosts();
			} catch {
				/* best-effort: never break the session over a sweep */
			}
		},
		intervalMs: envInt("AGENT_BOARD_SWEEP_INTERVAL_MS", 60_000, 0, 24 * 60 * 60 * 1000, "AGENT_VIEW_SWEEP_INTERVAL_MS"),
	});
```

其中 `serviceForContext` 是模块级工厂，替代现有 `serviceFor(ctx)` 对 ctx 的依赖（sweep 回调在 session_shutdown 时可能无 ctx）：

在 `serviceFor` 定义附近（现约 53 行）新增并让 `serviceFor` 复用它：

```ts
	const serviceForContext = () =>
		createService({ root, runnerScript: RUNNER_SCRIPT, ptyRunnerScript: PTY_RUNNER_SCRIPT, titleRunnerScript: TITLE_RUNNER_SCRIPT, autoStateRunnerScript: AUTO_STATE_RUNNER_SCRIPT, piCommand, piArgsPrefix, defaultCwd: process.cwd() });
	const serviceFor = (ctx: ExtensionContext) =>
		createService({ root, runnerScript: RUNNER_SCRIPT, ptyRunnerScript: PTY_RUNNER_SCRIPT, titleRunnerScript: TITLE_RUNNER_SCRIPT, autoStateRunnerScript: AUTO_STATE_RUNNER_SCRIPT, piCommand, piArgsPrefix, defaultCwd: ctx.cwd });
```

（保持两行独立亦可——sweep 用 `defaultCwd: process.cwd()` 的版本；**不要**用共享同一 service 实例的方案：piAgentBoard 内 createService 的 defaultCwd 依赖 ctx，session 间不同；sweep 每次临时创建 service 与现有 `serviceFor` 行为一致且无状态泄漏。）

- [ ] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 无类型错误
Run: `node --test test/warm-host-sweeper.test.mjs test/warm-host-sweep.integration.test.mjs`
Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire warm-host sweeper into host pi lifecycle (issue #75)"
```

---

### Task 6: 全量回归 + U1 用户实测

**Files:**
- 无代码改动（验证任务）

**验收:** A8（全量回归无新增失败）、U1（用户实测回收闭环）

- [ ] **Step 1: 全量回归**

Run: `npm run typecheck && node --test test/*.test.mjs`
Expected: typecheck 0 错误；测试与基线一致（无新增失败；新增 3 个测试文件全部 PASS）

- [ ] **Step 2: U1 用户实测清单（提交 PR 前在真实环境执行，结果记录到 PR 描述）**

1. 在宿主 pi（本机）加载新扩展代码（worktree 内 `node src/...` 不方便——用安装目录替换或等 PR 合入后实测；临时方案：设 `AGENT_BOARD_WARM_HOST_TTL_MS=10000` 与 `AGENT_BOARD_SWEEP_INTERVAL_MS=5000` 重启 pi 会话）
2. `/agent-board` → 选一个会话 attach → detach 返回 board → 关掉宿主 pi 窗口
3. 等待 >10s（TTL 10s）+ >5s（sweep 周期）
4. 检查：该 view 的 host.json `state: "exited"`；runner 与 child pi 进程已退出（任务管理器 / `Get-Process`）
5. 通过标准：进程消失、host.json finalize、重启 pi 后 dashboard 中该会话可正常重新 attach（冷启动路径）

- [ ] **Step 3: 清理 env 痕迹**（若 Step 2 在宿主真实环境设过 env，恢复默认后验证一次默认参数路径）

---

## Self-Review

- **Spec coverage**：M1 → Task 1（selectIdleHostsToEvict 纯函数 + graceMs）✓；M2 → Task 2（createWarmHostSweeper）✓；M3 → Task 2（attachWarmHostSweeper）+ Task 5（index.ts 接线）✓；M4 取消（偏差记录于 Global Constraints）✓；Non-goals 未引入代码 ✓；A1-A4 → Task 1；A5 → Task 2；A6 → Task 2（lifecycle 语义）+ Task 4（integration）+ Task 5（真接线）；A7 → Task 4；A8 → Task 1/3/6；U1 → Task 6
- **Placeholder scan**：所有代码步骤含完整实现；Task 6 实测步骤为可执行清单
- **Type consistency**：`selectIdleHostsToEvict(rows, {now,maxWarm,ttlMs,graceMs,keepViewId})` 签名在 Task 1/3 一致；`createWarmHostSweeper({sweep,intervalMs})` 与 `attachWarmHostSweeper(pi,{isHostedChild,sweep,intervalMs})` 在 Task 2/4/5 一致；service 方法 `pruneWarmHosts(pruneOpts?)` 在 Task 3/4/5 一致；`envInt(name,fallback,min,max,legacyName)` export 在 Task 3/5 一致
