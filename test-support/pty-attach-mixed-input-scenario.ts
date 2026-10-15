// Component-level coverage (issue #189): one input read that mixes mouse reports with terminal
// reports must be dispatched per segment — the gesture is still processed (OSC 52 copy + selection
// kept), no raw mouse bytes reach the child, and a spontaneous report clears neither the selection
// nor the viewport. Modelled on test-support/pty-attach-mouse-scenario.ts (real runner socket, fake
// PTY from test-support/fake-pty-pi.mjs, fake TUI capturing terminal.write).
// Run via `node --experimental-transform-types`; prints one JSON line: { error, checks }.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const root = mkdtempSync(join(tmpdir(), "agentview-attach-mixed-"));
const viewId = "mixed-e2e";
const SELECTED_TEXT = "fake pi ready";
const OSC52_COPY = `\x1b]52;c;${Buffer.from(SELECTED_TEXT, "utf8").toString("base64")}\x07`;
const OSC11_REPLY = "\x1b]11;rgb:0d0d/0d0d/0d0d\x07";

// Hermetic xclip stub: the scenario must never touch the host clipboard.
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

const meta = createView(root, { id: viewId, name: "mixed attach e2e", cwd: root });
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

const checks: Record<string, boolean> = {};
const result = { error: null as string | null, checks };

