import assert from "node:assert/strict";
import test from "node:test";
import { createFullscreenSelectionSettler } from "../src/core/fullscreen-selection.mjs";

const leftEvent = (type, x = 3, y = 3) => ({ type, button: "left", x, y, screenX: x, screenY: y, width: 80, height: 22, shift: false });

/** Manual scheduler: collect callbacks, flush explicitly. Mirrors process.nextTick ordering without wall-clock. */
const manualQueue = () => {
	const q = [];
	return { q, schedule: (cb) => q.push(cb), flush: () => { while (q.length) q.shift()(); } };
};

/** Counting host fixture; clear invalidates text so a read-after-clear order yields no mirror text. */
// NOTE: presence check ("text" in opts), not a destructuring default — a default
// would silently turn an explicit `text: undefined` (the absent-selection case)
// into "fixture-text" and make the absent-text test settle for real.
const makeHost = (opts = {}) => {
	const { copyOnSelect = true, withClear = true } = opts;
	const text = "text" in opts ? opts.text : "fixture-text";
	const state = { text, copyOnSelect, reads: 0, clears: 0, repaints: 0, mirrored: [] };
	return {
		state,
		host: {
			getActiveSelectionText: () => { state.reads += 1; return state.text; },
			getCopyOnSelect: () => state.copyOnSelect,
			...(withClear ? { clearTextSelection: () => { state.clears += 1; state.text = undefined; } } : {}),
		},
	};
};

test("settler: left release defers settle via the injected scheduler, then clears and repaints once", () => {
	const { q, schedule, flush } = manualQueue();
	const { state, host } = makeHost();
	const s = createFullscreenSelectionSettler({ host, repaint: () => { state.repaints += 1; }, schedule });
	s.observeMouse(leftEvent("release"));
	assert.equal(state.reads, 0, "nothing may run synchronously");
	flush();
	assert.equal(state.reads, 1);
	assert.equal(state.clears, 1);
	assert.equal(state.repaints, 1);
});

test("settler: empty or absent selection text never clears, never mirrors", () => {
	for (const text of [undefined, ""]) {
		const { q, schedule, flush } = manualQueue();
		const mirrored = [];
		const { state, host } = makeHost({ text });
		const s = createFullscreenSelectionSettler({ host, mirror: (t) => mirrored.push(t), schedule });
		s.observeMouse(leftEvent("release"));
		flush();
		assert.equal(state.clears, 0, `text=${String(text)}`);
		assert.equal(mirrored.length, 0, `text=${String(text)}`);
	}
});

test("settler: copyOnSelect=false mirrors but keeps the selection for Ctrl+X", () => {
	const { schedule, flush } = manualQueue();
	const mirrored = [];
	const { state, host } = makeHost({ copyOnSelect: false });
	const s = createFullscreenSelectionSettler({ host, mirror: (t) => mirrored.push(t), schedule });
	s.observeMouse(leftEvent("release"));
	flush();
	assert.equal(mirrored.length, 1);
	assert.equal(mirrored[0], "fixture-text", "mirror runs before the copyOnSelect check and reads live text");
	assert.equal(state.clears, 0);
});

test("settler: missing clearTextSelection degrades without throwing", () => {
	const { schedule, flush } = manualQueue();
	const { state, host } = makeHost({ withClear: false });
	const s = createFullscreenSelectionSettler({ host, schedule });
	s.observeMouse(leftEvent("release"));
	assert.doesNotThrow(flush);
	assert.equal(state.clears, 0);
});

test("settler: read-before-clear order (mirror receives live text even though clear invalidates it)", () => {
	const { schedule, flush } = manualQueue();
	const mirrored = [];
	const { host } = makeHost();
	const s = createFullscreenSelectionSettler({ host, mirror: (t) => mirrored.push(t), schedule });
	s.observeMouse(leftEvent("release"));
	flush();
	assert.equal(mirrored[0], "fixture-text", "text was read before clearTextSelection invalidated it");
});

test("settler: a release followed by a new left press in the same tick is dropped (gesture serial)", () => {
	const { q, schedule, flush } = manualQueue();
	const { state, host } = makeHost();
	const s = createFullscreenSelectionSettler({ host, schedule });
	s.observeMouse(leftEvent("release", 3, 3));
	s.observeMouse(leftEvent("press", 9, 9));
	// Queue length is observable only before flush — flush() drains the queue.
	assert.equal(q.length, 1, "only the release queued a settle");
	flush();
	assert.equal(state.reads, 0, "the queued settle must not consume the new gesture");
	assert.equal(state.clears, 0);
});

test("settler: left click also settles; press/move/right/middle/wheel never do", () => {
	const { schedule, flush } = manualQueue();
	const { state, host } = makeHost();
	const s = createFullscreenSelectionSettler({ host, schedule });
	s.observeMouse(leftEvent("click"));
	flush();
	assert.equal(state.clears, 1, "click is a selection end");
	const nonEndings = [
		{ type: "press", button: "left" },
		{ type: "move", button: "left" },
		{ type: "press", button: "right" },
		{ type: "press", button: "middle" },
		{ type: "wheel", button: "none" },
	];
	for (const ev of nonEndings) s.observeMouse({ ...leftEvent("press"), ...ev });
	flush();
	assert.equal(state.clears, 1, "no non-ending cleared again");
});

test("settler: shouldSettle() === false blocks before any host read, mirror, clear or repaint", () => {
	const { schedule, flush } = manualQueue();
	const mirrored = [];
	const { state, host } = makeHost();
	const s = createFullscreenSelectionSettler({
		host,
		mirror: (t) => mirrored.push(t),
		repaint: () => { state.repaints += 1; },
		schedule,
		shouldSettle: () => false,
	});
	s.observeMouse(leftEvent("release"));
	flush();
	assert.equal(state.reads, 0, "gate is checked before the host read");
	assert.equal(mirrored.length, 0);
	assert.equal(state.clears, 0);
	assert.equal(state.repaints, 0);
});
