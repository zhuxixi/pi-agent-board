import assert from "node:assert/strict";
import test from "node:test";
import {
	encodeWheelReport,
	historyFloorAfterHydrate,
	mouseWheelDirection,
	parseMouseEvent,
	parseMouseInputChunk,
	resizeJiggleSize,
	resolveAttachMouseAction,
	resolveAttachWheelRoute,
	resolvePasteSelectionSource,
	resolveWheelLines,
	sameMousePoint,
	sameScreenCell,
	scrollableHistoryLines,
	scrollViewportTop,
	selectionDragScrollLines,
	selectionReleaseIsDrag,
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
test("sameMousePoint: same buffer line within the 1-cell slack", () => {
	assert.equal(sameMousePoint({ line: 4, col: 10 }, { line: 4, col: 10 }), true);
	assert.equal(sameMousePoint({ line: 4, col: 10 }, { line: 4, col: 11 }), true);
	assert.equal(sameMousePoint({ line: 4, col: 10 }, { line: 4, col: 12 }), false);
	assert.equal(sameMousePoint({ line: 4, col: 10 }, { line: 5, col: 10 }), false);
});

test("sameScreenCell: same screen row within the 1-cell slack", () => {
	assert.equal(sameScreenCell({ row: 2, col: 1 }, { row: 2, col: 1 }), true);
	assert.equal(sameScreenCell({ row: 2, col: 1 }, { row: 2, col: 2 }), true);
	assert.equal(sameScreenCell({ row: 2, col: 1 }, { row: 2, col: 3 }), false);
	assert.equal(sameScreenCell({ row: 2, col: 1 }, { row: 3, col: 1 }), false);
});

test("selectionReleaseIsDrag: geometry decides in screen cells; missing geometry degrades to a click", () => {
	const press = { row: 2, col: 1 };
	// a motion event always wins
	assert.equal(selectionReleaseIsDrag({ dragging: true, pressScreen: press, releaseScreen: press }), true);
	assert.equal(selectionReleaseIsDrag({ dragging: true, pressScreen: null, releaseScreen: null }), true);
	// a stationary gesture is a click, including the 1-cell report slack
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: { row: 2, col: 1 } }), false);
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: { row: 2, col: 2 } }), false);
	// motion-less drags: horizontally past the slack, or any vertical movement
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: { row: 2, col: 16 } }), true);
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: { row: 3, col: 1 } }), true);
	// an out-of-body release compares RAW reported cells, never the clamped buffer point
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: { row: 30, col: 16 } }), true);
	// missing geometry degrades to the pre-fix answer
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: null, releaseScreen: press }), false);
	assert.equal(selectionReleaseIsDrag({ dragging: false, pressScreen: press, releaseScreen: null }), false);

});

// Issue #188: in the X10/normal encoding (ESC [ M Cb Cx Cy, each byte = value
// + 32) the low two bits of Cb are the button, except value 3, which is the
// protocol's release code and carries no button identity; bit 5 is motion and
// bit 6 is wheel. Classifying 3 as a press made the attach surface clear the
// drag selection on release instead of copying it.
test("parseMouseEvent classifies X10 button codes (issue #188)", () => {
	// Cb = 0/1/2: left/middle/right press. col 1, row 2 (body row 0).
	assert.deepEqual(parseMouseEvent("\x1b[M !\""), { encoding: "x10", button: 0, col: 1, row: 2, action: "press" });
	assert.deepEqual(parseMouseEvent("\x1b[M!!\""), { encoding: "x10", button: 1, col: 1, row: 2, action: "press" });
	assert.deepEqual(parseMouseEvent("\x1b[M\"!\""), { encoding: "x10", button: 2, col: 1, row: 2, action: "press" });
	// Cb = 32: motion (col 8); Cb = 32|3: motion without a button held.
	assert.deepEqual(parseMouseEvent("\x1b[M@(\""), { encoding: "x10", button: 32, col: 8, row: 2, action: "move" });
	assert.deepEqual(parseMouseEvent("\x1b[MC!\""), { encoding: "x10", button: 35, col: 1, row: 2, action: "move" });
	// Cb = 3: release; 3|4 shift, 3|16 ctrl must stay releases.
	assert.deepEqual(parseMouseEvent("\x1b[M#!\""), { encoding: "x10", button: 3, col: 1, row: 2, action: "release" });
	assert.deepEqual(parseMouseEvent("\x1b[M#4\""), { encoding: "x10", button: 3, col: 20, row: 2, action: "release" });
	assert.deepEqual(parseMouseEvent("\x1b[M'!\""), { encoding: "x10", button: 7, col: 1, row: 2, action: "release" });
	assert.deepEqual(parseMouseEvent("\x1b[M3!\""), { encoding: "x10", button: 19, col: 1, row: 2, action: "release" });
	// Cb = 64/65: wheel, and the release rule must not capture it.
	assert.deepEqual(parseMouseEvent("\x1b[M`!\""), { encoding: "x10", button: 64, col: 1, row: 2, action: "press" });
	assert.deepEqual(parseMouseEvent("\x1b[Ma!\""), { encoding: "x10", button: 65, col: 1, row: 2, action: "press" });
	// Cb = 67 (64|3, horizontal wheel): the wheel bit must win over the low bits.
	assert.deepEqual(parseMouseEvent("\x1b[Mc!\""), { encoding: "x10", button: 67, col: 1, row: 2, action: "press" });
	assert.equal(mouseWheelDirection("\x1b[M`!\""), 1);
	assert.equal(mouseWheelDirection("\x1b[Ma!\""), -1);
});

