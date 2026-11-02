// Exploratory real-Pi probe for the post-merge candidate-open regression.
// Uses an isolated session copy and never sends input to the source session.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const sourceRoot = resolve(process.env.REPO_ROOT ?? process.cwd());
const sessionSource = resolve(process.env.SESSION_SOURCE ?? "");
const label = process.env.LABEL ?? "probe";
const artifactDir = resolve(process.env.ARTIFACT_DIR ?? "");
if (!sessionSource || !artifactDir) throw new Error("SESSION_SOURCE and ARTIFACT_DIR are required");
if (existsSync(artifactDir)) throw new Error(`artifact dir exists: ${artifactDir}`);
mkdirSync(artifactDir, { recursive: true });
const { atomicWriteJson } = await import(join(sourceRoot, "src/core/atomic.mjs"));
const P = await import(join(sourceRoot, "src/core/paths.mjs"));
const { claimHost, createView, readHost } = await import(join(sourceRoot, "src/core/store.mjs"));
const launcher = process.env.PI_LAUNCHER ?? "/home/elling/.pi/agent/install/releases/1.5.0/node_modules/.bin/pi";
const root = join(tmpdir(), `attach-candidate-open-${label}-${process.pid}-${Date.now()}`);
const agentDir = join(tmpdir(), `attach-candidate-open-agent-${label}-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const viewId = "candidate-open";
const instanceId = `inst-${label}`;
const meta = createView(root, { id: viewId, name: label, cwd: "/home/elling" });
copyFileSync(sessionSource, meta.sessionFile);
const socketPath = P.hostEndpointPathFor(process.platform, root, viewId, instanceId);
const configPath = P.hostConfigPathFor(root, viewId, instanceId);
claimHost(root, { viewId, instanceId, configPath, socketPath, claimAt: Date.now(), claimPid: process.pid, claimIdentity: null, cols: 80, rows: 24 });
atomicWriteJson(configPath, {
	root, viewId, instanceId, socketPath, sessionFile: meta.sessionFile, cwd: "/home/elling", initialPrompt: null,
	piCommand: launcher,
	piArgsPrefix: ["--no-extensions", "--no-mcp", "--extension", join(sourceRoot, "index.ts"), "--tui-mode", "fullscreen", "--verbose", "--offline", "-na"],
	model: null, tools: null,
	env: { PI_CODING_AGENT_DIR: agentDir, AGENT_BOARD_ALLOW_PIPE_FALLBACK: "0" },
	cols: 80, rows: 24,
});
const sourceHash = createHash("sha256").update(readFileSync(join(sourceRoot, "src/ui/pty-attach.ts"))).digest("hex");
const result = {
	label, sourceRoot, sourceHash, sessionSource, launcher: { path: launcher, version: "1.5.0" },
	runnerPid: null, childPid: null, snapshots: [], wire: [], error: null,
	orderedExit: { input: "Ctrl+D once on an isolated runner", childExited: false, runnerExited: false, forcedKills: [] },
	cleanup: { rootRemoved: false, agentDirRemoved: false },
};
const runner = spawn(process.execPath, [join(sourceRoot, "runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
result.runnerPid = runner.pid ?? null;
runner.stdout.resume(); runner.stderr.resume();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs, label) {
	const start = Date.now();
	for (;;) {
		const value = predicate();
		if (value) return value;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
		await sleep(25);
	}
}
function hostSnapshot(snapshotLabel) {
	const host = readHost(root, viewId);
	result.childPid = host?.childPid ?? result.childPid;
	result.snapshots.push({ label: snapshotLabel, at: Date.now(), state: host?.state ?? null, cols: host?.cols ?? null, rows: host?.rows ?? null, revision: host?.revision ?? null, frameWitness: host?.frameWitness ?? null });
	return host;
}
function connectAndCollect() {
	const socket = createConnection(socketPath);
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const msg = JSON.parse(line);
			const entry = { at: Date.now(), type: msg.type };
			if (msg.type === "snapshot_begin" || msg.type === "snapshot_end") {
				entry.snapshotSeq = msg.snapshotSeq ?? null; entry.nextSeq = msg.nextSeq ?? null; entry.empty = msg.empty ?? null;
				entry.cols = msg.cols ?? null; entry.rows = msg.rows ?? null;
				entry.viewProof = msg.viewProof ? { status: msg.viewProof.status, reason: msg.viewProof.reason, throughSeq: msg.viewProof.throughSeq, proofSeq: msg.viewProof.proof?.seq ?? null, frameId: msg.viewProof.proof?.frameId ?? null } : null;
			} else if (msg.type === "snapshot_frame") {
				entry.bytes = Buffer.byteLength(msg.frame ?? "", "utf8"); entry.sha256 = createHash("sha256").update(msg.frame ?? "").digest("hex");
			} else if (msg.type === "output") {
				entry.seq = msg.seq; entry.bytes = Buffer.byteLength(msg.data ?? "", "utf8");
			} else if (msg.type === "view_proof") {
				entry.marker = msg.record?.marker ?? null; entry.seq = msg.record?.seq ?? null; entry.frameId = msg.record?.frameId ?? null;
			}
			result.wire.push(entry);
		}
	});
	return new Promise((resolveSocket) => socket.on("connect", () => {
		socket.write(`${JSON.stringify({ type: "subscribe_terminal", frameVersion: 1, viewProof: 1 })}\n`);
		resolveSocket(socket);
	}));
}
async function runnerExit(timeoutMs) {
	if (runner.exitCode !== null || runner.signalCode !== null) return true;
	await Promise.race([new Promise((r) => runner.once("exit", r)), sleep(timeoutMs)]);
	return runner.exitCode !== null || runner.signalCode !== null;
}
let exitSocket = null;
try {
	await waitFor(() => { const h = readHost(root, viewId); return h?.state === "alive" && h.childPid ? h : null; }, 20000, "host alive");
	hostSnapshot("alive");
	await sleep(5000);
	hostSnapshot("after-5s");
	const subscriber = await connectAndCollect();
	await sleep(2500);
	subscriber.destroy();
	hostSnapshot("after-subscribe");
	exitSocket = createConnection(socketPath);
	await new Promise((r) => exitSocket.once("connect", r));
	exitSocket.write(`${JSON.stringify({ type: "input", data: "\x04" })}\n`);
	await waitFor(() => readHost(root, viewId)?.state === "exited", 10000, "isolated child natural exit");
	result.orderedExit.childExited = true;
	result.orderedExit.runnerExited = await runnerExit(5000);
	hostSnapshot("exited");
} catch (error) {
	result.error = error instanceof Error ? error.stack ?? error.message : String(error);
	if (exitSocket === null && existsSync(socketPath)) exitSocket = createConnection(socketPath);
	if (exitSocket !== null && exitSocket.destroyed === false) {
		try { exitSocket.write(`${JSON.stringify({ type: "terminate" })}\n`); result.orderedExit.forcedKills.push("public terminate after failed natural exit"); } catch {}
	}
	result.orderedExit.runnerExited = await runnerExit(7000);
} finally {
	try { exitSocket?.destroy(); } catch {}
	if (!result.orderedExit.runnerExited && runner.exitCode === null && runner.signalCode === null) {
		try { runner.kill("SIGKILL"); result.orderedExit.forcedKills.push(`runner:${runner.pid}:SIGKILL`); } catch {}
		await runnerExit(1000);
	}
	for (const name of ["host.json", "screen.log"]) {
		const source = join(root, "views", viewId, name);
		if (existsSync(source)) copyFileSync(source, join(artifactDir, name));
	}
	writeFileSync(join(artifactDir, "result.json"), JSON.stringify(result, null, 2));
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
	rmSync(agentDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
	result.cleanup.rootRemoved = !existsSync(root); result.cleanup.agentDirRemoved = !existsSync(agentDir);
	writeFileSync(join(artifactDir, "result.json"), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ artifactDir, label, sourceRoot, sourceHash, error: result.error, snapshots: result.snapshots, wire: result.wire, orderedExit: result.orderedExit, cleanup: result.cleanup }));
