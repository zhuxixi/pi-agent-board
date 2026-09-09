/**
 * Integration tests for the detached View State Coordinator (issue #91, spec D3,
 * plan Task 4). Spawns the real runner process against an isolated store root and
 * talks JSONL over its socket, mirroring the pty-runner integration fixture style.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { readJournal } from "../src/core/coordinator-journal.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readState, writeState } from "../src/core/store.mjs";

const COORDINATOR_SCRIPT = fileURLToPath(new URL("../runner/state-coordinator.mjs", import.meta.url));

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-coord-"));
}

async function waitFor(predicate, timeoutMs = 5000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out waiting");
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForExit(child, timeoutMs = 3000) {
	if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
	const result = await Promise.race([
		once(child, "exit").then(([code]) => code),
		new Promise((r) => setTimeout(() => r(null), timeoutMs)),
	]);
	return result;
}

/** Spawn a coordinator on its own store root. Env pins the isolation vars even
 *  though the runner takes an explicit root argument (paths.mjs defaultRoot
 *  pitfall: it follows neither PI_CODING_AGENT_DIR nor argv without both). */
function startCoordinator(root) {
	const child = spawn(process.execPath, [COORDINATOR_SCRIPT, root], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, AGENT_BOARD_ROOT: root, PI_CODING_AGENT_DIR: root },
	});
	child.stdout.resume();
	child.stderr.resume();
	return child;
}

/** Poll real connect attempts — the socket only exists once boot replay finished. */
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
	throw new Error("timed out waiting for coordinator socket");
}

/** JSONL client: ordered message queue + one-waiter `next()`. */
function makeClient(socket) {
	const queue = [];
	const waiters = [];
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const msg = JSON.parse(line);
			const waiter = waiters.shift();
			if (waiter) waiter(msg);
			else queue.push(msg);
		}
	});
	return {
		send: (obj) => socket.write(JSON.stringify(obj) + "\n"),
		next: (timeoutMs = 3000) => {
			if (queue.length) return Promise.resolve(queue.shift());
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timed out waiting for coordinator message")), timeoutMs);
				waiters.push((msg) => {
					clearTimeout(timer);
					resolve(msg);
				});
			});
		},
	};
}

async function readyClient(root) {
	const socket = await connectWhenReady(P.coordinatorEndpointPathFor(process.platform, root));
	const client = makeClient(socket);
	client.send({ type: "ping" });
	const pong = await client.next();
	assert.equal(pong.type, "pong");
	return { socket, client, instanceId: pong.instanceId };
}

function classification(at = Date.now()) {
	return {
		version: 1,
		kind: "done",
		semanticState: "completed",
		confidence: "high",
		source: "model",
		reason: "assistant reported completion",
		question: null,
		classifiedAt: at,
		lastAgentActivityAt: null,
		textHash: "hash-1",
	};
}

test("coordinator applies mark_completed and materializes state with revision", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	const { client } = await readyClient(root);

	const command = {
		type: "state_command",
		commandId: "cmd-apply-1",
		viewId: "v1",
		source: "dashboard-user",
		kind: "mark_completed",
		expectedRevision: null,
		payload: {},
	};
	client.send(command);
	const result = await client.next();
	assert.equal(result.type, "state_command_result");
	assert.equal(result.commandId, "cmd-apply-1");
	assert.equal(result.status, "applied");
	assert.equal(result.reason, "manual_completion");
	assert.ok(result.materializedRevision >= 1, "revision stamped");

	const state = readState(root, "v1");
	assert.equal(state.semanticState, "completed");
	assert.equal(state.materializedRevision, result.materializedRevision);
});

test("duplicate commandId returns the original result without re-applying", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	const { client } = await readyClient(root);

	const command = {
		type: "state_command",
		commandId: "cmd-dup-1",
		viewId: "v1",
		source: "dashboard-user",
		kind: "mark_completed",
		payload: {},
	};
	client.send(command);
	const first = await client.next();
	assert.equal(first.status, "applied");

	client.send({ ...command });
	const second = await client.next();
	assert.deepEqual(
		{ status: second.status, reason: second.reason, materializedRevision: second.materializedRevision },
		{ status: first.status, reason: first.reason, materializedRevision: first.materializedRevision },
	);
	assert.equal(readJournal(root).length, 1, "duplicate must not append a second journal record");
});

