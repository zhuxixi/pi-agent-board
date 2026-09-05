/**
 * Pure host-lifecycle decision functions (issue #70).
 *
 * Every function here takes plain snapshots (HostStatus-shaped objects, probe
 * results, process observations) and returns a decision — no fs/net/process
 * I/O. Callers (locks, store, service, runner) own all side effects; this
 * module is the single source of truth for the coordination rules so they can
 * be unit-tested exhaustively.
 *
 * @typedef {import("./types.mjs").HostStatus} HostStatus
 */

/**
 * Whether `host` is owned by the given fencing token. A null/missing
 * instanceId never matches — legacy hosts have no owner token.
 * @param {HostStatus|null|undefined} host
 * @param {string|null|undefined} expectedInstanceId
 * @returns {boolean}
 */
export function sameHostOwner(host, expectedInstanceId) {
	if (!host || !expectedInstanceId) return false;
	return host.instanceId === expectedInstanceId;
}

/**
 * Whether a `starting` claim is still inside the launch grace window.
 * A missing runnerPid or socket does NOT make a fresh claim stale (issue #70:
 * provisional claims are normal while the runner boots).
 * @param {HostStatus|null|undefined} host
 * @param {number} now Epoch ms.
 * @param {number} graceMs
 * @returns {boolean}
 */
export function isStartingWithinGrace(host, now, graceMs) {
	if (!host || host.state !== "starting" || host.claimAt == null) return false;
	return now - host.claimAt < graceMs;
}

/**
 * Classify a recorded process identity against a live observation.
 * Five states — `not_started` (never spawned) must never be conflated with
 * `dead`, and a missing stable token must never be guessed as alive-owned:
 * it degrades to `unknown` so recovery can only refuse, never misfire.
 * @param {{pid:number,startToken:string|null}|null|undefined} identity The recorded identity.
 * @param {{alive:boolean,startToken:string|null}|null|undefined} observed The observation.
 * @param {number|null|undefined} spawnedAt Non-null only after spawn was confirmed.
 * @returns {"not_started"|"dead"|"owned"|"foreign"|"unknown"}
 */
export function processIdentityState(identity, observed, spawnedAt) {
	if (spawnedAt == null) return "not_started";
	if (observed?.alive === false) return "dead";
	if (identity?.startToken == null || observed?.startToken == null) return "unknown";
	return identity.startToken === observed.startToken ? "owned" : "foreign";
}

/** Role observations that mean "no live process can belong to the old instance". */
const SAFE_TO_RELEASE = new Set(["not_started", "dead", "foreign"]);

/**
 * Whether an exited/failed host can be replaced by a new claim. Every role
 * (runner, child, provisional-claim launcher) must be provably gone; any
 * `unknown` observation or an active launch lease blocks replacement.
 * @param {{
 *   host: HostStatus|null|undefined,
 *   runnerObservation: string,
 *   childObservation: string,
 *   claimObservation: string,
 *   launchLeaseActive: boolean,
 * }} input
 * @returns {boolean}
 */
export function canReplaceHost({ host, runnerObservation, childObservation, claimObservation, launchLeaseActive }) {
	if (!host || (host.state !== "exited" && host.state !== "failed")) return false;
	if (launchLeaseActive) return false;
	return (
		SAFE_TO_RELEASE.has(runnerObservation) &&
		SAFE_TO_RELEASE.has(childObservation) &&
		SAFE_TO_RELEASE.has(claimObservation)
	);
}

/**
 * Whether the endpoint file at `current` is the one this instance bound.
 * Compares dev+ino so a replaced (rebound) socket path is never unlinked by
 * its former owner.
 * @param {{dev:number,ino:number}|null|undefined} bound Identity recorded at bind time.
 * @param {{dev:number,ino:number}|null|undefined} current Identity observed at cleanup time.
 * @returns {boolean}
 */
export function ownsEndpoint(bound, current) {
	return Boolean(bound && current && bound.dev === current.dev && bound.ino === current.ino);
}

/**
 * Classify a connect+hello probe snapshot into the coordination enum.
 * Order: connection errors first (they carry the errorCode), then protocol
 * validity, then ownership mismatch (`occupied` — never touch), then
 * readiness. A valid matching host that is not ready yet is `starting`, which
 * callers treat as "wait", never as stale.
 * @param {{
 *   connected?: boolean,
 *   protocolValid?: boolean,
 *   viewMatch?: boolean,
 *   instanceMatch?: boolean,
 *   state?: string|null,
 *   readyAt?: number|null,
 *   errorCode?: string|null,
 *   isSocket?: boolean,
 * }} result Probe snapshot from host-probe.
 * @returns {"ready"|"starting"|"stale"|"occupied"|"missing"|"unknown"}
 */
export function classifyProbeResult(result) {
	if (!result) return "unknown";
	if (!result.connected) {
		if (result.errorCode === "ENOENT") return "missing";
		if (result.errorCode === "ECONNREFUSED" && result.isSocket) return "stale";
		return "unknown";
	}
	if (!result.protocolValid) return "unknown";
	if (result.viewMatch === false || result.instanceMatch === false) return "occupied";
	if (result.state === "alive" && result.readyAt != null) return "ready";
	return "starting";
}

/** Host states in which a claim exists and must not be duplicated. */
const ACTIVE_STATES = new Set(["starting", "alive", "stopping"]);

/**
 * Whether a runner starting for `instanceId` must yield because the host
 * record belongs to another still-active instance.
 * @param {{host: HostStatus|null|undefined, instanceId: string|null|undefined}} input
 * @returns {boolean}
 */
export function shouldYieldRunner({ host, instanceId }) {
	if (!host || host.instanceId === instanceId) return false;
	return ACTIVE_STATES.has(host.state);
}

/**
 * Whether a host is ready to accept service-generated input: alive, ready,
 * and not revoked.
 * @param {HostStatus|null|undefined} host
 * @returns {boolean}
 */
export function shouldAcceptInput(host) {
	if (!host || host.state !== "alive" || host.readyAt == null) return false;
	return host.stopRequestedAt == null;
}

/**
 * Whether a failed `listen` with this error may be retried (only EADDRINUSE,
 * only the single configured retry).
 * @param {string|null|undefined} errorCode
 * @param {number} attempt Zero-based retry attempt already made.
 * @returns {boolean}
 */
export function shouldRetryBind(errorCode, attempt) {
	return errorCode === "EADDRINUSE" && attempt < 1;
}