test("parseMouseInputChunk decodes a concatenated X10 gesture in order (issue #188)", () => {
	assert.deepEqual(parseMouseInputChunk("\x1b[M !\"\x1b[M@(\"\x1b[M#4\""), [
		{ length: 6, raw: "\x1b[M !\"", mouse: { encoding: "x10", button: 0, col: 1, row: 2, action: "press" } },
		{ length: 6, raw: "\x1b[M@(\"", mouse: { encoding: "x10", button: 32, col: 8, row: 2, action: "move" } },
		{ length: 6, raw: "\x1b[M#4\"", mouse: { encoding: "x10", button: 3, col: 20, row: 2, action: "release" } },
	]);
	// Seven bytes is not an X10 report: the all-or-nothing chunk parser rejects it
	// (#189), which is why every literal above is exactly six bytes.
	assert.equal(parseMouseInputChunk("\x1b[M !\"\x1b[M#20\""), null);
});

test("historyFloorAfterHydrate disables local history when hydration overflowed", () => {
	assert.equal(historyFloorAfterHydrate(27, 0), 27);
	// overflow => local history disabled (the manufactured rows sit above the oldest real rows)
	assert.equal(historyFloorAfterHydrate(127, 100), 127);
	assert.equal(historyFloorAfterHydrate(5, 10), 0);
	assert.equal(historyFloorAfterHydrate(0, 0), 0);
});

test("historyFloorAfterHydrate never returns NaN for unvalidated input", () => {
	assert.equal(historyFloorAfterHydrate(undefined, 0), 0);
	assert.equal(historyFloorAfterHydrate(27, undefined), 27);
	assert.equal(historyFloorAfterHydrate(Number.NaN, Number.NaN), 0);
	assert.equal(historyFloorAfterHydrate(27, Number.POSITIVE_INFINITY), 27);
});

test("scrollableHistoryLines reports only the rows above the floor", () => {
	assert.equal(scrollableHistoryLines(27, 27), 0);
	assert.equal(scrollableHistoryLines(127, 27), 100);
	assert.equal(scrollableHistoryLines(0, 0), 0);
	assert.equal(scrollableHistoryLines(5, 9), 0);
});

test("scrollViewportTop honours the floor and matches the legacy behaviour at floor 0", () => {
	// floor === bottom: nothing to scroll back to
	assert.deepEqual(scrollViewportTop(null, 27, 1, 27), { viewportTop: null, changed: false });
	assert.deepEqual(scrollViewportTop(27, 27, 1, 27), { viewportTop: null, changed: false });
	// floor 0 must reproduce the pre-change contract exactly
	assert.deepEqual(scrollViewportTop(null, 27, 1, 0), { viewportTop: 26, changed: true });
	assert.deepEqual(scrollViewportTop(27, 27, 1), { viewportTop: 26, changed: true });
	assert.deepEqual(scrollViewportTop(0, 27, 1, 0), { viewportTop: 0, changed: false });
	// floor clamps a downward scroll the same way bottom does
	assert.deepEqual(scrollViewportTop(5, 27, -5, 10), { viewportTop: 15, changed: true });
});

test("scrollViewportTop snaps a below-floor viewport up to the floor without consuming", () => {
	// Issue #205: a viewport parked below a floor that later rose (hydrate/resize)
	// must settle onto the floor instead of scrolling the pseudo history in between.
	assert.deepEqual(scrollViewportTop(3, 27, 1, 27), { viewportTop: null, changed: false });
	assert.deepEqual(scrollViewportTop(3, 27, 1, 10), { viewportTop: 10, changed: false });
});
