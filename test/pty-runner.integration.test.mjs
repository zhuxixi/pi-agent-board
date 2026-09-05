import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import * as P from "../src/core/paths.mjs";
import { claimHost, createView, readHost, writeHost } from "../src/core/store.mjs";

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

/** Connect to the control socket, retrying until it binds. The runner binds the
 *  socket only after the child spawns, and on Windows the pipe is not a filesystem
 *  entry (existsSync can't gate it), so poll with real connect attempts. */
async function connectWhenReady(socketPath, timeoutMs = 5000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const socket = createConnection(socketPath);
		try {
			await once(socket, "connect");
			return socket;
		} catch {
			socket.destroy();
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	throw new Error("timed out waiting for control socket");
}

let hasNodePty = true;
try {
	await import("node-pty");
} catch {
	hasNodePty = false;
}

function waitForExit(child, timeoutMs) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		let timer;
		const onExit = () => finish(true);
		const finish = (exited) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("exit", onExit);
			resolve(exited);
		};
		timer = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
		if (child.exitCode !== null || child.signalCode !== null) finish(true);
	});
}

async function stopRunner(runner) {
	if (!runner || runner.exitCode !== null || runner.signalCode !== null) return;
	try { runner.kill("SIGTERM"); } catch {}
	if (!(await waitForExit(runner, 500)) && runner.exitCode === null && runner.signalCode === null) {
		try { runner.kill("SIGKILL"); } catch {}
		await waitForExit(runner, 500);
	}
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

test("pty-runner applies an ordered restore resize before a detach packet", async () => {
	const root = freshRoot();
	let runner;
	let socket;
	try {
		const meta = createView(root, { id: "detach1", name: "detach", cwd: process.cwd() });
		const configPath = P.hostConfigPath(root, "detach1");
		atomicWriteJson(configPath, {
			root,
			viewId: "detach1",
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
			model: null,
			tools: null,
			env: {},
			cols: 80,
			rows: 24,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		await waitFor(() => existsSync(P.controlSocketPath(root, "detach1")) && readHost(root, "detach1")?.state === "alive");

		socket = createConnection(P.controlSocketPath(root, "detach1"));
		socket.on("error", () => {});
		await once(socket, "connect");
		// Send both packets in one write, matching PtyAttachComponent's
		// restore -> detach sequence. The runner must process resize first,
		// before ending the socket for detach.
		socket.write(
			JSON.stringify({ type: "resize", cols: 100, rows: 30 }) + "\n" +
			JSON.stringify({ type: "detach" }) + "\n",
		);
		// host.json is the durable protocol-side observation. Do not wait for
		// the client socket's close event: some Node/net versions keep the local
		// close event pending while the peer has already ended its side.
		await waitFor(() => readHost(root, "detach1")?.cols === 100 && readHost(root, "detach1")?.rows === 30);
		assert.equal(readHost(root, "detach1").cols, 100);
		assert.equal(readHost(root, "detach1").rows, 30);
	} finally {
		try { socket?.destroy(); } catch {}
		await stopRunner(runner);
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("pty-runner server error routes through the child-aware shutdown", async () => {
	const root = freshRoot();
	let runner;
	try {
		const meta = createView(root, { id: "servererr1", name: "server error", cwd: process.cwd() });
		const configPath = P.hostConfigPath(root, "servererr1");
		const socketPath = P.controlSocketPath(root, "servererr1");
		// A directory at the Unix socket path survives the runner's best-effort
		// unlink and makes server.listen() emit EADDRINUSE right after spawn.
		mkdirSync(socketPath);
		atomicWriteJson(configPath, {
			root,
			viewId: "servererr1",
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-ignore-term-pi.mjs")],
			model: null,
			tools: null,
			env: {},
			cols: 80,
			rows: 24,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		assert.equal(await waitForExit(runner, 7000), true, "runner must exit after server error cleanup");
		assert.equal(runner.exitCode, 1);
		// The failed listener must be recorded, and — the actual regression guard —
		// the runner must have awaited the child's exit before process.exit:
		// child.onExit is what clears childPid and flips state to "exited". The
		// old server-error path exited synchronously, leaving state "failed"
		// with childPid still set.
		const host = readHost(root, "servererr1");
		assert.match(host.error ?? "", /EADDRINUSE/);
		assert.equal(host.childPid, null, "shutdown must observe the child exit before the runner exits");
		assert.equal(host.state, "exited");
	} finally {
		await stopRunner(runner);
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("pty-runner shutdown escalates when the PTY child ignores SIGTERM", async () => {
	const root = freshRoot();
	let runner;
	let childPid;
	try {
		const meta = createView(root, { id: "ignore1", name: "ignore", cwd: process.cwd() });
		const configPath = P.hostConfigPath(root, "ignore1");
		const childPidPath = join(root, "ignore-child.pid");
		atomicWriteJson(configPath, {
			root,
			viewId: "ignore1",
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			// The shell trap sets SIG_IGN for TERM/HUP/INT BEFORE exec, and ignored
			// dispositions survive exec — the child then ignores SIGTERM even while
			// node is booting. The test waits for the child's PID file (written after
			// boot) before signaling the runner, so the 4s SIGKILL escalation is the
			// only way shutdown can complete.
			piCommand: "sh",
			piArgsPrefix: [
				"-c",
				`trap '' TERM HUP INT; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("test-support/fake-ignore-term-pi.mjs"))}`,
			],
			model: null,
			tools: null,
			env: { FAKE_PTY_PID_PATH: childPidPath },
			cols: 80,
			rows: 24,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		await waitFor(() => existsSync(childPidPath));
		childPid = Number(readFileSync(childPidPath, "utf8"));
		assert.ok(childPid > 0, "escalation fixture must wait for the booted PTY child");
		const shutdownStartedAt = Date.now();
		runner.kill("SIGTERM");
		assert.equal(await waitForExit(runner, 7000), true, "runner must finish the escalated shutdown");
		const shutdownElapsed = Date.now() - shutdownStartedAt;
		assert.ok(
			shutdownElapsed >= 3500,
			`shutdown finished in ${shutdownElapsed}ms — a SIGTERM-immune child requires the ~4s SIGKILL escalation`,
		);
		assert.equal(runner.exitCode, 0);
		assert.throws(() => process.kill(childPid, 0), "child must be gone after runner shutdown");
	} finally {
		try { if (childPid) process.kill(childPid, "SIGKILL"); } catch {}
		await stopRunner(runner);
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

test("pty-runner survives persistent host.json persist failures (EPERM-class)", async () => {
	const root = freshRoot();
	let runner;
	let childPid = null;
	try {
		const meta = createView(root, { id: "v1", name: "persist-fail", cwd: process.cwd() });
		// Occupy host.json with a DIRECTORY: rename(tmp, host.json) must fail on
		// every attempt on every platform (EISDIR/EPERM), so every heartbeat
		// persist fails — the runner must degrade instead of dying.
		mkdirSync(P.hostPath(root, "v1"), { recursive: true });
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
		// hostReady() gates on host.json which can never be written here — gate on
		// the runner process being alive, then poll-connect the control socket
		// (the runner binds it only after the child spawns).
		await waitFor(() => isAlive(runner.pid ?? -1));
		const socket = await connectWhenReady(P.controlSocketPath(root, "v1"));
		let buf = "";
		const messages = [];
		socket.on("data", (chunk) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
		});
		send(socket, { type: "get_status" });
		// The control protocol must keep working even though every host.json
		// write fails (status is delivered over the socket, not the file).
		await waitFor(() => messages.find((m) => m.type === "status"));
		// Capture the child pid from the socket status (host.json is occupied by
		// a directory, so reapChild's readHost lookup is a no-op here).
		childPid = messages.find((m) => m.type === "status")?.status?.childPid ?? null;
		// Degradation is recorded in diagnostics; the runner is still alive.
		await waitFor(() => readDiagnostics(root, "v1").some((d) => d.code === "persist_error"));
		assert.ok(isAlive(runner.pid ?? -1), "runner must survive persist failures");
		socket.destroy();
	} finally {
		try { runner?.kill("SIGKILL"); } catch {}
		if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
		reapChild(root, "v1");
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("pty-runner routes editor_state between clients, seeds hello, resets on exit", async () => {
	const root = freshRoot();
	let runner;
	try {
		const meta = createView(root, { id: "v1", name: "editor-state", cwd: process.cwd() });
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

		const readMessages = (socket) => {
			let buf = "";
			const messages = [];
			socket.on("data", (chunk) => {
				buf += chunk.toString();
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
			});
			return messages;
		};

		const client1 = createConnection(P.controlSocketPath(root, "v1"));
		await once(client1, "connect");
		const messages1 = readMessages(client1);
		send(client1, { type: "hello" });
		await waitFor(() => messages1.find((m) => m.type === "hello"));

		// A second client must receive the pushed state as a broadcast.
		const client2 = createConnection(P.controlSocketPath(root, "v1"));
		await once(client2, "connect");
		const messages2 = readMessages(client2);
		send(client1, { type: "editor_state", empty: false });
		await waitFor(() => messages2.find((m) => m.type === "editor_state"));
		assert.equal(messages2.find((m) => m.type === "editor_state").empty, false);

		// A client connecting afterwards gets the current state seeded in hello.
		const client3 = createConnection(P.controlSocketPath(root, "v1"));
		await once(client3, "connect");
		const messages3 = readMessages(client3);
		send(client3, { type: "hello" });
		// The runner also sends an unsolicited hello on connect (now with the
		// current editorEmpty seeded too); both it and the explicit-hello reply
		// carry the seeded value, so the finder matches either.
		await waitFor(() => messages3.find((m) => m.type === "hello" && "editorEmpty" in m));
		assert.equal(messages3.find((m) => m.type === "hello" && "editorEmpty" in m).editorEmpty, false);

		// Child exit resets the state to null and broadcasts it.
		send(client1, { type: "input", data: "exit\r" });
		await waitFor(() => messages2.find((m) => m.type === "editor_state" && m.empty === null));
		await waitFor(() => readHost(root, "v1")?.endedAt);

		client1.destroy();
		client2.destroy();
		client3.destroy();
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

// ---- new-protocol (issue #70): per-instance endpoint + ownership fencing ----

/** Launch a new-protocol runner the way the service does: instance-scoped
 *  config + provisional host claim, then spawn. Returns runner/config/socket. */
async function launchOwnedRunner(root, viewId, instanceId, opts = {}) {
	const meta = createView(root, { id: viewId, name: `owned-${instanceId}`, cwd: process.cwd() });
	const configPath = P.hostConfigPathFor(root, viewId, instanceId);
	const socketPath = P.hostEndpointPathFor(process.platform, root, viewId, instanceId);
	atomicWriteJson(configPath, {
		root,
		viewId,
		instanceId,
		configPath,
		socketPath,
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
		...opts.config,
	});
	const claim = claimHost(root, {
		viewId,
		instanceId,
		configPath,
		socketPath,
		claimAt: Date.now(),
		claimPid: process.pid,
		claimIdentity: { pid: process.pid, startToken: null },
	});
	if (!claim.claimed) throw new Error(`claimHost refused: ${JSON.stringify(claim)}`);
	const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
	return { runner, configPath, socketPath, meta };
}

test("owned runner binds unique endpoint, publishes ready, cleans up on natural child exit", async () => {
	const root = freshRoot();
	let runner;
	let childPid;
	try {
		({ runner } = await launchOwnedRunner(root, "v1", "i1"));
		const host = await waitFor(() => {
			const h = readHost(root, "v1");
			return h?.state === "alive" && h?.readyAt != null && h?.childPid ? h : false;
		});
		childPid = host.childPid;
		assert.ok(isAlive(childPid), "child alive before exit");
		assert.equal(host.instanceId, "i1");
		assert.equal(host.socketPath, P.hostEndpointPathFor(process.platform, root, "v1", "i1"));
		const socket = createConnection(host.socketPath);
		socket.on("error", () => {});
		await once(socket, "connect");
		send(socket, { type: "input", data: "exit\r" });
		assert.equal(await waitForExit(runner, 5000), true, "runner exits after natural child exit");
		await waitFor(() => readHost(root, "v1")?.state === "exited");
		const final = readHost(root, "v1");
		assert.equal(final.instanceId, "i1");
		assert.equal(final.childPid, null);
		assert.equal(final.readyAt, null);
		assert.ok(final.endedAt != null, "terminal record carries endedAt");
		assert.equal(existsSync(host.socketPath), false, "instance endpoint must be cleaned up");
		socket.destroy();
	} finally {
		try { runner?.kill("SIGKILL"); } catch {}
		if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("duplicate runner for the same instance exits before spawning a child", async () => {
	const root = freshRoot();
	let runnerA;
	let runnerB;
	let childPid;
	try {
		({ runner: runnerA } = await launchOwnedRunner(root, "v1", "i1"));
		const host = await waitFor(() => {
			const h = readHost(root, "v1");
			return h?.state === "alive" && h?.childPid ? h : false;
		});
		childPid = host.childPid;
		// B starts from the SAME instance config — the endpoint is already owned by A.
		runnerB = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), host.configPath], { stdio: ["ignore", "pipe", "pipe"] });
		assert.equal(await waitForExit(runnerB, 8000), true, "duplicate runner must exit");
		const diags = readDiagnostics(root, "v1");
		assert.ok(
			diags.some((d) => d.code === "host_endpoint_busy" || d.code === "host_start_yielded"),
			"duplicate runner records a yield/busy diagnostic",
		);
		assert.ok(isAlive(childPid), "original child still alive");
		const settled = readHost(root, "v1");
		assert.equal(settled.state, "alive");
		assert.equal(settled.childPid, childPid);
		assert.equal(settled.runnerPid, runnerA.pid, "duplicate runner never wrote host.json");
	} finally {
		try { runnerA?.kill("SIGKILL"); } catch {}
		try { runnerB?.kill("SIGKILL"); } catch {}
		if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("owned runner does not unlink a foreign endpoint on exit", async () => {
	const root = freshRoot();
	let runner;
	let childPid;
	let foreign;
	try {
		({ runner } = await launchOwnedRunner(root, "v1", "i1"));
		await waitFor(() => readHost(root, "v1")?.state === "alive");
		childPid = readHost(root, "v1")?.childPid;
		// A second instance's endpoint with a REAL listener must survive A's exit.
		const foreignPath = P.hostEndpointPathFor(process.platform, root, "v1", "i2");
		foreign = createServer(() => {});
		await new Promise((resolveListen, rejectListen) => {
			foreign.once("error", rejectListen);
			foreign.listen(foreignPath, resolveListen);
		});
		runner.kill("SIGTERM");
		assert.equal(await waitForExit(runner, 8000), true, "owned runner exits on SIGTERM");
		const probe = createConnection(foreignPath);
		probe.on("error", () => {});
		await once(probe, "connect");
		probe.destroy();
		assert.equal(existsSync(foreignPath), true, "foreign endpoint survives the other instance's exit");
	} finally {
		try { runner?.kill("SIGKILL"); } catch {}
		if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
		try { foreign?.close(); } catch {}
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("heartbeat detects ownership loss and exits without writing host state", async () => {
	const root = freshRoot();
	let runner;
	let childPid;
	try {
		({ runner } = await launchOwnedRunner(root, "v1", "i1"));
		await waitFor(() => readHost(root, "v1")?.state === "alive");
		childPid = readHost(root, "v1")?.childPid;
		// Simulate a superseding owner rewriting host.json.
		writeHost(root, { ...readHost(root, "v1"), instanceId: "other" });
		assert.equal(await waitForExit(runner, 5000), true, "runner exits after ownership loss");
		const after = readHost(root, "v1");
		assert.equal(after.instanceId, "other", "superseding owner's record untouched");
		assert.equal(after.state, "alive", "loser runner never wrote a terminal state");
	} finally {
		try { runner?.kill("SIGKILL"); } catch {}
		if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
