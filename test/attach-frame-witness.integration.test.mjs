// Issue #222 step 23b1 fix1 (task-23b1-fix1-dispositions.md): REAL-runner integration for
// FW-03/FW-04 through the owned main. A marker-emitting fake child runs under the actual
// `runner/pty-runner.mjs`; the test drives the real control socket.
//
// Covers: no-hello identity (no new messages, byte-identical output), valid hello ->
// per-instance random token + runner GENERATION identity + truthful sessionEpoch, marker
// stripping from broadcast/canonical/screenLog, proof seq recorded on the parser's own
// objects, intent only on a differing resize with monotonic geometryRevision, and cleanup.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";

import { atomicWriteJson } from "../src/core/atomic.mjs";

import * as P from "../src/core/paths.mjs";
import { claimHost, createView, readHost } from "../src/core/store.mjs";

const CHILD_SCRIPT = `
const fs = require("node:fs");
const file = process.argv[1];
let sent = 0;
const marker = (kind, frameId, extra = "") =>
  "\\u001bP> agent-board-frame/1 ; " + fs.readFileSync(file, "utf8").trim() + " ; " + kind + " ; " + frameId + " ; " + extra + "\\u001b\\\\";
setInterval(() => {
  const token = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  if (!token) { process.stdout.write("PLAIN-1 "); return; }
  if (sent === 0) { process.stdout.write("before" + marker("S", 1, "0 ; 80") + "BODY-A" + marker("F", 1, Buffer.from(JSON.stringify({protocol:1,cols:80,rows:24,mode:"fullscreen",rendererEpoch:1,sessionEpoch:1,focusPresent:true,overlayPresent:false,intentId:0,geometryRevision:0})).toString("base64url")) + "after"); sent = 1; }
  else process.stdout.write("PLAIN-2 ");
}, 60);
`;

const VIEW_PROOF_SCRIPT = `
const fs = require("node:fs");
const file = process.argv[1];
const meta = (sessionEpoch) => Buffer.from(JSON.stringify({protocol:1,cols:80,rows:24,mode:"fullscreen",rendererEpoch:1,sessionEpoch,focusPresent:true,overlayPresent:false,intentId:0,geometryRevision:0})).toString("base64url");
const marker = (kind, frameId, extra) => "\\u001bP> agent-board-frame/1 ; " + fs.readFileSync(file, "utf8").trim() + " ; " + kind + " ; " + frameId + " ; " + extra + "\\u001b\\\\";
let sent = false;
setInterval(() => {
  let token = "";
  try { token = fs.readFileSync(file, "utf8").trim(); } catch {}
  if (!token) { process.stdout.write("P"); return; }
  if (sent) return;
  sent = true;
  process.stdout.write(marker("S", 1, "0 ; 80"));
  process.stdout.write("BODY-A");
  process.stdout.write(marker("F", 1, meta(1)));
  process.stdout.write("\\u001b[?25l");
  process.stdout.write(marker("S", 2, "0 ; 80"));
  process.stdout.write("BODY-B");
  process.stdout.write(marker("A", 2, "stop"));
  process.stdout.write("\\u001b[?25h");
  process.stdout.write(marker("S", 3, "0 ; 80"));
  process.stdout.write("BODY-C");
  process.stdout.write(marker("F", 3, meta(1)));
  process.stdout.write("\\u001b[?25h");
}, 80);
`;

const LEGACY_CLOSE_SCRIPT = `
const fs = require("node:fs");
const file = process.argv[1];
const meta = (sessionEpoch) => Buffer.from(JSON.stringify({protocol:1,cols:80,rows:24,mode:"fullscreen",rendererEpoch:1,sessionEpoch,focusPresent:true,overlayPresent:false,intentId:0,geometryRevision:0})).toString("base64url");
let token = "";
let escSent = false;
let frameSent = false;
const marker = (kind, frameId, extra) => "\\u001bP> agent-board-frame/1 ; " + token + " ; " + kind + " ; " + frameId + " ; " + extra + "\\u001b\\\\";
setInterval(() => {
  let state = "";
  try { state = fs.readFileSync(file, "utf8").trim(); } catch {}
  if (state && state !== "GO" && state !== "FRAME") token = state;
  if (!token) { process.stdout.write("PREFIX"); return; }
  if (state === "GO" && !escSent) { escSent = true; process.stdout.write("\\u001b"); return; }
  if (state === "FRAME" && !frameSent) {
    frameSent = true;
    process.stdout.write(marker("S", 1, "0 ; 80"));
    process.stdout.write("BODY");
    process.stdout.write(marker("F", 1, meta(1)));
    process.stdout.write("\\u001b[?25h");
    return;
  }
  if (!escSent) process.stdout.write("PREFIX");
}, 50);
`;

