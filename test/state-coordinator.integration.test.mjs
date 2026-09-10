/**
 * Integration tests for the detached View State Coordinator (issue #91, spec D3,
 * plan Task 4). Spawns the real runner process against an isolated store root and
 * talks JSONL over its socket, mirroring the pty-runner integration fixture style.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, appendFileSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { gcJournal, journalPath, readJournal, writeCheckpoint } from "../src/core/coordinator-journal.mjs";
import { launchAutoState } from "../src/core/launch.mjs";
import { writeEvidence } from "../src/core/evidence.mjs";
import * as P from "../src/core/paths.mjs";
import { createRunStatus } from "../src/core/events.mjs";
import { createView, readState, readStatus, writeState, writeStatus } from "../src/core/store.mjs";
import { sendStateCommand } from "../src/core/coordinator-client.mjs";

const COORDINATOR_SCRIPT = fileURLToPath(new URL("../runner/state-coordinator.mjs", import.meta.url));
const STATE_RUNNER_SCRIPT = fileURLToPath(new URL("../runner/state-runner.mjs", import.meta.url));

/** Exited idle row with a run-tracked id and a NON-manual autoState (the
 *  manual fence signal is autoState: null + completed). Fixed lastActivityAt
 *  so stamp assertions can discriminate. */
function legacyRowState(viewId) {
	return {
		version: 1,
		viewId,
		currentRunId: null,
		semanticState: "idle",
		processState: "exited",
		summary: "Idle",
		lastActivityAt: 1000,
		updatedAt: 1000,
		needsInput: false,
		hasError: false,
		latestAssistantPreview: "",
		latestTool: null,
		question: null,
		pendingQuestions: [],
		error: null,
		autoState: { source: "heuristic" },
		materializedRevision: 1,
	};
}

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

test("legacy view without materializedRevision gets revision 1 on first coordinator touch", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
		rmSync(root, { recursive: true, force: true });
	});
	// createView rows carry no materializedRevision — the legacy precondition.
	createView(root, { id: "v1", name: "x", cwd: root });
	assert.equal(readState(root, "v1").materializedRevision, undefined);
	child = startCoordinator(root);
	const { client } = await readyClient(root);

	client.send({
		type: "state_command",
		commandId: "cmd-legacy-1",
		viewId: "v1",
		source: "dashboard-user",
		kind: "mark_completed",
		expectedRevision: null,
		payload: {},
	});
	const result = await client.next();
	assert.equal(result.type, "state_command_result");
	assert.equal(result.status, "applied");
	// Legacy adoption stamps as part of the first applied command's single
	// materialization write: exactly 1, not 2 (no separate adoption write).
	assert.equal(result.materializedRevision, 1);
	assert.equal(readState(root, "v1").materializedRevision, 1);
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
	const status = readStatus(root, "v1", "run_1");
	assert.equal(status.autoState?.kind, "done", "status patch materialized too");

	// PR #2 (Task 4): the evidence mirrors move behind the coordinator too — a
	// follow-up patch_fields record carries review/evidenceSummary with its own
	// (higher) revision and materializes both files under one shared revision.
	const patchRecord = readJournal(root).find(
		(r) => r?.command?.kind === "patch_fields" && r?.command?.source === "state-runner",
	);
	assert.ok(patchRecord, "evidence mirrors journaled as a patch_fields command");
	assert.equal(patchRecord.result?.status, "applied");
	assert.ok(patchRecord.materializedRevision > record.materializedRevision, "patch bumps the revision past the classification");
	assert.ok(patchRecord.mutate?.state?.review != null, "patch carries the review mirror");
	assert.ok(patchRecord.mutate?.status?.evidenceSummary != null, "patch carries the evidenceSummary mirror");

	const finalState = readState(root, "v1");
	assert.deepEqual(finalState.review, patchRecord.mutate.state.review, "review mirror materialized from the journal patch");
	assert.equal(finalState.materializedRevision, patchRecord.materializedRevision, "state carries the patch revision");
	const finalStatus = readStatus(root, "v1", "run_1");
	assert.deepEqual(finalStatus.evidenceSummary, patchRecord.mutate.status.evidenceSummary, "evidenceSummary mirror materialized from the journal patch");
	assert.equal(finalStatus.materializedRevision, patchRecord.materializedRevision, "shared revision across both files");
});

