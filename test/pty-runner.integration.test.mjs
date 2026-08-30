import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-pty-"));
}

async function waitFor(predicate, timeoutMs = 3000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out waiting");
}

/** Host is usable once the runner reports the socket bound and the child pid is recorded.
 *  Deliberately avoids existsSync(socketPath): on Windows the socket is a named pipe,
 *  which never exists as a filesystem entry. Also requires the runner process to be
 *  alive, so a runner that fails at listen (and exits) never satisfies the gate. */
function hostReady(root, viewId) {
	const host = readHost(root, viewId);
	if (!host || host.state !== "alive" || !host.socketPath || !host.childPid) return false;
	return isAlive(host.runnerPid);
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

let hasNodePty = true;
try {
	await import("node-pty");
} catch {
	hasNodePty = false;
}

function send(socket, msg) {
	socket.write(JSON.stringify(msg) + "\n");
}

/** Best-effort reap of the hosted child after a hard runner kill (Windows). */
function reapChild(root, viewId) {
	try {
		const pid = readHost(root, viewId)?.childPid;
		if (pid) process.kill(pid, "SIGKILL");
	} catch {}
}

test("pty-runner creates host socket, broadcasts output, forwards input, finalizes", async () => {
	const root = freshRoot();
	let runner;
	try {
		const meta = createView(root, { id: "v1", name: "pty", cwd: process.cwd() });
		const configPath = P.hostConfigPath(root, "v1");
		atomicWriteJson(configPath, {
			root,
			viewId: "v1",
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
			model: null,
			tools: null,
			env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1" },
			cols: 80,
			rows: 24,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		await waitFor(() => hostReady(root, "v1"));

		const socket = createConnection(P.controlSocketPath(root, "v1"));
		await once(socket, "connect");
		let buf = "";
		const messages = [];
		socket.on("data", (chunk) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
		});
		send(socket, { type: "hello" });
		// The socket carries only live output; output emitted before the client connects
		// is replayed from the screen log (same as the UI attach path, pty-attach.ts
		// replayScreenLog). Wait on the log so the boot banner is visible before we
		// assert on realtime echo below.
		await waitFor(() => {
			try {
				return readFileSync(P.screenLogPath(root, "v1"), "utf8").includes("fake pi ready");
			} catch {
				return false;
			}
		});
		send(socket, { type: "input", data: "hello\r" });
		await waitFor(() => messages.find((m) => m.type === "output" && m.data.includes("echo:hello")));
		send(socket, { type: "resize", cols: 100, rows: 30 });
		await waitFor(() => readHost(root, "v1")?.cols === 100);
		send(socket, { type: "input", data: "exit\r" });
		await waitFor(() => readHost(root, "v1")?.endedAt);
		assert.equal(readHost(root, "v1").state, "exited");
		assert.match(readFileSync(P.screenLogPath(root, "v1"), "utf8"), /fake pi ready/);
		socket.destroy();
	} finally {
		try { runner?.kill("SIGTERM"); } catch {}
		reapChild(root, "v1");
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("pty-runner protects dash-prefixed initial prompts while keeping argv delivery", async () => {
	const root = freshRoot();
	let runner;
	try {
		const meta = createView(root, { id: "v1", name: "pty", cwd: process.cwd() });
		const capturePath = join(root, "argv-prompt.txt");
		const configPath = P.hostConfigPath(root, "v1");
		atomicWriteJson(configPath, {
			root,
			viewId: "v1",
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: "- Create a ticket\n- Run the fix",
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
			model: null,
			tools: null,
			env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_ARGV_CAPTURE_PATH: capturePath },
			cols: 80,
			rows: 24,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		await waitFor(() => hostReady(root, "v1"));
		await waitFor(() => existsSync(capturePath) && readFileSync(capturePath, "utf8") === " - Create a ticket\n- Run the fix");
	} finally {
		try { runner?.kill("SIGTERM"); } catch {}
		reapChild(root, "v1");
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("pty-runner terminates its child when the runner is stopped", { skip: !hasNodePty }, async () => {
	const root = freshRoot();
	let runner;
	try {
		const meta = createView(root, { id: "v1", name: "pty-kill", cwd: process.cwd() });
		const configPath = P.hostConfigPath(root, "v1");
		atomicWriteJson(configPath, {
			root,
			viewId: "v1",
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
			model: null,
			tools: null,
			// No AGENT_BOARD_ALLOW_PIPE_FALLBACK: exercise the node-pty path whose
			// kill() throws "Signals not supported on windows" — the runner must
			// fall back to terminating the child directly.
			env: {},
			cols: 80,
			rows: 24,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		await waitFor(() => hostReady(root, "v1"));
		const childPid = readHost(root, "v1")?.childPid;
		assert.ok(childPid, "child pid recorded");
		assert.ok(isAlive(childPid), "child alive before stop");
		// Use the control protocol (the panel stop path) rather than killing the
		// runner process: on Windows process.kill("SIGTERM") is TerminateProcess
		// and would skip the runner's shutdown handler entirely.
		const socket = createConnection(P.controlSocketPath(root, "v1"));
		await once(socket, "connect");
		send(socket, { type: "terminate" });
		await waitFor(() => !isAlive(childPid), 5000);
	} finally {
		try { runner?.kill("SIGKILL"); } catch {}
		const pid = readHost(root, "v1")?.childPid;
		if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("pty-runner honors screenLogMaxBytes from host config", async () => {
	const root = freshRoot();
	let runner;
	try {
		const meta = createView(root, { id: "cap1", name: "cap", cwd: process.cwd() });
		const configPath = P.hostConfigPath(root, "cap1");
		atomicWriteJson(configPath, {
			root,
			viewId: "cap1",
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
			model: null,
			tools: null,
			env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1" },
			cols: 80,
			rows: 24,
			screenLogMaxBytes: 2048,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		await waitFor(() => existsSync(P.controlSocketPath(root, "cap1")) && readHost(root, "cap1")?.state === "alive");

		const socket = createConnection(P.controlSocketPath(root, "cap1"));
		await once(socket, "connect");
		// ~8 KB of echoed output → well over the 2 KB cap → runner must compact.
		send(socket, { type: "input", data: `${"x".repeat(8192)}\n` });
		await waitFor(() => {
			try {
				return statSync(P.screenLogPath(root, "cap1")).size > 0;
			} catch {
				return false;
			}
		});
		send(socket, { type: "input", data: "exit\n" });
		await waitFor(() => readHost(root, "cap1")?.endedAt != null);
		// Compaction happens synchronously inside onData; size must settle ≤ cap.
		const size = await waitFor(() => {
			try {
				const s = statSync(P.screenLogPath(root, "cap1")).size;
				return s <= 2048 ? s : false;
			} catch {
				return false;
			}
		});
		assert.ok(size > 0 && size <= 2048, `screen.log should be compacted to <=2048 bytes, got ${size}`);
		socket.end();
	} finally {
		try { runner?.kill(); } catch {}
		rmSync(root, { recursive: true, force: true });
	}
});
