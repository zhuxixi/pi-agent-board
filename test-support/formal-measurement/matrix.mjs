export const MATRIX_VERSION = 1;
export const WARMUPS_PER_VERSION = 5;
export const OBSERVATION_MS = 3000;
export const B_UPDATE_MS = 25;
export const TRIAL_CAP_MS = 10000;
export const HARD_OPPORTUNITY_MS = 2500;
export const INFRA_LIMIT = 0.05;

export const CELLS = [
	{ cellId: "B", n: 100, thresholdMs: 200, maxMs: 500, kind: "hot" },
	{ cellId: "Q", n: 100, thresholdMs: 200, maxMs: 500, kind: "hot" },
	{ cellId: "S", n: 100, thresholdMs: 100, maxMs: 200, kind: "complete-frame" },
	{ cellId: "L-normal", n: 100, thresholdMs: 200, maxMs: 500, kind: "complete-frame" },
	{ cellId: "L-alt", n: 100, thresholdMs: 200, maxMs: 500, kind: "complete-frame" },
	{ cellId: "G1", n: 30, thresholdMs: 500, maxMs: 1000, kind: "geometry", completeFrameP95Ms: 100, completeFrameMaxMs: 200 },
	{ cellId: "G2", n: 30, thresholdMs: 500, maxMs: 1000, kind: "geometry", completeFrameP95Ms: 100, completeFrameMaxMs: 200 },
	{ cellId: "G3", n: 30, thresholdMs: 500, maxMs: 1000, kind: "geometry", completeFrameP95Ms: 100, completeFrameMaxMs: 200 },
	{ cellId: "C", n: 30, thresholdMs: 100, maxMs: 200, kind: "complete-frame", startupListed: true },
	{ cellId: "R-reconnect", n: 30, thresholdMs: 100, maxMs: 200, kind: "complete-frame" },
	{ cellId: "R-restart", n: 30, thresholdMs: 100, maxMs: 200, kind: "complete-frame" },
	{ cellId: "T-on-time", n: 30, thresholdMs: 200, maxMs: 500, kind: "initial-publish" },
	{ cellId: "T-late", n: 30, thresholdMs: 200, maxMs: 500, kind: "initial-publish" },
	{ cellId: "U-unframed", n: 30, thresholdMs: 200, maxMs: 500, kind: "legacy" },
	{ cellId: "U-legacy", n: 30, thresholdMs: 200, maxMs: 500, kind: "legacy" },
	{ cellId: "D", n: 30, thresholdMs: null, maxMs: null, kind: "lifecycle" },
];

export function scheduleFor(n) {
	if (!Number.isInteger(n) || n <= 0 || n % 2 !== 0) throw new Error("scheduleFor requires an even positive trial count");
	const half = n / 2;
	return [
		...(Array(half).fill("candidate:first")),
		...(Array(half).fill("baseline:first")),
		...(Array(half).fill("baseline:second")),
		...(Array(half).fill("candidate:second")),
	];
}

export function validateSchedule(n) {
	const schedule = scheduleFor(n);
	if (schedule.length !== 2 * n) throw new Error(`schedule length ${schedule.length} != ${2 * n}`);
	const candidate = schedule.filter((entry) => entry.startsWith("candidate:")).length;
	const baseline = schedule.filter((entry) => entry.startsWith("baseline:")).length;
	if (candidate !== n || baseline !== n) throw new Error(`schedule versions candidate=${candidate} baseline=${baseline} != ${n}`);
	return schedule;
}