test("duplicate commandId still returns the original result after a checkpoint+GC cycle", async (t) => {
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
		commandId: "cmd-gc-1",
		viewId: "v1",
		source: "dashboard-user",
		kind: "mark_completed",
		expectedRevision: null,
		payload: {},
	};
	client.send(command);
	const first = await client.next();
	assert.equal(first.status, "applied");

	// Simulate the checkpoint+GC cycle the coordinator runs at the size
	// threshold: checkpoint the full journal, then reclaim it. The journal
	// empties; dedupe for covered commandIds is the coordinator's in-memory
	// ring's job (the accepted post-GC tradeoff).
	const journalSize = statSync(journalPath(root)).size;
	assert.equal(writeCheckpoint(root, { materializedRevision: first.materializedRevision, journalBytes: journalSize }), true);
	assert.equal(gcJournal(root), 0);
	assert.deepEqual(readJournal(root), []);

	// The resent duplicate must short-circuit on the ring: original result,
	// no re-append (journal stays empty), no second materialization.
	client.send(command);
	const second = await client.next();
	assert.equal(second.status, "applied");
	assert.equal(second.reason, first.reason);
	assert.equal(second.materializedRevision, first.materializedRevision);
	assert.deepEqual(readJournal(root), []);

	const state = readState(root, "v1");
	assert.equal(state.semanticState, "completed");
	assert.equal(state.materializedRevision, first.materializedRevision);
});

test("boot repairs a torn journal tail before the first append", async (t) => {
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
	// Pre-crash journal: one complete record + a torn mid-JSON line (no \n).
	const torn = '{"command":{"commandId":"cmd-torn-0","kind":"run_fina","resu';
	appendFileSync(journalPath(root), `${JSON.stringify({
		command: { type: "state_command", commandId: "cmd-old", viewId: "v1", source: "dashboard-user", kind: "mark_completed", expectedRevision: null, payload: {} },
		result: { status: "applied", reason: "manual_completion" },
		materializedRevision: 1,
		at: 1,
	})}\n`);
	appendFileSync(journalPath(root), torn);
	assert.ok(statSync(journalPath(root)).size > JSON.stringify({}).length);

	child = startCoordinator(root);
	const { client } = await readyClient(root);
	client.send({
		type: "state_command",
		commandId: "cmd-torn-1",
		viewId: "v1",
		source: "dashboard-user",
		kind: "mark_completed",
		expectedRevision: null,
		payload: {},
	});
	const result = await client.next();
	assert.equal(result.status, "applied");

	// The post-restart append must be a parseable, discoverable record —
	// without the boot repair it would merge into the torn line and vanish
	// from every readJournal/replay scan.
	const ids = readJournal(root).map((entry) => entry?.command?.commandId);
	assert.ok(ids.includes("cmd-torn-1"), "new record visible after boot repair");
	assert.ok(!ids.includes("cmd-torn-0"), "torn record dropped by repair");
	const state = readState(root, "v1");
	assert.equal(state.semanticState, "completed");
});

// -- Task 2: transient run_progress, new lifecycle kinds, F1/F2 shell contracts --

/** Seed a live run r1 through the coordinator itself (also covers mark_queued +
 *  run_started + the F5 lastActivityAt stamp + status bootstrap). */
async function seedLiveRun(client, root) {
	const beforeMarkQueued = Date.now();
	client.send({ type: "state_command", commandId: "seed-mq-1", viewId: "v1", source: "service", kind: "mark_queued", payload: { runId: "r1" } });
	const mq = await client.next();
	assert.equal(mq.status, "applied");
	const mqState = readState(root, "v1");
	assert.equal(mqState.semanticState, "queued");
	assert.equal(mqState.currentRunId, "r1");
	assert.ok(mqState.lastActivityAt >= beforeMarkQueued, "mark_queued stamps lastActivityAt (F5 legacy parity)");

	// The run is working when run_started fires — seed the status accordingly
	// so the first run_progress beat projects a consistent (working) row.
	const seedStatus = { ...createRunStatus({ runId: "r1", viewId: "v1", kind: "dispatch", prompt: "p" }, null, Date.now()), semanticState: "working" };
	client.send({
		type: "state_command", commandId: "seed-rs-1", viewId: "v1", runId: "r1", source: "job-runner",
		kind: "run_started",
		payload: { status: seedStatus },
	});
	const rs = await client.next();
	assert.equal(rs.status, "applied");
	const status = readStatus(root, "v1", "r1");
	assert.ok(status, "run_started bootstraps the run's status file");
	assert.equal(status.runId, "r1");
	assert.equal(status.processState, "alive");
	return { mqRevision: mq.materializedRevision, startedRevision: rs.materializedRevision };
}

