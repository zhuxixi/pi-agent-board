export const THRESHOLDS = {
	B: { primaryMs: 200, primaryMaxMs: 500 },
	Q: { primaryMs: 200, primaryMaxMs: 500 },
	S: { primaryMs: 100, primaryMaxMs: 200 },
	"L-normal": { primaryMs: 200, primaryMaxMs: 500 },
	"L-alt": { primaryMs: 200, primaryMaxMs: 500 },
	G1: { primaryMs: 500, primaryMaxMs: 1000, secondaryMs: 100, secondaryMaxMs: 200 },
	G2: { primaryMs: 500, primaryMaxMs: 1000, secondaryMs: 100, secondaryMaxMs: 200 },
	G3: { primaryMs: 500, primaryMaxMs: 1000, secondaryMs: 100, secondaryMaxMs: 200 },
	C: { primaryMs: 100, primaryMaxMs: 200 },
	"R-reconnect": { primaryMs: 100, primaryMaxMs: 200 },
	"R-restart": { primaryMs: 100, primaryMaxMs: 200 },
	"T-on-time": { primaryMs: 200, primaryMaxMs: 500, secondaryMs: null, secondaryMaxMs: null },
	"T-late": { primaryMs: 200, primaryMaxMs: 500, secondaryMs: null, secondaryMaxMs: null },
	"U-unframed": { compatibilityOnly: true },
	"U-legacy": { compatibilityOnly: true },
	D: { lifecycleOnly: true },
};

export function ceilQuantile(values, p) {
	if (!Array.isArray(values) || values.length === 0) throw new Error("quantile requires non-empty values");
	if (!(p > 0 && p <= 1)) throw new Error("invalid quantile");
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
}
export function wilson95(successes, n) {
	if (!Number.isInteger(n) || n <= 0 || successes < 0 || successes > n) throw new Error("invalid Wilson input");
	const p = successes / n, z = 1.959963984540054, z2 = z * z;
	const denom = 1 + z2 / n, center = (p + z2 / (2 * n)) / denom;
	const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denom;
	return { low: Math.max(0, center - margin), high: Math.min(1, center + margin), p };
}

function finiteOrInfinity(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : Infinity;
}
function lastAction(actions, predicate) {
	return [...(actions ?? [])].reverse().find(predicate) ?? null;
}
function childCompleteAligned(actions, childEvents, frameId) {
	const writes = (childEvents ?? []).filter((event) => event.event === "stdout-write" && event.frame === frameId && (event.phase === "closed" || event.phase === "closed-live"));
	if (writes.length === 0) return null;
	const target = writes.at(-1);
	const index = (childEvents ?? []).indexOf(target);
	let command = null;
	for (let i = index; i >= 0; i -= 1) {
		if (childEvents[i].event === "command" && childEvents[i].step !== undefined) { command = childEvents[i]; break; }
	}
	if (command === null) return null;
	const parent = lastAction(actions, (action) => action.type === "child-command" && action.detail?.step === command.step);
	if (parent === null) return null;
	return parent.at + (Number(target.monoNs) - Number(command.monoNs)) / 1e6;
}
function observationAt(observations, index) {
	const obs = observations?.[index];
	return typeof obs?.boundaryParsedAt === "number" ? obs.boundaryParsedAt : null;
}
function mountedAt(actions) {
	return lastAction(actions, (action) => action.type === "attach-mounted")?.at ?? null;
}
export function findMatchingObservationIndex(observations, targetRows) {
	if (!Array.isArray(targetRows) || targetRows.length === 0) return -1;
	for (let i = 0; i < (observations ?? []).length; i += 1) {
		const rows = observations[i]?.grid?.map((row) => row.text.replace(/\s+$/u, "")) ?? [];
		for (let offset = 0; offset + targetRows.length <= rows.length; offset += 1) {
			if (targetRows.every((text, j) => rows[offset + j] === text)) return i;
		}
	}
	return -1;
}

