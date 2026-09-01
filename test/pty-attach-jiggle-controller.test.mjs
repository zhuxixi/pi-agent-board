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
	controller.feed("\x1b[?2026h frame"); // fast path restores, cancels G1
	// 排干全部退避计时器：第一个 tick（还原后的验证窗口）发现无 clear 且 hold
	// 已塌陷 → 重新 shrink 再戳一次（issue #42）；后续 tick 因 hold 在位而空转，
	// 预算耗尽时 G2 还原原始尺寸。
	for (let i = 0; i < 8; i++) scheduler.fireNext();
	assert.equal(controller.getState().stopped, true);
	assert.deepEqual(
		resizes,
		[[170, 36], [169, 35], [170, 36], [169, 35], [170, 36]],
		"start pair → fast-path restore → re-poke shrink → G2 restore",
	);
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

test("slow boot: G1 released, first frame re-arms hold, clear restores", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	const g1 = scheduler.findByDelay(6000);
	assert.ok(g1);
	scheduler.fire(g1); // G1 releases the hold before the TUI boots
	assert.deepEqual(resizes.slice(-1), [[170, 36]]);
	assert.equal(controller.getState().held, false);
	// TUI boots late: first frame re-arms a fresh hold (F1 probe)
	controller.feed("\x1b[?2026h first frame");
	assert.deepEqual(resizes.slice(-1), [[169, 35]], "probe re-shrinks and holds");
	assert.equal(controller.getState().held, true);
	assert.equal(controller.getState().tuiFrameSeen, true);
	// The now-running child fullRenders on the width delta → clear restores
	controller.feed("x\x1b[2J");
	assert.deepEqual(resizes.slice(-1), [[170, 36]], "clear restores original size");
	const s = controller.getState();
	assert.equal(s.held, false);
	assert.equal(s.clearDetected, true);
	assert.equal(s.stopped, true);
});

test("no re-arm probe after chain exhausted (stopped)", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	scheduler.fireNext(); // G1(6000) fires first in Map order → restore, held=false
	assert.equal(controller.getState().held, false);
	for (let i = 0; i < 8; i++) scheduler.fireNext(); // exhaust the 8-entry chain (G2)
	assert.equal(controller.getState().stopped, true);
	const before = resizes.length;
	controller.feed("\x1b[?2026h late frame");
	assert.equal(resizes.length, before, "no probe after chain stopped");
	assert.equal(controller.getState().held, false);
});

test("frames keep arriving without a clear → chain re-pokes, exhaustion restores", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	controller.feed("\x1b[?2026h frame"); // fast path restores once
	// 持续的无 clear 差分帧（热 session 净零塌陷后的沉默，issue #42）：链必须在
	// 验证窗口后重新 shrink 再戳一次；预算耗尽时停留在原始尺寸。
	for (let i = 0; i < 8; i++) scheduler.fireNext();
	assert.deepEqual(
		resizes,
		[[170, 36], [169, 35], [170, 36], [169, 35], [170, 36]],
		"clear-less fast-path restore must be followed by exactly one re-poke shrink",
	);
	assert.equal(controller.getState().stopped, true);
	assert.equal(controller.getState().held, false);
});

test("issue #42: fast-path restore without a following clear re-arms the hold, next clear heals", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(196, 39);
	assert.deepEqual(resizes, [[196, 39], [195, 38]]);
	// 热 session 的在途差分帧（无 clear）误触快速通道 → 还原；子进程把
	// shrink+restore 合并成净零 → 沉默。
	controller.feed("\x1b[?2026hstatus tick\x1b[?2026l");
	assert.deepEqual(resizes.at(-1), [196, 39], "fast path restores on first frame");
	assert.equal(controller.getState().held, false);
	// 还原后的验证窗口到期：无 clear → 重新 shrink 再戳一次（单独落地，无法塌陷）。
	scheduler.fireNext();
	assert.deepEqual(resizes.at(-1), [195, 38], "verify window without a clear re-shrinks");
	assert.equal(controller.getState().held, true);
	// 子进程这回真的看到宽度差 → fullRender → clear → 还原并彻底停止。
	controller.feed("\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jfull repaint");
	assert.deepEqual(resizes.at(-1), [196, 39], "clear after the re-poke restores");
	const s = controller.getState();
	assert.equal(s.held, false);
	assert.equal(s.clearDetected, true);
	assert.equal(s.stopped, true);
	assert.equal(scheduler.timers.size, 0, "no timers left after the heal");
});

