// Component-level A6 restart e2e (issue #91 phase 4): the REAL PtyAttachComponent
// against a REAL runner — session establishes via snapshot protocol, the runner is
// SIGKILLed mid-stream, a fresh runner (new child) takes over the same view, and
// the component must converge to the NEW child's output through a fresh baseline
// hydrate — never the old screen, never screen.log, never a jiggle resize.
// Pins the F3 fix (stale-frame wipe on empty/resnapshot baseline) at the component
// level against a real runner, per the Task 3 review mandate.
// Run via `node --experimental-transform-types` (parameter properties).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-attach-restart-"));
const viewId = "restart-e2e";

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

const config = {
	root,
	viewId,
	sessionFile: "" as string,
	cwd: process.cwd(),
	initialPrompt: null,
	piCommand: process.execPath,
	piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
	model: null,
	tools: null,
	env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_STREAM_MODE: "steady" },
	cols: 80,
	// Matches the component's computed rows (tui 24 - 2 chrome): the size-sync
	// (CR R1 blocking) then sends nothing and the zero-resize jiggle assertion
	// below stays a pure protocol-mode discriminator.
	rows: 22,
};

const meta = createView(root, { id: viewId, name: "restart e2e", cwd: root });
config.sessionFile = meta.sessionFile;
const configPath = P.hostConfigPath(root, viewId);
atomicWriteJson(configPath, config);

function spawnRunner(envOverrides) {
	if (envOverrides) {
		config.env = { ...config.env };
		for (const [k, v] of Object.entries(envOverrides)) {
			if (v === null) delete config.env[k];
			else config.env[k] = v;
		}
		// The runner reads the config FILE at spawn — persist the override.
		atomicWriteJson(configPath, config);
	}
	const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	runner.stderr.resume();
	runner.stdout.resume();
	return runner;
}

function hostIsReady(): boolean {
	const host = readHost(root, viewId);
	return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
}

const result = {
	ok: false,
	sawContent: false,
	sawPreKillEcho: false,
	resizesBeforeContent: -1,
	resizesTotal: -1,
	subscribeCount: 0,
	convergedToNewChild: false,
	oldScreenVisibleAfterRestart: false,
	poisonVisible: false,
	error: null as string | null,
};

let runner: ReturnType<typeof spawn> | null = null;
const poison = "SCREENLOG-POISON-MARKER";
const scans: string[] = [];
let scansMark = 0; // scans before this index predate the restart baseline

try {
	runner = spawnRunner();
	if (!(await waitFor(hostIsReady, 10_000))) throw new Error("host never became ready");

	// Intercept component→runner messages: protocol attach never resizes at
	// connect (legacy shrink-and-hold always does) — across the WHOLE session,
	// including the post-restart reconnect.
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
			title: "restart e2e",
		} as never,
	);

	const renderScan = (): string => {
		const lines = component.render(80) ?? [];
		const text = lines.join("\n");
		scans.push(text);
		return text;
	};

	// Phase 1: protocol attach renders session content (snapshot hydrate).
	{
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline && !result.sawContent) {
			if (renderScan().includes("steady-")) result.sawContent = true;
			else await sleep(40);
		}
		if (!result.sawContent) throw new Error("session content never rendered (snapshot hydrate failed)");
		result.resizesBeforeContent = sent.filter((l) => l.includes('"type":"resize"')).length;
	}

	// Phase 2: put a discriminator line on the OLD child's screen.
	component.handleInput("before-restart\r");
	{
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !result.sawPreKillEcho) {
			if (renderScan().includes("echo:before-restart")) result.sawPreKillEcho = true;
			else await sleep(40);
		}
		if (!result.sawPreKillEcho) throw new Error("pre-kill echo never rendered");
	}

	// Phase 3: crash the runner (SIGKILL: no finalize, no socket cleanup), reap
	// the orphaned child, and POISON the screen.log — every recovery from here
	// on must come from the canonical snapshot, never from the log file.
	try { runner.kill("SIGKILL"); } catch {}
	await waitFor(() => !isAlive(runner!.pid!));
	try {
		const pid = readHost(root, viewId)?.childPid;
		if (pid) process.kill(pid, "SIGKILL");
	} catch {}
	try {
		writeFileSync(P.screenLogPath(root, viewId), `${poison}\n`);
	} catch {}

	// Phase 4: fresh runner + new child on the same view/config, but the new
	// child is HELD (silent): the restart baseline is deterministically the
	// empty host-starting answer, and once the UI resets on it, "steady-" must
	// DISAPPEAR from the viewport — a wipe signal that scroll-masking cannot
	// fake. The component's scheduleReconnect loop (150ms ticks, 15s budget)
	// lands on the new socket; protocol mode resumes via reconnect(lastSeq).
	// From here on, every rendered batch is post-restart evidence.
	runner = spawnRunner({ FAKE_PTY_STREAM_MODE: null, FAKE_PTY_HOLD: "1" });
	scansMark = scans.length;
	if (!(await waitFor(hostIsReady, 10_000))) throw new Error("replacement host never became ready");

	// Phase 5: converge to the NEW child. Wait for the reconnect to complete
	// (protocol mode, attached), then send the post-restart discriminator.
	const comp = component as any;
	let reconnected = false;
	let wiped = false;
	{
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && !(reconnected && wiped)) {
			const text = renderScan();
			if (comp.connected && comp.attachMode === "protocol") reconnected = true;
			// Hold-mode child is silent, so once the empty baseline hydrates (F3
			// reset), the pre-restart steady content must be gone from the viewport.
			if (reconnected && !text.includes("steady-")) wiped = true;
			await sleep(40);
		}
		if (!reconnected) throw new Error("component never reconnected in protocol mode");
		if (!wiped) throw new Error("old screen never wiped after the empty restart baseline (F3)");
	}
	component.handleInput("after-restart\r");
	{
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline && !result.convergedToNewChild) {
			const text = renderScan();
			if (text.includes("echo:after-restart")) result.convergedToNewChild = true;
			else await sleep(40);
		}
	}
	// Observation window for late jiggle pulses / late stale content.
	for (let i = 0; i < 20; i++) {
		renderScan();
		await sleep(50);
	}

	result.resizesTotal = sent.filter((l) => l.includes('"type":"resize"')).length;
	result.subscribeCount = sent.filter((l) => l.includes("subscribe_terminal")).length;
	const postRestartScans = scans.slice(scansMark);
	// The sharp F3 pin: at convergence the SAME viewport holds the new child's
	// echo while the old child's echo is long gone (hold child = static screen,
	// no scroll masking) — possible only if the baseline actually wiped it.
	const convergedBatch = postRestartScans.find((t) => t.includes("echo:after-restart"));
	result.oldScreenVisibleAfterRestart =
		(!!convergedBatch && convergedBatch.includes("echo:before-restart")) ||
		postRestartScans.slice(postRestartScans.indexOf(convergedBatch)).some((t) => t.includes("echo:before-restart"));
	result.poisonVisible = scans.some((t) => t.includes(poison));

	result.ok =
		result.convergedToNewChild &&
		!result.oldScreenVisibleAfterRestart &&
		!result.poisonVisible &&
		result.resizesBeforeContent === 0 &&
		result.resizesTotal === 0 &&
		result.subscribeCount >= 2;

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
	runner?.kill("SIGKILL");
} catch {}
await sleep(50);
try {
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
} catch {}

console.log(JSON.stringify(result));
