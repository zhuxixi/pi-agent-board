// Component-level legacy-path drag coverage (issue #187): the REAL
// PtyAttachComponent against a REAL runner socket (fake pty child in default
// mode, so the buffer holds one stable line) with a fake TUI capturing
// terminal.write and a PATH-stubbed xclip logging PRIMARY writes. Verifies:
//   1. press + release with ZERO motion events across 15 columns copies the line
//      (OSC 52 payload + PRIMARY mirror) and the selection survives the 260 ms
//      pending-click timer — the Warp fast-flick byte stream;
//   2. the same gesture with a motion event in between copies the SAME text;
//   3. a same-cell press+release still behaves as a click (no copy, cleared);
//   4. two rapid same-cell clicks still select the word under the pointer and
//      copy it — the click path this change routes through.
// Run via `node --experimental-transform-types`.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-legacy-drag-"));
const viewId = "legacy-drag-e2e";
const prevPath = process.env.PATH;

// Hermetic xclip stub: log every write (args + stdin) so the PRIMARY mirror is
// observable and the host clipboard is never touched.
const binDir = join(root, "bin");
mkdirSync(binDir);
const xclipLog = join(root, "xclip.log");
writeFileSync(xclipLog, "");
writeFileSync(
	join(binDir, "xclip"),
	["#!/bin/sh", 'text="$(cat)"', `echo "write $* text=$text" >> "${xclipLog}"`].join("\n"),
);
chmodSync(join(binDir, "xclip"), 0o755);
process.env.PATH = `${binDir}:${process.env.PATH}`;

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

const meta = createView(root, { id: viewId, name: "legacy drag e2e", cwd: root });
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
	env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1" },
	cols: 80,
	rows: 22,
});

const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], {
	stdio: ["ignore", "pipe", "pipe"],
});
runner.stderr.resume();

const result = {
	error: null as string | null,
	sawContent: false,
	motionlessOsc52: null as string | null,
	motionlessPrimary: null as string | null,
	motionlessSelectionSurvives: false,
	motionlessForwardedInput: false,
	movefulOsc52: null as string | null,
	clickPressedSelection: false,
	clickOsc52: null as string | null,
	clickSelectionCleared: false,
	doubleOsc52: null as string | null,
	doubleSelectionIsWord: false,
};

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
	}, 15_000);
	if (!ready) throw new Error("host never became ready");

	// Intercept component→runner messages: mouse events must never arrive as input.
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
			.filter((m) => !!m && m.type === "input" && typeof m.data === "string");

	const writes: string[] = [];
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (s: string) => void writes.push(s) },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const component: any = new PtyAttachComponent(
		tui as never,
		theme as never,
		{} as never,
		() => {},
		{
			socketPath: readHost(root, viewId).socketPath,
			screenLogPath: P.screenLogPath(root, viewId),
			title: "legacy drag e2e",
		} as never,
	);

	// Wait for session content so the gesture lands on a settled attach (an empty
	// buffer would make the copy a silent no-op and the case vacuous).
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && !result.sawContent) {
		const lines = component.render(80) ?? [];
		if (lines.join("\n").includes("fake pi ready")) result.sawContent = true;
		else await sleep(40);
	}
	if (!result.sawContent) throw new Error("session content never rendered");

	const osc52Since = (from: number) =>
		writes
			.slice(from)
			.filter((s) => s.includes("\x1b]52;"))
			.map((s) => {
				const m = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(s);
				return m ? Buffer.from(m[1], "base64").toString("utf8") : `<unparsed:${JSON.stringify(s)}>`;
			});
	const mirroredWrites = () =>
		readFileSync(xclipLog, "utf8")
			.split("\n")
			.filter((l) => l.startsWith("write ") && l.includes("-selection primary"));
	const lastMirrored = () => {
		const lines = mirroredWrites();
		return lines.length ? (lines.at(-1) as string).replace(/^write .*?text=/, "") : null;
	};
	// A previous case's pending-click timer must never fire inside the next case.
	const resetGestureState = () => {
		component.clearPendingClick();
		component.selection = null;
		component.selectionDragging = false;
	};

	// Case 1 (A2): the reported bug — press + release, zero motion events, 15 columns.
	resetGestureState();
	const from1 = writes.length;
	const mirroredBefore1 = mirroredWrites().length;
	component.handleInput("\x1b[<0;1;2M");
	await sleep(20);
	component.handleInput("\x1b[<0;16;2m");
	await sleep(400);
	result.motionlessOsc52 = osc52Since(from1).at(-1) ?? null;
	result.motionlessSelectionSurvives = !!component.selection;
	result.motionlessForwardedInput = forwardedInputs().length > 0;
	await waitFor(() => mirroredWrites().length > mirroredBefore1, 2000);
	result.motionlessPrimary = lastMirrored();

	// Case 2 (A3): the canonical gesture (a motion event in the middle) must agree.
	resetGestureState();
	const from2 = writes.length;
	component.handleInput("\x1b[<0;1;2M");
	component.handleInput("\x1b[<32;8;2M");
	component.handleInput("\x1b[<0;16;2m");
	await sleep(400);
	result.movefulOsc52 = osc52Since(from2).at(-1) ?? null;

	// Case 3 (A4): a same-cell press+release stays a click.
	resetGestureState();
	const from3 = writes.length;
	component.handleInput("\x1b[<0;1;2M");
	await sleep(20);
	result.clickPressedSelection = !!component.selection;
	component.handleInput("\x1b[<0;1;2m");
	await sleep(400);
	result.clickOsc52 = osc52Since(from3).at(-1) ?? null;
	result.clickSelectionCleared = !component.selection;

	// Case 4 (A6): two rapid same-cell clicks still select and copy the word.
	resetGestureState();
	const from4 = writes.length;
	component.handleInput("\x1b[<0;1;2M");
	component.handleInput("\x1b[<0;1;2m");
	await sleep(60);
	component.handleInput("\x1b[<0;1;2M");
	component.handleInput("\x1b[<0;1;2m");
	await sleep(400);
	result.doubleOsc52 = osc52Since(from4).at(-1) ?? null;
	result.doubleSelectionIsWord =
		!!component.selection &&
		component.selection.anchor.line === 0 &&
		component.selection.anchor.col === 0 &&
		component.selection.focus.col === 3;

	try {
		component.dispose();
	} catch {}
} catch (err) {
	result.error = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
}

try {
	const host = readHost(root, viewId);
	if (host?.childPid) process.kill(host.childPid, "SIGKILL");
} catch {}
try {
	runner.kill("SIGKILL");
} catch {}
await sleep(80);
process.env.PATH = prevPath;
try {
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
} catch {}
console.log(JSON.stringify(result));