try {
	const ready = await waitFor(() => {
		const host = readHost(root, viewId);
		return !!host && host.state === "alive" && !!host.socketPath && !!host.childPid && isAlive(host.runnerPid) && isAlive(host.childPid);
	}, 10_000);
	if (!ready) throw new Error("host never became ready");

	// Observe component→runner frames so forwarded input is visible.
	const sent: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") sent.push(data);
		return origWrite.call(this, data, ...rest);
	};
	const forwardedInput = (): string[] =>
		sent
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter((msg) => !!msg && msg.type === "input" && typeof msg.data === "string")
			.map((msg) => msg.data as string);

	// Exact-frame assertion (round-2 review): `.every()` over a possibly-empty slice passes vacuously,
	// so report forwarding must be pinned to exactly one frame with the expected payload.
	const forwardedExactly = (from: number, expected: string): boolean => {
		const frames = forwardedInput().slice(from);
		return frames.length === 1 && frames[0] === expected;
	};

	// Observe terminal writes so OSC 52 copies are visible.
	const writes: string[] = [];
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (data: string) => writes.push(data) },
		requestRender: () => {},
	};
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const component: any = new PtyAttachComponent(
		tui as never,
		theme,
		{} as never,
		() => {},
		{
			socketPath: readHost(root, viewId).socketPath,
			screenLogPath: P.screenLogPath(root, viewId),
			title: "mixed attach e2e",
		} as never,
	);

	const rendered = () => (component.render(80) ?? []).join("\n");
	const firstBurstLine = (): number | null => {
		const match = /burstline-(\d{4})/.exec(rendered());
		return match ? Number(match[1]) : null;
	};
	const copies = () => writes.filter((write) => write === OSC52_COPY).length;
	const selectionPresent = () => component.selection !== null;
	const drag = (fromCol: number, toCol: number) => {
		component.handleInput(`\x1b[<0;${fromCol};2M`);
		component.handleInput(`\x1b[<32;${toCol};2M`);
	};

	checks.sawContent = await waitFor(() => rendered().includes(SELECTED_TEXT), 8000);
	if (!checks.sawContent) throw new Error("session content never rendered");

	// A3 control: a canonical drag in separate reads still copies.
	const controlCopies = copies();
	drag(1, 16);
	component.handleInput("\x1b[<0;16;2m");
	await waitFor(() => copies() > controlCopies, 3000);
	checks.controlCopies = copies() === controlCopies + 1;

	// A3 case 1 (the issue's repro): release + focus report coalesced into ONE read.
	const mixedCopies = copies();
	const mixedFrames = forwardedInput().length;
	drag(1, 16);
	component.handleInput("\x1b[<0;16;2m\x1b[I");
	await waitFor(() => copies() > mixedCopies, 3000);
	checks.mixedCopies = copies() === mixedCopies + 1;
	checks.mixedForwardedOnlyReport = forwardedExactly(mixedFrames, "\x1b[I");
	// The pending-click window (DOUBLE_CLICK_MS = 260) is what used to wipe the selection: nothing to
	// await here, so this wait is the assertion's own window.
	await sleep(400);
	checks.selectionSurvivesMixed = selectionPresent();

	// A3 case 2: report FIRST, release after, still ONE read.
	const reportFirstCopies = copies();
	const reportFirstFrames = forwardedInput().length;
	drag(1, 16);
	component.handleInput("\x1b[I\x1b[<0;16;2m");
	await waitFor(() => copies() > reportFirstCopies, 3000);
	checks.reportFirstCopies = copies() === reportFirstCopies + 1;
	checks.reportFirstForwardedOnlyReport = forwardedExactly(reportFirstFrames, "\x1b[I");

	// A4: a report alone mid-drag keeps the selection and copies nothing.
	const reportOnlyCopies = copies();
	const reportOnlyFrames = forwardedInput().length;
	drag(1, 16);
	component.handleInput("\x1b[I");
	await sleep(150);
	checks.reportOnlyKeepsSelection = selectionPresent();
	checks.reportOnlyNoCopy = copies() === reportOnlyCopies;
	checks.reportOnlyForwarded = forwardedExactly(reportOnlyFrames, "\x1b[I");

	// A4 variant: an OSC 11 reply (an answer to a forwarded child query) behaves the same.
	const oscCopies = copies();
	const oscFrames = forwardedInput().length;
	drag(1, 16);
	component.handleInput(OSC11_REPLY);
	await sleep(150);
	checks.oscReplyKeepsSelection = selectionPresent();
	checks.oscReplyNoCopy = copies() === oscCopies;
	checks.oscReplyForwarded = forwardedExactly(oscFrames, OSC11_REPLY);

	// A5: viewport semantics on a scrollable buffer. "burst" makes the fixture emit 200 numbered lines.
	component.handleInput("burst");
	await waitFor(() => firstBurstLine() === 200, 10_000);
	const settle = async (): Promise<number | null> => {
		let last = firstBurstLine();
		// Bounded (round-2 review): a never-quiescing buffer must not hang the harness; the A5 checks
		// fail loudly on null/unchanged values, so returning the last observation is enough.
		for (let i = 0; i < 30; i++) {
			await sleep(60);
			const now = firstBurstLine();
			if (now === last) return now;
			last = now;
		}
		return last;
	};
	const atBottom = await settle();
	for (let i = 0; i < 3; i++) component.handleInput("\x1b[<64;10;3M");
	const scrolled = (await waitFor(() => firstBurstLine() !== null && firstBurstLine()! < (atBottom ?? 0), 3000)) ? firstBurstLine() : null;
	component.handleInput("\x1b[I");
	// Nothing to await: the assertion is that a spontaneous report moves nothing.
	await sleep(150);
	checks.viewportKeptOnReport = scrolled !== null && firstBurstLine() === scrolled;

	const wheelFrames = forwardedInput().length;
	const beforeWheel = firstBurstLine();
	component.handleInput("\x1b[<64;10;3M\x1b[I");
	checks.wheelScrolledInMixedRead = await waitFor(() => firstBurstLine() !== null && firstBurstLine()! < (beforeWheel ?? 0), 3000);
	checks.wheelMixedForwardedOnlyReport = forwardedExactly(wheelFrames, "\x1b[I");

	// A6: a real key still clears the selection (typing semantics unchanged) …
	const keyCopies = copies();
	drag(1, 16);
	component.handleInput("x");
	await sleep(80);
	checks.keyStillClears = !selectionPresent() && copies() === keyCopies;
	checks.keyForwarded = forwardedInput().at(-1) === "x";

	// … and ambiguous escape shapes stay keys (the classifier boundary).
	drag(1, 16);
	component.handleInput("\x1b[1;2R");
	await sleep(80);
	const clearedByShiftF3 = !selectionPresent();
	drag(1, 16);
	component.handleInput("\x1b[97;5u");
	await sleep(80);
	checks.ambiguousEscapesStayKeys = clearedByShiftF3 && !selectionPresent() && copies() === keyCopies;

	// A9 (last: it closes the component): a detach chord matched in a mixed read must stop the rest of
	// that read. The read is THREE segments — detach chord, focus report, trailing KEY — and the report
	// separator is required: adjacent key runs merge (spec A1), so a bare chord+key read would be one
	// key blob the chord never matches. The trailing segment is a KEY, not a report: once detach()
	// closes the socket a trailing report's send() is a silent no-op, so only a key can prove the loop
	// stopped (it would otherwise clearSelection() and wipe the highlight).
	drag(1, 16);
	component.handleInput("\x1b[1;5D" + "\x1b[I" + "x");
	await sleep(150);
	checks.detachStopsRead = component.closed === true;
	checks.detachTrailingSegmentStopped = selectionPresent();

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
process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0));
