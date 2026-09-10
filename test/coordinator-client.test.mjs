/**
 * Integration tests for the View State Coordinator client (issue #91, plan Task 5).
 * Fake in-process JSONL servers cover protocol/timeout/reset semantics; happy-path
 * suites spawn the REAL coordinator on isolated roots through the client's
 * ensure/spawn path (mirrors the state-coordinator integration fixture).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { test } from "node:test";
import { COORDINATOR_PROTOCOL_VERSION } from "../src/core/coordinator-protocol.mjs";
import { ensureCoordinator, sendStateCommand } from "../src/core/coordinator-client.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readState } from "../src/core/store.mjs";

const COORDINATOR_SCRIPT = fileURLToPath(new URL("../runner/state-coordinator.mjs", import.meta.url));

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-cclient-"));
}

/**
 * In-process fake coordinator socket. Answers `ping` → pong; `state_command`
 * handling is caller-configured per test (reply / silence / destroy).
 * @param {{ onStateCommand?: (cmd: object, socket: import("node:net").Socket, seen: object[]) => void, protocolVersion?: number }} [handlers]
 */
async function startFakeServer(handlers = {}) {
	const root = freshRoot();
	const socketPath = P.coordinatorEndpointPathFor(process.platform, root);
	const seen = [];
	const connections = { count: 0 };
	const server = createServer((socket) => {
		connections.count += 1;
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const msg = JSON.parse(line);
				if (msg.type === "ping") {
					socket.write(JSON.stringify({ type: "pong", instanceId: "fake-1", startedAt: 1, protocolVersion: handlers.protocolVersion ?? COORDINATOR_PROTOCOL_VERSION }) + "\n");
					return;
				}
				seen.push(msg);
				handlers.onStateCommand?.(msg, socket, seen);
			}
		});
	});
	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(socketPath, () => resolveListen());
	});
	return {
		root,
		socketPath,
		seen,
		connections,
		close: () => new Promise((r) => server.close(() => r())),
	};
}

/** Fake server hook: echo a fixed state_command_result back. */
function replyWith(result) {
	return (cmd, socket) => {
		socket.write(JSON.stringify({ type: "state_command_result", commandId: cmd.commandId, ...result }) + "\n");
	};
}

function markCompleted(overrides = {}) {
	return {
		type: "state_command",
		kind: "mark_completed",
		viewId: "v1",
		runId: null,
		source: "dashboard-user",
		expectedRevision: null,
		payload: {},
		...overrides,
	};
}

test("sendStateCommand sends a state_command envelope and resolves the applied result", async (t) => {
	const fake = await startFakeServer({
		onStateCommand: replyWith({ status: "applied", reason: "manual_completion", materializedRevision: 3 }),
	});
	t.after(() => fake.close());

	const result = await sendStateCommand(fake.root, markCompleted(), { timeoutMs: 1500 });

	assert.deepEqual(result, { status: "applied", reason: "manual_completion", materializedRevision: 3 });
	assert.equal(fake.seen.length, 1);
	const envelope = fake.seen[0];
	assert.equal(envelope.type, "state_command");
	assert.equal(envelope.kind, "mark_completed");
	assert.equal(envelope.viewId, "v1");
	assert.equal(envelope.source, "dashboard-user");
	assert.match(envelope.commandId, /^[a-z]+_[0-9a-f]+$/);
});

test("caller-supplied commandId is preserved; otherwise a fresh id is generated per call", async (t) => {
	const fake = await startFakeServer({
		onStateCommand: replyWith({ status: "rejected", reason: "no_change", materializedRevision: 1 }),
	});
	t.after(() => fake.close());

	const first = await sendStateCommand(fake.root, markCompleted({ commandId: "cmd-fixed" }), { timeoutMs: 1500 });
	const second = await sendStateCommand(fake.root, markCompleted(), { timeoutMs: 1500 });

	assert.equal(fake.seen[0].commandId, "cmd-fixed");
	assert.notEqual(fake.seen[1].commandId, "cmd-fixed");
	assert.match(fake.seen[1].commandId, /^[a-z]+_[0-9a-f]+$/);
	assert.deepEqual(first, { status: "rejected", reason: "no_change", materializedRevision: 1 });
	assert.equal(second.status, "rejected");
});

