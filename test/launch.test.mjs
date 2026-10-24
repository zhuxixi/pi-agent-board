import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { launchAutoState, launchHost, launchRun, launchTitle } from "../src/core/launch.mjs";
import * as P from "../src/core/paths.mjs";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const FAKE_PI = join(ROOT_DIR, "test-support", "fake-pi.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 10_000, intervalMs = 50) {
	const start = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() - start > timeoutMs) return null;
		await sleep(intervalMs);
	}
}

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-launch-"));
}

test("launchHost spawns a detached runner and persists the host config", async () => {
	const root = freshRoot();
	/** @type {{ pid: number|null, configPath: string }|null} */
	let res = null;
	try {
		const config = {
			root,
			viewId: "view_1",
			sessionFile: "/tmp/sessions/view_1.jsonl",
			cwd: root,
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [],
			model: null,
			thinkingLevel: null,
			tools: null,
			env: {},
			cols: 80,
			rows: 24,
			screenLogMaxBytes: 1_000_000,
		};
		res = launchHost(root, config, { runnerScript: FAKE_PI });
		assert.ok(res.pid, "detached runner must have a pid");
		assert.equal(res.configPath, P.hostConfigPath(root, "view_1"));
		// Wait for the config to hit disk (the runner may keep running briefly).
		const persisted = await waitFor(() => (existsSync(res.configPath) ? readFileSync(res.configPath, "utf8") : null));
		assert.ok(persisted, "host config must be written");
		assert.equal(JSON.parse(persisted).viewId, "view_1");
	} finally {
		await killAndRemove(res?.pid ?? null, root);
	}
});

test("launchHost honors the instance-specific config path when provided", async () => {
	const root = freshRoot();
	/** @type {{ pid: number|null, configPath: string }|null} */
	let res = null;
	try {
		const configPath = P.hostConfigPathFor(root, "view_inst", "inst-1");
		const config = {
			root,
			viewId: "view_inst",
			sessionFile: "/tmp/sessions/view_inst.jsonl",
			cwd: root,
			initialPrompt: "hello",
			piCommand: process.execPath,
			piArgsPrefix: [],
			model: null,
			thinkingLevel: null,
			tools: null,
			env: {},
			cols: 80,
			rows: 24,
			configPath,
		};
		res = launchHost(root, config, { runnerScript: FAKE_PI });
		assert.ok(res.pid);
		assert.equal(res.configPath, configPath);
		const persisted = await waitFor(() => (existsSync(configPath) ? readFileSync(configPath, "utf8") : null));
		assert.ok(persisted, "instance host config must be written");
		assert.equal(JSON.parse(persisted).initialPrompt, "hello");
		// The launch must not also touch the legacy fixed config path.
		assert.equal(existsSync(P.hostConfigPath(root, "view_inst")), false);
	} finally {
		await killAndRemove(res?.pid ?? null, root);
	}
});

test("launchTitle persists the title config with the injected node", async () => {
	const root = freshRoot();
	/** @type {{ pid: number|null, configPath: string }|null} */
	let res = null;
	try {
		const config = {
			root,
			viewId: "view_2",
			cwd: root,
			prompt: "fix the bug",
			fallbackName: "fix",
			piCommand: process.execPath,
			piArgsPrefix: [],
			model: null,
		};
		res = launchTitle(root, config, { runnerScript: FAKE_PI, node: process.execPath });
		assert.ok(res.pid);
		assert.equal(res.configPath, P.titleConfigPath(root, "view_2"));
		const persisted = await waitFor(() => (existsSync(res.configPath) ? readFileSync(res.configPath, "utf8") : null));
		assert.ok(persisted, "title config must be written");
		assert.equal(JSON.parse(persisted).fallbackName, "fix");
	} finally {
		await killAndRemove(res?.pid ?? null, root);
	}
});

test("launchAutoState persists the auto-state config", async () => {
	const root = freshRoot();
	/** @type {{ pid: number|null, configPath: string }|null} */
	let res = null;
	try {
		const config = {
			root,
			viewId: "view_3",
			runId: "run_3",
			cwd: root,
			piCommand: process.execPath,
			piArgsPrefix: [],
		};
		res = launchAutoState(root, config, { runnerScript: FAKE_PI });
		assert.ok(res.pid);
		assert.equal(res.configPath, P.autoStateConfigPath(root, "view_3"));
		const persisted = await waitFor(() => (existsSync(res.configPath) ? readFileSync(res.configPath, "utf8") : null));
		assert.ok(persisted, "auto-state config must be written");
		assert.equal(JSON.parse(persisted).runId, "run_3");
	} finally {
		await killAndRemove(res?.pid ?? null, root);
	}
});

test("async spawn failures are swallowed instead of crashing the host (issue #86)", async () => {
	const root = freshRoot();
	let uncaughtCount = 0;
	const onUncaught = () => {
		uncaughtCount += 1;
	};
	process.on("uncaughtException", onUncaught);
	try {
		const opts = { runnerScript: FAKE_PI, node: "/nonexistent/node-ENOENT-test" };
		const hostConfig = {
			root,
			viewId: "view_e1",
			sessionFile: "/tmp/sessions/view_e1.jsonl",
			cwd: root,
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [],
			model: null,
			thinkingLevel: null,
			tools: null,
			env: {},
			cols: 80,
			rows: 24,
			screenLogMaxBytes: 1_000_000,
		};
		const titleConfig = {
			root,
			viewId: "view_e2",
			cwd: root,
			prompt: "name it",
			fallbackName: "name",
			piCommand: process.execPath,
			piArgsPrefix: [],
			model: null,
		};
		const autoStateConfig = {
			root,
			viewId: "view_e3",
			runId: "run_e3",
			cwd: root,
			piCommand: process.execPath,
			piArgsPrefix: [],
		};
		const runConfig = {
			root,
			viewId: "view_e4",
			runId: "run_e4",
			cwd: root,
			piCommand: process.execPath,
			piArgsPrefix: [],
		};

		// Every entry point must degrade to the pid == null branch (state "failed")
		// instead of letting the async spawn 'error' escape as uncaughtException.
		assert.equal(launchHost(root, hostConfig, opts).pid, null);
		assert.equal(launchTitle(root, titleConfig, opts).pid, null);
		assert.equal(launchAutoState(root, autoStateConfig, opts).pid, null);
		assert.equal(launchRun(root, runConfig, opts).pid, null);

		// Give the async 'error' events time to surface; an uncaughtException
		// here would kill the test process outright (the issue #86 symptom).
		await sleep(300);
		assert.equal(uncaughtCount, 0, "no spawn failure may surface as uncaughtException");
	} finally {
		process.removeListener("uncaughtException", onUncaught);
		rmSync(root, { recursive: true, force: true });
	}
});

// --- Launched-runner cleanup (issue #241) ---

/**
 * Liveness probe for a runner this file spawned. Signal 0 performs the
 * existence/permission check without delivering a signal; a throw means the pid
 * is gone.
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Stop a launched fake runner and delete its temp root. These fixtures pass
 * `config.cwd = root` to the detached runner, and on win32 that pinned directory
 * makes an immediate `rmSync` fail EPERM until the process has fully exited — so
 * terminate first, poll for the exit, then retry the delete with slack.
 * @param {number|null} pid
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function killAndRemove(pid, dir) {
	if (pid) {
		try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
		for (let waited = 0; waited < 2000; waited += 25) {
			if (!isAlive(pid)) break;
			await sleep(25);
		}
		if (isAlive(pid)) {
			try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
		}
	}
	let lastError = null;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			await sleep(50);
		}
	}
	if (lastError) throw lastError;
}
