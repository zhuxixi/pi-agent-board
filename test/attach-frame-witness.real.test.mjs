// Issue #222 step 23b1 F1 (final evidence round): REAL provider topology with retained artifacts.
//
// Real host + real managed Pi child running the DEFAULT repository extension (`index.ts`) on an
// isolated PI_CODING_AGENT_DIR. The extension itself performs the production hello/enable; a real
// client drives an enveloped differing resize and a same-size resize, and the test requires:
// applied ack -> exactly one intent (monotonic revision) -> a LATER complete target-geometry F,
// a same-size command with its OWN ack and no new intent/revision, a real documented
// `/settings` mode switch producing a LATER regular proof (adapter re-arm), and no marker bytes in
// the broadcast or the screen log.
//
// Raw evidence is written BEFORE the owned roots are removed when PI23B1_ARTIFACT_DIR is set.
// Opt-in: PI23B1_REAL_PI=1 node --test test/attach-frame-witness.real.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { claimHost, createView, readHost } from "../src/core/store.mjs";

const enabled = process.env.PI23B1_REAL_PI === "1";
const realTest = enabled ? test : test.skip;
const reason = "set PI23B1_REAL_PI=1 to run the real Pi provider topology";
const ARTIFACT_DIR = process.env.PI23B1_ARTIFACT_DIR ? resolve(process.env.PI23B1_ARTIFACT_DIR) : null;
const MAX_MARKER_SCAN_BYTES = 256 * 1024;

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function waitFor(predicate, timeoutMs = 30000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out waiting");
}

function send(socket, msg) {
	socket.write(`${JSON.stringify(msg)}\n`);
}

function listen(socket) {
	let buffer = "";
	const messages = [];
	socket.on("data", (chunk) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
	});
	return messages;
}

/**
 * Observe the runner process exit: if it already exited, return the existing code/signal
 * immediately; otherwise await the exit event with a bounded timeout. An unobserved exit is
 * reported as `timedOut`, never conflated with an already-exited process.
 */
async function observeRunnerExit(runner, timeoutMs) {
	if (runner.exitCode !== null || runner.signalCode !== null) {
		return { exited: true, alreadyExited: true, code: runner.exitCode, signal: runner.signalCode, timedOut: false };
	}
	return await Promise.race([
		new Promise((resolve) => runner.once("exit", (code, signal) => resolve({ exited: true, alreadyExited: false, code, signal, timedOut: false }))),
		new Promise((resolve) => setTimeout(() => resolve({ exited: runner.exitCode !== null || runner.signalCode !== null, code: runner.exitCode, signal: runner.signalCode, timedOut: true }), timeoutMs)),
	]);
}

/**
 * Fallback cleanup for FAILED attempts only. Every signal actually sent is recorded, SIGKILL is
 * only sent after a SIGTERM and a recheck, and a missing/unknown/reused PID is never signalled as
 * if it were known dead.
 */
async function fallbackStopRunner(runner, signals) {
	if (!runner || runner.exitCode !== null || runner.signalCode !== null) return;
	const pid = runner.pid;
	if (!Number.isInteger(pid) || pid <= 0) return; // unknown PID: never signal
	try {
		runner.kill("SIGTERM");
		signals.push({ target: "runner", pid, signal: "SIGTERM" });
	} catch {
		return;
	}
	await new Promise((r) => setTimeout(r, 500));
	// Recheck: the process may have exited naturally after SIGTERM.
	if (runner.exitCode !== null || runner.signalCode !== null) return;
	try {
		process.kill(pid, 0); // still alive?
	} catch {
		return;
	}
	try {
		runner.kill("SIGKILL");
		signals.push({ target: "runner", pid, signal: "SIGKILL" });
	} catch {
		/* gone */
	}
	await new Promise((r) => setTimeout(r, 300));
}

/** Child fallback: same rules; a missing PID from the host row is unknown, never "dead". */
function fallbackReapChild(root, viewId, signals) {
	const pid = readHost(root, viewId)?.childPid;
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid, 0);
	} catch {
		return; // already gone
	}
	try {
		process.kill(pid, "SIGKILL");
		signals.push({ target: "child", pid, signal: "SIGKILL" });
	} catch {
		/* gone */
	}
}

function reapChild(root, viewId) {
	try {
		const pid = readHost(root, viewId)?.childPid;
		if (pid) process.kill(pid, "SIGKILL");
	} catch {
		/* gone */
	}
}