test("timeout resolves rejected/timeout — ambiguous, no auto-retry", async (t) => {
	const fake = await startFakeServer({
		onStateCommand: () => { /* never answers */ },
	});
	t.after(() => fake.close());

	const result = await sendStateCommand(fake.root, markCompleted(), { timeoutMs: 150 });

	assert.deepEqual(result, { status: "rejected", reason: "timeout", materializedRevision: 0 });
	// Exactly one envelope was sent: the client never silently retries.
	assert.equal(fake.seen.length, 1);
});

test("connection reset mid-command resolves rejected/connection_reset — ambiguous, no auto-retry", async (t) => {
	const fake = await startFakeServer({
		onStateCommand: (cmd, socket) => {
			socket.destroy(); // crash-window simulation: no reply at all
		},
	});
	t.after(() => fake.close());

	const result = await sendStateCommand(fake.root, markCompleted(), { timeoutMs: 1500 });

	assert.deepEqual(result, { status: "rejected", reason: "connection_reset", materializedRevision: 0 });
	assert.equal(fake.seen.length, 1); // exactly one attempt, no silent retry
});

test("AGENT_BOARD_COORDINATOR=off short-circuits with coordinator_disabled and never connects", async (t) => {
	const fake = await startFakeServer({});
	t.after(() => fake.close());
	process.env.AGENT_BOARD_COORDINATOR = "off";
	try {
		const result = await sendStateCommand(fake.root, markCompleted(), { timeoutMs: 300 });
		assert.deepEqual(result, { status: "rejected", reason: "coordinator_disabled", materializedRevision: 0 });
		assert.equal(fake.connections.count, 0);
	} finally {
		delete process.env.AGENT_BOARD_COORDINATOR;
	}
});

test("ensureCoordinator spawns the real coordinator; sendStateCommand happy path is applied", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});

	createView(root, { id: "v1", name: "client-e2e", cwd: root });

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true);
	assert.match(ensured.instanceId, /^[0-9a-f]+$/);
	assert.ok(ensured.pid, "spawning ensure reports the child pid for cleanup");
	track(ensured.pid);

	const result = await sendStateCommand(root, markCompleted(), { timeoutMs: 5000 });
	assert.equal(result.status, "applied");
	assert.ok(result.materializedRevision >= 1);

	const state = readState(root, "v1");
	assert.equal(state.semanticState, "completed");
	assert.equal(state.autoState, null);
	assert.ok(state.materializedRevision >= 1);
});

test("two parallel ensureCoordinator calls converge on one owner; both clients get pongs", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});

	const [a, b] = await Promise.all([
		ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT }),
		ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT }),
	]);
	assert.equal(a.ok, true);
	assert.equal(b.ok, true);
	assert.equal(a.instanceId, b.instanceId); // one lease owner serves both
	if (a.pid) track(a.pid);
	if (b.pid) track(b.pid);
});

// --- protocol version gate (issue #108) ---

/**
 * One raw ping round-trip against any JSONL socket. Resolves the parsed pong
 * message, or null on timeout/error.
 * @param {string} socketPath
 * @param {number} [timeoutMs]
 * @returns {Promise<object|null>}
 */
function rawPing(socketPath, timeoutMs = 1000) {
	return new Promise((resolve) => {
		let settled = false;
		let buffer = "";
		/** @type {import("node:net").Socket|null} */
		let socket = null;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { socket?.destroy(); } catch { /* best effort */ }
			resolve(value);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref?.();
		try { socket = createConnection(socketPath); } catch { return finish(null); }
		socket.on("error", () => finish(null));
		socket.on("connect", () => {
			try { socket?.write(JSON.stringify({ type: "ping" }) + "\n"); } catch { finish(null); }
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg?.type === "pong") finish(msg);
				} catch { /* malformed line — keep waiting */ }
			}
		});
	});
}

/** Inline CJS body for the stale pre-#107 coordinator fixture. Binds the
 *  socket, answers pings with a pong that has NO protocolVersion field (the
 *  v1 wire format), publishes a coordinator lease owner.json like the real
 *  process, and on SIGTERM unlinks the socket + releases the lease. */
const STALE_COORDINATOR_CJS = `
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const socketPath = process.argv[2];
const lockDir = process.argv[3];
fs.mkdirSync(lockDir, { recursive: true });
fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ token: "stale", pid: process.pid, identity: { pid: process.pid, startToken: "1" }, startedAt: 1 }));
const server = net.createServer((socket) => {
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		const lines = buffer.split("\\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const msg = JSON.parse(line);
			if (msg.type === "ping") socket.write(JSON.stringify({ type: "pong", instanceId: "stale-v1", startedAt: 1 }) + "\\n");
		}
	});
});
process.on("SIGTERM", () => {
	try { server.close(); } catch {}
	try { fs.unlinkSync(socketPath); } catch {}
	try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
	process.exit(0);
});
server.listen(socketPath);
`;

