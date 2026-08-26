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

function send(socket, msg) {
	socket.write(JSON.stringify(msg) + "\n");
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
		await waitFor(() => existsSync(P.controlSocketPath(root, "v1")) && readHost(root, "v1")?.state === "alive");

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
		await waitFor(() => existsSync(P.controlSocketPath(root, "v1")) && readHost(root, "v1")?.state === "alive");
		await waitFor(() => existsSync(capturePath) && readFileSync(capturePath, "utf8") === " - Create a ticket\n- Run the fix");
	} finally {
		try { runner?.kill("SIGTERM"); } catch {}
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
