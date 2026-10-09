// Component-level mouse-dispatch coverage (issue #167): the REAL
// PtyAttachComponent against a REAL runner socket (fake pty child in
// steady-stream mode) with a fake TUI and a PATH-stubbed xclip that prints a
// fixture string. Verifies:
//   1. fullscreen path: handleMouse(press middle) → {handled:true, render:false}
//      and the
//      X11 PRIMARY fixture reaches the attach socket as {type:"input"};
//   2. kill switch: AGENT_BOARD_ATTACH_NATIVE_PASTE=0 → handleMouse returns
//      undefined and forwards nothing;
//   3. legacy path (regular-mode regression): the SGR middle-press sequence
//      via handleInput behaves identically.
// Run via `node --experimental-transform-types`.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-attach-mouse-"));
const viewId = "mouse-e2e";
const FIXTURE = "primary-paste-fixture";

// Hermetic xclip stub: any invocation prints the fixture. Prepending binDir to
// PATH keeps the scenario off the host's real X11 clipboard.
const binDir = join(root, "bin");
mkdirSync(binDir);
writeFileSync(join(binDir, "xclip"), `#!/bin/sh\nprintf '%s' "${FIXTURE}"\n`);
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

const meta = createView(root, { id: viewId, name: "mouse attach e2e", cwd: root });
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
	ok: false,
	sawContent: false,
	fullscreenHandled: false,
	fullscreenInput: null as string | null,
	offUndefined: false,
	offNoInput: false,
	legacyInput: null as string | null,
	error: null as string | null,
};

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
	}, 10_000);
	if (!ready) throw new Error("host never became ready");

	// Intercept component→runner messages to observe {type:"input"} pastes.
	const sent: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") sent.push(data);
		return origWrite.call(this, data, ...rest);
	};
	const pastedInputs = () =>
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
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const component = new PtyAttachComponent(
		tui as never,
		theme,
		{} as never,
		() => {},
		{
			socketPath: readHost(root, viewId).socketPath,
			screenLogPath: P.screenLogPath(root, viewId),
			title: "mouse attach e2e",
		} as never,
	);

	// Wait for session content so the paste lands on a settled attach.
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && !result.sawContent) {
		const lines = component.render(80) ?? [];
		if (lines.join("\n").includes("steady-")) result.sawContent = true;
		else await sleep(40);
	}
	if (!result.sawContent) throw new Error("session content never rendered");

	// 1. Fullscreen path: normalized middle press via handleMouse.
	const middlePress = {
		type: "press",
		button: "middle",
		x: 3,
		y: 3,
		screenX: 3,
		screenY: 3,
		width: 80,
		height: 22,
		shift: false,
	};
	const before = pastedInputs().length;
	const mouseResult = (component as any).handleMouse(middlePress);
	result.fullscreenHandled = !!mouseResult && mouseResult.handled === true && mouseResult.render === false;
	if (await waitFor(() => pastedInputs().length > before, 3000)) {
		result.fullscreenInput = pastedInputs().at(-1) ?? null;
	}

	// 2. Kill switch: handleMouse returns undefined and forwards nothing.
	process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE = "0";
	const offBefore = pastedInputs().length;
	const offResult = (component as any).handleMouse(middlePress);
	result.offUndefined = offResult === undefined;
	await sleep(600);
	result.offNoInput = pastedInputs().length === offBefore;
	delete process.env.AGENT_BOARD_ATTACH_NATIVE_PASTE;

	// 3. Legacy path (regular-mode regression): SGR middle press via handleInput.
	const legacyBefore = pastedInputs().length;
	component.handleInput("\x1b[<1;10;20M");
	if (await waitFor(() => pastedInputs().length > legacyBefore, 3000)) {
		result.legacyInput = pastedInputs().at(-1) ?? null;
	}

	result.ok =
		result.sawContent &&
		result.fullscreenHandled &&
		result.fullscreenInput === FIXTURE &&
		result.offUndefined &&
		result.offNoInput &&
		result.legacyInput === FIXTURE;

	try {
		component.dispose();
	} catch {}
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
}

try {
	const pid = readHost(root, viewId)?.childPid;
	if (pid) process.kill(pid, "SIGKILL");
} catch {}
try {
	runner.kill("SIGKILL");
} catch {}
await sleep(50);
try {
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
} catch {}

console.log(JSON.stringify(result));
