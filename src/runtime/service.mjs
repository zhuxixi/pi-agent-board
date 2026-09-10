/**
 * AgentViewService — the imperative actions behind the dashboard: dispatch a new
 * background session, reply/resume, stop, pin/rename/archive, and the same-repo write
 * safety rule. Pure node + core modules; the Pi-coupled bits (attach, dialogs) live in
 * the command handler. The pi invocation + runner path are injected (resolved in index.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { applyAutoStateToStatus, autoStateEnabled, heuristicAutoState, isManualCompletion } from "../core/auto-state.mjs";
import { appendLine, atomicWriteJson, removeFile } from "../core/atomic.mjs";
import { finalizeRun, projectViewState, reduceEvent } from "../core/events.mjs";
import { clearDiagnostics, appendDiagnostic, tailDiagnostics } from "../core/diagnostics.mjs";
import { emptyEvidenceSnapshot, finalizeEvidence, readEvidence, reduceEvidence, summarizeEvidence, writeEvidence } from "../core/evidence.mjs";
import { updateCodeRefsFromEvidence } from "../core/code-refs-store.mjs";
import { claimNextFollowUp, completeFollowUp, enqueueFollowUp, readFollowUpQueue, releaseFollowUp, summarizeFollowUpQueue, clearQueuedFollowUps, removeLastFollowUp } from "../core/follow-up-queue.mjs";
import { approvePlan as approvePlanState, markExecutingApprovedPlan, readSteering, recordPlanReady, requestPlan as requestPlanState, requestPlanChanges as requestPlanChangesState, summarizeSteering } from "../core/steering.mjs";
import { buildApprovePlanPrompt, buildPlanChangesPrompt, buildPlanRequestPrompt } from "../core/steering-prompts.mjs";
import { isGenericStatusText } from "../core/derive.mjs";
import { firstSentence, truncate } from "../core/heuristics.mjs";
import { newRunId, newViewId, slugifyTask } from "../core/ids.mjs";
import { launchAutoState as launchAutoStateProcess, launchHost as launchHostProcess, launchRun, launchTitle as launchTitleProcess } from "../core/launch.mjs";
import { gitRepoRoot } from "../core/repo.mjs";
import { isAlive, killProcess } from "../core/pid.mjs";
import { acquireOwnedViewLock, tryAcquireOwnedViewLock } from "../core/locks.mjs";
import { canFinalizeLegacyHost, canReplaceHost } from "../core/host-coordination.mjs";
import { modelRefAvailable } from "../core/launch-options.mjs";
import { ensureCoordinator, sendStateCommand, coordinatorDisabled } from "../core/coordinator-client.mjs";
import { statusRevisionDesynced } from "../core/status-consistency.mjs";
import { HOST_PROBE_RETRY_MS, probeHost } from "../core/host-probe.mjs";
import * as P from "../core/paths.mjs";
import {
	claimHost,
	createView,
	listRows,
	loadRow,
	readHost,
	readHostPid,
	readLaunchPrefs,
	readPid,
	readState,
	readStatus,
	updateOwnedHost,
	writeHost,
	writeLaunchPrefs,
	writeMeta,
	writeState,
	writeStatus,
} from "../core/store.mjs";
import { diagnoseNodePtyFailure, ensureNodePtySpawnHelperExecutable, nodePtyFallbackMessage, probeNodePtyEnvironment } from "../core/pty-support.mjs";
import { normalizeScreenLogMaxBytes, pruneScreenLogs } from "../core/screen-log-gc.mjs";
import { hasPendingQuestions, isAgentBusy, selectIdleHostsToEvict } from "../core/warm-host-sweeper.mjs";

/** @typedef {import("../core/types.mjs").RunKind} RunKind */

/** A fresh `starting` claim is a normal cold start for this long — never an orphan (issue #70). */
export const HOST_START_GRACE_MS = 10_000;
/** Bounded wait for the per-view host-start lease on explicit user actions (dispatch/reply). */
export const HOST_START_LOCK_WAIT_MS = 500;
/** Bounded wait for a revoked host's runner/child to end before recovery escalates (issue #70). */
export const HOST_RECOVERY_GRACE_MS = 5_000;
/** Poll cadence while waiting out a host recovery window. */
const HOST_RECOVERY_POLL_MS = 150;
/** Default wall-clock budget for one attach resolution (issue #70 Task 12). */
const ATTACH_RESOLVE_TIMEOUT_MS = 120_000;

/**
 * @param {{
 *   root: string,
 *   runnerScript: string,
 *   ptyRunnerScript?: string,
 *   piCommand: string,
 *   piArgsPrefix: string[],
 *   defaultCwd: string,
 *   titleRunnerScript?: string,
 *   autoStateRunnerScript?: string,
 *   launch?: typeof launchRun,
 *   launchHost?: typeof launchHostProcess,
 *   launchTitle?: typeof launchTitleProcess,
 *   launchAutoState?: typeof launchAutoStateProcess,
 *   ptySupport?: (opts?: { refresh?: boolean, maxAgeMs?: number }) => { ok: boolean, reason?: string|null, issue?: any },
 *   pruneScreenLogs?: typeof pruneScreenLogs,
 *   randomId?: () => string,
 *   now?: () => number,
 *   acquireLock?: typeof acquireOwnedViewLock,
 *   tryAcquireLock?: typeof tryAcquireOwnedViewLock,
 *   observeProcess?: (identity: {pid: number, startToken: string|null}|null) => "not_started"|"dead"|"owned"|"foreign"|"unknown",
 *   signalOwnedProcess?: (identity: {pid: number, startToken: string|null}, signal: string) => void,
 *   probeHostFn?: typeof probeHost,
 *   sleepFn?: (ms: number) => Promise<void>,
 *   sendStateCommand?: typeof sendStateCommand,
 *   availableModels?: () => Array<{ provider: string, id: string }> | undefined,
 * }} opts
 */
