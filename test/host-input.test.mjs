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
import { readFollowUpQueue, enqueueFollowUp } from "../src/core/follow-up-queue.mjs";
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
function startFakeHost(socketPath, mode = "ack", opts = {}) {
	const writes = [];
	const received = [];
	const seen = new Set();
	// Envelope-mode journal sim (phase 5 Task 4): commandId → terminal stage.
	const journal = new Map(); // commandId → "accepted" | "applied"
	const server = createServer((socket) => {
		const envelopeMode = mode.startsWith("envelope");
		socket.write(JSON.stringify({ type: "hello", status: { state: mode === "starting" ? "starting" : "alive" }, editorEmpty: null, ...(envelopeMode ? { generation: "gen-fake" } : {}) }) + "\n");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let msg;
				try { msg = JSON.parse(line); } catch { continue; }
				if (envelopeMode && msg.type === "reconcile") {
					const unresolved = [...journal.entries()].filter(([, stage]) => stage === "accepted").map(([commandId]) => ({ commandId, status: "accepted_unknown" }));
					socket.write(JSON.stringify({ type: "reconcile_result", commandId: msg.commandId, generation: "gen-fake", hostRevision: 1, terminalCursor: { lastSeq: 0 }, stateMaterializedRevision: null, unresolved }) + "\n");
					continue;
				}
				if (msg.type !== "input") continue;
				received.push(msg);
				if (envelopeMode) {
					// Journal sim mirroring the runner's durable contract: accepted
					// (journaled) → applied (written); a re-send returns the cached
					// final stage and never re-writes.
					const stage = journal.get(msg.commandId);
					if (stage) {
						if (!opts.muteAcks) socket.write(JSON.stringify({ type: "cmd_ack", commandId: msg.commandId, stage }) + "\n");
						continue;
					}
					if (mode === "envelope-journal-down") {
						// Durable accept REFUSED (journal write failed): nothing journaled.
						socket.write(JSON.stringify({ type: "error", code: "journal_unavailable", commandId: msg.commandId }) + "\n");
						continue;
					}
					journal.set(msg.commandId, "accepted");
					if (!opts.muteAcks) socket.write(JSON.stringify({ type: "cmd_ack", commandId: msg.commandId, stage: "accepted" }) + "\n");
					if (mode === "envelope-applyless") continue; // simulate §10 write failure
					journal.set(msg.commandId, "applied");
					writes.push({ commandId: msg.commandId, requestId: msg.requestId ?? null, data: msg.data });
					if (!opts.muteAcks) socket.write(JSON.stringify({ type: "cmd_ack", commandId: msg.commandId, stage: "applied" }) + "\n");
					continue;
				}
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
		received,
		journal,
		/** Pre-seed the journal sim (accepted-without-applied = §10 window). */
		seedAccepted: (commandId) => journal.set(commandId, "accepted"),
		/** Drop an applied record (simulates a lost applied ack after write). */
		markAppliedWithoutAck: (commandId) => journal.set(commandId, "applied"),
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

/** Bounded wait for fire-and-forget delivery (connect+write is async). */
async function waitForReceived(fake, count, timeoutMs = 1000) {
	const start = Date.now();
	while (fake.received.length < count) {
		if (Date.now() - start > timeoutMs) return false;
		await new Promise((r) => setTimeout(r, 10));
	}
	return true;
}

test("reply over a legacy (instanceId-less) host is fire-and-forget and completes on connect", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "legacy.sock"), "silent");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		// Legacy host: state alive, no instanceId — a pre-upgrade runner that
		// never speaks input_ack. Delivery must not wait for one (final review
		// finding 1: ack-wait loop re-sends the prompt forever).
		writeLiveHost(root, "v1", join(root, "legacy.sock"), { instanceId: null });
		const svc = service(root);
		const startedAt = Date.now();
		const res = await svc.reply("v1", "hello");
		assert.equal(res.ok, true);
		assert.equal(res.sent, true);
		assert.ok(Date.now() - startedAt < 500, "legacy reply must not stall on an ack that never comes");
		assert.equal(await waitForReceived(fake, 1), true, "legacy input delivered exactly once");
		assert.equal(fake.received[0].data, "hello\r");
		const queue = readFollowUpQueue(root, "v1");
		assert.equal(queue.items.length, 1);
		assert.equal(queue.items[0].status, "completed", "legacy delivery must complete, not loop");
		assert.ok(readDiagnostics(root, "v1").some((d) => d.code === "follow_up_sent"));
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("drain over a legacy host completes without waiting for input_ack", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "legacy.sock"), "silent");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		writeLiveHost(root, "v1", join(root, "legacy.sock"), { instanceId: null });
		setIdle(root, "v1");
		// Queue an item directly (bypassing reply, which delivers instantly on
		// the legacy path) so drainNextFollowUp must deliver it itself.
		const enq = enqueueFollowUp(root, "v1", "queued earlier", { kind: "reply", source: "user" });
		assert.equal(enq.ok, true);
		const svc = service(root);
		const drained = await svc.drainNextFollowUp("v1");
		assert.equal(drained.ok, true);
		assert.equal(await waitForReceived(fake, 1), true, "drain delivered the queued item once via fire-and-forget");
		assert.equal(fake.received[0].data, "queued earlier\r");
		const queue = readFollowUpQueue(root, "v1");
		assert.equal(queue.items[0].status, "completed");
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

test("sendHostInput staged: enveloped durable input gets accepted→applied (generation-capable host)", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "staged.sock"), "envelope");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		const res = await sendHostInput(join(root, "staged.sock"), "step one\r", {
			commandId: "item-1", viewId: "v1", instanceId: "itest",
		});
		assert.equal(res.ok, true);
		assert.equal(res.applied, true, "staged delivery reports the applied stage");
		const envelope = fake.received[0];
		assert.equal(envelope.type, "input");
		assert.equal(envelope.durable, true, "durable flag on the wire");
		assert.equal(envelope.commandId, "item-1");
		assert.equal(envelope.clientId, "service");
		assert.equal(envelope.seq, 1);
		assert.equal(envelope.viewId, "v1");
		assert.equal(envelope.instanceId, "itest");
		assert.equal(fake.writes.length, 1);
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("staged re-send of a journaled commandId returns the cached stage without a second write", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "staged-dup.sock"), "envelope");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		const opts = { commandId: "item-1", viewId: "v1", instanceId: "itest" };
		const first = await sendHostInput(join(root, "staged-dup.sock"), "step one\r", opts);
		assert.equal(first.ok, true);
		const second = await sendHostInput(join(root, "staged-dup.sock"), "step one\r", opts);
		assert.equal(second.ok, true);
		assert.equal(second.applied, true, "re-send gets the cached applied stage");
		assert.equal(fake.writes.length, 1, "never re-written (commandId dedup)");
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("staged accepted-never-applied resolves ambiguous via reconcile — §10 never-retry", async () => {
	const root = freshRoot();
	// applyless host: accepts (journaled) but never writes → the §10 window.
	const fake = startFakeHost(join(root, "staged-applyless.sock"), "envelope-applyless");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		const res = await sendHostInput(join(root, "staged-applyless.sock"), "step one\r", {
			commandId: "item-1", viewId: "v1", instanceId: "itest",
		});
		assert.equal(res.ok, false);
		assert.equal(res.ambiguous, true, "accepted_unknown is ambiguous, not retryable");
		assert.equal(res.error, "accepted_unknown");
		assert.equal(res.retryable, false);
		assert.equal(fake.writes.length, 0, "never applied anywhere");
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("staged timeout with lost applied-ack reconciles clean and stays retryable", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "staged-mute.sock"), "envelope", { muteAcks: true });
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		const res = await sendHostInput(join(root, "staged-mute.sock"), "step one\r", {
			commandId: "item-1", viewId: "v1", instanceId: "itest", timeoutMs: 300,
		});
		assert.equal(res.ok, false);
		assert.equal(res.ambiguous, undefined, "applied-lost-ack is NOT ambiguous (reconcile shows applied)");
		assert.equal(res.retryable, true, "re-send is safe: the runner dedups to the cached applied stage");
		assert.equal(fake.writes.length, 1, "the write did land");
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy runner (hello without generation) falls back to requestId contract on the same connection", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "legacy-fallback.sock"), "ack");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		const res = await sendHostInput(join(root, "legacy-fallback.sock"), "step one\r", {
			commandId: "item-1", viewId: "v1", instanceId: "itest",
		});
		assert.equal(res.ok, true);
		assert.equal(res.applied, undefined, "legacy ack carries no staged semantics");
		const envelope = fake.received[0];
		assert.equal(envelope.requestId, "item-1", "legacy requestId bytes");
		assert.equal(envelope.durable, undefined, "no envelope fields on the wire");
		assert.equal(envelope.commandId, undefined);
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("journal_unavailable is retryable — the accept was refused, nothing journaled", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "journal-down.sock"), "envelope-journal-down");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		const res = await sendHostInput(join(root, "journal-down.sock"), "step one\r", {
			commandId: "item-1", viewId: "v1", instanceId: "itest", timeoutMs: 300,
		});
		assert.equal(res.ok, false);
		assert.equal(res.error, "journal_unavailable");
		assert.equal(res.retryable, true, "fresh accept on retry is safe (refused ≠ journaled)");
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("reply marks an accepted_unknown item failed at the delivery attempt (§10)", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "reply-amb.sock"), "envelope-applyless");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		writeLiveHost(root, "v1", join(root, "reply-amb.sock"));
		const svc = service(root);
		const res = await svc.reply("v1", "step one");
		assert.equal(res.ok, true);
		assert.equal(res.failed, true, "the delivery attempt itself resolves §10-ambiguous");
		const queue = readFollowUpQueue(root, "v1");
		assert.equal(queue.items[0].status, "failed", "ambiguous item is terminal — never re-queued");
		assert.ok(queue.items[0].error.includes("accepted_unknown"), "reason recorded on the item");
		assert.equal(fake.writes.length, 0, "never delivered anywhere (no double-write possible)");
		const diags = readDiagnostics(root, "v1").filter((d) => d.code === "follow_up_ambiguous");
		assert.equal(diags.length, 1);
		assert.equal(diags[0].level, "error");
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("drain marks an accepted_unknown item failed when the host restarts between queue and drain (§10)", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "drain-amb.sock"), "envelope-applyless");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		// Queue against a dead socket first (reply keeps it queued).
		writeLiveHost(root, "v1", join(root, "drain-amb.sock"));
		const svc = service(root);
		const queued = await svc.reply("v1", "step one");
		assert.equal(queued.queued, true);
		// Host endpoint comes up only now — but the pre-journaled accepted
		// record means the item can never be delivered: the drain must mark it
		// failed instead of re-sending (§10 never-replay).
		const itemId = readFollowUpQueue(root, "v1").items[0].id;
		fake.seedAccepted(itemId);
		await fake.listen();
		setIdle(root, "v1");
		const drained = await svc.drainNextFollowUp("v1");
		assert.equal(drained.ok, true);
		assert.equal(drained.failed, true);
		const queue = readFollowUpQueue(root, "v1");
		assert.equal(queue.items[0].status, "failed", "ambiguous item is terminal — never re-queued");
		assert.ok(queue.items[0].error.includes("accepted_unknown"), "reason recorded on the item");
		assert.equal(fake.writes.length, 0, "never delivered anywhere (no double-write possible)");
		const diags = readDiagnostics(root, "v1").filter((d) => d.code === "follow_up_ambiguous");
		assert.equal(diags.length, 1);
		assert.equal(diags[0].level, "error");
		const second = await svc.drainNextFollowUp("v1");
		assert.equal(second.ok, false, "terminal: nothing left to claim");
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("reply completes on the staged applied ack (enveloped happy path)", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "reply-env.sock"), "envelope");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		await fake.listen();
		writeLiveHost(root, "v1", join(root, "reply-env.sock"));
		const svc = service(root);
		const res = await svc.reply("v1", "step one");
		assert.equal(res.ok, true);
		assert.equal(res.sent, true);
		const queue = readFollowUpQueue(root, "v1");
		assert.equal(queue.items[0].status, "completed");
		assert.equal(fake.writes.length, 1);
		assert.equal(fake.writes[0].commandId, queue.items[0].id, "the queue item id IS the commandId");
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("drain completes on the staged applied ack after a queued start (enveloped happy path)", async () => {
	const root = freshRoot();
	const fake = startFakeHost(join(root, "drain-env.sock"), "envelope");
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		// Queue against a dead socket first (reply keeps it queued).
		writeLiveHost(root, "v1", join(root, "drain-env.sock"));
		const svc = service(root);
		const queued = await svc.reply("v1", "step one");
		assert.equal(queued.queued, true);
		await fake.listen();
		setIdle(root, "v1");
		const drained = await svc.drainNextFollowUp("v1");
		assert.equal(drained.ok, true);
		assert.equal(drained.sent, true);
		const queue = readFollowUpQueue(root, "v1");
		assert.equal(queue.items[0].status, "completed");
		assert.equal(fake.writes.length, 1);
		assert.equal(fake.writes[0].commandId, queue.items[0].id, "the queue item id IS the commandId");
		assert.ok(readDiagnostics(root, "v1").some((d) => d.code === "follow_up_sent"));
	} finally {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
});