test("issue #42: healthy session — clear within the grace window → zero extra resizes", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(196, 39);
	controller.feed("\x1b[?2026h frame start");
	controller.feed("rest of frame \x1b[2J\x1b[H\x1b[3J full repaint");
	const count = resizes.length;
	for (let i = 0; i < 16 && scheduler.timers.size; i++) scheduler.fireNext();
	assert.equal(resizes.length, count, "no re-poke once the clear landed (no flicker on healthy sessions)");
	assert.equal(controller.getState().stopped, true);
});

test("issue #42: no-frame child (shell) — chain ticks never re-shrink, G1/G2 semantics unchanged", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(170, 36);
	// 从未见过 TUI 帧：G1 在 6s 还原；退避链 tick 全部空转（ensureHold 被
	// !tuiFrameSeen 挡住）；预算耗尽后 restoreIfHeld 幂等 no-op。
	for (let i = 0; i < 16 && scheduler.timers.size; i++) scheduler.fireNext();
	assert.deepEqual(
		resizes,
		[[170, 36], [169, 35], [170, 36]],
		"shell child: exactly one restore (G1), no re-shrinks",
	);
	assert.equal(controller.getState().stopped, true);
	assert.equal(controller.getState().held, false);
});

test("issue #42: clear after the 900ms verify window still heals after one extra re-poke", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(196, 39);
	controller.feed("\x1b[?2026h frame start");
	assert.deepEqual(resizes, [[196, 39], [195, 38], [196, 39]]);

	// Model a healthy but delayed fullRender: the clear arrives after the
	// post-restore grace window, so G6 is allowed to re-poke once.
	scheduler.fireNext();
	assert.deepEqual(resizes, [[196, 39], [195, 38], [196, 39], [195, 38]]);
	assert.equal(controller.getState().held, true);

	controller.feed("late fullRender \x1b[2J");
	assert.deepEqual(resizes.at(-1), [196, 39]);
	assert.equal(controller.getState().clearDetected, true);
	assert.equal(controller.getState().stopped, true);
	assert.equal(scheduler.timers.size, 0, "late clear must cancel the remaining retry timer");
});

test("issue #42: external resize during post-restore verify cancels G6 without rewriting the new size", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(196, 39);
	controller.feed("\x1b[?2026h frame start");
	const beforeExternalResize = resizes.length;
	assert.equal(scheduler.timers.size, 1, "post-restore verify timer is armed");

	controller.notifyExternalResize(220, 50);
	assert.equal(scheduler.timers.size, 0, "G4 must cancel the post-restore verify timer");
	assert.equal(controller.getState().stopped, true);
	assert.equal(controller.getState().originalCols, 220);
	assert.equal(controller.getState().originalRows, 50);

	// No stale verify callback may re-shrink after the external resize. A
	// later clear is inert because G4 stopped the controller.
	assert.equal(resizes.length, beforeExternalResize);
	controller.feed("late \x1b[2J");
	assert.equal(resizes.length, beforeExternalResize);
});

test("issue #42: minimum PTY size skips an invalid shrink", () => {
	const { controller, scheduler, resizes } = makeController();
	controller.start(20, 5);
	assert.deepEqual(resizes, [[20, 5]], "do not send 19x4, which the runner clamps back to 20x5");
	assert.equal(controller.getState().held, false);
	assert.equal(controller.getState().stopped, true);
	assert.equal(scheduler.timers.size, 0);
});
