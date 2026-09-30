/**
 * Boot-window stop-safety integration tests (issue #153).
 *
 * A1: a stop delivered between the observable run_started and the handler
 *     wiring must still finalize the run (module-scope stop latch). Leg 1
 *     injects the window deterministically via AGENT_BOARD_TEST_BOOT_WINDOW_MS;
 *     leg 2 repeats the flow with the knob unset (inert-when-unset proof).
 * A3: the run's first diagnostics.jsonl entry is stop_latch_armed — nothing
 *     is published before the process can handle a stop.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import { launchRun } from "../src/core/launch.mjs";
import { createView, readPid, readStatus } from "../src/core/store.mjs";
import { startCoordinator } from "../test-support/ensure-coordinator-helper.mjs";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = join(ROOT_DIR, "runner", "job-runner.mjs");
const FAKE_PI = join(ROOT_DIR, "test-support", "fake-pi.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kill a detached process before deleting its root so it can never orphan (issue #33). */
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
		const v = await fn();
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
		piCommand: process.execPath,
		piArgsPrefix: [FAKE_PI],
		model: null,
		tools: null,
	};
}

/** Shared fixture: launch a hanging run and wait until working is observable. */
async function startWorkingRun(root) {
	const meta = createView(root, { id: "view_1", name: "stopwin", cwd: root });
	const config = makeConfig(root, "view_1", "run_1", meta.sessionFile, root, "do it");
	const runnerPid = launchRun(root, config, { runnerScript: RUNNER }).pid;
	assert.ok(runnerPid && runnerPid > 0, "runner spawned");
	const working = await waitFor(() => {
		const s = readStatus(root, "view_1", "run_1");
		return s && s.semanticState === "working" ? s : null;
	});
	assert.ok(working, "run reached working (run_started is observable)");
	return { runnerPid };
}

/** A3 must hold on every leg: stop_latch_armed is the run's first diagnostic. */
function assertFirstDiagnosticIsLatchArmed(root) {
	const diags = readDiagnostics(root, "view_1");
	assert.ok(diags.length > 0, "diagnostics exist");
	assert.equal(diags[0].code, "stop_latch_armed", "stop latch armed before anything was published");
}

async function stopWindowLeg({ injected }) {
	const root = mkdtempSync(join(tmpdir(), "agentview-stop-window-"));
	process.env.FAKE_PI_MODE = "hang";
	process.env.AGENT_BOARD_SUMMARY_MODEL = "off";
	if (injected) process.env.AGENT_BOARD_TEST_BOOT_WINDOW_MS = "800";
	let runnerPid = null;
	// Tracked coordinator: the run's terminal state routes through it; without
	// this fixture the client's ensure path spawns an untracked twin.
	const coord = await startCoordinator(root);
	try {
		const started = await startWorkingRun(root);
		runnerPid = started.runnerPid;

		const pid = readPid(root, "view_1", "run_1");
		assert.ok(pid, "have runner pid");
		// Injected leg: the knob guarantees the SIGTERM lands between run_started
		// and the handler wiring (the poll resolves ~25ms into the 800ms window).
		process.kill(pid, "SIGTERM");

		const status = await waitFor(() => {
			const s = readStatus(root, "view_1", "run_1");
			return s && s.endedAt != null ? s : null;
		});
		assert.ok(status, "run finalized after the early stop");
		assert.equal(status.semanticState, "stopped", "early stop still produces the stopped verdict");
		assertFirstDiagnosticIsLatchArmed(root);
	} finally {
		delete process.env.AGENT_BOARD_TEST_BOOT_WINDOW_MS;
		await killDetached(runnerPid);
		await coord.kill();
		delete process.env.FAKE_PI_MODE;
		delete process.env.AGENT_BOARD_SUMMARY_MODEL;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

test("A1 (injected window): SIGTERM inside the boot window still finalizes as stopped", { timeout: 20000 }, async () => {
	await stopWindowLeg({ injected: true });
});

test("A1 (knob unset): the same flow passes with the knob inert", { timeout: 20000 }, async () => {
	await stopWindowLeg({ injected: false });
});