export function createService(opts) {
	const root = opts.root;
	const launch = opts.launch ?? launchRun;
	const launchHostImpl = opts.launchHost ?? launchHostProcess;
	const launchTitleImpl = opts.launchTitle ?? launchTitleProcess;
	const launchAutoStateImpl = opts.launchAutoState ?? launchAutoStateProcess;
	const ptySupport = opts.ptySupport ?? ptyHostAvailability;
	const ptyRunnerScript = opts.ptyRunnerScript ?? opts.runnerScript;
	const titleRunnerScript = opts.titleRunnerScript ?? null;
	const randomIdImpl = opts.randomId ?? (() => randomBytes(16).toString("hex"));
	const nowImpl = opts.now ?? Date.now;
	const acquireLockImpl = opts.acquireLock ?? acquireOwnedViewLock;
	const tryAcquireLockImpl = opts.tryAcquireLock ?? tryAcquireOwnedViewLock;
	const sendStateCommandImpl = opts.sendStateCommand ?? sendStateCommand;
	// Identity-aware observation/signalling for host recovery (issue #70). Callers must
	// only signal after observeProcess returned "owned" for that exact identity.
	const observeProcessImpl = opts.observeProcess ?? defaultObserveProcess;
	const signalOwnedProcessImpl = opts.signalOwnedProcess ?? defaultSignalOwnedProcess;
	// Attach-resolver dependencies (issue #70 Task 12): a real socket probe and an
	// awaitable sleep. The resolver runs on the UI thread, so its waits MUST go
	// through sleepFn (never a blocking acquire / Atomics.wait).
	const probeHostImpl = opts.probeHostFn ?? probeHost;
	const sleepFnImpl = opts.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	// Live model list for the stale-defaultModel launch guard (issue #90). Called
	// at validation time (never cached at startup) and wrapped defensively by the
	// caller; undefined/absent skips validation entirely.
	const availableModelsImpl = opts.availableModels ?? null;
	// In-flight attach resolutions, keyed by viewId: concurrent resolver calls for
	// the same view share one promise (issue #70 Task 12).
	const inflightAttachResolvers = new Map();

	const pruneScreenLogsImpl = opts.pruneScreenLogs ?? pruneScreenLogs;
	// Reclaim replay logs of long-ended views on dashboard startup. Deferred via
	// setImmediate so the first frame is unaffected; any failure must not break
	// the dashboard.
	setImmediate(() => {
		try {
			const stats = pruneScreenLogsImpl(root, { retentionDays: readLaunchPrefs(root).screenLogRetentionDays });
			// One JSONL record per pass that actually reclaimed something. `removed` is a
			// one-time event per file, so records stay proportional to real usage.
			// Persistent conditions (a permanent foreign dir, a recurring unlink failure)
			// ride along as record fields but never trigger a record on their own —
			// otherwise this file would itself grow without bound from routine opens.
			if (stats && stats.removed > 0) {
				appendLine(P.gcHistoryPath(root), JSON.stringify({ at: Date.now(), ...stats }));
			}
		} catch {}
	}).unref?.();

	/**
	 * Launch a run (dispatch or reply) against an existing view, updating its state to queued.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {string} prompt
	 * @param {RunKind} kind
	 * @returns {{ runId: string, pid: number|null }}
	 */
	async function launchForView(meta, prompt, kind) {
		const runId = newRunId();
		/** @type {import("../core/types.mjs").RunConfig} */
		const config = {
			root,
			viewId: meta.id,
			runId,
			kind,
			sessionFile: meta.sessionFile,
			cwd: meta.cwd,
			prompt,
			piCommand: opts.piCommand,
			piArgsPrefix: opts.piArgsPrefix,
			model: meta.defaultModel ?? null,
			thinkingLevel: meta.defaultThinking ?? null,
			tools: null,
		};
		// Final-review F2 residual (fix round 2): mark_queued must LAND before the
		// runner can boot. A detached runner that boots faster than this round-trip
		// used to send run_started while the row was still manual-completed → the
		// command hit the manual fence → row stuck queued/alive with no status file
		// → beats and run_finalized reject stale_run forever → permanent zombie.
		// Spawn regardless of the result: with the coordinator unreachable the
		// runner's own commands fail the same way either way — launch availability
		// beats strict ordering.
		await markQueued(meta.id, runId);
		const { pid } = launch(root, config, { runnerScript: opts.runnerScript });
		appendDiagnostic(root, meta.id, { source: "service", runId, code: "launch_run", message: "Detached runner launched", details: { kind, pid } });
		return { runId, pid };
	}

	/**
	 * Launch a durable interactive PTY host for a view — two-phase claim protocol
	 * (issue #70). Everything (claim → spawn → runnerPid merge) happens while the
	 * caller holds the per-view `host-start` lease, so concurrent service processes
	 * can never stack a second host on top of a live claim.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {string|null} initialPrompt
	 * @returns {Promise<{ ok: true, status: "started"|"pending"|"reused", pid: number|null, socketPath: string|null, instanceId: string|null } | { ok: false, error: string, fallbackReason?: string }>}
	 */
	async function launchHost(meta, initialPrompt, launchOpts = {}) {
		let lease;
		try {
			lease = acquireLockImpl(root, meta.id, "host-start", { waitMs: HOST_START_LOCK_WAIT_MS, identity: serviceIdentity() });
		} catch {
			// LOCK_TIMEOUT means lease contention (another live process holds it);
			// an IO-class failure means the lock path itself is unusable. Both map
			// to "cannot launch now": surface the existing claim as pending, never stack.
			const existing = readHost(root, meta.id);
			return pendingLaunchResult(existing);
		}
		try {
			// Same ordering contract as launchForView (final-review F2 residual):
			// the row must leave completed/fenced before the host can start work.
			// `return await` (not `return`) keeps the host-start lease held until
			// the two-phase claim transaction settles.
			if (launchOpts.markQueued !== false) await markQueued(meta.id, null);
			return await startHostUnderLease(meta, initialPrompt, launchOpts);
		} finally {
			try { lease.release(); } catch { /* best effort */ }
		}
	}

	/** @param {import("../core/types.mjs").HostStatus|null} host */
	function pendingLaunchResult(host) {
		return { ok: true, status: "pending", pid: null, socketPath: host?.socketPath ?? null, instanceId: host?.instanceId ?? null };
	}

	/**
	 * Actionable error when the view's defaultModel is provably unavailable
	 * (issue #90): launching a child with a dead model id makes it exit 1 on
	 * every start, so attach would loop cold starts forever. Only fires when a
	 * model is configured AND a live model list is injectable; anything
	 * uncertain (no list, list call failure) conservatively allows the launch.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @returns {string|null}
	 */
	function validateViewModelMeta(meta) {
		const model = meta.defaultModel ?? null;
		if (!model || !availableModelsImpl) return null;
		let available;
		try {
			available = availableModelsImpl();
		} catch {
			return null;
		}
		if (modelRefAvailable(model, available)) return null;
		return `Model "${model}" configured for this session is no longer available — update the view's model (or clear defaultModel) and retry attach.`;
	}

	/**
	 * Claim → spawn → merge flow. The CALLER must already hold the `host-start`
	 * lease; this function never acquires or releases it.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {string|null} initialPrompt
	 * @returns {ReturnType<typeof launchHost>}
	 */
	function startHostUnderLease(meta, initialPrompt, launchOpts = {}) {
		const existing = readHost(root, meta.id);
		if (existing && (existing.state === "starting" || existing.state === "alive" || existing.state === "stopping")) {
			// An active claim already exists — reuse it, never a second spawn.
			return existing.state === "alive"
				? { ok: true, status: "reused", pid: null, socketPath: existing.socketPath ?? null, instanceId: existing.instanceId ?? null }
				: pendingLaunchResult(existing);
		}
		// No record is trivially replaceable; a terminal record only when nothing
		// it names can still be alive (conservative: a live pid is "unknown" and blocks).
		if (existing && !canReplaceHost(observeHostForReplace(existing))) {
			return pendingLaunchResult(existing);
		}

		// Fail fast BEFORE claiming (issue #90): no claim record, no config file,
		// no spawn — the resolver surfaces the error via its pending reason.
		const modelError = validateViewModelMeta(meta);
		if (modelError) return { ok: false, error: modelError };

		const instanceId = randomIdImpl();
		const configPath = P.hostConfigPathFor(root, meta.id, instanceId);
		const socketPath = P.hostEndpointPathFor(process.platform, root, meta.id, instanceId);
		/** @type {import("../core/types.mjs").HostConfig} */
		const config = {
			root,
			viewId: meta.id,
			sessionFile: meta.sessionFile,
			cwd: meta.cwd,
			initialPrompt,
			piCommand: opts.piCommand,
			piArgsPrefix: opts.piArgsPrefix,
			model: meta.defaultModel ?? null,
			thinkingLevel: meta.defaultThinking ?? null,
			tools: null,
			env: {},
			cols: Number(process.env.COLUMNS || 120),
			rows: Number(process.env.LINES || 36),
			screenLogMaxBytes: normalizeScreenLogMaxBytes(readLaunchPrefs(root).screenLogMaxSize),
			instanceId,
			configPath,
			socketPath,
		};
		const claimIdentity = serviceIdentity();
		const claimed = claimHost(root, {
			viewId: meta.id,
			instanceId,
			configPath,
			socketPath,
			claimAt: nowImpl(),
			claimPid: process.pid,
			claimIdentity,
			cols: config.cols,
			rows: config.rows,
		});
		if (!claimed.claimed) {
			// Lost the host-meta race: another launch owns the claim now.
			return pendingLaunchResult(claimed.host);
		}

		let pid = null;
		let spawnError = null;
		try {
			({ pid } = launchHostImpl(root, config, { runnerScript: ptyRunnerScript }));
		} catch (err) {
			spawnError = err instanceof Error ? err.message : String(err);
		}
		if (pid == null) {
			const message = spawnError ?? "PTY host runner failed to spawn";
			updateOwnedHost(root, meta.id, instanceId, (h) => ({ ...h, state: "failed", endedAt: nowImpl(), exitCode: 1, error: message }));
			removeFile(configPath);
			return { ok: false, error: message, fallbackReason: message };
		}
		updateOwnedHost(root, meta.id, instanceId, (h) => ({ ...h, runnerPid: pid, runnerSpawnedAt: nowImpl() }));
		appendDiagnostic(root, meta.id, { source: "service", code: "launch_host", message: "PTY host launched", details: { pid, instanceId, hasInitialPrompt: Boolean(initialPrompt) } });
		return { ok: true, status: "started", pid, socketPath, instanceId };
	}

	/**
	 * Best-effort detached title generation. If this fails or times out, the fallback slug
	 * remains as the row name.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {string} prompt
	 */
	function queueGeneratedTitle(meta, prompt) {
		if (!titleRunnerScript) return;
		/** @type {import("../core/types.mjs").TitleConfig} */
		const config = {
			root,
			viewId: meta.id,
			cwd: meta.cwd,
			prompt,
			fallbackName: meta.name,
			piCommand: opts.piCommand,
			piArgsPrefix: opts.piArgsPrefix,
			model: null,
		};
		try {
			launchTitleImpl(root, config, { runnerScript: titleRunnerScript });
		} catch {
			/* best effort */
		}
	}

	/**
	 * Apply immediate heuristic auto-state and, when configured, queue a detached
	 * model pass to refine the row without blocking the live Pi child.
	 *
	 * Issue #91 (A8, service source): the classification lands through the View
	 * State Coordinator — the single writer of state.json/status.json. On apply,
	 * projection-relevant fields are refreshed from the materialized state so the
	 * caller's foreground projection (writeForegroundState) cannot clobber the
	 * patch with stale in-memory values. Ambiguous transport outcomes (timeout /
	 * connection_reset) never fall back to a direct write — the command may
	 * already be journaled, and the coordinator's boot replay is the recovery
	 * path. coordinator_disabled keeps the pre-coordinator in-memory apply.
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {import("../core/types.mjs").RunStatus} status refreshed in place on apply
	 * @param {import("../core/types.mjs").EvidenceSnapshot} evidence
	 * @returns {Promise<boolean>} whether the classification was applied
	 */
	async function queueAutoState(meta, status, evidence) {
		if (!autoStateEnabled()) return false;
		if (status.processState === "alive" || status.semanticState === "failed" || status.semanticState === "stopped") return false;
		const latest = latestEvidenceText(evidence) || status.latestAssistantPreview || status.summary || "";
		if (!latest.trim()) return false;
		const classification = heuristicAutoState(latest, { lastAgentActivityAt: status.lastAgentActivityAt ?? null });
		const commandRunId = status.runId === "foreground" ? null : status.runId;
		const result = await sendStateCommandImpl(root, {
			type: "state_command",
			viewId: meta.id,
			runId: commandRunId,
			source: "service",
			kind: "auto_state_classified",
			expectedRevision: null,
			payload: { classification },
		});
		if (opts.autoStateRunnerScript) {
			try {
				launchAutoStateImpl(root, {
					root,
					viewId: meta.id,
					runId: status.runId === "foreground" ? null : status.runId,
					cwd: meta.cwd,
					piCommand: opts.piCommand,
					piArgsPrefix: opts.piArgsPrefix,
				}, { runnerScript: opts.autoStateRunnerScript });
			} catch (err) {
				appendDiagnostic(root, meta.id, { source: "service", level: "warn", code: "auto_state_launch_failed", message: "Auto-state classifier could not be launched", details: { error: err instanceof Error ? err.message : String(err) } });
			}
		}
		if (result.status === "applied") {
			const fresh = readState(root, meta.id);
			if (fresh) {
				status.semanticState = fresh.semanticState;
				status.summary = fresh.summary;
				status.question = fresh.question;
				status.autoState = fresh.autoState ?? null;
			}
			return true;
		}
		if (result.reason === "coordinator_disabled") {
			return applyAutoStateToStatus(status, classification, Date.now());
		}
		if (result.reason === "manual_fence" || result.reason === "no_change" || result.reason === "stale_run") {
			// Designed fences — informational, not errors.
			return false;
		}
		appendDiagnostic(root, meta.id, { source: "service", runId: commandRunId, level: "warn", code: "auto_state_command_ambiguous", message: `Auto-state classification outcome unknown (${result.reason}); if the command was journaled, coordinator replay will recover it; otherwise the next classification pass will converge the row`, details: { reason: result.reason } });
		return false;
	}

	/**
	 * Fire a state command for a non-run lifecycle/metadata mutation and surface
	 * non-applied outcomes. Ambiguity contract (issue #91): timeout /
	 * connection_reset mean the command MAY already be journaled — never fall
	 * back to a direct write on those; only the explicit
	 * AGENT_BOARD_COORDINATOR=off escape hatch takes the legacy branch (the
	 * caller checks `reason === "coordinator_disabled"`).
	 * @param {object} command
	 * @param {string} [viewId] defaults to command.viewId
	 */
	async function sendLifecycleCommand(command, viewId = command.viewId) {
		const result = await sendStateCommandImpl(root, command);
		if (result.status !== "applied" && result.reason !== "coordinator_disabled") {
			appendDiagnostic(root, viewId, { source: "service", level: "warn", code: "state_command_not_applied", message: `${command.kind} ${result.status} (${result.reason})`, details: { kind: command.kind, reason: result.reason } });
		}
		return result;
	}

	/** Legacy direct write for mark_queued — coordinator_disabled escape hatch only. */
	function markQueuedDirect(viewId, runId) {
		const state = readState(root, viewId) ?? blankState(viewId);
		state.currentRunId = runId;
		state.semanticState = "queued";
		state.processState = "alive";
		state.summary = "Queued";
		state.needsInput = false;
		state.hasError = false;
		state.question = null;
		state.pendingQuestions = [];
		state.error = null;
		state.autoState = null;
		state.lastActivityAt = Date.now();
		state.updatedAt = Date.now();
		writeState(root, state);
	}

	/** @param {string} viewId @param {string|null} runId @returns {Promise<{status: string, reason: string|null, materializedRevision?: number}>} */
	function markQueued(viewId, runId) {
		if (coordinatorDisabled()) {
			markQueuedDirect(viewId, runId);
			return Promise.resolve({ status: "applied", reason: "coordinator_disabled" });
		}
		// Fire-and-forget: legacy issued this write right after launch() without
		// waiting on the runner, and the coordinator serializes arrival order the
		// same way. N1 (Task 1): command.runId stays null — the new run's id rides
		// in the payload and the decision branch pins currentRunId, so the generic
		// stale-run guard cannot fire against the PREVIOUS run.
		//
		// source is "dashboard-user" on purpose (final-review F1): launching a run
		// from these flows is ALWAYS user intent (reply / dispatch / attach), and
		// the manual fence exists to protect the user's verdict from AUTOMATED late
		// writes — a user-initiated re-launch IS the user changing the verdict, so
		// mark_queued must lift the fence for the rest of the new run (otherwise a
		// reply on a done row would execute invisibly while the row stays
		// completed). Automated re-launch stays guarded upstream: the job-runner's
		// post-exit follow-up claim refuses manually-completed rows
		// (drainQueuedFollowUp: `if (isManualCompletion(readState(...))) return;`),
		// and the service-side drain path delivers already-queued user follow-ups
		// with no fence by design (prompt-not-lost, issue #70 — its live-host input
		// path never fenced either).
		// Fix round 2 (launch ordering): this promise is now AWAITED by launchForView
		// / launchHost before they spawn — see the ordering notes there.
		return sendLifecycleCommand({
			type: "state_command",
			viewId,
			runId: null,
			source: "dashboard-user",
			kind: "mark_queued",
			expectedRevision: null,
			payload: { runId },
		}).catch(() => ({ status: "rejected", reason: "connection_reset" }));
	}

	/** Legacy direct write for markVisited — coordinator_disabled escape hatch only. */
	function markVisitedDirect(row) {
		const state = readState(root, row.meta.id) ?? row.state ?? blankState(row.meta.id);
		state.lastVisitedAt = Date.now();
		state.updatedAt = Date.now();
		writeState(root, state);
	}

	/**
	 * @param {string} viewId
	 * @returns {Promise<{ ok: boolean, error?: string }>}
	 */
	async function markVisited(viewId) {
		const row = loadRow(root, viewId);
		if (!row) return { ok: false, error: "Unknown session" };
		if (coordinatorDisabled()) {
			markVisitedDirect(row);
			return { ok: true };
		}
		// dashboard-user (not "service"): visiting is a user action, and the
		// manual fence must not stop visit-recency tracking on completed rows —
		// legacy stamped lastVisitedAt unconditionally. Whitelist: lastVisitedAt only.
		const result = await sendLifecycleCommand({
			type: "state_command",
			viewId,
			source: "dashboard-user",
			kind: "patch_fields",
			expectedRevision: null,
			payload: { state: { lastVisitedAt: Date.now() } },
		}, viewId);
		if (result.reason === "coordinator_disabled") markVisitedDirect(row);
		// Visit tracking is best-effort metadata — never fail the UI action.
		return { ok: true };
	}

	/** Legacy direct write for adoptSession — coordinator_disabled escape hatch only. */
	function adoptStateDirect(viewId, state) {
		const target = state ?? readState(root, viewId) ?? blankState(viewId);
		target.semanticState = "idle";
		target.processState = "exited";
		target.needsInput = false;
		target.hasError = false;
		target.question = null;
		target.pendingQuestions = [];
		target.error = null;
		target.summary = "Backgrounded session";
		target.updatedAt = Date.now();
		target.lastActivityAt = Date.now();
		writeState(root, target);
	}

	/** Route the adopt-idle transition through the coordinator (fenced, journaled). */
	async function adoptIdleState(viewId, state) {
		const result = await sendLifecycleCommand({
			type: "state_command",
			viewId,
			runId: null,
			source: "dashboard-user",
			kind: "adopt_session",
			expectedRevision: null,
			payload: {},
		}, viewId);
		if (result.reason === "coordinator_disabled") adoptStateDirect(viewId, state);
	}

	/** Legacy direct-write completion — only reachable when the coordinator is
	 *  explicitly disabled (AGENT_BOARD_COORDINATOR=off tests/escape hatch). */
	function completeViewDirect(state) {
		state.semanticState = "completed";
		state.processState = "exited";
		state.needsInput = false;
		state.hasError = false;
		state.question = null;
		state.pendingQuestions = [];
		state.error = null;
		state.autoState = null;
		state.summary = completionSummary(state);
		state.lastActivityAt = Date.now();
		state.updatedAt = Date.now();
		// Also clear autoState in the run status so in-flight model passes
		// (job-runner / state-runner) see the manual completion and skip refinement.
		if (state.currentRunId) {
			const status = readStatus(root, state.viewId, state.currentRunId);
			if (status) {
				status.autoState = null;
				writeStatus(root, status);
			}
		}
		writeState(root, state);
	}

	/**
	 * Explicitly mark an inactive session as done via the View State Coordinator
	 * (issue #91): the command is journaled and materialized by the single owner,
	 * which also rejects stale-run and fenced manual-completion overwrites.
	 * @param {string} viewId
	 * @returns {Promise<{ ok: boolean, error?: string }>}
	 */
	async function completeView(viewId) {
		const row = loadRow(root, viewId);
		if (!row) return { ok: false, error: "Unknown session" };
		// Fast local pre-check for instant UI feedback; the coordinator's decision
		// stays authoritative (its "busy" rejection maps to the same wording).
		if (isAgentBusy(row)) return { ok: false, error: "Wait for the active run to finish before marking done" };
		const state = readState(root, viewId) ?? row.state ?? blankState(viewId);
		const result = await sendStateCommandImpl(root, {
			type: "state_command",
			viewId,
			runId: state.currentRunId ?? null,
			source: "dashboard-user",
			kind: "mark_completed",
			expectedRevision: null,
			payload: {},
		});
		if (result.status === "applied") return { ok: true };
		if (result.reason === "busy") return { ok: false, error: "Wait for the active run to finish before marking done" };
		if (result.reason === "coordinator_disabled") {
			completeViewDirect(state);
			return { ok: true };
		}
		// Ambiguous outcomes (timeout / connection_reset: the command MAY already be
		// journaled) and real rejections surface verbatim — never fall back to a
		// direct write here, it would bypass the single-writer fence.
		return { ok: false, error: result.reason ?? "state_command_failed" };
	}

	/** Legacy direct write for archiveView's busy-row stop — coordinator_disabled escape hatch only. */
	function archiveStateDirect(row) {
		const state = readState(root, row.meta.id) ?? row.state ?? blankState(row.meta.id);
		state.semanticState = "stopped";
		state.processState = "exited";
		state.needsInput = false;
		state.hasError = false;
		state.question = null;
		state.pendingQuestions = [];
		state.error = null;
		state.autoState = null;
		state.summary = "Stopped";
		state.lastActivityAt = Date.now();
		state.updatedAt = Date.now();
		writeState(root, state);
	}

	/**
	 * @param {string} viewId
	 * @returns {Promise<{ ok: boolean, error?: string }>}
	 */
	async function archiveView(viewId) {
		const row = loadRow(root, viewId);
		if (!row) return { ok: false, error: "Unknown session" };
		if (row.host?.instanceId) stopHostRow(row, "archive");
		else if (row.hostAlive) sendHostMessage(row, { type: "terminate" });
		if (row.alive && row.state?.currentRunId) {
			const pid = readPid(root, viewId, row.state.currentRunId);
			if (pid) killProcess(pid);
		}
		if (isAgentBusy(row)) {
			// dashboard-user: archiving is a user action. Busy rows are allowed by
			// the decision kind (archiving a working row stops it — legacy parity).
			const result = await sendLifecycleCommand({
				type: "state_command",
				viewId,
				source: "dashboard-user",
				kind: "archive_view",
				expectedRevision: null,
				payload: {},
			}, viewId);
			if (result.reason === "coordinator_disabled") archiveStateDirect(row);
		}
		row.meta.archived = true;
		writeMeta(root, row.meta);
		return { ok: true };
	}

	/** @param {string} viewId @returns {import("../core/types.mjs").ViewState} */
	function blankState(viewId) {
		return {
			version: 1,
			viewId,
			currentRunId: null,
			semanticState: "queued",
			processState: "exited",
			summary: "Queued",
			lastActivityAt: Date.now(),
			updatedAt: Date.now(),
			needsInput: false,
			hasError: false,
			latestAssistantPreview: "",
			latestTool: null,
			question: null,
			pendingQuestions: [],
			error: null,
			lastVisitedAt: null,
			lastAgentActivityAt: null,
			autoState: null,
		};
	}

	/** @param {string} a @param {string} b */
	function samePath(a, b) {
		return resolve(a) === resolve(b);
	}

	/**
	 * @param {import("../core/store.mjs").Row} row
	 * @returns {import("../core/types.mjs").RunStatus}
	 */
	function statusFromRow(row) {
		const now = Date.now();
		const s = row.state ?? blankState(row.meta.id);
		return {
			version: 1,
			runId: s.currentRunId ?? "foreground",
			viewId: row.meta.id,
			pid: null,
			startedAt: s.lastActivityAt ?? now,
			endedAt: null,
			exitCode: null,
			kind: "reply",
			prompt: "",
			model: row.meta.defaultModel ?? null,
			semanticState: s.semanticState,
			processState: s.processState,
			summary: s.summary,
			lastActivityAt: s.lastActivityAt,
			currentTool: s.latestTool ? { name: s.latestTool.name, path: s.latestTool.path, summary: s.summary } : null,
			latestAssistantPreview: s.latestAssistantPreview,
			question: s.question,
			pendingQuestions: Array.isArray(s.pendingQuestions) ? s.pendingQuestions : [],
			error: s.error,
			lastAgentActivityAt: s.lastAgentActivityAt ?? null,
			stopReason: null,
			stoppedByUser: false,
			turns: 0,
			toolCount: 0,
			autoState: s.autoState ?? null,
		};
	}

	/**
	 * @param {import("../core/store.mjs").Row} row
	 * @param {import("../core/types.mjs").RunStatus} status
	 * @returns {Promise<void>}
	 */
	async function writeForegroundState(row, status) {
		const projected = projectViewState(status, Date.now(), readState(root, row.meta.id) ?? row.state ?? null);
		// Foreground turns are driven by the interactive Pi process, not a detached
		// runner, so keep currentRunId null. This prevents reconcile()/stop() from
		// treating a foreground turn as a managed background runner pid. (The
		// decision kind force-nulls it too; the caller-side null keeps the
		// coordinator_disabled direct write at legacy parity.)
		projected.currentRunId = null;
		if (coordinatorDisabled()) {
			writeState(root, projected);
			return;
		}
		const result = await sendLifecycleCommand({
			type: "state_command",
			viewId: row.meta.id,
			runId: null,
			source: "service",
			kind: "sync_foreground",
			expectedRevision: null,
			payload: { projection: projected },
		}, row.meta.id);
		if (result.reason === "coordinator_disabled") writeState(root, projected);
	}

	/** @param {string} sessionFile */
	function rowForSession(sessionFile) {
		return listRows(root, { includeArchived: true }).find((r) => samePath(r.meta.sessionFile, sessionFile)) ?? null;
	}

	/**
	 * Evict idle warm PTY hosts past TTL / over the warm pool cap.
	 * Idle = host alive, not agent-busy, no attached clients.
	 * Called lazily from dispatch/ensureHost (keepViewId = the view being used)
	 * and periodically / on shutdown by the warm-host sweeper (issue #75).
	 * @param {{ keepViewId?: string|null }} [pruneOpts]
	 */
	function pruneWarmHosts(pruneOpts = {}) {
		const maxWarm = envInt("AGENT_BOARD_MAX_WARM_HOSTS", 4, 0, 50, "AGENT_VIEW_MAX_WARM_HOSTS");
		const ttlMs = envInt("AGENT_BOARD_WARM_HOST_TTL_MS", 10 * 60 * 1000, 0, 24 * 60 * 60 * 1000, "AGENT_VIEW_WARM_HOST_TTL_MS");
		if (maxWarm === 0 && ttlMs === 0) return;
		const graceMs = envInt("AGENT_BOARD_WARM_HOST_GRACE_MS", 30 * 1000, 0, 24 * 60 * 60 * 1000, "AGENT_VIEW_WARM_HOST_GRACE_MS");
		const { ttlEvicted, excessEvicted } = selectIdleHostsToEvict(listRows(root), {
			now: Date.now(),
			maxWarm,
			ttlMs,
			graceMs,
			keepViewId: pruneOpts.keepViewId ?? null,
		});
		for (const viewId of [...ttlEvicted, ...excessEvicted]) {
			// Re-verify against fresh state before terminating: the selection ran
			// on a listRows snapshot, and the host may have been dispatched (busy)
			// or attached (attachedClients > 0) since. Never kill a busy/attached
			// host; graceMs also re-checked in case the host was just restarted.
			const row = loadRow(root, viewId);
			if (!row?.hostAlive) continue;
			if (isAgentBusy(row)) continue;
			if ((row.host?.attachedClients ?? 0) !== 0) continue;
			if (graceMs > 0 && row.host?.startedAt != null && Date.now() - row.host.startedAt < graceMs) continue;
			stopHostRow(row, "warm_prune");
		}
	}

	/** Stop a host row by policy (issue #70): new-protocol hosts get the authoritative
	 *  file-based revoke (works even when the control socket is dead); legacy hosts
	 *  without an instanceId keep the old socket-terminate fallback. */
	function stopHostRow(row, reason) {
		const instanceId = row.host?.instanceId ?? null;
		if (instanceId) return requestHostStop(row.meta.id, instanceId, reason);
		return sendHostMessage(row, { type: "terminate" });
	}

	/**
	 * File-based host revoke (issue #70): marks the host record `stopping` with a
	 * fresh revoke token so the runner's heartbeat shuts it down cooperatively.
	 * Never signals, never spawns a replacement. Idempotent: terminal or
	 * already-stopping states are left untouched (`requested: false`).
	 * @param {string} viewId
	 * @param {string|null} expectedInstanceId
	 * @param {string} reason
	 * @returns {{ ok: boolean, requested?: boolean, error?: string }}
	 */
	function requestHostStop(viewId, expectedInstanceId, reason) {
		let wasRequested = false;
		const res = updateOwnedHost(root, viewId, expectedInstanceId, (h) => {
			if (h.state === "exited" || h.state === "failed" || h.state === "stopping") return h;
			wasRequested = true;
			return { ...h, state: "stopping", stopRequestedAt: nowImpl(), revokeToken: randomIdImpl(), stopReason: reason };
		});
		if (!res.updated) return { ok: false, error: "owner_changed" };
		return { ok: true, requested: wasRequested };
	}

	/** Observe one host role: a recorded identity goes through identity-aware
	 *  observation; a missing identity means `not_started` (never spawned) or
	 *  `unknown` (spawn attempted, identity unavailable) — never `dead`. */
	function observeHostRole(host, role) {
		const identity = host?.[`${role}Identity`] ?? null;
		if (identity) return observeProcessImpl(identity);
		return host?.[`${role}SpawnedAt`] == null ? "not_started" : "unknown";
	}

	/**
	 * Revoke + wait + replace a broken host (issue #70). The caller (attach
	 * resolver) has already probed and decided the instance is unrecoverable.
	 * Escalation signals go ONLY to identities observed as "owned" at that
	 * moment, each guarded by an instance re-read; unknown identities leave the
	 * host pending instead of guessing. The replacement claim is created only
	 * after runner and child are both confirmed ended.
	 * @param {string} viewId
	 * @param {string} expectedInstanceId
	 * @returns {Promise<{ ok: boolean, recovered?: boolean, instanceId?: string, socketPath?: string|null, error?: string }>}
	 */
	/** A host role observation is "ended" when it is provably not running:
	 *  never-spawned, confirmed dead, or a reused PID (foreign). */
	const hostRoleEnded = (o) => o === "not_started" || o === "dead" || o === "foreign";

	async function recoverHost(viewId, expectedInstanceId) {
		const ended = hostRoleEnded;
		const instanceStillExpected = () => {
			const h = readHost(root, viewId);
			return h != null && h.instanceId === expectedInstanceId;
		};

		// Gate: another launch/recovery in flight, or the instance already moved on.
		const gate = tryAcquireLockImpl(root, viewId, "host-start", { identity: serviceIdentity() });
		if (!gate.acquired) return { ok: false, error: "busy_retry_later" };
		try {
			const current = readHost(root, viewId);
			if (!current || current.instanceId !== expectedInstanceId) return { ok: false, error: "already_recovered" };
			if (current.state === "exited" || current.state === "failed") return { ok: false, error: "already_recovered" };
		} finally {
			try { gate.lease.release(); } catch { /* best effort */ }
		}

		// File-based revoke under the lease is done; release before waiting so the
		// dying runner's own finish path is never blocked by this recovery.
		requestHostStop(viewId, expectedInstanceId, "recovery");

		// Bounded wait for runner/child to end, with identity-checked escalation.
		const startedAt = nowImpl();
		let runnerTermSent = false;
		let runnerKillSent = false;
		let childTermSent = false;
		let childKillSent = false;
		let childTermAt = 0;
		while (nowImpl() - startedAt < HOST_RECOVERY_GRACE_MS) {
			const host = readHost(root, viewId);
			if (!host || host.instanceId !== expectedInstanceId) return { ok: false, error: "already_recovered" };
			const runnerObservation = observeHostRole(host, "runner");
			const childObservation = observeHostRole(host, "child");
			if (ended(runnerObservation) && ended(childObservation)) break;
			// Alive-but-unverifiable: never signal, never claim — stay pending.
			if (runnerObservation === "unknown" || childObservation === "unknown") return { ok: false, error: "recovery_pending" };
			if (!instanceStillExpected()) return { ok: false, error: "already_recovered" };
			const elapsed = nowImpl() - startedAt;
			if (runnerObservation === "owned") {
				if (!runnerTermSent) {
					signalOwnedProcessImpl(host.runnerIdentity, "SIGTERM");
					runnerTermSent = true;
				} else if (elapsed >= HOST_RECOVERY_GRACE_MS / 2 && !runnerKillSent) {
					signalOwnedProcessImpl(host.runnerIdentity, "SIGKILL");
					runnerKillSent = true;
				}
			}
			// The child is only escalated once its runner is confirmed gone.
			if (childObservation === "owned" && runnerObservation !== "owned") {
				if (!childTermSent) {
					signalOwnedProcessImpl(host.childIdentity, "SIGTERM");
					childTermSent = true;
					childTermAt = elapsed;
				} else if (elapsed - childTermAt >= 1_000 && !childKillSent) {
					signalOwnedProcessImpl(host.childIdentity, "SIGKILL");
					childKillSent = true;
				}
			}
			await sleepFnImpl(HOST_RECOVERY_POLL_MS);
		}
		// Grace exhausted or loop broke — verify both roles are confirmed ended before claiming.
		const finalHost = readHost(root, viewId);
		if (!finalHost || finalHost.instanceId !== expectedInstanceId) return { ok: false, error: "already_recovered" };
		if (!ended(observeHostRole(finalHost, "runner")) || !ended(observeHostRole(finalHost, "child"))) {
			return { ok: false, error: "recovery_pending" };
		}

		// Claim the replacement under the host-start lease: finalize the old record
		// (clearing its process fields — they are confirmed gone) and claim fresh.
		let claimLease;
		try {
			claimLease = acquireLockImpl(root, viewId, "host-start", { waitMs: HOST_START_LOCK_WAIT_MS, identity: serviceIdentity() });
		} catch {
			return { ok: false, error: "busy_retry_later" };
		}
		try {
			const current = readHost(root, viewId);
			if (!current || current.instanceId !== expectedInstanceId) return { ok: false, error: "already_recovered" };
			const finalized = updateOwnedHost(root, viewId, expectedInstanceId, (h) => ({
				...h,
				state: "exited",
				endedAt: h.endedAt ?? nowImpl(),
				exitCode: h.exitCode ?? 0,
				runnerPid: null,
				runnerIdentity: null,
				runnerSpawnedAt: null,
				childPid: null,
				childIdentity: null,
				childSpawnedAt: null,
			}));
			if (!finalized.updated) return { ok: false, error: "owner_changed" };
			const instanceId = randomIdImpl();
			// claimPid stays null: this recovery transaction is COMPLETE once the claim
			// is on disk (nothing of ours is still between claim and spawn — spawning is
			// deliberately the adopter's job). A live claimPid would make ensureHost /
			// the resolver treat the replacement as a launcher mid-transaction and wait
			// out HOST_START_GRACE_MS before adopting, which starves the recovery chain
			// on slow machines (PR #84 A10 CI flake). Null = no launcher to protect:
			// claimerGone holds immediately, so adoption can fire on the next tick.
			const claimed = claimHost(root, {
				viewId,
				instanceId,
				configPath: P.hostConfigPathFor(root, viewId, instanceId),
				socketPath: P.hostEndpointPathFor(process.platform, root, viewId, instanceId),
				claimAt: nowImpl(),
				claimPid: null,
				claimIdentity: null,
				cols: Number(process.env.COLUMNS || 120),
				rows: Number(process.env.LINES || 36),
			});
			if (!claimed.claimed) return { ok: false, error: "claim_lost", socketPath: claimed.host?.socketPath ?? null };
			appendDiagnostic(root, viewId, { source: "service", code: "host_recovered", message: "PTY host recovered after revoke", details: { oldInstanceId: expectedInstanceId, instanceId } });
			return { ok: true, recovered: true, instanceId, socketPath: claimed.host?.socketPath ?? null };
		} finally {
			try { claimLease.release(); } catch { /* best effort */ }
		}
	}

	/**
	 * ensureHost implementation (issue #70 Task 10 + Task 12 adopt branch).
	 * @param {string} viewId
	 * @returns {{ ok: boolean, pending?: boolean, started?: boolean, socketPath?: string|null, instanceId?: string|null, error?: string, fallbackReason?: string }}
	 */
	function ensureHostImpl(viewId) {
		const row = loadRow(root, viewId);
		if (!row) return { ok: false, error: "Unknown session" };
		const host = row.host ?? null;
		// Adopt-and-spawn (issue #70 Task 12): a `starting` claim whose runner was never
		// spawned (the launcher crashed between claim and spawn, or recoverHost claimed
		// a replacement without spawning) would pend forever. Take it over ONLY when the
		// claim is provably stale or its claimer is gone. Recovery-created claims carry
		// claimPid:null (their transaction is complete; spawning is the adopter's job),
		// so claimerGone holds immediately and they adopt without a grace wait. Fresh
		// claims with a live claimPid stay untouched: their launcher may legitimately be
		// between claim and spawn inside the grace window.
		if (host?.state === "starting" && host.runnerSpawnedAt == null && host.instanceId != null) {
			const claimStale = nowImpl() - (host.claimAt ?? 0) > HOST_START_GRACE_MS;
			const claimerGone = !isAlive(host.claimPid ?? null);
			if (claimStale || claimerGone) return adoptClaimedHost(viewId, row.meta, host);
		}
		if (row.hostActive) {
			return { ok: true, pending: true, socketPath: row.host?.socketPath ?? null, instanceId: row.host?.instanceId ?? null };
		}

		// Default probe semantics: success is cached for the process lifetime and a
		// failed probe retries on a short TTL. Forcing refresh here would spawn a
		// probe process on every keypress-driven prewarm when PTY support is broken.
		const pty = ptySupport();
		if (!pty.ok) return { ok: false, error: "PTY unavailable", fallbackReason: nodePtyFallbackMessage(pty) };
		if (isAgentBusy(row)) return { ok: false, error: "A non-live background run is active for this session" };
		if (!existsSync(row.meta.sessionFile)) return { ok: false, error: "Session file isn't ready yet" };

		const lock = tryAcquireLockImpl(root, viewId, "host-start", { identity: serviceIdentity() });
		if (!lock.acquired) {
			// Someone else (another board/service process) is mid-launch — its claim
			// will appear on disk; treat that as an in-flight start, not a failure.
			return { ok: true, pending: true, socketPath: null, instanceId: null };
		}
		try {
			const inner = readHost(root, viewId);
			if (inner && (inner.state === "starting" || inner.state === "alive" || inner.state === "stopping")) {
				return { ok: true, pending: true, socketPath: inner.socketPath ?? null, instanceId: inner.instanceId ?? null };
			}
			const res = startHostUnderLease(row.meta, null, { markQueued: false });
			if (res.ok && res.status === "started") pruneWarmHosts({ keepViewId: viewId });
			return res.ok
				? { ok: true, started: res.status === "started", pending: res.status !== "started", socketPath: res.socketPath, instanceId: res.instanceId }
				: res;
		} finally {
			try { lock.lease.release(); } catch { /* best effort */ }
		}
	}

	/**
	 * Finish an abandoned host claim: spawn its runner under the `host-start` lease
	 * (issue #70 Task 12). The claim's config was never written (the claimer died
	 * before spawn, or recoverHost claims without writing one — Task 11 rider a), so
	 * it is rebuilt from the view meta here. A failed spawn marks the claim failed
	 * fenced (clearing the dead claimer's fields) so the next ensure can claim anew.
	 * @param {string} viewId
	 * @param {import("../core/types.mjs").ViewMeta} meta
	 * @param {import("../core/types.mjs").HostStatus} host
	 */
	function adoptClaimedHost(viewId, meta, host) {
		const instanceId = host.instanceId;
		const lock = tryAcquireLockImpl(root, viewId, "host-start", { identity: serviceIdentity() });
		if (!lock.acquired) {
			// Another adopter/spawner is mid-transaction — its result lands on disk.
			return { ok: true, pending: true, socketPath: host.socketPath ?? null, instanceId };
		}
		try {
			const current = readHost(root, viewId);
			if (!current || current.instanceId !== instanceId || current.state !== "starting" || current.runnerSpawnedAt != null) {
				// The record moved on (adopted elsewhere, revoked, or replaced) — surface it.
				return { ok: true, pending: true, socketPath: current?.socketPath ?? host.socketPath ?? null, instanceId: current?.instanceId ?? instanceId };
			}
			// Stale-model guard (issue #90): the claim is an abandoned record, so mark
			// it failed fenced (same shape as the spawn-failure path below — the next
			// ensure can claim anew) instead of spawning a child doomed to exit 1.
			const modelError = validateViewModelMeta(meta);
			if (modelError) {
				updateOwnedHost(root, viewId, instanceId, (h) => ({ ...h, state: "failed", endedAt: nowImpl(), exitCode: 1, error: modelError, claimPid: null, claimIdentity: null }));
				return { ok: true, pending: true, socketPath: null, instanceId };
			}
			const configPath = current.configPath ?? P.hostConfigPathFor(root, viewId, instanceId);
			const socketPath = current.socketPath ?? P.hostEndpointPathFor(process.platform, root, viewId, instanceId);
			/** @type {import("../core/types.mjs").HostConfig} */
			const config = {
				root,
				viewId,
				sessionFile: meta.sessionFile,
				cwd: meta.cwd,
				initialPrompt: null,
				piCommand: opts.piCommand,
				piArgsPrefix: opts.piArgsPrefix,
				model: meta.defaultModel ?? null,
				thinkingLevel: meta.defaultThinking ?? null,
				tools: null,
				env: {},
				cols: current.cols || 120,
				rows: current.rows || 36,
				screenLogMaxBytes: normalizeScreenLogMaxBytes(readLaunchPrefs(root).screenLogMaxSize),
				instanceId,
				configPath,
				socketPath,
			};
			if (!existsSync(configPath)) atomicWriteJson(configPath, config);
			let pid = null;
			let spawnError = null;
			try {
				({ pid } = launchHostImpl(root, config, { runnerScript: ptyRunnerScript }));
			} catch (err) {
				spawnError = err instanceof Error ? err.message : String(err);
			}
			if (pid == null) {
				const message = spawnError ?? "PTY host runner failed to spawn (adopted claim)";
				// Clear the dead claimer's fields (failed fenced — keeps the record
				// replaceable without depending on claimer liveness; canReplaceHost no
				// longer consults claim fields, see issue #99).
				updateOwnedHost(root, viewId, instanceId, (h) => ({ ...h, state: "failed", endedAt: nowImpl(), exitCode: 1, error: message, claimPid: null, claimIdentity: null }));
				removeFile(configPath);
				return { ok: true, pending: true, socketPath: null, instanceId };
			}
			updateOwnedHost(root, viewId, instanceId, (h) => ({ ...h, runnerPid: pid, runnerSpawnedAt: nowImpl() }));
			appendDiagnostic(root, viewId, { source: "service", code: "host_adopted", message: "Abandoned host claim adopted; runner spawned", details: { pid, instanceId } });
			return { ok: true, started: true, socketPath, instanceId };
		} finally {
			try { lock.lease.release(); } catch { /* best effort */ }
		}
	}

	/**
	 * The single attach authority (issue #70 Task 12): resolves a view to a PTY
	 * target via REAL socket probes, waiting out cold starts, adopting abandoned
	 * claims, and running one bounded recovery per invocation. Never downgrades to
	 * `session` while a host claim is active. All waits go through sleepFn — the
	 * resolver runs on the UI thread and must never block on a lock.
	 * @param {string} viewId
	 * @param {number} timeoutMs
	 * @returns {Promise<{kind:"pty",socketPath:string|null,sessionFile:string,instanceId:string|null}|{kind:"session",sessionFile:string}|{kind:"pending",sessionFile:string,reason:string}|{kind:"missing"}>}
	 */
	async function resolveAttachTargetInner(viewId, timeoutMs) {
		const deadline = nowImpl() + timeoutMs;
		let ensured = false;
		let recovered = false;
		// Last adopt-and-spawn attempt (issue #70 CI wave 2): adoption is retried
		// across loop iterations while the stale-claim conditions hold — a single
		// failed/contended attempt must not pend the resolver to its deadline. The
		// host-start lease inside adoptClaimedHost serializes attempts (idempotent:
		// a successful adoption flips runnerSpawnedAt and the conditions stop
		// holding), and this timestamp rate-limits post-adopt re-ensures.
		let lastAdoptAt = 0;
		/** @param {string} reason @param {string} sessionFile */
		const pending = (sessionFile, reason) => ({ kind: "pending", sessionFile, reason });
		for (;;) {
			const row = loadRow(root, viewId);
			if (!row) return { kind: "missing" };
			const sessionFile = row.meta.sessionFile;
			if (nowImpl() >= deadline) return pending(sessionFile, "host start timed out");
			const host = row.host ?? null;

			// No active claim: live JSON runners pend (no parallel PTY child); otherwise
			// ensure exactly one host start per invocation, then fall through to probing.
			if (!host || !row.hostActive) {
				if (isAgentBusy(row)) return pending(sessionFile, "background run active");
				// A claim that turned terminal AFTER our adopt attempt (spawn failed —
				// adoptClaimedHost marks it failed fenced) may be re-claimed, at most
				// once per grace window: the fresh claim's own grace period spaces the
				// attempts out and the resolver deadline bounds the total, preserving the
				// once-per-invocation ensure guarantee as a rate limit rather than a
				// pend-forever on one bad attempt.
				if (
					(host?.state === "exited" || host?.state === "failed") &&
					lastAdoptAt > 0 &&
					nowImpl() - lastAdoptAt >= HOST_START_GRACE_MS
				) {
					ensured = false;
				}
				if (!ensured) {
					ensured = true;
					const res = ensureHostImpl(viewId);
					if (!res.ok) {
						if (res.fallbackReason != null) {
							// PTY unavailable and nothing active — safe to fall back to session attach.
							const fresh = loadRow(root, viewId);
							return fresh && !fresh.hostActive ? { kind: "session", sessionFile: fresh.meta.sessionFile } : pending(sessionFile, res.error ?? "host ensure failed");
						}
						return pending(sessionFile, res.error ?? "host ensure failed");
					}
				}
				await sleepFnImpl(HOST_PROBE_RETRY_MS);
				continue;
			}

			// A revoke is in flight — wait it out; never revoke twice. But a stale
			// `stopping` record whose processes are provably gone is a stranded
		// deadlock (SIGKILLed runner never finalizes; nothing else covers stopping)
			// — finalize it through the same bounded recovery path (CR r1 f2).
			if (host.state === "stopping") {
				const staleStop = host.instanceId != null && nowImpl() - (host.stopRequestedAt ?? host.claimAt ?? 0) >= HOST_RECOVERY_GRACE_MS;
				if (staleStop && !recovered) {
					const runnerObs = observeHostRole(host, "runner");
					const childObs = observeHostRole(host, "child");
					if (runnerObs === "unknown" || childObs === "unknown") {
						// Unverifiable processes on a stranded record — never force.
						return pending(sessionFile, "recovery_pending: host identity unverifiable");
					}
					if (hostRoleEnded(runnerObs) && hostRoleEnded(childObs)) {
						recovered = true;
						try {
							const rec = await recoverHost(viewId, /** @type {string} */ (host.instanceId));
							if (!rec.ok && rec.error === "recovery_pending") {
								return pending(sessionFile, "recovery_pending: host identity unverifiable");
							}
						} catch {
							// recoverHost rethrows non-ESRCH signal failures — surface, don't crash.
						}
						await sleepFnImpl(HOST_PROBE_RETRY_MS);
						continue;
					}
				}
				await sleepFnImpl(HOST_PROBE_RETRY_MS);
				continue;
			}

			const legacy = host.instanceId == null;
			const withinGrace = host.state === "starting" && (legacy || (host.claimPid != null && nowImpl() - (host.claimAt ?? 0) < HOST_START_GRACE_MS));
			const probe = await probeHostImpl(host.socketPath ?? "", { expectedViewId: viewId, expectedInstanceId: host.instanceId ?? null });
			if (probe.classification === "ready") {
				return { kind: "pty", socketPath: host.socketPath ?? null, sessionFile, instanceId: host.instanceId ?? null };
			}

			if (host.state === "starting") {
				// Gap-closer: a claim whose runner was never spawned (recovery claim or an
				// abandoned launch) is adopted past grace. Recovery-created claims carry
				// claimPid:null — no launcher to protect — so they are NOT within grace and
				// adopt immediately; claims with a live claimPid wait out the window like
				// any launcher mid-transaction (contract §6).
				// Retried per iteration: a contended or failed attempt must not pend
				// the resolver to its deadline (issue #70 CI wave 2).
			if (!legacy && host.runnerSpawnedAt == null && probe.classification === "missing" && !withinGrace) {
					lastAdoptAt = nowImpl();
					ensureHostImpl(viewId);
					await sleepFnImpl(HOST_PROBE_RETRY_MS);
					continue;
				}
				if (withinGrace || legacy) {
					// A legacy starting host whose runner is provably dead would wait out
					// the grace window forever (withinGrace is always true for legacy) —
					// finalize it now instead (issue #87).
					if (legacy && finalizeDeadLegacyHost(root, viewId, host, probe.classification, nowImpl(), tryAcquireLockImpl)) {
						await sleepFnImpl(HOST_PROBE_RETRY_MS);
						continue;
					}
					// Normal cold start (or a legacy starting host — legacy is never recovered,
				// spec §10.1): wait out the grace window.
				await sleepFnImpl(HOST_PROBE_RETRY_MS);
					continue;
				}
			} else if (probe.classification === "starting" || probe.classification === "occupied") {
				// Alive record, mid-transition or a foreign listener — wait, don't touch.
				await sleepFnImpl(HOST_PROBE_RETRY_MS);
				continue;
			} else if (legacy) {
				// Legacy host unreachable. spec §10.1 says never recover — unless the
				// runner pid is provably dead, in which case finalize and self-heal
				// (issue #87).
				if (finalizeDeadLegacyHost(root, viewId, host, probe.classification, nowImpl(), tryAcquireLockImpl)) {
					await sleepFnImpl(HOST_PROBE_RETRY_MS);
					continue;
				}
				return pending(sessionFile, "legacy host unreachable — manual restart needed");
			}

			// Unhealthy new-protocol host past grace: one bounded recovery per invocation.
			if (!recovered) {
				recovered = true;
				try {
					const rec = await recoverHost(viewId, /** @type {string} */ (host.instanceId));
					if (!rec.ok && rec.error === "recovery_pending") {
						return pending(sessionFile, "recovery_pending: host identity unverifiable");
					}
					// recovered / busy_retry_later / already_recovered — loop and re-evaluate.
					await sleepFnImpl(HOST_PROBE_RETRY_MS);
					continue;
				} catch {
					// recoverHost rethrows non-ESRCH signal failures (Task 11 rider b) — never
					// guess at process state; surface as pending for the next attempt.
					return pending(sessionFile, "recovery signal failed");
				}
			}
			await sleepFnImpl(HOST_PROBE_RETRY_MS);
		}
	}

	/** @param {import("../core/types.mjs").FollowUpKind|import("../core/types.mjs").RunKind|string} kind */
	function runKindForKind(kind) {
		switch (kind) {
			case "plan_request":
				return "plan";
			case "plan_change":
				return "plan_change";
			case "plan_approval":
				return "plan_approval";
			case "plan":
			case "reply":
			case "dispatch":
				return kind;
			default:
				return "reply";
		}
	}

	/** @param {import("../core/types.mjs").FollowUpItem} item */
	function runKindForFollowUp(item) {
		return runKindForKind(item.kind);
	}

	/** @param {string} viewId @param {import("../core/types.mjs").FollowUpItem} item */
	function promptForFollowUp(viewId, item) {
		const steering = readSteering(root, viewId);
		switch (item.kind) {
			case "plan_request":
				return buildPlanRequestPrompt(item.text);
			case "plan_approval":
				return buildApprovePlanPrompt(steering.planText);
			case "plan_change":
				return buildPlanChangesPrompt(steering.planText, item.text);
			default:
				return item.text;
		}
	}

	/**
	 * Claim the next queued follow-up and deliver it. Host-path delivery is
	 * async: the item is only completed on input_ack; any failure releases it
	 * back to queued for a later retry (issue #70 A13).
	 * @param {string} viewId
	 * @returns {Promise<{ ok: boolean, error?: string, sent?: boolean, started?: boolean, pending?: boolean, item?: any }>}
	 */
	async function drainNextFollowUp(viewId) {
		const row = loadRow(root, viewId);
		if (!row) return { ok: false, error: "Unknown session" };
		if (!canAutoDrain(row)) return { ok: false, error: "Session is not ready to drain queued follow-ups" };
		const claimed = claimNextFollowUp(root, viewId);
		if (!claimed.ok || !claimed.item) return claimed;
		const item = claimed.item;
		const prompt = promptForFollowUp(viewId, item);
		try {
			if (item.kind === "plan_approval") markExecutingApprovedPlan(root, viewId);
			if (row.hostActive) {
				const socketPath = row.host?.socketPath;
				// Legacy host (pre-upgrade runner, no instanceId): it never sends
				// input_ack, so the ack path would loop forever. Deliver with the
				// old fire-and-forget semantics and complete on connect (final
				// review finding 1).
				if (row.host?.instanceId == null) {
					const sent = sendHostMessage(row, { type: "input", data: `${prompt}\r` });
					if (sent.ok) {
						completeFollowUp(root, viewId, item.id);
						appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_sent", message: "Queued follow-up sent to live host", details: { kind: item.kind, legacy: true } });
						return { ok: true, sent: true, item };
					}
					releaseFollowUp(root, viewId, item.id);
					appendDiagnostic(root, viewId, { source: "queue", level: "warn", code: "follow_up_send_failed", message: "Queued follow-up could not be delivered to the host", details: { kind: item.kind, error: sent.error ?? "unknown", legacy: true } });
					return { ok: true, pending: true, item };
				}
				const sent = socketPath
					? await sendHostInput(socketPath, `${prompt}\r`, { requestId: item.id })
					: { ok: false, error: "No host socket", retryable: true };
				if (sent.ok) {
					completeFollowUp(root, viewId, item.id);
					appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_sent", message: "Queued follow-up sent to live host", details: { kind: item.kind } });
					return { ok: true, sent: true, item };
				}
				releaseFollowUp(root, viewId, item.id);
				appendDiagnostic(root, viewId, { source: "queue", level: "warn", code: "follow_up_send_failed", message: "Queued follow-up could not be delivered to the host", details: { kind: item.kind, error: sent.error ?? "unknown", retryable: sent.retryable !== false } });
				return { ok: true, pending: true, item };
			}
			// Poll-path drain (reconcile): cached probe semantics — success cached for
			// process lifetime, failures retried on a 2s TTL; never force a real
			// pty.spawn on every 700ms cycle when a follow-up keeps failing to start.
			const pty = ptySupport();
			let runId = null;
			let hostMode = "pty";
			if (!pty.ok) hostMode = "json-runner";
			if (pty.ok) {
				const launched = await launchHost(row.meta, prompt);
				if (launched.ok && launched.status !== "started") {
					// An existing claim owns the view; the item stays queued and retries
					// after that host becomes ready (issue #70 prompt-not-lost invariant).
					releaseFollowUp(root, viewId, item.id);
					return { ok: true, pending: true };
				}
				if (!launched.ok) hostMode = "json-runner";
			}
			if (hostMode === "json-runner" && isExternalSession(row.meta)) {
				// Adopted (external) sessions must never continue via the json runner —
				// only a PTY host can resume them safely (pre-existing guard).
				releaseFollowUp(root, viewId, item.id);
				appendDiagnostic(root, viewId, { source: "queue", level: "warn", code: "follow_up_waiting_for_pty", message: "Adopted session follow-up is waiting for PTY support", details: {} });
				return { ok: false, error: "PTY is required to drain adopted session follow-ups safely" };
			}
			if (hostMode === "json-runner") {
				({ runId } = await launchForView(row.meta, prompt, runKindForFollowUp(item)));
			}
			completeFollowUp(root, viewId, item.id, { runId });
			appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_started", message: "Queued follow-up started", details: { kind: item.kind, hostMode } });
			return { ok: true, started: true, item };
		} catch (err) {
			releaseFollowUp(root, viewId, item.id);
			appendDiagnostic(root, viewId, { source: "queue", level: "error", code: "follow_up_drain_failed", message: "Queued follow-up failed to start", details: { error: err instanceof Error ? err.message : String(err) } });
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * Mirror a foreground/hosted session event into the row state. Async since
	 * issue #91: the terminal classification routes through the View State
	 * Coordinator command socket (fire-and-forget callers are fine — the returned
	 * promise resolves after the classification outcome is known).
	 * @param {import("../core/store.mjs").Row} row @param {any} event
	 * @returns {Promise<boolean>} whether a managed row was updated
	 */
	async function syncRowEvent(row, event) {
		const now = Date.now();
		const status = statusFromRow(row);
		let evidence = readEvidence(root, row.meta.id);
		if (!evidence.viewId) evidence = emptyEvidenceSnapshot({ viewId: row.meta.id, source: "hosted" });
		try {
			reduceEvidence(evidence, event, now);
			writeEvidence(root, evidence);
			updateCodeRefsFromEvidence(root, row.meta.id, evidence, row.meta);
		} catch (err) {
			appendDiagnostic(root, row.meta.id, { source: "evidence", level: "warn", code: "evidence_reduce_failed", message: "Could not reduce hosted evidence", details: { error: err instanceof Error ? err.message : String(err) } });
		}

		if (event.type === "input" || event.type === "before_agent_start" || event.type === "agent_start") {
			status.semanticState = "working";
			status.processState = "alive";
			status.currentTool = null;
			status.question = null;
			status.pendingQuestions = [];
			status.error = null;
			status.summary = "Running…";
			status.lastActivityAt = now;
			// Throughput path: periodic self-healing mirror, fire-and-forget.
			void writeForegroundState(row, status);
			return true;
		}

		if (event.type === "agent_end") {
			// #46-class fence (issue #91): a manual completion is a user verdict that
			// outlives the turn. A late/duplicate agent_end after markCompleted must
			// not resurrect the row via finalizeRun + projection — skip all semantic
			// writes (baseline, steering, classification) and keep evidence only.
			// The fence read is repeated after the classification await below; the
			// window between the two reads is covered by the coordinator's own
			// manual_fence rejection plus the guarded tail write.
			if (isManualCompletion(readState(root, row.meta.id))) {
				status.evidenceSummary = summarizeEvidence(evidence);
				writeEvidence(root, evidence);
				return false;
			}
			finalizeRun(status, { exitCode: 0 }, now);
			finalizeEvidence(evidence, status, now);
			const steering = readSteering(root, row.meta.id);
			let classificationQueued = false;
			if (steering.status === "plan_requested" || steering.status === "changes_requested") {
				recordPlanReady(root, row.meta.id, { planText: latestEvidenceText(evidence) || status.latestAssistantPreview || evidence.summary || "Plan ready", runId: status.runId });
				status.semanticState = "needs_input";
				status.question = "Approve this plan?";
				status.summary = "Plan ready for approval";
			} else {
				// Baseline the exited projection BEFORE the classification command:
				// the coordinator's delegated auto-state rules key on processState,
				// and its materialized patch lands after this write and wins. When
				// the coordinator applies, the projection write below is skipped so
				// the stale in-memory fields cannot clobber the patch (#46 class).
				// The legacy coordinator_disabled path applies in-memory instead and
				// still needs the tail projection write (pre-coordinator behavior).
				// Awaited: this ordering IS the fence — the classification command
				// must observe processState "exited" or its delegated rules skip.
				await writeForegroundState(row, status);
				classificationQueued = await queueAutoState(row.meta, status, evidence);
				if (classificationQueued) finalizeEvidence(evidence, status, now);
			}
			status.evidenceSummary = summarizeEvidence(evidence);
			writeEvidence(root, evidence);
			updateCodeRefsFromEvidence(root, row.meta.id, evidence, row.meta);
			// Re-read the fence after the classification await: a completion landing
			// between the baseline write and the coordinator's decision read gets
			// manual_fence back (classificationQueued=false), and writing the stale
			// in-memory projection here would clobber it (#46 class).
			if (!isManualCompletion(readState(root, row.meta.id)) && !(classificationQueued && !coordinatorDisabled())) await writeForegroundState(row, status);
			pruneWarmHosts({ keepViewId: row.meta.id });
			// Async delivery (ack-gated, issue #70 A13): fire-and-forget here — the
			// queue item's own state records the outcome, ordering is preserved by
			// the queue lock, and requestId dedup makes late retries harmless.
			void drainNextFollowUp(row.meta.id);
			return true;
		}

		if (reduceEvent(status, event, now, { interactive: true })) {
			status.processState = "alive";
			// Throughput path: periodic self-healing mirror, fire-and-forget.
			void writeForegroundState(row, status);
			return true;
		}
		return false;
	}

	return {
		root,
		/**
		 * Create a new background session and launch its first run.
		 * Worktree mode is currently disabled, but the dashboard no longer blocks
		 * concurrent same-repo sessions on its own.
		 * @param {string} text
		 * @param {{
		 *   cwd?: string,
		 *   worktree?: boolean,
		 *   writeCapable?: boolean,
		 *   model?: string|null,
		 *   thinkingLevel?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"|null,
		 * }} [dispatchOpts]
		 * @returns {Promise<{ ok: boolean, viewId?: string, error?: string, hostMode?: "pty"|"json-runner", fallbackReason?: string }>}
		 */
		async dispatch(text, dispatchOpts = {}) {
			const prompt = String(text || "").trim();
			if (!prompt) return { ok: false, error: "Empty task" };

			const cwd = dispatchOpts.cwd ?? opts.defaultCwd;
			const writeCapable = dispatchOpts.writeCapable ?? true;
			const defaultModel = dispatchOpts.model ?? null;
			const defaultThinking = dispatchOpts.thinkingLevel ?? null;
			const repoRoot = gitRepoRoot(cwd);

			if (dispatchOpts.worktree) {
				return { ok: false, error: "Worktree mode is currently disabled." };
			}

			const id = newViewId();
			const meta = createView(root, {
				id,
				name: slugifyTask(prompt),
				cwd,
				repoCwd: cwd,
				repoRoot,
				worktreeMode: "off",
				worktreePath: null,
				defaultModel,
				defaultThinking,
				writeCapable,
			});
			const pty = ptySupport({ refresh: true });
			let hostMode = "json-runner";
			let fallbackReason;
			let queued;
			if (pty.ok) {
				const launched = await launchHost(meta, prompt);
				if (launched.ok) {
					hostMode = "pty";
					if (launched.status !== "started") {
						// An existing claim owns the prompt now; keep it durably queued
						// instead of dropping it (issue #70 prompt-not-lost invariant).
						const q = enqueueFollowUp(root, id, prompt, { kind: "reply", delivery: "auto", source: "user" });
						if (!q.ok) return q;
						queued = true;
					}
				} else {
					fallbackReason = launched.fallbackReason ?? launched.error;
					await launchForView(meta, prompt, "dispatch");
				}
			} else {
				fallbackReason = nodePtyFallbackMessage(pty);
				await launchForView(meta, prompt, "dispatch");
			}
			queueGeneratedTitle(meta, prompt);
			return {
				ok: true,
				viewId: id,
				hostMode,
				...(queued ? { queued: true } : {}),
				...(hostMode === "json-runner" ? { fallbackReason } : {}),
			};
		},

		/**
		 * Append a reply to an existing session. Host-path delivery is
		 * ack-gated: the prompt is first persisted as a follow-up item, then
		 * attempted over the control socket; only input_ack completes the item,
		 * anything else leaves it queued for the drain loop (issue #70 A13).
		 * @param {string} viewId
		 * @param {string} text
		 * @returns {Promise<{ ok: boolean, error?: string, queued?: boolean, sent?: boolean, summary?: any, hostMode?: "pty"|"json-runner", fallbackReason?: string }>}
		 */
		async reply(viewId, text, replyOpts = {}) {
			const prompt = String(text || "").trim();
			if (!prompt) return { ok: false, error: "Empty reply" };
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			if (hasPendingQuestions(row)) return { ok: false, error: "Attach to answer the pending question" };
			const delivery = replyOpts.delivery ?? "auto";
			const kind = replyOpts.kind ?? "reply";
			if (delivery === "queue" || (delivery === "auto" && isAgentBusy(row))) {
				const queued = enqueueFollowUp(root, viewId, prompt, { kind, delivery, source: "user" });
				if (queued.ok) appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_queued", message: "Follow-up queued", details: { kind, queuedCount: queued.summary?.queuedCount } });
				return queued.ok ? { ok: true, queued: true, summary: queued.summary } : queued;
			}
			if (row.hostActive) {
				// Durable queue-first delivery: the item id is the requestId, so a
				// lost ack after a child write de-dupes on retry instead of duplicating.
				const queued = enqueueFollowUp(root, viewId, prompt, { kind, delivery: "auto", source: "user" });
				if (!queued.ok) return queued;
				appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_queued", message: "Follow-up queued", details: { kind, queuedCount: queued.summary?.queuedCount } });
				// Legacy host: no instanceId → no input_ack → fire-and-forget (final
				// review finding 1); connect success completes the item.
				if (row.host?.instanceId == null) {
					const sent = sendHostMessage(row, { type: "input", data: `${prompt}\r` });
					if (sent.ok) {
						completeFollowUp(root, viewId, queued.item.id);
						appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_sent", message: "Queued follow-up sent to live host", details: { kind, legacy: true } });
						return { ok: true, sent: true, item: queued.item };
					}
					return { ok: true, queued: true, summary: queued.summary };
				}
				const socketPath = row.host?.socketPath;
				const sent = socketPath
					? await sendHostInput(socketPath, `${prompt}\r`, { requestId: queued.item.id })
					: { ok: false, error: "No host socket", retryable: true };
				if (sent.ok) {
					completeFollowUp(root, viewId, queued.item.id);
					appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_sent", message: "Queued follow-up sent to live host", details: { kind } });
					return { ok: true, sent: true, item: queued.item };
				}
				// Not an error: starting host, busy socket or lost ack — the drain
				// loop retries once the host acks (issue #70 prompt-not-lost).
				return { ok: true, queued: true, summary: queued.summary };
			}
			if (row.alive) return { ok: false, error: "A run is already active for this session" };
			const pty = ptySupport({ refresh: true });
			let hostMode = null;
			let fallbackReason;
			if (pty.ok) {
				const launched = await launchHost(row.meta, prompt);
				if (launched.ok) {
					if (launched.status !== "started") {
						// The existing claim will consume the prompt later — keep it queued
						// instead of dropping it (issue #70 prompt-not-lost invariant).
						const q = enqueueFollowUp(root, viewId, prompt, { kind, delivery: "auto", source: "user" });
						if (q.ok) {
							appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_queued", message: "Follow-up queued", details: { kind, queuedCount: q.summary?.queuedCount } });
							return { ok: true, queued: true, summary: q.summary };
						}
						return q;
					}
					hostMode = "pty";
				} else {
					fallbackReason = launched.fallbackReason ?? launched.error;
				}
			} else {
				fallbackReason = nodePtyFallbackMessage(pty);
			}
			if (!hostMode) {
				if (isExternalSession(row.meta)) return { ok: false, error: "PTY is required to continue an adopted foreground session safely" };
				await launchForView(row.meta, prompt, runKindForKind(kind));
				hostMode = "json-runner";
			}
			return { ok: true, hostMode, ...(hostMode === "json-runner" ? { fallbackReason } : {}) };
		},

		/**
		 * Stop the active run for a view (SIGTERM the runner → it finalizes as `stopped`).
		 * @param {string} viewId
		 * @returns {{ ok: boolean, error?: string }}
		 */
		stop(viewId) {
			const row = loadRow(root, viewId);
			if (row?.hostActive) {
				// Interrupt is turn-abort, not host-stop; an already-stopping host has nothing to abort.
				if (row.host?.state === "stopping") return { ok: true };
				return sendHostMessage(row, { type: "interrupt" });
			}
			const state = readState(root, viewId);
			if (!state?.currentRunId) return { ok: false, error: "No active run" };
			const pid = readPid(root, viewId, state.currentRunId);
			if (!pid) return { ok: false, error: "No runner pid" };
			killProcess(pid);
			return { ok: true };
		},

		/** @param {string} viewId */
		terminateHost(viewId) {
			const row = loadRow(root, viewId);
			if (!row?.host) return { ok: false, error: "No live host" };
			if (row.host.instanceId) return requestHostStop(viewId, row.host.instanceId, "user");
			if (!row.hostAlive) return { ok: false, error: "No live host" };
			return sendHostMessage(row, { type: "terminate" });
		},

		/**
		 * File-based host revoke (issue #70). See the closure doc above; exposed for
		 * the attach resolver and lifecycle callers.
		 * @param {string} viewId @param {string|null} expectedInstanceId @param {string} reason
		 */
		requestHostStop,

		/**
		 * Revoke + wait + replace a broken host (issue #70). Only the attach
		 * resolver / recovery-aware reconcile should call this.
		 * @param {string} viewId @param {string} expectedInstanceId
		 */
		recoverHost,

		/**
		 * The single async attach authority (issue #70 Task 12): real-probes the
		 * current claim, waits out cold starts, adopts abandoned claims, and runs one
		 * bounded recovery per invocation. Concurrent calls for the same view share
		 * one in-flight promise. `attachTarget()` remains a pure sync hint.
		 * @param {string} viewId
		 * @param {{ timeoutMs?: number }} [resolveOpts]
		 * @returns {Promise<{kind:"pty",socketPath:string|null,sessionFile:string,instanceId:string|null}|{kind:"session",sessionFile:string}|{kind:"pending",sessionFile:string,reason:string}|{kind:"missing"}>}
		 */
		async resolveAttachTarget(viewId, resolveOpts = {}) {
			const existing = inflightAttachResolvers.get(viewId);
			if (existing) return existing;
			const run = resolveAttachTargetInner(viewId, resolveOpts.timeoutMs ?? ATTACH_RESOLVE_TIMEOUT_MS)
				.finally(() => { inflightAttachResolvers.delete(viewId); });
			inflightAttachResolvers.set(viewId, run);
			return run;
		},

	/**
	 * Ensure there is an interactive PTY host for this session. Used for fast attach
	 * and dashboard prewarm. Idempotent (issue #70): an existing active claim — even
	 * a fresh `starting` one with no runner pid yet — is surfaced as `pending`, never
	 * replaced or double-spawned; a provably abandoned claim is adopted and spawned
	 * (Task 12) instead of pending forever. Real socket health is the attach
	 * resolver's job; this path never probes, kills, or spawns past an active claim.
	 * @param {string} viewId
	 * @returns {{ ok: boolean, pending?: boolean, started?: boolean, socketPath?: string|null, instanceId?: string|null, error?: string, fallbackReason?: string }}
	 */
	ensureHost(viewId) {
		return ensureHostImpl(viewId);
	},

		/** @param {string} viewId */
		prewarmHost(viewId) {
			const row = loadRow(root, viewId);
			if (!row || isAgentBusy(row)) return { ok: false, error: row ? "Session is busy" : "Unknown session" };
			return this.ensureHost(viewId);
		},

		/** @param {string} viewId */
		attachTarget(viewId) {
			const row = loadRow(root, viewId);
			if (!row) return { kind: "missing" };
			if (row.hostAlive && row.host?.socketPath) {
				return { kind: "pty", socketPath: row.host.socketPath, sessionFile: row.meta.sessionFile };
			}
			return { kind: "session", sessionFile: row.meta.sessionFile };
		},

		async adoptSession(adoptOpts = {}) {
			const sessionFile = String(adoptOpts.sessionFile || "").trim();
			if (!sessionFile) return { ok: false, error: "No session file to adopt" };
			const existing = rowForSession(sessionFile);
			if (existing) {
				existing.meta.archived = false;
				if (adoptOpts.name) existing.meta.name = String(adoptOpts.name).trim() || existing.meta.name;
				writeMeta(root, existing.meta);
				if (!isAgentBusy(existing)) {
					await adoptIdleState(existing.meta.id, readState(root, existing.meta.id) ?? existing.state ?? blankState(existing.meta.id));
				}
				appendDiagnostic(root, existing.meta.id, { source: "service", code: "session_adopted", message: "Existing session adopted into Agent Board", details: { reused: true } });
				return { ok: true, viewId: existing.meta.id, reused: true };
			}
			const cwd = adoptOpts.cwd ?? opts.defaultCwd;
			const id = newViewId();
			const repoRoot = gitRepoRoot(cwd);
			const meta = createView(root, {
				id,
				name: adoptOpts.name ?? "background-session",
				cwd,
				repoCwd: cwd,
				repoRoot,
				worktreeMode: "off",
				worktreePath: null,
				defaultModel: adoptOpts.model ?? null,
				defaultThinking: adoptOpts.thinkingLevel ?? null,
				writeCapable: true,
				sessionFile,
			});
			const state = readState(root, id) ?? blankState(id);
			await adoptIdleState(id, state);
			appendDiagnostic(root, id, { source: "service", code: "session_adopted", message: "Current session adopted into Agent Board", details: { reused: false } });
			return { ok: true, viewId: meta.id, reused: false };
		},

		getRoot() {
			return root;
		},

		getLaunchPrefs() {
			return readLaunchPrefs(root);
		},

		saveLaunchPrefs(prefs) {
			writeLaunchPrefs(root, prefs ?? {});
			return { ok: true };
		},

		/** @param {string} viewId @param {boolean} pinned */
		setPinned(viewId, pinned) {
			const meta = loadRow(root, viewId)?.meta;
			if (!meta) return { ok: false, error: "Unknown session" };
			meta.pinned = pinned;
			writeMeta(root, meta);
			return { ok: true };
		},

		/** @param {string} viewId @param {string} name */
		rename(viewId, name) {
			const clean = String(name || "").trim();
			if (!clean) return { ok: false, error: "Empty name" };
			const meta = loadRow(root, viewId)?.meta;
			if (!meta) return { ok: false, error: "Unknown session" };
			meta.name = clean;
			writeMeta(root, meta);
			return { ok: true };
		},

		/** @param {string} viewId @returns {{ ok: boolean, error?: string }} */
		markVisited(viewId) {
			return markVisited(viewId);
		},

		/**
		 * Explicitly mark an inactive session as done. Successful runs settle as
		 * `idle` until the user reviews and confirms this action from the dashboard.
		 * @param {string} viewId
		 * @returns {Promise<{ ok: boolean, error?: string }>}
		 */
		markCompleted(viewId) {
			return completeView(viewId);
		},

		/**
		 * Bulk mark sessions done, skipping live/already-done rows.
		 * @param {string[]} viewIds
		 * @returns {{ ok: boolean, completed: number, skipped: number, completedIds: string[] }}
		 */
		queueFollowUp(viewId, text, queueOpts = {}) {
			const res = enqueueFollowUp(root, viewId, text, queueOpts);
			if (res.ok) appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_queued", message: "Follow-up queued", details: { kind: queueOpts.kind ?? "reply" } });
			return res;
		},

		clearFollowUps(viewId) {
			const res = clearQueuedFollowUps(root, viewId);
			if (res.ok) appendDiagnostic(root, viewId, { source: "queue", code: "follow_ups_cleared", message: "Queued follow-ups cleared", details: { cancelled: res.cancelled } });
			return res;
		},

		removeLastFollowUp(viewId) {
			const res = removeLastFollowUp(root, viewId);
			if (res.ok) appendDiagnostic(root, viewId, { source: "queue", code: "follow_up_removed", message: "Last queued follow-up removed", details: { itemId: res.item?.id } });
			return res;
		},

		followUps(viewId) {
			const queue = readFollowUpQueue(root, viewId);
			return { queue, summary: summarizeFollowUpQueue(queue) };
		},

		/** Async (ack-gated) since issue #70 A13; see the internal implementation above. @param {string} viewId */
		drainNextFollowUp(viewId) {
			return drainNextFollowUp(viewId);
		},

		async requestPlan(viewId, text = "") {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			requestPlanState(root, viewId, { note: text || null });
			if (isAgentBusy(row)) return this.queueFollowUp(viewId, text, { kind: "plan_request", delivery: "queue", source: "steering" });
			return this.reply(viewId, buildPlanRequestPrompt(text), { delivery: "now", kind: "plan_request" });
		},

		async approvePlan(viewId) {
			const row = loadRow(root, viewId);
			const state = readSteering(root, viewId);
			const approved = approvePlanState(root, viewId);
			if (!approved.ok) return approved;
			if (row && isAgentBusy(row)) return this.queueFollowUp(viewId, "approved", { kind: "plan_approval", delivery: "queue", source: "steering" });
			markExecutingApprovedPlan(root, viewId);
			return this.reply(viewId, buildApprovePlanPrompt(state.planText), { delivery: "now", kind: "plan_approval" });
		},

		async requestPlanChanges(viewId, feedback) {
			const row = loadRow(root, viewId);
			const state = readSteering(root, viewId);
			const changed = requestPlanChangesState(root, viewId, feedback);
			if (!changed.ok) return changed;
			if (row && isAgentBusy(row)) return this.queueFollowUp(viewId, feedback, { kind: "plan_change", delivery: "queue", source: "steering" });
			return this.reply(viewId, buildPlanChangesPrompt(state.planText, feedback), { delivery: "now", kind: "plan_change" });
		},

		steering(viewId) {
			const state = readSteering(root, viewId);
			return { state, summary: summarizeSteering(state) };
		},

		/**
		 * Bulk mark sessions done, skipping live/already-done rows.
		 * @param {string[]} viewIds
		 * @returns {Promise<{ ok: boolean, completed: number, skipped: number, completedIds: string[] }>}
		 */
		async markCompletedMany(viewIds) {
			const ids = [...new Set((viewIds ?? []).filter(Boolean))];
			let completed = 0;
			let skipped = 0;
			const completedIds = [];
			for (const viewId of ids) {
				const row = loadRow(root, viewId);
				if (!row || row.state?.semanticState === "completed") {
					skipped += 1;
					continue;
				}
				const res = await completeView(viewId);
				if (res.ok) {
					completed += 1;
					completedIds.push(viewId);
				} else skipped += 1;
			}
			return { ok: true, completed, skipped, completedIds };
		},

		/**
		 * Soft-delete a row: archive it (removed from the dashboard) but preserve the session
		 * file.
		 * @param {string} viewId
		 */
		archive(viewId) {
			return archiveView(viewId);
		},

		/**
		 * Bulk archive explicit row ids, skipping live/missing rows.
		 * @param {string[]} viewIds
		 * @returns {Promise<{ ok: boolean, archived: number, skipped: number }>}
		 */
		async archiveMany(viewIds) {
			const ids = [...new Set((viewIds ?? []).filter(Boolean))];
			let archived = 0;
			let skipped = 0;
			for (const viewId of ids) {
				const row = loadRow(root, viewId);
				if (!row || isAgentBusy(row)) {
					skipped += 1;
					continue;
				}
				const res = await archiveView(viewId);
				if (res.ok) archived += 1;
				else skipped += 1;
			}
			return { ok: true, archived, skipped };
		},

		/**
		 * Archive every non-live visible row in a semantic state. Live rows are skipped
		 * so bulk cleanup cannot accidentally kill work.
		 * @param {import("../core/types.mjs").SemanticState} state
		 * @returns {{ ok: boolean, archived: number, skipped: number, error?: string }}
		 */
		archiveByState(state) {
			let archived = 0;
			let skipped = 0;
			for (const row of listRows(root)) {
				if (row.state?.semanticState !== state) continue;
				if (isAgentBusy(row)) {
					skipped += 1;
					continue;
				}
				if (row.host?.instanceId) stopHostRow(row, "archive");
				else if (row.hostAlive) sendHostMessage(row, { type: "terminate" });
				row.meta.archived = true;
				writeMeta(root, row.meta);
				archived += 1;
			}
			return { ok: true, archived, skipped };
		},

		/**
		 * Recovery: reconcile rows whose runner died without finalizing (e.g. machine crash
		 * or the runner was killed). If a terminal status exists, project it; otherwise mark
		 * the row failed/stale. Safe to call on every dashboard open and on session_start.
		 * @returns {Promise<number>} number of rows reconciled.
		 */
		async reconcile() {
			const now = Date.now();
			let fixed = 0;
			for (const row of listRows(root)) {
				const s = row.state;
				const looksActive = s?.processState === "alive" || s?.semanticState === "queued" || s?.semanticState === "working";
				if (!s || !looksActive) continue;
				if (!s.currentRunId) {
				if (row.host && !row.hostAlive && (row.host.state === "starting" || row.host.state === "alive" || row.host.state === "exited" || row.host.state === "failed")) {
					// A starting claim inside the launch grace is a normal cold start (issue #70):
					// its runner pid may legitimately be absent — never finalize it to failed yet.
					if (row.host.state === "starting" && now - (row.host.claimAt ?? row.host.startedAt ?? 0) < HOST_START_GRACE_MS) continue;
						const failed = row.host.state === "starting" || row.host.state === "alive" || row.host.state === "failed" || Boolean(row.host.error) || (row.host.exitCode !== null && row.host.exitCode !== 0);
						// F6: failed verdicts must carry a reason (legacy guaranteed an
						// error string). The row has no currentRunId here, so only the
						// state half participates (no status.json to sync).
						const result = await sendLifecycleCommand({
							type: "state_command",
							viewId: row.meta.id,
							runId: null,
							source: "service",
							kind: "reconcile_finalize",
							expectedRevision: null,
							payload: {
								semanticState: failed ? "failed" : "idle",
								summary: failed ? "Failed (PTY host exited)" : "Needs instructions",
								reason: failed ? (s.error ?? row.host.error ?? "PTY host exited unexpectedly") : null,
							},
						}, row.meta.id);
						if (result.status !== "applied") {
							if (result.reason === "coordinator_disabled") {
								s.semanticState = failed ? "failed" : "idle";
								s.processState = "exited";
								s.hasError = failed;
								s.needsInput = false;
								s.question = null;
								s.pendingQuestions = [];
								s.error = failed ? (s.error ?? row.host.error ?? "PTY host exited unexpectedly") : null;
								s.summary = failed ? "Failed (PTY host exited)" : "Needs instructions";
								s.updatedAt = now;
								writeState(root, s);
							} else continue; // rejected/ambiguous: nothing mutated, not fixed
						}
						appendDiagnostic(root, row.meta.id, { source: "service", level: failed ? "error" : "info", code: "host_reconciled", message: failed ? "PTY host exited before final event" : "PTY host finalized without final event", details: { hostState: row.host.state, exitCode: row.host.exitCode } });
						fixed += 1;
					}
					continue;
				}
				if (row.alive) continue;
				const status = readStatus(root, row.meta.id, s.currentRunId);
				if (statusRevisionDesynced(s, status)) {
					// Half-materialized pair (a coordinator crashed between its paired
					// writes): don't combine the mismatched halves into one decision —
					// record it and kick a coordinator so boot replay repairs the pair.
					// The row is skipped this pass (not fixed); the next pass sees the
					// repaired stamps and proceeds normally.
					appendDiagnostic(root, row.meta.id, { source: "service", level: "warn", code: "state_status_revision_desync", message: "state.json and status.json revisions disagree; skipping reconcile projection and requesting coordinator repair", details: { stateRevision: s.materializedRevision, statusRevision: status.materializedRevision, runId: s.currentRunId } });
					void ensureCoordinator(root).catch(() => {});
					continue;
				}
				if (status?.endedAt) {
					// The run's terminal status exists but the row was never materialized
					// from it (crash between the two writes, or a pre-coordinator row).
					// Project mode lets the status's own verdict govern (completed rows
					// must not be forced to failed/idle).
					const result = await sendLifecycleCommand({
						type: "state_command",
						viewId: row.meta.id,
						runId: s.currentRunId,
						source: "service",
						kind: "reconcile_finalize",
						expectedRevision: null,
						payload: { project: true },
					}, row.meta.id);
					if (result.status !== "applied" && result.reason !== "coordinator_disabled") {
						// Fix round 2 (F5 leftover): a rejected/ambiguous project-mode
						// row (manual fence, no_change, stale_run, timeout) mutated
						// nothing — it must not count toward the fixed tally.
						continue;
					}
					if (result.reason === "coordinator_disabled") writeState(root, projectViewState(status, now, readState(root, row.meta.id) ?? row.state ?? null));
				} else {
					const result = await sendLifecycleCommand({
						type: "state_command",
						viewId: row.meta.id,
						runId: s.currentRunId,
						source: "service",
						kind: "reconcile_finalize",
						expectedRevision: null,
						payload: {
							semanticState: "failed",
							summary: "Failed (runner exited)",
							reason: s.error ?? "Runner exited unexpectedly",
						},
					}, row.meta.id);
					if (result.status !== "applied") {
						if (result.reason === "coordinator_disabled") {
							s.semanticState = "failed";
							s.processState = "exited";
							s.hasError = true;
							s.needsInput = false;
							s.error = s.error ?? "Runner exited unexpectedly";
							s.summary = "Failed (runner exited)";
							s.updatedAt = now;
							writeState(root, s);
						} else continue;
					}
				}
				fixed += 1;
			}
			for (const row of listRows(root)) {
				if ((row.state?.followUps?.queuedCount ?? 0) > 0 && canAutoDrain(row)) {
					// Delivery is ack-gated and async now (issue #70 A13); the queue
					// item state, not this counter, records the outcome.
					void drainNextFollowUp(row.meta.id);
					fixed += 1;
				}
			}
			return fixed;
		},

		/**
		 * Mirror lifecycle/events from a managed session that is currently attached in
		 * the foreground. Without this, a row that was completed/needs_input can keep
		 * looking stale after the user types a follow-up in the real Pi session.
		 * @param {string|undefined} sessionFile
		 * @param {any} event
		 * @returns {Promise<boolean>} whether a managed row was updated
		 */
		syncForegroundEvent(sessionFile, event) {
			if (!sessionFile || !event?.type) return Promise.resolve(false);
			const row = rowForSession(sessionFile);
			if (!row) return Promise.resolve(false);
			return syncRowEvent(row, event);
		},

		/** @param {string|undefined} viewId @param {any} event */
		syncHostedEvent(viewId, event) {
			if (!viewId || !event?.type) return Promise.resolve(false);
			const row = loadRow(root, viewId);
			if (!row) return Promise.resolve(false);
			return syncRowEvent(row, event);
		},

		/** @returns {import("../core/store.mjs").Row[]} all visible rows. */
		rows() {
			return listRows(root);
		},

		/**
		 * Live node-pty / PTY host health snapshot for dashboard chrome.
		 * - `ok` reflects whether this process can currently launch PTY hosts.
		 * - `staleHosts` counts rows whose last persisted host claimed `alive` but the
		 *   runner pid is gone, which often explains attach prompts / degraded UX.
		 */
		ptyHealth() {
			const support = ptySupport();
			const rows = listRows(root);
			const staleHosts = rows.filter((row) => row.host?.state === "alive" && !row.hostAlive).length;
			const liveHosts = rows.filter((row) => row.hostAlive).length;
			const stalled = rows.filter((row) => row.state?.diagnostics?.stalled).length;
			const diagnosticErrors = rows.reduce((sum, row) => sum + (row.state?.diagnostics?.errorCount ?? 0), 0);
			return {
				ok: Boolean(support.ok),
				reason: support.ok ? null : support.reason ?? "PTY unavailable",
				issue: support.ok ? null : (support.issue ?? diagnoseNodePtyFailure(support.reason ?? null)),
				staleHosts,
				liveHosts,
				stalled,
				diagnosticErrors,
			};
		},

		evidence(viewId) {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			return {
				ok: true,
				evidence: readEvidence(root, viewId),
				paths: {
					evidence: P.evidencePath(root, viewId),
					diagnostics: P.diagnosticsPath(root, viewId),
					session: row.meta.sessionFile,
					screenLog: P.screenLogPath(root, viewId),
				},
			};
		},

		diagnostics(viewId, diagOpts = {}) {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			return { ok: true, events: tailDiagnostics(root, viewId, { limit: diagOpts.limit ?? 50 }) };
		},

		clearDiagnostics(viewId) {
			const row = loadRow(root, viewId);
			if (!row) return { ok: false, error: "Unknown session" };
			return clearDiagnostics(root, viewId);
		},

		/** @param {string} viewId @returns {import("../core/store.mjs").Row|null} */
		row(viewId) {
			return loadRow(root, viewId);
		},

		/**
		 * Evict idle warm PTY hosts (TTL / warm-pool cap). Safe to call anytime:
		 * busy and attached hosts are never touched.
		 * @param {{ keepViewId?: string|null }} [pruneOpts]
		 */
		pruneWarmHosts(pruneOpts = {}) {
			// Delegates to the createService-closure pruneWarmHosts (same name; NOT recursive).
			pruneWarmHosts(pruneOpts);
		},
	};
}

/** @param {import("../core/types.mjs").ViewMeta} meta */
function isExternalSession(meta) {
	const normalized = resolve(meta.sessionFile).replace(/\\/g, "/");
	return !normalized.endsWith(`/sessions/${meta.id}.jsonl`);
}

/** @param {import("../core/types.mjs").EvidenceSnapshot} evidence */
function latestEvidenceText(evidence) {
	return evidence.assistantEvidence?.[evidence.assistantEvidence.length - 1]?.text ?? "";
}

/** @param {import("../core/store.mjs").Row} row */
function canAutoDrain(row) {
	const st = row.state?.semanticState;
	return !isAgentBusy(row) && (st === "idle" || st === "completed");
}

/** @param {import("../core/types.mjs").ViewState} state */
function completionSummary(state) {
	if (!isGenericStatusText(state.summary)) return compactSummary(state.summary);
	return "Done";
}

/** @param {string} text */
function compactSummary(text) {
	const cleaned = String(text || "").replace(/\s+/g, " ").trim();
	if (!cleaned) return "Done";
	const first = firstSentence(cleaned);
	return truncate(first.length >= 12 ? first : cleaned, 80);
}

/** POSIX process start token — /proc/<pid>/stat field 22 (starttime). Mirrors the
 *  runner's captureStartToken (issue #70) so both sides publish comparable
 *  identities; null on failure or non-Linux platforms. Task 11 may promote this
 *  to a shared module when identity-aware observation lands. */
function readProcStartToken(pid) {
	if (process.platform !== "linux" || !pid) return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm (field 2) may contain spaces and parens — fields resume AFTER the
		// last ')'. fields[0] is state (field 3) → starttime (field 22) is [19].
		const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trimStart();
		return afterComm.split(/\s+/)[19] ?? null;
	} catch {
		return null;
	}
}

/** Launch-time identity this service process stamps on leases and claims. */
function serviceIdentity() {
	return { pid: process.pid, startToken: readProcStartToken(process.pid) };
}

/**
 * Finalize a provably-dead legacy host as `exited` so the resolver loop's next
 * iteration sees hostActive=false and claims a fresh new-protocol host
 * (issue #87). The gate is `canFinalizeLegacyHost` — anything unverifiable
 * stays pending (spec §10.1 conservatism). The write itself is serialized
 * under the host-start lease (same gate as recoverHost/claim) with a
 * live-record re-check: a concurrent resolver may have already finalized and
 * claimed a new-protocol host, and a stale `alive` snapshot must never clobber
 * that replacement's record (issue #87 CR r1).
 * @param {string} root
 * @param {string} viewId
 * @param {import("../core/types.mjs").HostStatus} host
 * @param {string} probeClassification
 * @param {number} now
 * @param {(r: string, v: string, name: string, o?: object) => ({ acquired: true, lease: { release: () => void } } | { acquired: false, reason: string })} acquireHostStartLock
 * @returns {boolean} true when finalized (caller should `continue` the loop).
 */
function finalizeDeadLegacyHost(root, viewId, host, probeClassification, now, acquireHostStartLock) {
	// Same pid fallback as loadRow: legacy records carry no runnerPid property —
	// the pid lives only in the host-pid.json mirror.
	const hostPid = Object.hasOwn(host, "runnerPid") ? host.runnerPid : readHostPid(root, viewId);
	if (!canFinalizeLegacyHost({ host, hostPid, hostPidAlive: isAlive(hostPid), probeClassification })) return false;
	// Serialize with claims: only write while the live record still matches our
	// (possibly stale) snapshot.
	const gate = acquireHostStartLock(root, viewId, "host-start", { identity: serviceIdentity() });
	if (!gate.acquired) return false; // busy — record left untouched; caller pends/waits this attempt, a later one finalizes
	try {
		const cur = readHost(root, viewId);
		if (!cur || cur.instanceId != null) return false; // already claimed by a new-protocol host
		if (cur.state !== "starting" && cur.state !== "alive") return false; // already finalized
		if (cur.socketPath !== host.socketPath || cur.state !== host.state) return false; // snapshot drifted
		const finalizedAt = now;
		writeHost(root, { ...cur, state: "exited", endedAt: finalizedAt, lastSeenAt: finalizedAt, error: "legacy host finalized: runner pid dead" });
	} finally {
		try { gate.lease.release(); } catch { /* best effort */ }
	}
	try {
		appendDiagnostic(root, viewId, {
			source: "service",
			level: "info",
			code: "legacy_host_finalized",
			message: `Finalized stale legacy host (pid ${hostPid} dead, probe ${probeClassification}) — next attach claims a fresh host`,
			details: { hostPid, probeClassification, previousState: host.state },
		});
	} catch { /* best effort */ }
	return true;
}

/** Conservative pre-identity observation (issue #70 Task 10): a recorded pid that
 *  is still alive is always `unknown` — never safe to release; not recorded or
 *  provably gone is `dead`. Task 11 replaces this with identity-aware observation. */
function conservativeObservation(pid) {
	if (pid == null) return "dead";
	return isAlive(pid) ? "unknown" : "dead";
}

/** Identity-aware process observation (issue #70): a live pid whose /proc start
 *  token matches the recorded identity is `owned` (safe to signal); a mismatch is
 *  `foreign` (pid reused — the original is gone); alive-but-unverifiable is
 *  `unknown` (recovery must stay pending, never signal). */
function defaultObserveProcess(identity) {
	if (!identity || identity.pid == null) return "unknown";
	if (!isAlive(identity.pid)) return "dead";
	const token = readProcStartToken(identity.pid);
	if (identity.startToken == null || token == null) return "unknown";
	return token === identity.startToken ? "owned" : "foreign";
}

/** Signal an identity previously observed as "owned". ESRCH is tolerated (the
 *  process may exit between observation and signal); anything else rethrows. */
function defaultSignalOwnedProcess(identity, signal) {
	try {
		process.kill(identity.pid, signal);
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ESRCH") throw err;
	}
}

/** @param {import("../core/types.mjs").HostStatus|null} host */
function observeHostForReplace(host) {
	return {
		host,
		runnerObservation: conservativeObservation(host?.runnerPid ?? null),
		childObservation: conservativeObservation(host?.childPid ?? null),
		launchLeaseActive: false,
	};
}

/**
 * Send a one-shot JSONL command to a live host socket.
 * @param {import("../core/store.mjs").Row} row
 * @param {Record<string, unknown>} message
 * @returns {{ ok: boolean, error?: string }}
 */
function sendHostMessage(row, message) {
	const socketPath = row.host?.socketPath;
	if (!socketPath) return { ok: false, error: "No host socket" };
	// On Windows the control socket is a named pipe, which never exists as a
	// filesystem entry, so existsSync can't be used as a readiness probe there.
	// A missing pipe surfaces as a connection error on the socket below.
	if (process.platform !== "win32" && !existsSync(socketPath)) return { ok: false, error: "Host socket is not ready" };
	try {
		const socket = createConnection(socketPath);
		socket.on("connect", () => {
			socket.write(JSON.stringify(message) + "\n");
			socket.end();
		});
		socket.on("error", () => {});
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Default window service waits for the runner's input_ack before treating a
 * host input as undelivered (issue #70 A13).
 */
const HOST_INPUT_ACK_TIMEOUT_MS = 2_000;

/**
 * Send one input line to a host control socket and wait for the runner's
 * input_ack (issue #70 A13). Fire-and-forget "connected" no longer counts as
 * delivered: only `{type:"input_ack", requestId}` does.
 *
 * Delivery contract is durable at-least-once, coordinated through the queue
 * item id used as requestId:
 * - If an ack is lost AFTER the runner wrote the child, a re-send with the
 *   same requestId hits the runner's dedup table and re-acks without a second
 *   child write.
 * - If the host instance restarted, the new instance never saw the requestId
 *   and writes the prompt once.
 * Legacy (pre-instanceId) runners ignore requestId and never ack: this helper
 * then times out and reports a retryable failure, leaving the prompt queued —
 * legacy hosts are attach-only by spec, so queued prompts surface on attach.
 * Never rejects: every failure resolves `{ok:false, error, retryable:true}`.
 * @param {string} socketPath
 * @param {string} text
 * @param {{ requestId?: string|null, timeoutMs?: number, connect?: (path: string) => import("node:net").Socket }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, retryable?: boolean }>}
 */
export function sendHostInput(socketPath, text, opts = {}) {
	const requestId = opts.requestId ?? null;
	const timeoutMs = opts.timeoutMs ?? HOST_INPUT_ACK_TIMEOUT_MS;
	const connect = opts.connect ?? createConnection;
	return new Promise((resolve) => {
		let settled = false;
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
		const timer = setTimeout(() => finish({ ok: false, error: "timeout", retryable: true }), timeoutMs);
		timer.unref?.();
		try {
			socket = connect(socketPath);
		} catch (err) {
			finish({ ok: false, error: err instanceof Error ? err.message : String(err), retryable: true });
			return;
		}
		socket.on("connect", () => {
			try {
				socket.write(JSON.stringify({ type: "input", requestId, data: text }) + "\n");
			} catch (err) {
				finish({ ok: false, error: err instanceof Error ? err.message : String(err), retryable: true });
			}
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let msg;
				try { msg = JSON.parse(line); } catch { continue; }
				if (msg?.type === "input_ack" && (requestId == null || msg.requestId === requestId)) {
					finish({ ok: true });
					return;
				}
				if (msg?.type === "error") {
					// e.g. {type:"error", code:"host_starting", requestId} while the child boots.
					finish({ ok: false, error: msg.code ?? msg.message ?? "host_error", retryable: true });
					return;
				}
				// hello/status/output lines are ignored — keep waiting for the ack.
			}
		});
		socket.on("error", (err) => {
			const code = /** @type {NodeJS.ErrnoException} */ (err).code;
			finish({ ok: false, error: code ?? (err instanceof Error ? err.message : String(err)), retryable: true });
		});
		socket.on("close", () => finish({ ok: false, error: "socket_closed", retryable: true }));
	});
}

let cachedPtySupport;
const requireForPty = createRequire(import.meta.url);
const PTY_SUPPORT_ERROR_TTL_MS = 2_000;

function ptyHostAvailability(opts = {}) {
	if (process.env.AGENT_BOARD_DISABLE_PTY === "1" || process.env.AGENT_VIEW_DISABLE_PTY === "1") {
		return { ok: false, reason: "AGENT_BOARD_DISABLE_PTY=1", issue: diagnoseNodePtyFailure("AGENT_BOARD_DISABLE_PTY=1") };
	}
	if (process.env.AGENT_BOARD_FORCE_PTY === "1" || process.env.AGENT_VIEW_FORCE_PTY === "1") return { ok: true };
	return ptySpawnSupported(opts);
}

export function envInt(name, fallback, min, max, legacyName) {
	const raw = process.env[name] ?? (legacyName ? process.env[legacyName] : undefined);
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

export function shouldProbePtySupport(cached, opts = {}, now = Date.now()) {
	if (!cached) return true;
	if (cached.ok) return false;
	if (opts.refresh) return true;
	const ttlMs = opts.maxAgeMs ?? PTY_SUPPORT_ERROR_TTL_MS;
	return now - (cached.checkedAt ?? 0) >= ttlMs;
}

function ptySpawnSupported(opts = {}) {
	const now = Date.now();
	if (!shouldProbePtySupport(cachedPtySupport, opts, now)) return cachedPtySupport;
	try {
		ensureNodePtySpawnHelperExecutable(requireForPty);
		const pty = requireForPty("node-pty");
		const proc = pty.spawn(process.execPath, ["-e", "process.exit(0)"], {
			name: "xterm-256color",
			cols: 20,
			rows: 5,
			cwd: process.cwd(),
			env: process.env,
		});
		proc.kill?.();
		cachedPtySupport = { ok: true, checkedAt: now };
	} catch (err) {
		cachedPtySupport = { ok: false, reason: err instanceof Error ? err.message : String(err), checkedAt: now };
		cachedPtySupport.issue = diagnoseNodePtyFailure(cachedPtySupport.reason, { probe: probeNodePtyEnvironment(requireForPty) });
	}
	return cachedPtySupport;
}

