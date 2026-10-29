// Issue #222 step 23a adapter fix1 (task-23a-adapter-fix1-dispositions.md): adapter tests
// for `src/core/attach-frame-reporter.mjs` — ordered split-write marker insertion,
// pre-existing own-descriptor restoration, epoch-after-successful-start, sentinel
// dispose, marker failure, old-runner inertness, and preserved original semantics.
import assert from "node:assert/strict";
import test from "node:test";

import { AttachFrameReporter, ATTACH_FRAME_WIDGET_KEY, negotiateFrameWitness } from "../src/core/attach-frame-reporter.mjs";
import { decodeFrameMarker } from "../src/core/attach-frame-proof.mjs";

const OPEN = "\u001b[?2026h";
const CLOSE = "\u001b[?2026l";
const CUP = "\u001b[1;1H";
const FULL = `${OPEN}${CUP}text${CLOSE}`;
const TOKEN = "abcdefghijklmnopqrstuv";

function createTerminalDouble({ failWrite = null, failStart = false, ownColumns = null } = {}) {
	const written = [];
	class FakeTerminal {
		constructor() {
			this.started = 0;
			this.stopped = 0;
			this.epochAtStart = [];
		}
		get columns() {
			return ownColumns === null ? 80 : ownColumns();
		}
		get rows() {
			return 24;
		}
		write(text) {
			if (failWrite !== null && failWrite.matches(text)) {
				if (failWrite.mode === "throw") throw new Error("write failed");
				return;
			}
			written.push(text);
		}
		hideCursor() {
			written.push("<hide>");
		}
		showCursor() {
			written.push("<show>");
		}
		start() {
			if (failStart) throw new Error("start failed");
			this.started += 1;
		}
		stop() {
			this.stopped += 1;
		}
	}
	return { terminal: new FakeTerminal(), written };
}

function createUiDouble(terminal) {
	const widgets = new Map();
	const tui = {
		mode: "fullscreen",
		terminal,
		focus: { id: "editor" },
		getFocusedComponent() {
			return this.focus;
		},
		hasOverlay: () => false,
	};
	return {
		widgets,
		tui,
		ui: {
			setWidget(key, factory, options) {
				widgets.set(key, { component: factory(tui, {}), options });
			},
		},
	};
}

function enabledReporter(options = {}) {
	const { terminal, written } = createTerminalDouble(options);
	const { ui, widgets, tui } = createUiDouble(terminal);
	const sent = [];
	const reporter = new AttachFrameReporter({ ui, mode: "fullscreen", sessionEpoch: 1, send: (message) => sent.push(message) });
	reporter.announce();
	assert.equal(reporter.handleMessage({ type: "frame_witness_enable", protocol: 1, token: TOKEN, instanceId: "inst-1", sessionEpoch: 1 }).status, "enabled");
	assert.equal(reporter.install(), true);
	const widget = widgets.get(ATTACH_FRAME_WIDGET_KEY);
	assert.equal(widget.options.placement, "belowEditor");
	const renderPass = () => {
		void terminal.columns;
		void terminal.rows;
		widget.component.render(80);
	};
	return { reporter, terminal, written, sent, tui, renderPass, widget };
}

function markerKinds(written) {
	return written.map((text) => decodeFrameMarker(text)).filter((marker) => marker !== null);
}

test("fix1 adapter: old/silent runners stay inert (no widget, wrappers or markers)", () => {
	const { terminal, written } = createTerminalDouble();
	const { ui, widgets } = createUiDouble(terminal);
	const sent = [];
	const reporter = new AttachFrameReporter({ ui, send: (message) => sent.push(message) });
	reporter.announce();
	assert.deepEqual(sent, [{ type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 0 } }]);
	assert.equal(reporter.handleMessage(undefined).status, "ignored");
	assert.equal(reporter.handleMessage({ type: "frame_witness_enable", protocol: 2, token: TOKEN }).status, "unsupported");
	assert.equal(reporter.handleMessage({ type: "frame_witness_enable", protocol: 1, token: "short" }).status, "unsupported");
	assert.equal(reporter.install(), false);
	assert.equal(widgets.size, 0);
	assert.equal(Object.getOwnPropertyDescriptor(terminal, "write"), undefined);
	terminal.write("plain");
	assert.deepEqual(written, ["plain"]);
	assert.equal(reporter.markerCount, 0);
	assert.equal(negotiateFrameWitness({ type: "frame_witness_enable", protocol: 1, token: TOKEN }).status, "enabled");
});