export function extractBQ(summary) {
	const total = summary?.totalEntryMs;
	return { metric: "entry-total", latencyMs: typeof total === "number" ? total : Infinity, correct: summary?.ok === true && summary?.correctness?.all === true, source: "summary.totalEntryMs" };
}
export function extractS(summary, actions, childEvents) {
	const targetId = summary?.finalTarget?.frameId;
	const complete = targetId ? childCompleteAligned(actions, childEvents, targetId) : null;
	const commit = lastAction(actions, (action) => typeof action.type === "string" && action.type.includes("commit-observed"))?.at ?? null;
	return { metric: "complete-child-frame-to-commit", latencyMs: complete !== null && commit !== null ? commit - complete : Infinity, correct: summary?.ok === true && summary?.finalTarget?.committed === true, source: "child stdout-write(closed)+analysis child-command/commit" };
}
export function extractLG(summary, actions, observations) {
	const index = summary?.analysis?.firstContentFrameIndex;
	const commit = typeof index === "number" ? observationAt(observations, index) : null;
	const mount = mountedAt(actions);
	return { metric: "entry-to-first-correct-work-area", latencyMs: commit !== null && mount !== null ? commit - mount : Infinity, correct: summary?.ok === true && summary?.analysis?.firstContentHasTailAndInput === true, source: "analysis.attach-mounted->observations[firstContentFrameIndex]" };
}
export function extractG(summary, actions, observations, childEvents) {
	const targetRows = summary?.declared?.targetFrame?.rows;
	const targetIndex = findMatchingObservationIndex(observations, targetRows);
	const targetCommit = targetIndex >= 0 ? observationAt(observations, targetIndex) : null;
	const mount = mountedAt(actions);
	const total = { metric: "entry-to-correct-target", latencyMs: targetCommit !== null && mount !== null ? targetCommit - mount : Infinity, correct: summary?.ok === true && targetIndex >= 0, source: "analysis.attach-mounted->observations[target rows]" };
	const targetId = summary?.declared?.targetFrame?.id;
	const complete = targetId ? childCompleteAligned(actions, childEvents, targetId) : null;
	const commit = targetCommit;
	return { ...total, secondaryMetric: "target-complete-frame-to-commit", secondaryLatencyMs: complete !== null && commit !== null ? commit - complete : Infinity, secondarySource: "child target closed write+analysis child-command/commit" };
}
export function extractC(summary) {
	const complete = summary?.completeFrameAt, publish = summary?.publishAt;
	return { metric: "complete-editor-to-commit", latencyMs: typeof complete === "number" && typeof publish === "number" ? publish - complete : Infinity, startupCompleteFrameAt: complete ?? null, correct: summary?.ok === true && summary?.contractOk === true, source: "summary.publishAt-completeFrameAt" };
}
export function extractRReconnect(summary, observations) {
	const index = summary?.windowAnalysis?.firstF1Index;
	const commit = typeof index === "number" ? observationAt(observations, index) : null;
	return { metric: "restored-frame-to-commit", latencyMs: Infinity, commitAt: commit, correct: summary?.f1Committed === true && summary?.windowAnalysis?.ok === true };
}
export function extractRReconnectWithRx(summary, observations, rxLines) {
	const index = summary?.windowAnalysis?.firstF1Index;
	const commit = typeof index === "number" ? observationAt(observations, index) : null;
	const output = (rxLines ?? []).find((line) => line.msg?.type === "output" && typeof line.msg.data === "string" && line.msg.data.includes("F1 ")) ?? null;
	return { metric: "restored-frame-to-commit", latencyMs: output !== null && commit !== null ? commit - output.at : Infinity, correct: summary?.f1Committed === true && summary?.windowAnalysis?.ok === true, source: "rx output F1 receipt->observations[firstF1Index]" };
}
export function extractRRestart(summary, rxLines) {
	const commit = summary?.gen2Proof?.observedAt ?? null;
	const output = (rxLines ?? []).find((line) => line.msg?.type === "output" && typeof line.msg.data === "string" && line.msg.data.includes("gen-2 F0 ")) ?? null;
	return { metric: "restored-frame-to-commit", latencyMs: output !== null && typeof commit === "number" ? commit - output.at : Infinity, correct: summary?.gen2Committed === true && summary?.gen2Proof?.literalMatched === true, source: "rx gen-2 F0 output receipt->summary.gen2Proof.observedAt" };
}
export function extractT(summary) {
	const mount = mountedAt(summary?.actions ?? []);
	const first = (summary?.postFirstContentCommits ?? []).find((entry) => entry.identity === "t0-complete") ?? null;
	const reply = summary?.reply?.injectedAt;
	const redraw = summary?.themeRedraw?.boundaryParsedAt;
	return {
		metric: "initial-content",
		latencyMs: typeof mount === "number" && typeof first?.boundaryParsedAt === "number" ? first.boundaryParsedAt - mount : Infinity,
		secondaryMetric: "theme-reply-to-redraw",
		secondaryLatencyMs: typeof reply === "number" && typeof redraw === "number" ? redraw - reply : Infinity,
		correct: summary?.ok === true && summary?.themeCompletion === "completed",
		source: "analysis.attach-mounted->postFirstContentCommits[t0]; reply.injectedAt->themeRedraw",
	};
}
export function summarizeFormal(records, { latency, thresholdMs, maxMs, secondaryLatency = null, secondaryThresholdMs = null, secondaryMaxMs = null, compatibilityOnly = false, lifecycleOnly = false }) {
	const n = records.length;
	const infra = records.filter((record) => record.classification === "infrastructure").length;
	const latencies = records.map((record) => finiteOrInfinity(latency(record)));
	const productCorrect = records.filter((record) => record.correct === true).length;
	const timely = compatibilityOnly || lifecycleOnly ? 0 : records.filter((record, index) => record.correct === true && latencies[index] <= thresholdMs).length;
	const secondary = secondaryLatency === null ? null : records.map((record) => finiteOrInfinity(secondaryLatency(record)));
	const summary = {
		n, infra, infraRate: n === 0 ? 0 : infra / n, infraInvalid: n === 0 || infra / n > 0.05,
		productCorrect, timelyCorrect: timely, unmeasured: latencies.filter((value) => !Number.isFinite(value)).length,
		p50: ceilQuantile(latencies, 0.5), p95: ceilQuantile(latencies, 0.95), max: Math.max(...latencies),
		wilson95: wilson95(timely, n),
		thresholdMs, maxMs, secondary: secondary === null ? null : { p50: ceilQuantile(secondary, 0.5), p95: ceilQuantile(secondary, 0.95), max: Math.max(...secondary), thresholdMs: secondaryThresholdMs, maxAllowedMs: secondaryMaxMs },
	};
	if (compatibilityOnly) summary.passes = !summary.infraInvalid && productCorrect === n;
	else if (lifecycleOnly) summary.passes = !summary.infraInvalid && records.every((record) => record.lifecycleValid === true);
	else summary.passes = !summary.infraInvalid && productCorrect === n && summary.unmeasured === 0 && summary.p95 <= thresholdMs && summary.max <= maxMs && (secondary === null || (secondary.every(Number.isFinite) && summary.secondary.p95 <= secondaryThresholdMs && summary.secondary.max <= secondaryMaxMs));
	return summary;
}
