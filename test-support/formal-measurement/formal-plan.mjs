// Issue #222 step31 formal 1660-trial plan. Pure plan/classification helpers;
// the CLI runner owns process spawning and file append.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CELLS, HARD_OPPORTUNITY_MS, OBSERVATION_MS, B_UPDATE_MS, TRIAL_CAP_MS, WARMUPS_PER_VERSION, scheduleFor } from "./matrix.mjs";

export const FORMAL_TOTAL = CELLS.reduce((sum, cell) => sum + cell.n, 0) * 2;
export const WARMUP_TOTAL = CELLS.length * WARMUPS_PER_VERSION * 2;

const MODERN_CELLS = new Set(["B", "Q", "S", "T-on-time", "T-late", "L-normal", "L-alt", "G1", "G2", "G3", "C", "R-reconnect", "R-restart"]);
export function expectedPath(version, cellId) {
	return version === "baseline" || !MODERN_CELLS.has(cellId) ? "legacy-no-reporter" : "modern-reporter-viewproof";
}

export function scenarioFor(cellId) {
	if (cellId === "B" || cellId === "Q") return "test-support/attach-entry-22-scenario.ts";
	if (["S", "T-on-time", "T-late"].includes(cellId)) return "test-support/pty-attach-ready-scenario.ts";
	if (["L-normal", "L-alt", "G1", "G2", "G3"].includes(cellId)) return "test-support/pty-attach-matrix-scenario.ts";
	if (cellId === "C") return "test-support/pty-attach-21b-scenario.ts";
	return "test-support/pty-attach-20b-scenario.ts";
}

export const S_SHAPES = [
	{ variant: "plain", entry: "ticker" },
	{ variant: "plain", entry: "status" },
	{ variant: "plain", entry: "capture" },
	{ variant: "same-write", entry: "ticker" },
	{ variant: "same-write", entry: "status" },
	{ variant: "same-write", entry: "capture" },
	{ variant: "split", entry: "ticker" },
	{ variant: "split", entry: "status" },
	{ variant: "split", entry: "capture" },
];

export function sShapeFor(index) {
	if (!Number.isInteger(index) || index < 1) throw new Error("S shape index must be positive");
	return S_SHAPES[(index - 1) % S_SHAPES.length];
}

