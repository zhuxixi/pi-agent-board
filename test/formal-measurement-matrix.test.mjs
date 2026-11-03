import assert from "node:assert/strict";
import test from "node:test";
import { CELLS, HARD_OPPORTUNITY_MS, OBSERVATION_MS, WARMUPS_PER_VERSION, scheduleFor, validateSchedule } from "../test-support/formal-measurement/matrix.mjs";

test("matrix declares all 16 cells with approved sample sizes and thresholds", () => {
	assert.equal(CELLS.length, 16);
	const by = Object.fromEntries(CELLS.map((c) => [c.cellId, c]));
	assert.equal(by.B.n, 100);
	assert.equal(by.S.n, 100);
	assert.equal(by["L-normal"].n, 100);
	assert.equal(by["L-alt"].n, 100);
	for (const id of ["G1", "G2", "G3", "C", "R-reconnect", "R-restart", "T-on-time", "T-late", "U-unframed", "U-legacy", "D"]) assert.equal(by[id].n, 30);
	assert.equal(by["T-on-time"].thresholdMs, 200);
	assert.equal(by["T-on-time"].maxMs, 500);
	assert.equal(by["T-late"].thresholdMs, 200);
	assert.equal(by["T-late"].maxMs, 500);
	assert.equal(by["L-normal"].kind, "complete-frame");
	assert.equal(by["L-alt"].kind, "complete-frame");
	assert.equal(by["U-unframed"].kind, "legacy");
	assert.equal(by["U-legacy"].kind, "legacy");
	assert.equal(WARMUPS_PER_VERSION, 5);
	assert.equal(OBSERVATION_MS, 3000);
	assert.equal(HARD_OPPORTUNITY_MS, 2500);
});

test("schedule executes 2n trials with exactly n per version", () => {
	for (const n of [30, 100]) {
		const schedule = validateSchedule(n);
		assert.equal(schedule.length, 2 * n);
		assert.equal(schedule.filter((x) => x.startsWith("candidate:")).length, n);
		assert.equal(schedule.filter((x) => x.startsWith("baseline:")).length, n);
		assert.deepEqual(schedule.slice(0, n / 2), Array(n / 2).fill("candidate:first"));
		assert.deepEqual(schedule.slice(n / 2, n), Array(n / 2).fill("baseline:first"));
		assert.deepEqual(schedule.slice(n, n + n / 2), Array(n / 2).fill("baseline:second"));
		assert.deepEqual(schedule.slice(n + n / 2), Array(n / 2).fill("candidate:second"));
	}
});

test("matrix totals are 830/version and 1660 overall", () => {
	const perVersion = CELLS.reduce((sum, cell) => sum + cell.n, 0);
	assert.equal(perVersion, 830);
	assert.equal(perVersion * 2, 1660);
});
