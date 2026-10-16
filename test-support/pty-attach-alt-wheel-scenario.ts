// Component-level alternate-buffer wheel coverage (issue #185): the REAL
// PtyAttachComponent against a REAL runner socket whose fake pty child holds
// the alternate screen (FAKE_PTY_STREAM_MODE=alt). In that topology the
// attach's own xterm scrollback is inert (an alternate buffer keeps no
// history), so a fullscreen wheel event must be FORWARDED to the child as one
// synthesized SGR report instead of scrolling the local viewport — the same
// fallback the keyboard path already uses.
//
// Premise (issues #198, #203): this branch is reachable only when the attach actually
// learns about the alternate screen, i.e. through the LEGACY screen-log replay path with
// the child's one-shot `\x1b[?1049h` still inside the replayed tail
// (`ATTACH_REPLAY_BYTES`). The default snapshot path carries no alternate-screen state at
// all, which is why the production topology (see pty-attach-wheel-fallback-scenario.ts)
// has to be covered by the cannot-move forwarding rule instead. The replay is read once,
// at construction, so the scenario waits for the child's first frame to reach the screen
// log before building the component — see the readiness gate below. Verifies:
//   1. wheel up/down → {handled:true, render:false} and the exact SGR report
//      reaches the runner socket as {type:"input"} (button 64 up / 65 down,
//      1-based child-screen coordinates), while viewportTop stays null
//      (follow-bottom: the child, not the attach, owns the scroll);
//   2. kill switches (AGENT_BOARD_ATTACH_MOUSE=0,
//      AGENT_BOARD_ENABLE_MOUSE_SCROLL=0) and a wheel report without a delta
//      all fall through (undefined) and forward nothing;
//   3. clearing the switches restores forwarding.
// Run via `node --experimental-transform-types`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-attach-alt-wheel-"));
const viewId = "alt-wheel-e2e";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await sleep(25);
	}
	return false;
}

const meta = createView(root, { id: viewId, name: "alt wheel attach e2e", cwd: root });
const configPath = P.hostConfigPath(root, viewId);
atomicWriteJson(configPath, {
	root,
	viewId,
	sessionFile: meta.sessionFile,
	cwd: process.cwd(),
	initialPrompt: null,
	piCommand: process.execPath,
	piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
	model: null,
	tools: null,
	env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_STREAM_MODE: "alt" },
	cols: 80,
	rows: 22,
});

const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], {
	stdio: ["ignore", "pipe", "pipe"],
});
runner.stderr.resume();

// The snapshot DTO has no alternate-screen state (issue #198), so the alt route
// can only be exercised through the legacy replay path.
process.env.AGENT_BOARD_TERMINAL_SNAPSHOT = "0";

