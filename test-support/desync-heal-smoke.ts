// Desync heal wiring harness (issue #11): construct PtyAttachComponent with a
// fake TUI, drive it through Pi-like buffer states via the real socket-data
// path (pushOutput + checkClearSequence), then verify the 7 gates of
// checkDesync() and the end-to-end heal loop:
//   H1. healthy idle (cursor parked on inverse fake cursor) → no heal.
//   H2. desync (cursor parked elsewhere) + quiet window → exactly one heal
//       (shrink sent); immediate re-check is rate-limited + chain-idle-gated.
//   H3. pre-settle (attaching) → no heal.
//   H4. no TUI frame (tuiFrameSeen false) → no heal.
//   H5. cursor scrolled out of viewport → no heal.
//   H6. recent output (within DESYNC_QUIET_MS) → no heal.
//   H7. heal loop: child redraws with clear + cursor back on the fake cursor
//       → restore + no further heal.
// Timing/state facts the harness encodes (verified against the component and
// controller source):
//   - checkDesync gate 7 needs this.connected — injected true (no real socket).
//   - The controller must sit in runtime-idle state (tuiFrameSeen=true from a
//     2026h frame, then chain stopped by a detected \x1b[2J) — feed() learns
//     the frame BEFORE the clear; once clearDetected it short-circuits, and
//     within one chunk a clear wins over a frame start.
//   - The projected window is bottom-anchored (bottomViewportTop), so frames
//     sink 25 newlines first to land the cursor inside [start, start+height).
// Run via `node --experimental-transform-types` (TS parameter properties).
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const ESC = "\x1b";
/** Leading clear: stops the controller chain (runtime-idle state). */
const CLEAR = `${ESC}[2J${ESC}[H`;
/** Push content + cursor to the buffer bottom so they land inside the
 * bottom-anchored projection window (25 > 24-row viewport → 1 line scrollback). */
