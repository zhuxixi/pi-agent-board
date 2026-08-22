import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { launchAutoState, launchHost, launchTitle } from "../src/core/launch.mjs";
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
		const res = launchHost(root, config, { runnerScript: FAKE_PI });
		assert.ok(res.pid, "detached runner must have a pid");
		assert.equal(res.configPath, P.hostConfigPath(root, "view_1"));
		// Wait for the config to hit disk (the runner may keep running briefly).
		const persisted = await waitFor(() => (existsSync(res.configPath) ? readFileSync(res.configPath, "utf8") : null));
		assert.ok(persisted, "host config must be written");
		assert.equal(JSON.parse(persisted).viewId, "view_1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("launchTitle persists the title config with the injected node", async () => {
	const root = freshRoot();
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
		const res = launchTitle(root, config, { runnerScript: FAKE_PI, node: process.execPath });
		assert.ok(res.pid);
		assert.equal(res.configPath, P.titleConfigPath(root, "view_2"));
		const persisted = await waitFor(() => (existsSync(res.configPath) ? readFileSync(res.configPath, "utf8") : null));
		assert.ok(persisted, "title config must be written");
		assert.equal(JSON.parse(persisted).fallbackName, "fix");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("launchAutoState persists the auto-state config", async () => {
	const root = freshRoot();
	try {
		const config = {
			root,
			viewId: "view_3",
			runId: "run_3",
			cwd: root,
			piCommand: process.execPath,
			piArgsPrefix: [],
		};
		const res = launchAutoState(root, config, { runnerScript: FAKE_PI });
		assert.ok(res.pid);
		assert.equal(res.configPath, P.autoStateConfigPath(root, "view_3"));
		const persisted = await waitFor(() => (existsSync(res.configPath) ? readFileSync(res.configPath, "utf8") : null));
		assert.ok(persisted, "auto-state config must be written");
		assert.equal(JSON.parse(persisted).runId, "run_3");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
