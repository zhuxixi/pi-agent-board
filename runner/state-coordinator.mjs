#!/usr/bin/env node
/**
 * Detached View State Coordinator (issue #91, spec D3) — the single logical
 * writer of state.json/status.json for one board root.
 *
 * Usage: node state-coordinator.mjs <root>
 *
 * Design contract:
 * - Exactly one instance per root: a token-fenced lease (acquireOwnedViewLock on
 *   the pseudo-view "_coordinator") is grabbed before anything else; a second
 *   instance exits 0 immediately ("busy" is an expected, idempotent outcome).
 * - Every semantic mutation arrives as a `state_command` over the JSONL control
 *   socket and is decided by the pure layer (state-commands.mjs). This process
 *   owns ALL side effects: durable journal append (fsync BEFORE materialize, so
 *   boot replay can repair the crash window), materialization under a per-view
 *   file lock, checkpoint + journal GC, and socket lifecycle.
 * - Transient kinds (TRANSIENT_KINDS, run_progress) bypass the durable
 *   machinery: validate → decide → materialize → reply, with no journal
 *   append, no dedupe, and no checkpoint trigger — a periodic snapshot whose
 *   next beat supersedes it. They still bump materializedRevision.
 * - Idempotency: a processed commandId returns its original result forever —
 *   from the in-memory ring first (bounded, covers the post-GC window), then
 *   from the journal (findProcessedCommand). Duplicates never re-append.
 * - Revisions: one global monotonic materializedRevision counter, initialized at
 *   boot to max(checkpoint, max journal revision, max revision across views'
 *   state.json), incremented once per applied command, and stamped identically
 *   on state.json and the command's run status.json (spec 根治条件 5 scope).
 * - Boot replay re-materializes every applied journal record from its stored
 *   patches; per-file guards stamp only files strictly behind the recorded
 *   revision, so a half-materialized pair (state.json written, status.json not)
 *   repairs just the lagging half without moving the other one backwards. The
 *   decision-time status binding (statusRunId) is recorded in the journal, so
 *   replay is deterministic — no re-decision, no re-binding.
 * - Legacy adoption: a view without materializedRevision is stamped as part of
 *   its first applied command's single materialization write (no extra write).
 * - AGENT_BOARD_COORDINATOR=off makes the process exit 0 immediately (tests and
 *   the client's degradation path).
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { readJson } from "../src/core/atomic.mjs";
import {
	appendCommand,
	findProcessedCommand,
	gcJournal,
	readCheckpoint,
	readJournal,
	repairJournalTail,
	writeCheckpoint,
} from "../src/core/coordinator-journal.mjs";
import { ownsEndpoint } from "../src/core/host-coordination.mjs";
import { acquireOwnedViewLock, withViewLockSync } from "../src/core/locks.mjs";
import * as P from "../src/core/paths.mjs";
import { readState, readStatus, writeState, writeStatus } from "../src/core/store.mjs";
import { TRANSIENT_KINDS, decideStateTransition, validateCommand } from "../src/core/state-commands.mjs";

/** In-memory processed-command ring size (FIFO). Beyond the journal, this covers
 *  idempotency when the journal prefix has already been GC'd away. */
const PROCESSED_RING_MAX = 1000;
/** Journal growth (bytes) that triggers checkpoint + GC. Keeps boot replay bounded. */
const CHECKPOINT_THRESHOLD_BYTES = 262_144;
/** Lease heartbeat — matches pty-runner's host-start lease cadence. */
const HEARTBEAT_MS = 1000;
/** Lifecycle kinds whose legacy write sites stamped state.lastActivityAt on
 *  every persist (service markQueued/archive/adopt, job-runner plan-ready,
 *  reconcile terminal sites). The decision layer stays clock-free, so the
 *  shell adds the wall-clock stamp — into the patch BEFORE the journal
 *  append, so boot replay re-applies the exact same fields deterministically
 *  (there is no clock at replay time either). (Task 1 review F5.) */
const LAST_ACTIVITY_STAMP_KINDS = new Set(["mark_queued", "archive_view", "adopt_session", "reconcile_finalize", "plan_ready", "mark_completed", "host_run_failed"]);
/** Kinds whose status patch may CREATE the run's status file: they carry the
 *  full status content for a run that has no materialized status yet. Every
 *  other kind keeps PR #1's "patch presence ≠ file requirement" semantics
 *  (e.g. mark_completed's `status: {autoState: null}` on a legacy row without
 *  a status file must not fabricate one). */
const STATUS_BOOTSTRAP_KINDS = new Set(["run_started", "followup_started"]);