/**
 * Spawn a fake "old-build" coordinator as a REAL child process so the client's
 * SIGTERM-via-lease-pid replacement path can be exercised end to end.
 */
async function spawnStaleV1Coordinator(root) {
	const socketPath = P.coordinatorEndpointPathFor(process.platform, root);
	const lockDir = P.viewLockPath(root, "_coordinator", "state-coordinator");
	const scriptPath = join(root, "stale-coordinator.cjs");
	writeFileSync(scriptPath, STALE_COORDINATOR_CJS);
	const child = spawn(process.execPath, [scriptPath, socketPath, lockDir], { stdio: "ignore" });
	const deadline = Date.now() + 3000;
	for (;;) {
		const pong = await rawPing(socketPath, 300);
		if (pong) break;
		if (Date.now() >= deadline) throw new Error("stale coordinator fixture failed to bind");
		await new Promise((r) => setTimeout(r, 50));
	}
	return {
		child,
		socketPath,
		alive() {
			try { process.kill(child.pid, 0); return true; } catch { return false; }
		},
		cleanup: () => {
			try { child.kill("SIGTERM"); } catch { /* already gone */ }
		},
	};
}

test("coordinator pong carries the current protocol version", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true);
	if (ensured.pid) track(ensured.pid);

	const pong = await rawPing(P.coordinatorEndpointPathFor(process.platform, root));
	assert.ok(pong, "coordinator answers ping");
	assert.equal(pong.protocolVersion, COORDINATOR_PROTOCOL_VERSION);
});

test("ensureCoordinator replaces a stale pre-protocol coordinator via its lease pid", async (t) => {
	const root = freshRoot();
	t.after(async () => {
		await cleanupRoot(root);
	});
	const stale = await spawnStaleV1Coordinator(root);
	t.after(() => stale.cleanup());
	createView(root, { id: "v1", name: "stale-replace", cwd: root });

	// sanity: the stale instance answers the v1 wire format (no version field)
	const stalePong = await rawPing(stale.socketPath);
	assert.equal(stalePong?.instanceId, "stale-v1");
	assert.equal(stalePong?.protocolVersion, undefined);

	const ensured = await ensureCoordinator(root, { runnerScript: COORDINATOR_SCRIPT });
	assert.equal(ensured.ok, true);
	assert.notEqual(ensured.instanceId, "stale-v1"); // a FRESH instance owns the lease now
	if (ensured.pid) track(ensured.pid);
	assert.equal(stale.alive(), false, "stale instance was terminated");

	const result = await sendStateCommand(root, markCompleted(), { timeoutMs: 5000 });
	assert.equal(result.status, "applied");
});

test("ensureCoordinator reports coordinator_stale_protocol instead of trusting an irreplaceable stale instance", async (t) => {
	const fake = await startFakeServer({ protocolVersion: 1 }); // in-process fake: no lease pid to SIGTERM
	t.after(() => fake.close());

	const ensured = await ensureCoordinator(fake.root, { runnerScript: COORDINATOR_SCRIPT });
	assert.deepEqual(ensured, { ok: false, error: "coordinator_stale_protocol" });
});

// --- fixture helpers (mirrors state-coordinator.integration.test.mjs) ---

/** Pids of coordinators spawned by this test file, for the cleanup ladder. */
const spawnedPids = new Set();

/** @param {number|null|undefined} pid */
function track(pid) {
	if (pid) spawnedPids.add(pid);
}

async function cleanupRoot(root) {
	for (const pid of spawnedPids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone (e.g. the lease loser exiting) — nothing to clean
		}
	}
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline && spawnedPids.size > 0) {
		for (const pid of [...spawnedPids]) {
			try {
				process.kill(pid, 0);
			} catch {
				spawnedPids.delete(pid);
			}
		}
		if (spawnedPids.size > 0) await new Promise((r) => setTimeout(r, 50));
	}
	for (const pid of spawnedPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone already — fine
		}
	}
	spawnedPids.clear();
	rmSync(root, { recursive: true, force: true });
}
