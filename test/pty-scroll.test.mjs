import assert from "node:assert/strict";
import test from "node:test";
import {
	encodeWheelReport,
	mouseWheelDirection,
	parseMouseEvent,
	parseMouseInputChunk,
	resizeJiggleSize,
	resolveAttachMouseAction,
	resolveAttachWheelRoute,
	resolvePasteSelectionSource,
	resolveWheelLines,
	scrollViewportTop,
	selectionDragScrollLines,
	shouldMirrorSelectionToPrimary,
	shouldOwnOuterMouseMode,
	splitAttachInput,
	wheelScrollLinesUp,
} from "../src/core/pty-scroll.mjs";

test("mouseWheelDirection decodes standard/passive SGR and X10 wheel events", () => {
	assert.equal(mouseWheelDirection("\x1b[<64;10;20M"), 1);
	assert.equal(mouseWheelDirection("\x1b[<65;10;20M"), -1);
	assert.equal(mouseWheelDirection("\x1b[?64;10;20M"), 1);
	assert.equal(mouseWheelDirection("\x1b[?65;10;20M"), -1);
	assert.equal(mouseWheelDirection("\x1b[<66;10;20M"), 0);
	assert.equal(mouseWheelDirection("\x1b[M`!!"), 1);
	assert.equal(mouseWheelDirection("\x1b[Ma!!"), -1);
	assert.equal(mouseWheelDirection("x"), 0);
});

test("resolveAttachWheelRoute picks the alternate-buffer branch, else local, else none", () => {
	// Alternate buffer: the attach's own scrollback is inert there, so the wheel
	// must be forwarded to the child instead of scrolling locally (issue #185).
	assert.equal(resolveAttachWheelRoute({ bufferType: "alternate", wheelLinesUp: 3, mouseEnabled: true }), "child");
	assert.equal(resolveAttachWheelRoute({ bufferType: "alternate", wheelLinesUp: -2, mouseEnabled: true }), "child");
	// Normal buffer: local scrollback exists; the shell still downgrades to
	// "none" itself when tryScrollBy cannot move (it owns the live viewport).
	assert.equal(resolveAttachWheelRoute({ bufferType: "normal", wheelLinesUp: 3, mouseEnabled: true }), "local");
	// Kill switches or an unusable delta leave the event to pi.
	assert.equal(resolveAttachWheelRoute({ bufferType: "normal", wheelLinesUp: 3, mouseEnabled: false }), "none");
	assert.equal(resolveAttachWheelRoute({ bufferType: "alternate", wheelLinesUp: 3, mouseEnabled: false }), "none");
	assert.equal(resolveAttachWheelRoute({ bufferType: "normal", wheelLinesUp: 0, mouseEnabled: true }), "none");
	assert.equal(resolveAttachWheelRoute({ bufferType: "alternate", wheelLinesUp: 0, mouseEnabled: true }), "none");
});

test("encodeWheelReport emits SGR up/down reports with 1-based clamped coordinates", () => {
	// Button 64 = wheel up, 65 = wheel down (plain SGR report a terminal sends).
	assert.equal(encodeWheelReport("up", { col: 5, row: 3 }), "\x1b[<64;5;3M");
	assert.equal(encodeWheelReport("down", { col: 5, row: 3 }), "\x1b[<65;5;3M");
	// Coordinates are child-screen cells and must never leave the 1-based range.
	assert.equal(encodeWheelReport("up", { col: 0, row: 0 }), "\x1b[<64;1;1M");
	assert.equal(encodeWheelReport("up", { col: -7, row: 2.9 }), "\x1b[<64;1;2M");
	assert.equal(encodeWheelReport("up", { col: Number.NaN, row: undefined }), "\x1b[<64;1;1M");
});

test("wheelScrollLinesUp flips pi-tui's wheel delta into the viewport's linesUp", () => {
	// pi-tui scrolls up on a NEGATIVE wheelDelta; tryScrollBy/scrollViewportTop
	// scroll up on a POSITIVE linesUp. The sign flip is the whole contract.
	assert.equal(wheelScrollLinesUp({ type: "wheel", wheelDelta: -3 }), 3);
	assert.equal(wheelScrollLinesUp({ type: "wheel", wheelDelta: 2 }), -2);
	// Nothing to scroll, or not a wheel event at all ⇒ 0 so the caller falls
	// through to pi's own handling instead of consuming the event.
	assert.equal(wheelScrollLinesUp({ type: "wheel", wheelDelta: 0 }), 0);
	assert.equal(wheelScrollLinesUp({ type: "wheel" }), 0);
	assert.equal(wheelScrollLinesUp({ type: "wheel", wheelDelta: Number.NaN }), 0);
	assert.equal(wheelScrollLinesUp({ type: "press", button: "middle", wheelDelta: -3 }), 0);
	assert.equal(wheelScrollLinesUp(null), 0);
	assert.equal(wheelScrollLinesUp(undefined), 0);
});

