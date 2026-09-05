/**
 * Issue #70 A13: ack-based host input with durable follow-up retention.
 * service.reply / drainNextFollowUp must treat a host input as sent only
 * after the runner answers input_ack; anything else keeps the item queued.
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService, sendHostInput } from "../src/runtime/service.mjs";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import { readFollowUpQueue } from "../src/core/follow-up-queue.mjs";
import { createView, readState, writeHost, writeState } from "../src/core/store.mjs";
import * as P from "../src/core/paths.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-hostinput-"));
}

function service(root, overrides = {}) {
	return createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: process.cwd(),
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
		...overrides,
	});
}

/** Host fixture: a live-looking claim whose socketPath the caller controls. */
function writeLiveHost(root, viewId, socketPath, overrides = {}) {
	writeHost(root, {
		version: 1,
		viewId,
		mode: "pty",
		instanceId: "itest",
		runnerPid: process.pid,
		childPid: null,
		socketPath,
		state: "alive",
		claimAt: Date.now(),
		claimPid: process.pid,
		claimIdentity: { pid: process.pid, startToken: null },
		runnerIdentity: { pid: process.pid, startToken: null },
		runnerSpawnedAt: Date.now(),
		childIdentity: null,
		childSpawnedAt: null,
		readyAt: Date.now(),
		stopRequestedAt: null,
		revokeToken: null,
		stopReason: null,
		startedAt: Date.now(),
		lastSeenAt: Date.now(),
		endedAt: null,
		exitCode: null,
		error: null,
		cols: 80,
		rows: 24,
		attachedClients: 0,
		...overrides,
	});
}

/**
 * Fake control-socket endpoint. mode "ack" mirrors the new-protocol runner:
 * hello on connect, input_ack per input, and a requestId dedup table so a
 * repeat requestId re-acks WITHOUT writing the child again. mode "starting"
 * answers every input with {type:"error",code:"host_starting"}. mode "silent"
 * behaves like a legacy runner: hello, then nothing (no ack ever).
 */
function startFakeHost(socketPath, mode = "ack") {
	const writes = [];
	const seen = new Set();
	const server = createServer((socket) => {
		socket.write(JSON.stringify({ type: "hello", status: { state: mode === "starting" ? "starting" : "alive" }, editorEmpty: null }) + "\n");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let msg;
				try { msg = JSON.parse(line); } catch { continue; }
				if (msg.type !== "input") continue;
				if (mode === "starting") {
					socket.write(JSON.stringify({ type: "error", code: "host_starting", requestId: msg.requestId }) + "\n");
					continue;
				}
				if (mode === "silent") continue;
				if (seen.has(msg.requestId)) {
					socket.write(JSON.stringify({ type: "input_ack", requestId: msg.requestId }) + "\n");
					continue;
				}
				seen.add(msg.requestId);
				writes.push({ requestId: msg.requestId, data: msg.data });
				socket.write(JSON.stringify({ type: "input_ack", requestId: msg.requestId }) + "\n");
			}
		});
	});
	return {
		writes,
		listen: () => new Promise((resolve) => server.listen(socketPath, resolve)),
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

/** canAutoDrain gate: drain only runs for idle non-busy rows. */
function setIdle(root, viewId) {
	const st = readState(root, viewId);
	st.semanticState = "idle";
	st.processState = "exited";
	writeState(root, st);
}

test("reply over ready host completes the item on input_ack", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "ack.sock"), "ack");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		writeLiveHost(root, "v1", join(root, "ack.sock"));
		const svc = service(root);
		const res = await svc.reply("v1", "hello");
		assert.equal(res.ok, true);
		assert.equal(res.sent, true);
		assert.equal(fake.writes.length, 1);
		assert.equal(fake.writes[0].data, "hello\r");
		const queue = readFollowUpQueue(root, "v1");
		assert.equal(queue.items.length, 1);
		assert.equal(queue.items[0].status, "completed");
		assert.ok(readDiagnostics(root, "v1").some((d) => d.code === "follow_up_sent"));
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("reply while the host is starting keeps the prompt queued", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "starting.sock"), "starting");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		writeLiveHost(root, "v1", join(root, "starting.sock"));
		const svc = service(root);
		const res = await svc.reply("v1", "hello");
		assert.equal(res.ok, true);
		assert.equal(res.queued, true);
		assert.equal(res.sent, undefined);
		assert.equal(fake.writes.length, 0, "host_starting must not be treated as delivered");
		const queue = readFollowUpQueue(root, "v1");
		assert.equal(queue.items.length, 1);
		assert.equal(queue.items[0].status, "queued");
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("reply against a dead socket keeps the prompt queued", async () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeLiveHost(root, "v1", P.hostEndpointPathFor(process.platform, root, "v1", "itest"));
		const svc = service(root);
		const res = await svc.reply("v1", "hello");
		assert.equal(res.ok, true);
		assert.equal(res.queued, true);
		const queue = readFollowUpQueue(root, "v1");
		assert.equal(queue.items[0].status, "queued");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("drain completes on ack and releases with a warning when the send fails", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "drain.sock"), "ack");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		// Queue a prompt against a dead socket first (reply keeps it queued).
		writeLiveHost(root, "v1", join(root, "drain.sock"));
		const svc = service(root);
		const dead = await svc.reply("v1", "step one");
		assert.equal(dead.queued, true);

		// Host endpoint comes up only now — the queued prompt drains via ack.
		await fake.listen();
		setIdle(root, "v1");
		const drained = await svc.drainNextFollowUp("v1");
		assert.equal(drained.ok, true);
		assert.equal(drained.sent, true);
		assert.equal(fake.writes.length, 1);
		assert.equal(fake.writes[0].data, "step one\r");
		const queue = readFollowUpQueue(root, "v1");
		assert.equal(queue.items[0].status, "completed");
		assert.ok(readDiagnostics(root, "v1").some((d) => d.code === "follow_up_sent"));

		// Second round: socket gone again -> item must be released back to queued.
		await fake.close();
		const deadReply = await svc.reply("v1", "step two");
		assert.equal(deadReply.queued, true);
		const drainedFail = await svc.drainNextFollowUp("v1");
		assert.equal(drainedFail.ok, true);
		assert.equal(drainedFail.pending, true);
		const q2 = readFollowUpQueue(root, "v1");
		const two = q2.items.find((i) => i.text === "step two");
		assert.equal(two.status, "queued", "failed send must release the claimed item");
		const warns = readDiagnostics(root, "v1").filter((d) => d.code === "follow_up_send_failed");
		assert.equal(warns.length, 1);
		assert.equal(warns[0].level, "warn");
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("sendHostInput re-acks a duplicate requestId without a second child write", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "dup.sock"), "ack");
	try {
		await fake.listen();
		const first = await sendHostInput(join(root, "dup.sock"), "x\r", { requestId: "dup-1" });
		assert.equal(first.ok, true);
		const second = await sendHostInput(join(root, "dup.sock"), "x\r", { requestId: "dup-1" });
		assert.equal(second.ok, true);
		assert.equal(fake.writes.length, 1, "runner dedup must re-ack without writing the child again");
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("sendHostInput times out against a silent (legacy) endpoint as retryable", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "silent.sock"), "silent");
	try {
		await fake.listen();
		const res = await sendHostInput(join(root, "silent.sock"), "x\r", { requestId: "s-1", timeoutMs: 150 });
		assert.equal(res.ok, false);
		assert.equal(res.error, "timeout");
		assert.equal(res.retryable, true);
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});