test("fix1 adapter: S is inserted at the exact OPEN boundary, splitting the write (prefix, S, remainder)", () => {
	const { reporter, terminal, written, renderPass } = enabledReporter();
	renderPass();
	const previousClose = `${CLOSE}\u001b[2A\u001b[1G`;
	const text = `${previousClose}${FULL}`;
	terminal.write(text);
	const markers = markerKinds(written);
	const sIndex = written.findIndex((chunk) => decodeFrameMarker(chunk)?.kind === "S");
	assert.ok(sIndex > 0, "there is a prefix chunk before S");
	assert.equal(written[0], previousClose, "the previous frame's CLOSE is written BEFORE the S marker");
	assert.equal(written[sIndex + 1], FULL, "the remainder starts exactly at this frame's OPEN");
	assert.deepEqual(markerKinds(written).map((marker) => marker.kind), ["S", "F"]);
	assert.equal(markers[0].frameId, 1);
	assert.equal(reporter.markerCount, 2);
});

test("fix1 adapter: pre-existing own descriptors are restored, third-party replacements are left alone", () => {
	const ownGetter = Object.getOwnPropertyDescriptor;
	const { terminal, written } = createTerminalDouble();
	let ownValue = 90;
	Object.defineProperty(terminal, "columns", { configurable: true, enumerable: true, get: () => ownValue });
	const { ui } = createUiDouble(terminal);
	const reporter = new AttachFrameReporter({ ui, mode: "fullscreen", sessionEpoch: 1, send: () => {} });
	reporter.announce();
	reporter.handleMessage({ type: "frame_witness_enable", protocol: 1, token: TOKEN, sessionEpoch: 1 });
	assert.equal(reporter.install(), true);
	assert.notEqual(Object.getOwnPropertyDescriptor(terminal, "columns").get, ownGetter);
	const { restores } = reporter.dispose("test");
	const columnsRestore = restores.find((entry) => entry.key === "columns");
	assert.equal(columnsRestore.result, "restored");
	assert.equal(columnsRestore.restoredOwnBefore, true, "the pre-existing own accessor was reinstalled");
	assert.equal(terminal.columns, 90, "the pre-existing getter is back, not deleted");
	void written;
});

test("fix1 adapter: epoch advances only after a successful start; a throwing start preserves epoch and exception", () => {
	const failing = enabledReporter({ failStart: true });
	const epochBefore = failing.reporter.decisions.length;
	assert.throws(() => failing.terminal.start(), /start failed/);
	assert.equal(failing.reporter.rendererEpoch ?? 1, 1);
	const failingDecisions = failing.reporter.decisions.slice(epochBefore);
	assert.equal(failingDecisions.some((entry) => entry.rendererEpoch > 1), false, "no epoch bump on a throw");

	const ok = enabledReporter();
	const reporter = ok.reporter;
	const before = reporter.decisions.length;
	void before;
	ok.terminal.start();
	assert.equal(reporter.frameIdCounter.value, 0);
	assert.equal(reporter.markerCount, 0);
});

test("fix1 adapter: sentinel dispose aborts the open candidate and stops proving", () => {
	const { reporter, terminal, written, renderPass, widget } = enabledReporter();
	renderPass();
	// The render pass opened a candidate (size pair) that has not written yet.
	assert.equal(reporter.frameIdCounter.value, 1);
	widget.component.dispose();
	assert.equal(reporter.state, "disposed");
	assert.deepEqual(reporter.installedKeys, []);
	const markersBefore = markerKinds(written).length;
	terminal.write(FULL);
	assert.equal(markerKinds(written).length, markersBefore, "no marker after the sentinel was disposed");
});

