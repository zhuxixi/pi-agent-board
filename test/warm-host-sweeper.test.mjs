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
