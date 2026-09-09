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
import { launchAutoState } from "../src/core/launch.mjs";
import { writeEvidence } from "../src/core/evidence.mjs";
import * as P from "../src/core/paths.mjs";
import { createView, readState, readStatus, writeState, writeStatus } from "../src/core/store.mjs";

const COORDINATOR_SCRIPT = fileURLToPath(new URL("../runner/state-coordinator.mjs", import.meta.url));
const STATE_RUNNER_SCRIPT = fileURLToPath(new URL("../runner/state-runner.mjs", import.meta.url));

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

test("boot replay repairs the status half of a half-materialized write pair without regressing state", async (t) => {
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
	// Seed a live run r1: state.currentRunId points at it, status.json exists.
	writeState(root, { ...readState(root, "v1"), currentRunId: "r1", semanticState: "working", processState: "alive" });
	const preFinalizeStatus = {
		version: 1,
		runId: "r1",
		viewId: "v1",
		pid: null,
		startedAt: 1,
		endedAt: null,
		exitCode: null,
		kind: "dispatch",
		prompt: "p",
		model: null,
		semanticState: "working",
		processState: "alive",
		summary: "Working",
		lastActivityAt: 1,
		currentTool: null,
		latestAssistantPreview: "partial answer",
		question: null,
		pendingQuestions: [],
		error: null,
		lastAgentActivityAt: null,
		stopReason: null,
		stoppedByUser: false,
		turns: 0,
		toolCount: 0,
		eventCount: 0,
		lastEventAt: null,
		usage: null,
		stallReason: null,
		evidenceSummary: null,
		autoState: null,
	};
	writeStatus(root, preFinalizeStatus);

	const { client } = await readyClient(root);
	client.send({
		type: "state_command",
		commandId: "cmd-crash-status-1",
		viewId: "v1",
		runId: "r1",
		source: "job-runner",
		kind: "run_finalized",
		payload: { exitCode: 0, endedAt: 123 },
	});
	const applied = await client.next();
	assert.equal(applied.status, "applied");

	// Decision-time status binding must be recorded in the journal (not re-derived
	// from whatever currentRunId is on disk at replay time).
	const record = readJournal(root).find((r) => r?.command?.commandId === "cmd-crash-status-1");
	assert.ok(record, "journal record exists");
	assert.equal(record.statusRunId, "r1", "decision-time status binding recorded");

	// Crash window: writeState landed, writeStatus did not. Rewind ONLY status.json
	// to its pre-finalize content (no patch, no stamp); state.json keeps the stamp.
	const stateAtCrash = readState(root, "v1");
	assert.equal(stateAtCrash.materializedRevision, applied.materializedRevision);
	writeStatus(root, preFinalizeStatus);
	child.kill("SIGKILL");
	await waitForExit(child);

	child = startCoordinator(root);
	await readyClient(root);

	const repairedStatus = readStatus(root, "v1", "r1");
	assert.equal(repairedStatus.processState, "exited", "status patch replayed into the bound run's status file");
	assert.equal(repairedStatus.materializedRevision, applied.materializedRevision, "status stamped to the record revision");
	const stateAfterReplay = readState(root, "v1");
	assert.equal(stateAfterReplay.materializedRevision, applied.materializedRevision, "state revision not moved backwards by replay");
	assert.equal(stateAfterReplay.semanticState, stateAtCrash.semanticState, "state content untouched by the status-half repair");
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

 test("A8: manual completion fences a late model classification (end-to-end)", async (t) => {
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
	// Exited run the late classification would target; autoState pre-set so the
	// manual completion's clearing behavior is observable.
	writeStatus(root, {
		version: 1, viewId: "v1", runId: "r1", semanticState: "idle", processState: "exited",
		autoState: classification(), needsInput: false, hasError: false, error: null,
	});
	const st = readState(root, "v1");
	st.currentRunId = "r1";
	writeState(root, st);
	child = startCoordinator(root);
	const { client } = await readyClient(root);

	// 1. Dashboard path: the user marks the row done manually.
	client.send({
		type: "state_command", commandId: "a8-manual-1", viewId: "v1", runId: "r1",
		source: "dashboard-user", kind: "mark_completed", expectedRevision: null, payload: {},
	});
	const manual = await client.next();
	assert.equal(manual.status, "applied");
	assert.equal(readState(root, "v1").autoState, null, "manual completion cleared autoState");

	// 2. Late state-runner classification arrives after the manual verdict.
	client.send({
		type: "state_command", commandId: "a8-late-1", viewId: "v1", runId: "r1",
		source: "state-runner", kind: "auto_state_classified", expectedRevision: null,
		payload: { classification: classification() },
	});
	const late = await client.next();
	assert.equal(late.status, "rejected", "late classification is rejected");
	assert.equal(late.reason, "manual_fence");

	const fenced = readState(root, "v1");
	assert.equal(fenced.semanticState, "completed", "manual verdict survives");
	assert.equal(fenced.autoState, null, "classification did not land");
	assert.equal(readStatus(root, "v1", "r1").autoState, null, "status fence holds too");

	// 3. Coordinator restart: the journal replay must keep the fence. Both a
	// replayed identical command (dedup) and a fresh late command (re-decided
	// against the materialized state) stay rejected.
	child.kill("SIGTERM");
	await waitForExit(child);
	child = startCoordinator(root);
	const { client: client2 } = await readyClient(root);

	client2.send({
		type: "state_command", commandId: "a8-late-1", viewId: "v1", runId: "r1",
		source: "state-runner", kind: "auto_state_classified", expectedRevision: null,
		payload: { classification: classification() },
	});
	const replayed = await client2.next();
	assert.equal(replayed.status, "rejected", "replayed command returns the original result");
	assert.equal(replayed.reason, "manual_fence");

	client2.send({
		type: "state_command", commandId: "a8-late-2", viewId: "v1", runId: "r1",
		source: "state-runner", kind: "auto_state_classified", expectedRevision: null,
		payload: { classification: classification() },
	});
	const fresh = await client2.next();
	assert.equal(fresh.status, "rejected", "fresh late command re-decided against materialized state");
	assert.equal(fresh.reason, "manual_fence");

	assert.equal(readState(root, "v1").semanticState, "completed");
	assert.equal(readState(root, "v1").autoState, null);
});

test("state-runner routes classification through the coordinator (journal record, no direct semantic write)", async (t) => {
	const root = freshRoot();
	let child = null;
	let runnerPid = null;
	t.after(async () => {
		if (runnerPid && isAlive(runnerPid)) {
			try { process.kill(runnerPid, "SIGKILL"); } catch { /* already gone */ }
		}
		if (child && isAlive(child.pid)) {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
		delete process.env.AGENT_BOARD_AUTO_STATE_MODEL;
		delete process.env.AGENT_BOARD_AUTO_STATE_NO_DONE;
		rmSync(root, { recursive: true, force: true });
	});
	process.env.AGENT_BOARD_AUTO_STATE_MODEL = "off"; // heuristic path: no model call
	process.env.AGENT_BOARD_AUTO_STATE_NO_DONE = "0"; // enable auto-done so the fixture classifies "done"
	createView(root, { id: "v1", name: "x", cwd: root });
	writeStatus(root, { version: 1, viewId: "v1", runId: "run_1", semanticState: "idle", processState: "exited" });
	const st = readState(root, "v1");
	st.currentRunId = "run_1";
	writeState(root, st);
	writeEvidence(root, { viewId: "v1", runId: "run_1", assistantEvidence: [{ text: "All done, tests pass.", at: Date.now() }] });

	// Tracked coordinator BEFORE the runner starts: the client's probe must find
	// this one (a lazily spawned detached twin would leak past the rmSync).
	child = startCoordinator(root);
	await readyClient(root);

	const launched = launchAutoState(root, {
		root, viewId: "v1", runId: "run_1", cwd: root,
		piCommand: process.execPath, piArgsPrefix: [],
	}, { runnerScript: STATE_RUNNER_SCRIPT });
	runnerPid = launched.pid;
	assert.ok(runnerPid, "state-runner spawned");
	await waitFor(() => (isAlive(runnerPid) ? null : true), 10000);

	const record = readJournal(root).find(
		(r) => r?.command?.kind === "auto_state_classified" && r?.command?.source === "state-runner",
	);
	assert.ok(record, "classification journaled as a coordinator command");
	assert.equal(record.result?.status, "applied");
	assert.ok(record.materializedRevision >= 1, "revision stamped");

	const state = readState(root, "v1");
	assert.equal(state.autoState?.kind, "done", "classification materialized by the coordinator");
	assert.equal(state.materializedRevision, record.materializedRevision, "state carries the journal revision");
	const status = readStatus(root, "v1", "run_1");
	assert.equal(status.autoState?.kind, "done", "status patch materialized too");
	assert.equal(status.materializedRevision, record.materializedRevision, "shared revision across both files");
});
