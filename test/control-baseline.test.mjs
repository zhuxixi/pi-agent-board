import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readHost } from "../src/core/store.mjs";

// Regression baseline for issue #91 (architecture hardening): locks the
// CURRENT pre-D4 control-socket behavior — control commands are
// fire-and-forget (no ack of any kind), and hello seeds editorEmpty.
// When the acked protocol lands, these tests are expected to change
// deliberately as part of that work — a failure here is a protocol
// behavior change, not an accident.

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-ctl-baseline-"));
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function hostReady(root, viewId) {
	const host = readHost(root, viewId);
	if (!host || host.state !== "alive" || !host.socketPath || !host.childPid) return false;
	return isAlive(host.runnerPid);
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

function send(socket, msg) {
	socket.write(JSON.stringify(msg) + "\n");
}

/** Collect JSONL messages arriving on the socket. */
function readMessages(socket) {
	let buf = "";
	const messages = [];
	socket.on("data", (chunk) => {
		buf += chunk.toString();
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
	});
	return messages;
}

async function waitForExit(child, timeoutMs) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			child.removeListener("exit", onExit);
			resolve(true);
		};
		const onExit = () => finish();
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.removeListener("exit", onExit);
			resolve(false);
		}, timeoutMs);
		child.once("exit", onExit);
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

function reapChild(root, viewId) {
	try {
		const pid = readHost(root, viewId)?.childPid;
		if (pid) process.kill(pid, "SIGKILL");
	} catch {}
}

/** Standard host fixture: fake child pi on an isolated root, runner spawned. */
async function startBaselineHost(t, viewId = "v1") {
	const root = freshRoot();
	const meta = createView(root, { id: viewId, name: "ctl-baseline", cwd: process.cwd() });
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
		rows: 24,
	});
	const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
	await waitFor(() => hostReady(root, viewId));
	t.after(async () => {
		await stopRunner(runner);
		reapChild(root, viewId);
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	const socket = createConnection(P.controlSocketPath(root, viewId));
	await once(socket, "connect");
	return { root, socket, messages: readMessages(socket) };
}

/** Settle window: let any in-flight reply arrive before asserting absence. */
function settle(ms = 500) {
	return new Promise((r) => setTimeout(r, ms));
}

test("baseline: resize command receives no ack (pre-D4 fire-and-forget)", async (t) => {
	const { root, socket, messages } = await startBaselineHost(t);
	send(socket, { type: "resize", cols: 100, rows: 30 });
	// Prove the runner actually processed the resize (durable side effect),
	// so the absence assertions below are about the reply, not a lost command.
	await waitFor(() => readHost(root, "v1")?.cols === 100);
	await settle();
	assert.equal(messages.find((m) => m.type === "ack" || m.type === "resize_ack"), undefined);
	socket.destroy();
});

test("baseline: UI keystroke input without requestId receives no input_ack", async (t) => {
	const { socket, messages } = await startBaselineHost(t);
	send(socket, { type: "input", data: "x" });
	// Prove the input reached the child (echo) before asserting no reply came back.
	await waitFor(() => messages.find((m) => m.type === "output" && m.data.includes("echo:x")));
	await settle();
	assert.equal(messages.find((m) => m.type === "input_ack"), undefined);
	socket.destroy();
});

test("baseline: hello reply carries editorEmpty field", async (t) => {
	const { socket, messages } = await startBaselineHost(t);
	send(socket, { type: "hello", clientId: "baseline", wantOutput: true });
	const hello = await waitFor(() => messages.find((m) => m.type === "hello" && "editorEmpty" in m));
	assert.ok(hello);
	assert.ok("status" in hello);
	socket.destroy();
});
