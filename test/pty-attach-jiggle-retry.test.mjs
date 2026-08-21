import assert from "node:assert/strict";
import test from "node:test";
import {
	advanceRetry,
	BACKOFF_MS,
	createJiggleRetryState,
	feedOutput,
	hasFullClearSequence,
	MAX_RETRIES,
	nextRetryDelay,
	stopRetry,
} from "../src/core/pty-attach-jiggle-retry.mjs";

// --- hasFullClearSequence ---

test("detects \\x1b[2J in plain data", () => {
	assert.equal(hasFullClearSequence("hello\x1b[2Jworld"), true);
});

test("detects \\x1b[2J at start", () => {
	assert.equal(hasFullClearSequence("\x1b[2J"), true);
});

test("detects \\x1b[2J followed by \\x1b[H", () => {
	assert.equal(hasFullClearSequence("\x1b[2J\x1b[H"), true);
});

test("rejects data without \\x1b[2J", () => {
	assert.equal(hasFullClearSequence("hello world"), false);
});

test("rejects \\x1b[3J (scrollback clear, not full clear)", () => {
	assert.equal(hasFullClearSequence("\x1b[3J"), false);
});

test("rejects partial escape \\x1b[2 (no J)", () => {
	assert.equal(hasFullClearSequence("\x1b[2"), false);
});

// --- createJiggleRetryState ---

test("initial state is fresh", () => {
	const s = createJiggleRetryState();
	assert.equal(s.retryIndex, 0);
	assert.equal(s.clearDetected, false);
	assert.equal(s.stopped, false);
});

// --- feedOutput ---

test("feedOutput detects clear sequence", () => {
	const s = createJiggleRetryState();
	const r = feedOutput(s, "some output \x1b[2J more", "");
	assert.equal(r.clearFound, true);
	assert.equal(r.state.clearDetected, true);
});

test("feedOutput returns clearFound=false when no clear", () => {
	const s = createJiggleRetryState();
	const r = feedOutput(s, "normal output", "");
	assert.equal(r.clearFound, false);
	assert.equal(r.state.clearDetected, false);
});

test("feedOutput handles cross-chunk split: \\x1b[ + 2J", () => {
	const s = createJiggleRetryState();
	const r1 = feedOutput(s, "data\x1b[", "");
	assert.equal(r1.clearFound, false);
	assert.equal(r1.carry, "\x1b[");
	const r2 = feedOutput(r1.state, "2Jrest", r1.carry);
	assert.equal(r2.clearFound, true);
});

test("feedOutput handles cross-chunk split: \\x1b + [2J", () => {
	const s = createJiggleRetryState();
	const r1 = feedOutput(s, "data\x1b", "");
	assert.equal(r1.clearFound, false);
	assert.equal(r1.carry, "\x1b");
	const r2 = feedOutput(r1.state, "[2Jrest", r1.carry);
	assert.equal(r2.clearFound, true);
});

test("feedOutput clears carry after successful detection", () => {
	const s = createJiggleRetryState();
	const r1 = feedOutput(s, "data\x1b[", "");
	const r2 = feedOutput(r1.state, "2Jrest", r1.carry);
	assert.equal(r2.carry, "");
});

test("feedOutput keeps carry for non-matching partial", () => {
	const s = createJiggleRetryState();
	const r = feedOutput(s, "data\x1b[3", "");
	assert.equal(r.clearFound, false);
	assert.ok(r.carry.length > 0);
});

// --- nextRetryDelay ---

test("nextRetryDelay returns BACKOFF_MS in order", () => {
	let s = createJiggleRetryState();
	for (let i = 0; i < MAX_RETRIES; i++) {
		assert.equal(nextRetryDelay(s), BACKOFF_MS[i]);
		s = advanceRetry(s);
	}
});

test("nextRetryDelay returns null after MAX_RETRIES", () => {
	let s = createJiggleRetryState();
	for (let i = 0; i < MAX_RETRIES; i++) s = advanceRetry(s);
	assert.equal(nextRetryDelay(s), null);
});

test("nextRetryDelay returns null when clearDetected", () => {
	const s = createJiggleRetryState();
	const r = feedOutput(s, "\x1b[2J", "");
	assert.equal(nextRetryDelay(r.state), null);
});

test("nextRetryDelay returns null when stopped", () => {
	const s = stopRetry(createJiggleRetryState());
	assert.equal(nextRetryDelay(s), null);
});

// --- advanceRetry ---

test("advanceRetry increments retryIndex", () => {
	const s0 = createJiggleRetryState();
	const s1 = advanceRetry(s0);
	assert.equal(s1.retryIndex, 1);
	const s2 = advanceRetry(s1);
	assert.equal(s2.retryIndex, 2);
});

// --- stopRetry ---

test("stopRetry sets stopped=true", () => {
	const s = stopRetry(createJiggleRetryState());
	assert.equal(s.stopped, true);
});

// --- Immutability ---

test("feedOutput does not mutate original state", () => {
	const s = createJiggleRetryState();
	feedOutput(s, "\x1b[2J", "");
	assert.equal(s.clearDetected, false);
});

test("advanceRetry does not mutate original state", () => {
	const s = createJiggleRetryState();
	advanceRetry(s);
	assert.equal(s.retryIndex, 0);
});

test("stopRetry does not mutate original state", () => {
	const s = createJiggleRetryState();
	stopRetry(s);
	assert.equal(s.stopped, false);
});
