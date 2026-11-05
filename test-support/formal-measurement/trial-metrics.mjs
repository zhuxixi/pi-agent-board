// Extract actual per-trial metrics from every accepted scenario family shape.
export function extractTrialMetrics(parsed) {
	const trial = parsed?.trials?.[0] ?? parsed ?? {};
	const evidence = trial.evidence ?? {};
	const timeline = parsed?.timeline ?? trial.timeline ?? evidence.timeline ?? {};
	const correctness = parsed?.correctness ?? trial.correctness ?? evidence.correctness ?? {};
	const explicitObservation = parsed?.observation ?? trial.observation ?? evidence.observation;
	const observation = explicitObservation ?? (parsed?.observationStartMs !== undefined ? {
		observationStartMs: parsed.observationStartMs,
		observationEndMs: parsed.observationEndMs,
		observationActualMs: parsed.observationActualMs,
		observationCompletion: parsed.observationCompletion,
	} : trial.observationStartMs !== undefined ? {
		observationStartMs: trial.observationStartMs,
		observationEndMs: trial.observationEndMs,
		observationActualMs: trial.observationActualMs,
		observationCompletion: trial.observationCompletion,
	} : parsed?.postWindow ?? trial.postWindow ?? {});
	const firstTrial = parsed?.trials?.[0] ?? parsed ?? {};
	const actual = (value) => value === undefined || value === null ? "UNKNOWN" : value;
	const frameFailures = firstTrial.frameFailures ?? parsed?.frameFailures ?? "UNKNOWN";
	const detach = parsed?.detach ?? trial.detach ?? evidence.detach ?? {};
	return {
		readyLatencyMs: actual(parsed?.totalEntryMs ?? firstTrial.totalEntryMs ?? firstTrial.readyLatencyMs ?? evidence.readyLatencyMs),
		select: actual(timeline.select ?? parsed?.timeline?.select),
		overlay: actual(timeline.overlayMounted ?? parsed?.timeline?.overlayMounted),
		connected: actual(timeline.connected),
		snapshotValidated: actual(timeline.snapshotValidated),
		snapshotParsed: actual(timeline.snapshotParsed),
		childFrameComplete: actual(timeline.childFrameComplete?.state ?? firstTrial.childFrameComplete?.state),
		renderRequested: actual(timeline.renderRequested),
		terminalCommitted: actual(timeline.terminalCommitted),
		resizeSizes: actual(firstTrial.resizeSizes ?? parsed?.resizeSizes),
		correct: parsed?.ok === true && firstTrial.ok !== false,
		frameFailures: actual(frameFailures),
		inputUsable: actual(detach?.result?.action === "detached" || correctness?.inputOutputPaths?.input?.usable === true ? true : undefined),
		outputUsable: actual(correctness?.completeLiteralGrid ?? correctness?.inputOutputPaths?.output?.usable),
		detachUsable: actual(detach?.result?.action === "detached" ? true : undefined),
		observationStartMs: actual(observation.observationStartMs ?? observation.start),
		observationEndMs: actual(observation.observationEndMs ?? observation.end),
		observationActualMs: actual(observation.observationActualMs),
		observationCompletion: actual(observation.observationCompletion ?? (observation.observationActualMs !== undefined ? "completed" : undefined)),
		themeCompletion: actual(parsed?.themeCompletion ?? trial.themeCompletion ?? evidence.themeCompletion),
		recoveryCompletion: actual(parsed?.recoveryCompletion ?? trial.recoveryCompletion ?? evidence.recoveryCompletion),
	};
}
