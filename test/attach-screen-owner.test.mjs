import assert from "node:assert/strict";
import test from "node:test";
import xtermHeadless from "@xterm/headless";
import {
	createAttachScreenOwnerState,
	installAttachScreenOwnerObservers,
	transitionAttachScreenOwner,
} from "../src/core/attach-screen-owner.mjs";
const { Terminal } = xtermHeadless;

// Issue #278: Ctrl+G external editor temporarily leaves Pi's alt screen. The
// reducer tracks synchronized-output ownership (?2026) so the attach view can
// tell Pi-owned frames from external editor output (?1049 exit while synced).

test("reducer: initial state and Pi startup alt entry is not external ownership", () => {
	const initial = createAttachScreenOwnerState();
	assert.deepEqual(initial, { syncOpen: false, externalOutputActive: false });
	assert.equal(transitionAttachScreenOwner(initial, {
		type: "csi", final: "h", params: [1049],
	}), initial);
});

test("reducer: synced ?1049l marks external output until the next sync open", () => {
	const initial = createAttachScreenOwnerState();
	const stopped = transitionAttachScreenOwner(
		transitionAttachScreenOwner(initial, { type: "csi", final: "h", params: [2026] }),
		{ type: "csi", final: "l", params: [1049] },
	);
	assert.deepEqual(stopped, { syncOpen: true, externalOutputActive: true });
	const closed = transitionAttachScreenOwner(stopped, { type: "csi", final: "l", params: [2026] });
	assert.deepEqual(closed, { syncOpen: false, externalOutputActive: true });
	assert.deepEqual(transitionAttachScreenOwner(closed, { type: "csi", final: "h", params: [2026] }), {
		syncOpen: true, externalOutputActive: false,
	});
});

test("reducer: unsynchronized ?1049l is not an external-output entry", () => {
	const initial = createAttachScreenOwnerState();
	assert.deepEqual(transitionAttachScreenOwner(initial, { type: "csi", final: "l", params: [1049] }), initial);
});

test("reducer: ?1049h and ?2026$p are no-ops", () => {
	const initial = createAttachScreenOwnerState();
	assert.equal(transitionAttachScreenOwner(initial, { type: "csi", final: "h", params: [1049] }), initial);
	assert.equal(transitionAttachScreenOwner(initial, { type: "csi", final: "p", params: [2026] }), initial);
});

test("reducer: combined h/l params in any order close sync and mark external output", () => {
	for (const params of [[2026, 1049], [1049, 2026], [[2026, 1049]]]) {
		const open = { syncOpen: true, externalOutputActive: false };
		assert.deepEqual(transitionAttachScreenOwner(open, { type: "csi", final: "l", params }), {
			syncOpen: false, externalOutputActive: true,
		});
	}
});

test("reducer: adopt applies explicit external-output facts", () => {
	const initial = createAttachScreenOwnerState();
	const adopted = transitionAttachScreenOwner(initial, { type: "adopt", active: true });
	assert.deepEqual(adopted, { syncOpen: false, externalOutputActive: true });
	assert.deepEqual(transitionAttachScreenOwner(adopted, { type: "adopt", active: false }), initial);
});

test("reducer: reset clears all ownership state", () => {
	const dirty = { syncOpen: true, externalOutputActive: true };
	assert.deepEqual(transitionAttachScreenOwner(dirty, { type: "reset" }), {
		syncOpen: false, externalOutputActive: false,
	});
});

test("reducer: unknown events leave the state untouched", () => {
	const initial = createAttachScreenOwnerState();
	assert.equal(transitionAttachScreenOwner(initial, { type: "csi", final: "m", params: [1] }), initial);
	assert.equal(transitionAttachScreenOwner(initial, { type: "other" }), initial);
});

test("adapter: missing parser installs no observers", () => {
	assert.deepEqual(installAttachScreenOwnerObservers(null), []);
	assert.deepEqual(installAttachScreenOwnerObservers({}), []);
});

test("adapter: real parser transitions, reports marker facts, and passes controls through", async (t) => {
	const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
	t.after(() => term.dispose());
	const transitions = [];
	const observers = installAttachScreenOwnerObservers(term, {
		onTransition: (fact) => transitions.push(fact),
	});
	assert.equal(observers.length, 2);
	const feed = (data) => new Promise((resolve) => term.write(data, resolve));

	// Pi startup alt entry alone is not external ownership.
	await feed("\x1b[?1049h");
	assert.equal(term.buffer.active.type, "alternate");
	assert.deepEqual(transitions.at(-1).current, { syncOpen: false, externalOutputActive: false });

	// External editor flow: sync open, synced alt exit, sync close, sync reopen.
	await feed("\x1b[?2026h");
	assert.equal(term.modes.synchronizedOutputMode, true);
	await feed("\x1b[?1049l");
	await feed("\x1b[?2026l");
	await feed("\x1b[?2026h");
	const kinds = transitions.map(({ event }) => `${event.final}:${event.params.join(",")}`);
	assert.deepEqual(kinds, ["h:1049", "h:2026", "l:1049", "l:2026", "h:2026"]);
	const markers = transitions.map(({ syncOpenMarker, syncCloseMarker }) => [syncOpenMarker, syncCloseMarker]);
	assert.deepEqual(markers, [
		[false, false],
		[true, false],
		[false, false],
		[false, true],
		[true, false],
	]);
	const states = transitions.map(({ current }) => current);
	assert.deepEqual(states, [
		{ syncOpen: false, externalOutputActive: false },
		{ syncOpen: true, externalOutputActive: false },
		{ syncOpen: true, externalOutputActive: true },
		{ syncOpen: false, externalOutputActive: true },
		{ syncOpen: true, externalOutputActive: false },
	]);
	// Each transition chains off the previous one.
	for (let i = 1; i < transitions.length; i++) {
		assert.deepEqual(transitions[i].previous, transitions[i - 1].current);
	}
	// Handlers returned false: default parsing still applied every control.
	assert.equal(term.buffer.active.type, "normal");
	assert.equal(term.modes.synchronizedOutputMode, true);
});

test("adapter: disposed observers receive no later transitions", async (t) => {
	const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
	t.after(() => term.dispose());
	const transitions = [];
	const observers = installAttachScreenOwnerObservers(term, {
		onTransition: (fact) => transitions.push(fact),
	});
	const feed = (data) => new Promise((resolve) => term.write(data, resolve));
	await feed("\x1b[?2026h");
	assert.equal(transitions.length, 1);
	for (const observer of observers) observer.dispose();
	await feed("\x1b[?2026l\x1b[?1049l\x1b[?1049h");
	assert.equal(transitions.length, 1);
});

test("adapter: explicit initial state is honored", async (t) => {
	const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
	t.after(() => term.dispose());
	const transitions = [];
	installAttachScreenOwnerObservers(term, {
		initialState: { syncOpen: true, externalOutputActive: true },
		onTransition: (fact) => transitions.push(fact),
	});
	await new Promise((resolve) => term.write("\x1b[?1049h", resolve));
	assert.deepEqual(transitions.at(-1).current, { syncOpen: true, externalOutputActive: true });
});
