/**
 * Instrumentation gate (issue #305).
 *
 * True when the process tree runs under coverage instrumentation: c8 sets
 * NODE_V8_COVERAGE for the whole tree (children included), inflating measured
 * latency ~2.5–6× (issue #121's measurement). Absolute real-time budgets are
 * therefore only decided in plain runs. The predicate is verbatim the one the
 * perf gate uses (test-support/perf-gate.mjs, scripts/run-perf-gate.mjs).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function underCoverageInstrumentation(env = process.env) {
	return env.NODE_V8_COVERAGE !== undefined;
}