// -- Task 5 (Phase-2b): F5b — mark_completed + host_run_failed stamp lastActivityAt --

/** Table of every kind in the coordinator's LAST_ACTIVITY_STAMP_KINDS, with a
 *  fixture state + command that applies cleanly. Mirrors the set in
 *  runner/state-coordinator.mjs (not importable — the module runs main() on
 *  import); keep the two lists in sync. */
const STAMP_KIND_CASES = [
	{ kind: "mark_queued", source: "service", command: { payload: { runId: "rq" } } },
	{ kind: "archive_view", source: "dashboard-user", command: { payload: {} } },
	{ kind: "adopt_session", source: "service", command: { payload: {} } },
	{ kind: "reconcile_finalize", source: "service", command: { runId: "rc", payload: { semanticState: "idle", summary: "reconciled" } }, stateOverrides: { processState: "alive", semanticState: "working", currentRunId: "rc" } },
	{ kind: "plan_ready", source: "job-runner", command: { runId: "rp", payload: { runId: "rp" } } },
	{ kind: "mark_completed", source: "dashboard-user", command: { payload: {} } },
	{ kind: "host_run_failed", source: "pty-runner", command: { payload: { error: "PTY host failed: boom" } } },
];

for (const { kind, source, command, stateOverrides } of STAMP_KIND_CASES) {
	test(`F5b: ${kind} stamps lastActivityAt on apply`, async (t) => {
		const root = freshRoot();
		let child = null;
		t.after(async () => {
			if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		});
		createView(root, { id: "v1", name: "x", cwd: root });
		writeState(root, { ...legacyRowState("v1"), ...(stateOverrides ?? {}) });
		child = startCoordinator(root);
		await waitFor(() => existsSync(P.coordinatorEndpointPathFor(process.platform, root)));
		const result = await sendStateCommand(root, {
			type: "state_command", viewId: "v1", source, kind, ...command,
		});
		assert.equal(result.status, "applied", `${kind} must apply against the fixture row`);
		const state = readState(root, "v1");
		assert.ok(state.lastActivityAt > 1000, `${kind} must stamp lastActivityAt (legacy parity: service.mjs completeView / pty-runner markRowFailed)`);
	});
}

test("F5b negative: patch_fields does not stamp lastActivityAt", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	writeState(root, legacyRowState("v1"));
	child = startCoordinator(root);
	await waitFor(() => existsSync(P.coordinatorEndpointPathFor(process.platform, root)));
	const result = await sendStateCommand(root, {
		type: "state_command", viewId: "v1", source: "service", kind: "patch_fields",
		payload: { state: { lastVisitedAt: 4242 } },
	});
	assert.equal(result.status, "applied");
	const state = readState(root, "v1");
	assert.equal(state.lastVisitedAt, 4242, "the whitelisted patch applies");
	assert.equal(state.lastActivityAt, 1000, "patch_fields must NOT stamp lastActivityAt");
});