const SINK = "\n".repeat(25);
const tui = {
	terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const keybindings = {} as never;

type Drivable = {
	pushOutput: (data: string) => void;
	checkClearSequence: (data: string) => void;
	finishAttachTransition: () => void;
	checkDesync: () => void;
	attaching: boolean;
	viewportTop: number | null;
	jiggleRetry: { getState: () => { healCount: number; held: boolean; stopped: boolean; tuiFrameSeen: boolean }; feed: (data: string) => void };
};

function makeAttach() {
	const attach = new PtyAttachComponent(
		tui as never,
		theme as never,
		keybindings,
		() => {},
		{ socketPath: "/no/such/socket", title: "desync" },
	);
	const sent: Array<Record<string, unknown>> = [];
	(attach as unknown as { send: (msg: Record<string, unknown>) => void }).send = (msg) => sent.push(msg);
	// Gate 7 needs a live connection; the fake socketPath would never connect.
	(attach as unknown as { connected: boolean }).connected = true;
	// Injectable clock: start at t=1_000_000 so "unset" (0) timestamps always look stale.
	const clock = { now: 1_000_000 };
	(attach as unknown as { nowFn: () => number }).nowFn = () => clock.now;
	return { attach: attach as unknown as Drivable, sent, clock };
}

async function write(attach: Drivable, data: string): Promise<void> {
	// Mirror the real socket-data path (onSocketData → pushOutput + checkClearSequence):
	// checkClearSequence feeds the jiggle controller (2026h frame detection,
	// clear detection) — without it tuiFrameSeen stays false and gates have no teeth.
	attach.pushOutput(data);
	attach.checkClearSequence(data);
	await new Promise((r) => setTimeout(r, 20));
}

/** Bring the controller to the real runtime-idle state: 2026h frame seen
 * first (tuiFrameSeen=true), then a detected clear (chain stopped). */
async function primeRuntime(attach: Drivable): Promise<void> {
	await write(attach, `${ESC}[?2026h`);
	await write(attach, CLEAR);
}

/** Healthy idle frame: bottom line carries the inverse fake cursor and the
 * hardware cursor is parked ON it (CUP 24;7 == the inverse cell). */
const healthyFrame = `${SINK}> editor \u4f60\u597d${ESC}[7m ${ESC}[0m${ESC}[24;7H${ESC}[7m ${ESC}[0m${ESC}[24;7H`;
/** Desynced frame: same content, but the cursor ends parked on a PLAIN cell
 * one row above the inverse fake cursor (where a garbled differential write
 * left it). */
const desyncFrame = `${SINK}> editor \u4f60\u597d${ESC}[7m ${ESC}[0m${ESC}[24;7H${ESC}[7m ${ESC}[0m${ESC}[23;5H`;
/** Child response to a heal: fullRender-style clear + redraw + cursor parked
 * back on the inverse fake cursor. */
const healResponse = `${ESC}[?2026h${ESC}[2J${ESC}[H${SINK}> editor \u4f60\u597d${ESC}[7m ${ESC}[0m${ESC}[24;7H${ESC}[7m ${ESC}[0m${ESC}[24;7H${ESC}[?2026l`;

function resizes(sent: Array<Record<string, unknown>>): number {
	return sent.filter((m) => m.type === "resize").length;
}

async function main(): Promise<void> {
	const out: Record<string, boolean> = {};

	// H1: healthy idle — no heal
	{
		const { attach, sent, clock } = makeAttach();
		await primeRuntime(attach);
		await write(attach, healthyFrame);
		attach.finishAttachTransition();
		clock.now += 10_000; // all gates open — only gate 3 (aligned) can stop it
		attach.checkDesync();
		out.healthyIdleNoHeal = attach.jiggleRetry.getState().healCount === 0 && resizes(sent) === 0;
	}

	// H2: desync + quiet → exactly one heal; immediate re-check rate-limited + chain-idle-gated
	{
		const { attach, sent, clock } = makeAttach();
		await primeRuntime(attach);
		await write(attach, desyncFrame);
		attach.finishAttachTransition();
		clock.now += 10_000; // last output now older than DESYNC_QUIET_MS
		attach.checkDesync();
		const healed = attach.jiggleRetry.getState().healCount === 1 && resizes(sent) === 1;
		attach.checkDesync(); // within 10s rate limit AND chain is active (held)
		out.desyncHealsOnce = healed && attach.jiggleRetry.getState().healCount === 1 && resizes(sent) === 1;
	}

	// H3: pre-settle (attaching true) — no heal
	{
		const { attach, sent, clock } = makeAttach();
		await primeRuntime(attach);
		await write(attach, desyncFrame);
		// do NOT finishAttachTransition(); attaching is still true
		clock.now += 10_000; // all other gates open — only attaching can stop it
		attach.checkDesync();
		out.preSettleNoHeal = attach.jiggleRetry.getState().healCount === 0 && resizes(sent) === 0;
	}

	// H4: no 2026h frame — no heal
	{
		const { attach, sent, clock } = makeAttach();
		// No primeRuntime (it would set tuiFrameSeen); chain is stopped via the
		// clear so only gate 2 (no TUI frame) blocks the heal.
		await write(attach, CLEAR + "plain shell output, no TUI frame");
		attach.finishAttachTransition();
		clock.now += 10_000; // all other gates open — only the missing TUI frame can stop it
		attach.checkDesync();
		out.noFrameNoHeal = attach.jiggleRetry.getState().healCount === 0 && resizes(sent) === 0;
	}

	// H5: cursor scrolled out of the projected viewport — no heal
	{
		const { attach, sent, clock } = makeAttach();
		await primeRuntime(attach);
		// Establish scrollback well beyond the window (60 lines), leave the
		// cursor on the bottom viewport row (absolute ≈ buf.length-1), then
		// have the user scroll to the top: window [0,22) excludes the cursor.
		let scroll = "";
		for (let i = 0; i < 60; i++) scroll += `row ${i}\n`;
		await write(attach, scroll + `${ESC}[24;5H`);
		attach.finishAttachTransition();
		(attach as unknown as { viewportTop: number | null }).viewportTop = 0; // user scrolled up
		clock.now += 10_000; // all gates open — only the viewport (unknown) path can stop it
		attach.checkDesync();
		out.scrolledOutNoHeal = attach.jiggleRetry.getState().healCount === 0 && resizes(sent) === 0;
	}

	// H6: recent output (inside the quiet window) — no heal
	{
		const { attach, sent, clock } = makeAttach();
		await primeRuntime(attach);
		await write(attach, desyncFrame);
		attach.finishAttachTransition();
		clock.now += 100; // way less than DESYNC_QUIET_MS
		attach.checkDesync();
		out.recentOutputNoHeal = attach.jiggleRetry.getState().healCount === 0 && resizes(sent) === 0;
	}

	// H7: heal loop closes — child clears + parks cursor on the fake cursor again
	{
		const { attach, sent, clock } = makeAttach();
		await primeRuntime(attach);
		await write(attach, desyncFrame);
		attach.finishAttachTransition();
		clock.now += 10_000;
		attach.checkDesync();
		const shrinkSeen = attach.jiggleRetry.getState().healCount === 1;
		// Child answers the shrink with a fullRender: clear + redraw + cursor on fake cursor.
		await write(attach, healResponse);
		const restored = attach.jiggleRetry.getState().held === false && attach.jiggleRetry.getState().stopped === true;
		clock.now += 10_000; // next probe tick: aligned now, and budget intact
		attach.checkDesync();
		out.healLoopCloses = shrinkSeen && restored && attach.jiggleRetry.getState().healCount === 1 && resizes(sent) === 2; // heal shrink + controller restore
	}

	console.log(JSON.stringify(out));
	const allOk = Object.values(out).every(Boolean);
	if (!allOk) process.exitCode = 1;
}

void main();
