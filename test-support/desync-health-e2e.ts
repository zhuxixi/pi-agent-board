// Healthy-session E2E (issue #11, spec A4): real runner + fake idle TUI child +
// REAL PtyAttachComponent. The attach runs its full lifecycle (shrink-and-hold
// protocol, settle, probe). With a healthy child (cursor parked on the inverse
// fake cursor, then silent) the desync probe must never heal across ≥3 probe
// ticks. Run via `node --experimental-transform-types`.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const tui = {
	terminal: { rows: 36, cols: 120, columns: 120, write: () => {} },
	requestRender: () => {},
};
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const keybindings = {} as never;

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for runner readiness");
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function stopRunner(runner: ReturnType<typeof spawn>): Promise<void> {
	if (runner.exitCode !== null || runner.signalCode !== null) return;
	runner.kill("SIGTERM");
	for (let i = 0; i < 6 && runner.exitCode === null && runner.signalCode === null; i++) {
		await new Promise((r) => setTimeout(r, 100));
	}
	if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "desync-health-"));
	const viewId = "e2ehealth";
	let runner: ReturnType<typeof spawn> | null = null;
	let attach: PtyAttachComponent | null = null;
	try {
		const meta = createView(root, { id: viewId, name: "health", cwd: process.cwd() });
		atomicWriteJson(P.hostConfigPath(root, viewId), {
			root,
			viewId,
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-idle-tui-pi.mjs")],
			model: null,
			tools: null,
			env: {},
			cols: 120,
			rows: 36,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), P.hostConfigPath(root, viewId)], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		// Drain runner diagnostics so pipe backpressure can never stall it; the
		// captured bytes are intentionally unused (our stdout must stay JSON-only).
		runner.stdout?.on("data", () => {});
		runner.stderr?.on("data", () => {});

		// Same readiness wait as the cold-start E2E: control socket exists AND
		// the host is alive (spawning the child takes a beat past socket creation).
		await waitFor(() => existsSync(P.controlSocketPath(root, viewId)) && readHost(root, viewId)?.state === "alive", 10_000);

		attach = new PtyAttachComponent(
			tui as never,
			theme as never,
			keybindings,
			() => {},
			{ socketPath: P.controlSocketPath(root, viewId), title: "health" },
		);
		void attach.render(120); // drive one render so resizeIfNeeded syncs the local xterm

		// Settle (ATTACH_SETTLE_MS=250 after output stops) + hold across ≥3 probe
		// ticks (2s period) + quiet window (1.5s) with the child idle.
		await new Promise((r) => setTimeout(r, 9_000));

		const state = (attach as unknown as {
			jiggleRetry: { getState: () => { healCount: number; held: boolean; stopped: boolean } };
		}).jiggleRetry.getState();
		// Raw controller state: healedNever/chainDone assert the derived flags,
		// held carries the raw held bit (must be false once the chain is done).
		const result = { healedNever: state.healCount === 0, chainDone: state.stopped === true, held: state.held };
		console.log(JSON.stringify(result));
		if (!Object.values(result).every((v, i) => (i === 2 ? v === false : v === true))) process.exitCode = 1;
	} finally {
		try { attach?.close(); } catch {}
		if (runner) await stopRunner(runner);
		rmSync(root, { recursive: true, force: true });
	}
}

void main();
