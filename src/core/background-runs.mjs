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
import { readdirSync, readFileSync, statSync } from "node:fs";
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
 * `null` when it is not a workflow run. A v2 record nests the run fields under
 * `index` but keeps `summary` (and therefore the checkpoint) as a sibling at the
 * record root; legacy flat records carry `checkpoint` at the root themselves and
 * can never match a row because they have no `parentSessionFile` (spec non-goal:
 * no legacy session matching).
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
		hasCheckpoint: Boolean(record.summary?.checkpoint ?? source.checkpoint),
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
 * @typedef {RunHead & { path: string, mtimeMs: number }} RunHeadWithPath
 */

/**
 * Enumerate every run head under `<workflowHome>/projects/<project>/runs/`.
 * Only `*.json` regular files are candidates (upstream keeps `.bak`,
 * `.events.jsonl`, `.log` and `.result-*` siblings next to the head), and
 * `minMtimeMs` drops heads too old to belong to a live host — a prefilter only,
 * the protection verdict still comes from `classifyRunsForRow`.
 *
 * Failure policy (spec D6): an absent store is normal and yields `ok:true`; any
 * incomplete scan yields `ok:false` so the caller logs a `warm_prune_probe_failed`
 * diagnostic instead of silently guessing. An incomplete scan is any unreadable
 * directory or head file, including corrupt JSON — the eviction outcome is the
 * same either way (a run that cannot be read protects nothing), but only
 * `ok:false` tells the caller that protection was lost. Heads that were read
 * successfully are still returned for diagnostics; callers ignore them when
 * `ok` is false. A head file that parses but is not a run head
 * (`parseRunHead` → null) is not an error: it is simply not a candidate.
 * The store root is stat-ed before the child paths are enumerated because on
 * win32 a child path under a regular file reports `ENOENT` exactly like a
 * missing directory does: a missing `workflowHome` is "no store yet", a
 * `workflowHome` that is not a directory is a read failure.
 * @param {{ workflowHome: string, minMtimeMs?: number }} o
 * @returns {{ ok: boolean, heads: Array<RunHeadWithPath>, error: string|null }}
 */
export function scanBackgroundRuns({ workflowHome, minMtimeMs = 0 }) {
	const heads = [];
	let error = null;
	const noteError = (message) => {
		error ??= message;
	};

	let projects;
	try {
		if (!statSync(workflowHome).isDirectory()) {
			return { ok: false, heads: [], error: `workflow home is not a directory: ${workflowHome}` };
		}
		projects = readdirSync(joinPath(workflowHome, "projects"), { withFileTypes: true });
	} catch (e) {
		if (e?.code === "ENOENT") return { ok: true, heads: [], error: null };
		return { ok: false, heads: [], error: errorMessage(e) };
	}

	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const runsDir = joinPath(workflowHome, "projects", project.name, "runs");
		let entries;
		try {
			entries = readdirSync(runsDir, { withFileTypes: true });
		} catch (e) {
			if (e?.code !== "ENOENT") noteError(`${runsDir}: ${errorMessage(e)}`);
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const filePath = joinPath(runsDir, entry.name);
			try {
				const mtimeMs = statSync(filePath).mtimeMs;
				if (mtimeMs < minMtimeMs) continue;
				const head = parseRunHead(JSON.parse(readFileSync(filePath, "utf8")));
				if (head) heads.push({ ...head, path: filePath, mtimeMs });
			} catch (e) {
				noteError(`${filePath}: ${errorMessage(e)}`);
			}
		}
	}

	return { ok: error === null, heads, error };
}

/**
 * Fresh protection probe for one row: the scan prefiltered to runs that could
 * have been updated by this host incarnation, classified against the row's
 * session file. Each field answers one question and is filled independently
 * (design §5.1: a running/paused split): `running` is the run that must keep the
 * host alive (spec D1), `paused` is the run whose interruption the reconcile
 * pass announces (spec D2). They coexist because one session may hold an older
 * paused run while a new one is running, and each consumer reads one field.
 * `ok:false` only means the store could not be read (spec D6).
 * @param {{ sessionFile: string|null, hostStartedAt: number|null, workflowHome: string }} o
 * @returns {{ ok: boolean, running: RunHeadWithPath|null, paused: RunHeadWithPath|null, error: string|null }}
 */
export function probeBackgroundRun({ sessionFile, hostStartedAt, workflowHome }) {
	const minMtimeMs = hostStartedAt == null ? 0 : hostStartedAt - CLOCK_EPSILON_MS;
	const scan = scanBackgroundRuns({ workflowHome, minMtimeMs });
	if (!scan.ok) return { ok: false, running: null, paused: null, error: scan.error };
	const verdict = classifyRunsForRow(scan.heads, { sessionFile, hostStartedAt });
	const running = verdict.state === "protecting" ? verdict.run : null;
	// Newest paused run wins, because it is the one most likely to be the run the
	// just-ended host left behind; `path` only breaks ties deterministically.
	const paused = scan.heads
		.filter((head) => classifyRunForRow(head, { sessionFile, hostStartedAt }) === "paused")
		.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0) || a.path.localeCompare(b.path))[0] ?? null;
	return { ok: true, running, paused, error: scan.error };
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
 * @param {unknown} e
 * @returns {string}
 */
function errorMessage(e) {
	return e instanceof Error ? e.message : String(e);
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