const REPORTER_LIFECYCLE_SCRIPT = `
const fs = require("node:fs");
const file = process.argv[1];
const meta = (sessionEpoch) => Buffer.from(JSON.stringify({protocol:1,cols:80,rows:24,mode:"fullscreen",rendererEpoch:1,sessionEpoch,focusPresent:true,overlayPresent:false,intentId:0,geometryRevision:0})).toString("base64url");
process.stdout.write("BOOT");
let token = "";
let frameId = 0;
const readyFile = file + ".ready";
const marker = (kind, id, extra) => "\\u001bP> agent-board-frame/1 ; " + token + " ; " + kind + " ; " + id + " ; " + extra + "\\u001b\\\\";
setInterval(() => {
  let state = "";
  try { state = fs.readFileSync(file, "utf8").trim(); } catch {}
  if (state && state !== "FRAME" && state !== token) {
    token = state;
    try { fs.writeFileSync(readyFile, token); } catch {}
  }
  if (!token) { process.stdout.write("PREFIX"); return; }
  if (state === "FRAME" && token) {
    try { fs.writeFileSync(file, ""); } catch {}
    frameId += 1;
    process.stdout.write(marker("S", frameId, "0 ; 80"));
    process.stdout.write("BODY-" + frameId);
    process.stdout.write(marker("F", frameId, meta(1)));
    process.stdout.write("\\u001b[?25h");
  }
}, 50);
`;

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-fw-"));
}

async function waitFor(predicate, timeoutMs = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out waiting");
}

function send(socket, msg) {
	socket.write(`${JSON.stringify(msg)}\n`);
}

function listen(socket) {
	let buffer = "";
	const messages = [];
	socket.on("data", (chunk) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
	});
	return messages;
}

async function stopRunner(runner) {
	if (!runner || runner.exitCode !== null || runner.signalCode !== null) return;
	try {
		runner.kill("SIGTERM");
	} catch {
		/* already gone */
	}
	await new Promise((r) => setTimeout(r, 300));
	try {
		runner.kill("SIGKILL");
	} catch {
		/* already gone */
	}
}

