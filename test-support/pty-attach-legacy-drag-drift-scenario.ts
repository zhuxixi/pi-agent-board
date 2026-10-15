// Component-level drift coverage (issue #187, review finding R1-G1): the REAL
// PtyAttachComponent against a REAL runner whose fake pty child streams a line
// every 25 ms (FAKE_PTY_STREAM_MODE=steady). A stationary click — same screen
// cell for press and release — must stay a click even though the stream moves
// the viewport base between the two events, so the buffer-space line of the
// release differs from the press. xclip is PATH-stubbed so the host clipboard
// is never touched and any copy would still be visible in the log.
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

const root = mkdtempSync(join(tmpdir(), "agentview-legacy-drag-drift-"));
const viewId = "legacy-drag-drift-e2e";
const prevPath = process.env.PATH;
const binDir = join(root, "bin");
mkdirSync(binDir);
const xclipLog = join(root, "xclip.log");
writeFileSync(xclipLog, "");
writeFileSync(join(binDir, "xclip"), ["#!/bin/sh", 'text="$(cat)"', `echo "write $* text=$text" >> "${xclipLog}"`].join("\n"));
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

const meta = createView(root, { id: viewId, name: "legacy drag drift e2e", cwd: root });
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
	env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_STREAM_MODE: "steady" },
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
	bufferGrew: false,
	bufferGrowth: 0,
	pressCreatedSelection: false,
	osc52: null as string | null,
	selectionCleared: false,
	mirroredWrites: 0,
};

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
	}, 15_000);
	if (!ready) throw new Error("host never became ready");

	const sent: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") sent.push(data);
		return origWrite.call(this, data, ...rest);
	};

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
			title: "legacy drag drift e2e",
		} as never,
	);

	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && !result.sawContent) {
		const lines = component.render(80) ?? [];
		if (lines.join("\n").includes("steady-")) result.sawContent = true;
		else await sleep(40);
	}
	if (!result.sawContent) throw new Error("streaming session content never rendered");

	component.clearPendingClick();
	component.selection = null;
	component.selectionDragging = false;
	const from = writes.length;
	const bufferBefore = component.term.buffer.active.length;

	// Same SCREEN cell for press and release: the stream must be the only reason the
	// two events map to different buffer lines.
	component.handleInput("\x1b[<0;1;2M");
	await sleep(20);
	result.pressCreatedSelection = !!component.selection;
	await sleep(180);
	const bufferAtRelease = component.term.buffer.active.length;
	component.handleInput("\x1b[<0;1;2m");
	await sleep(400);

	result.bufferGrowth = bufferAtRelease - bufferBefore;
	result.bufferGrew = result.bufferGrowth >= 3;
	result.osc52 = writes
		.slice(from)
		.filter((s) => s.includes("\x1b]52;"))
		.at(-1) ?? null;
	result.selectionCleared = !component.selection;
	result.mirroredWrites = readFileSync(xclipLog, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("write ") && l.includes("-selection primary")).length;

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
