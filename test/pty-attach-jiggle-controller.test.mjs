import assert from "node:assert/strict";
import test from "node:test";
import { createJiggleRetryController } from "../src/core/pty-attach-jiggle-controller.mjs";

/** Fake scheduler: 记录计时器，手动触发。 */
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
		clearTimeoutFn(id) {
			timers.delete(id);
		},
		/** 触发当前唯一（或指定）计时器 */
		fireNext() {
			const first = timers.entries().next().value;
			assert.ok(first, "expected a pending timer");
			timers.delete(first[0]);
			first[1].fn();
		},
		get pendingDelays() {
			return [...timers.values()].map((t) => t.ms);
		},
	};
}

function makeController(overrides = {}) {
	const scheduler = fakeScheduler();
	const jiggles = [];
	const controller = createJiggleRetryController({
		sendJiggle: () => jiggles.push(Date.now()),
		setTimeoutFn: scheduler.setTimeoutFn,
		clearTimeoutFn: scheduler.clearTimeoutFn,
		...overrides,
	});
	return { controller, scheduler, jiggles };
}

test("start schedules first retry at 120ms and firing sends jiggle + advances", () => {
	const { controller, scheduler, jiggles } = makeController();
	controller.start();
	assert.deepEqual(scheduler.pendingDelays, [120]);
	scheduler.fireNext();
	assert.equal(jiggles.length, 1);
	assert.deepEqual(scheduler.pendingDelays, [500]);
	assert.equal(controller.getState().retryIndex, 1);
});

test("feed with clear stops chain and marks clearDetected", () => {
	const { controller, scheduler } = makeController();
	controller.start();
	controller.feed("prefix\x1b[2J\x1b[H");
	const s = controller.getState();
	assert.equal(s.clearDetected, true);
	assert.equal(s.stopped, true);
	assert.equal(scheduler.timers.size, 0);
});

test("first TUI frame re-arms the chain with a fresh budget (latch)", () => {
	const { controller, scheduler, jiggles } = makeController();
	controller.start();
	scheduler.fireNext(); // retry 1 fired, budget now at 500ms
	controller.feed("\x1b[?2026h first frame");
	assert.equal(controller.getState().tuiFrameSeen, true);
	assert.equal(controller.getState().retryIndex, 0);
	assert.deepEqual(scheduler.pendingDelays, [120]);
	// second frame does NOT re-arm again
	controller.feed("\x1b[?2026h another frame");
	assert.deepEqual(scheduler.pendingDelays, [120]);
	scheduler.fireNext();
	assert.equal(jiggles.length, 2);
});

test("clear wins when one chunk contains both frame-start and clear", () => {
	const { controller } = makeController();
	controller.start();
	controller.feed("\x1b[?2026h\x1b[2J");
	const s = controller.getState();
	assert.equal(s.clearDetected, true);
	assert.equal(s.stopped, true);
	assert.equal(s.tuiFrameSeen, false);
});

test("no re-arm after clear-wins settle: later differential frames stay inert", () => {
	const { controller, scheduler } = makeController();
	controller.start();
	// same-chunk clear-wins: chain stops, latch never set
	controller.feed("\x1b[?2026h\x1b[2J");
	assert.equal(controller.getState().stopped, true);
	assert.equal(controller.getState().clearDetected, true);
	assert.equal(controller.getState().tuiFrameSeen, false);
	// a later differential frame must NOT re-arm the already-stopped chain
	controller.feed("\x1b[?2026h later differential frame");
	const s = controller.getState();
	assert.equal(s.stopped, true);
	assert.equal(s.clearDetected, true);
	assert.equal(s.tuiFrameSeen, false);
	assert.equal(s.retryIndex, 0);
	assert.equal(scheduler.timers.size, 0, "no pending retry timer after post-clear frame");
});

test("re-arm fires even after the chain exhausted (cold-boot case)", () => {
	const { controller, scheduler, jiggles } = makeController();
	controller.start();
	for (let i = 0; i < 8; i++) scheduler.fireNext(); // drain all retries
	assert.equal(controller.getState().stopped, true);
	assert.equal(jiggles.length, 8);
	controller.feed("late frame \x1b[?2026h");
	assert.equal(controller.getState().stopped, false);
	assert.deepEqual(scheduler.pendingDelays, [120]);
});

test("shouldFire=false stops the chain without firing", () => {
	const { controller, scheduler, jiggles } = makeController({
		shouldFire: () => false,
	});
	controller.start();
	scheduler.fireNext();
	assert.equal(jiggles.length, 0);
	assert.equal(controller.getState().stopped, true);
});

test("full backoff schedule matches spec table then stops", () => {
	const { controller, scheduler } = makeController();
	controller.start();
	const seen = [];
	for (let i = 0; i < 8; i++) {
		seen.push(...scheduler.pendingDelays);
		scheduler.fireNext();
	}
	assert.deepEqual(seen, [120, 500, 1500, 3000, 6000, 10000, 15000, 20000]);
	assert.equal(scheduler.timers.size, 0);
	assert.equal(controller.getState().stopped, true);
});

test("start() resets latch and carry for a fresh connection", () => {
	const { controller } = makeController();
	controller.start();
	controller.feed("\x1b[?2026h frame");
	controller.start();
	assert.equal(controller.getState().tuiFrameSeen, false);
	assert.equal(controller.getState().retryIndex, 0);
});
