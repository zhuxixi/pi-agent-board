// Component-level production-topology wheel coverage (issue #198): the REAL
// PtyAttachComponent against a real runner whose fake child enters the alternate
// screen ONCE and then paints absolute-positioned frames with enough volume that
// the enable falls outside the attach's 100 KB screen-log replay window.
//
// That is the topology every real session is in (a fullscreen TUI sends
// `\x1b[?1049h` at startup, long before the attach replays the tail), and it is
// why #185's buffer-type routing alone is not enough: the attach's own xterm
// reads `normal`, the wheel routes "local", and there is no attach-local
// scrollback to move. The wheel must therefore be forwarded to the child
// whenever the local viewport cannot move — exactly like PageUp/PageDown.
//
// Verifies:
//   1. topology pin: the attach's buffer is `normal` and the local viewport has
//      no room to travel, despite the child holding the alternate screen;
//   2. wheel up/down → {handled:true, render:false}, the exact SGR report
//      reaches the runner as {type:"input"} (button 64 up / 65 down, 1-based
//      child-screen coordinates, +8 for Alt+wheel — issue #214), and the
//      attach's own viewport never moves;
//   3. the kill switches still fall through and forward nothing.
// Run via `node --experimental-transform-types`.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-attach-wheel-fallback-"));
const viewId = "wheel-fallback-e2e";

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

const meta = createView(root, { id: viewId, name: "wheel fallback attach e2e", cwd: root });
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
	env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_STREAM_MODE: "alt-flood", FAKE_PTY_ALT_ROWS: "22" },
	cols: 80,
	rows: 22,
});

const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], {
	stdio: ["ignore", "pipe", "pipe"],
});
runner.stderr.resume();

const result = {
	error: null as string | null,
	screenLogBytes: 0,
	sawContent: false,
	bufferType: null as string | null,
	localRoom: null as number | null,
	upHandled: false,
	upRenderFalse: false,
	forwardedUp: null as string | null,
	forwardedDown: null as string | null,
	forwardedAltUp: null as string | null,
	forwardedAltDown: null as string | null,
	viewportStayedNull: false,
	attachMouseOffFallsThrough: false,
	attachMouseOffNoForward: false,
};

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
	}, 15_000);
	if (!ready) throw new Error("host never became ready");

	// Let the child flood past the 100 KB replay window BEFORE attaching: that is
	// what makes the alternate-screen enable unrecoverable for the attach.
	const logPath = P.screenLogPath(root, viewId);
	const flooded = await waitFor(() => {
		try {
			return statSync(logPath).size > 130_000;
		} catch {
			return false;
		}
	}, 20_000);
	if (!flooded) throw new Error("child never flooded past the replay window");
	result.screenLogBytes = statSync(logPath).size;

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

	const tui = {
		mode: "fullscreen",
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const component = new PtyAttachComponent(
		tui as never,
		theme as never,
		{} as never,
		() => {},
		{
			socketPath: readHost(root, viewId).socketPath,
			screenLogPath: logPath,
			title: "wheel fallback attach e2e",
		} as never,
	);

	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline && !result.sawContent) {
		const lines = component.render(80) ?? [];
		if (lines.join("\n").includes("alt-flood-")) result.sawContent = true;
		else await sleep(40);
	}
	if (!result.sawContent) throw new Error("session content never rendered");

	const buf = (component as any).term.buffer.active;
	result.bufferType = buf.type;
	result.localRoom = (component as any).bottomViewportTop((component as any).bodyHeight());

	const mouseBase = { x: 3, y: 3, screenX: 3, screenY: 3, width: 80, height: 22, shift: false, alt: false, ctrl: false };
	const wheelEvent = (wheelDelta: number) => ({ ...mouseBase, type: "wheel", button: "none", wheelDelta });

	// 1. Wheel up: local has nowhere to go, so the child must get the report.
	let before = forwardedInputs().length;
	const up = (component as any).handleMouse(wheelEvent(-3));
	result.upHandled = !!up && up.handled === true;
	result.upRenderFalse = !!up && up.render === false;
	if (await waitFor(() => forwardedInputs().length > before, 3000)) {
		result.forwardedUp = forwardedInputs().at(-1) ?? null;
	}
	result.viewportStayedNull = (component as any).viewportTop === null;

	// 2. Wheel down: same route, button 65.
	before = forwardedInputs().length;
	(component as any).handleMouse(wheelEvent(2));
	if (await waitFor(() => forwardedInputs().length > before, 3000)) {
		result.forwardedDown = forwardedInputs().at(-1) ?? null;
	}

	// 3. Alt+wheel: the overlay already received the Alt bit from pi-tui, so the
	// forwarded report must keep it (issue #214) — button 72 up / 73 down.
	before = forwardedInputs().length;
	(component as any).handleMouse({ ...wheelEvent(-3), alt: true });
	if (await waitFor(() => forwardedInputs().length > before, 3000)) {
		result.forwardedAltUp = forwardedInputs().at(-1) ?? null;
	}
	before = forwardedInputs().length;
	(component as any).handleMouse({ ...wheelEvent(2), alt: true });
	if (await waitFor(() => forwardedInputs().length > before, 3000)) {
		result.forwardedAltDown = forwardedInputs().at(-1) ?? null;
	}

	// 4. Kill switch: fall through, forward nothing.
	before = forwardedInputs().length;
	process.env.AGENT_BOARD_ATTACH_MOUSE = "0";
	result.attachMouseOffFallsThrough = (component as any).handleMouse(wheelEvent(-3)) === undefined;
	await sleep(300);
	result.attachMouseOffNoForward = forwardedInputs().length === before;
	delete process.env.AGENT_BOARD_ATTACH_MOUSE;

	socketProto.write = origWrite;
	try {
		(component as any).dispose();
	} catch {}
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
} finally {
	delete process.env.AGENT_BOARD_ATTACH_MOUSE;
	try {
		runner.kill();
	} catch {}
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
	} catch {}
}

console.log(JSON.stringify(result));