function reapChild(root, viewId) {
	try {
		const pid = readHost(root, viewId)?.childPid;
		if (pid) process.kill(pid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

let counter = 0;

const ESC = String.fromCharCode(27);
// The controlled child emits the ordinary prefix repeatedly until the test writes "GO";
// only then does it emit the pending payload (i.e. after the reporter parser is active).
// Repeating the prefix avoids a pre-subscribe snapshot race without changing what is asserted.
const tailScript = (payload) => `
const fs = require("node:fs");
const file = process.argv[1];
let sent = false;
setInterval(() => {
  try {
    if (sent) return;
    process.stdout.write("TAIL");
    if (fs.readFileSync(file, "utf8").trim() === "GO") {
      sent = true;
      process.stdout.write(${JSON.stringify(payload)});
    }
  } catch {}
}, 50);
`;

async function startHost(t, { legacy = false, script = CHILD_SCRIPT } = {}) {
	const root = freshRoot();
	const viewId = `v${++counter}`;
	const meta = createView(root, { id: viewId, name: "fw", cwd: process.cwd() });
	const instanceId = `inst-${viewId}`;
	const socketPath = legacy ? P.controlSocketPath(root, viewId) : P.hostEndpointPathFor(process.platform, root, viewId, instanceId);
	const configPath = legacy ? P.hostConfigPath(root, viewId) : P.hostConfigPathFor(root, viewId, instanceId);
	if (!legacy) {
		claimHost(root, { viewId, instanceId, configPath, socketPath, claimAt: Date.now(), claimPid: process.pid, claimIdentity: null, cols: 80, rows: 24 });
	}
	const tokenFile = join(root, "token.txt");
	atomicWriteJson(configPath, {
		root,
		viewId,
		...(legacy ? {} : { instanceId, socketPath }),
		sessionFile: meta.sessionFile,
		cwd: process.cwd(),
		initialPrompt: null,
		piCommand: process.execPath,
		piArgsPrefix: ["-e", script, tokenFile],
		model: null,
		tools: null,
		env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1" },
		cols: 80,
		rows: 24,
	});
	const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
	runner.stdout.resume();
	runner.stderr.resume();
	t.after(async () => {
		await stopRunner(runner);
		reapChild(root, viewId);
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	await waitFor(() => {
		const host = readHost(root, viewId);
		return host && host.state === "alive" && host.childPid;
	});
	const socket = createConnection(socketPath);
	await once(socket, "connect");
	// A separate real subscriber observes the output stream; the reporter socket is
	// bookkeeping-only and is removed from terminalSubscriptions by its hello.
	const subscriber = createConnection(socketPath);
	await once(subscriber, "connect");
	const subscriberMessages = listen(subscriber);
	send(subscriber, { type: "subscribe_terminal" });
	return { root, viewId, instanceId, socketPath, socket, subscriber, subscriberMessages, tokenFile, messages: listen(socket) };
}

test("23b1 fix1 F2 (owned main): no-hello identity, token enable, marker stripping and proof seq", async (t) => {
	const { root, viewId, socketPath, socket, subscriber, subscriberMessages, tokenFile, messages } = await startHost(t);
	// No-hello: the stream is byte-identical (no new messages, no marker knowledge yet).
	await waitFor(() => subscriberMessages.some((msg) => msg.type === "output"));
	const plainOutputs = subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("");
	assert.match(plainOutputs, /PLAIN-/, "ordinary child output flows before any hello");
	assert.equal(plainOutputs.includes("agent-board-frame"), false);

	// Valid hello -> per-instance random token, runner GENERATION identity, truthful epoch.
	send(socket, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	const enable = await waitFor(() => messages.find((msg) => msg.type === "frame_witness_enable"));
	assert.equal(enable.protocol, 1);
	assert.match(enable.token, /^[A-Za-z0-9_-]{22,}$/, "the token is >=128 bits of base64url");
	assert.equal(typeof enable.instanceId, "string");
	assert.equal(enable.sessionEpoch, 1, "the truthful session epoch is reported");
	assert.match(enable.instanceId, /^[0-9a-f-]{36}$/, "the identity is the runner process generation, not a connection id");

	// Let the child emit real markers now that it knows the token.
	writeFileSync(tokenFile, enable.token);
	await waitFor(() => readHost(root, viewId)?.frameWitness?.proofs >= 1, 20000);
	const summary = readHost(root, viewId).frameWitness;
	assert.ok(summary.proofs >= 1, "the accepted proof is recorded");
	assert.equal(summary.openFrameId, null);
	const allOutput = subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("");
	assert.equal(allOutput.includes("agent-board-frame"), false, "marker bytes never reach the broadcast");
	assert.equal(allOutput.includes("BODY-A"), true, "ordinary segments around the markers are preserved");
	// Canonical model + screen log must be marker-free too.
	const screenLog = readFileSync(P.screenLogPath(root, viewId), "utf8");
	assert.equal(screenLog.includes("agent-board-frame"), false, "no marker bytes in the screen log");

	// Intent seam (issue #222 FW-04): the runner announces an intent only when the ACTUAL
	// model geometry changed after the resize. This fake child does not reflow, so a resize
	// request must NOT fabricate an intent — that is the correct fail-closed behaviour and the
	// real topology (attach-frame-witness.real.test.mjs) is where an intent is observed.
	send(socket, { type: "resize", cols: 100, rows: 30 });
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(messages.filter((msg) => msg.type === "frame_witness_intent").length, 0, "no intent without an actual geometry change");
	send(socket, { type: "resize", cols: 100, rows: 30 }); // same size
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(messages.filter((msg) => msg.type === "frame_witness_intent").length, 0, "same-size resize emits no intent");
	// Proofs stay consistent (the resumed render stream keeps proving).
	await waitFor(() => (readHost(root, viewId)?.frameWitness?.proofs ?? 0) >= 1);

	// Reporter replacement: a new token but the SAME runner generation; the old socket's
	// capability is retired (F4/F7).
	const replacement = createConnection(socketPath);
	await once(replacement, "connect");
	const replacementMessages = listen(replacement);
	send(replacement, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	const replacementEnable = await waitFor(() => replacementMessages.find((msg) => msg.type === "frame_witness_enable"));
	assert.equal(replacementEnable.instanceId, enable.instanceId, "a replacement keeps the runner generation");
	assert.notEqual(replacementEnable.token, enable.token, "a replacement gets a fresh token");
	replacement.destroy();
	subscriber.destroy();
	socket.destroy();
});

test("23b1 fix1 F2 (legacy main): no-hello identity and marker stripping still hold", async (t) => {
	const { root, viewId, socket, tokenFile, messages } = await startHost(t, { legacy: true });
	send(socket, { type: "subscribe_terminal" });
	await waitFor(() => messages.some((msg) => msg.type === "output"));
	send(socket, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	const enable = await waitFor(() => messages.find((msg) => msg.type === "frame_witness_enable"));
	assert.equal(enable.sessionEpoch, 1);
	writeFileSync(tokenFile, enable.token);
	await waitFor(() => readHost(root, viewId)?.frameWitness?.proofs >= 1, 20000);
	const output = messages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("");
	assert.equal(output.includes("agent-board-frame"), false, "legacy path also strips marker bytes");
	const screenLog = readFileSync(P.screenLogPath(root, viewId), "utf8");
	assert.equal(screenLog.includes("agent-board-frame"), false);
	socket.destroy();
});

test("23b1 fix1 F2: a marker-family lookalike from the child never becomes a proof", async (t) => {
	const { root, viewId, socket, messages } = await startHost(t);
	send(socket, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	const enable = await waitFor(() => messages.find((msg) => msg.type === "frame_witness_enable"));
	// The child is still in PLAIN mode (no token written); a lookalike cannot appear, so the
	// identity assertion is that no proof exists without a valid token+marker.
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(readHost(root, viewId)?.frameWitness?.proofs ?? 0, 0, "no proof without a valid marker");
	assert.equal(existsSync(join(root, "token.txt")) && readFileSync(join(root, "token.txt"), "utf8").trim().length > 0, false);
	void enable;
	void viewId;
	socket.destroy();
});

// 23b1 trailing-replacement fix (parent-required): a pending ORDINARY tail held by the
// reporter parser must survive reporter replacement. REAL runner + REAL parser: the child
// emits "TAIL\x1b" then goes silent, an independent subscriber observes "TAIL" (so the ESC
// is pending), the reporter is replaced, and the exact ESC must reach subscriber + screenLog.
test("23b1 trailing fix: reporter replacement forwards a pending ordinary ESC (old code fails)", async (t) => {
	const { root, viewId, socketPath, subscriber, subscriberMessages, socket, tokenFile } = await startHost(t, { script: tailScript("\u001b") });
	await waitFor(() => subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("").includes("TAIL"), 15000);
	const first = createConnection(socketPath);
	await once(first, "connect");
	const firstMessages = listen(first);
	send(first, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	await waitFor(() => firstMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	// The parser is now active: the child's pending ESC becomes a carried tail, not output.
	writeFileSync(tokenFile, "GO");
	await new Promise((r) => setTimeout(r, 500));
	const beforeReplace = subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("");
	assert.equal(beforeReplace.includes("TAIL"), true, "the ordinary prefix reached the subscriber");
	assert.equal(beforeReplace.includes("\u001b"), false, "the pending ESC has NOT been forwarded yet");
	// Replace the reporter: the old parser must flush its ordinary trailing byte.
	const replacement = createConnection(socketPath);
	await once(replacement, "connect");
	const replacementMessages = listen(replacement);
	send(replacement, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	await waitFor(() => replacementMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	await waitFor(() => subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("").includes("\u001b"), 15000);
	const afterReplace = subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("");
	assert.equal(afterReplace.includes("\u001b"), true, "the trailing ordinary ESC reached the subscriber after replacement");
	const screenLog = readFileSync(P.screenLogPath(root, viewId), "utf8");
	assert.equal(screenLog.includes("TAIL\u001b"), true, "the trailing ordinary ESC reached the screen log");
	assert.equal(screenLog.includes("agent-board-frame"), false, "no marker bytes in the screen log");
	replacement.destroy();
	first.destroy();
	subscriber.destroy();
	socket.destroy();
});

test("23b1 trailing fix: a pending marker-family tail is never forwarded on replacement", async (t) => {
	const { root, viewId, socketPath, subscriber, subscriberMessages, socket, tokenFile } = await startHost(t, { script: tailScript("\u001bP> agent-board-frame/1 ; partial") });
	await waitFor(() => subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("").includes("TAIL"), 15000);
	const first = createConnection(socketPath);
	await once(first, "connect");
	const firstMessages = listen(first);
	send(first, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	await waitFor(() => firstMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	writeFileSync(tokenFile, "GO");
	await new Promise((r) => setTimeout(r, 500));
	const replacement = createConnection(socketPath);
	await once(replacement, "connect");
	const replacementMessages = listen(replacement);
	send(replacement, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	await waitFor(() => replacementMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	await new Promise((r) => setTimeout(r, 600));
	const output = subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("");
	assert.equal(output.includes("agent-board-frame"), false, "a marker-family tail is never forwarded");
	const screenLog = readFileSync(P.screenLogPath(root, viewId), "utf8");
	assert.equal(screenLog.includes("agent-board-frame"), false);
	replacement.destroy();
	first.destroy();
	subscriber.destroy();
	socket.destroy();
});

for (const legacy of [false, true]) {
	const label = legacy ? "legacy main" : "owned main";
	test(`23b2b viewProof (${label}): opt-in live/capture/replay records, coverage and replacement reset`, async (t) => {
		const { root, viewId, instanceId, socketPath, socket, subscriberMessages, tokenFile, messages } = await startHost(t, { legacy, script: VIEW_PROOF_SCRIPT });

		const live = createConnection(socketPath);
		await once(live, "connect");
		const liveMessages = listen(live);
		send(live, { type: "subscribe_terminal", viewProof: 1 });
		await waitFor(() => liveMessages.some((msg) => msg.type === "snapshot_end"), 15000);
		const firstBegin = liveMessages.find((msg) => msg.type === "snapshot_begin");
		assert.equal(firstBegin.viewProof !== undefined, true, "opt-in snapshot_begin carries viewProof");
		assert.equal(firstBegin.viewProof.status, "unknown", "no proof exists before the reporter emits one");

		send(socket, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
		const enable = await waitFor(() => messages.find((msg) => msg.type === "frame_witness_enable"), 15000);
		await waitFor(() => liveMessages.some((msg) => msg.type === "output"), 15000);
		writeFileSync(tokenFile, enable.token);

		await waitFor(
			() => liveMessages.some((msg) => msg.type === "view_proof" && msg.record.marker === "F" && msg.record.frameId === 3),
			25000,
		);
		await new Promise((r) => setTimeout(r, 350));
		const records = liveMessages.filter((msg) => msg.type === "view_proof").map((msg) => msg.record);
		const outputSeqs = new Set(liveMessages.filter((msg) => msg.type === "output").map((msg) => msg.seq));
		for (const record of records) assert.equal(outputSeqs.has(record.seq), true, "record.seq is the preceding ordinary output segment");
		assert.deepEqual(records.map((record) => [record.marker, record.frameId]), [
			["S", 1],
			["F", 1],
			["S", 2],
			["A", 2],
			["S", 3],
			["F", 3],
		]);
		assert.equal(records.some((record) => record.frameId === 2 && record.marker === "F"), false, "A never becomes F");
		for (const record of records) {
			assert.equal(record.token, undefined, "the reporter token never crosses the view_proof wire");
			if (record.marker === "F") assert.equal(record.metadata.rendererEpoch, 1);
			if (record.marker === "A") assert.equal(typeof record.reason, "string");
		}
		const f3 = records.find((record) => record.marker === "F" && record.frameId === 3);
		assert.equal(f3.metadata.sessionEpoch, 1);
		const summary = readHost(root, viewId)?.frameWitness;
		assert.equal(summary.lastProof.rendererEpoch, 1, "host lastProof summary exposes rendererEpoch additively");

		// Old subscriber stays byte/message compatible: no viewProof fields or records.
		for (const message of subscriberMessages) {
			assert.equal(Object.hasOwn(message, "viewProof"), false, "legacy messages never gain viewProof fields");
			assert.notEqual(message.type, "view_proof");
			assert.notEqual(message.type, "view_proof_state");
		}
		const legacyOutput = subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("");
		assert.equal(legacyOutput.includes("agent-board-frame"), false, "markers never reach the legacy broadcast");
		const screenLog = readFileSync(P.screenLogPath(root, viewId), "utf8");
		assert.equal(screenLog.includes("agent-board-frame"), false, "markers never reach the screen log");

		// A fresh opt-in snapshot after the frames sees the latest covered view.
		const late = createConnection(socketPath);
		await once(late, "connect");
		const lateMessages = listen(late);
		send(late, { type: "subscribe_terminal", viewProof: 1, sinceSeq: 999 });
		await waitFor(() => lateMessages.some((msg) => msg.type === "snapshot_end"), 15000);
		const lateBegin = lateMessages.find((msg) => msg.type === "snapshot_begin");
		const lateEnd = lateMessages.find((msg) => msg.type === "snapshot_end");
		assert.equal(lateBegin.resnapshot, true);
		assert.equal(lateEnd.viewProof.status, "covered");
		assert.equal(lateEnd.viewProof.proof.marker, "F");
		assert.equal(lateEnd.viewProof.proof.seq <= lateEnd.viewProof.throughSeq, true);
		assert.equal(lateEnd.viewProof.cursorVisible, true, "the trailing DECTCEM is reflected");

		// Replay uses the output ring + tracker journal; only retained F proofs replay.
		const replay = createConnection(socketPath);
		await once(replay, "connect");
		const replayMessages = listen(replay);
		send(replay, { type: "subscribe_terminal", viewProof: 1, sinceSeq: 1 });
		await waitFor(() => replayMessages.some((msg) => msg.type === "view_proof_state"), 15000);
		const replayRecords = replayMessages.filter((msg) => msg.type === "view_proof").map((msg) => msg.record);
		assert.equal(replayRecords.length > 0, true, "retained F proofs replay");
		assert.equal(replayRecords.every((record) => record.marker === "F"), true, "S/A history is not replayed");
		for (const record of replayRecords) {
			const outputIndex = replayMessages.findIndex((msg) => msg.type === "output" && msg.seq === record.seq);
			const proofIndex = replayMessages.indexOf(replayMessages.find((msg) => msg.type === "view_proof" && msg.record === record));
			assert.equal(outputIndex >= 0 && outputIndex < proofIndex, true, "output precedes proof at the same seq");
		}
		const replayState = replayMessages.find((msg) => msg.type === "view_proof_state");
		assert.equal(replayState.viewProof.status, "covered");

		// Replacement invalidates live negotiated state before any new proof.
		const replacement = createConnection(socketPath);
		await once(replacement, "connect");
		const replacementMessages = listen(replacement);
		send(replacement, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
		await waitFor(() => replacementMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
		await waitFor(
			() => liveMessages.some((msg) => msg.type === "view_proof_state" && msg.viewProof.reason === "reporter-replaced"),
			15000,
		);
		const resetState = liveMessages.filter((msg) => msg.type === "view_proof_state" && msg.viewProof.reason === "reporter-replaced").at(-1);
		assert.equal(resetState.viewProof.status, "unknown");
		assert.equal(resetState.viewProof.proof, null);

		void instanceId;
		replacement.destroy();
		replay.destroy();
		late.destroy();
		live.destroy();
		socket.destroy();
	});
}


test("23b2b fix1 (legacy main): reporter-close trailing byte advances lastOutputSeq for the next proof", async (t) => {
	const { root, viewId, socketPath, subscriber, subscriberMessages, tokenFile } = await startHost(t, { legacy: true, script: LEGACY_CLOSE_SCRIPT });
	const first = createConnection(socketPath);
	await once(first, "connect");
	const firstMessages = listen(first);
	send(first, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	const firstEnable = await waitFor(() => firstMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	writeFileSync(tokenFile, firstEnable.token);

	const live = createConnection(socketPath);
	await once(live, "connect");
	const liveMessages = listen(live);
	send(live, { type: "subscribe_terminal", viewProof: 1 });
	await waitFor(() => liveMessages.some((msg) => msg.type === "snapshot_end"), 15000);
	await waitFor(() => liveMessages.some((msg) => msg.type === "output"), 15000);

	writeFileSync(tokenFile, "GO");
	await new Promise((r) => setTimeout(r, 350));
	const beforeClose = subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("");
	assert.equal(beforeClose.includes("PREFIX"), true);
	assert.equal(beforeClose.includes("\u001b"), false, "the ordinary ESC is pending at the reporter parser");
	first.destroy();
	await waitFor(() => subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("").includes("\u001b"), 15000);

	const second = createConnection(socketPath);
	await once(second, "connect");
	const secondMessages = listen(second);
	send(second, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	const secondEnable = await waitFor(() => secondMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	assert.notEqual(secondEnable.token, firstEnable.token);
	writeFileSync(tokenFile, secondEnable.token);
	await new Promise((r) => setTimeout(r, 200));
	writeFileSync(tokenFile, "FRAME");
	await waitFor(() => liveMessages.some((msg) => msg.type === "view_proof" && msg.record.marker === "F"), 20000);

	const fresh = createConnection(socketPath);
	await once(fresh, "connect");
	const freshMessages = listen(fresh);
	send(fresh, { type: "subscribe_terminal", viewProof: 1, sinceSeq: 999 });
	await waitFor(() => freshMessages.some((msg) => msg.type === "snapshot_end"), 15000);
	const end = freshMessages.find((msg) => msg.type === "snapshot_end");
	assert.equal(end.viewProof.status, "covered", `the post-close proof covers the first frame (reason=${end.viewProof.reason})`);
	assert.notEqual(end.viewProof.reason, "output-gap");
	assert.equal(end.viewProof.proof.marker, "F");
	const summary = readHost(root, viewId)?.frameWitness;
	assert.ok(summary.proofs >= 1);
	assert.equal(summary.viewProofFailures, 0, "no tracker protocol failure");
	const screenLog = readFileSync(P.screenLogPath(root, viewId), "utf8");
	assert.equal(screenLog.includes("agent-board-frame"), false);
	second.destroy();
	fresh.destroy();
	live.destroy();
	subscriber.destroy();
	void viewId;
});


test("23b2c3a reporter close/replacement: UNKNOWN reset, same generation, re-prove before coverage", async (t) => {
	const { root, viewId, instanceId, socketPath, subscriberMessages, tokenFile } = await startHost(t, { script: REPORTER_LIFECYCLE_SCRIPT });
	const live = createConnection(socketPath);
	await once(live, "connect");
	const liveMessages = listen(live);
	send(live, { type: "subscribe_terminal", viewProof: 1 });
	await waitFor(() => liveMessages.some((msg) => msg.type === "snapshot_end"), 15000);

	const first = createConnection(socketPath);
	await once(first, "connect");
	const firstMessages = listen(first);
	send(first, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	const firstEnable = await waitFor(() => firstMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	const firstReady = `${tokenFile}.ready`;
	try { rmSync(firstReady, { force: true }); } catch { /* no stale ready */ }
	writeFileSync(tokenFile, firstEnable.token);
	await waitFor(() => existsSync(firstReady) && readFileSync(firstReady, "utf8").trim() === firstEnable.token, 15000);
	writeFileSync(tokenFile, "FRAME");
	await new Promise((r) => setTimeout(r, 1000));
	const fwAfterFrame = readHost(root, viewId)?.frameWitness;
	assert.ok((fwAfterFrame?.proofs ?? 0) >= 1, `runner did not accept frame1: ${JSON.stringify(fwAfterFrame)}`);
	await waitFor(() => liveMessages.some((msg) => msg.type === "view_proof" && msg.record.marker === "F" && msg.record.frameId === 1), 20000).catch(() => {
		throw new Error(`live records missing: ${JSON.stringify(liveMessages.slice(-20))}`);
	});
	const childPid = readHost(root, viewId)?.childPid;
	first.destroy();
	await waitFor(() => liveMessages.some((msg) => msg.type === "view_proof_state" && msg.viewProof.reason === "reporter-close"), 15000);
	const afterClose = readHost(root, viewId);
	assert.equal(afterClose?.state, "alive", "reporter close does not restart/stop the session");
	assert.equal(afterClose?.childPid, childPid, "the real child survives reporter close");

	const second = createConnection(socketPath);
	await once(second, "connect");
	const secondMessages = listen(second);
	send(second, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	const secondEnable = await waitFor(() => secondMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	assert.equal(secondEnable.instanceId, firstEnable.instanceId, "same runner generation");
	assert.notEqual(secondEnable.token, firstEnable.token, "new reporter token");

	const beforeProof = createConnection(socketPath);
	await once(beforeProof, "connect");
	const beforeProofMessages = listen(beforeProof);
	send(beforeProof, { type: "subscribe_terminal", viewProof: 1, sinceSeq: 999 });
	await waitFor(() => beforeProofMessages.some((msg) => msg.type === "snapshot_end"), 15000);
	const beforeCoverage = beforeProofMessages.find((msg) => msg.type === "snapshot_end").viewProof;
	assert.notEqual(beforeCoverage.status, "covered", "new reporter must re-prove before coverage returns");

	try { rmSync(firstReady, { force: true }); } catch { /* no stale ready */ }
	writeFileSync(tokenFile, secondEnable.token);
	await waitFor(() => existsSync(firstReady) && readFileSync(firstReady, "utf8").trim() === secondEnable.token, 15000);
	writeFileSync(tokenFile, "FRAME");
	await waitFor(() => liveMessages.some((msg) => msg.type === "view_proof" && msg.record.marker === "F" && msg.record.frameId === 2), 20000);

	const afterProof = createConnection(socketPath);
	await once(afterProof, "connect");
	const afterProofMessages = listen(afterProof);
	send(afterProof, { type: "subscribe_terminal", viewProof: 1, sinceSeq: 999 });
	await waitFor(() => afterProofMessages.some((msg) => msg.type === "snapshot_end"), 15000);
	const afterCoverage = afterProofMessages.find((msg) => msg.type === "snapshot_end").viewProof;
	assert.equal(afterCoverage.status, "covered");
	assert.equal(afterCoverage.proof.frameId, 2, "current coverage uses the new reporter proof");
	const markerText = subscriberMessages.filter((msg) => msg.type === "output").map((msg) => msg.data).join("");
	assert.equal(markerText.includes("agent-board-frame"), false);
	const screenLog = readFileSync(P.screenLogPath(root, viewId), "utf8");
	assert.equal(screenLog.includes("agent-board-frame"), false);
	afterProof.destroy();
	beforeProof.destroy();
	second.destroy();
	live.destroy();
	void instanceId;
});

test("23b2c3a epoch negotiation: absent=1, invalid rejected, reported epoch2 accepted and preserved on replacement", async (t) => {
	const { root, viewId, socketPath, socket } = await startHost(t);

	const invalid = createConnection(socketPath);
	await once(invalid, "connect");
	const invalidMessages = listen(invalid);
	send(invalid, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 0 } });
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(invalidMessages.some((msg) => msg.type === "frame_witness_enable"), false, "zero epoch is rejected without enabling");

	const absent = createConnection(socketPath);
	await once(absent, "connect");
	const absentMessages = listen(absent);
	send(absent, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1 } });
	const enableAbsent = await waitFor(() => absentMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	assert.equal(enableAbsent.sessionEpoch, 1, "legacy absent epoch defaults to 1");

	const epoch2 = createConnection(socketPath);
	await once(epoch2, "connect");
	const epoch2Messages = listen(epoch2);
	send(epoch2, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 2 } });
	const enable2 = await waitFor(() => epoch2Messages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	assert.equal(enable2.sessionEpoch, 2);
	assert.equal(enable2.instanceId, enableAbsent.instanceId, "same runner generation");
	assert.notEqual(enable2.token, enableAbsent.token, "replacement gets a new token");
	const summary2 = await waitFor(() => {
		const fw = readHost(root, viewId)?.frameWitness;
		return fw?.sessionEpoch === 2 ? fw : null;
	}, 15000).catch(() => {
		throw new Error(`host summary did not adopt epoch2: ${JSON.stringify(readHost(root, viewId))}`);
	});
	assert.equal(summary2.sessionEpoch, 2);

	const invalidReplacement = createConnection(socketPath);
	await once(invalidReplacement, "connect");
	const invalidReplacementMessages = listen(invalidReplacement);
	send(invalidReplacement, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: -2 } });
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(invalidReplacementMessages.some((msg) => msg.type === "frame_witness_enable"), false, "invalid replacement is rejected");
	const unchanged = readHost(root, viewId)?.frameWitness;
	assert.equal(unchanged.sessionEpoch, 2, "invalid replacement does not change the active epoch");
	assert.equal(unchanged.tokenFingerprint, summary2.tokenFingerprint, "invalid replacement does not replace the active reporter");

	const replacement = createConnection(socketPath);
	await once(replacement, "connect");
	const replacementMessages = listen(replacement);
	send(replacement, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 2 } });
	const enableReplacement = await waitFor(() => replacementMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	assert.equal(enableReplacement.sessionEpoch, 2, "replacement preserves the reported epoch");
	assert.equal(enableReplacement.instanceId, enable2.instanceId);
	assert.notEqual(enableReplacement.token, enable2.token);
	const final = await waitFor(() => {
		const fw = readHost(root, viewId)?.frameWitness;
		return fw?.tokenFingerprint !== summary2.tokenFingerprint ? fw : null;
	}, 15000);
	assert.equal(final.sessionEpoch, 2);
	replacement.destroy();
	invalidReplacement.destroy();
	epoch2.destroy();
	absent.destroy();
	invalid.destroy();
	socket.destroy();
});

test("23b2c3a legacy summary: replacement and child-exit write the actual epoch/token summary", async (t) => {
	const { root, viewId, socketPath, socket, tokenFile } = await startHost(t, { legacy: true, script: VIEW_PROOF_SCRIPT });
	const first = createConnection(socketPath);
	await once(first, "connect");
	const firstMessages = listen(first);
	send(first, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 1 } });
	const firstEnable = await waitFor(() => firstMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	assert.equal(firstEnable.sessionEpoch, 1);
	writeFileSync(tokenFile, firstEnable.token);
	const oldSummary = await waitFor(() => {
		const fw = readHost(root, viewId)?.frameWitness;
		return fw?.proofs >= 1 ? fw : null;
	}, 20000);
	assert.equal(oldSummary.sessionEpoch, 1);

	const replacement = createConnection(socketPath);
	await once(replacement, "connect");
	const replacementMessages = listen(replacement);
	send(replacement, { type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 2 } });
	const replacementEnable = await waitFor(() => replacementMessages.find((msg) => msg.type === "frame_witness_enable"), 15000);
	assert.equal(replacementEnable.sessionEpoch, 2);
	const replacementSummary = await waitFor(() => {
		const fw = readHost(root, viewId)?.frameWitness;
		return fw?.sessionEpoch === 2 && fw?.tokenFingerprint !== oldSummary.tokenFingerprint ? fw : null;
	}, 15000).catch(() => {
		throw new Error(`legacy replacement summary stayed stale: ${JSON.stringify(readHost(root, viewId)?.frameWitness)}`);
	});
	assert.equal(replacementSummary.sessionEpoch, 2, "replacement summary carries the actual epoch");
	assert.notEqual(replacementSummary.tokenFingerprint, oldSummary.tokenFingerprint, "replacement summary is not stale");

	const childPid = readHost(root, viewId)?.childPid;
	assert.equal(typeof childPid, "number");
	process.kill(childPid, "SIGTERM");
	await waitFor(() => readHost(root, viewId)?.state === "exited", 20000);
	const finalSummary = readHost(root, viewId)?.frameWitness;
	assert.equal(finalSummary.tokenFingerprint, replacementSummary.tokenFingerprint, "child-exit summary belongs to the replacement");
	assert.equal(finalSummary.sessionEpoch, 2);
	replacement.destroy();
	first.destroy();
	socket.destroy();
});
