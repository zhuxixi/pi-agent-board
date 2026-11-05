// Issue #278 A5 driver: REAL managed Pi + real runner/PTY (node-pty) + real
// Nvim Ctrl+G external-editor round trip, driven through REAL PtyAttachComponent
// instances. No model request (--offline, no prompt is ever submitted), isolated
// AGENT_BOARD root, isolated PI_CODING_AGENT_DIR with `externalEditor` pinned to
// the discovered Nvim, isolated child cwd.
//
// Spawned by test/attach-external-editor.real.test.mjs with
// `node --experimental-transform-types`. Inputs arrive via env:
//   PI278_PI            realpath of the managed pi launcher (required)
//   PI278_NVIM          realpath of the nvim executable (required)
//   PI278_ARTIFACT_DIR  optional FRESH directory for retained evidence
// The final stdout line is the JSON result; exit code is nonzero on any failure.
// Failure still reaps the owned child/runner and retains the error.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { claimHost, createView, readHost } from "../src/core/store.mjs";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";
import { exitAfterStdout } from "./stdout-flush.mjs";

// Derived from this file's own location (test-support/), never from the main
// checkout path: the same driver runs in any worktree.
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PI_LAUNCHER = process.env.PI278_PI ?? "";
const NVIM = process.env.PI278_NVIM ?? "";
const ARTIFACT_DIR = process.env.PI278_ARTIFACT_DIR ? resolve(process.env.PI278_ARTIFACT_DIR) : null;

const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
const keybindings = {} as never;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(predicate: () => T | null | false | undefined, timeoutMs: number, label: string): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = predicate();
		if (value) return value;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
		await sleep(50);
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function screenLog(root: string, viewId: string): string {
	try {
		return readFileSync(P.screenLogPath(root, viewId), "utf8");
	} catch {
		return "";
	}
}

function componentBufferText(component: PtyAttachComponent): string {
	const buf = (component as unknown as { term: { buffer: { active: any } } }).term.buffer.active;
	const lines: string[] = [];
	for (let i = 0; i < buf.length; i += 1) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
	return lines.join("\n");
}

function attachComponent(socketPath: string, title: string, onDone: (result: unknown) => void): PtyAttachComponent {
	const tui = {
		// rows-2 is the component work area: 24 keeps the component at 80x22,
		// exactly the host/child geometry, so no resize intent is minted.
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
	};
	return new PtyAttachComponent(tui as never, theme, keybindings, onDone, { socketPath, title });
}

type RunnerProc = ReturnType<typeof spawn>;

/** Bounded fallback stop for the failure lane; every signal is recorded. */
async function fallbackStopRunner(runner: RunnerProc | null, signals: Array<Record<string, unknown>>): Promise<void> {
	if (!runner || runner.exitCode !== null || runner.signalCode !== null) return;
	const pid = runner.pid;
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		runner.kill("SIGTERM");
		signals.push({ target: "runner", pid, signal: "SIGTERM" });
	} catch {
		return;
	}
	await sleep(500);
	if (runner.exitCode !== null || runner.signalCode !== null) return;
	try {
		process.kill(pid, 0);
	} catch {
		return;
	}
	try {
		runner.kill("SIGKILL");
		signals.push({ target: "runner", pid, signal: "SIGKILL" });
	} catch {
		/* gone */
	}
	await sleep(300);
}

function fallbackReapChild(root: string, viewId: string, signals: Array<Record<string, unknown>>): void {
	const pid = readHost(root, viewId)?.childPid;
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid, 0);
	} catch {
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
		signals.push({ target: "child", pid, signal: "SIGKILL" });
	} catch {
		/* gone */
	}
}

async function observeRunnerExit(runner: RunnerProc, timeoutMs: number) {
	if (runner.exitCode !== null || runner.signalCode !== null) {
		return { exited: true, alreadyExited: true, code: runner.exitCode, signal: runner.signalCode, timedOut: false };
	}
	return await Promise.race([
		new Promise((resolve) => runner.once("exit", (code, signal) => resolve({ exited: true, alreadyExited: false, code, signal, timedOut: false }))),
		sleep(timeoutMs).then(() => ({ exited: runner.exitCode !== null || runner.signalCode !== null, code: runner.exitCode, signal: runner.signalCode, timedOut: true })),
	]);
}

