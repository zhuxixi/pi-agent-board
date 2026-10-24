import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService, NOTICE_FLIP_GRACE_MS } from "../src/runtime/service.mjs";
import { createView, readState, writeHost, writeState } from "../src/core/store.mjs";
import { readJsonl } from "../src/core/atomic.mjs";
import { appendDiagnostic } from "../src/core/diagnostics.mjs";
import * as P from "../src/core/paths.mjs";

const makeService = (root, extra = {}) =>
	createService({ root, runnerScript: "/no/runner.mjs", piCommand: "pi", piArgsPrefix: [], defaultCwd: process.cwd(), ...extra });

function deadHostRow(root, id, { paused = true, endedAt = Date.now() - 60_000 } = {}) {
	const wf = mkdtempSync(join(tmpdir(), "agentboard-notice-"));
	const runsDir = join(wf, "projects", "p", "runs");
	mkdirSync(runsDir, { recursive: true });
	createView(root, { id, name: id, cwd: "/r" });
	const s = readState(root, id);
	// 生产真实态：turn 已结束、run 已终态，宿主随后死亡
	s.semanticState = "idle";
	s.processState = "exited";
	s.currentRunId = null;
	s.summary = "Turn finished";
	writeState(root, s);
	writeHost(root, { viewId: id, mode: "pty", state: "exited", runnerPid: null, startedAt: Date.now() - 3_600_000, endedAt, exitCode: 0, attachedClients: 0, lastSeenAt: Date.now() });
	writeFileSync(
		join(runsDir, "run-9.json"),
		JSON.stringify({
			format: "pi-workflow-run-v2",
			index: {
				runId: "run-9",
				status: paused ? "paused" : "completed",
				parentSessionFile: P.sessionFilePath(root, id),
				updatedAt: new Date(Date.now() - 90_000).toISOString(),
			},
			summary: { checkpoint: { checkpointId: "cp1", kind: "manual", status: "pending" } },
		}),
	);
	return { wf, cleanup: () => rmSync(wf, { recursive: true, force: true }) };
}

