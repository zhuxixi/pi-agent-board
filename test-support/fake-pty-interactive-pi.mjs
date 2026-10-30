#!/usr/bin/env node
// Issue #222 step 19 (task-19-brief.md), evidence chains 3 and 4: the
// interactive fixture child. It owns a REAL ProcessTerminal and one REAL
// pi-tui view, selected by FAKE_PTY_INTERACTIVE_MODE:
//
// - "selection": REAL TuiAltScreen + REAL SelectList (items/maxVisible/theme)
//   focused through the REAL showOverlay path. Real arrow input arrives on
//   stdin (the runner PTY) → ProcessTerminal → TuiAltScreen input chain →
//   SelectList. Every selection change is recorded as independent fixture
//   truth (the real getSelectedItem() value/label and the real focused
//   component identity). The child stays ALIVE until the outer attach detach
//   terminates it — it never finishes on its own (no stdin EOF dependency).
// - "scroll": REAL fullscreen TuiAltScreen + REAL ScrollView
//   ({follow:"end", primary:true}) over a long history plus an editor/dock
//   child. Real wheel-up SGR input arrives on stdin; the child records the
//   real scrollTop / isFollowingEnd / top visible text per wheel; after the
//   deliberate three-wheel sequence it appends new output through the real
//   child + render scheduler, records the post-append state (viewport must
//   NOT jump to the newest bottom), then scrolls to end through the real path
//   and records restored follow. It then stays ALIVE for the outer detach.
//
// Both modes capture every process.stdout.write (index/data) so the parent's
// independently-parsed byte stream and this fixture's own write facts stay
// separate, and log a real pid (child-clock evidence, never a ready flag).
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { ProcessTerminal, ScrollView, SelectList, TuiAltScreen } from "@earendil-works/pi-tui";

const eventsPath = process.env.FAKE_PTY_EVENTS_PATH ?? "";
if (!eventsPath) {
	process.stderr.write("interactive-fixture: FAKE_PTY_EVENTS_PATH is required\n");
	process.exit(2);
}
const mode = process.env.FAKE_PTY_INTERACTIVE_MODE ?? "";
if (mode !== "selection" && mode !== "scroll") {
	process.stderr.write(`interactive-fixture: unknown FAKE_PTY_INTERACTIVE_MODE ${JSON.stringify(mode)}\n`);
	process.exit(2);
}

const clockNow = () => ({ monoNs: process.hrtime.bigint().toString(), wallMs: Date.now() });
const logEvent = (event) => appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);

const capturedWrites = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (data, ...args) {
	capturedWrites.push({ index: capturedWrites.length, data: String(data) });
	return originalWrite(data, ...args);
};
const closeIndices = () => {
	const out = [];
	for (let i = 0; i < capturedWrites.length; i++) if (capturedWrites[i].data.includes("\x1b[?2026l")) out.push(i);
	return out;
};
const waitForFirstClose = async (timeoutMs) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const idx = closeIndices()[0];
		if (idx !== undefined) return idx;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return -1;
};

const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal, false, undefined, {});