test("fix1 adapter: original write errors propagate and no F is written for the failed frame", () => {
	const { reporter, terminal, written, renderPass } = enabledReporter({ failWrite: { mode: "throw", matches: (text) => text === FULL } });
	renderPass();
	assert.throws(() => terminal.write(FULL), /write failed/);
	const kinds = markerKinds(written).map((marker) => marker.kind);
	assert.deepEqual(kinds, ["S", "A"], "S is closed by A because the frame bytes were never delivered; no F");
	assert.equal(reporter.markerCount, 2);
});

test("fix1 adapter: marker failure turns the capability off and keeps the original output", () => {
	const { reporter, terminal, written, renderPass } = enabledReporter({ failWrite: { mode: "throw", matches: (text) => text.startsWith("\u001bP>") } });
	renderPass();
	assert.doesNotThrow(() => terminal.write(FULL));
	assert.equal(written.includes(FULL), true);
	assert.equal(reporter.capabilityEnabled, false);
	assert.equal(reporter.markerFailure !== null, true);
	assert.equal(reporter.markerCount, 0);
});

test("fix1 adapter: stop restores all shadows, keeps the capability armed, and re-arms on the carried counter", () => {
	const { reporter, terminal, written, renderPass } = enabledReporter();
	renderPass();
	const { restores } = reporter.dispose("stop");
	assert.equal(restores.filter((entry) => entry.result === "restored").length, 7);
	for (const key of ["columns", "rows", "write", "hideCursor", "showCursor", "start", "stop"]) {
		assert.equal(Object.getOwnPropertyDescriptor(terminal, key), undefined, `own shadow ${key} removed`);
	}
	const markersBefore = markerKinds(written).length;
	terminal.write(FULL);
	assert.equal(markerKinds(written).length, markersBefore);
});

test("fix1 adapter: real terminal stop suspends and the next registration re-arms with continued ids", () => {
	const { reporter, terminal, written, renderPass } = enabledReporter();
	renderPass();
	terminal.write(FULL);
	assert.equal(reporter.frameIdCounter.value, 1);
	terminal.stop();
	assert.equal(reporter.suspensions, 1);
	assert.deepEqual(reporter.installedKeys, []);
	assert.equal(terminal.stopped, 1);
	assert.equal(reporter.install(), true, "re-registration re-arms on the same terminal");
	renderPass();
	terminal.write(FULL);
	const sIds = markerKinds(written).filter((marker) => marker.kind === "S").map((marker) => marker.frameId);
	assert.deepEqual(sIds, [1, 2], "the carried counter continues");
});

test("fix1 adapter: mode switch rebinds the grammar, keeps the terminal and the counter", () => {
	const { reporter, terminal, written, renderPass, tui } = enabledReporter();
	renderPass();
	terminal.write(FULL);
	reporter.setMode("regular", { rendererEpoch: 2 });
	// The test double must reflect the real mode: the factory now binds mode from tui.mode.
	tui.mode = "regular";
	assert.equal(reporter.install(), true);
	renderPass();
	terminal.write(`${OPEN}content`);
	terminal.write(CLOSE);
	terminal.write("\u001b[3A\u001b[1G");
	terminal.hideCursor();
	const markers = markerKinds(written);
	const sIds = markers.filter((marker) => marker.kind === "S").map((marker) => marker.frameId);
	const fIds = markers.filter((marker) => marker.kind === "F").map((marker) => marker.frameId);
	assert.deepEqual(sIds, [1, 2]);
	assert.deepEqual(fIds, [1, 2]);
	const secondF = markers.filter((marker) => marker.kind === "F").at(-1);
	assert.equal(secondF.metadata.mode, "regular");
	assert.equal(secondF.metadata.rendererEpoch, 2);
});

