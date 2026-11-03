#!/usr/bin/env node
// Issue #222 step31 serial formal runner. Dry-run is the default; real
// execution requires BOTH --execute-formal and FORMAL_APPROVED=1 (step32).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildFormalPlan, buildReplacementPlan, classifyTrial } from "./formal-plan.mjs";
import { extractTrialMetrics } from "./trial-metrics.mjs";
import { parseRunnerArgs } from "./runner-args.mjs";

const repo = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const baselineRepo = resolve(repo, "../issue-222-attach-baseline");
const options = parseRunnerArgs(process.argv.slice(2));
const artifactsRoot = resolve(options.artifacts ?? join(repo, ".superpowers/sdd/2026-10-23-issue-222-attach-ready/task-31-artifacts/formal-run"));
const execute = options.execute;
const dryRun = !execute;

const plan = options.scope === "replacement"
	? buildReplacementPlan({ repo, baselineRepo, artifactsRoot })
	: buildFormalPlan({ repo, baselineRepo, artifactsRoot });
mkdirSync(artifactsRoot, { recursive: true });
writeFileSync(join(artifactsRoot, "formal-plan.json"), JSON.stringify(plan, null, 2) + "\n");
if (dryRun) {
	process.stdout.write(JSON.stringify({ ok: true, dryRun: true, artifactsRoot, formalTotal: plan.formalTotal, warmupTotal: plan.warmupTotal, candidateFormal: plan.candidateFormal, baselineFormal: plan.baselineFormal }) + "\n");
	process.exit(0);
}
if (process.env.FORMAL_APPROVED !== "1") {
	process.stderr.write("formal-runner: refusing execution; set FORMAL_APPROVED=1 only after step31 acceptance/step32\n");
	process.exit(2);
}

const jsonlPath = join(artifactsRoot, "trials.jsonl");
const completed = new Map();
if (existsSync(jsonlPath)) {
	for (const line of readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean)) {
		try {
			const record = JSON.parse(line);
			if (record.status === "completed") completed.set(record.id, record);
		} catch { /* retain malformed line for inspection */ }
	}
}
writeFileSync(join(artifactsRoot, "source-identity.json"), JSON.stringify(plan.sourceIdentity, null, 2) + "\n");
const byId = new Map([...plan.warmups, ...plan.trials].map((entry) => [entry.id, entry]));

for (const id of plan.executionOrder) {
	const entry = byId.get(id);
	if (completed.has(id)) continue;
	if (existsSync(entry.artifactDir)) throw new Error(`resume refuses incomplete/foreign artifact dir: ${entry.artifactDir}`);
	mkdirSync(dirname(entry.artifactDir), { recursive: true });
	const started = Date.now();
	const result = spawnSync(entry.argv[0], entry.argv.slice(1), {
		cwd: entry.cwd,
		env: { ...process.env, ...entry.env },
		encoding: "utf8",
		timeout: entry.trialCapMs,
	});
	const ended = Date.now();
	let parsed = null;
	for (const line of (result.stdout ?? "").trim().split("\n").reverse()) {
		try { parsed = JSON.parse(line); break; } catch { /* preceding text */ }
	}
	const trialError = parsed?.trials?.[0]?.error ?? null;
	const metrics = extractTrialMetrics(parsed);
	const classification = classifyTrial({
		version: entry.version,
		expectedPath: entry.expectedPath ?? null,
		spawnError: result.error,
		status: result.status,
		timedOut: result.error?.code === "ETIMEDOUT",
		parsed,
		trialError,
	});
	const rawBase = join(artifactsRoot, "raw", entry.id.replaceAll("/", "__"));
	mkdirSync(dirname(rawBase), { recursive: true });
	writeFileSync(`${rawBase}.stdout.log`, result.stdout ?? "");
	writeFileSync(`${rawBase}.stderr.log`, result.stderr ?? "");
	const record = {
		id,
		cellId: entry.cellId,
		version: entry.version,
		warmup: entry.excludedFromFormal === true,
		half: entry.half ?? "warmup",
		trialIndex: entry.trialIndex ?? entry.index,
		excludedFromFormal: entry.excludedFromFormal === true,
		argv: entry.argv,
		cwd: entry.cwd,
		env: entry.env,
		artifactDir: entry.artifactDir,
		rawStdout: `${rawBase}.stdout.log`,
		rawStderr: `${rawBase}.stderr.log`,
		startedAtMs: started,
		endedAtMs: ended,
		observationWindowMs: entry.observationWindowMs ?? null,
		bUpdateMs: entry.bUpdateMs ?? null,
		baselineOpportunityMs: entry.baselineOpportunityMs ?? null,
		trialCapMs: entry.trialCapMs,
		processCapMs: entry.trialCapMs,
		spawnError: result.error === undefined ? null : String(result.error.message ?? result.error),
		exitCode: result.status,
		timedOut: result.error?.code === "ETIMEDOUT",
		classification: classification.class,
		classificationReason: classification.reason,
		actualPath: parsed?.measurementPath ?? parsed?.trials?.[0]?.measurementPath ?? "UNKNOWN",
		...(entry.sShape === undefined ? {} : { sShape: entry.sShape }),
		...metrics,
		sourceIdentity: plan.sourceIdentity,
		status: "completed",
	};
	appendFileSync(jsonlPath, JSON.stringify(record) + "\n");
}
process.stdout.write(JSON.stringify({ ok: true, dryRun: false, artifactsRoot, completed: plan.executionOrder.length }) + "\n");