test("final pairing invariant: state-only patches restamp the run's status revision (issue #91 P1)", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	await waitFor(() => existsSync(P.coordinatorEndpointPathFor(process.platform, root)));

	// Live run: mark_queued + run_started pair both files at the same revision.
	const mq = await sendStateCommand(root, {
		type: "state_command", viewId: "v1", runId: "r1", source: "service",
		kind: "mark_queued", expectedRevision: null, payload: { runId: "r1" },
	});
	assert.equal(mq.status, "applied");
	const seedStatus = { ...createRunStatus({ runId: "r1", viewId: "v1", kind: "dispatch", prompt: "p" }, null, Date.now()), semanticState: "working" };
	const rs = await sendStateCommand(root, {
		type: "state_command", viewId: "v1", runId: "r1", source: "job-runner",
		kind: "run_started", expectedRevision: null, payload: { status: seedStatus },
	});
	assert.equal(rs.status, "applied");
	assert.equal(readStatus(root, "v1", "r1")?.materializedRevision, rs.materializedRevision);

	// A healthy state-only patch (the markVisited shape): this used to leave
	// status at the older revision — a live-coordinator-produced desync that
	// permanently shielded the row from reconcile recovery (final review P1).
	const pv = await sendStateCommand(root, {
		type: "state_command", viewId: "v1", source: "service",
		kind: "patch_fields", expectedRevision: null, payload: { state: { lastVisitedAt: 4242 } },
	});
	assert.equal(pv.status, "applied");
	const state = readState(root, "v1");
	const status = readStatus(root, "v1", "r1");
	assert.equal(state.materializedRevision, pv.materializedRevision, "state carries the applied revision");
	assert.equal(status.materializedRevision, pv.materializedRevision, "the status half is restamped to the applied revision (pairing invariant)");
	assert.equal(state.lastVisitedAt, 4242, "the whitelisted state patch applies");
	assert.equal(status.lastVisitedAt, undefined, "restamp is metadata-only — no content change");

	// Replay heals a torn state-only pair through the same shared path: tear
	// the pair on disk (external/crash shape), restart the coordinator, and
	// the journaled patch_fields record re-materializes both halves.
	writeStatus(root, { ...status, materializedRevision: rs.materializedRevision });
	assert.notEqual(readStatus(root, "v1", "r1").materializedRevision, state.materializedRevision, "torn shape staged");
	if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
	child = startCoordinator(root);
	await waitFor(() => existsSync(P.coordinatorEndpointPathFor(process.platform, root)));
	await waitFor(() => readStatus(root, "v1", "r1")?.materializedRevision === state.materializedRevision, 5000);
	assert.equal(readState(root, "v1").materializedRevision, state.materializedRevision, "replay does not regress the state half");
	assert.equal(readState(root, "v1").lastVisitedAt, 4242, "replay re-applies the journaled state patch");
});

test("transient run_progress applies, stamps the revision, and never touches the journal", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	const { client } = await readyClient(root);
	const { startedRevision } = await seedLiveRun(client, root);

	const journalLinesBefore = readJournal(root).length;
	client.send({
		type: "state_command", commandId: "cmd-rp-1", viewId: "v1", runId: "r1", source: "job-runner",
		kind: "run_progress",
		payload: { statusPatch: { latestAssistantPreview: "beat-1", turns: 2, lastActivityAt: Date.now() } },
	});
	const progress = await client.next();
	assert.equal(progress.type, "state_command_result");
	assert.equal(progress.status, "applied");
	assert.equal(progress.materializedRevision, startedRevision + 1, "transient commands still bump the revision");
	assert.equal(readJournal(root).length, journalLinesBefore, "transient commands must not append journal records");

	const state = readState(root, "v1");
	assert.equal(state.materializedRevision, progress.materializedRevision);
	assert.equal(state.latestAssistantPreview, "beat-1");
	assert.equal(state.semanticState, "working");
	const status = readStatus(root, "v1", "r1");
	assert.equal(status.latestAssistantPreview, "beat-1");
	assert.equal(status.turns, 2);
});

test("run_progress after an applied run_finalized is rejected stale_run and mutates nothing (Task 3 review regression)", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	const { client } = await readyClient(root);
	await seedLiveRun(client, root);

	// Finalize the run (journaled, applied), then a late transient beat arrives
	// out of order — the liveness guard must drop it without touching disk.
	client.send({
		type: "state_command", commandId: "seed-rf-late", viewId: "v1", runId: "r1", source: "job-runner",
		kind: "run_finalized", payload: { exitCode: 0, endedAt: Date.now() },
	});
	assert.equal((await client.next()).status, "applied");

	const stateBefore = JSON.stringify(readState(root, "v1"));
	const statusBefore = JSON.stringify(readStatus(root, "v1", "r1"));
	const journalLinesBefore = readJournal(root).length;

	client.send({
		type: "state_command", commandId: "cmd-rp-late", viewId: "v1", runId: "r1", source: "job-runner",
		kind: "run_progress",
		payload: { statusPatch: { latestAssistantPreview: "late-beat", turns: 9 } },
	});
	const result = await client.next();
	assert.equal(result.type, "state_command_result");
	assert.equal(result.status, "rejected");
	assert.equal(result.reason, "stale_run");

	// The rejected beat mutates nothing and leaves no trace anywhere.
	assert.equal(JSON.stringify(readState(root, "v1")), stateBefore, "rejected progress beat must not mutate state.json");
	assert.equal(JSON.stringify(readStatus(root, "v1", "r1")), statusBefore, "rejected progress beat must not mutate status.json");
	assert.equal(readJournal(root).length, journalLinesBefore, "rejected transient command must not append journal records");
});

