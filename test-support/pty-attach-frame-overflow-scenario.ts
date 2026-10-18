// Production-topology scenario for issue #205 (A4–A7): the REAL
// PtyAttachComponent hydrating a REAL runner snapshot whose 65-row frame is
// taller than the attach viewport (rows 40 → body 38).
//
// Why this exists: hydrating a frame that overflows the local terminal scrolls
// the top rows into the attach's own xterm scrollback, so `tryScrollBy()` used
// to succeed for 27 notches and the wheel never reached the hosted session.
// `historyFloor` (baseY minus the runner-authoritative scrollback line count)
// is what makes the first notch forward. The numbers below are the topology
// pin from spec §2.3/§6, and they only hold while the frame is delivered
// UNCHANGED:
//
//   - the fake runner is a real named pipe and answers `subscribe_terminal`
//     with a fixed `captureTerminalSnapshot()` + `synthesizeFullRedrawFrame()`
//     capture, as the spec's §6 "frame delivery seam" (option 1) requires: an
//     `resize` control message is IGNORED, never re-captured at the attach's
//     smaller size (a re-capture would collapse `attachBaseY === 27`);
//   - the socket is really connected so `forwardWheelToChild()` actually sends,
//     and `Socket.prototype.write` is intercepted (same pattern as
//     `pty-attach-wheel-fallback-scenario.ts`) to observe the forwarded
//     `{type:"input"}` lines;
//   - no `screenLogPath` is passed, so the legacy screen-log replay cannot
//     contribute scrollback or `receivedOutput`.
//
// Cases: main overflow hydrate + wheel, real-history variant (100 runner
// scrollback lines still scroll locally, first forward on notch 101), reset
// (empty baseline), resize (floor re-based on the observed baseY), and
// missing `scrollbackLines` (older runner: local history disabled, not NaN).
//
// `tuiDispatch` is the end-to-end smoke on top of the main case: a fresh
// hydrated component is mounted as an overlay on the REAL TuiAltScreen and the
// wheel arrives as a raw SGR report through `handleTerminalInput()` — the path
// a live fullscreen session takes — instead of a hand-built mouse event.
//
// Run via `node --experimental-transform-types`; prints one JSON line.
import { createServer, Socket, type Server } from "node:net";
import { TuiAltScreen } from "@earendil-works/pi-tui/dist/tui-alt-screen.js";
import { createTerminalModel, feedOutput, whenIdle } from "../src/core/terminal-model.mjs";
import { captureTerminalSnapshot, synthesizeFullRedrawFrame } from "../src/core/terminal-snapshot.mjs";
import { scrollableHistoryLines } from "../src/core/pty-scroll.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const RUNNER_ROWS = 65;
const ATTACH_TERMINAL_ROWS = 40;
const FRAME_VERSION = 1;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await sleep(25);
	}
	return false;
}

// Collect the component→runner `{type:"input"}` lines. The fake runner lives in
// this same process, so its own snapshot writes traverse the same prototype;
// filtering by type keeps this to the forwarded wheel reports.
const forwardedInputs: string[] = [];
const socketProto = Socket.prototype as any;
const origSocketWrite = socketProto.write;
socketProto.write = function (data: any, ...rest: any[]) {
	if (typeof data === "string") {
		try {
			const msg = JSON.parse(data);
			if (msg && msg.type === "input" && typeof msg.data === "string") forwardedInputs.push(msg.data);
		} catch {
			// Not a protocol line (raw child bytes never reach this socket).
		}
	}
	return origSocketWrite.call(this, data, ...rest);
};

let pipeCounter = 0;

/** The runner's fixed capture, served verbatim to every `subscribe_terminal`. */
async function startFakeRunner({ dto, frame, omitScrollbackLines = false }: { dto: any; frame: string; omitScrollbackLines?: boolean }) {
	const pipePath = `\\\\.\\pipe\\attach-frame-overflow-${process.pid}-${Date.now()}-${++pipeCounter}`;
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				let msg: any;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				// Only the subscribe is answered. A `resize` is deliberately ignored
				// (spec §6): the 65-row capture is the precondition for A4's baseY.
				if (!msg || msg.type !== "subscribe_terminal") continue;
				const end = omitScrollbackLines
					? { type: "snapshot_end", nextSeq: dto.snapshotSeq + 1 }
					: { type: "snapshot_end", nextSeq: dto.snapshotSeq + 1, scrollbackLines: dto.scrollback.length };
				socket.write(
					`${JSON.stringify({ type: "snapshot_begin", snapshotSeq: dto.snapshotSeq, cols: dto.cols, rows: dto.rows, frameVersion: FRAME_VERSION })}\n` +
						`${JSON.stringify({ type: "snapshot_frame", frameVersion: FRAME_VERSION, data: frame })}\n` +
						`${JSON.stringify(end)}\n`,
				);
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(pipePath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		pipePath,
		close: () => {
			for (const socket of sockets) {
				try {
					socket.destroy();
				} catch {
					/* best-effort teardown */
				}
			}
			server.close();
		},
	};
}

