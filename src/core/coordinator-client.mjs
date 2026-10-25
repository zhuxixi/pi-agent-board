/**
 * Client for the detached View State Coordinator (issue #91, spec D3).
 *
 * Every semantic-state writer (dashboard service, job-runner, state-runner,
 * CLI) submits `{type:"state_command"}` envelopes through `sendStateCommand`
 * instead of writing state.json/status.json directly. The client resolves the
 * coordinator endpoint, ensures a coordinator is live (spawning one if needed
 * — idempotent via the coordinator's own lease), and waits for the matching
 * `state_command_result`.
 *
 * Ambiguity contract (binding, from the Task 4 review): the coordinator can
 * crash mid-command (e.g. an fs error) WITHOUT replying. The client then sees
 * a connection reset or a timeout. Both mean the command MAY already be
 * journaled and will replay on coordinator restart, so these outcomes are
 * AMBIGUOUS: they resolve `{status:"rejected", reason:"timeout"|
 * "connection_reset", materializedRevision:0}` and the client NEVER retries
 * with a fresh commandId. Retrying with the SAME commandId after reconnect is
 * safe (the coordinator dedupes) but is the caller's decision — which is why
 * the caller may pin `command.commandId`.
 *
 * `materializedRevision: 0` on client-side outcomes means "no revision was
 * observed" — it is not a store revision. Real coordinator replies always
 * carry the actual revision (≥ 1 after any applied command; decided
 * rejections carry the current revision).
 */
import { createConnection } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appendDiagnosticOnce } from "./diagnostics.mjs";
import { newRunId } from "./ids.mjs";
import { launchCoordinator } from "./launch.mjs";
import { isAlive } from "./pid.mjs";
import { readProcessStartToken } from "./process-identity-probe.mjs";
import * as P from "./paths.mjs";
import { COORDINATOR_PROTOCOL_VERSION } from "./coordinator-protocol.mjs";

const COORDINATOR_SCRIPT = fileURLToPath(
	new URL("../../runner/state-coordinator.mjs", import.meta.url),
);

const PROBE_TIMEOUT_MS = 1_000;
const ENSURE_WINDOW_MS = 10_000;
const ENSURE_POLL_MS = 100;
const COMMAND_TIMEOUT_MS = 5_000;

/** @typedef {{ status: "applied"|"rejected", reason: string|null, materializedRevision: number }} StateCommandResult */
/** @typedef {{ ok: boolean, instanceId?: string, pid?: number|null, error?: "coordinator_disabled"|"coordinator_unavailable"|"coordinator_stale_protocol" }} EnsureResult */
/** @typedef {{ token: string|null, pid: number|null, instanceId: string|null, startToken: string|null }} LeaseRecord */

/**
 * Whether the coordinator is switched off for this process (tests/legacy
 * escape hatch). `AGENT_BOARD_COORDINATOR=off` makes every command resolve
 * `coordinator_disabled` so callers fall back to the pre-coordinator path.
 * @returns {boolean}
 */
export function coordinatorDisabled() {
	return /^(0|false|off|no)$/i.test(String(process.env.AGENT_BOARD_COORDINATOR ?? "").trim());
}

/**
 * One probe round-trip: connect, ping, wait for the pong. The coordinator
 * binds its socket only after boot replay, so a pong proves full readiness.
 * @param {string} socketPath
 * @param {(path: string) => import("node:net").Socket} connect
 * @param {number} timeoutMs
 * @returns {Promise<{ instanceId: string, protocolVersion: number }|null>} null on timeout/error;
 *   a pong without a numeric protocolVersion counts as version 1 (pre-#107 baseline)
 */
