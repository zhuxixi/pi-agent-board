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
 *
 * `not_started` requires BOTH the identity and `spawnedAt` to be absent: a
 * recorded identity is proof the spawn happened, so such a record is judged by
 * the observation. Calling it `not_started` (a releasable state) on a
 * spawned-but-incomplete record could release a still-live host and let a new
 * host double-write the session file.
 * @param {{pid:number,startToken:string|null}|null|undefined} identity The recorded identity.
 * @param {{alive:boolean,startToken:string|null}|null|undefined} observed The observation.
 * @param {number|null|undefined} spawnedAt Non-null only after spawn was confirmed.
 * @returns {"not_started"|"dead"|"owned"|"foreign"|"unknown"}
 */
export function processIdentityState(identity, observed, spawnedAt) {
	if (spawnedAt == null && identity == null) return "not_started";
	if (observed?.alive === false) return "dead";
	if (identity?.startToken == null || observed?.startToken == null) return "unknown";
	return identity.startToken === observed.startToken ? "owned" : "foreign";
}

/** Characters that may abut a path fragment in a command line without being part of it. */
const COMMAND_LINE_BOUNDARIES = /[\s"']/;

/** Windows path semantics: separators and case are not significant. */
function normalizeCommandLine(text) {
	return text.replace(/\\/g, "/").toLowerCase();
}

function isCommandLineBoundary(text, index, length) {
	const before = index === 0 ? null : text[index - 1];
	const after = index + length >= text.length ? null : text[index + length];
	return (before == null || COMMAND_LINE_BOUNDARIES.test(before)) && (after == null || COMMAND_LINE_BOUNDARIES.test(after));
}

/**
 * Whether a process command line mentions `fragment` as a whole path, not as a
 * prefix of a longer one (`view_abc` must not match `view_abcd`, nor
 * `session.jsonl` match `session-2.jsonl`). Comparison is slash- and
 * case-insensitive because Windows reports `C:\x\y` inside quotes while the
 * recorded fragment is a plain path (issue #217). Empty/missing input is never
 * a match: a blank fragment would otherwise corroborate any process.
 * @param {string|null|undefined} commandLine
 * @param {string|null|undefined} fragment
 * @returns {boolean}
 */
export function commandLineMentions(commandLine, fragment) {
	if (!commandLine || !fragment) return false;
	const haystack = normalizeCommandLine(commandLine);
	const needle = normalizeCommandLine(fragment);
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		if (isCommandLineBoundary(haystack, index, needle.length)) return true;
		index = haystack.indexOf(needle, index + 1);
	}
	return false;
}

/**
 * Refine a host-role observation that the token path could only call `unknown`
 * (platforms without a start token) using deterministic probe evidence
 * (issue #217). The command line is authoritative because every host role we
 * spawn carries its own unique path argument; process creation time only
 * corroborates when the command line is unreadable, and the tolerance absorbs
 * spawn→record skew. A missing probe stays `unknown` — the #70 contract: an
 * unverifiable process is never guessed as foreign.
 * @param {{
 *   spawnedAt: number|null,
 *   probe: {creationTimeMs: number|null, commandLine: string|null}|null,
 *   expectedCommandFragment: string|null,
 *   toleranceMs: number,
 * }} input
 * @returns {"owned"|"foreign"|"unknown"}
 */
export function classifyUnverifiableProcess({ spawnedAt, probe, expectedCommandFragment, toleranceMs }) {
	if (!probe) return "unknown";
	if (probe.commandLine && expectedCommandFragment) {
		return commandLineMentions(probe.commandLine, expectedCommandFragment) ? "owned" : "foreign";
	}
	if (spawnedAt == null || probe.creationTimeMs == null) return "unknown";
	return Math.abs(probe.creationTimeMs - spawnedAt) <= toleranceMs ? "owned" : "foreign";
}

/** Role observations that mean "no live process can belong to the old instance". */
const SAFE_TO_RELEASE = new Set(["not_started", "dead", "foreign"]);

/**
 * Whether an exited/failed host can be replaced by a new claim. The runner and
 * child roles must be provably gone; any `unknown` observation or an active
 * launch lease blocks replacement. The claim role does NOT participate: claim
 * protection (a launcher mid-transaction between claim and spawn) only matters
 * while the host is `starting`, and this gate only ever sees terminal hosts —
 * a terminal host cannot still be being launched (issue #99: a live claimPid —
 * the dashboard process that wrote the claim — must not block re-attach).
 * @param {{
 *   host: HostStatus|null|undefined,
 *   runnerObservation: string,
 *   childObservation: string,
 *   launchLeaseActive: boolean,
 * }} input
 * @returns {boolean}
 */
export function canReplaceHost({ host, runnerObservation, childObservation, launchLeaseActive }) {
	if (!host || (host.state !== "exited" && host.state !== "failed")) return false;
	if (launchLeaseActive) return false;
	return (
		SAFE_TO_RELEASE.has(runnerObservation) &&
		SAFE_TO_RELEASE.has(childObservation)
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

/**
 * Whether a legacy (pre-instanceId) host record can be safely finalized as
 * `exited` so the next attach claims a fresh host. Spec §10.1 keeps legacy
 * hosts unrecovered because their identity is unverifiable — but a provably
 * dead runner pid IS a certain identity (a reused pid reads alive, which
 * conservatively lands here as false), and an unreachable endpoint (missing
 * socket file / refused socket) rules out a merely slow host. All four
 * conditions must hold at once (issue #87).
 * @param {{
 *   host: HostStatus|null|undefined,
 *   hostPid: number|null|undefined,
 *   hostPidAlive: boolean,
 *   probeClassification: string,
 * }} input
 * @returns {boolean}
 */
export function canFinalizeLegacyHost({ host, hostPid, hostPidAlive, probeClassification }) {
	if (!host || host.instanceId != null) return false;
	if (host.state !== "starting" && host.state !== "alive") return false;
	if (hostPid == null || hostPidAlive) return false;
	return probeClassification === "missing" || probeClassification === "stale";
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
