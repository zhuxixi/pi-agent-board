// Issue #222 step31 pure formal-matrix statistics. No clock, I/O or process state.
export const Z95 = 1.959963984540054;

export function ceilQuantile(values, p) {
	if (!Array.isArray(values) || values.length === 0) throw new Error("quantile requires non-empty values");
	if (!(p > 0 && p <= 1)) throw new Error("quantile p must be in (0,1]");
	const sorted = values.slice().sort((a, b) => a - b);
	const index = Math.max(1, Math.ceil(p * sorted.length)) - 1;
	return sorted[index];
}

export function wilson95(successes, trials) {
	if (!Number.isInteger(successes) || !Number.isInteger(trials) || successes < 0 || trials <= 0 || successes > trials) {
		throw new Error("wilson95 requires 0 <= successes <= trials");
	}
	const p = successes / trials;
	const z2 = Z95 * Z95;
	const denom = 1 + z2 / trials;
	const center = (p + z2 / (2 * trials)) / denom;
	const margin = (Z95 * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) / denom;
	return { low: Math.max(0, center - margin), high: Math.min(1, center + margin), p };
}

export function infrastructureRate(trials) {
	const total = trials.length;
	const infra = trials.filter((trial) => trial.infrastructureError !== null && trial.infrastructureError !== undefined).length;
	return { total, infra, rate: total === 0 ? 0 : infra / total, invalid: total > 0 && infra / total > 0.05 };
}

function finiteOrInfinity(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : Infinity;
}

/**
 * Summarize one version/cell only. `latencyField` is the ready/terminal latency
 * for that cell; Infinity is retained and never dropped.
 */
export function summarizeCell({ version, cellId, trials, latencyField = "readyLatencyMs", thresholdMs, maxMs }) {
	if (!Array.isArray(trials)) throw new Error("trials required");
	const formal = trials.filter((trial) => trial.version === version && trial.cellId === cellId && trial.warmup === false);
	if (formal.length === 0) throw new Error(`no formal trials for ${version}/${cellId}`);
	const latencies = formal.map((trial) => finiteOrInfinity(trial[latencyField]));
	const timelyCorrect = formal.filter((trial) => trial.correct === true && latencies[formal.indexOf(trial)] <= thresholdMs).length;
	const productCorrect = formal.filter((trial) => trial.correct === true).length;
	const infra = infrastructureRate(formal);
	return {
		version,
		cellId,
		n: formal.length,
		latencies,
		p50: ceilQuantile(latencies, 0.5),
		p95: ceilQuantile(latencies, 0.95),
		max: Math.max(...latencies),
		timelyCorrect,
		productCorrect,
		wilson95: wilson95(timelyCorrect, formal.length),
		infra,
		thresholds: { thresholdMs, maxMs },
		passes:
			!infra.invalid &&
			productCorrect === formal.length &&
			ceilQuantile(latencies, 0.95) <= thresholdMs &&
			Math.max(...latencies) <= maxMs,
	};
}