function buildScreenText(lineCount: number): string {
	const lines: string[] = [];
	for (let i = 0; i < lineCount; i++) {
		lines.push(`frame-overflow line ${String(i + 1).padStart(3, "0")} ${".".repeat(24)}`);
	}
	return lines.join("\r\n");
}

async function buildRunnerModel(lineCount: number) {
	const model = createTerminalModel({ cols: 300, rows: RUNNER_ROWS, scrollback: 2000 });
	feedOutput(model, buildScreenText(lineCount));
	await whenIdle(model);
	return model;
}

async function drain(component: any): Promise<void> {
	// @xterm/headless parses asynchronously: an empty trailing write resolves only
	// after everything queued before it (the frame) has been parsed, which is the
	// point where `historyFloor` and baseY are final.
	await new Promise<void>((resolve) => component.term.write("", resolve));
}

const cleanups: Array<() => void> = [];

/** Attach a real component to a fake runner serving `model`'s fixed capture. */
async function hydrate(
	model: any,
	{ omitScrollbackLines = false, tui: tuiOverride }: { omitScrollbackLines?: boolean; tui?: any } = {},
) {
	const dto = await captureTerminalSnapshot(model);
	const frame = await synthesizeFullRedrawFrame(dto);
	const runner = await startFakeRunner({ dto, frame, omitScrollbackLines });
	const tui = tuiOverride ?? {
		mode: "fullscreen",
		terminal: { rows: ATTACH_TERMINAL_ROWS, cols: 300, columns: 300, write: () => {} },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const component: any = new PtyAttachComponent(tui as never, theme as never, {} as never, () => {}, {
		socketPath: runner.pipePath,
		title: "frame overflow",
	} as never);
	cleanups.push(() => {
		try {
			component.dispose();
		} catch {}
		runner.close();
	});
	const ready = await waitFor(() => component.attachMode === "protocol" && component.receivedOutput, 10_000);
	if (!ready) {
		throw new Error(`attach never hydrated (mode=${component.attachMode}, receivedOutput=${component.receivedOutput})`);
	}
	await drain(component);
	return { component, dto };
}

// pi-tui convention: negative wheelDelta scrolls up.
const WHEEL_UP = {
	type: "wheel",
	button: "none",
	wheelDelta: -1,
	x: 3,
	y: 3,
	screenX: 3,
	screenY: 3,
	width: 80,
	height: 22,
	shift: false,
	alt: false,
	ctrl: false,
};

/** Drive wheel notches until the first forwarded report; 0 = never forwarded. */
function firstForwardNotch(component: any, maxNotches: number): { at: number; data: string | null } {
	const before = forwardedInputs.length;
	for (let notch = 1; notch <= maxNotches; notch++) {
		component.handleMouse({ ...WHEEL_UP });
		if (forwardedInputs.length > before) {
			return { at: notch, data: forwardedInputs[forwardedInputs.length - 1] };
		}
	}
	return { at: 0, data: null };
}

const result = {
	error: null as string | null,
	runnerScrollback: -1,
	attachBaseY: -1,
	historyFloor: -1,
	scrollableHistoryLines: -1,
	bodyHeight: -1,
	bottomViewportTop: -1,
	firstForwardAt: -1,
	firstForwardData: null as string | null,
	viewportTop: null as number | null,
	realHistoryCase: { scrollable: -1, firstForwardAt: -1 },
	resetCase: { historyFloor: -1, baseY: -1 },
	resizeCase: { baseY: -1, historyFloor: -1, scrollableHistoryLines: -1 },
	missingFieldCase: { attachBaseY: -1, historyFloor: -1, firstForwardAt: -1 },
	tuiDispatch: { overlayLayouts: 0, handleMouseCalls: 0, firstForwardAt: 0 },
};

try {
	// --- Main case (A4): a 65-row frame in a 38-row attach viewport ------------
	const main = await hydrate(await buildRunnerModel(RUNNER_ROWS));
	result.runnerScrollback = main.dto.scrollback.length;
	if (result.runnerScrollback !== 0) {
		throw new Error(`main case must snapshot without scrollback, got ${result.runnerScrollback}`);
	}
	const attachBuf = main.component.term.buffer.active;
	const bodyHeight = main.component.bodyHeight();
	const bottomViewportTop = main.component.bottomViewportTop(bodyHeight);
	result.attachBaseY = attachBuf.baseY;
	result.historyFloor = main.component.historyFloor;
	result.bodyHeight = bodyHeight;
	result.bottomViewportTop = bottomViewportTop;
	result.scrollableHistoryLines = scrollableHistoryLines(attachBuf.baseY, main.component.historyFloor);
	const mainNotch = firstForwardNotch(main.component, 40);
	result.firstForwardAt = mainNotch.at;
	result.firstForwardData = mainNotch.data;
	result.viewportTop = main.component.viewportTop;

	// --- Real-history case (A5): runner-vouched scrollback still scrolls -------
	const historyModel = await buildRunnerModel(RUNNER_ROWS + 100);
	const history = await hydrate(historyModel);
	if (history.dto.scrollback.length !== 100) {
		throw new Error(`real-history case must snapshot 100 scrollback lines, got ${history.dto.scrollback.length}`);
	}
	const historyBuf = history.component.term.buffer.active;
	result.realHistoryCase.scrollable = scrollableHistoryLines(historyBuf.baseY, history.component.historyFloor);
	result.realHistoryCase.firstForwardAt = firstForwardNotch(history.component, 120).at;

	// --- Reset case (A6b): an empty baseline clears the floor ------------------
	const reset = await hydrate(await buildRunnerModel(RUNNER_ROWS));
	reset.component.handleAttachEvent("snapshotReady", { empty: true });
	await drain(reset.component);
	result.resetCase.historyFloor = reset.component.historyFloor;
	result.resetCase.baseY = reset.component.term.buffer.active.baseY;

	// --- Resize case (A6): a narrower render re-bases the floor -----------------
	const resized = await hydrate(await buildRunnerModel(RUNNER_ROWS));
	resized.component.render(120);
	await drain(resized.component);
	const resizedBuf = resized.component.term.buffer.active;
	result.resizeCase.baseY = resizedBuf.baseY;
	result.resizeCase.historyFloor = resized.component.historyFloor;
	result.resizeCase.scrollableHistoryLines = scrollableHistoryLines(resizedBuf.baseY, resized.component.historyFloor);

	// --- Missing-field case (A7): a runner without scrollbackLines --------------
	const missing = await hydrate(await buildRunnerModel(RUNNER_ROWS), { omitScrollbackLines: true });
	result.missingFieldCase.attachBaseY = missing.component.term.buffer.active.baseY;
	result.missingFieldCase.historyFloor = missing.component.historyFloor;
	result.missingFieldCase.firstForwardAt = firstForwardNotch(missing.component, 40).at;

	// --- Fullscreen dispatch case (Task 5): the wheel through the real TUI -----
	// The stub terminal only has to satisfy the dispatcher: columns/rows build the
	// normalized wheel event and size the overlay. `renderedOverlayLayouts` is
	// filled by compositeOverlays(), so that render pass is what makes the overlay
	// hit-testable — without it dispatchMouseToOverlay() finds no target and the
	// raw SGR report would only reach the viewport router, never the component.
	const stubTerminal = {
		columns: 300,
		rows: ATTACH_TERMINAL_ROWS,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		setProgramStatus() {},
	};
	const tui = new TuiAltScreen(stubTerminal as never, false, undefined, { mouse: true, wheelScrollLines: 1 });
	const overlay = await hydrate(await buildRunnerModel(RUNNER_ROWS), { tui });
	const dispatcher = tui as unknown as {
		handleTerminalInput(data: string): void;
		compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[];
		renderedOverlayLayouts: unknown[];
	};
	tui.showOverlay(overlay.component, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
	await drain(overlay.component);
	dispatcher.compositeOverlays(tui.render(300), 300, ATTACH_TERMINAL_ROWS);
	let handleMouseCalls = 0;
	const originalHandleMouse = overlay.component.handleMouse.bind(overlay.component);
	overlay.component.handleMouse = (event: any) => {
		handleMouseCalls += 1;
		return originalHandleMouse(event);
	};
	const forwardedBefore = forwardedInputs.length;
	let tuiFirstForwardAt = 0;
	for (let notch = 1; notch <= 5; notch++) {
		// SGR wheel-up at column 10, row 10: the dispatcher turns it into a
		// wheel event for the overlay that covers the pointer.
		dispatcher.handleTerminalInput("\x1b[<64;10;10M");
		if (forwardedInputs.length > forwardedBefore) {
			tuiFirstForwardAt = notch;
			break;
		}
	}
	result.tuiDispatch = {
		overlayLayouts: dispatcher.renderedOverlayLayouts.length,
		handleMouseCalls,
		firstForwardAt: tuiFirstForwardAt,
	};
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
} finally {
	for (const cleanup of cleanups.reverse()) {
		try {
			cleanup();
		} catch {}
	}
	socketProto.write = origSocketWrite;
}

console.log(JSON.stringify(result));
process.exit(0);