const root = process.argv[2];
if (!root) {
	process.stderr.write("state-coordinator: missing root argument\n");
	process.exit(2);
}
if (process.env.AGENT_BOARD_COORDINATOR === "off") process.exit(0);

main().catch((err) => {
	process.stderr.write(`state-coordinator: fatal ${err?.stack || err}\n`);
	process.exit(1);
});

async function main() {
	const instanceId = randomBytes(8).toString("hex");
	const startedAt = Date.now();

	// 1. Lease first: a second coordinator is an expected, idempotent no-op.
	// Identity carries a POSIX startToken (pty-runner pattern) so a SIGKILLed
	// coordinator's lease can be reclaimed by the next instance after pid reuse.
	/** @type {import("../src/core/locks.mjs").Lease} */
	let lease;
	try {
		lease = acquireOwnedViewLock(root, "_coordinator", "state-coordinator", {
			waitMs: 500,
			identity: { pid: process.pid, startToken: captureStartToken(process.pid) },
		});
	} catch (err) {
		process.stderr.write(`state-coordinator: lease unavailable (${err?.code ?? err?.message ?? "unknown"}); another instance may own it; exiting\n`);
		process.exit(0);
	}
	const startTouchTimer = setInterval(() => {
		try { lease?.touch(); } catch { /* best effort */ }
	}, HEARTBEAT_MS);
	startTouchTimer.unref?.();

	// 2. Boot state: journal summary, processed-command ring, replay, counter init.
	// Repair a crash-torn tail FIRST: without it the first post-restart append
	// concatenates onto the torn line and that fsynced record becomes invisible
	// to every readJournal / replay / revision scan below.
	repairJournalTail(root);
	const checkpoint = readCheckpoint(root) ?? { materializedRevision: 0, journalBytes: 0 };
	const journal = readJournal(root);
	/** @type {Map<string, { result: { status: string, reason: string|null }, materializedRevision: number }>} */
	const processedCommands = new Map();
	for (const record of journal) {
		const commandId = record?.command?.commandId;
		if (commandId && !processedCommands.has(commandId)) {
			processedCommands.set(commandId, {
				result: record.result ?? { status: "rejected", reason: "unknown" },
				materializedRevision: record.materializedRevision ?? 0,
			});
		}
	}

	// Replay in journal order: re-materialize every applied record from its stored
	// patches; materialize's per-file guards write only files strictly behind the
	// recorded revision, so this repairs just the half that missed its write in a
	// crash window and never moves the other half backwards.
	for (const record of journal) {
		if (record?.result?.status !== "applied") continue;
		const viewId = record?.command?.viewId;
		if (!viewId) continue;
		materialize(viewId, record.command ?? {}, record.mutate ?? {}, record.materializedRevision ?? 0, record.statusRunId ?? null);
	}

	// Global revision counter: never reissue a revision that exists anywhere.
	let revisionCounter = Math.max(checkpoint.materializedRevision ?? 0, 0);
	for (const record of journal) revisionCounter = Math.max(revisionCounter, record.materializedRevision ?? 0);
	if (existsSync(P.viewsDir(root))) {
		for (const entry of readdirSync(P.viewsDir(root))) {
			const state = readJson(P.statePath(root, entry), null);
			revisionCounter = Math.max(revisionCounter, state?.materializedRevision ?? 0);
		}
	}
	let lastCheckpointBytes = 0;

	// 3. Control socket (JSONL, pty-runner's line-buffered server shape).
	const socketPath = P.coordinatorEndpointPathFor(process.platform, root);
	if (process.platform !== "win32" && existsSync(socketPath)) {
		// Lease is ours: any leftover socket file belongs to a dead coordinator.
		try { unlinkSync(socketPath); } catch { /* best effort */ }
	}
	/** {dev,ino} recorded at bind time; cleanup unlinks only this exact inode. */
	let boundSocketIdentity = null;

	const server = createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleClientLine(line, socket);
		});
		socket.on("error", () => {}); // client vanished mid-request; nothing to answer
	});

	server.on("error", (err) => {
		process.stderr.write(`state-coordinator: server error ${err instanceof Error ? err.message : String(err)}\n`);
		shutdown(1);
	});

	server.listen(socketPath, () => {
		if (process.platform !== "win32") {
			try {
				const st = statSync(socketPath);
				boundSocketIdentity = { dev: st.dev, ino: st.ino };
			} catch { /* without the identity, cleanup degrades to no-op */ }
		}
	});

	let shuttingDown = false;
	process.on("SIGTERM", () => shutdown(0));
	process.on("SIGINT", () => shutdown(0));

	function shutdown(code) {
		if (shuttingDown) return;
		shuttingDown = true;
		try { clearInterval(startTouchTimer); } catch { /* best effort */ }
		try { server.close(); } catch { /* already closed */ }
		if (process.platform !== "win32" && boundSocketIdentity) {
			try {
				const st = statSync(socketPath);
				if (ownsEndpoint(boundSocketIdentity, { dev: st.dev, ino: st.ino })) {
					try { unlinkSync(socketPath); } catch { /* best effort */ }
				}
			} catch { /* path gone — nothing to clean */ }
		}
		try { lease.release(); } catch { /* best effort */ }
		process.exit(code);
	}

	function send(socket, msg) {
		socket.write(JSON.stringify(msg) + "\n");
	}

	function handleClientLine(line, socket) {
		if (!line.trim()) return;
		let msg;
		try { msg = JSON.parse(line); } catch { return send(socket, { type: "error", message: "invalid json" }); }
		switch (msg?.type) {
			case "ping":
				send(socket, { type: "pong", instanceId, startedAt });
				break;
			case "state_command":
				send(socket, { type: "state_command_result", ...processStateCommand(msg) });
				break;
			default:
				send(socket, { type: "error", message: "unknown type" });
		}
	}

	/**
	 * The command loop: validate → dedupe → decide → journal (fsync) → materialize
	 * → remember → reply. Rejections are journaled too, so their exact reason is
	 * replayable; duplicates short-circuit before any append.
	 * @param {object} msg
	 * @returns {{ commandId: string|null, status: string, reason: string|null, materializedRevision: number }}
	 */
	function processStateCommand(msg) {
		const checked = validateCommand(msg);
		if (!checked.ok) {
			return {
				commandId: typeof msg?.commandId === "string" ? msg.commandId : null,
				status: "rejected",
				reason: checked.error,
				materializedRevision: 0,
			};
		}
		const command = checked.command;
		const transient = TRANSIENT_KINDS.includes(command.kind);

		if (!transient) {
			const known = lookupProcessed(command.commandId);
			if (known) {
				return { commandId: command.commandId, status: known.result.status, reason: known.result.reason, materializedRevision: known.materializedRevision };
			}
		}

		const state = readState(root, command.viewId);
		// Status consistency only binds the view's current run (spec 根治条件 5):
		// no currentRunId → status.json plays no role in this command.
		// Exception (Task 1 review F1): followup_started re-points the row at a
		// NEW run carried in payload.newRunId (command.runId is deliberately null
		// so the stale-run guard cannot fire against the finished parent run).
		// Resolving the status from the parent here would overwrite the parent's
		// status.json with the new run's bootstrap patch; resolving from newRunId
		// finds no file and cleanly bootstraps the new run's status instead.
		const statusRunId = command.kind === "followup_started"
			? (typeof command.payload?.newRunId === "string" ? command.payload.newRunId : null)
			: (command.runId ?? state?.currentRunId ?? null);
		const status = statusRunId ? readStatus(root, command.viewId, statusRunId) : null;
		const now = Date.now();
		const decision = stampLegacyTimestamps(command, decideStateTransition(command, state, status, now), now);
		const currentRevision = state?.materializedRevision ?? 0;

		if (decision.action === "reject") {
			if (transient) {
				// Transient rejections are not replayable either — nothing was
				// mutated, and journaling them would grow the journal for noise.
				return { commandId: command.commandId ?? null, status: "rejected", reason: decision.reason, materializedRevision: currentRevision };
			}
			const result = { status: "rejected", reason: decision.reason };
			const record = { command, result, materializedRevision: currentRevision, at: now };
			const journalBytes = appendCommand(root, record);
			rememberProcessed(command.commandId, result, currentRevision);
			maybeCheckpoint(journalBytes);
			return { commandId: command.commandId, status: "rejected", reason: decision.reason, materializedRevision: currentRevision };
		}

		const newRevision = revisionCounter + 1;
		const result = { status: "applied", reason: decision.reason };
		if (transient) {
			// No journal, no processed ring, no checkpoint: a periodic snapshot —
			// the next beat supersedes it.
			materialize(command.viewId, command, decision.mutate, newRevision, statusRunId);
			revisionCounter = newRevision;
			return { commandId: command.commandId ?? null, status: "applied", reason: decision.reason, materializedRevision: newRevision };
		}
		// Journal first (fsync inside), materialize second: boot replay repairs
		// the window between the two using the stored patches.
		const record = { command, result, materializedRevision: newRevision, at: now, mutate: decision.mutate, statusRunId };
		const journalBytes = appendCommand(root, record);
		materialize(command.viewId, command, decision.mutate, newRevision, statusRunId);
		revisionCounter = newRevision;
		rememberProcessed(command.commandId, result, newRevision);
		maybeCheckpoint(journalBytes);
		return { commandId: command.commandId, status: "applied", reason: decision.reason, materializedRevision: newRevision };
	}

	/**
	 * Merge patches onto state.json (and the run's status.json when it exists)
	 * under the view's materialize lock, stamping the shared revision. Per-file
	 * guards stamp only files strictly behind the record revision: the live path
	 * always qualifies (the global counter is monotonic), while replay repairs
	 * just the half that missed its write in a crash window and never moves the
	 * other half backwards. A status patch without a status file is skipped —
	 * patch presence ≠ file requirement (mark_completed always emits
	 * `status: {autoState: null}`). The status run binding is the decision-time
	 * one (`statusRunId`, recorded in the journal) so replay cannot re-bind a
	 * runId-less patch to whatever run is current on disk at replay time;
	 * `state.currentRunId` remains only as a legacy fallback for records written
	 * before statusRunId existed.
	 */
	function materialize(viewId, command, mutate, revision, statusRunId) {
		withViewLockSync(root, viewId, "state-materialize", () => {
			const state = readState(root, viewId);
			if (mutate?.state && state && (state.materializedRevision ?? 0) < revision) {
				writeState(root, { ...state, ...mutate.state, materializedRevision: revision });
			}
			const runId = command?.runId ?? statusRunId ?? state?.currentRunId ?? null;
			if (mutate?.status && runId) {
				const status = readStatus(root, viewId, runId);
				if (!status && STATUS_BOOTSTRAP_KINDS.has(command?.kind)) {
					// run_started / followup_started carry the full status content for a
					// run that has no status file yet — create it (F1's clean-bootstrap
					// half). Identity fields come from the command context; the patch
					// carries everything meaningful.
					writeStatus(root, { version: 1, runId, viewId, ...mutate.status, materializedRevision: revision });
				} else if (status && (status.materializedRevision ?? 0) < revision) {
					writeStatus(root, { ...status, ...mutate.status, materializedRevision: revision });
				}
			}
		});
	}

	/** Add the legacy wall-clock stamp to a decided patch (F5): see
	 *  LAST_ACTIVITY_STAMP_KINDS. Applied before the journal append so the
	 *  stored patches are exactly what replay re-materializes. */
	function stampLegacyTimestamps(command, decision, now) {
		if (decision.action !== "apply" || !LAST_ACTIVITY_STAMP_KINDS.has(command.kind)) return decision;
		return { ...decision, mutate: { ...decision.mutate, state: { ...(decision.mutate.state ?? {}), lastActivityAt: now } } };
	}

	/** Memory ring first (covers the post-GC window), journal second. */
	function lookupProcessed(commandId) {
		const inMemory = processedCommands.get(commandId);
		if (inMemory) return inMemory;
		const result = findProcessedCommand(root, commandId);
		if (!result) return null;
		const entry = { result, materializedRevision: revisionOf(commandId) };
		rememberProcessed(commandId, result, entry.materializedRevision);
		return entry;
	}

	/** Revision recorded for a known commandId (journal scan; 0 if unrecorded). */
	function revisionOf(commandId) {
		for (const record of readJournal(root)) {
			if (record?.command?.commandId === commandId) return record.materializedRevision ?? 0;
		}
		return 0;
	}

	function rememberProcessed(commandId, result, materializedRevision) {
		processedCommands.set(commandId, { result, materializedRevision });
		while (processedCommands.size > PROCESSED_RING_MAX) {
			processedCommands.delete(processedCommands.keys().next().value);
		}
	}

	/** Checkpoint + GC once the journal outgrows the threshold. GC only runs when
	 *  the checkpoint write provably succeeded (journal module enforces this). */
	function maybeCheckpoint(journalBytes) {
		if (journalBytes - lastCheckpointBytes < CHECKPOINT_THRESHOLD_BYTES) return;
		if (!writeCheckpoint(root, { materializedRevision: revisionCounter, journalBytes })) return;
		lastCheckpointBytes = gcJournal(root);
	}
}

/** POSIX process start token — /proc/<pid>/stat field 22 (starttime), stable
 *  across exec(2). Same recipe as pty-runner: lets locks.mjs reclaim this
 *  coordinator's lease after a SIGKILL even if the pid was reused. null on
 *  failure or non-Linux platforms (reclaim degrades to "blocked" there — same
 *  platform parity as PTY hosts). */
function captureStartToken(pid) {
	if (process.platform !== "linux" || !pid) return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trimStart();
		const fields = afterComm.split(/\s+/);
		return fields[19] ?? null;
	} catch {
		return null;
	}
}