function probeOnce(socketPath, connect, timeoutMs) {
	return new Promise((resolve) => {
		let settled = false;
		let buffer = "";
		/** @type {import("node:net").Socket|null} */
		let socket = null;
		const finish = (instanceId) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { socket?.destroy(); } catch { /* best effort */ }
			resolve(instanceId);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref?.();
		try {
			socket = connect(socketPath);
		} catch {
			finish(null);
			return;
		}
		// Missing filesystem sockets surface as async errors, not throw-on-connect
		// (and Windows pipes never exist as files — never gate on existsSync).
		socket.on("error", () => finish(null));
		socket.on("connect", () => {
			try {
				socket?.write(JSON.stringify({ type: "ping" }) + "\n");
			} catch {
				finish(null);
			}
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg?.type === "pong" && typeof msg.instanceId === "string") {
						finish({
							instanceId: msg.instanceId,
							protocolVersion: typeof msg.protocolVersion === "number" ? msg.protocolVersion : 1,
						});
						return;
					}
				} catch {
					// malformed line — keep waiting for the pong
				}
			}
		});
	});
}

/**
 * First argument that is a non-empty string, else null. Only a non-empty
 * string identifies a process instance — "" and non-strings are treated as
 * "field missing" so a malformed record can never read as a verified identity.
 * @param {...unknown} values
 * @returns {string|null}
 */