export function argvFor(cellId, artifactDir, sShape = null) {
	const script = scenarioFor(cellId);
	if (cellId === "C") return [script, "--case", "C", "--artifact-dir", artifactDir];
	const base = [script, "--case", cellId, "--repeat", "1", "--clock", "real", "--artifact-dir", artifactDir];
	if (cellId === "S" && sShape !== null) base.push("--variant", sShape.variant, "--entry", sShape.entry);
	return base;
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sourceIdentity(repo, baselineRepo) {
	const production = ["src/ui/pty-attach.ts", "src/core/terminal-attach-client.mjs", "src/core/pty-attach-render.mjs", "runner/pty-runner.mjs"];
	const measurementScripts = [
		"test-support/attach-entry-22-scenario.ts",
		"test-support/attach-presentation-fixture.ts",
		"test-support/attach-ready-entry-scenario.ts",
		"test-support/pty-attach-ready-scenario.ts",
		"test-support/pty-attach-timing-scenario.ts",
		"test-support/pty-attach-21b-scenario.ts",
		"test-support/pty-attach-20b-scenario.ts",
		"test-support/pty-attach-matrix-scenario.ts",
		"test-support/fake-pty-busy-pi.mjs",
		"test-support/fake-pty-c-frame.mjs",
		"test-support/fake-pty-frame-wrapper.mjs",
		"test-support/fake-pty-generation-pi.mjs",
		"test-support/fake-pty-geometry-pi.mjs",
		"test-support/fake-pty-longlog-pi.mjs",
		"test-support/fake-pty-restart-pi.mjs",
		"test-support/fake-pty-unframed-pi.mjs",
		"test-support/formal-measurement/fake-pty-controlled-pi.mjs",
		"test-support/formal-measurement/version.mjs",
		"test-support/formal-measurement/observation.mjs",
		"test-support/formal-measurement/matrix.mjs",
		"test-support/formal-measurement/stats.mjs",
		"test-support/formal-measurement/trial-metrics.mjs",
		"test-support/formal-measurement/runner-args.mjs",
		"test-support/formal-measurement/preflight.mjs",
		"test-support/formal-measurement/formal-plan.mjs",
		"test-support/formal-measurement/formal-runner.mjs",
	];
	const mirrored = Object.fromEntries(measurementScripts.map((file) => [file, { candidate: sha256File(join(repo, file)), baseline: sha256File(join(baselineRepo, file)) }]));
	return {
		candidateRoot: repo,
		baselineRoot: baselineRepo,
		candidate: Object.fromEntries(production.map((file) => [file, sha256File(join(repo, file))])),
		baseline: Object.fromEntries(production.map((file) => [file, sha256File(join(baselineRepo, file))])),
		scenario: Object.fromEntries(["B", "S", "L-normal", "C", "R-reconnect", "U-unframed", "D"].map((cellId) => [cellId, { candidate: sha256File(join(repo, scenarioFor(cellId))), baseline: sha256File(join(baselineRepo, scenarioFor(cellId))) }])),
		measurementScripts: mirrored,
		mirrored: Object.values(mirrored).every((entry) => entry.candidate === entry.baseline),
		dependencies: {
			piTui: JSON.parse(readFileSync(join(repo, "node_modules/@earendil-works/pi-tui/package.json"), "utf8")).version,
			xtermHeadless: JSON.parse(readFileSync(join(repo, "node_modules/@xterm/headless/package.json"), "utf8")).version,
		},
	};
}

export function buildFormalPlan({ repo, baselineRepo, artifactsRoot }) {
	const trials = [];
	const warmups = [];
	for (const cell of CELLS) {
		for (const version of ["candidate", "baseline"]) {
			for (let index = 1; index <= WARMUPS_PER_VERSION; index += 1) {
				const artifactDir = join(artifactsRoot, "warmups", cell.cellId, version, `warmup-${index}`);
				const sShape = cell.cellId === "S" ? sShapeFor(index) : null;
				warmups.push({
					id: `${cell.cellId}/${version}/warmup-${index}`,
					cellId: cell.cellId,
					version,
					index,
					artifactDir,
					argv: [process.execPath, "--experimental-transform-types", ...argvFor(cell.cellId, artifactDir, sShape).map((part) => part.startsWith("test-support/") ? join(repo, part) : part)],
					...(sShape === null ? {} : { sShape }),
					cwd: version === "candidate" ? repo : baselineRepo,
					env: { FORMAL_MEASURE_VERSION: version },
					expectedPath: expectedPath(version, cell.cellId),
					observationWindowMs: OBSERVATION_MS,
					trialCapMs: TRIAL_CAP_MS,
					bUpdateMs: cell.cellId === "B" ? B_UPDATE_MS : null,
					baselineOpportunityMs: version === "baseline" ? HARD_OPPORTUNITY_MS : null,
					themeObservationMs: cell.cellId.startsWith("T-") ? OBSERVATION_MS : null,
					recoveryObservationMs: cell.cellId.startsWith("R-") ? OBSERVATION_MS : null,
					excludedFromFormal: true,
				});
			}
		}
		const schedule = scheduleFor(cell.n);
		const versionCounters = { candidate: 0, baseline: 0 };
		schedule.forEach((entry, index) => {
			const [version, half] = entry.split(":");
			const trialIndex = index + 1;
			versionCounters[version] += 1;
			const sShape = cell.cellId === "S" ? sShapeFor(versionCounters[version]) : null;
			const artifactDir = join(artifactsRoot, "formal", String(trialIndex).padStart(4, "0"), cell.cellId, version);
			const [script, ...args] = argvFor(cell.cellId, artifactDir, sShape);
			trials.push({
				id: `${cell.cellId}/${version}/${trialIndex}`,
				cellId: cell.cellId,
				version,
				half,
				trialIndex,
				artifactDir,
				argv: [process.execPath, "--experimental-transform-types", join(version === "candidate" ? repo : baselineRepo, script), ...args],
				...(sShape === null ? {} : { sShape }),
				cwd: version === "candidate" ? repo : baselineRepo,
				env: { FORMAL_MEASURE_VERSION: version },
				expectedPath: expectedPath(version, cell.cellId),
				observationWindowMs: OBSERVATION_MS,
				bUpdateMs: cell.cellId === "B" ? B_UPDATE_MS : null,
				trialCapMs: TRIAL_CAP_MS,
				baselineOpportunityMs: version === "baseline" ? HARD_OPPORTUNITY_MS : null,
				themeObservationMs: cell.cellId.startsWith("T-") ? OBSERVATION_MS : null,
				recoveryObservationMs: cell.cellId.startsWith("R-") ? OBSERVATION_MS : null,
			});
		});
	}
	const executionOrder = [];
	for (const cell of CELLS) {
		for (const entry of warmups.filter((item) => item.cellId === cell.cellId)) executionOrder.push(entry.id);
		for (const entry of trials.filter((item) => item.cellId === cell.cellId)) executionOrder.push(entry.id);
	}
	return {
		version: 1,
		formalTotal: trials.length,
		executionOrder,
		warmupTotal: warmups.length,
		candidateFormal: trials.filter((trial) => trial.version === "candidate").length,
		baselineFormal: trials.filter((trial) => trial.version === "baseline").length,
		sourceIdentity: sourceIdentity(repo, baselineRepo),
		trials,
		warmups,
	};
}

export function classifyTrial({ version, expectedPath: wanted, spawnError, status, timedOut, parsed, trialError }) {
	if (spawnError || timedOut) return { class: "infrastructure", reason: spawnError ? String(spawnError.message ?? spawnError) : "timeout" };
	if (parsed === null || parsed === undefined) return { class: "infrastructure", reason: "no JSON result" };
	const actualPath = parsed.measurementPath ?? parsed.trials?.[0]?.measurementPath ?? "UNKNOWN";
	if (actualPath !== wanted) return { class: "infrastructure", reason: `path ${actualPath} != ${wanted}` };
	if (status === 0 && parsed.ok === true) return { class: "product", reason: "product-pass" };
	if (version === "baseline" && (trialError === null || trialError === undefined)) return { class: "product", reason: "baseline-product-red" };
	return { class: "product", reason: `product-red exit=${status}` };
}

export function artifactKey(entry) {
	return basename(entry.artifactDir);
}

export const REPLACEMENT_CELLS = Object.freeze([
	{ cellId: "R-restart", version: "baseline" },
	{ cellId: "U-legacy", version: "candidate" },
	{ cellId: "U-legacy", version: "baseline" },
	{ cellId: "D", version: "candidate" },
	{ cellId: "D", version: "baseline" },
]);

export function buildReplacementPlan({ repo, baselineRepo, artifactsRoot }) {
	const full = buildFormalPlan({ repo, baselineRepo, artifactsRoot });
	const selected = new Set(REPLACEMENT_CELLS.map((entry) => `${entry.cellId}/${entry.version}`));
	const trials = full.trials.filter((entry) => selected.has(`${entry.cellId}/${entry.version}`));
	const warmups = full.warmups.filter((entry) => selected.has(`${entry.cellId}/${entry.version}`));
	const executionOrder = [];
	for (const entry of REPLACEMENT_CELLS) {
		const key = `${entry.cellId}/${entry.version}`;
		for (const warmup of warmups.filter((item) => `${item.cellId}/${item.version}` === key)) executionOrder.push(warmup.id);
		for (const trial of trials.filter((item) => `${item.cellId}/${item.version}` === key)) executionOrder.push(trial.id);
	}
	return {
		...full,
		version: 2,
		replacementCells: REPLACEMENT_CELLS,
		formalTotal: trials.length,
		warmupTotal: warmups.length,
		candidateFormal: trials.filter((entry) => entry.version === "candidate").length,
		baselineFormal: trials.filter((entry) => entry.version === "baseline").length,
		trials,
		warmups,
		executionOrder,
	};
}
