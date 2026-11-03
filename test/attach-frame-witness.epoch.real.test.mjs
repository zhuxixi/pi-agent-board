// Issue #222 step 23b2c3a: REAL default-Pi second session_start (/new) epoch fencing.
// Opt-in: PI23B2C3A_REAL_PI=1, optional fresh PI23B2C3A_ARTIFACT_DIR.
// No model request, no auth/global change; isolated root + PI_CODING_AGENT_DIR.
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

const enabled = process.env.PI23B2C3A_REAL_PI === "1";
const reason = "set PI23B2C3A_REAL_PI=1 to run the real second-session_start epoch test";
const ARTIFACT_DIR = process.env.PI23B2C3A_ARTIFACT_DIR ? resolve(process.env.PI23B2C3A_ARTIFACT_DIR) : null;

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
async function waitFor(predicate, timeoutMs = 30000, label = "condition") {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out: ${label}`);
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
async function stopRunner(runner) {
	if (!runner || runner.exitCode !== null || runner.signalCode !== null) return;
	try { runner.kill("SIGTERM"); } catch { /* gone */ }
	await new Promise((r) => setTimeout(r, 300));
	if (runner.exitCode === null && runner.signalCode === null) {
		try { runner.kill("SIGKILL"); } catch { /* gone */ }
	}
}
function reapChild(root, viewId) {
	try {
		const pid = readHost(root, viewId)?.childPid;
		if (pid) process.kill(pid, "SIGKILL");
	} catch { /* gone */ }
}

// Registered only in the opt-in real lane so the default `npm test` inventory keeps its
// existing skip count (this file contributes no skipped test case when disabled).
if (enabled) test(`23b2c3a real /new: second session_start epoch fencing [${reason}]`, async (t) => {
	assert.ok(!ARTIFACT_DIR || !existsSync(ARTIFACT_DIR), "PI23B2C3A_ARTIFACT_DIR must be fresh (overwrite refused)");
	if (ARTIFACT_DIR) mkdirSync(ARTIFACT_DIR, { recursive: true });
	const launcher = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).stdout.trim();
	assert.ok(launcher !== "", "real pi launcher available");
	const launcherRealpath = realpathSync(launcher);
	const extensionEntry = resolve("index.ts");
	const root = mkdtempSync(join(tmpdir(), "agentview-epoch-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi23b2c3a-agent-"));
	const viewId = "real-epoch";
	const instanceId = "inst-real-epoch";
	const meta = createView(root, { id: viewId, name: "real-epoch", cwd: process.cwd() });
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
		launcher: { launcher, launcherRealpath, launcherSha256: sha256(readFileSync(launcherRealpath)), extensionSha256: sha256(readFileSync(extensionEntry)) },
		epoch1: null,
		epoch2: null,
		snapshots: [],
		subscriber: { chunks: 0, bytes: 0, markerScan: null, tail: "" },
		inputTimeline: [],
		exit: null,
		cleanup: null,
		failure: null,
	};
	let naturalExit = false;
	let subscriberText = "";
	const flush = () => {
		if (ARTIFACT_DIR === null) return;
		evidence.subscriber.bytes = Buffer.byteLength(subscriberText, "utf8");
		evidence.subscriber.markerScan = subscriberText.includes("agent-board-frame") ? "found" : "absent";
		evidence.subscriber.tail = subscriberText.slice(-4000);
		writeFileSync(join(ARTIFACT_DIR, "subscriber.txt"), subscriberText);
		writeFileSync(join(ARTIFACT_DIR, "result.json"), JSON.stringify(evidence, null, 2));
	};
	const snapshot = (label) => {
		const host = readHost(root, viewId);
		evidence.snapshots.push({ label, at: new Date().toISOString(), frameWitness: host?.frameWitness ?? null, state: host?.state ?? null });
		return host;
	};
	t.after(async () => {
		flush();
		if (!naturalExit) {
			await stopRunner(runner);
			reapChild(root, viewId);
		}
		await new Promise((r) => setTimeout(r, 100));
		evidence.cleanup = { ...(evidence.cleanup ?? {}), naturalExit, rootRemoved: false, agentDirRemoved: false, forcedKills: [] };
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		evidence.cleanup.rootRemoved = !existsSync(root);
		evidence.cleanup.agentDirRemoved = !existsSync(agentDir);
		flush();
	});
	try {
		await waitFor(() => readHost(root, viewId)?.state === "alive" && readHost(root, viewId)?.childPid, 30000, "host alive");
		const epoch1 = await waitFor(() => {
			const fw = readHost(root, viewId)?.frameWitness;
			return fw?.enabled === true && fw.lastProof?.sessionEpoch === 1 ? fw : null;
		}, 60000, "epoch1 proof");
		evidence.epoch1 = { instanceId: epoch1.instanceId, sessionEpoch: epoch1.sessionEpoch, tokenFingerprint: epoch1.tokenFingerprint, lastProof: epoch1.lastProof };
		snapshot("epoch1");

		const subscriber = createConnection(socketPath);
		await once(subscriber, "connect");
		const subscriberMessages = listen(subscriber);
		subscriber.on("data", (chunk) => {
			subscriberText += chunk.toString();
			evidence.subscriber.chunks += 1;
		});
		send(subscriber, { type: "subscribe_terminal", viewProof: 1 });

		const client = createConnection(socketPath);
		await once(client, "connect");
		const clientMessages = listen(client);
		send(client, { type: "hello", clientId: "epoch-ui" });
		await waitFor(() => clientMessages.some((msg) => msg.type === "hello"), 10000, "client hello");

		const input = (data, label) => {
			evidence.inputTimeline.push({ label, data, at: Date.now() });
			send(client, { type: "input", data });
		};
		input("/new", "new-command");
		await new Promise((r) => setTimeout(r, 1200));
		input("\r", "submit-new");
		await new Promise((r) => setTimeout(r, 1200));

		snapshot("after-new-input");
		const newSessionStarted = await waitFor(() => subscriberText.includes("New session started"), 30000, "raw Pi New session started").then(() => true).catch(() => false);
		evidence.rawNewSessionStarted = newSessionStarted;
		const epoch2Enabled = await waitFor(() => {
			const fw = readHost(root, viewId)?.frameWitness;
			return fw?.enabled === true && fw.sessionEpoch === 2 && fw.tokenFingerprint !== epoch1.tokenFingerprint ? fw : null;
		}, 15000, "epoch2 enable after /new").catch(() => null);
		snapshot("epoch2-enable-or-timeout");
		if (epoch2Enabled !== null) {
			evidence.epoch2EnableOnly = { instanceId: epoch2Enabled.instanceId, sessionEpoch: epoch2Enabled.sessionEpoch, tokenFingerprint: epoch2Enabled.tokenFingerprint, lastProof: epoch2Enabled.lastProof ?? null };
			const epoch2 = await waitFor(() => {
				const fw = readHost(root, viewId)?.frameWitness;
				return fw?.enabled === true && fw.sessionEpoch === 2 && fw.tokenFingerprint !== epoch1.tokenFingerprint && fw.lastProof?.sessionEpoch === 2 ? fw : null;
			}, 45000, "epoch2 proof after /new");
			evidence.epoch2 = { instanceId: epoch2.instanceId, sessionEpoch: epoch2.sessionEpoch, tokenFingerprint: epoch2.tokenFingerprint, lastProof: epoch2.lastProof };
			snapshot("epoch2");
			assert.equal(epoch2.instanceId, epoch1.instanceId, "same runner generation");
			assert.notEqual(epoch2.tokenFingerprint, epoch1.tokenFingerprint, "new witness token");
			assert.equal(epoch1.sessionEpoch, 1);
			assert.equal(epoch2.sessionEpoch, 2);
			assert.ok(epoch2.lastProof.seq > epoch1.lastProof.seq, "epoch2 proof is later in ordered output seq");
			assert.equal(epoch2.lastProof.sessionEpoch, 2, "old epoch proof is not current");
		} else {
			// Parent-approved stop condition: /new must not be claimed as epoch coverage when
			// the real host does not emit a second extension session_start/enable.
			const current = snapshot("epoch2-unavailable");
			evidence.epoch2Unavailable = {
				reason: "raw /new completed but no second frame_witness_enable/session_start was observed",
				rawNewSessionStarted: newSessionStarted,
				hostState: current?.state ?? null,
				frameWitness: current?.frameWitness ?? null,
			};
			assert.equal(newSessionStarted, true, "raw /new actually ran");
			assert.equal(current?.frameWitness?.sessionEpoch, 1, "no epoch2 claim is made");
		}
		assert.equal(subscriberText.includes("agent-board-frame"), false, "no marker bytes in broadcast");

		// Natural exit through the real input path.
		input("\u0004", "ctrl-d");
		await waitFor(() => {
			const host = readHost(root, viewId);
			return host?.state === "exited" && host.endedAt;
		}, 30000, "natural host exit");
		const exit = await waitFor(() => (runner.exitCode !== null || runner.signalCode !== null ? { code: runner.exitCode, signal: runner.signalCode } : null), 20000, "runner exit");
		naturalExit = true;
		evidence.exit = { host: readHost(root, viewId), runner: exit, forcedKills: [] };
		assert.equal(exit.signal, null, "runner exited naturally");
		assert.equal(exit.code, 0);
		const screenLog = readFileSync(P.screenLogPath(root, viewId), "utf8");
		assert.equal(screenLog.includes("agent-board-frame"), false, "no marker bytes in screenLog");
		subscriber.destroy();
		client.destroy();
		flush();
	} catch (error) {
		evidence.failure = error instanceof Error ? error.message : String(error);
		flush();
		throw error;
	}
});
