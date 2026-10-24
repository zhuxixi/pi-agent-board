import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "../src/runtime/service.mjs";
import { createView, readState, writeState, writeHost, writeHostPid } from "../src/core/store.mjs";
import * as P from "../src/core/paths.mjs";
import { readJsonl } from "../src/core/atomic.mjs";
import { attachWarmHostSweeper } from "../src/core/warm-host-sweeper.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentboard-warmhost-"));
}

function makeService(root, extra = {}) {
	return createService({
		root,
		runnerScript: "/no/runner.mjs",
		piCommand: "pi",
		piArgsPrefix: [],
		defaultCwd: process.cwd(),
		launch: () => ({ pid: null, configPath: "/no/config.json" }),
		launchHost: () => ({ pid: null, configPath: "/no/host-config.json" }),
		launchTitle: () => ({ pid: null, configPath: "/no/title-config.json" }),
		...extra,
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

const waitFor = async (pred, timeoutMs = 10000) => {
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

function wfFixture() {
	const root = mkdtempSync(join(tmpdir(), "agentboard-wf-svc-"));
	const runsDir = join(root, "projects", "proj-1", "runs");
	mkdirSync(runsDir, { recursive: true });
	return { root, runsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeRunningRun(runsDir, root, viewId, { runId = "run-1", status = "running", updatedAt = Date.now() } = {}) {
	writeFileSync(
		join(runsDir, `${runId}.json`),
		JSON.stringify({
			format: "pi-workflow-run-v2",
			index: { runId, status, parentSessionFile: P.sessionFilePath(root, viewId), updatedAt: new Date(updatedAt).toISOString() },
			summary: { checkpoint: null },
		}),
	);
}

test("A8: 有 running 后台 run 的 idle host 不被淘汰；无 run 的仍被淘汰", async () => {
	const root = freshRoot();
	const wf = wfFixture();
	try {
		const protectedId = "view_protected";
		const plainId = "view_plain";
		idleView(root, protectedId);
		idleView(root, plainId);
		writeRunningRun(wf.runsDir, root, protectedId);
		const a = await captureHostSocket(root, protectedId);
		const b = await captureHostSocket(root, plainId);
		makeService(root, { workflowHome: wf.root }).pruneWarmHosts();
		await waitFor(() => b.received.some((m) => m.type === "terminate"), 3000);
		assert.equal(a.received.some((m) => m.type === "terminate"), false);
		assert.equal(b.received.some((m) => m.type === "terminate"), true);
		await closeServer(a.server);
		await closeServer(b.server);
	} finally {
		wf.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A9: 选择后被跳过——复查阶段看到 running run 则不驱逐，并留 warm_prune_during_background_run", async () => {
	const root = freshRoot();
	const id = "view_race";
	try {
		idleView(root, id);
		const sock = await captureHostSocket(root, id);
		// 选择阶段扫不到任何 run；停前复查探针看到刚启动的 run（模拟快照→停止的窗口）
		const service = makeService(root, {
			backgroundRuns: {
				scanBackgroundRuns: () => ({ ok: true, heads: [], error: null }),
				probeBackgroundRun: () => ({ ok: true, running: { runId: "run-late" }, paused: null, error: null }),
			},
		});
		service.pruneWarmHosts();
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(sock.received.some((m) => m.type === "terminate"), false);
		const diags = readJsonl(P.diagnosticsPath(root, id));
		assert.equal(diags.filter((d) => d.code === "warm_prune_during_background_run").length, 1);
		assert.equal(diags.find((d) => d.code === "warm_prune_during_background_run").details.runId, "run-late");
		await closeServer(sock.server);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A10: 探测失败 fail-open（照常 terminate）+ 去重 warn 诊断", async () => {
	const root = freshRoot();
	const id = "view_probe_fail";
	try {
		idleView(root, id);
		const sock = await captureHostSocket(root, id);
		const failing = {
			scanBackgroundRuns: () => ({ ok: false, heads: [], error: "EACCES" }),
			probeBackgroundRun: () => ({ ok: false, running: null, paused: null, error: "EACCES" }),
		};
		const service = makeService(root, { backgroundRuns: failing });
		service.pruneWarmHosts();
		await waitFor(() => sock.received.some((m) => m.type === "terminate"), 3000);
		assert.equal(sock.received.some((m) => m.type === "terminate"), true);
		const diags = readJsonl(P.diagnosticsPath(root, id));
		assert.equal(diags.filter((d) => d.code === "warm_prune_probe_failed").length, 1);
		await closeServer(sock.server);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A11: AGENT_BOARD_NO_BACKGROUND_RUN_GUARD=1 回到今天的行为", async () => {
	const root = freshRoot();
	const wf = wfFixture();
	const prev = process.env.AGENT_BOARD_NO_BACKGROUND_RUN_GUARD;
	try {
		process.env.AGENT_BOARD_NO_BACKGROUND_RUN_GUARD = "1";
		const id = "view_guard_off";
		idleView(root, id);
		writeRunningRun(wf.runsDir, root, id);
		const sock = await captureHostSocket(root, id);
		makeService(root, { workflowHome: wf.root }).pruneWarmHosts();
		await waitFor(() => sock.received.some((m) => m.type === "terminate"), 3000);
		assert.equal(sock.received.some((m) => m.type === "terminate"), true);
		await closeServer(sock.server);
	} finally {
		if (prev === undefined) delete process.env.AGENT_BOARD_NO_BACKGROUND_RUN_GUARD;
		else process.env.AGENT_BOARD_NO_BACKGROUND_RUN_GUARD = prev;
		wf.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});