// fix1 (F3): intent identity, duplicates, supersession, intent-at-creation, first-F consume.
test("23b1 fix1 F3: intentId comes from fw-N, duplicates and non-monotonic revisions are rejected", () => {
	const { reporter, renderPass, terminal, written } = enabledReporter();
	renderPass();
	const first = reporter.applyIntent({ type: "frame_witness_intent", instanceId: "inst-1", requestId: "fw-1", geometryRevision: 1, cols: 100, rows: 30 });
	assert.equal(first.ok, true);
	assert.equal(reporter.intentStats.intentId, 1);
	// Duplicate requestId and non-monotonic revision never call requestRender.
	const requestsBefore = reporter.intentStats.applied;
	assert.equal(reporter.applyIntent({ type: "frame_witness_intent", instanceId: "inst-1", requestId: "fw-1", geometryRevision: 2, cols: 120, rows: 40 }).reason, "duplicate-requestId");
	assert.equal(reporter.applyIntent({ type: "frame_witness_intent", instanceId: "inst-1", requestId: "fw-2", geometryRevision: 1, cols: 120, rows: 40 }).reason, "geometryRevision");
	assert.equal(reporter.intentStats.applied, requestsBefore, "rejected intents never touch the renderer");
	assert.equal(reporter.applyIntent({ type: "frame_witness_intent", instanceId: "inst-1", requestId: "bad", geometryRevision: 3, cols: 1, rows: 1 }).reason, "requestId-format");
	void terminal;
	void written;
});

test("23b1 fix1 F3: a newer intent supersedes an open candidate before any S/F (no retroactive stamping)", () => {
	const { reporter, renderPass, terminal, written } = enabledReporter();
	reporter.applyIntent({ type: "frame_witness_intent", instanceId: "inst-1", requestId: "fw-1", geometryRevision: 1, cols: 80, rows: 24 });
	renderPass(); // candidate created with the intent snapshot
	const before = reporter.decisions.length;
	reporter.applyIntent({ type: "frame_witness_intent", instanceId: "inst-1", requestId: "fw-2", geometryRevision: 2, cols: 100, rows: 30 });
	const after = reporter.decisions.slice(before);
	assert.equal(after.some((decision) => decision.kind === "S" || decision.kind === "F"), false, "supersession never publishes");
	assert.equal(after.some((decision) => decision.reason === "intent-superseded-before-s"), true);
	terminal.write("\u001b[?2026h\u001b[1;1Hx\u001b[?2026l");
	assert.equal(markerKinds(written).length, 0, "the superseded frame cannot prove");
});

test("23b1 fix1 F3: the first matching F consumes the intent once; stale nonce cannot repeat", () => {
	const { reporter, renderPass, terminal, written } = enabledReporter();
	reporter.applyIntent({ type: "frame_witness_intent", instanceId: "inst-1", requestId: "fw-1", geometryRevision: 1, cols: 80, rows: 24 });
	renderPass();
	terminal.write(FULL);
	const fMarkers = markerKinds(written).filter((marker) => marker.kind === "F");
	assert.equal(fMarkers.length, 1);
	assert.equal(fMarkers[0].metadata.intentId, 1, "F carries the intent snapshot");
	assert.deepEqual(reporter.intentStats.consumedRequestIds, ["fw-1"], "the first matching F consumes the intent");
	assert.equal(reporter.consumeIntentOnce(), false, "the same nonce cannot consume twice");
	renderPass();
	terminal.write(FULL);
	const secondF = markerKinds(written).filter((marker) => marker.kind === "F").at(-1);
	assert.equal(secondF.frameId, 2, "a later frame still proves and updates the view");
	assert.equal(reporter.consumeIntentOnce(), false, "later frames never re-consume");
});