realTest(`23b1 F1 real Pi provider topology [${reason}]`, async (t) => {
	assert.ok(!ARTIFACT_DIR || !existsSync(ARTIFACT_DIR), "PI23B1_ARTIFACT_DIR must be fresh (overwrite refused)");
	if (ARTIFACT_DIR) mkdirSync(ARTIFACT_DIR, { recursive: true });
	const launcher = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).stdout.trim();
	assert.ok(launcher !== "", "the real managed pi launcher is available");
	const launcherRealpath = realpathSync(launcher);
	const launcherVersion = spawnSync(launcherRealpath, ["--version"], { encoding: "utf8" });
	const extensionEntry = resolve("index.ts");
	const launcherFacts = {
		launcher,
		launcherRealpath,
		launcherSha256: sha256(readFileSync(launcherRealpath)),
		versionStdout: launcherVersion.stdout?.trim() ?? null,
		versionExit: launcherVersion.status,
		extensionRealpath: realpathSync(extensionEntry),
		extensionSha256: sha256(readFileSync(extensionEntry)),
	};
	const root = mkdtempSync(join(tmpdir(), "agentview-real-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi23b1-agent-"));
	const viewId = "real-f1";
	const instanceId = "inst-real-f1";
	const meta = createView(root, { id: viewId, name: "real", cwd: process.cwd() });
	const socketPath = P.hostEndpointPathFor(process.platform, root, viewId, instanceId);
	const configPath = P.hostConfigPathFor(root, viewId, instanceId);
	claimHost(root, { viewId, instanceId, configPath, socketPath, claimAt: Date.now(), claimPid: process.pid, claimIdentity: null, cols: 80, rows: 24 });
	atomicWriteJson(configPath, {
		root,
		viewId,
		instanceId,
		socketPath,
		sessionFile: meta.sessionFile,
		cwd: process.cwd(),
		initialPrompt: null,
		piCommand: launcherRealpath,
		piArgsPrefix: ["--no-extensions", "--no-mcp", "--extension", extensionEntry, "--tui-mode", "fullscreen", "--verbose", "--offline", "-na"],
		model: null,
		tools: null,
		env: { PI_CODING_AGENT_DIR: agentDir, AGENT_BOARD_ALLOW_PIPE_FALLBACK: "0" },
		cols: 80,
		rows: 24,
	});
	const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
	runner.stdout.resume();
	runner.stderr.resume();
	const evidence = {
		startedAt: new Date().toISOString(),
		launcher: launcherFacts,
		initialResize: null,
		sameSize: null,
		modeTransition: null,
		snapshots: [],
		clientMessages: [],
		subscriber: { chunks: 0, bytes: 0, sha256: null, markerScan: null, tail: "" },
		proofs: [],
		cleanup: null,
		orderedExit: null,
		failure: null,
	};
	let naturalExitObserved = false;
	const fallbackSignals = [];
	let subscriberText = "";
	const snapshot = (label) => {
		const host = readHost(root, viewId);
		evidence.snapshots.push({ label, at: new Date().toISOString(), host: host ?? null });
		return host;
	};
	const flush = () => {
		if (ARTIFACT_DIR === null) return;
		evidence.subscriber.bytes = Buffer.byteLength(subscriberText, "utf8");
		evidence.subscriber.sha256 = sha256(subscriberText);
		// FULL-stream scan (not tail-only): marker bytes must never reach the broadcast.
		evidence.subscriber.markerScan = subscriberText.includes("agent-board-frame") ? "found" : "absent";
		evidence.subscriber.tail = subscriberText.slice(-2000);
		writeFileSync(join(ARTIFACT_DIR, "result.json"), JSON.stringify(evidence, null, 2));
	};
	t.after(async () => {
		flush();
		if (!naturalExitObserved) {
			// FAILED attempt only: bounded fallback with every signal recorded.
			await fallbackStopRunner(runner, fallbackSignals);
			fallbackReapChild(root, viewId, fallbackSignals);
			await new Promise((r) => setTimeout(r, 100));
			evidence.cleanup = {
				naturalExit: false,
				runnerExited: runner.exitCode !== null || runner.signalCode !== null,
				runnerCode: runner.exitCode,
				runnerSignal: runner.signalCode,
				forcedKills: fallbackSignals.slice(),
				rootRemoved: false,
				agentDirRemoved: false,
			};
		} else {
			// Natural exit already observed and recorded: no stop/reap, no signals.
			evidence.cleanup = {
				...(evidence.cleanup ?? {}),
				naturalExit: true,
				forcedKills: [],
				rootRemoved: false,
				agentDirRemoved: false,
			};
		}
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		evidence.cleanup.rootRemoved = !existsSync(root);
		evidence.cleanup.agentDirRemoved = !existsSync(agentDir);
		flush();
	});
	try {
		await waitFor(() => {
			const host = readHost(root, viewId);
			return host && host.state === "alive" && host.childPid;
		});
		const enabledRow = await waitFor(() => (readHost(root, viewId)?.frameWitness?.enabled === true ? readHost(root, viewId).frameWitness : null), 60000);
		assert.equal(typeof enabledRow.instanceId, "string", "the extension completed the production enable");
		snapshot("initial");

		const subscriber = createConnection(socketPath);
		await once(subscriber, "connect");
		const subscriberMessages = listen(subscriber);
		subscriber.on("data", (chunk) => {
			subscriberText += chunk.toString();
			evidence.subscriber.chunks += 1;
		});
		send(subscriber, { type: "subscribe_terminal" });
		const client = createConnection(socketPath);
		await once(client, "connect");
		const clientMessages = listen(client);
		// Continuous exit observation from the interaction phase: the exact triggering input is
		// retained even if the child exits before the scripted exit step.
		const actions = [];
		const observation = { exitMessage: null, hostEnded: null, triggerAction: null };
		let inputIndex = 0;
		const sendInput = (data, label) => {
			inputIndex += 1;
			actions.push({ index: inputIndex, sort: "input", data, label, at: Date.now() });
			send(client, { type: "input", data });
		};
		client.on("data", (chunk) => {
			if (observation.exitMessage !== null) return;
			for (const line of chunk.toString().split("\n")) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.type === "exit") {
						observation.exitMessage = msg;
						observation.triggerAction = actions.filter((entry) => entry.sort === "input").at(-1)?.index ?? null;
						break;
					}
				} catch {
					/* ignore partial lines */
				}
			}
		});
		const hostWatcher = setInterval(() => {
			if (observation.hostEnded !== null) return;
			const host = readHost(root, viewId);
			if (host && host.state !== "alive" && host.endedAt) {
				observation.hostEnded = { state: host.state, endedAt: host.endedAt, exitCode: host.exitCode ?? null };
			}
		}, 40);
		hostWatcher.unref?.();
		send(client, { type: "hello", clientId: "ui-client" });
		await waitFor(() => clientMessages.some((msg) => msg.type === "hello"));

		// ---- differing resize: applied ack -> exactly one intent -> LATER target proof ----
		// Capture the host row SYNCHRONOUSLY when the applied ack is parsed: this is the
		// closest observable instant to "applied", and proves applied is not completion.
		let appliedAtAck = null;
		client.on("data", (chunk) => {
			if (appliedAtAck !== null) return;
			for (const line of chunk.toString().split("\n")) {
				if (!line.trim()) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.type === "cmd_ack" && msg.commandId === "f1-resize-diff" && msg.stage === "applied") {
					appliedAtAck = readHost(root, viewId)?.frameWitness ?? null;
					break;
				}
			}
		});
		send(client, { type: "resize", commandId: "f1-resize-diff", clientId: "ui-client", seq: 1, viewId, instanceId, cols: 100, rows: 30 });
		const ackDiff = await waitFor(() => clientMessages.find((msg) => msg.type === "cmd_ack" && msg.commandId === "f1-resize-diff" && msg.stage === "applied"), 30000);
		assert.deepEqual([ackDiff.cols, ackDiff.rows], [100, 30]);
		const appliedSnap = snapshot("applied-differing");
		const target = await waitFor(() => {
			const fw = readHost(root, viewId)?.frameWitness;
			if (!fw || !fw.lastProof || fw.lastProof.marker !== "F") return null;
			if (fw.lastProof.cols !== 100 || fw.lastProof.rows !== 30) return null;
			if (fw.geometryRevision < 1) return null;
			return fw;
		}, 60000);
		assert.equal(target.geometryRevision, 1, "exactly one intent for the differing resize");
		assert.equal(target.intents, 1);
		assert.equal(target.lastProof.intentId >= 1, true, "the completing frame carries the intent");
		assert.equal(typeof target.lastProof.seq, "number");
		assert.equal(target.lastProof.mode, "fullscreen", "the adapter bound the ACTUAL public tui.mode");
		// Ordering by PROOF IDENTITY (the ack and the proof can land in the same poll window):
		// the completing frame must be newer than anything observed at applied time.
		const appliedFrameId = appliedAtAck?.lastProof?.frameId ?? 0;
		assert.ok(target.lastProof.frameId > appliedFrameId, "the target proof is LATER than the applied-ack observation");
		evidence.initialResize = { ack: ackDiff, appliedAtAck, target };
		snapshot("target");
		evidence.proofs.push({ stage: "target", proof: target.lastProof });

		// ---- same size: NEW commandId + next seq, its OWN ack, no intent/revision ----
		const revisionBefore = target.geometryRevision;
		send(client, { type: "resize", commandId: "f1-resize-same", clientId: "ui-client", seq: 2, viewId, instanceId, cols: 100, rows: 30 });
		const ackSame = await waitFor(() => clientMessages.find((msg) => msg.type === "cmd_ack" && msg.commandId === "f1-resize-same" && msg.stage === "applied"), 30000);
		assert.deepEqual([ackSame.cols, ackSame.rows], [100, 30]);
		await new Promise((r) => setTimeout(r, 800));
		const afterSame = snapshot("after-same-size");
		assert.equal(afterSame.frameWitness.geometryRevision, revisionBefore, "same-size keeps the revision");
		assert.equal(afterSame.frameWitness.intents, 1, "same-size sends no intent");
		evidence.sameSize = { ack: ackSame, after: afterSame.frameWitness };

		// ---- REAL mode transition: accepted 23a documented sequence, require a LATER regular proof ----
		const frameIdBeforeSwitch = target.lastProof.frameId;
		await new Promise((r) => setTimeout(r, 200));
		sendInput("/settings", "open-settings");
		await new Promise((r) => setTimeout(r, 800));
		sendInput("\r", "submit-settings");
		await new Promise((r) => setTimeout(r, 1500));
		sendInput("tui", "search-tui");
		await new Promise((r) => setTimeout(r, 900));
		sendInput("\r", "cycle-tui-mode");
		await new Promise((r) => setTimeout(r, 1600));
		sendInput("\u001b", "close-selector");
		const regular = await waitFor(() => {
			const fw = readHost(root, viewId)?.frameWitness;
			if (!fw || !fw.lastProof) return null;
			return fw.lastProof.mode === "regular" && fw.lastProof.frameId > frameIdBeforeSwitch ? fw : null;
		}, 45000).catch(() => null);
		snapshot("mode-switch");
		evidence.clientMessages = clientMessages.slice(-40);
		if (regular === null) {
			evidence.failure = "mode transition not observed: no regular proof with a later frameId";
			flush();
			assert.fail(`mode transition not observed: later regular proof missing (last=${JSON.stringify(readHost(root, viewId)?.frameWitness?.lastProof ?? null)})`);
		}
		evidence.modeTransition = { beforeFrameId: frameIdBeforeSwitch, after: regular.lastProof };
		evidence.proofs.push({ stage: "mode", proof: regular.lastProof });

		// ---- ORDERED EXIT: close the selector, clear the editor, then ONE real Ctrl+D ----
		sendInput("\u001b", "close-settings");
		await new Promise((r) => setTimeout(r, 300));
		sendInput("\u0015", "clear-editor");
		await new Promise((r) => setTimeout(r, 300));
		// Sample BEFORE any exit key: the host must still be serving.
		const preExit = snapshot("pre-exit");
		assert.equal(preExit?.state, "alive", "the host is still serving before the exit input");
		assert.equal(observation.exitMessage, null, "no exit had happened before the exit input");
		sendInput("\u0004", "ctrl-d");
		await waitFor(() => observation.exitMessage !== null && observation.hostEnded !== null, 30000);
		const runnerExit = await observeRunnerExit(runner, 20000);
		// Natural exit is accepted ONLY when all three are verified.
		const exitVerified = observation.exitMessage !== null && observation.hostEnded !== null && runnerExit.exited === true && runnerExit.timedOut !== true;
		evidence.orderedExit = {
			actions,
			triggerAction: observation.triggerAction,
			exitMessage: observation.exitMessage,
			childExited: observation.exitMessage !== null && observation.hostEnded !== null,
			childExitCode: observation.exitMessage?.exitCode ?? observation.hostEnded?.exitCode ?? null,
			hostEnded: observation.hostEnded,
			runnerExit,
			runnerExited: runnerExit.exited === true,
			runnerCode: runnerExit.code ?? null,
			runnerSignal: runnerExit.signal ?? null,
			verified: exitVerified,
			forcedKills: [],
		};
		assert.equal(observation.exitMessage.type, "exit", "an actual exit message was observed");
		assert.notEqual(observation.hostEnded.state, "alive", "the host reached a finalized state");
		assert.equal(runnerExit.exited, true, "the runner process actually exited");
		assert.equal(runnerExit.timedOut, false, "the runner exit was observed, not timed out");
		clearInterval(hostWatcher);
		naturalExitObserved = exitVerified;
		evidence.cleanup = { naturalExit: true, forcedKills: [], rootRemoved: false, agentDirRemoved: false };
		flush();

		// ---- no marker bytes anywhere in the observed output ----
		const output = subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("");
		assert.equal(output.includes("agent-board-frame"), false, "no marker bytes in the broadcast");
		const screenLog = readFileSync(P.screenLogPath(root, viewId), "utf8");
		assert.equal(screenLog.includes("agent-board-frame"), false, "no marker bytes in the screen log");
		subscriber.destroy();
		client.destroy();
		flush();
	} catch (error) {
		evidence.failure = error instanceof Error ? error.message : String(error);
		flush();
		throw error;
	}
});