function firstNonEmptyString(...values) {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

/**
 * Read the coordinator lease's owner.json in a decision-friendly shape. The
 * lease is written by whichever process owns the "_coordinator" lock, so it
 * identifies the live coordinator — but its pid alone is NOT proof that the
 * lease owner is the endpoint that answered our ping (issue #239): the pid may
 * have been reused by an unrelated process. `instanceId` (written since issue
 * #239, same value as the coordinator's pong) is what
 * `judgeReplacementTarget` compares to close that gap.
 *
 * Tolerates every historical record shape: the lock layer passes `identity`
 * through verbatim, so records written before #239 have no `instanceId` and
 * non-Linux records carry `startToken: null`. `instanceId` is read from
 * `identity` first, then from the top level (compatibility path for a future
 * shape).
 * @param {string} root
 * @returns {LeaseRecord|null} null when the lease is missing, unparsable, or
 *   not a JSON object
 */
export function readCoordinatorLeaseRecord(root) {
	try {
		const lockPath = P.viewLockPath(root, "_coordinator", "state-coordinator");
		const owner = JSON.parse(readFileSync(`${lockPath}/owner.json`, "utf8"));
		if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
		const identity = owner.identity;
		const pid = Number(identity?.pid ?? owner.pid);
		return {
			token: typeof owner.token === "string" ? owner.token : null,
			pid: Number.isFinite(pid) && pid > 0 ? pid : null,
			instanceId: firstNonEmptyString(identity?.instanceId, owner.instanceId),
			startToken: firstNonEmptyString(identity?.startToken),
		};
	} catch {
		return null;
	}
}

/**
 * Decide whether the lease owner may be signalled, given the lease record and
 * the instanceId from the pong we just received (issue #239). Pure: no fs, no
 * process, no platform checks — the caller injects the legacy live-token read.
 *
 * Decision order (first match wins):
 *   1. unreadable record / invalid pid  → skip("lease_unreadable")
 *   2. recorded instanceId present      → equal: signal, else skip("lease_owner_mismatch")
 *   3. legacy record without startToken → skip("identity_unverified")
 *   4. currentStartToken not a usable
 *      string (unreadable, or a missed
 *      await handing us a Promise)      → skip("identity_unverified")
 *   5. startToken differs               → skip("pid_reused")
 *   6. otherwise                        → signal
 *
 * Empty-string instanceId/startToken count as missing, so a malformed record
 * stays on the skip side instead of matching an empty probe value.
 * @param {{ recorded: LeaseRecord|null, probedInstanceId: string, currentStartToken?: string|null }} args
 * @returns {{ action: "signal" } | { action: "skip", reason: "lease_unreadable"|"lease_owner_mismatch"|"pid_reused"|"identity_unverified" }}
 */
export function judgeReplacementTarget({ recorded, probedInstanceId, currentStartToken = null }) {
	if (!recorded || typeof recorded.pid !== "number" || !Number.isFinite(recorded.pid) || recorded.pid <= 0) {
		return { action: "skip", reason: "lease_unreadable" };
	}
	const recordedInstanceId = firstNonEmptyString(recorded.instanceId);
	if (recordedInstanceId !== null) {
		return recordedInstanceId === probedInstanceId
			? { action: "signal" }
			: { action: "skip", reason: "lease_owner_mismatch" };
	}
	const recordedStartToken = firstNonEmptyString(recorded.startToken);
	if (recordedStartToken === null) return { action: "skip", reason: "identity_unverified" };
	if (typeof currentStartToken !== "string" || currentStartToken.length === 0) {
		return { action: "skip", reason: "identity_unverified" };
	}
	if (currentStartToken !== recordedStartToken) return { action: "skip", reason: "pid_reused" };
	return { action: "signal" };
}

/**
 * Process-local dedup keys for the replacement-skip diagnostic (issue #239 D5).
 * A stale coordinator that cannot be replaced keeps failing on every
 * `sendStateCommand` ensure, and `appendDiagnosticOnce` tails the whole JSONL
 * file (`readJsonlTail` → `readJsonl`), so a repeat must return before any disk
 * access. One entry per root × reason × identity pair for the process lifetime;
 * the key space is small and bounded by the board roots in use.
 * @type {Set<string>}
 */
const reportedReplacementSkips = new Set();

/**
 * Record that the coordinator replacement was deliberately skipped (issue #239
 * D5). `reason` is one of the spec's `SkipReason` values. Best-effort by
 * contract: the skip paths run inside `ensureCoordinator`, which
 * `sendStateCommand` does not wrap, so every error here (malformed args,
 * unreadable/unwritable JSONL) is swallowed instead of thrown.
 *
 * Two-layer dedup: this process-local Set filters the hot path without touching
 * disk, then `appendDiagnosticOnce` dedupes across processes/restarts. The root
 * existence check comes before the append because appending creates parent
 * directories — a diagnostic must never resurrect a deleted root (issue #241
 * class of leftovers). The key is recorded even when the write is skipped, so a
 * state that was already handled never probes the disk again.
 * @param {string} root
 * @param {{ reason: string, recordedInstanceId?: string|null, probedInstanceId: string }} details
 * @returns {void}
 */
function reportReplacementSkip(root, details) {
	try {
		const { reason, recordedInstanceId = null, probedInstanceId } = details;
		const key = `${root}|${reason}|${recordedInstanceId ?? "null"}|${probedInstanceId}`;
		if (reportedReplacementSkips.has(key)) return;
		reportedReplacementSkips.add(key);
		if (!existsSync(root)) return;
		appendDiagnosticOnce(root, "_coordinator", {
			source: "coordinator-client",
			level: "warn",
			code: "coordinator_replacement_skipped",
			message: `coordinator replacement skipped: ${reason}`,
			details: { reason, recordedInstanceId: recordedInstanceId ?? null, probedInstanceId },
		}, { match: ["reason", "recordedInstanceId", "probedInstanceId"] });
	} catch {
		// Diagnostics are best-effort: a failed write must never break the caller.
	}
}

/** Grace window for a SIGTERMed stale coordinator to exit (issue #239 D4). */
const REPLACE_TIMEOUT_MS = 3_000;
/** Liveness poll interval while waiting for a SIGTERMed coordinator to exit. */
const REPLACE_POLL_MS = 50;

/** @typedef {{ replaced: true } | { replaced: false, reason: SkipReason }} ReplaceOutcome */
/** @typedef {"lease_unreadable"|"lease_owner_mismatch"|"pid_reused"|"identity_unverified"|"lease_changed"|"instance_unresponsive"|"replacement_raced"|"replace_timeout"} SkipReason */

/**
 * Await `ms` with an unref'd timer, so waiting for a coordinator to exit never
 * keeps a one-shot CLI process alive on its own.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function replaceSleep(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/**
 * Whether a lease record names a pid that may be signalled. Mirrors the
 * `lease_unreadable` boundary of `judgeReplacementTarget` for the records read
 * outside the decision itself.
 * @param {LeaseRecord|null} record
 * @returns {boolean}
 */
function hasUsableLeasePid(record) {
	return Boolean(record)
		&& typeof record.pid === "number"
		&& Number.isFinite(record.pid)
		&& record.pid > 0;
}

/**
 * Terminate a stale-protocol coordinator and wait for it to exit (issue #108),
 * with the signal gated on a proven lease identity (issue #239). SIGTERM
 * triggers the coordinator's graceful shutdown; its crash safety
 * (fsync-before-materialize journal + boot replay) makes the kill safe even
 * mid-command — an in-flight reply is the documented ambiguous outcome.
 *
 * Identity contract: the pong that proved the endpoint stale came from one
 * process, while `owner.json` names the lease owner. They are the same process
 * only when the recorded `identity.instanceId` matches `expectedInstanceId`
 * (D2) — a mismatch or an unverifiable legacy record never signals. Before
 * signalling, the endpoint is re-probed and the lease re-read (D3), so a
 * takeover or lease handover that happened between judging and signalling wins
 * over the kill. After the signal the caller waits, bounded by
 * `replaceTimeoutMs`, for the pid to exit (D4): a successor must not be spawned
 * while the old owner can still hold the lease.
 *
 * Every skip return reports through `reportSkip` (D5) and resolves a
 * `ReplaceOutcome`. The function never throws: the diagnostic writer and the
 * `kill` call are both wrapped (the latter routes ESRCH to "already replaced"
 * and other errors into wait-for-exit).
 * @param {string} root
 * @param {string} socketPath
 * @param {string} expectedInstanceId `instanceId` from the pong that was judged
 *   stale — the only identity whose process may be signalled
 * @param {{
 *   probe?: (socketPath: string, connect: (path: string) => import("node:net").Socket, timeoutMs: number) => Promise<{instanceId: string, protocolVersion: number}|null>,
 *   connect?: (path: string) => import("node:net").Socket,
 *   probeTimeoutMs?: number,
 *   readLease?: (root: string) => LeaseRecord|null,
 *   kill?: (pid: number, signal: string) => void,
 *   isAlive?: (pid: number) => boolean,
 *   readStartToken?: (pid: number) => Promise<string|null>,
 *   clock?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   replaceTimeoutMs?: number,
 *   reportSkip?: (details: { reason: SkipReason, recordedInstanceId: string|null, probedInstanceId: string }) => void,
 * }} [opts]
 * @returns {Promise<ReplaceOutcome>}
 */
export async function replaceStaleCoordinator(root, socketPath, expectedInstanceId, opts = {}) {
	const connect = opts.connect ?? createConnection;
	const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
	const probe = opts.probe ?? probeOnce;
	const readLease = opts.readLease ?? readCoordinatorLeaseRecord;
	const kill = opts.kill ?? process.kill;
	const isAliveFn = opts.isAlive ?? isAlive;
	const readStartToken = opts.readStartToken ?? readProcessStartToken;
	const clock = opts.clock ?? Date.now;
	const sleep = opts.sleep ?? replaceSleep;
	const replaceTimeoutMs = opts.replaceTimeoutMs ?? REPLACE_TIMEOUT_MS;
	const reportSkip = opts.reportSkip ?? ((details) => reportReplacementSkip(root, details));

	const recorded = readLease(root);
	const recordedInstanceId = firstNonEmptyString(recorded?.instanceId);
	/**
	 * Report a deliberate skip and resolve the matching outcome. Best-effort by
	 * contract: a throwing writer must never escape into `ensureCoordinator`,
	 * which does not wrap this call.
	 * @param {SkipReason} reason
	 * @param {string|null} [instanceId] lease-owner instance at decision time
	 * @returns {ReplaceOutcome}
	 */
	const skip = (reason, instanceId = recordedInstanceId) => {
		try {
			reportSkip({
				reason,
				recordedInstanceId: instanceId,
				probedInstanceId: expectedInstanceId,
			});
		} catch {
			// Diagnostics are best-effort: a failed write never changes the outcome.
		}
		return { replaced: false, reason };
	};

	// Legacy records (pre-#239) carry no instanceId; on Linux the live /proc
	// start token is then the only proof that the lease pid is still the process
	// the endpoint served (D6 / J3). The read is async by contract: an injected
	// implementation returning a Promise that is not awaited would compare as
	// unequal, so the judge normalizes a non-string token to
	// `identity_unverified` rather than `pid_reused`.
	const currentStartToken = recordedInstanceId === null && firstNonEmptyString(recorded?.startToken) !== null
		? await readStartToken(/** @type {LeaseRecord} */ (recorded).pid)
		: null;

	const verdict = judgeReplacementTarget({ recorded, probedInstanceId: expectedInstanceId, currentStartToken });
	if (verdict.action === "skip") return skip(verdict.reason);
	const target = /** @type {LeaseRecord} */ (recorded);
	const pid = /** @type {number} */ (target.pid);

	// D3 step 1: re-probe the endpoint. A pong proves the instance that was
	// judged stale is still serving, so its pid cannot have been reused yet.
	// A DIFFERENT instance means the replacement raced with another client: a
	// current-protocol instance already took over (nothing left to replace — the
	// caller may continue), an old-protocol one must not be killed by us.
	const reprobed = await probe(socketPath, connect, probeTimeoutMs);
	if (reprobed && reprobed.instanceId !== expectedInstanceId) {
		if (reprobed.protocolVersion >= COORDINATOR_PROTOCOL_VERSION) return { replaced: true };
		return skip("replacement_raced");
	}
	if (!reprobed) {
		// No valid pong within the timeout is NOT proof the process is gone.
		// Re-read the lease: no usable record means no evidence to signal, a
		// live owner is a slow instance we must not race, and a dead owner lets
		// the next launch take the lease through the normal reclaim path.
		const fresh = readLease(root);
		if (!hasUsableLeasePid(fresh)) return skip("lease_unreadable", null);
		const freshRecord = /** @type {LeaseRecord} */ (fresh);
		if (isAliveFn(/** @type {number} */ (freshRecord.pid))) {
			return skip("instance_unresponsive", firstNonEmptyString(freshRecord.instanceId));
		}
		return { replaced: true };
	}

	// D3 step 2: the lease must still describe the owner we judged. A changed
	// token or instanceId means another coordinator (or a recovery) owns the
	// lease now — signalling the old pid could hit an unrelated process.
	const confirmed = readLease(root);
	if (!confirmed || confirmed.token !== target.token || firstNonEmptyString(confirmed.instanceId) !== recordedInstanceId) {
		return skip("lease_changed");
	}

	// D4: the last fallible system call. ESRCH means the target exited between
	// the checks — already replaced. EPERM and anything else leave the target
	// possibly alive, so fail closed into wait-for-exit below.
	try {
		kill(pid, "SIGTERM");
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err)?.code === "ESRCH") return { replaced: true };
	}

	// D4: wait for the old process to actually exit before the caller spawns a
	// successor. The tick budget keeps the wait finite even when an injected
	// clock never advances; `clock` ends it early when wall time runs out first.
	const deadline = clock() + replaceTimeoutMs;
	const maxTicks = Math.max(1, Math.ceil(replaceTimeoutMs / REPLACE_POLL_MS));
	for (let tick = 0; tick < maxTicks; tick++) {
		if (!isAliveFn(pid)) return { replaced: true };
		if (clock() >= deadline) break;
		await sleep(REPLACE_POLL_MS);
	}
	return skip("replace_timeout");
}

