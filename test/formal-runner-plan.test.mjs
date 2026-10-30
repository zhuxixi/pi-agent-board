import assert from "node:assert/strict";
import test from "node:test";
import { buildFormalPlan, classifyTrial, FORMAL_TOTAL, WARMUP_TOTAL, expectedPath } from "../test-support/formal-measurement/formal-plan.mjs";
import { CELLS, scheduleFor } from "../test-support/formal-measurement/matrix.mjs";

const repo = process.cwd();
const baselineRepo = repo.replace(/issue-222-attach-ready$/, "issue-222-attach-baseline");
const plan = buildFormalPlan({ repo, baselineRepo, artifactsRoot: "/tmp/issue-222-formal-plan-test" });

test("formal plan is exactly 1660 trials plus 160 excluded warmups", () => {
	assert.equal(plan.formalTotal, 1660);
	assert.equal(plan.formalTotal, FORMAL_TOTAL);
	assert.equal(plan.warmupTotal, 160);
	assert.equal(plan.warmupTotal, WARMUP_TOTAL);
	assert.equal(plan.candidateFormal, 830);
	assert.equal(plan.baselineFormal, 830);
	assert.equal(plan.warmups.filter((entry) => entry.version === "candidate").length, 80);
	assert.equal(plan.warmups.filter((entry) => entry.version === "baseline").length, 80);
	assert.ok(plan.warmups.every((entry) => entry.excludedFromFormal === true));
	assert.ok(plan.warmups.every((entry) => entry.trialCapMs === 10000));
	assert.ok(plan.warmups.every((entry) => entry.observationWindowMs === 3000));
	assert.ok(plan.warmups.filter((entry) => entry.version === "baseline").every((entry) => entry.baselineOpportunityMs === 2500));
});

test("plan keeps exact 2n schedule per cell and D30/version", () => {
	for (const cell of CELLS) {
		const entries = plan.trials.filter((entry) => entry.cellId === cell.cellId);
		assert.equal(entries.length, 2 * cell.n, cell.cellId);
		assert.deepEqual(entries.map((entry) => `${entry.version}:${entry.half}`), scheduleFor(cell.n), cell.cellId);
		assert.equal(entries.filter((entry) => entry.version === "candidate").length, cell.n);
		assert.equal(entries.filter((entry) => entry.version === "baseline").length, cell.n);
	}
	assert.equal(plan.trials.filter((entry) => entry.cellId === "D").length, 60);
	assert.equal(plan.trials.filter((entry) => entry.cellId === "B").length, 200);
	assert.equal(plan.trials.filter((entry) => entry.cellId === "G1").length, 60);
});

test("artifact directories are unique across formal and warmup plans", () => {
	const all = [...plan.trials, ...plan.warmups].map((entry) => entry.artifactDir);
	assert.equal(new Set(all).size, all.length);
	assert.equal(new Set(plan.trials.map((entry) => entry.id)).size, plan.trials.length);
	assert.equal(new Set(plan.warmups.map((entry) => entry.id)).size, plan.warmups.length);
});

test("argv, cwd, observation and classification contracts are explicit", () => {
	const b = plan.trials.find((entry) => entry.cellId === "B" && entry.version === "candidate");
	assert.ok(b.argv.includes("--clock"));
	assert.ok(b.argv.includes("real"));
	assert.equal(b.observationWindowMs, 3000);
	assert.equal(b.bUpdateMs, 25);
	assert.equal(b.trialCapMs, 10000);
	const base = plan.trials.find((entry) => entry.cellId === "B" && entry.version === "baseline");
	assert.equal(base.baselineOpportunityMs, 2500);
	assert.equal(base.cwd, baselineRepo);
	const g = plan.trials.find((entry) => entry.cellId === "G1" && entry.version === "candidate");
	assert.equal(g.expectedPath, "modern-reporter-viewproof");
	assert.equal(plan.trials.find((entry) => entry.cellId === "U-legacy" && entry.version === "candidate").expectedPath, "legacy-no-reporter");
	assert.equal(expectedPath("candidate", "D"), "legacy-no-reporter");
	assert.equal(plan.sourceIdentity.mirrored, true);
	assert.ok(Object.values(plan.sourceIdentity.measurementScripts).every((entry) => entry.candidate === entry.baseline));
	assert.ok(plan.sourceIdentity.measurementScripts["test-support/pty-attach-matrix-scenario.ts"]);
});

test("classifyTrial separates infrastructure from product evidence", () => {
	const ok = classifyTrial({ version: "candidate", expectedPath: "modern-reporter-viewproof", status: 0, parsed: { ok: true, measurementPath: "modern-reporter-viewproof" } });
	assert.equal(ok.class, "product");
	const wrong = classifyTrial({ version: "candidate", expectedPath: "modern-reporter-viewproof", status: 0, parsed: { ok: true, measurementPath: "legacy-no-reporter" } });
	assert.equal(wrong.class, "infrastructure");
	const baselineRed = classifyTrial({ version: "baseline", expectedPath: "legacy-no-reporter", status: 1, parsed: { ok: false, measurementPath: "legacy-no-reporter" }, trialError: null });
	assert.equal(baselineRed.class, "product");
	const timeout = classifyTrial({ version: "candidate", expectedPath: "modern-reporter-viewproof", status: null, timedOut: true, parsed: null });
	assert.equal(timeout.class, "infrastructure");
});