test("followup_started bootstraps the NEW run's status and never touches the parent's (F1)", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	const { client } = await readyClient(root);
	await seedLiveRun(client, root);

	// Finalize the parent run, then let a classification land (the real post-exit
	// sequence) so the row is not manual-completion-fenced for the follow-up.
	client.send({
		type: "state_command", commandId: "seed-rf-1", viewId: "v1", runId: "r1", source: "job-runner",
		kind: "run_finalized", payload: { exitCode: 0, endedAt: Date.now() },
	});
	assert.equal((await client.next()).status, "applied");
	client.send({
		type: "state_command", commandId: "seed-ac-1", viewId: "v1", runId: "r1", source: "state-runner",
		kind: "auto_state_classified", payload: { classification: classification(Date.now()) },
	});
	assert.equal((await client.next()).status, "applied");

	const parentBefore = JSON.stringify(readStatus(root, "v1", "r1"));
	const startedAt = Date.now();
	client.send({
		type: "state_command", commandId: "cmd-fu-1", viewId: "v1", source: "service",
		kind: "followup_started",
		payload: {
			newRunId: "r2",
			statusPatch: createRunStatus({ runId: "r2", viewId: "v1", kind: "reply", prompt: "go" }, null, startedAt),
		},
	});
	const result = await client.next();
	assert.equal(result.status, "applied");

	const newStatus = readStatus(root, "v1", "r2");
	assert.ok(newStatus, "the NEW run's status file is bootstrapped");
	assert.equal(newStatus.runId, "r2");
	assert.equal(newStatus.processState, "alive");
	assert.equal(JSON.stringify(readStatus(root, "v1", "r1")), parentBefore, "the parent run's status file must not be modified (F1)");

	const state = readState(root, "v1");
	assert.equal(state.currentRunId, "r2");
	assert.equal(state.processState, "alive");
});

test("run_progress from two concurrent clients is serialized without torn writes", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	const { client: first } = await readyClient(root);
	const { client: second } = await readyClient(root);
	await seedLiveRun(first, root);

	// Fire interleaved beats from both clients; commandIds omitted — transient
	// kinds have no idempotency semantics (shell must not dedupe on them).
	const sends = [];
	for (let i = 1; i <= 10; i++) {
		const client = i % 2 === 0 ? second : first;
		client.send({
			type: "state_command", viewId: "v1", runId: "r1", source: "job-runner",
			kind: "run_progress",
			payload: { statusPatch: { latestAssistantPreview: `beat-${i}`, turns: i, lastActivityAt: Date.now() + i } },
		});
		sends.push(client.next());
	}
	const results = await Promise.all(sends);
	assert.equal(results.length, 10);
	const revisions = results.map((r) => r.materializedRevision);
	assert.equal(new Set(revisions).size, 10, "every beat gets its own revision (serialized, none lost)");
	const sorted = revisions.slice().sort((a, b) => a - b);
	for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i], sorted[i - 1] + 1, "revisions are consecutive — none lost, none duplicated");

	const state = readState(root, "v1");
	const maxResult = results.reduce((a, b) => (b.materializedRevision > a.materializedRevision ? b : a));
	assert.equal(state.materializedRevision, maxResult.materializedRevision, "state.json carries the highest applied revision");
	const winner = results.find((r) => r.materializedRevision === maxResult.materializedRevision);
	assert.equal(state.latestAssistantPreview, `beat-${results.indexOf(winner) + 1}`, "last materialized beat wins, no torn merge");
	const status = readStatus(root, "v1", "r1");
	assert.equal(status.turns, Number(state.latestAssistantPreview.split("-")[1]), "status matches the same winning beat");
});

