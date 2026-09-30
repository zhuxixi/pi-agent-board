import assert from "node:assert/strict";
import { test } from "node:test";
import { createStopLatch } from "../src/core/stop-latch.mjs";

test("A2: latch records the first signal and collapses later ones", () => {
	const latch = createStopLatch();
	assert.equal(latch.pending(), null, "nothing noted initially");
	latch.note("SIGTERM");
	latch.note("SIGINT");
	assert.equal(latch.pending(), "SIGTERM", "first signal wins; SIGINT/SIGTERM collapse into one stop intent");
});

test("A2: take returns the noted signal exactly once", () => {
	const latch = createStopLatch();
	latch.note("SIGINT");
	assert.equal(latch.take(), "SIGINT", "take returns the noted signal");
	assert.equal(latch.take(), null, "take clears — a replayed stop cannot double-fire");
	assert.equal(latch.pending(), null);
});

test("A2: take on an empty latch is null", () => {
	const latch = createStopLatch();
	assert.equal(latch.take(), null);
	assert.equal(latch.pending(), null);
});

test("A2: latches are independent instances", () => {
	const a = createStopLatch();
	const b = createStopLatch();
	a.note("SIGTERM");
	assert.equal(b.pending(), null, "no shared state across instances");
});