/**
 * Make sure a coordinator is live for this board root: probe the endpoint and,
 * on failure, spawn one and poll until it answers (the lease guarantees a
 * single owner even under concurrent spawns — the loser exits silently).
 * Repeated/concurrent calls are safe and cheap once a coordinator is up.
 *
 * Protocol gate (issue #108): a live coordinator reporting a protocol version
 * older than this client's build is TERMINATED and respawned — otherwise a
 * detached old-build instance survives every extension update and rejects
 * every new command kind (`unknown_kind`), silently stranding state writes.
 * If the stale instance cannot be replaced (unkillable, socket stuck), report
 * `coordinator_stale_protocol` instead of pretending it is healthy.
 *
 * Replacement seams (issue #239): the identity-gated replacement accepts every
 * injectable dependency of `replaceStaleCoordinator` (`probe`, `kill`,
 * `isAlive`, `readStartToken`, `clock`, `sleep`, `replaceTimeoutMs`,
 * `reportSkip`) plus the re-probe plumbing (`connect`, `probeTimeoutMs`); this
 * function forwards them verbatim. Defaults live in `replaceStaleCoordinator`,
 * so an omitted option keeps the production behaviour.
 *
 * Root-lifetime note (issue #241): a root that does not exist yet is no longer
 * lazily created — the boot guard makes the spawned coordinator exit 0, so a
 * `ensureCoordinator` call on a missing root waits the full `ENSURE_WINDOW_MS`
 * (~10 s) and returns `coordinator_unavailable`. No in-repo caller does that;
 * external one-shot callers that relied on a lazily-created board are affected.
 *
 * @param {string} root
 * @param {{
 *   runnerScript?: string,
 *   node?: string,
 *   probeTimeoutMs?: number,
 *   ensureWindowMs?: number,
 *   pollMs?: number,
 *   connect?: (path: string) => import("node:net").Socket,
 *   probe?: (socketPath: string, connect: (path: string) => import("node:net").Socket, timeoutMs: number) => Promise<{instanceId: string, protocolVersion: number}|null>,
 *   kill?: (pid: number, signal: string) => void,
 *   isAlive?: (pid: number) => boolean,
 *   readStartToken?: (pid: number) => Promise<string|null>,
 *   clock?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   replaceTimeoutMs?: number,
 *   reportSkip?: (details: { reason: SkipReason, recordedInstanceId: string|null, probedInstanceId: string }) => void,
 * }} [opts]
 * @returns {Promise<EnsureResult>}
 */