async function main(): Promise<{ ok: boolean; evidence: Record<string, unknown> }> {
	if (PI_LAUNCHER === "" || !existsSync(PI_LAUNCHER)) throw new Error("PI278_PI must point at the discovered pi launcher");
	if (NVIM === "" || !existsSync(NVIM)) throw new Error("PI278_NVIM must point at the discovered nvim executable");
	if (ARTIFACT_DIR !== null) {
		if (existsSync(ARTIFACT_DIR)) throw new Error(`PI278_ARTIFACT_DIR must be fresh (overwrite refused): ${ARTIFACT_DIR}`);
		mkdirSync(ARTIFACT_DIR, { recursive: true });
	}
	const extensionEntry = resolve(REPO_ROOT, "index.ts");
	const root = mkdtempSync(join(tmpdir(), "pi278-root-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi278-agent-"));
	const childCwd = mkdtempSync(join(tmpdir(), "pi278-cwd-"));
	// Isolated agent config: Ctrl+G launches the discovered Nvim with no user
	// config and no swap/state file; NVIM_NOTTYFAST=1 keeps Nvim's redraw
	// pacing deterministic inside the PTY.
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ externalEditor: `${NVIM} -u NONE -i NONE` }, null, 2));
	const viewId = "real-278";
	const instanceId = "inst-real-278";
	const meta = createView(root, { id: viewId, name: "real-278", cwd: childCwd });
	const socketPath = P.hostEndpointPathFor(process.platform, root, viewId, instanceId);
	const configPath = P.hostConfigPathFor(root, viewId, instanceId);
	claimHost(root, { viewId, instanceId, configPath, socketPath, claimAt: Date.now(), claimPid: process.pid, claimIdentity: null, cols: 80, rows: 22 });
	atomicWriteJson(configPath, {
		root,
		viewId,
		instanceId,
		socketPath,
		sessionFile: meta.sessionFile,
		cwd: childCwd,
		initialPrompt: null,
		piCommand: PI_LAUNCHER,
		piArgsPrefix: ["--no-extensions", "--no-mcp", "--extension", extensionEntry, "--tui-mode", "fullscreen", "--verbose", "--offline", "-na"],
		model: null,
		tools: null,
		env: { PI_CODING_AGENT_DIR: agentDir, AGENT_BOARD_ALLOW_PIPE_FALLBACK: "0", NVIM_NOTTYFAST: "1" },
		cols: 80,
		rows: 22,
	});
	const runner = spawn(process.execPath, [resolve(REPO_ROOT, "runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
	let runnerStdout = "";
	let runnerStderr = "";
	runner.stdout.on("data", (chunk) => {
		runnerStdout = (runnerStdout + chunk.toString()).slice(-8000);
	});
	runner.stderr.on("data", (chunk) => {
		runnerStderr = (runnerStderr + chunk.toString()).slice(-8000);
	});

	const evidence: Record<string, unknown> = {
		startedAt: new Date().toISOString(),
		repoRoot: REPO_ROOT,
		executables: {
			pi: PI_LAUNCHER,
			piSha256: sha256(readFileSync(PI_LAUNCHER)),
			nvim: NVIM,
			nvimSha256: sha256(readFileSync(NVIM)),
			extensionRealpath: extensionEntry,
			extensionSha256: sha256(readFileSync(extensionEntry)),
		},
		phases: [] as Array<Record<string, unknown>>,
		nvim: null,
		reattach: null,
		restore: null,
		laterProof: null,
		exit: null,
		cleanup: null,
		failure: null,
	};
	let componentA: PtyAttachComponent | null = null;
	let componentB: PtyAttachComponent | null = null;
	let doneResult: Record<string, unknown> | null = null;
	let naturalExit = false;
	const forcedKills: Array<Record<string, unknown>> = [];
	const flush = () => {
		if (ARTIFACT_DIR === null) return;
		// The final flush runs AFTER the owned root is removed; never overwrite a
		// previously captured tail with the empty read of the deleted log.
		const log = screenLog(root, viewId);
		if (log !== "") evidence.screenLogTail = log.slice(-8000);
		evidence.runnerStdoutTail = runnerStdout;
		evidence.runnerStderrTail = runnerStderr;
		writeFileSync(join(ARTIFACT_DIR, "result.json"), JSON.stringify(evidence, null, 2));
	};
	const phase = (name: string, facts: Record<string, unknown>) => {
		(evidence.phases as Array<Record<string, unknown>>).push({ name, at: new Date().toISOString(), ...facts });
		flush();
	};

	/** Graceful teardown that works on both the success and failure lanes:
	 * leave any Nvim/insert state, clear the Pi editor, one real Ctrl+D.
	 * If Nvim was never opened the `:q!` bytes land in the Pi editor and the
	 * following Ctrl+U clears them, so the sequence is safe on every lane. */
	const attemptGracefulExit = async (component: PtyAttachComponent | null): Promise<boolean> => {
		if (component === null || doneResult !== null) return doneResult !== null;
		try { component.handleInput("\x1b"); } catch { /* best effort */ }
		await sleep(400);
		try { component.handleInput(":q!\r"); } catch { /* best effort */ }
		await sleep(2000); // Nvim quits and Pi's ui.start() redraws before more input.
		try { component.handleInput("\x15"); } catch { /* best effort */ }
		await sleep(400);
		try { component.handleInput("\x04"); } catch { /* best effort */ }
		await waitFor(() => doneResult !== null, 15000, "exit message").catch(() => false);
		return doneResult !== null;
	};

	try {
		await waitFor(() => {
			const host = readHost(root, viewId);
			return host && host.state === "alive" && host.childPid ? true : null;
		}, 30000, "runner host alive");
		await waitFor(() => (readHost(root, viewId)?.frameWitness?.enabled === true ? true : null), 60000, "frame witness enabled by the production extension");
		phase("host-ready", { host: readHost(root, viewId) });

		// ---- attach and settle ----
		componentA = attachComponent(socketPath, "real-278-a", (result) => {
			doneResult = result as Record<string, unknown>;
		});
		const internalsA = componentA as unknown as Record<string, any>;
		await waitFor(() => internalsA.attaching === false, 60000, "component A attach settle");
		phase("attach-settled", { mode: internalsA.attachMode, frameWitnessAvailable: internalsA.frameWitnessAvailable });

		// ---- type PI_RESTORE_PROBE, then Ctrl+G ----
		componentA.handleInput("PI_RESTORE_PROBE");
		await waitFor(() => componentA!.render(80).join("\n").includes("PI_RESTORE_PROBE"), 30000, "Pi editor prefill renders");
		const preCtrlGFrameId = readHost(root, viewId)?.frameWitness?.lastProof?.frameId ?? 0;
		phase("pi-prefill-rendered", { preCtrlGFrameId });
		componentA.handleInput("\x07");
		await waitFor(() => screenLog(root, viewId).includes("\x1b[?2026$p"), 30000, "Nvim synchronized-output query observed in the child output");
		await waitFor(() => componentBufferText(componentA!).includes("PI_RESTORE_PROBE"), 30000, "Nvim drew the prompt file");
		phase("nvim-started", { bufferTail: componentBufferText(componentA).slice(-400) });

		// ---- type into Nvim; the actual attach render must project it live ----
		componentA.handleInput("ggiNVIM_VISIBLE_PROBE_1");
		await waitFor(() => componentBufferText(componentA!).includes("NVIM_VISIBLE_PROBE_1"), 30000, "live Nvim probe in the underlying buffer");
		const nvimRender = componentA.render(80).join("\n");
		evidence.nvim = {
			liveBufferContainsProbe: true,
			renderContainsProbe: nvimRender.includes("NVIM_VISIBLE_PROBE_1"),
			actualRender: nvimRender,
			hostFrameWitness: readHost(root, viewId)?.frameWitness ?? null,
		};
		phase("nvim-typed", { renderContainsProbe: nvimRender.includes("NVIM_VISIBLE_PROBE_1") });
		// RED oracle (A3/A5): the buffer holds the probe, the render must too.
		if (!nvimRender.includes("NVIM_VISIBLE_PROBE_1")) {
			throw new Error("actual render does not project the live Nvim probe (buffer=true, render=false)");
		}

		// ---- dispose, reattach fresh, keep typing through the new component ----
		componentA.dispose();
		componentA = null;
		componentB = attachComponent(socketPath, "real-278-b", (result) => {
			doneResult = result as Record<string, unknown>;
		});
		const internalsB = componentB as unknown as Record<string, any>;
		await waitFor(() => internalsB.attaching === false, 60000, "component B attach settle during external editor");
		componentB.handleInput("NVIM_REATTACH_PROBE_2");
		await waitFor(() => componentBufferText(componentB!).includes("NVIM_REATTACH_PROBE_2"), 30000, "reattach probe in the underlying buffer");
		const reattachRender = componentB.render(80).join("\n");
		evidence.reattach = {
			settled: internalsB.attaching === false,
			snapshotOwnershipAdopted: internalsB.externalOutputActive === true,
			renderContainsProbe1: reattachRender.includes("NVIM_VISIBLE_PROBE_1"),
			renderContainsProbe2: reattachRender.includes("NVIM_REATTACH_PROBE_2"),
			actualRender: reattachRender,
		};
		phase("reattach-typed", { probe1: reattachRender.includes("NVIM_VISIBLE_PROBE_1"), probe2: reattachRender.includes("NVIM_REATTACH_PROBE_2") });
		if (!reattachRender.includes("NVIM_VISIBLE_PROBE_1") || !reattachRender.includes("NVIM_REATTACH_PROBE_2")) {
			throw new Error("the reattached component does not project both live Nvim probes");
		}

		// ---- Escape, :q! — Pi takes the screen back ----
		const logBeforeQuit = screenLog(root, viewId).length;
		componentB.handleInput("\x1b");
		await sleep(400);
		componentB.handleInput(":q!\r");
		const restored = await waitFor(() => {
			const text = componentB!.render(80).join("\n");
			return text.includes("PI_RESTORE_PROBE") && !text.includes("NVIM_VISIBLE_PROBE_1") && !text.includes("NVIM_REATTACH_PROBE_2") ? text : null;
		}, 60000, "Pi restore render without Nvim residue");
		const restoreLog = screenLog(root, viewId).slice(logBeforeQuit);
		const committedB = internalsB.committedView;
		evidence.restore = {
			renderContainsPiProbe: true,
			omitsNvimProbes: true,
			bodyLines: componentB.render(80).length - 2,
			committedIdentity: committedB
				? { targetCols: committedB.identity.targetCols, targetRows: committedB.identity.targetRows, rows: committedB.rows.length }
				: null,
			restoreKittyApcObserved: restoreLog.includes("\x1b_Ga=d"),
			restoreKittyApcCount: restoreLog.split("\x1b_Ga=d").length - 1,
			actualRender: restored,
			hostFrameWitness: readHost(root, viewId)?.frameWitness ?? null,
		};
		phase("pi-restored", { kittyApc: evidence.restore });
		if (!committedB || committedB.identity.targetCols !== 80 || committedB.identity.targetRows !== 22 || committedB.rows.length !== 22) {
			throw new Error(`restore lost the 80x22 committed identity: ${JSON.stringify(evidence.restore)}`);
		}

		// ---- a later ordinary input produces a later F proof ----
		const preXFrameId = readHost(root, viewId)?.frameWitness?.lastProof?.frameId ?? preCtrlGFrameId;
		componentB.handleInput("x");
		const laterProof = await waitFor(() => {
			const fw = readHost(root, viewId)?.frameWitness;
			if (!fw?.lastProof || fw.lastProof.marker !== "F") return null;
			return fw.lastProof.frameId > preXFrameId ? fw.lastProof : null;
		}, 60000, "later F proof after ordinary input");
		evidence.laterProof = { preXFrameId, proof: laterProof };
		phase("later-proof", { frameId: laterProof.frameId });

		// ---- natural exit: Ctrl+U, Ctrl+D; no forced kill allowed ----
		componentB.handleInput("\x15");
		await sleep(400);
		componentB.handleInput("\x04");
		await waitFor(() => doneResult !== null, 30000, "component exit message");
		const hostEnded = await waitFor(() => {
			const host = readHost(root, viewId);
			return host && host.state !== "alive" ? { state: host.state, endedAt: host.endedAt ?? null, exitCode: host.exitCode ?? null } : null;
		}, 30000, "host finalized");
		const runnerExit = await observeRunnerExit(runner, 20000);
		naturalExit = doneResult !== null && runnerExit.exited === true && runnerExit.timedOut !== true;
		evidence.exit = { doneResult, hostEnded, runnerExit, natural: naturalExit, forcedKills: [] };
		phase("natural-exit", { natural: naturalExit });
		if (!naturalExit) throw new Error(`natural child/runner exit not verified: ${JSON.stringify(evidence.exit)}`);
	} catch (error) {
		evidence.failure = error instanceof Error ? error.message : String(error);
		flush();
		// Failure lane: the input path is intact, so attempt the same graceful
		// exit first; only a bounded recorded fallback remains after that.
		const graceful = await attemptGracefulExit(componentB ?? componentA);
		if (graceful) {
			const runnerExit = await observeRunnerExit(runner, 20000);
			naturalExit = runnerExit.exited === true && runnerExit.timedOut !== true;
			evidence.exit = { doneResult, gracefulAfterFailure: true, runnerExit, natural: naturalExit };
		}
	}

	// ---- bounded cleanup on both lanes; every forced signal is recorded ----
	if (!naturalExit) {
		await fallbackStopRunner(runner, forcedKills);
		fallbackReapChild(root, viewId, forcedKills);
		await sleep(100);
	}
	for (const component of [componentA, componentB]) {
		try { component?.dispose(); } catch { /* best effort */ }
	}
	rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	rmSync(childCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	evidence.cleanup = {
		naturalExit,
		forcedKills,
		runnerExited: runner.exitCode !== null || runner.signalCode !== null,
		runnerCode: runner.exitCode,
		runnerSignal: runner.signalCode,
		rootRemoved: !existsSync(root),
		agentDirRemoved: !existsSync(agentDir),
		childCwdRemoved: !existsSync(childCwd),
	};
	flush();
	const ok = evidence.failure === null && naturalExit === true && forcedKills.length === 0;
	return { ok, evidence };
}

main()
	.then(({ ok, evidence }) => {
		exitAfterStdout(`${JSON.stringify({ ok, ...evidence })}\n`, ok ? 0 : 1);
	})
	.catch((err) => {
		process.stderr.write(`attach-external-editor-real: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		exitAfterStdout(`${JSON.stringify({ ok: false, failure: err instanceof Error ? err.message : String(err) })}\n`, 1);
	});