test("stale auto_state_classified after manual completion is rejected", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	const { client } = await readyClient(root);

	client.send({
		type: "state_command",
		commandId: "cmd-manual-1",
		viewId: "v1",
		source: "dashboard-user",
		kind: "mark_completed",
		payload: {},
	});
	const applied = await client.next();
	assert.equal(applied.status, "applied");

	client.send({
		type: "state_command",
		commandId: "cmd-late-classify-1",
		viewId: "v1",
		runId: null,
		source: "state-runner",
		kind: "auto_state_classified",
		payload: { classification: classification() },
	});
	const rejected = await client.next();
	assert.equal(rejected.type, "state_command_result");
	assert.equal(rejected.status, "rejected");
	assert.equal(rejected.reason, "manual_fence");

	const state = readState(root, "v1");
	assert.equal(state.semanticState, "completed", "manual completion survives the late classification");
	assert.equal(state.autoState, null, "fence signal (autoState null) intact");
});

test("coordinator restart replays journal and stays idempotent", async (t) => {
	const root = freshRoot();
	let child = startCoordinator(root);
	const rootCleanup = async () => {
		if (child && isAlive(child.pid)) {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
		rmSync(root, { recursive: true, force: true });
	};
	t.after(rootCleanup);
	createView(root, { id: "v1", name: "x", cwd: root });

	let { client } = await readyClient(root);
	const command = {
		type: "state_command",
		commandId: "cmd-restart-1",
		viewId: "v1",
		source: "dashboard-user",
		kind: "mark_completed",
		payload: {},
	};
	client.send(command);
	const original = await client.next();
	assert.equal(original.status, "applied");
	client.socket?.destroy?.();
	await child.kill("SIGTERM");
	await waitForExit(child);

	child = startCoordinator(root);
	;({ client } = await readyClient(root));
	client.send({ ...command });
	const replayed = await client.next();
	assert.deepEqual(
		{ status: replayed.status, reason: replayed.reason, materializedRevision: replayed.materializedRevision },
		{ status: original.status, reason: original.reason, materializedRevision: original.materializedRevision },
	);
	assert.equal(readJournal(root).length, 1, "restart must not duplicate journal records");
	assert.equal(readState(root, "v1").materializedRevision, original.materializedRevision);
});

test("boot replay repairs a journal record whose materialization was lost", async (t) => {
	const root = freshRoot();
	let child = startCoordinator(root);
	t.after(async () => {
		if (child && isAlive(child.pid)) {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });

	const { client } = await readyClient(root);
	client.send({
		type: "state_command",
		commandId: "cmd-crash-1",
		viewId: "v1",
		source: "dashboard-user",
		kind: "mark_completed",
		payload: {},
	});
	const applied = await client.next();
	assert.equal(applied.status, "applied");

	// Simulate the crash window: journal fsynced but the revision stamp never landed.
	const state = readState(root, "v1");
	delete state.materializedRevision;
	writeState(root, state);
	child.kill("SIGTERM");
	await waitForExit(child);

	child = startCoordinator(root);
	await readyClient(root);
	const repaired = readState(root, "v1");
	assert.equal(repaired.materializedRevision, applied.materializedRevision, "replay restores the recorded revision");
	assert.equal(repaired.semanticState, "completed");
});

test("second coordinator instance exits immediately (lease held)", async (t) => {
	const root = freshRoot();
	let first = null;
	let second = null;
	t.after(async () => {
		for (const c of [first, second]) {
			if (c && isAlive(c.pid)) {
				c.kill("SIGTERM");
				await waitForExit(c);
			}
		}
		rmSync(root, { recursive: true, force: true });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	first = startCoordinator(root);
	await readyClient(root);

	second = startCoordinator(root);
	const exitCode = await waitForExit(second, 2000);
	assert.notEqual(exitCode, null, "second instance exited within 2s");
	assert.equal(readState(root, "v1").semanticState, "queued", "second instance left state untouched");
});
