import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeHost } from "../src/core/host-probe.mjs";

function freshDir() {
	return mkdtempSync(join(tmpdir(), "agentview-host-probe-"));
}

/** Fake control socket that replies to any inbound line with `line`. */
function replyServer(replyLine) {
	return new Promise((resolveReady) => {
		const server = createServer((socket) => {
			socket.on("data", () => {
				socket.write(replyLine.endsWith("\n") ? replyLine : `${replyLine}\n`);
			});
			socket.on("error", () => {});
		});
		server.listen(0, "127.0.0.1", () => resolveReady(server));
	});
}

async function withReplyServer(replyLine, fn) {
	const server = await replyServer(replyLine);
	try {
		return await fn({ host: server.address().host, port: server.address().port });
	} finally {
		await new Promise((r) => server.close(r));
	}
}

test("probeHost classifies a ready host from a real socket", async () => {
	await withReplyServer(
		'{"type":"hello","status":{"viewId":"v1","instanceId":"i1","state":"alive","readyAt":123}}',
		async ({ host, port }) => {
			const res = await probeHost({ host, port }, { expectedViewId: "v1", expectedInstanceId: "i1" });
			assert.equal(res.classification, "ready");
			assert.equal(res.ready, true);
			assert.equal(res.connected, true);
			assert.equal(res.viewId, "v1");
			assert.equal(res.errorCode, null);
		},
	);
});

test("probeHost classifies a starting host", async () => {
	await withReplyServer(
		'{"type":"hello","status":{"viewId":"v1","instanceId":"i1","state":"starting","readyAt":null}}',
		async ({ host, port }) => {
			const res = await probeHost({ host, port }, { expectedViewId: "v1", expectedInstanceId: "i1" });
			assert.equal(res.classification, "starting");
			assert.equal(res.ready, false);
		},
	);
});

test("probeHost classifies a foreign instance as occupied", async () => {
	await withReplyServer(
		'{"type":"hello","status":{"viewId":"v1","instanceId":"i1","state":"alive","readyAt":123}}',
		async ({ host, port }) => {
			const res = await probeHost({ host, port }, { expectedViewId: "v1", expectedInstanceId: "i2" });
			assert.equal(res.classification, "occupied");
		},
	);
});

test("legacy probe without expectedInstanceId synthesizes ready for alive hosts", async () => {
	await withReplyServer(
		'{"type":"hello","status":{"viewId":"v1","state":"alive"}}',
		async ({ host, port }) => {
			const res = await probeHost({ host, port }, { expectedViewId: "v1", expectedInstanceId: null });
			assert.equal(res.classification, "ready");
			assert.equal(res.ready, true);
		},
	);
});

test("probeHost maps a nonexistent path to missing", async () => {
	const dir = freshDir();
	try {
		const res = await probeHost(join(dir, "no-such.sock"));
		assert.equal(res.classification, "missing");
		assert.equal(res.connected, false);
		assert.equal(res.errorCode, "ENOENT");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("probeHost classifies a plain file as unknown (not stale)", async () => {
	const dir = freshDir();
	try {
		const file = join(dir, "plain.sock");
		writeFileSync(file, "not a socket");
		const res = await probeHost(file, { timeoutMs: 1000 });
		assert.equal(res.connected, false);
		assert.equal(res.classification, "unknown");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("probeHost returns unknown/TIMEOUT when connect never completes", async () => {
	const fake = new EventEmitter();
	fake.destroy = () => {};
	const res = await probeHost("ignored", {
		timeoutMs: 80,
		connect: () => fake,
	});
	assert.equal(res.classification, "unknown");
	assert.equal(res.errorCode, "TIMEOUT");
});

test("AGENT_BOARD_TEST_HOST_PROBE_TIMEOUT_MS shortens the probe timeout", async () => {
	/** A socket-like emitter that never connects and ignores writes. */
	const deadSocket = () => {
		const fake = new EventEmitter();
		fake.destroy = () => {};
		return fake;
	};
	const original = process.env.AGENT_BOARD_TEST_HOST_PROBE_TIMEOUT_MS;
	try {
		process.env.AGENT_BOARD_TEST_HOST_PROBE_TIMEOUT_MS = "1";
		const knobbedStart = Date.now();
		const knobbed = await probeHost("ignored", { connect: deadSocket });
		const knobbedElapsed = Date.now() - knobbedStart;
		assert.equal(knobbed.errorCode, "TIMEOUT");

		// Unset, the same probe waits out the production default (250ms) — so the
		// knob, not the connect injection, is what shortened the budget above.
		delete process.env.AGENT_BOARD_TEST_HOST_PROBE_TIMEOUT_MS;
		const defaultStart = Date.now();
		const fallback = await probeHost("ignored", { connect: deadSocket });
		const defaultElapsed = Date.now() - defaultStart;
		assert.equal(fallback.errorCode, "TIMEOUT");
		assert.ok(defaultElapsed >= 200, `unset knob keeps the 250ms default (${defaultElapsed}ms)`);
		assert.ok(knobbedElapsed < defaultElapsed, `knob=1 (${knobbedElapsed}ms) resolves before the default (${defaultElapsed}ms)`);
		assert.ok(knobbedElapsed < 100, `knob=1 shortened the probe (${knobbedElapsed}ms)`);
	} finally {
		if (original === undefined) delete process.env.AGENT_BOARD_TEST_HOST_PROBE_TIMEOUT_MS;
		else process.env.AGENT_BOARD_TEST_HOST_PROBE_TIMEOUT_MS = original;
	}
});

test("probeHost always destroys the probe socket (error path)", async () => {
	let destroyed = false;
	const fake = new EventEmitter();
	fake.destroy = () => {
		destroyed = true;
	};
	const res = await probeHost("ignored", {
		timeoutMs: 50,
		connect: () => fake,
	});
	assert.equal(destroyed, true);
	assert.equal(res.errorCode, "TIMEOUT");
});

test("probeHost with invalid JSON reply is unknown and destroyed", async () => {
	await withReplyServer("this is not json", async ({ host, port }) => {
		const res = await probeHost({ host, port }, { timeoutMs: 2000 });
		assert.equal(res.classification, "unknown");
		assert.equal(res.protocolValid, false);
	});
});

test("socket emit connect but no status payload is not protocol valid", async () => {
	await withReplyServer('{"type":"hello"}', async ({ host, port }) => {
		const res = await probeHost({ host, port }, { timeoutMs: 2000 });
		assert.equal(res.classification, "unknown");
		assert.equal(res.protocolValid, false);
	});
});