export async function ensureCoordinator(root, opts = {}) {
	if (coordinatorDisabled()) return { ok: false, error: "coordinator_disabled" };
	const connect = opts.connect ?? createConnection;
	const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
	const windowMs = opts.ensureWindowMs ?? ENSURE_WINDOW_MS;
	const pollMs = opts.pollMs ?? ENSURE_POLL_MS;
	const socketPath = P.coordinatorEndpointPathFor(process.platform, root);

	const first = await probeOnce(socketPath, connect, probeTimeoutMs);
	if (first) {
		if (first.protocolVersion >= COORDINATOR_PROTOCOL_VERSION) return { ok: true, instanceId: first.instanceId };
		// Issue #239: only the instance that answered our ping may be replaced —
		// its instanceId is the identity the lease must prove. A skip is already
		// reported with its reason by the replacement orchestration itself.
		const outcome = await replaceStaleCoordinator(root, socketPath, first.instanceId, {
			connect,
			probeTimeoutMs,
			probe: opts.probe,
			kill: opts.kill,
			isAlive: opts.isAlive,
			readStartToken: opts.readStartToken,
			clock: opts.clock,
			sleep: opts.sleep,
			replaceTimeoutMs: opts.replaceTimeoutMs,
			reportSkip: opts.reportSkip,
		});
		if (!outcome.replaced) return { ok: false, error: "coordinator_stale_protocol" };
	}

	const launched = launchCoordinator(root, { runnerScript: opts.runnerScript ?? COORDINATOR_SCRIPT, node: opts.node });
	const deadline = Date.now() + windowMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, pollMs));
		const probe = await probeOnce(socketPath, connect, probeTimeoutMs);
		if (probe && probe.protocolVersion >= COORDINATOR_PROTOCOL_VERSION) {
			return { ok: true, instanceId: probe.instanceId, pid: launched.pid };
		}
	}
	return { ok: false, error: "coordinator_unavailable", pid: launched.pid };
}