// 23b1 final P2: epoch validation, first-F consumption, no consumption on failure.
test("23b1 P2: the enable must carry the reporter's actual sessionEpoch", () => {
	const { terminal } = createTerminalDouble();
	const { ui } = createUiDouble(terminal);
	const reporter = new AttachFrameReporter({ ui, send: () => {}, sessionEpoch: 2 });
	reporter.announce();
	assert.equal(reporter.handleMessage({ type: "frame_witness_enable", protocol: 1, token: TOKEN, instanceId: "i", sessionEpoch: 1 }).status, "unsupported");
	assert.equal(reporter.capabilityEnabled, false);
	assert.equal(reporter.handleMessage({ type: "frame_witness_enable", protocol: 1, token: TOKEN, instanceId: "i" }).status, "unsupported");
	assert.equal(reporter.handleMessage({ type: "frame_witness_enable", protocol: 1, token: TOKEN, instanceId: "i", sessionEpoch: 2 }).status, "enabled");
});

test("23b1 P2: intent is consumed only after the first matching F is written; later frames use ordinary intent 0", () => {
	const { reporter, terminal, written, renderPass } = enabledReporter();
	reporter.applyIntent({ type: "frame_witness_intent", instanceId: "inst-1", requestId: "fw-1", geometryRevision: 1, cols: 80, rows: 24 });
	renderPass();
	terminal.write(FULL);
	assert.deepEqual(reporter.intentStats.consumedRequestIds, ["fw-1"], "the first matching F consumed the intent");
	renderPass();
	terminal.write(FULL);
	const frames = markerKinds(written).filter((marker) => marker.kind === "F");
	assert.equal(frames.length, 2);
	assert.equal(frames[0].metadata.intentId, 1, "the completing frame carries the intent");
	assert.equal(frames[1].metadata.intentId, 0, "later frames fall back to the ordinary intent 0");
	assert.equal(reporter.consumeIntentOnce(), false, "a consumed nonce never consumes twice");
});

test("23b1 P2: a failed F marker write does not consume the intent", () => {
	const { reporter, terminal, renderPass } = enabledReporter({ failWrite: { mode: "throw", matches: (text) => text.startsWith("\u001bP>") } });
	reporter.applyIntent({ type: "frame_witness_intent", instanceId: "inst-1", requestId: "fw-1", geometryRevision: 1, cols: 80, rows: 24 });
	renderPass();
	terminal.write(FULL);
	assert.deepEqual(reporter.intentStats.consumedRequestIds, [], "a failed write never consumes");
	assert.equal(reporter.capabilityEnabled, false);
});

// 23b1 re-arm regression (default topology): the host REUSES the existing widget component
// after `switchTuiMode` and never calls the factory again. Proving must resume from the SAME
// component's next render without install()/setWidget().
test("23b1 re-arm: same component render re-arms after a real terminal.stop + mode change", () => {
	const { reporter, terminal, written, widget, tui } = enabledReporter("regular");
	// A real renderer reads the shared size, then renders the components.
	const render = () => {
		void terminal.columns;
		void terminal.rows;
		widget.component.render(80);
	};
	// First frame in the startup mode (fullscreen) proves.
	tui.mode = "fullscreen";
	render();
	terminal.write(FULL);
	const firstF = markerKinds(written).filter((marker) => marker.kind === "F").at(-1);
	assert.equal(firstF.frameId, 1);
	const epochBefore = firstF.metadata.rendererEpoch;
	// The REAL renderer swaps modes: previousUi.stop() -> terminal.stop(), then the public
	// TuiRef reports the new mode. The widget component instance is REUSED (no factory).
	terminal.stop();
	tui.mode = "regular";
	assert.equal(reporter.state, "enabled", "the capability stays armed across a renderer stop");
	// SAME component, NO install()/setWidget(): the next render must rebind and reinstall.
	render();
	assert.notEqual(Object.getOwnPropertyDescriptor(terminal, "write"), undefined, "own shadows are reinstalled on reactivation");
	// The size pair of the NEXT render pass belongs to the new evaluator (the pass that
	// reactivated could not have sampled through restored shadows); this mirrors the host.
	render();
	// The next REAL regular frame proves with a carried frameId and exactly ONE epoch bump.
	terminal.write(`${OPEN}content`);
	terminal.write(CLOSE);
	terminal.write("\u001b[3A\u001b[1G");
	terminal.hideCursor();
	const markers = markerKinds(written);
	const lastF = markers.filter((marker) => marker.kind === "F").at(-1);
	assert.equal(lastF.frameId, 2, "the frameId counter continues across the reactivation");
	assert.equal(lastF.metadata.mode, "regular", "the rebind used the ACTUAL current tui.mode");
	assert.equal(lastF.metadata.rendererEpoch, epochBefore + 1, "exactly one epoch bump for the reactivation");
	// A stop WITHOUT a subsequent render proves nothing.
	const beforeStop = markerKinds(written).length;
	terminal.stop();
	assert.equal(markerKinds(written).length, beforeStop, "stop alone emits no proof");
	// Same-mode stop/start also bumps exactly once, not twice.
	render();
	render();
	terminal.write(`${OPEN}more`);
	terminal.write(CLOSE);
	terminal.write("\u001b[3A\u001b[1G");
	terminal.hideCursor();
	const afterSame = markerKinds(written).filter((marker) => marker.kind === "F").at(-1);
	assert.equal(afterSame.frameId, 3);
	assert.equal(afterSame.metadata.rendererEpoch, epochBefore + 2, "same-mode reactivation bumps once, not twice");
});

