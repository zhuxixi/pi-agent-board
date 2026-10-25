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

/** Grace window for a SIGTERMed stale coordinator to unlink its socket. */
const REPLACE_TIMEOUT_MS = 3_000;
const REPLACE_POLL_MS = 50;

/**
 * Terminate a stale-protocol coordinator (issue #108) and wait for its socket
 * to disappear so a fresh instance can bind. SIGTERM triggers the
 * coordinator's graceful shutdown (socket unlink + lease release); its crash
 * safety (fsync-before-materialize journal + boot replay) makes the kill safe
 * even mid-command — an in-flight reply is the documented ambiguous outcome.
 * @param {string} root
 * @param {string} socketPath
 * @returns {Promise<boolean>} whether the socket is gone (replacement can proceed)
 */
async function replaceStaleCoordinator(root, socketPath) {
	const pid = readCoordinatorLeaseRecord(root)?.pid ?? null;
	if (pid != null) {
		try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
	}
	const deadline = Date.now() + REPLACE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!existsSync(socketPath)) return true;
		await new Promise((r) => setTimeout(r, REPLACE_POLL_MS));
	}
	return false;
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
 * Root-lifetime note (issue #241): a root that does not exist yet is no longer
 * lazily created — the boot guard makes the spawned coordinator exit 0, so a
 * `ensureCoordinator` call on a missing root waits the full `ENSURE_WINDOW_MS`
 * (~10 s) and returns `coordinator_unavailable`. No in-repo caller does that;
 * external one-shot callers that relied on a lazily-created board are affected.
 *
 * @param {string} root
 * @param {{ runnerScript?: string, node?: string, probeTimeoutMs?: number, ensureWindowMs?: number, pollMs?: number, connect?: (path: string) => import("node:net").Socket }} [opts]
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
		if (!await replaceStaleCoordinator(root, socketPath)) {
			return { ok: false, error: "coordinator_stale_protocol" };
		}
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
