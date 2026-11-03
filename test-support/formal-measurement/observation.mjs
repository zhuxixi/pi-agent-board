export const FORMAL_OBSERVATION_MS = 3000;

export function formalObservationEnabled() {
	return process.env.FORMAL_MEASURE_VERSION === "candidate" || process.env.FORMAL_MEASURE_VERSION === "baseline";
}

export async function holdFormalObservation(now, sleep, label = "formal-post-content") {
	if (!formalObservationEnabled()) return null;
	const start = now();
	await sleep(FORMAL_OBSERVATION_MS + 50);
	const end = now();
	return {
		label,
		observationStartMs: start,
		observationEndMs: end,
		observationActualMs: end - start,
		observationCompletion: "completed",
	};
}

export function withObservation(record, observation) {
	if (observation === null) return record;
	return {
		...record,
		observationStartMs: observation.observationStartMs,
		observationEndMs: observation.observationEndMs,
		observationActualMs: observation.observationActualMs,
		observationCompletion: observation.observationCompletion,
	};
}