const result = {
	error: null as string | null,
	sawAltText: false,
	sawAltContent: false,
	bufferType: null as string | null,
	framePreview: null as string | null,
	upHandled: false,
	upRenderFalse: false,
	forwardedUp: null as string | null,
	forwardedDown: null as string | null,
	viewportStayedNull: false,
	attachMouseOffFallsThrough: false,
	attachMouseOffNoForward: false,
	scrollSwitchOffFallsThrough: false,
	scrollSwitchOffNoForward: false,
	missingDeltaFallsThrough: false,
	missingDeltaNoForward: false,
	restoredAfterKillSwitch: false,
	disconnectedFallsThrough: false,
	disconnectedNoForward: false,
};

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
	}, 15_000);
	if (!ready) throw new Error("host never became ready");

	// The legacy path hydrates by replaying the screen-log tail ONCE, in the component
	// constructor (`replayScreenLog`, ATTACH_REPLAY_BYTES), and the legacy runner never
	// re-delivers bytes written before the socket connected. So the child's one-shot
	// `\x1b[?1049h` must already be in the log when the component is built — otherwise
	// the enable is lost for the whole session and the attach's xterm reads `normal`
	// forever while the live frames paint the alternate-screen text into it
	// (issue #203). Wait for the first frame before constructing the component.
	const logPath = P.screenLogPath(root, viewId);
	const firstFrameLogged = await waitFor(() => {
		try {
			const logged = readFileSync(logPath, "utf8");
			// The invariant is the enable itself, not the frame text that follows it.
			return logged.includes("\x1b[?1049h") && logged.includes("alt-frame-");
		} catch {
			return false;
		}
	}, 10_000);
	if (!firstFrameLogged) throw new Error("the child's first alternate-buffer frame never reached the screen log");

	// Intercept component→runner messages to observe forwarded {type:"input"}.
	const sent: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") sent.push(data);
		return origWrite.call(this, data, ...rest);
	};
	const forwardedInputs = () =>
		sent
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter((m) => !!m && m.type === "input" && typeof m.data === "string")
			.map((m) => m.data as string);

	// Fake TUI declares fullscreen: the component is exercised in production's
	// dispatch shape (no outer mouse-mode ownership writes, wheel via handleMouse).
	const tui = {
		mode: "fullscreen",
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	process.env.AGENT_BOARD_ATTACH_MOUSE = "1";
	const component = new PtyAttachComponent(
		tui as never,
		theme as never,
		{} as never,
		() => {},
		{
			socketPath: readHost(root, viewId).socketPath,
			screenLogPath: P.screenLogPath(root, viewId),
			title: "alt wheel attach e2e",
		} as never,
	);

	// Wait for the alternate-buffer topology to be fully established. The legacy replay can
	// land between frames, so the frame text may be visible while the attach's xterm is not
	// yet switched; poll content and buffer type together, and keep the failures
	// distinguishable — a content timeout and a buffer-type timeout are different problems
	// and must not look alike in the log (issue #203).
	const deadline = Date.now() + 25_000;
	let sawAlternateBuffer = false;
	while (Date.now() < deadline && !(result.sawAltText && sawAlternateBuffer)) {
		const lines = component.render(80) ?? [];
		const text = lines.join("\n");
		result.framePreview = text.slice(0, 400);
		if (text.includes("alt-frame-")) result.sawAltText = true;
		result.bufferType = (component as any).term.buffer.active.type;
		sawAlternateBuffer = result.bufferType === "alternate";
		if (!(result.sawAltText && sawAlternateBuffer)) await sleep(40);
	}
	result.sawAltContent = result.sawAltText && sawAlternateBuffer;
	if (!result.sawAltText) throw new Error(`alternate-buffer session content never rendered (bufferType=${result.bufferType}, frame=${JSON.stringify(result.framePreview)})`);
	if (!sawAlternateBuffer) throw new Error(`the attach's xterm stayed in the "${result.bufferType}" buffer — the alternate-screen enable never reached it (replayed tail window or construction ordering), so the scenario cannot exercise the #185 branch`);

	const mouseBase = { x: 3, y: 3, screenX: 3, screenY: 3, width: 80, height: 22, shift: false, alt: false, ctrl: false };
	const wheelEvent = (wheelDelta?: number) => ({
		...mouseBase,
		type: "wheel",
		button: "none",
		...(wheelDelta === undefined ? {} : { wheelDelta }),
	});

	// 1. Wheel up: forwarded (button 64), viewport untouched.
	let before = forwardedInputs().length;
	const up = (component as any).handleMouse(wheelEvent(-3));
	result.upHandled = !!up && up.handled === true;
	result.upRenderFalse = !!up && up.render === false;
	if (await waitFor(() => forwardedInputs().length > before, 3000)) {
		result.forwardedUp = forwardedInputs().at(-1) ?? null;
	}
	result.viewportStayedNull = (component as any).viewportTop === null;

	// 2. Wheel down: forwarded with button 65.
	before = forwardedInputs().length;
	(component as any).handleMouse(wheelEvent(2));
	if (await waitFor(() => forwardedInputs().length > before, 3000)) {
		result.forwardedDown = forwardedInputs().at(-1) ?? null;
	}

	// 3. Kill switch AGENT_BOARD_ATTACH_MOUSE=0: fall through, forward nothing.
	before = forwardedInputs().length;
	process.env.AGENT_BOARD_ATTACH_MOUSE = "0";
	result.attachMouseOffFallsThrough = (component as any).handleMouse(wheelEvent(-3)) === undefined;
	await sleep(300);
	result.attachMouseOffNoForward = forwardedInputs().length === before;
	delete process.env.AGENT_BOARD_ATTACH_MOUSE;

	// 4. Compatibility switch AGENT_BOARD_ENABLE_MOUSE_SCROLL=0: same.
	before = forwardedInputs().length;
	process.env.AGENT_BOARD_ENABLE_MOUSE_SCROLL = "0";
	result.scrollSwitchOffFallsThrough = (component as any).handleMouse(wheelEvent(-3)) === undefined;
	await sleep(300);
	result.scrollSwitchOffNoForward = forwardedInputs().length === before;
	delete process.env.AGENT_BOARD_ENABLE_MOUSE_SCROLL;

	// 5. A wheel report without a delta is not ours.
	before = forwardedInputs().length;
	result.missingDeltaFallsThrough = (component as any).handleMouse(wheelEvent()) === undefined;
	await sleep(300);
	result.missingDeltaNoForward = forwardedInputs().length === before;

	// 6. Both switches cleared ⇒ forwarding is back.
	before = forwardedInputs().length;
	(component as any).handleMouse(wheelEvent(-3));
	result.restoredAfterKillSwitch = await waitFor(() => forwardedInputs().length > before, 3000);

	// 7. Disconnected: send() would silently drop the report, so the wheel falls
	// through instead of being consumed without effect (consume-only-on-effect).
	before = forwardedInputs().length;
	(component as any).connected = false;
	result.disconnectedFallsThrough = (component as any).handleMouse(wheelEvent(-3)) === undefined;
	await sleep(300);
	result.disconnectedNoForward = forwardedInputs().length === before;
	(component as any).connected = true;

	socketProto.write = origWrite;
	try {
		(component as any).dispose();
	} catch {}
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
} finally {
	delete process.env.AGENT_BOARD_ATTACH_MOUSE;
	delete process.env.AGENT_BOARD_ENABLE_MOUSE_SCROLL;
	delete process.env.AGENT_BOARD_TERMINAL_SNAPSHOT;
	try {
		runner.kill();
	} catch {}
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
	} catch {}
}

console.log(JSON.stringify(result));
