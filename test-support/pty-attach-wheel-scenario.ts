// Component-level fullscreen wheel coverage (issue #173 follow-up): the REAL
// PtyAttachComponent with a fake TUI and a nonexistent control socket (on
// non-Windows, connect() short-circuits to its reconnect loop before creating a
// socket — no socket churn), its xterm scrollback filled directly so the local
// viewport has somewhere to travel.
//
// Why this needs its own scenario: the renderer's routeWheel fallback only moves
// real ScrollView components, while the attach viewport paints its own xterm
// scrollback. A wheel event we hand back unconsumed therefore scrolls nothing at
// all, and the fullscreen wheel goes dead. No runner socket and no xclip stub are
// involved, so the case stays green on Windows too.
// Cases:
//   1. wheel up with scrollback available → {handled:true, render:false} and the
//      viewport travels up by exactly the reported delta;
//   2. wheel down → consumed while it moves, lands back on follow-bottom (null),
//      and the NEXT downward wheel falls through (undefined) instead of
//      swallowing the event;
//   3. a wheel report with no delta, and a non-wheel press, both fall through.
// Run via `node --experimental-transform-types`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), "agentview-attach-wheel-"));
const socketPath = join(root, "nonexistent.sock");
process.env.AGENT_BOARD_ATTACH_MOUSE = "1";

const tui = {
	mode: "fullscreen",
	terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

const mouseBase = { x: 3, y: 3, screenX: 3, screenY: 3, width: 80, height: 22, shift: false, alt: false, ctrl: false };
// pi-tui convention: negative wheelDelta scrolls up.
const wheelEvent = (wheelDelta?: number) => ({
	...mouseBase,
	type: "wheel",
	button: "none",
	...(wheelDelta === undefined ? {} : { wheelDelta }),
});

const result = {
	error: null as string | null,
	room: 0,
	upHandled: false,
	upRenderFalse: false,
	upMovedByDelta: false,
	downHandled: false,
	downLandedOnBottom: false,
	atBottomFallsThrough: false,
	missingDeltaFallsThrough: false,
	nonWheelFallsThrough: false,
};

let component: any = null;
try {
	component = new PtyAttachComponent(
		tui as never,
		theme as never,
		{} as never,
		() => {},
		{ socketPath, title: "wheel e2e" } as never,
	);
	// Fill the attach scrollback so the local viewport can actually travel.
	await new Promise<void>((resolve) => component.term.write("scrollback line\r\n".repeat(200), resolve));
	await sleep(50);

	const bottom = component.bottomViewportTop(component.bodyHeight());
	result.room = bottom;
	if (bottom <= 0) throw new Error("scrollback never exceeded one screen");

	// 1. Wheel up scrolls locally by exactly the reported delta.
	const up = component.handleMouse(wheelEvent(-3));
	result.upHandled = !!up && up.handled === true;
	result.upRenderFalse = !!up && up.render === false;
	result.upMovedByDelta = component.viewportTop === bottom - 3;

	// 2. Wheel down is consumed while it still moves, and lands on follow-bottom.
	const down = component.handleMouse(wheelEvent(600));
	result.downHandled = !!down && down.handled === true;
	result.downLandedOnBottom = component.viewportTop === null;
	result.atBottomFallsThrough = component.handleMouse(wheelEvent(600)) === undefined;

	// 3. Nothing-to-scroll and non-wheel events are never swallowed. Native paste
	// is off so the middle press cannot reach the xclip path.
	process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE = "0";
	result.missingDeltaFallsThrough = component.handleMouse(wheelEvent()) === undefined;
	result.nonWheelFallsThrough = component.handleMouse({ ...mouseBase, type: "press", button: "middle" }) === undefined;
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
} finally {
	delete process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE;
	try {
		component?.dispose();
	} catch {}
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
	} catch {}
}

console.log(JSON.stringify(result));
process.exit(0);
