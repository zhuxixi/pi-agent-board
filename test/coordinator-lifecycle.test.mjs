import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { coordinatorSpawnPlan, launchCoordinator } from "../src/core/launch.mjs";

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

const FAKE_RUNNER = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.argv[2], "spawn-probe.json"), JSON.stringify({ cwd: process.cwd(), arg: process.argv[2] }));
`;

test("A1 coordinatorSpawnPlan: absolute root argv, parent-dir cwd", () => {
	const base = join(tmpdir(), "agentview-c241-plan", "board root");
	for (const input of [base, `${base}/`, join(base, "views", "..")]) {
		const plan = coordinatorSpawnPlan(input);
		assert.ok(isAbsolute(plan.root), `root must be absolute for ${input}`);
		assert.equal(plan.root, resolve(input));
		assert.equal(plan.cwd, dirname(resolve(input)));
	}
});

test("A2 launchCoordinator spawns with absolute root argv and parent-dir cwd", async () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-c241-spawn-"));
	try {
		const fake = join(root, "fake-runner.mjs");
		writeFileSync(fake, FAKE_RUNNER, "utf8");
		const { pid } = launchCoordinator(root, { runnerScript: fake });
		assert.ok(pid, "detached child has a pid");
		const probePath = join(root, "spawn-probe.json");
		const raw = await waitFor(() => (existsSync(probePath) ? readFileSync(probePath, "utf8") : null), 5000);
		assert.ok(raw, "fake runner must write its probe file");
		const probe = JSON.parse(raw);
		const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
		assert.equal(norm(probe.arg), norm(root), "argv[2] is the absolute root");
		assert.equal(norm(probe.cwd), norm(dirname(root)), "cwd is the root's parent, not the root");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
