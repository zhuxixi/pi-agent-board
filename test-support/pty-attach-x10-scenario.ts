// Component-level X10 mouse-report coverage (issue #188): the REAL
// PtyAttachComponent against a REAL runner socket (runner/pty-runner.mjs) with a
// fake PTY (test-support/fake-pty-pi.mjs, default mode -> one "fake pi ready"
// line) and a fake TUI capturing terminal.write, driven by X10-encoded reports
// through the public handleInput seam. Verifies:
//   1. an X10 drag (press -> motion -> release) copies the selection: exactly one
//      OSC 52 write whose payload is the selected text. This is the issue #188
//      regression — before the fix the release was decoded as a non-primary
//      press, so the selection was cleared and nothing was copied;
//   2. a same-point X10 click copies nothing, keeps its 1-cell highlight right
//      after the release and loses it once the pending-click window elapsed;
//   3. an X10 right press + release copies nothing (the release finds no live
//      selection);
//   4. an X10 wheel report the local viewport cannot scroll is forwarded to the
//      child raw instead of being consumed.
// Hermetic: a PATH-stubbed xclip so writePrimarySelection() never touches the
// host X11 clipboard. Run via `node --experimental-transform-types`.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-attach-x10-"));
const viewId = "x10-e2e";

const binDir = join(root, "bin");
mkdirSync(binDir);
writeFileSync(join(binDir, "xclip"), "#!/bin/sh\nexit 0\n");
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

const meta = createView(root, { id: viewId, name: "x10 attach e2e", cwd: root });
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

// X10 reports used below (ESC [ M Cb Cx Cy, each byte = value + 32; body row 0
// is terminal row 2): press/motion/release of a full-line drag, a same-point
// click release, a right-button press, and a wheel notch.
const PRESS = "\x1b[M !\"";
const MOTION = "\x1b[M@(\"";
const RELEASE = "\x1b[M#4\"";
const CLICK_RELEASE = "\x1b[M#!\"";
const RIGHT_PRESS = "\x1b[M\"!\"";
const WHEEL_UP = "\x1b[M`!\"";

const result = {
	ok: false,
	sawContent: false,
	cases: {} as Record<string, Record<string, unknown>>,
	error: null as string | null,
};

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return (
			!!host &&
			host.state === "alive" &&
			!!host.socketPath &&
			!!host.childPid &&
			isAlive(host.runnerPid) &&
			isAlive(host.childPid)
		);
	}, 10_000);
	if (!ready) throw new Error("host never became ready");

	// Intercept component -> runner frames so a forwarded wheel report is observable.
	const frames: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") frames.push(data);
		return origWrite.call(this, data, ...rest);
	};
	const forwardedInputs = () =>
		frames
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter((msg) => !!msg && msg.type === "input" && typeof msg.data === "string")
			.map((msg) => msg.data as string);

	const writes: string[] = [];
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (d: string) => writes.push(String(d)) },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const component = new PtyAttachComponent(
		tui as never,
		theme,
		{} as never,
		() => {},
		{
			socketPath: readHost(root, viewId)!.socketPath,
			screenLogPath: P.screenLogPath(root, viewId),
			title: "x10 attach e2e",
		} as never,
	);

	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && !result.sawContent) {
		const lines = component.render(80) ?? [];
		if (lines.join("\n").includes("fake pi ready")) result.sawContent = true;
		else await sleep(40);
	}
	if (!result.sawContent) throw new Error("session content never rendered");

	const osc52Payloads = () =>
		writes
			.filter((w) => w.includes("\x1b]52;c;"))
			.map((w) => Buffer.from(w.replace(/.*\x1b]52;c;/, "").replace("\x07", ""), "base64").toString("utf8"));

	// Selection paint on the fixture line: selected cells are rendered with inverse
	// video (\x1b[0;7;…), while the bare cursor block on an empty row is a
	// different sequence (\x1b[7m), so this probe only sees a live selection.
	// The fixture text is matched on an SGR-stripped copy: a selection starting at
	// column 0 renders an attribute reset between "f" and "ake pi ready", so a
	// contiguous includes() on the raw line cannot find it. The \x1b[0;7; probe
	// itself still runs on the unstripped line.
	const selectionPainted = () => {
		const line =
			(component.render(80) ?? []).find((l) => l.replace(/\x1b\[[0-9;]*m/g, "").includes("fake pi ready")) ?? "";
		return line.includes("\x1b[0;7;");
	};

	const runCase = async (name: string, sequences: string[], settleMs = 400) => {
		writes.length = 0;
		frames.length = 0;
		for (const seq of sequences.slice(0, -1)) {
			component.handleInput(seq);
			await sleep(15);
		}
		component.handleInput(sequences[sequences.length - 1]);
		// Read the immediate state in the same tick as the release: the pending-click
		// window (DOUBLE_CLICK_MS = 260) must not be able to race this probe.
		const paintedRightAfterRelease = selectionPainted();
		await sleep(settleMs);
		result.cases[name] = {
			osc52: osc52Payloads(),
			forwarded: forwardedInputs(),
			paintedRightAfterRelease,
			paintedAfterWindow: selectionPainted(),
		};
	};

	await runCase("drag", [PRESS, MOTION, RELEASE]);
	await runCase("click", [PRESS, CLICK_RELEASE]);
	await runCase("rightButton", [RIGHT_PRESS, CLICK_RELEASE]);
	await runCase("wheel", [WHEEL_UP]);

	result.ok =
		(result.cases.drag.osc52 as string[]).length === 1 &&
		(result.cases.click.osc52 as string[]).length === 0 &&
		(result.cases.rightButton.osc52 as string[]).length === 0 &&
		(result.cases.wheel.osc52 as string[]).length === 0 &&
		(result.cases.wheel.forwarded as string[]).includes(WHEEL_UP);

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
