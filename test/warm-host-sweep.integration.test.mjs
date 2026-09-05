import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "../src/runtime/service.mjs";
import { createView, readState, writeState, writeHost, writeHostPid } from "../src/core/store.mjs";
import * as P from "../src/core/paths.mjs";
import { attachWarmHostSweeper } from "../src/core/warm-host-sweeper.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentboard-warmhost-"));
}

function makeService(root) {
	return createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: process.cwd(),
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
	});
}

/** 起一个监听 viewId socketPath 的 net server，返回 { server, received } */
async function captureHostSocket(root, viewId) {
	const received = [];
	const server = createServer((socket) => {
		let buf = "";
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			for (const line of buf.split("\n")) {
				if (!line.trim()) continue;
				try { received.push(JSON.parse(line)); } catch { /* ignore */ }
			}
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(P.controlSocketPath(root, viewId), resolve);
	});
	return { server, received };
}

const closeServer = (s) => new Promise((resolve) => s.close(resolve));

const waitFor = async (pred, timeoutMs = 3000) => {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return pred();
};

function idleView(root, id) {
	createView(root, { id, name: id, cwd: "/r" });
	const s = readState(root, id);
	s.semanticState = "completed";
	s.processState = "exited";
	s.lastActivityAt = Date.now() - 3600_000;
	writeState(root, s);
	writeHost(root, {
		viewId: id,
		mode: "pty",
		state: "alive",
		runnerPid: process.pid, // hostAlive 判定用（isAlive(process.pid)=true）
		socketPath: P.controlSocketPath(root, id),
		startedAt: Date.now() - 3600_000,
		attachedClients: 0,
		lastSeenAt: Date.now(),
	});
	writeHostPid(root, id, process.pid);
}

test("A6: 手动 sweep 后 idle host 收到 terminate（busy 由独立测试覆盖）", async () => {
	const root = freshRoot();
	const oldTtl = process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
	const oldGrace = process.env.AGENT_BOARD_WARM_HOST_GRACE_MS;
	process.env.AGENT_BOARD_WARM_HOST_TTL_MS = "1"; // 立即过期
	process.env.AGENT_BOARD_WARM_HOST_GRACE_MS = "0";
	try {
		idleView(root, "idle1");
		const { server, received } = await captureHostSocket(root, "idle1");
		const svc = makeService(root);
		svc.pruneWarmHosts();
		const got = await waitFor(() => received.some((m) => m.type === "terminate"));
		assert.equal(got, true, "idle host 应收到 terminate");
		await closeServer(server);
	} finally {
		if (oldTtl === undefined) delete process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
		else process.env.AGENT_BOARD_WARM_HOST_TTL_MS = oldTtl;
		if (oldGrace === undefined) delete process.env.AGENT_BOARD_WARM_HOST_GRACE_MS;
		else process.env.AGENT_BOARD_WARM_HOST_GRACE_MS = oldGrace;
		rmSync(root, { recursive: true, force: true });
	}
});

test("A6: busy host 不被 sweep 触碰", async () => {
	const root = freshRoot();
	const oldTtl = process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
	process.env.AGENT_BOARD_WARM_HOST_TTL_MS = "1";
	try {
		createView(root, { id: "busy1", name: "busy1", cwd: "/r" });
		const s = readState(root, "busy1");
		s.semanticState = "working";
		s.processState = "alive";
		s.lastActivityAt = Date.now() - 3600_000;
		writeState(root, s);
		writeHost(root, {
			viewId: "busy1", mode: "pty", state: "alive", runnerPid: process.pid,
			socketPath: P.controlSocketPath(root, "busy1"),
			startedAt: Date.now() - 3600_000, attachedClients: 0, lastSeenAt: Date.now(),
		});
		writeHostPid(root, "busy1", process.pid);
		const { server, received } = await captureHostSocket(root, "busy1");
		const svc = makeService(root);
		svc.pruneWarmHosts();
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(received.some((m) => m.type === "terminate"), false, "busy host 不得收 terminate");
		await closeServer(server);
	} finally {
		if (oldTtl === undefined) delete process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
		else process.env.AGENT_BOARD_WARM_HOST_TTL_MS = oldTtl;
		rmSync(root, { recursive: true, force: true });
	}
});

test("A7: session_shutdown 触发 sweepNow（lifecycle 接线端到端）", async () => {
	const root = freshRoot();
	const oldTtl = process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
	const oldGrace = process.env.AGENT_BOARD_WARM_HOST_GRACE_MS;
	process.env.AGENT_BOARD_WARM_HOST_TTL_MS = "1";
	process.env.AGENT_BOARD_WARM_HOST_GRACE_MS = "0";
	try {
		idleView(root, "idle2");
		const { server, received } = await captureHostSocket(root, "idle2");
		const events = {};
		const fakePi = { on: (ev, fn) => { events[ev] = fn; } };
		const svc = makeService(root);
		const attached = attachWarmHostSweeper(fakePi, {
			isHostedChild: false,
			sweep: () => svc.pruneWarmHosts(),
			intervalMs: 0,
		});
		// 启动即 sweep 已发 terminate（A6）；验证 shutdown 再次 sweep（幂等 terminate 无害）
		const got1 = await waitFor(() => received.some((m) => m.type === "terminate"));
		assert.equal(got1, true);
		received.length = 0;
		events.session_shutdown();
		const got2 = await waitFor(() => received.some((m) => m.type === "terminate"));
		assert.equal(got2, true, "shutdown sweep 应再次发 terminate");
		attached.dispose();
		await closeServer(server);
	} finally {
		if (oldTtl === undefined) delete process.env.AGENT_BOARD_WARM_HOST_TTL_MS;
		else process.env.AGENT_BOARD_WARM_HOST_TTL_MS = oldTtl;
		if (oldGrace === undefined) delete process.env.AGENT_BOARD_WARM_HOST_GRACE_MS;
		else process.env.AGENT_BOARD_WARM_HOST_GRACE_MS = oldGrace;
		rmSync(root, { recursive: true, force: true });
	}
});