/**
 * Submit one state command to the coordinator and wait for its result.
 * Never throws; every failure path resolves a rejected result (see the
 * ambiguity contract in the module doc).
 * @param {string} root
 * @param {object} command Command fields (`kind`, `viewId`, `runId`, `source`,
 *   `expectedRevision`, `payload`); an explicit `commandId` pins the identity
 *   for safe same-id retries, otherwise one is generated via `newRunId()`.
 * @param {{ timeoutMs?: number, runnerScript?: string, node?: string, socketPath?: string, connect?: (path: string) => import("node:net").Socket, ensure?: typeof ensureCoordinator }} [opts]
 * @returns {Promise<StateCommandResult>}
 */
export async function sendStateCommand(root, command, opts = {}) {
	if (coordinatorDisabled()) {
		return { status: "rejected", reason: "coordinator_disabled", materializedRevision: 0 };
	}
	const ensure = opts.ensure ?? ensureCoordinator;
	const ensured = await ensure(root, {
		runnerScript: opts.runnerScript,
		node: opts.node,
		connect: opts.connect,
	});
	if (!ensured.ok) {
		return { status: "rejected", reason: ensured.error ?? "coordinator_unavailable", materializedRevision: 0 };
	}

	const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
	const connect = opts.connect ?? createConnection;
	const socketPath = opts.socketPath ?? P.coordinatorEndpointPathFor(process.platform, root);
	const commandId = typeof command.commandId === "string" && command.commandId
		? command.commandId
		: newRunId();
	const envelope = { ...command, type: "state_command", commandId };

	return await new Promise((resolve) => {
		let settled = false;
		let wrote = false;
		let buffer = "";
		/** @type {import("node:net").Socket|null} */
		let socket = null;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { socket?.destroy(); } catch { /* best effort */ }
			resolve(result);
		};
		const timer = setTimeout(() => finish({ status: "rejected", reason: "timeout", materializedRevision: 0 }), timeoutMs);
		timer.unref?.();
		try {
			socket = connect(socketPath);
		} catch {
			// synchronous connect failure — nothing was sent, so not ambiguous
			finish({ status: "rejected", reason: "connection_failed", materializedRevision: 0 });
			return;
		}
		socket.on("error", () => {
			// A reset AFTER the envelope was written is ambiguous (the command may
			// be journaled); a failure before that is a plain delivery failure.
			finish(wrote
				? { status: "rejected", reason: "connection_reset", materializedRevision: 0 }
				: { status: "rejected", reason: "connection_failed", materializedRevision: 0 });
		});
		socket.on("close", () => {
			finish(wrote
				? { status: "rejected", reason: "connection_reset", materializedRevision: 0 }
				: { status: "rejected", reason: "connection_failed", materializedRevision: 0 });
		});
		socket.on("connect", () => {
			try {
				socket?.write(JSON.stringify(envelope) + "\n");
				wrote = true;
			} catch {
				finish({ status: "rejected", reason: "connection_failed", materializedRevision: 0 });
			}
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue; // malformed line — keep waiting for the result
				}
				if (msg?.type === "state_command_result" && msg.commandId === commandId) {
					finish({
						status: msg.status === "applied" ? "applied" : "rejected",
						reason: typeof msg.reason === "string" ? msg.reason : null,
						materializedRevision: typeof msg.materializedRevision === "number" ? msg.materializedRevision : 0,
					});
					return;
				}
				if (msg?.type === "error") {
					// Protocol misuse on our side — a definitive, non-journaled rejection.
					finish({ status: "rejected", reason: `coordinator_error:${msg.message ?? "unknown"}`, materializedRevision: 0 });
					return;
				}
				// pong/other lines are ignored — keep waiting for the matching result.
			}
		});
	});
}