test("parseMouseEvent decodes press, drag, and release events", () => {
	assert.deepEqual(parseMouseEvent("\x1b[<0;10;20M"), {
		encoding: "sgr",
		button: 0,
		col: 10,
		row: 20,
		action: "press",
	});
	assert.deepEqual(parseMouseEvent("\x1b[<32;11;20M"), {
		encoding: "sgr",
		button: 32,
		col: 11,
		row: 20,
		action: "move",
	});
	assert.deepEqual(parseMouseEvent("\x1b[<0;11;20m"), {
		encoding: "sgr",
		button: 0,
		col: 11,
		row: 20,
		action: "release",
	});
	assert.deepEqual(parseMouseEvent("\x1b[?32;7;8M"), {
		encoding: "passive",
		button: 32,
		col: 7,
		row: 8,
		action: "move",
	});
	assert.deepEqual(parseMouseEvent("\x1b[M !!"), {
		encoding: "x10",
		button: 0,
		col: 1,
		row: 1,
		action: "press",
	});
	assert.equal(parseMouseEvent("x"), null);
});

test("parseMouseInputChunk decodes concatenated mouse reports and rejects mixed input", () => {
	assert.deepEqual(parseMouseInputChunk("\x1b[<64;10;20M\x1b[<65;10;20M"), [
		{
			length: "\x1b[<64;10;20M".length,
			raw: "\x1b[<64;10;20M",
			mouse: { encoding: "sgr", button: 64, col: 10, row: 20, action: "press" },
		},
		{
			length: "\x1b[<65;10;20M".length,
			raw: "\x1b[<65;10;20M",
			mouse: { encoding: "sgr", button: 65, col: 10, row: 20, action: "press" },
		},
	]);
	assert.equal(parseMouseInputChunk("\x1b[<64;10;20Mx"), null);
	assert.equal(parseMouseInputChunk("x\x1b[<64;10;20M"), null);
	assert.equal(parseMouseInputChunk(""), null);
});

test("scrollViewportTop reports unconsumed scroll when no local scrollback can move", () => {
	assert.deepEqual(scrollViewportTop(null, 0, 5), { viewportTop: null, changed: false });
	assert.deepEqual(scrollViewportTop(null, 20, -5), { viewportTop: null, changed: false });
	assert.deepEqual(scrollViewportTop(0, 20, 5), { viewportTop: 0, changed: false });
});

test("scrollViewportTop consumes gestures that move local scrollback", () => {
	assert.deepEqual(scrollViewportTop(null, 20, 5), { viewportTop: 15, changed: true });
	assert.deepEqual(scrollViewportTop(15, 20, -5), { viewportTop: null, changed: true });
	assert.deepEqual(scrollViewportTop(15, 20, 20), { viewportTop: 0, changed: true });
});

test("selectionDragScrollLines starts autoscroll at the viewport edge", () => {
	assert.equal(selectionDragScrollLines(1, 10), 2);
	assert.equal(selectionDragScrollLines(2, 10), 1);
	assert.equal(selectionDragScrollLines(3, 10), 0);
	assert.equal(selectionDragScrollLines(10, 10), 0);
	assert.equal(selectionDragScrollLines(11, 10), -1);
	assert.equal(selectionDragScrollLines(12, 10), -2);
});

test("resizeJiggleSize chooses a safe temporary size to force child redraw", () => {
	assert.deepEqual(resizeJiggleSize(120, 34), { cols: 119, rows: 33 });
	assert.deepEqual(resizeJiggleSize(20, 34), { cols: 20, rows: 33 });
	assert.deepEqual(resizeJiggleSize(120, 6), { cols: 119, rows: 6 });
	assert.equal(resizeJiggleSize(20, 6), null);
});