if (mode === "selection") {
	const items = [
		{ value: "alpha", label: "Alpha" },
		{ value: "beta", label: "Beta" },
		{ value: "gamma", label: "Gamma" },
		{ value: "delta", label: "Delta" },
	];
	const theme = {
		selectedPrefix: (text) => text,
		selectedText: (text) => text,
		description: (text) => text,
		scrollInfo: (text) => text,
		noMatch: (text) => text,
	};
	const selectList = new SelectList(items, 3, theme, {});
	selectList.onSelectionChange = (item) => {
		const selected = selectList.getSelectedItem();
		logEvent({
			event: "selection",
			selectedItem: selected ? { value: selected.value, label: selected.label } : null,
			onSelectionChangeItem: { value: item.value, label: item.label },
			selectedIndex: items.findIndex((candidate) => candidate.value === selected?.value),
			focusIsSelectList: tui.getFocusedComponent() === selectList,
			clock: clockNow(),
		});
	};

	tui.start();
	// The select list overlay is focused through the REAL showOverlay path.
	tui.showOverlay(selectList, { anchor: "center", width: 20, maxHeight: 5 });
	const closeIdx = await waitForFirstClose(5000);
	if (closeIdx === -1) {
		process.stderr.write("interactive-fixture(selection): first render never flushed\n");
		process.exit(3);
	}
	logEvent({
		event: "ready",
		mode: "selection",
		pid: process.pid,
		closeWriteIndex: closeIdx,
		clock: clockNow(),
	});
	// Stay alive for the real outer attach detach (never self-finish).
	setInterval(() => {}, 1000);
} else {
	// "scroll": long history + editor/dock content in one ScrollView child.
	const history = Array.from({ length: 30 }, (_, i) => `HIST-${String(i + 1).padStart(2, "0")}`);
	const content = {
		render(_width) {
			return [...history, "EDITOR", "DOCK INPUT >"];
		},
		invalidate() {},
	};
	const scrollView = new ScrollView(content, { follow: "end", primary: true });
	tui.setLayoutRoot(scrollView);
	tui.start();
	const closeIdx = await waitForFirstClose(5000);
	if (closeIdx === -1) {
		process.stderr.write("interactive-fixture(scroll): first render never flushed\n");
		process.exit(3);
	}
	const topText = () => {
		const lines = content.render(process.stdout.columns ?? 80);
		const top = Math.max(0, Math.min(scrollView.scrollTop, lines.length - 1));
		return lines[top];
	};
	logEvent({
		event: "ready",
		mode: "scroll",
		pid: process.pid,
		closeWriteIndex: closeIdx,
		initial: { scrollTop: scrollView.scrollTop, isFollowingEnd: scrollView.isFollowingEnd, topText: topText() },
		clock: clockNow(),
	});

	let wheelCount = 0;
	let appended = false;
	const recordScroll = (phase) => {
		logEvent({
			event: "scroll",
			phase,
			scrollTop: scrollView.scrollTop,
			isFollowingEnd: scrollView.isFollowingEnd,
			topText: topText(),
			viewportHeight: scrollView.viewportHeight,
			clock: clockNow(),
		});
	};
	// Log-and-delegate wrapper around the REAL ScrollView.scrollBy: the real
	// wheel routing still runs it; this only observes the resulting state for
	// the evidence log (the original method and render scheduling are
	// unchanged — the same wrapper pattern as the accepted requestRender and
	// socket loggers).
	const originalScrollBy = scrollView.scrollBy.bind(scrollView);
	scrollView.scrollBy = (lines) => {
		const result = originalScrollBy(lines);
		wheelCount += 1;
		recordScroll(`wheel-up-${wheelCount}`);
		if (wheelCount === 3 && !appended) {
			appended = true;
			// Deliberate upscroll then NEW output through the real child +
			// render scheduler. The append lands BELOW the upscrolled viewport,
			// so the viewport must NOT jump to the newest bottom. The 600ms
			// delay lets the outer attach settle (ATTACH_SETTLE_MS=250) and paint
			// the upscrolled viewport BEFORE the append arrives, so the outer grid
			// independently shows the wheel-up top row (not only the final end).
			setTimeout(() => {
				const beforeAppendTop = topText();
				const beforeAppendScrollTop = scrollView.scrollTop;
				history.push(`HIST-${String(history.length + 1).padStart(2, "0")}`);
				tui.requestRender();
				setTimeout(() => {
					logEvent({
						event: "scroll",
						phase: "post-append",
						scrollTop: scrollView.scrollTop,
						isFollowingEnd: scrollView.isFollowingEnd,
						topText: topText(),
						topTextBeforeAppend: beforeAppendTop,
						scrollTopBeforeAppend: beforeAppendScrollTop,
						historyLength: history.length,
						clock: clockNow(),
					});
					scrollView.scrollToEnd();
					setTimeout(() => {
						logEvent({
							event: "scroll",
							phase: "scroll-to-end",
							scrollTop: scrollView.scrollTop,
							isFollowingEnd: scrollView.isFollowingEnd,
							topText: topText(),
							clock: clockNow(),
						});
					}, 150);
				}, 150);
			}, 600);
		}
		return result;
	};

	// Stay alive for the real outer attach detach (never self-finish).
	setInterval(() => {}, 1000);
}