test("A12: 生产真实态的死宿主 + paused run -> summary 写入提示，诊断恰一条", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-root-"));
	const fx = deadHostRow(root, "view_notice");
	try {
		const service = makeService(root, { workflowHome: fx.wf, sendStateCommand: async () => ({ status: "rejected", reason: "coordinator_disabled" }) });
		await service.reconcile();
		const s = readState(root, "view_notice");
		assert.equal(s.summary, "Background workflow run-9 was interrupted — resume it from this session");
		const diags = readJsonl(P.diagnosticsPath(root, "view_notice"));
		const interrupted = diags.filter((d) => d.code === "background_run_interrupted");
		assert.equal(interrupted.length, 1);
		assert.equal(interrupted[0].details.runId, "run-9");
		assert.equal(interrupted[0].details.hostState, "exited");
		assert.equal(interrupted[0].details.exitCode, 0);
		await service.reconcile();
		assert.equal(readState(root, "view_notice").summary, s.summary);
		assert.equal(readJsonl(P.diagnosticsPath(root, "view_notice")).filter((d) => d.code === "background_run_interrupted").length, 1);
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: completed run（非 paused）不写提示", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-root2-"));
	const fx = deadHostRow(root, "view_done", { paused: false });
	try {
		const service = makeService(root, { workflowHome: fx.wf, sendStateCommand: async () => ({ status: "rejected", reason: "coordinator_disabled" }) });
		await service.reconcile();
		assert.equal(readState(root, "view_done").summary, "Turn finished");
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: 探针失败不记 memo —— 恢复后下一个 tick 仍能写提示", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-root3-"));
	const fx = deadHostRow(root, "view_retry");
	try {
		let calls = 0;
		const flaky = {
			scanBackgroundRuns: () => ({ ok: true, heads: [], error: null }),
			probeBackgroundRun: () => {
				calls += 1;
				if (calls === 1) return { ok: false, running: null, paused: null, error: "EACCES" };
				return { ok: true, running: null, paused: { runId: "run-9" }, error: null };
			},
		};
		const service = makeService(root, { backgroundRuns: flaky, sendStateCommand: async () => ({ status: "rejected", reason: "coordinator_disabled" }) });
		await service.reconcile();
		assert.equal(readState(root, "view_retry").summary, "Turn finished");
		await service.reconcile();
		assert.match(readState(root, "view_retry").summary, /run-9/);
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: 协调器 applied 路径 —— 发送 patch_fields 命令且未走直写", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-applied-"));
	const fx = deadHostRow(root, "view_applied");
	try {
		const commands = [];
		const service = makeService(root, {
			workflowHome: fx.wf,
			sendStateCommand: async (_root, command) => {
				commands.push(command);
				return { status: "applied", reason: null };
			},
		});
		await service.reconcile();
		assert.equal(commands.length, 1);
		const command = commands[0];
		assert.equal(command.kind, "patch_fields");
		assert.equal(command.source, "service");
		assert.equal(command.viewId, "view_applied");
		assert.equal(command.payload.state.summary, "Background workflow run-9 was interrupted — resume it from this session");
		assert.equal(readState(root, "view_applied").summary, "Turn finished");
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: manual_fence 拒绝后仍写诊断、summary 不变", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-fence-"));
	const fx = deadHostRow(root, "view_fence");
	try {
		const s = readState(root, "view_fence");
		s.semanticState = "completed";
		s.autoState = null;
		s.summary = "Turn finished";
		writeState(root, s);
		const service = makeService(root, {
			workflowHome: fx.wf,
			sendStateCommand: async () => ({ status: "rejected", reason: "manual_fence" }),
		});
		await service.reconcile();
		assert.equal(readState(root, "view_fence").summary, "Turn finished");
		const diags = readJsonl(P.diagnosticsPath(root, "view_fence"));
		assert.equal(diags.filter((d) => d.code === "background_run_interrupted").length, 1);
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: running→paused 在 grace 窗口内 —— 第二个 tick 写提示且探测两次", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-flip-"));
	const fx = deadHostRow(root, "view_flip", { endedAt: Date.now() });
	try {
		let calls = 0;
		const flipping = {
			scanBackgroundRuns: () => ({ ok: true, heads: [], error: null }),
			probeBackgroundRun: () => {
				calls += 1;
				if (calls === 1) return { ok: true, running: { runId: "run-9" }, paused: null, error: null };
				return { ok: true, running: null, paused: { runId: "run-9" }, error: null };
			},
		};
		const service = makeService(root, { backgroundRuns: flipping, sendStateCommand: async () => ({ status: "rejected", reason: "coordinator_disabled" }) });
		await service.reconcile();
		assert.equal(readState(root, "view_flip").summary, "Turn finished");
		await service.reconcile();
		assert.match(readState(root, "view_flip").summary, /run-9/);
		assert.equal(calls, 2);
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: grace 过期后 running 记录只探测一次且不写提示", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-stuck-running-"));
	const fx = deadHostRow(root, "view_stuck_running", { endedAt: Date.now() - NOTICE_FLIP_GRACE_MS - 60_000 });
	try {
		let calls = 0;
		const alwaysRunning = {
			scanBackgroundRuns: () => ({ ok: true, heads: [], error: null }),
			probeBackgroundRun: () => {
				calls += 1;
				return { ok: true, running: { runId: "run-9" }, paused: null, error: null };
			},
		};
		const service = makeService(root, { backgroundRuns: alwaysRunning, sendStateCommand: async () => ({ status: "rejected", reason: "coordinator_disabled" }) });
		await service.reconcile();
		await service.reconcile();
		assert.equal(calls, 1);
		assert.equal(readState(root, "view_stuck_running").summary, "Turn finished");
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: 共存 running + 旧 paused 不关闭 grace 窗口 —— 两个 tick 依次写 run-8、run-9 且探测两次", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-coexist-"));
	const fx = deadHostRow(root, "view_coexist", { endedAt: Date.now() });
	try {
		let calls = 0;
		const coexisting = {
			scanBackgroundRuns: () => ({ ok: true, heads: [], error: null }),
			probeBackgroundRun: () => {
				calls += 1;
				if (calls === 1) return { ok: true, running: { runId: "run-9" }, paused: { runId: "run-8" }, error: null };
				return { ok: true, running: null, paused: { runId: "run-9" }, error: null };
			},
		};
		const service = makeService(root, { backgroundRuns: coexisting, sendStateCommand: async () => ({ status: "rejected", reason: "coordinator_disabled" }) });
		await service.reconcile();
		assert.equal(readState(root, "view_coexist").summary, "Background workflow run-8 was interrupted — resume it from this session");
		await service.reconcile();
		assert.equal(readState(root, "view_coexist").summary, "Background workflow run-9 was interrupted — resume it from this session");
		assert.equal(calls, 2);
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: 已通告的同一 run 仍探测一次但不再写 summary、不追加第二条诊断", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-already-"));
	const fx = deadHostRow(root, "view_already");
	try {
		const s = readState(root, "view_already");
		s.summary = "Background workflow run-9 was interrupted — resume it from this session";
		writeState(root, s);
		appendDiagnostic(root, "view_already", {
			source: "service",
			level: "warn",
			code: "background_run_interrupted",
			message: "Background workflow run-9 was interrupted when its host died",
			details: { runId: "run-9", hostState: "exited", exitCode: 0 },
		});
		let calls = 0;
		const spying = {
			scanBackgroundRuns: () => ({ ok: true, heads: [], error: null }),
			probeBackgroundRun: () => {
				calls += 1;
				return { ok: true, running: null, paused: { runId: "run-9" }, error: null };
			},
		};
		const service = makeService(root, { backgroundRuns: spying, sendStateCommand: async () => ({ status: "rejected", reason: "coordinator_disabled" }) });
		await service.reconcile();
		assert.equal(calls, 1);
		assert.equal(readState(root, "view_already").summary, "Background workflow run-9 was interrupted — resume it from this session");
		const interrupted = readJsonl(P.diagnosticsPath(root, "view_already")).filter((d) => d.code === "background_run_interrupted");
		assert.equal(interrupted.length, 1);
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: 旧 run 的已通告 summary 不隐藏新 runId —— summary 换成 run-2 且每 run 一条诊断", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentboard-notice-second-run-"));
	const fx = deadHostRow(root, "view_second_run");
	try {
		const s = readState(root, "view_second_run");
		s.summary = "Background workflow run-1 was interrupted — resume it from this session";
		writeState(root, s);
		appendDiagnostic(root, "view_second_run", {
			source: "service",
			level: "warn",
			code: "background_run_interrupted",
			message: "Background workflow run-1 was interrupted when its host died",
			details: { runId: "run-1", hostState: "exited", exitCode: 0 },
		});
		const service = makeService(root, {
			backgroundRuns: {
				scanBackgroundRuns: () => ({ ok: true, heads: [], error: null }),
				probeBackgroundRun: () => ({ ok: true, running: null, paused: { runId: "run-2" }, error: null }),
			},
			sendStateCommand: async () => ({ status: "rejected", reason: "coordinator_disabled" }),
		});
		await service.reconcile();
		assert.equal(readState(root, "view_second_run").summary, "Background workflow run-2 was interrupted — resume it from this session");
		const interrupted = readJsonl(P.diagnosticsPath(root, "view_second_run")).filter((d) => d.code === "background_run_interrupted");
		assert.equal(interrupted.length, 2);
		assert.deepEqual(interrupted.map((d) => d.details.runId).sort(), ["run-1", "run-2"]);
	} finally {
		fx.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});
