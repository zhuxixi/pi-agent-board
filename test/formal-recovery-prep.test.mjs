import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseRunnerArgs } from "../test-support/formal-measurement/runner-args.mjs";
import { S_SHAPES, buildFormalPlan, buildReplacementPlan, sShapeFor } from "../test-support/formal-measurement/formal-plan.mjs";

const repo = process.cwd();
const baselineRepo = repo.replace(/issue-222-attach-ready$/, "issue-222-attach-baseline");

test("runner args parse execute and artifacts independently", () => {
	assert.deepEqual(parseRunnerArgs(["--execute-formal", "--artifacts", "/tmp/x"]), { execute: true, artifacts: "/tmp/x", scope: "full" });
	assert.deepEqual(parseRunnerArgs(["--artifacts", "/tmp/y", "--execute-formal"]), { execute: true, artifacts: "/tmp/y", scope: "full" });
	assert.deepEqual(parseRunnerArgs([]), { execute: false, artifacts: null, scope: "full" });
	assert.deepEqual(parseRunnerArgs(["--scope", "replacement", "--artifacts", "/tmp/z"]), { execute: false, artifacts: "/tmp/z", scope: "replacement" });
	assert.throws(() => parseRunnerArgs(["--artifacts", "--execute-formal"]));
	assert.throws(() => parseRunnerArgs(["--bogus"]));
});

test("S shape mapping is deterministic and uniform over 100 formal trials/version", () => {
	assert.equal(S_SHAPES.length, 9);
	assert.deepEqual(sShapeFor(1), S_SHAPES[0]);
	assert.deepEqual(sShapeFor(9), S_SHAPES[8]);
	assert.deepEqual(sShapeFor(10), S_SHAPES[0]);
	const plan = buildFormalPlan({ repo, baselineRepo, artifactsRoot: "/tmp/recovery-plan-test" });
	for (const version of ["candidate", "baseline"]) {
		const entries = plan.trials.filter((entry) => entry.cellId === "S" && entry.version === version);
		assert.equal(entries.length, 100);
		assert.ok(entries.every((entry) => entry.sShape && entry.argv.includes("--variant") && entry.argv.includes("--entry")));
		const counts = new Map(S_SHAPES.map((shape) => [`${shape.variant}/${shape.entry}`, 0]));
		for (const entry of entries) counts.set(`${entry.sShape.variant}/${entry.sShape.entry}`, counts.get(`${entry.sShape.variant}/${entry.sShape.entry}`) + 1);
		assert.equal(counts.size, 9);
		assert.ok([...counts.values()].every((count) => count === 11 || count === 12));
		assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 100);
	}
	const warmups = plan.warmups.filter((entry) => entry.cellId === "S");
	assert.ok(warmups.every((entry) => entry.sShape && entry.trialCapMs === 10000));
});

test("single-S CLI runs exactly one selected trial through the shared seam", () => {
	const dir = mkdtempSync(join(tmpdir(), "s-single-test-"));
	try {
		const result = spawnSync(process.execPath, ["--experimental-transform-types", "test-support/pty-attach-ready-scenario.ts", "--case", "S", "--repeat", "1", "--clock", "real", "--artifact-dir", dir, "--variant", "plain", "--entry", "ticker"], { cwd: repo, env: { ...process.env, FORMAL_MEASURE_VERSION: "candidate" }, encoding: "utf8", timeout: 10000 });
		assert.equal(result.status, 0, result.stderr);
		const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1));
		assert.equal(parsed.trials.length, 1);
		assert.equal(parsed.trials[0].variant, "plain");
		assert.equal(parsed.trials[0].entry, "ticker");
		assert.equal(typeof parsed.trials[0].observationActualMs, "number");
		assert.ok(parsed.trials[0].observationActualMs >= 3000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runner source keeps the exact 10000 ms spawn/process cap", () => {
	const source = readFileSync("test-support/formal-measurement/formal-runner.mjs", "utf8");
	assert.match(source, /timeout: entry\.trialCapMs/);
	assert.match(source, /processCapMs: entry\.trialCapMs/);
	assert.doesNotMatch(source, /trialCapMs \+/);
});

test("replacement plan is exactly 175 entries for the failed/unstarted cells", () => {
	const replacement = buildReplacementPlan({ repo, baselineRepo, artifactsRoot: "/tmp/replacement-plan-test" });
	assert.equal(replacement.formalTotal, 150);
	assert.equal(replacement.warmupTotal, 25);
	assert.equal(replacement.executionOrder.length, 175);
	assert.equal(replacement.candidateFormal, 60);
	assert.equal(replacement.baselineFormal, 90);
	const keys = new Set(replacement.trials.map((entry) => `${entry.cellId}/${entry.version}`));
	assert.deepEqual([...keys].sort(), ["D/baseline", "D/candidate", "R-restart/baseline", "U-legacy/baseline", "U-legacy/candidate"].sort());
	assert.equal(replacement.trials.filter((entry) => entry.cellId === "D").length, 60);
	assert.equal(replacement.trials.filter((entry) => entry.cellId === "R-restart").length, 30);
	assert.equal(replacement.trials.filter((entry) => entry.cellId === "U-legacy").length, 60);
	assert.equal(new Set([...replacement.trials, ...replacement.warmups].map((entry) => entry.artifactDir)).size, 175);
	assert.equal(replacement.warmups.length, 25);
});

test("every B warmup and formal plan entry carries bUpdateMs=25", () => {
	const plan = buildFormalPlan({ repo, baselineRepo, artifactsRoot: "/tmp/b-warmup-metadata-test" });
	const b = [...plan.warmups, ...plan.trials].filter((entry) => entry.cellId === "B");
	assert.equal(b.filter((entry) => entry.excludedFromFormal === true).length, 10);
	assert.equal(b.filter((entry) => entry.excludedFromFormal !== true).length, 200);
	assert.ok(b.every((entry) => entry.bUpdateMs === 25));
});