test("resolveWheelLines defaults to 1 when unset, empty, or non-numeric", () => {
	assert.equal(resolveWheelLines({}), 1);
	assert.equal(resolveWheelLines({ AGENT_BOARD_WHEEL_LINES: "" }), 1);
	assert.equal(resolveWheelLines({ AGENT_BOARD_WHEEL_LINES: "  " }), 1);
	assert.equal(resolveWheelLines({ AGENT_BOARD_WHEEL_LINES: "fast" }), 1);
});

test("resolveWheelLines honors a valid override and clamps to [1, 50]", () => {
	assert.equal(resolveWheelLines({ AGENT_BOARD_WHEEL_LINES: "1" }), 1);
	assert.equal(resolveWheelLines({ AGENT_BOARD_WHEEL_LINES: "5" }), 5);
	assert.equal(resolveWheelLines({ AGENT_BOARD_WHEEL_LINES: "  3 " }), 3);
	assert.equal(resolveWheelLines({ AGENT_BOARD_WHEEL_LINES: "0" }), 1);
	assert.equal(resolveWheelLines({ AGENT_BOARD_WHEEL_LINES: "-4" }), 1);
	assert.equal(resolveWheelLines({ AGENT_BOARD_WHEEL_LINES: "999" }), 50);
});

const ev = (type, button) => ({ type, button });

test("resolveAttachMouseAction: enabled middle press is the only paste trigger", () => {
	assert.equal(resolveAttachMouseAction(ev("press", "middle"), { nativePasteEnabled: true }), "paste-primary");
});

test("resolveAttachMouseAction: native paste kill switch disables the trigger", () => {
	assert.equal(resolveAttachMouseAction(ev("press", "middle"), { nativePasteEnabled: false }), null);
});

test("resolveAttachMouseAction: every other event falls through untouched", () => {
	const cases = [
		["press", "left"],
		["press", "right"],
		["press", "none"],
		["release", "middle"],
		["click", "middle"],
		["move", "middle"],
		["drag", "middle"],
		["wheel", "left"],
		["wheel", "middle"],
	];
	for (const [type, button] of cases) {
		assert.equal(resolveAttachMouseAction(ev(type, button), { nativePasteEnabled: true }), null, `${type}/${button}`);
	}
});

test("shouldOwnOuterMouseMode: fullscreen never owns; regular/undefined follow the switch", () => {
	assert.equal(shouldOwnOuterMouseMode("fullscreen", true), false);
	assert.equal(shouldOwnOuterMouseMode("fullscreen", false), false);
	assert.equal(shouldOwnOuterMouseMode("regular", true), true);
	assert.equal(shouldOwnOuterMouseMode("regular", false), false);
	// Old pi runtimes have no tui.mode — must behave like regular.
	assert.equal(shouldOwnOuterMouseMode(undefined, true), true);
	assert.equal(shouldOwnOuterMouseMode(undefined, false), false);
});

test("resolvePasteSelectionSource: clipboard opt-in, everything else primary", () => {
	assert.equal(resolvePasteSelectionSource(undefined), "primary");
	assert.equal(resolvePasteSelectionSource(""), "primary");
	assert.equal(resolvePasteSelectionSource("primary"), "primary");
	assert.equal(resolvePasteSelectionSource("clipboard"), "clipboard");
	assert.equal(resolvePasteSelectionSource(" CLIPBOARD "), "clipboard");
	assert.equal(resolvePasteSelectionSource("garbage"), "primary");
});

test("shouldMirrorSelectionToPrimary: only selection endings of the left button with paste enabled", () => {
	assert.equal(shouldMirrorSelectionToPrimary(ev("release", "left"), { nativePasteEnabled: true }), "mirror-primary");
	assert.equal(shouldMirrorSelectionToPrimary(ev("click", "left"), { nativePasteEnabled: true }), "mirror-primary");
	assert.equal(shouldMirrorSelectionToPrimary(ev("release", "left"), { nativePasteEnabled: false }), null);
	assert.equal(shouldMirrorSelectionToPrimary(ev("click", "left"), { nativePasteEnabled: false }), null);
	const cases = [
		["press", "left"],
		["move", "left"],
		["drag", "left"],
		["wheel", "left"],
		["release", "middle"],
		["release", "right"],
		["release", "none"],
		["click", "middle"],
		["click", "none"],
	];
	for (const [type, button] of cases) {
		assert.equal(shouldMirrorSelectionToPrimary(ev(type, button), { nativePasteEnabled: true }), null, `${type}/${button}`);
	}
});

