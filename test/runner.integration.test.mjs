import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { readCodeRefs } from "../src/core/code-refs-store.mjs";
import { launchRun } from "../src/core/launch.mjs";
import { isAlive } from "../src/core/pid.mjs";
import * as P from "../src/core/paths.mjs";
import { rowView } from "../src/core/rows.mjs";
import { createView, loadRow, readPid, readState, readStatus } from "../src/core/store.mjs";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = join(ROOT_DIR, "runner", "job-runner.mjs");
const FAKE_PI = join(ROOT_DIR, "test-support", "fake-pi.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether `git` is available on PATH (code-refs extraction shells out to it). */
function gitAvailable() {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

/** Temp git repo whose origin remote is github.com, so code-refs matches the github provider. */
function makeGithubRepo() {
	const dir = mkdtempSync(join(tmpdir(), "agentview-refs-repo-"));
	execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore", windowsHide: true });
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/zhuxixi/pi-agent-board.git"], { stdio: "ignore", windowsHide: true });
	return dir;
}

/** Kill a detached runner before deleting its root so it can never orphan (issue #33). */
async function killDetached(pid) {
	if (!pid || pid <= 0) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return; // already exited
	}
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		await sleep(50);
		try {
			process.kill(pid, 0);
		} catch {
			return; // exited
		}
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

/** Poll `fn()` until it returns truthy or timeout. */
async function waitFor(fn, timeoutMs = 15000, intervalMs = 50) {
	const start = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() - start > timeoutMs) return null;
		await sleep(intervalMs);
	}
}

function makeConfig(root, viewId, runId, sessionFile, cwd, prompt) {
	return {
		root,
		viewId,
		runId,
		kind: "dispatch",
		sessionFile,
		cwd,
		prompt,
		piCommand: process.execPath, // node ...
		piArgsPrefix: [FAKE_PI], // ... fake-pi.mjs
		model: null,
		tools: null,
	};
}