test("run_progress with no materialized status is rejected stale_run and not journaled (F2 split: sparse patches stay stale_run; qualified beats bootstrap — see hard-down test)", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	const { client } = await readyClient(root);

	// mark_queued only: state says a run is queued, but run_started never
	// bootstrapped a status file for it.
	client.send({ type: "state_command", commandId: "cmd-mq-only", viewId: "v1", source: "service", kind: "mark_queued", payload: { runId: "r1" } });
	assert.equal((await client.next()).status, "applied");
	const journalLinesBefore = readJournal(root).length;

	client.send({
		type: "state_command", viewId: "v1", runId: "r1", source: "job-runner",
		kind: "run_progress", payload: { statusPatch: { turns: 1 } },
	});
	const result = await client.next();
	assert.equal(result.status, "rejected");
	assert.equal(result.reason, "stale_run");
	// No-fabrication pin (Task 2 review P2-B): the rejected sparse beat must not
	// have created a status file as a side effect.
	assert.equal(readStatus(root, "v1", "r1"), null);
	assert.equal(readJournal(root).length, journalLinesBefore, "transient rejections are not journaled either");
});

test("hard-down window: a qualified beat bootstraps the missed run_started and the run converges (residual closure)", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	const { client } = await readyClient(root);

	// mark_queued only: the coordinator was down through the runner's boot
	// window, so run_started was never delivered — the row is alive with the
	// run pinned but no status file exists.
	client.send({ type: "state_command", commandId: "hd-mq-1", viewId: "v1", source: "service", kind: "mark_queued", payload: { runId: "r1" } });
	assert.equal((await client.next()).status, "applied");
	assert.equal(readStatus(root, "v1", "r1"), null, "precondition: no status file (run_started was lost)");
	const journalBeforeBeat = readJournal(root).length;

	// The runner is alive and still beats through the coordinator; its first
	// post-recovery beat carries the FULL in-memory status and bootstraps the
	// missed status file.
	const beatPatch = { ...createRunStatus({ runId: "r1", viewId: "v1", kind: "dispatch", prompt: "p" }, null, Date.now()), semanticState: "working" };
	client.send({
		type: "state_command", viewId: "v1", runId: "r1", source: "job-runner",
		kind: "run_progress", payload: { statusPatch: beatPatch },
	});
	const beat = await client.next();
	assert.equal(beat.type, "state_command_result");
	assert.equal(beat.status, "applied");

	const bootstrapped = readStatus(root, "v1", "r1");
	assert.ok(bootstrapped, "beat bootstrapped the missed status file");
	assert.equal(bootstrapped.runId, "r1");
	assert.equal(bootstrapped.semanticState, "working");
	assert.equal(bootstrapped.processState, "alive");
	assert.equal(bootstrapped.materializedRevision, beat.materializedRevision, "bootstrap stamp shares the revision");
	const state = readState(root, "v1");
	assert.equal(state.materializedRevision, beat.materializedRevision);
	assert.equal(state.semanticState, "working");
	assert.equal(state.processState, "alive");

	// Transient by design: the bootstrap beat never lands in the journal.
	assert.equal(readJournal(root).length, journalBeforeBeat, "bootstrap beat stays transient");

	// The run can now finalize — before this closure both beats and finalize
	// rejected stale_run forever and the row could never converge (residual).
	client.send({ type: "state_command", commandId: "hd-fin-1", viewId: "v1", runId: "r1", source: "job-runner", kind: "run_finalized", payload: { exitCode: 0 } });
	const fin = await client.next();
	assert.equal(fin.status, "applied", "finalize converges after the bootstrap (was stale_run forever)");

	// Journal carries only the journaled commands — the beat never landed there.
	const kinds = readJournal(root).map((r) => r.command?.kind);
	assert.deepEqual(kinds, ["mark_queued", "run_finalized"]);
});

test("host_run_failed applies through the coordinator and fences manual completions", async (t) => {
	const root = freshRoot();
	let child = null;
	t.after(async () => {
		if (child && isAlive(child.pid)) { child.kill("SIGTERM"); await waitForExit(child); }
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	createView(root, { id: "v1", name: "x", cwd: root });
	child = startCoordinator(root);
	const { client } = await readyClient(root);
	await seedLiveRun(client, root);

	client.send({
		type: "state_command", commandId: "cmd-hrf-1", viewId: "v1", runId: "r1", source: "pty-runner",
		kind: "host_run_failed", payload: { error: "PTY host died unexpectedly", exitCode: 1 },
	});
	const result = await client.next();
	assert.equal(result.status, "applied");
	const state = readState(root, "v1");
	assert.equal(state.semanticState, "failed");
	assert.equal(state.processState, "exited");
	assert.equal(state.error, "PTY host died unexpectedly");
	assert.equal(readStatus(root, "v1", "r1").semanticState, "failed");
});
