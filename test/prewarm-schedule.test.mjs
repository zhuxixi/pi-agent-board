import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrewarmScheduler } from "../src/core/prewarm-schedule.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("rapid schedules fire prewarm once after quiet period", async () => {
	let fired = 0;
	const s = createPrewarmScheduler(() => { fired += 1; }, 15);
	s.schedule();
	s.schedule();
	s.schedule();
	await sleep(5);
	assert.equal(fired, 0); // still debouncing
	await sleep(25);
	assert.equal(fired, 1); // exactly once
});

test("cancel prevents prewarm entirely", async () => {
	let fired = 0;
	const s = createPrewarmScheduler(() => { fired += 1; }, 10);
	s.schedule();
	s.cancel();
	await sleep(30);
	assert.equal(fired, 0);
});

test("schedule after cancel works again", async () => {
	let fired = 0;
	const s = createPrewarmScheduler(() => { fired += 1; }, 10);
	s.schedule();
	s.cancel();
	s.schedule();
	await sleep(30);
	assert.equal(fired, 1);
});

test("prewarm errors do not crash the scheduler", async () => {
	let fired = 0;
	const s = createPrewarmScheduler(() => { fired += 1; throw new Error("boom"); }, 5);
	s.schedule();
	await sleep(20);
	assert.equal(fired, 1);
	s.schedule();
	await sleep(20);
	assert.equal(fired, 2);
});