test("runner auto-classifies a completed fake worker and writes durable artifacts", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-"));
	const env = { ...process.env };
	process.env.FAKE_PI_MODE = "completed";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	process.env.AGENT_BOARD_AUTO_STATE_NO_DONE = "0";
	let runnerPid = null;
	try {
		const meta = createView(root, { id: "view_1", name: "fix", cwd: root });
		const config = makeConfig(root, "view_1", "run_1", meta.sessionFile, root, "fix the bug");

		// link the current run into state so loadRow can find pid
		const st = readState(root, "view_1");
		st.currentRunId = "run_1";
		const { writeState } = await import("../src/core/store.mjs");
		writeState(root, st);

		runnerPid = launchRun(root, config, { runnerScript: RUNNER }).pid;
		assert.ok(runnerPid && runnerPid > 0, "runner spawned");

		const status = await waitFor(() => {
			const s = readStatus(root, "view_1", "run_1");
			return s && s.endedAt && s.semanticState === "completed" ? s : null;
		});
		assert.ok(status, "status reached terminal state");
		assert.equal(status.semanticState, "completed");
		assert.equal(status.processState, "exited");
		assert.equal(status.exitCode, 0);
		assert.ok(status.toolCount >= 1, "saw a tool execution");
		assert.match(status.latestAssistantPreview, /token expiry/i);
		assert.ok(status.summary.length > 0, "has a summary");

		assert.ok(existsSync(P.eventsPath(root, "view_1", "run_1")), "events.jsonl exists");
		assert.ok(existsSync(meta.sessionFile), "fake worker persisted the session file");

		const state = readState(root, "view_1");
		assert.equal(state.semanticState, "completed");
		assert.equal(state.autoState?.kind, "done");
		assert.equal(state.currentRunId, "run_1");
	} finally {
		await killDetached(runnerPid);
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		delete process.env.AGENT_BOARD_AUTO_STATE_NO_DONE;
		Object.assign(process.env, { AGENT_BOARD_SUMMARY_MODEL: env.AGENT_BOARD_SUMMARY_MODEL });
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("runner classifies a question as needs_input", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-ni-"));
	process.env.FAKE_PI_MODE = "needs_input";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	let runnerPid = null;
	try {
		const meta = createView(root, { id: "v", name: "x", cwd: root });
		const config = makeConfig(root, "v", "r", meta.sessionFile, root, "do it");
		runnerPid = launchRun(root, config, { runnerScript: RUNNER }).pid;
		const status = await waitFor(() => {
			const s = readStatus(root, "v", "r");
			return s && s.endedAt ? s : null;
		});
		assert.ok(status);
		assert.equal(status.semanticState, "needs_input");
		assert.ok(status.question, "extracted a question");
	} finally {
		await killDetached(runnerPid);
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("runner protects dash-prefixed prompts passed via argv", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-dash-"));
	process.env.FAKE_PI_MODE = "completed";
	process.env.FAKE_PI_FAIL_ON_DASH_PROMPT = "1";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	process.env.AGENT_BOARD_AUTO_STATE_NO_DONE = "0";
	let runnerPid = null;
	try {
		const meta = createView(root, { id: "v", name: "x", cwd: root });
		const config = makeConfig(root, "v", "r", meta.sessionFile, root, "- Create a ticket");
		runnerPid = launchRun(root, config, { runnerScript: RUNNER }).pid;
		const status = await waitFor(() => {
			const s = readStatus(root, "v", "r");
			return s && s.endedAt && s.semanticState === "completed" ? s : null;
		});
		assert.ok(status);
		assert.equal(status.semanticState, "completed");
		assert.equal(status.exitCode, 0);
	} finally {
		await killDetached(runnerPid);
		delete process.env.FAKE_PI_MODE;
		delete process.env.FAKE_PI_FAIL_ON_DASH_PROMPT;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		delete process.env.AGENT_BOARD_AUTO_STATE_NO_DONE;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("runner marks failed when the worker exits nonzero", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-fail-"));
	process.env.FAKE_PI_MODE = "fail";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	let runnerPid = null;
	try {
		const meta = createView(root, { id: "v", name: "x", cwd: root });
		const config = makeConfig(root, "v", "r", meta.sessionFile, root, "do it");
		runnerPid = launchRun(root, config, { runnerScript: RUNNER }).pid;
		const status = await waitFor(() => {
			const s = readStatus(root, "v", "r");
			return s && s.endedAt ? s : null;
		});
		assert.ok(status);
		assert.equal(status.semanticState, "failed");
		assert.notEqual(status.exitCode, 0);
	} finally {
		await killDetached(runnerPid);
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("stopping the runner finalizes the run as stopped", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-stop-"));
	process.env.FAKE_PI_MODE = "hang";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	let runnerPid = null;
	try {
		const meta = createView(root, { id: "v", name: "x", cwd: root });
		const config = makeConfig(root, "v", "r", meta.sessionFile, root, "do it");
		runnerPid = launchRun(root, config, { runnerScript: RUNNER }).pid;

		// Wait until the worker is actively running.
		const working = await waitFor(() => {
			const s = readStatus(root, "v", "r");
			return s && s.semanticState === "working" ? s : null;
		});
		assert.ok(working, "run reached working");

		const pid = readPid(root, "v", "r");
		assert.ok(pid, "have runner pid");
		process.kill(pid, "SIGTERM");

		const status = await waitFor(() => {
			const s = readStatus(root, "v", "r");
			return s && s.endedAt ? s : null;
		});
		assert.ok(status, "run finalized after stop");
		assert.equal(status.semanticState, "stopped");
	} finally {
		await killDetached(runnerPid);
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("runner keeps a completed fake worker idle when auto-done is disabled", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-nodone-"));
	process.env.FAKE_PI_MODE = "completed";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	delete process.env.AGENT_BOARD_AUTO_STATE_NO_DONE;
	let runnerPid = null;
	try {
		const meta = createView(root, { id: "view_1", name: "fix", cwd: root });
		const config = makeConfig(root, "view_1", "run_1", meta.sessionFile, root, "fix the bug");
		const st = readState(root, "view_1");
		st.currentRunId = "run_1";
		const { writeState } = await import("../src/core/store.mjs");
		writeState(root, st);
		runnerPid = launchRun(root, config, { runnerScript: RUNNER }).pid;
		assert.ok(runnerPid && runnerPid > 0, "runner spawned");
		const status = await waitFor(() => {
			const s = readStatus(root, "view_1", "run_1");
			// endedAt alone is not enough: autoState is written asynchronously by the
			// state runner, so wait for both before asserting on autoState.kind.
			return s && s.endedAt && s.autoState ? s : null;
		});
		assert.ok(status, "status reached terminal state");
		assert.equal(status.semanticState, "idle");
		assert.equal(status.processState, "exited");
		assert.equal(status.autoState?.kind, "in_progress");
	} finally {
		await killDetached(runnerPid);
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("runner extracts github issue/pr refs end-to-end into github.json and the row badge", { timeout: 20000, skip: !gitAvailable() }, async () => {
	const boardRoot = mkdtempSync(join(tmpdir(), "agentview-refs-"));
	const repo = makeGithubRepo();
	process.env.FAKE_PI_MODE = "github-refs";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	process.env.AGENT_BOARD_AUTO_STATE_NO_DONE = "0";
	let runnerPid = null;
	try {
		const meta = createView(boardRoot, { id: "view_1", name: "fix", cwd: repo });
		const config = makeConfig(boardRoot, "view_1", "run_1", meta.sessionFile, repo, "assign issue 40 and open a PR");
		const st = readState(boardRoot, "view_1");
		st.currentRunId = "run_1";
		const { writeState } = await import("../src/core/store.mjs");
		writeState(boardRoot, st);

		runnerPid = launchRun(boardRoot, config, { runnerScript: RUNNER }).pid;
		assert.ok(runnerPid && runnerPid > 0, "runner spawned");

		const status = await waitFor(() => {
			const s = readStatus(boardRoot, "view_1", "run_1");
			return s && s.endedAt ? s : null;
		});
		assert.ok(status, "status reached terminal state");
		// The runner persists endedAt first, then persists again after the
		// heuristic auto-state upgrade (completed). Asserting right after
		// endedAt races the second persist (CI Node 22 caught semanticState
		// still "idle"). The runner's process exit is the deterministic
		// barrier: the finalize chain completes before process.exit.
		await waitFor(() => (isAlive(runnerPid) ? null : true));
		const settled = readStatus(boardRoot, "view_1", "run_1");
		assert.equal(settled.semanticState, "completed");

		// github.json artifact: issue 40 claim + pr 45 action.
		const snap = readCodeRefs(boardRoot, "view_1");
		assert.equal(snap.provider, "github");
		assert.equal(snap.issue?.number, 40);
		assert.equal(snap.issue?.strength, "claim");
		assert.equal(snap.pr?.number, 45);
		assert.equal(snap.pr?.strength, "action");
		assert.equal(snap.pr?.url, "https://github.com/zhuxixi/pi-agent-board/pull/45");

		// Row badge from the per-view artifact.
		const row = loadRow(boardRoot, "view_1");
		assert.ok(row, "row loads");
		assert.equal(rowView(row).refsBadge, "#40 ▸#45");
	} finally {
		await killDetached(runnerPid);
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		delete process.env.AGENT_BOARD_AUTO_STATE_NO_DONE;
		rmSync(boardRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

test("runner does not clobber a manual completion made during post-exit model passes", { timeout: 30000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-run-manual-"));
	process.env.FAKE_PI_MODE = "completed";
	process.env.FAKE_PI_SUMMARY_DELAY_MS = "2000";
	let runnerPid = null;
	try {
		const meta = createView(root, { id: "view_1", name: "fix", cwd: root });
		const config = makeConfig(root, "view_1", "run_1", meta.sessionFile, root, "fix the bug");
		const st = readState(root, "view_1");
		st.currentRunId = "run_1";
		const { writeState } = await import("../src/core/store.mjs");
		writeState(root, st);

		runnerPid = launchRun(root, config, { runnerScript: RUNNER }).pid;
		assert.ok(runnerPid && runnerPid > 0, "runner spawned");

		// Wait for the worker to exit (terminal state persisted); the runner is now
		// inside its post-exit model passes (fake --model calls are slowed 2s).
		await waitFor(() => {
			const s = readStatus(root, "view_1", "run_1");
			return s && s.endedAt ? s : null;
		});

		// User marks the row done manually while the model passes are in flight.
		const { createService } = await import("../src/runtime/service.mjs");
		assert.deepEqual(createService({ root }).markCompleted("view_1"), { ok: true });

		// Let the runner finish its passes and exit.
		await waitFor(() => {
			try {
				process.kill(runnerPid, 0);
				return false;
			} catch {
				return true;
			}
		}, 25000);

		const state = readState(root, "view_1");
		assert.equal(state.semanticState, "completed");
		assert.equal(state.autoState, null);
	} finally {
		await killDetached(runnerPid);
		delete process.env.FAKE_PI_MODE;
		delete process.env.FAKE_PI_SUMMARY_DELAY_MS;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
