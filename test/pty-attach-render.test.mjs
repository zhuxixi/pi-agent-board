import assert from "node:assert/strict";
import test from "node:test";
import {
	createAttachOutputRenderScheduler,
	nextAttachRender,
	projectPtyCursor,
	shouldScheduleAttachRenderForMessage,
} from "../src/core/pty-attach-render.mjs";

test("nextAttachRender forces exactly the first attach paint by default", () => {
	assert.deepEqual(nextAttachRender(true), { force: true, firstPaint: false });
	assert.deepEqual(nextAttachRender(false), { force: false, firstPaint: false });
});

test("nextAttachRender preserves explicit hard resets after first paint", () => {
	assert.deepEqual(nextAttachRender(false, true), { force: true, firstPaint: false });
	assert.deepEqual(nextAttachRender(true, true), { force: true, firstPaint: false });
});

test("shouldScheduleAttachRenderForMessage skips immediate repaint for PTY output", () => {
	assert.equal(shouldScheduleAttachRenderForMessage("output"), false);
	assert.equal(shouldScheduleAttachRenderForMessage("hello"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("status"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("error"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("exit"), true);
	assert.equal(shouldScheduleAttachRenderForMessage("unknown"), false);
});

test("attach output scheduler coalesces parser callback bursts", async () => {
	let renders = 0;
	const scheduler = createAttachOutputRenderScheduler(() => renders++, 15);
	for (let i = 0; i < 20; i++) scheduler.request();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(renders, 1);

	scheduler.request();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(renders, 2);
	scheduler.dispose();
});

test("attach output scheduler cancels a pending repaint when disposed", async () => {
	let renders = 0;
	const scheduler = createAttachOutputRenderScheduler(() => renders++, 15);
	scheduler.request();
	scheduler.dispose();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(renders, 0);
});

test("projectPtyCursor maps a fresh session (baseY 0) to the absolute buffer row", () => {
	const buf = { baseY: 0, cursorX: 1, cursorY: 5 };
	assert.deepEqual(projectPtyCursor(buf, 0, 36), { row: 5, col: 1 });
});

test("projectPtyCursor returns an ABSOLUTE row once scrollback exists", () => {
	// Regression: a start-relative row (cursorY) never matches the absolute buffer
	// indices used by the projection loop, so the PTY-cursor block and the
	// CURSOR_MARKER (hardware cursor positioning for IME) silently disappeared
	// for any session with scrollback.
	const buf = { baseY: 249, cursorX: 0, cursorY: 32 };
	assert.deepEqual(projectPtyCursor(buf, 249, 36), { row: 281, col: 0 });
});

test("projectPtyCursor returns null when the cursor is outside the projected window", () => {
	const buf = { baseY: 249, cursorX: 0, cursorY: 32 };
	// Window scrolled up into history: cursor sits below it.
	assert.equal(projectPtyCursor(buf, 100, 36), null);
	// Window starts past the cursor.
	assert.equal(projectPtyCursor(buf, 282, 36), null);
});

test("projectPtyCursor tolerates missing or negative cursor coordinates", () => {
	assert.equal(projectPtyCursor({ baseY: 0 }, 0, 36), null);
	assert.equal(projectPtyCursor({ baseY: 0, cursorX: -1, cursorY: 3 }, 0, 36), null);
	assert.equal(projectPtyCursor({ baseY: 0, cursorX: 0, cursorY: -2 }, 0, 36), null);
});
