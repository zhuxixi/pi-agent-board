/**
 * Perf-gate decision — a pure function of two environment variables (issue #121).
 *
 * The A11 perf assertions are only meaningful in a quiet, non-instrumented
 * environment: c8 instrumentation inflates measured latency ~2.5–6× and the
 * parallel suite adds contention noise (see research/03 in the issue-121
 * research dir). They must therefore never decide results inside `npm test`
 * or `npm run test:coverage`. The only authoritative path is
 * `npm run test:perf`, which sets AGENT_BOARD_PERF_GATE=1.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ run: boolean, reason: string }}
 */
export function perfGateDecision(env = process.env) {
	const instrumented = env.NODE_V8_COVERAGE !== undefined;
	if (env.AGENT_BOARD_PERF_GATE === "1") {
		if (instrumented) {
			return {
				run: false,
				reason:
					"perf assertions refuse to measure under coverage instrumentation " +
					"(NODE_V8_COVERAGE is set); run `npm run test:perf` instead",
			};
		}
		return { run: true, reason: "" };
	}
	return {
		run: false,
		reason:
			"perf assertions are opt-in: run them via `npm run test:perf` " +
			"(or set AGENT_BOARD_PERF_GATE=1)",
	};
}
