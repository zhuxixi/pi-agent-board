#!/usr/bin/env node
// Step31 preflight only. One real trial per cell/version, serial, no warmups.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { WARMUPS_PER_VERSION, OBSERVATION_MS, B_UPDATE_MS, TRIAL_CAP_MS, HARD_OPPORTUNITY_MS, CELLS, scheduleFor } from "./matrix.mjs";
import { extractTrialMetrics } from "./trial-metrics.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = resolve(process.argv[2] ?? join(repo, ".superpowers/sdd/2026-10-23-issue-222-attach-ready/task-31-artifacts/preflight-full"));
const onlyVersion = process.env.FORMAL_MEASURE_ONLY_VERSION ?? null;
if (onlyVersion !== null && onlyVersion !== "candidate" && onlyVersion !== "baseline") throw new Error(`bad FORMAL_MEASURE_ONLY_VERSION ${onlyVersion}`);
const versions = onlyVersion === null ? ["candidate", "baseline"] : [onlyVersion];
if (!existsSync(root)) mkdirSync(root, { recursive: true });
if (existsSync(join(root, "preflight.jsonl"))) throw new Error(`preflight root already populated: ${root}`);

const MODERN_CELLS = new Set(["B", "Q", "S", "T-on-time", "T-late", "L-normal", "L-alt", "G1", "G2", "G3", "C", "R-reconnect", "R-restart"]);
const LEGACY_CELLS = new Set(["U-unframed", "U-legacy", "D"]);

function commandFor(version, cellId, artifactDir) {
	if (cellId === "B" || cellId === "Q") {
		return [join(repo, "test-support/attach-entry-22-scenario.ts"), ["--case", cellId, "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir]];
	}
	if (["S", "T-on-time", "T-late"].includes(cellId)) {
		return [join(repo, "test-support/pty-attach-ready-scenario.ts"), ["--case", cellId, "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir]];
	}
	if (["L-normal", "L-alt", "G1", "G2", "G3"].includes(cellId)) {
		return [join(repo, "test-support/pty-attach-matrix-scenario.ts"), ["--case", cellId, "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir]];
	}
	if (cellId === "C") return [join(repo, "test-support/pty-attach-21b-scenario.ts"), ["--case", cellId, "--artifact-dir", artifactDir]];
	if (["R-reconnect", "R-restart", "U-unframed", "U-legacy", "D"].includes(cellId)) {
		return [join(repo, "test-support/pty-attach-20b-scenario.ts"), ["--case", cellId, "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir]];
	}
	throw new Error(`no preflight command for ${cellId}`);
}

function parseOutput(stdout) {
	const lines = (stdout ?? "").trim().split("\n").filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		try { return JSON.parse(lines[i]); } catch { /* preceding text */ }
	}
	return null;
}

function actualPathOf(parsed) {
	return parsed?.measurementPath ?? parsed?.trials?.[0]?.measurementPath ?? parsed?.trials?.[0]?.evidence?.measurementPath ?? "UNKNOWN";
}

function firstTrial(parsed) {
	return parsed?.trials?.[0] ?? parsed ?? {};
}

const records = [];
for (const version of versions) {
	for (const cell of CELLS) {
		const cellId = cell.cellId;
		const trialIndex = 1;
		const artifactDir = join(root, `${version}-${cellId}-${trialIndex}`);
		if (existsSync(artifactDir)) throw new Error(`overwrite refused: ${artifactDir}`);
		const [script, args] = commandFor(version, cellId, artifactDir);
		const started = Date.now();
		const result = spawnSync(process.execPath, ["--experimental-transform-types", script, ...args], {
			cwd: repo,
			env: { ...process.env, FORMAL_MEASURE_VERSION: version },
			encoding: "utf8",
			timeout: 180_000,
		});
		const ended = Date.now();
		const parsed = parseOutput(result.stdout);
		const trial = firstTrial(parsed);
		const expectedPath = version === "baseline" || LEGACY_CELLS.has(cellId) ? "legacy-no-reporter" : "modern-reporter-viewproof";
		const actualPath = actualPathOf(parsed);
		const metrics = extractTrialMetrics(parsed);
		const baselineProductRed = version === "baseline" && result.status !== 0 && parsed !== null && actualPath === expectedPath && (trial?.error === null || trial?.error === undefined);
		const observationReal = metrics.observationActualMs !== "UNKNOWN" && typeof metrics.observationActualMs === "number";
		const observationValid = cellId === "D" || (observationReal && metrics.observationActualMs >= OBSERVATION_MS && metrics.observationCompletion === "completed");
		const themeValid = !cellId.startsWith("T-") || metrics.themeCompletion === "completed";
		const recoveryValid = !cellId.startsWith("R-") || metrics.recoveryCompletion === "completed";
		const bContinuityValid = cellId !== "B" || parsed?.continuity?.continuous === true;
		const infra = result.error !== undefined
			? `spawn=${result.error?.message ?? String(result.error)}`
			: result.status !== 0 && !baselineProductRed
				? `exit=${result.status} stderr=${String(result.stderr ?? "").slice(-700)}`
				: parsed === null
					? "no JSON result"
					: actualPath !== expectedPath
						? `expectedPath=${expectedPath} actual=${actualPath}`
						: !observationValid
							? `observationActualMs=${String(metrics.observationActualMs)} completion=${String(metrics.observationCompletion)}`
							: !themeValid
								? `themeCompletion=${String(metrics.themeCompletion)}`
								: !recoveryValid
									? `recoveryCompletion=${String(metrics.recoveryCompletion)}`
									: !bContinuityValid
										? "B continuity not proven for the entire window"
										: null;
		records.push({
			...metrics,
			caseId: cellId,
			version,
			trialIndex,
			half: "preflight",
			warmup: false,
			actualPath,
			infrastructureError: infra,
			artifactDir,
			observationWallStartMs: started,
			observationWallEndMs: ended,
			exitCode: result.status,
			rawResultFile: join(artifactDir, "scenario-result.json"),
		});
		writeFileSync(join(artifactDir, "scenario-result.json"), JSON.stringify(parsed, null, 2));
	}
}

writeFileSync(join(root, "preflight.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
writeFileSync(join(root, "preflight-meta.json"), JSON.stringify({
	formalTrials: 0,
	warmupsExecuted: 0,
	warmupsPerVersion: WARMUPS_PER_VERSION,
	observationMs: OBSERVATION_MS,
	bUpdateMs: B_UPDATE_MS,
	trialCapMs: TRIAL_CAP_MS,
	hardOpportunityMs: HARD_OPPORTUNITY_MS,
	matrixCells: CELLS.length,
	schedule: { B: scheduleFor(100), G1: scheduleFor(30) },
	preflighted: records.map((record) => `${record.version}/${record.caseId}`),
	expectedPerVersion: CELLS.reduce((sum, cell) => sum + cell.n, 0),
	expectedTotal: CELLS.reduce((sum, cell) => sum + cell.n, 0) * 2,
	status: records.some((record) => record.infrastructureError !== null) ? "PREFLIGHT_FAILED" : "PREFLIGHT_OK",
}, null, 2));
const failures = records.filter((record) => record.infrastructureError !== null);
for (const record of failures) process.stderr.write(`preflight failure ${record.version}/${record.caseId}: ${record.infrastructureError}\n`);
process.stdout.write(JSON.stringify({ ok: failures.length === 0, root, records: records.length, failures: failures.length }) + "\n");
process.exit(failures.length === 0 ? 0 : 1);
