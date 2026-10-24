import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "../src/runtime/service.mjs";
import { createView, readState, writeHost, writeState } from "../src/core/store.mjs";
import { readJsonl } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";

const makeService = (root, extra = {}) =>
	createService({ root, runnerScript: "/no/runner.mjs", piCommand: "pi", piArgsPrefix: [], defaultCwd: process.cwd(), ...extra });

function deadHostRow(root, id, { paused = true } = {}) {
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
	writeHost(root, { viewId: id, mode: "pty", state: "exited", runnerPid: null, startedAt: Date.now() - 3_600_000, endedAt: Date.now() - 60_000, exitCode: 0, attachedClients: 0, lastSeenAt: Date.now() });
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
