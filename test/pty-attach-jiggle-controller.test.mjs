import assert from "node:assert/strict";
import test from "node:test";
import { createJiggleRetryController } from "../src/core/pty-attach-jiggle-controller.mjs";

function fakeScheduler() {
	const timers = new Map();
	let nextId = 1;
	return {
		timers,
		setTimeoutFn(fn, ms) {
			const id = nextId++;
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimeoutFn(id) { timers.delete(id); },
		fire(id) { const t = timers.get(id); assert.ok(t, "no such timer"); timers.delete(id); t.fn(); },
		fireNext() { const first = timers.entries().next().value; assert.ok(first, "no pending timer"); this.fire(first[0]); },
		delays() { return [...timers.values()].map((t) => t.ms); },
		findByDelay(ms) { for (const [id, t] of timers) if (t.ms === ms) return id; return null; },
	};
}

function makeController() {
	const scheduler = fakeScheduler();
	const resizes = [];
	const controller = createJiggleRetryController({
		sendResize: (c, r) => resizes.push([c, r]),
		setTimeoutFn: scheduler.setTimeoutFn,
		clearTimeoutFn: scheduler.clearTimeoutFn,
	});
	return { controller, scheduler, resizes };
}

test("start() arms hold: sends original then shrunk size, holds", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	assert.deepEqual(resizes, [[170, 36], [169, 35]]);
	assert.equal(controller.getState().held, true);
	assert.notEqual(scheduler.findByDelay(6000), null, "G1 timer armed"); // 6000 in delays
	assert.ok(scheduler.delays().includes(6000), "G1 timer present");
});

test("feed with clear restores original size exactly once and stops", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.feed("x\x1b[2J\x1b[Hy");
	assert.deepEqual(resizes.slice(-1), [[170, 36]]);
	assert.equal(controller.getState().clearDetected, true);
	assert.equal(controller.getState().stopped, true);
	assert.equal(controller.getState().held, false);
	// 幂等：后续 feed 不再发
	controller.feed("more\x1b[2J");
	assert.equal(resizes.filter(([c]) => c === 170).length, 2); // start 的 + restore 的，无第三发
});

test("re-arm (first TUI frame) restores size and does NOT reschedule chain", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	// Count only the chain (non-G1) timers: the G1 guard is cancelled by the
	// frame itself, so the count before/after must be compared excluding it.
	const budgetBefore = scheduler.delays().filter((d) => d !== 6000).length;
	controller.feed("\x1b[?2026h first frame");
	assert.deepEqual(resizes.slice(-1), [[170, 36]]);
	assert.equal(controller.getState().tuiFrameSeen, true);
	assert.equal(scheduler.delays().length, budgetBefore, "no new timers scheduled");
	// G1 已取消
	assert.equal(scheduler.findByDelay(6000), null);
});

test("G1: no TUI frame within 6s restores original size", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	const g1 = scheduler.findByDelay(6000);
	assert.ok(g1);
	scheduler.fire(g1);
	assert.deepEqual(resizes.slice(-1), [[170, 36]]);
	assert.equal(controller.getState().held, false);
});

test("G1 cancelled once a frame arrives (no double restore)", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.feed("\x1b[?2026h frame");
	const g1 = scheduler.findByDelay(6000);
	assert.equal(g1, null);
});

test("G2: backoff budget exhausted without clear restores original size", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.feed("\x1b[?2026h frame"); // re-arm restores, cancels G1
	const before = resizes.length;
	// 排干全部退避计时器（无脉冲 fire 均为推进）
	for (let i = 0; i < 8; i++) scheduler.fireNext();
	assert.equal(controller.getState().stopped, true);
	// hold 已在 re-arm 时恢复，G2 无需再发（幂等）
	assert.equal(resizes.length, before);
});

test("G2 without any frame: budget exhausted restores", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	scheduler.fireNext(); // 第一个退避计时器（120ms）推进，no-op
	// 9 fires total: the G1(6000) timer occupies one fireNext slot mid-drain
	// (restoring via G1 counts as the G2 outcome), and the 8-entry backoff
	// needs 9 fires (8 advances + the final null-delay stop) to fully exhaust.
	for (let i = 0; i < 8; i++) scheduler.fireNext();
	assert.equal(controller.getState().stopped, true);
	assert.deepEqual(resizes.slice(-1), [[170, 36]], "G1/G2 restore fired");
});

test("restoreAndStop() restores then stops (G3)", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.restoreAndStop();
	assert.deepEqual(resizes.slice(-1), [[170, 36]]);
	assert.equal(controller.getState().stopped, true);
	assert.equal(scheduler.timers.size, 0);
});

test("start() after a held start restores previous hold first (G5)", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.start(196, 39); // 新连接
	assert.deepEqual(resizes.slice(0, 4), [[170, 36], [169, 35], [170, 36], [196, 39]]);
	assert.deepEqual(resizes.slice(-1), [[195, 38]]);
});

test("notifyExternalResize cancels hold, adopts new size, stops chain (G4)", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	resizes.length = 0;
	controller.notifyExternalResize(200, 50);
	assert.equal(scheduler.timers.size, 0, "all timers cleared");
	assert.equal(controller.getState().held, false);
	assert.equal(controller.getState().stopped, true);
	assert.equal(controller.getState().originalCols, 200);
	// 再 feed clear 不再触发任何 restore
	controller.feed("\x1b[2J");
	assert.equal(resizes.length, 0);
});

test("full G1 window passes while frames keep arriving → held restored by G2 only", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.feed("\x1b[?2026h frame"); // restores once
	const before = resizes.length;
	// 无全清的持续输出
	for (let i = 0; i < 8; i++) scheduler.fireNext();
	assert.equal(resizes.length, before, "no extra resizes");
	assert.equal(controller.getState().stopped, true);
});
