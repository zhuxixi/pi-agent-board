import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import { metaPath, sessionFilePath, titleConfigPath, viewDir } from "../src/core/paths.mjs";

const ROOT_DIR = join(import.meta.dirname, "..");
const RUNNER = join(ROOT_DIR, "runner", "title-runner.mjs");
const FAKE_PI = join(ROOT_DIR, "test-support", "fake-title-pi.mjs");

function freshRoot() { return mkdtempSync(join(tmpdir(), "agentview-title-smoke-")); }

function seedView(root, { prompt, name, sessionLines, extra = {} }) {
	const viewId = "view_smoke";
	mkdirSync(viewDir(root, viewId), { recursive: true });
	writeFileSync(metaPath(root, viewId), JSON.stringify({ id: viewId, name, cwd: root, sessionFile: sessionFilePath(root, viewId) }));
	if (sessionLines) {
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(sessionFilePath(root, viewId), sessionLines);
	}
	atomicWriteJson(titleConfigPath(root, viewId), {
		root, viewId, cwd: root, prompt, fallbackName: name,
		piCommand: process.execPath, piArgsPrefix: [FAKE_PI], model: null, ...extra,
	});
	return viewId;
}

/** Title env vars inherited from the host; scrubbed so tests stay hermetic. */
const TITLE_ENV_KEYS = [
	"AGENT_BOARD_TITLE_MODEL",
	"AGENT_VIEW_TITLE_MODEL",
	"AGENT_BOARD_TITLE_THINKING_LEVEL",
	"AGENT_VIEW_TITLE_THINKING_LEVEL",
];

function runRunner(root, viewId, env = {}) {
	// Scrub host title settings from the base env so a contaminated parent
	// cannot disable or reroute generation; explicit overrides still win.
	const base = { ...process.env };
	for (const key of TITLE_ENV_KEYS) delete base[key];
	return spawnSync(process.execPath, [RUNNER, titleConfigPath(root, viewId)], {
		env: { ...base, FAKE_TITLE_PI_MARKER: join(root, "marker"), ...env },
		timeout: 20000,
	});
}

const substantiveJsonl = [
	JSON.stringify({ type: "session", id: "s", cwd: "/r" }),
	JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
	JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "user", content: [{ type: "text", text: "deploy api" }] } }),
].join("\n") + "\n";

test("A6① non-greeting prompt generates immediately via the real runner", () => {
	const root = freshRoot();
	try {
		const viewId = seedView(root, { prompt: "fix bug now", name: "fix-bug-now" });
		const res = runRunner(root, viewId);
		assert.equal(res.status, 0);
		const meta = JSON.parse(readFileSync(metaPath(root, viewId), "utf8"));
		assert.equal(meta.name, "T: fix bug now");
		assert.ok(existsSync(join(root, "marker")));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("A6② greeting prompt polls and titles from the substantive message", () => {
	const root = freshRoot();
	try {
		const viewId = seedView(root, { prompt: "hello", name: "slug-name", sessionLines: substantiveJsonl, extra: { pollIntervalMs: 50, pollBudgetMs: 5000 } });
		const res = runRunner(root, viewId);
		assert.equal(res.status, 0);
		const meta = JSON.parse(readFileSync(metaPath(root, viewId), "utf8"));
		assert.equal(meta.name, "T: deploy api");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("A6③ off (board and legacy) exits without model call or rename", () => {
	for (const env of [{ AGENT_BOARD_TITLE_MODEL: "off" }, { AGENT_VIEW_TITLE_MODEL: "off" }]) {
		const root = freshRoot();
		try {
			const viewId = seedView(root, { prompt: "fix bug now", name: "keep-me" });
			const res = runRunner(root, viewId, env);
			assert.equal(res.status, 0);
			const meta = JSON.parse(readFileSync(metaPath(root, viewId), "utf8"));
			assert.equal(meta.name, "keep-me");
			assert.equal(existsSync(join(root, "marker")), false, JSON.stringify(env));
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});

test("A6④ hermeticity regression: contaminated host title env still generates for a non-greeting prompt", () => {
	const root = freshRoot();
	const saved = {};
	// Simulate a host that exports title settings ("off" disables generation).
	for (const key of TITLE_ENV_KEYS) {
		saved[key] = process.env[key];
		process.env[key] = key.endsWith("THINKING_LEVEL") ? "high" : "off";
	}
	try {
		const viewId = seedView(root, { prompt: "fix bug now", name: "fix-bug-now" });
		const res = runRunner(root, viewId);
		assert.equal(res.status, 0);
		const meta = JSON.parse(readFileSync(metaPath(root, viewId), "utf8"));
		assert.equal(meta.name, "T: fix bug now");
		assert.ok(existsSync(join(root, "marker")), "scrubbed env must still reach the model call");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});