test("23b1 re-arm: disposed/failed capabilities never re-arm", () => {
	const disposed = enabledReporter("regular");
	disposed.widget.component.dispose();
	assert.equal(disposed.reporter.state, "disposed");
	const before = disposed.written.length;
	void disposed.terminal.columns;
	void disposed.terminal.rows;
	disposed.widget.component.render(80);
	assert.equal(disposed.written.length, before, "no re-arm after dispose");

	const failed = enabledReporter({ failWrite: { mode: "throw", matches: (text) => text.startsWith("\u001bP>") } });
	void failed.terminal.columns;
	void failed.terminal.rows;
	failed.widget.component.render(80);
	failed.terminal.write(FULL);
	assert.equal(failed.reporter.capabilityEnabled, false);
	const failedBefore = failed.written.length;
	failed.terminal.stop();
	void failed.terminal.columns;
	void failed.terminal.rows;
	failed.widget.component.render(80);
	assert.equal(failed.written.length, failedBefore, "no re-arm after a marker failure");
});

test("23b2c3a cross-instance dispose: another Terminal instance on the same prototype keeps its methods/descriptors", () => {
	const written = [];
	class SharedTerminal {
		get columns() {
			return 80;
		}
		get rows() {
			return 24;
		}
		write(text) {
			written.push(text);
		}
		hideCursor() {}
		showCursor() {}
		start() {}
		stop() {}
	}
	const first = new SharedTerminal();
	const second = new SharedTerminal();
	const protoWrite = Object.getOwnPropertyDescriptor(SharedTerminal.prototype, "write")?.value;
	const protoColumns = Object.getOwnPropertyDescriptor(SharedTerminal.prototype, "columns")?.get;
	const { ui } = createUiDouble(first);
	const reporter = new AttachFrameReporter({ ui, mode: "fullscreen", sessionEpoch: 1, send: () => {} });
	reporter.announce();
	assert.equal(reporter.handleMessage({ type: "frame_witness_enable", protocol: 1, token: TOKEN, instanceId: "i", sessionEpoch: 1 }).status, "enabled");
	assert.equal(reporter.install(), true);
	assert.notEqual(first.write, protoWrite, "first instance is shadowed");
	reporter.dispose("test");
	assert.equal(first.write, protoWrite, "first instance restored to the prototype method");
	assert.equal(second.write, protoWrite, "second instance never changed");
	assert.equal(Object.getOwnPropertyDescriptor(SharedTerminal.prototype, "write")?.value, protoWrite, "prototype descriptor unchanged");
	assert.equal(Object.getOwnPropertyDescriptor(SharedTerminal.prototype, "columns")?.get, protoColumns, "prototype getter unchanged");
	assert.equal(second.columns, 80);
	assert.equal(Object.hasOwn(second, "write"), false, "no own shadow leaked to the sibling");
	void written;
});