test("splitAttachInput decodes ordered mouse / report / key segments (issue #189)", () => {
	const kinds = (input) => splitAttachInput(input).map((segment) => segment.kind);
	const data = (input) => splitAttachInput(input).flatMap((segment) => (segment.kind === "mouse" ? segment.events.map((entry) => entry.raw) : segment.data));

	assert.deepEqual(splitAttachInput(""), []);
	assert.deepEqual(kinds("\x1b[<64;10;20M\x1b[<65;10;20M"), ["mouse"]);
	assert.equal(splitAttachInput("\x1b[<64;10;20M\x1b[<65;10;20M")[0].events.length, 2);

	// the issue's repro, both orders
	assert.deepEqual(kinds("\x1b[<0;16;2m\x1b[I"), ["mouse", "report"]);
	assert.deepEqual(data("\x1b[<0;16;2m\x1b[I"), ["\x1b[<0;16;2m", "\x1b[I"]);
	assert.deepEqual(kinds("\x1b[I\x1b[<0;16;2m"), ["report", "mouse"]);
	assert.deepEqual(kinds("\x1b[I\x1b[O\x1b[<0;16;2m"), ["report", "mouse"]);
	assert.deepEqual(data("\x1b[I\x1b[O\x1b[<0;16;2m"), ["\x1b[I\x1b[O", "\x1b[<0;16;2m"]);

	// mouse/key and report/key adjacency, both orders
	assert.deepEqual(kinds("\x1b[<0;16;2mx"), ["mouse", "key"]);
	assert.deepEqual(kinds("x\x1b[<0;16;2m"), ["key", "mouse"]);
	assert.deepEqual(kinds("\x1b[Ix"), ["report", "key"]);
	assert.deepEqual(kinds("x\x1b[I"), ["key", "report"]);

	assert.deepEqual(kinds("hello"), ["key"]);
	assert.deepEqual(data("hello"), ["hello"]);

	// adjacent key runs merge: a key is only recognised when it is the whole read (spec §5)
	assert.deepEqual(kinds("\x1b[5~\x1b[6~"), ["key"]);
	assert.deepEqual(data("\x1b[5~\x1b[6~"), ["\x1b[5~\x1b[6~"]);

	// truncated sequences are not recognised and stay keyboard text
	assert.deepEqual(kinds("\x1b[<0;16"), ["key"]);
	assert.deepEqual(kinds("\x1b[?997;1"), ["key"]);
	assert.deepEqual(kinds("\x1b[<0;16\x1b[I"), ["key", "report"]);

	// the pre-existing all-or-nothing contract is untouched
	assert.equal(parseMouseInputChunk("\x1b[<64;10;20Mx"), null);
	assert.equal(parseMouseInputChunk("x\x1b[<64;10;20M"), null);
	assert.equal(parseMouseInputChunk(""), null);
});

test("splitAttachInput classifies grounded terminal reports and keeps keys as keys (issue #189)", () => {
	const reports = [
		"\x1b[I",
		"\x1b[O",
		"\x1b[?62;4;6;22c",
		"\x1b[?1;2c",
		"\x1b[>0;95;0c",
		"\x1b[?1u",
		"\x1b[?997;1n",
		"\x1b[?997;2n",
		"\x1b[6;24;80t",
		"\x1b]11;rgb:0d0d/0d0d/0d0d\x07",
		"\x1b]11;rgb:0d0d/0d0d/0d0d\x1b\\",
		"\x1b]10;#ffffff\x07",
		"\x1b]4;3;rgb:0000/0000/0000\x07",
		"\x1b]7501;?\x1b\\",
	];
	for (const sequence of reports) {
		assert.deepEqual(splitAttachInput(sequence), [{ kind: "report", data: sequence }], `report: ${JSON.stringify(sequence)}`);
	}

	// deliberately not reports: a keystroke can look like them (spec §3.1(b))
	const keys = ["a", "\x1b[A", "\x1b[1;2R", "\x1b[97;5u", "\x1b[1;5D", "\x1b[200~paste\x1b[201~", "\x1bP1+r6375;6375\x1b\\"];
	for (const sequence of keys) {
		assert.deepEqual(splitAttachInput(sequence), [{ kind: "key", data: sequence }], `key: ${JSON.stringify(sequence)}`);
	}
});
