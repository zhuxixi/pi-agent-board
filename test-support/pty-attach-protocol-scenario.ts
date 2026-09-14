// Component-level protocol-attach e2e (issue #91 phase 4, D2 UI switch).
// Constructs the REAL PtyAttachComponent against a REAL runner socket (fake
// pty child in steady-stream mode) with a fake TUI, and verifies:
//   1. the session content renders (snapshot hydrate + live output), and
//   2. the size-sync contract (CR R1 blocking): the protocol attach resizes
//      the child ONLY when snapshot_begin's geometry differs from the
//      attaching terminal's true size (cols, rows-2 chrome) — never a
//      jiggle shrink/restore pattern. The legacy shrink-and-hold attach
//      ALWAYS resizes at connect, so a resize-free same-size render still
//      pins protocol mode.
// SCENARIO_HOST_ROWS controls the host config's rows: default 22 MATCHES the
// component's computed size (tui 24 rows - 2 chrome); set 24 for the
// differing-size scenario. Run via `node --experimental-transform-types`.
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-attach-proto-"));
const viewId = "proto-e2e";
// Host geometry (CR R1 blocking size-sync coverage): 22 matches the
// component's computed rows (tui 24 - 2 chrome); 24 mismatches it.
const hostRows = Number(process.env.SCENARIO_HOST_ROWS ?? 22);

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

const meta = createView(root, { id: viewId, name: "protocol attach e2e", cwd: root });
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
	rows: hostRows,
});

const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], {
	stdio: ["ignore", "pipe", "pipe"],
});
runner.stderr.resume();

const result = {
	ok: false,
	sawContent: false,
	resizesBeforeContent: -1,
	resizesTotal: -1,
	resizeSizes: [] as Array<{ cols: number; rows: number }>,
	subscribeSent: false,
	hostRows,
	error: null as string | null,
};

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
	}, 10_000);
	if (!ready) throw new Error("host never became ready");

	// Intercept component→runner messages: the legacy shrink-and-hold attach
	// resizes at connect (jiggle sizes), the protocol attach resizes only on a
	// snapshot_begin geometry mismatch, to exactly the true terminal size.
	const sent: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") sent.push(data);
		return origWrite.call(this, data, ...rest);
	};

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
			title: "protocol attach e2e",
		} as never,
	);

	// Drive renders manually (the fake TUI's requestRender is a no-op): the
	// first pass renders the loading banner; the content pass proves the
	// snapshot hydrate + live output path.
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && !result.sawContent) {
		const lines = component.render(80) ?? [];
		if (lines.join("\n").includes("steady-")) {
			result.sawContent = true;
			result.resizesBeforeContent = sent.filter((l) => l.includes('"type":"resize"')).length;
			result.subscribeSent = sent.some((l) => l.includes("subscribe_terminal"));
			break;
		}
		await sleep(40);
	}
	// Observation window: catch any late jiggle pulses after content.
	for (let i = 0; i < 20 && result.sawContent; i++) {
		component.render(80);
		await sleep(50);
	}
	const resizeMsgs = sent
		.map((l) => {
			try { return JSON.parse(l); } catch { return null; }
		})
		.filter((m): m is { type: string; cols: number; rows: number } => !!m && m.type === "resize");
	result.resizeSizes = resizeMsgs.map((m) => ({ cols: m.cols, rows: m.rows }));
	result.resizesTotal = resizeMsgs.length;
	result.ok = result.sawContent && result.resizesBeforeContent === 0 && result.subscribeSent;

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
