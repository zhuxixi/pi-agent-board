/**
 * Background-workflow run detection for warm-host eviction (issue #230).
 *
 * A warm host whose session owns a `running` pi-workflow run must not be swept:
 * eviction revokes the host, the child pi gets SIGTERM, and the in-flight agent
 * step turns into a `skipped/interrupted` event — the run ends `paused` while the
 * user is never told. The sweeper cannot see this from row state because
 * `workflow({ background: true })` returns `started` before the step finishes, so
 * the row falls back to `idle` and looks evictable.
 *
 * This module is the pure decision core: parse a run head record, match it to a
 * row's session file, and classify the protection outcome. All IO (directory
 * scan, mtime prefilter) belongs to the caller. Design:
 * docs/superpowers/specs/2026-10-24-issue-230-warm-host-background-runs-design.md
 */
import * as os from "node:os";
import * as path from "node:path";

/** Timestamp tolerance for FS mtime granularity and cross-process clock skew
 *  when comparing a run's `updatedAt` against the host start time (spec D1). */
export const CLOCK_EPSILON_MS = 2000;

/**
 * @typedef {Object} RunHead
 * @property {string} runId
 * @property {string} status
 * @property {string|null} parentSessionFile legacy records carry none
 * @property {number|null} startedAtMs
 * @property {number|null} updatedAtMs
 * @property {boolean} hasCheckpoint
 */

/** @typedef {"protecting"|"paused"|"irrelevant"} RunVerdict */

/**
 * Root directory of pi-dynamic-workflows: `$AGENT_BOARD_WORKFLOW_HOME` (explicit
 * override) > `$PI_CODING_AGENT_DIR/workflows` > `<home>/.pi/workflows`.
 * Both `env` and `home` are injectable so callers and tests never depend on the
 * ambient environment or the real homedir.
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [o]
 * @returns {string}
 */
export function resolveWorkflowHome({ env = process.env, home = os.homedir() } = {}) {
	const expand = (p) => (p.startsWith("~") ? home + p.slice(1) : p);
	const explicit = env.AGENT_BOARD_WORKFLOW_HOME;
	if (typeof explicit === "string" && explicit.length > 0) return expand(explicit);
	const agentDir = env.PI_CODING_AGENT_DIR;
	const base = typeof agentDir === "string" && agentDir.length > 0 ? expand(agentDir) : joinPath(home, ".pi");
	return joinPath(base, "workflows");
}

/**
 * Parse a run head record into the fields the protection decision needs, or
 * `null` when it is not a workflow run. v2 heads nest the payload under `index`;
 * legacy flat records are still parsed but can never match a row because they
 * have no `parentSessionFile` (spec non-goal: no legacy session matching).
 * Never throws: the input is external, unversioned JSON.
 * @param {unknown} raw parsed JSON
 * @returns {RunHead|null}
 */
export function parseRunHead(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const record = /** @type {Record<string, any>} */ (raw);
	const source = record.format === "pi-workflow-run-v2" ? record.index : record;
	if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
	if (typeof source.runId !== "string") return null;
	return {
		runId: source.runId,
		status: typeof source.status === "string" ? source.status : "",
		parentSessionFile: typeof source.parentSessionFile === "string" ? source.parentSessionFile : null,
		startedAtMs: toMs(source.startedAt),
		updatedAtMs: toMs(source.updatedAt),
		hasCheckpoint: Boolean(source.summary?.checkpoint ?? source.checkpoint),
	};
}

/**
 * Whether two spellings point at the same session file. win32 compares
 * case-insensitively (the row meta and the workflow record disagree on drive
 * letter and segment casing; they also mix `\` and `/`); POSIX stays
 * case-sensitive. `platform` is injectable because CI only runs Linux, so the
 * win32 branch would otherwise be untested (spec A5).
 * @param {string} a
 * @param {string} b
 * @param {{ platform?: string }} [o]
 * @returns {boolean}
 */
export function isSameSessionFile(a, b, { platform = process.platform } = {}) {
	if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
	const impl = platform === "win32" ? path.win32 : path.posix;
	const na = impl.resolve(a);
	const nb = impl.resolve(b);
	return platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Protection verdict for one run against one row (spec D1/D2).
 *
 * Order matters: a run belonging to another session is always irrelevant (a
 * running or paused run of a sibling row must never keep this host alive);
 * `paused` is reported separately because a paused run needs no host at all and
 * only drives the "run was interrupted" notice; a running run protects only when
 * it was updated after the host started, so a stale `running` record left behind
 * by a previous host incarnation cannot exempt the row forever.
 * @param {RunHead|null|undefined} run
 * @param {{ sessionFile: string|null|undefined, hostStartedAt: number|null|undefined }} o
 * @returns {RunVerdict}
 */
export function classifyRunForRow(run, { sessionFile, hostStartedAt }) {
	if (!run || !run.parentSessionFile) return "irrelevant";
	if (!isSameSessionFile(run.parentSessionFile, sessionFile)) return "irrelevant";
	if (run.status === "paused") return "paused";
	if (run.status !== "running") return "irrelevant";
	if (hostStartedAt == null || run.updatedAtMs == null) return "protecting";
	if (run.updatedAtMs >= hostStartedAt - CLOCK_EPSILON_MS) return "protecting";
	return "irrelevant";
}

/**
 * Strongest verdict across a scanned head list: protecting > paused >
 * irrelevant. Returns the run that produced it so callers can name its runId in
 * a diagnostic or a row notice; `run` is null for "irrelevant".
 * @param {Array<RunHead|null|undefined>} runs
 * @param {{ sessionFile: string|null|undefined, hostStartedAt: number|null|undefined }} o
 * @returns {{ state: RunVerdict, run: RunHead|null }}
 */
export function classifyRunsForRow(runs, o) {
	let state = /** @type {RunVerdict} */ ("irrelevant");
	let match = null;
	for (const run of Array.isArray(runs) ? runs : []) {
		const verdict = classifyRunForRow(run, o);
		if (verdict === "protecting") return { state: "protecting", run };
		if (verdict === "paused" && state === "irrelevant") {
			state = "paused";
			match = run;
		}
	}
	return { state, run: match };
}

/**
 * Join segments with the separator style of the base path. The ambient
 * `path.join` uses the host separator, which would turn POSIX-style injected
 * inputs (tests, Linux CI) into backslash paths when the suite runs on Windows,
 * so the style is read from the base instead of the platform.
 * @param {string} base
 * @param {...string} parts
 * @returns {string}
 */
function joinPath(base, ...parts) {
	const impl = /^[A-Za-z]:/.test(base) || base.includes("\\") ? path.win32 : path.posix;
	return impl.join(base, ...parts);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toMs(value) {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}
