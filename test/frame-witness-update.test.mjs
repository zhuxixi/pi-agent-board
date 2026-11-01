import assert from "node:assert/strict";
import test from "node:test";

import { createFrameWitnessSummaryScheduler } from "../src/core/frame-witness-update.mjs";

function fakeTimers() {
	let nextId = 1;
	const tasks = new Map();
	return {
		tasks,
		setTimeoutFn(fn, ms) {
			const id = nextId++;
			const handle = { id, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
			tasks.set(id, { fn, handle });
			return handle;
		},
		clearTimeoutFn(handle) {
			tasks.delete(handle.id);
		},
		fire() {
			for (const [id, task] of [...tasks]) {
				tasks.delete(id);
				task.fn();
			}
		},
	};
}

test("frame-witness summary updates coalesce without changing immediate protocol work", () => {
	const timers = fakeTimers();
	const published = [];
	const scheduler = createFrameWitnessSummaryScheduler({ delayMs: 100, publish: () => published.push("summary"), ...timers });
	scheduler.schedule();
	scheduler.schedule();
	scheduler.schedule();
	assert.equal(published.length, 0, "marker bursts do not synchronously rewrite host.json");
	assert.equal(timers.tasks.size, 1, "one bounded flush is armed");
	assert.equal([...timers.tasks.values()][0].handle.unrefCalled, true, "the summary timer does not pin the runner");
	timers.fire();
	assert.deepEqual(published, ["summary"]);
	scheduler.schedule();
	scheduler.flush();
	assert.deepEqual(published, ["summary", "summary"], "immediate lifecycle flush publishes the latest summary");
	assert.equal(timers.tasks.size, 0, "flush cancels the pending timer");
	scheduler.schedule();
	scheduler.cancel();
	timers.fire();
	assert.deepEqual(published, ["summary", "summary"], "close cancellation prevents stale summary rewrites");
});
