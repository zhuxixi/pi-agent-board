#!/usr/bin/env node
/**
 * Detached job-runner shim (plain ESM — must not depend on Pi's jiti loader).
 *
 * Usage: node job-runner.mjs <configPath>
 *
 * Owns one run: spawns a headless Pi worker (`pi --mode json -p --session <file> <prompt>`),
 * streams its JSON events into events.jsonl, and routes every semantic-state
 * mutation through the View State Coordinator as commands (issue #91): boot
 * run_started, transient run_progress beats on the throttled hot path,
 * auto-state classifications, run_finalized on exit, and the post-exit
 * patch_fields (evidence mirrors / model summary). Evidence artifacts
 * (events/stdout/stderr logs, evidence files, code-refs) stay runner-owned and
 * are written directly. Survives the parent Pi process exiting/reloading.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendLine, readJson } from "../src/core/atomic.mjs";
import { createRunStatus, finalizeRun, reduceEvent } from "../src/core/events.mjs";
import { encodePromptForCliArg } from "../src/core/prompt-transport.mjs";
import { applyAutoStateToStatus, autoStateEnabled, autoStateFromModelOrHeuristic, autoStateModel, buildAutoStatePrompt, heuristicAutoState, isManualCompletion } from "../src/core/auto-state.mjs";
import { appendDiagnostic } from "../src/core/diagnostics.mjs";
import { emptyEvidenceSnapshot, finalizeEvidence, reduceEvidence, summarizeEvidence, writeEvidence, writeRunEvidence } from "../src/core/evidence.mjs";
import { updateCodeRefsFromEvidence } from "../src/core/code-refs-store.mjs";
import { claimNextFollowUp, completeFollowUp, releaseFollowUp } from "../src/core/follow-up-queue.mjs";
import { newRunId } from "../src/core/ids.mjs";
import { launchRun } from "../src/core/launch.mjs";
import * as P from "../src/core/paths.mjs";
import { readState, readStatus, readMeta } from "../src/core/store.mjs";
import { readSteering, recordPlanReady } from "../src/core/steering.mjs";
import { sendStateCommand, coordinatorDisabled } from "../src/core/coordinator-client.mjs";
import { commandRejectDiagnostic } from "../src/core/state-commands.mjs";
import { legacyFollowupBootstrap, legacyPersistState, legacyPlanReadyStateWrite, legacyWriteState, legacyWriteStatus } from "./job-runner-legacy.mjs";
import { buildApprovePlanPrompt, buildPlanChangesPrompt, buildPlanRequestPrompt } from "../src/core/steering-prompts.mjs";

const WRITE_THROTTLE_MS = 250;

/** @param {string[]} args */
function redactWorkerArgs(args) {
	return args.map((arg, idx) => {
		const prev = args[idx - 1];
		if (["--api-key", "--token", "--password", "--secret"].includes(prev)) return "[redacted]";
		if (/^(sk-|gho_|ghp_)/.test(arg)) return "[redacted]";
		return arg;
	});
}

function main() {
	const configPath = process.argv[2];
	if (!configPath) {
		process.stderr.write("job-runner: missing config path\n");
		process.exit(2);
	}
	/** @type {import("../src/core/types.mjs").RunConfig|null} */
	const config = readJson(configPath, null);
	if (!config) {
		process.stderr.write(`job-runner: cannot read config ${configPath}\n`);
		process.exit(2);
	}

	const { root, viewId, runId } = config;
	const stdoutLog = P.stdoutPath(root, viewId, runId);
	const stderrLog = P.stderrPath(root, viewId, runId);
	const eventsLog = P.eventsPath(root, viewId, runId);

	// Read the view meta once so code-ref extraction reuses it across every evidence write.
	const meta = readMeta(root, viewId);

	let status = createRunStatus(config, null, Date.now());
	// The run starts working the moment the runner is up; seeding the boot status
	// with "working" (instead of createRunStatus's "queued") avoids the stale
	// queued frame flickering through run_started's first materialization.
	status.semanticState = "working";
	let evidence = emptyEvidenceSnapshot({ viewId, runId, source: "json-runner" });
	appendDiagnostic(root, viewId, { source: "runner", runId, code: "runner_start", message: "Runner started", details: { kind: config.kind, cwd: config.cwd, model: config.model } });
	writeRunEvidence(root, evidence);
	writeEvidence(root, evidence);
	updateCodeRefsFromEvidence(root, viewId, evidence, meta);
	if (coordinatorDisabled()) {
		legacyPersistState({ root, viewId, runId, status });
	}
	return bootstrapRun({ root, viewId, runId, config, status, meta, evidence, stdoutLog, stderrLog, eventsLog });
}

/**
 * Async continuation of main: route the run_started bootstrap through the
 * coordinator (the status file it creates is what every later run_progress
 * beat patches onto), then spawn the worker and wire the event handlers.
 * @param {{ root: string, viewId: string, runId: string, config: object, status: object, meta: object, evidence: object, stdoutLog: string, stderrLog: string, eventsLog: string }} ctx
 */
async function bootstrapRun({ root, viewId, runId, config, status, meta, evidence, stdoutLog, stderrLog, eventsLog }) {
	if (!coordinatorDisabled()) {
		// Journaled bootstrap: creates the run's status.json (STATUS_BOOTSTRAP_KINDS)
		// and pins the row to working/alive/currentRunId. Ambiguous outcomes never
																				  // block the run: if the command was journaled, coordinator replay recovers
		// it; otherwise dashboard reconcile converges the row.
		const started = await sendStateCommand(root, {
			type: "state_command",
			viewId,
			runId,
			source: "job-runner",
			kind: "run_started",
			expectedRevision: null,
			payload: { status: { ...status } },
		});
		if (started.status !== "applied" && started.reason !== "coordinator_disabled") {
			appendDiagnostic(root, viewId, { source: "runner", runId, ...commandRejectDiagnostic("run_started", "Run bootstrap", started.reason, "otherwise dashboard reconcile will converge the row"), details: { reason: started.reason } });
		}
	}

	/**
	 * One transient progress beat: ship the full in-memory status as a sparse
	 * patch — the coordinator merges it onto the materialized status and lets
	 * projectViewState recompute the row state (delegation, not copied rules).
	 *
	 * Fire-and-forget by design (the ONLY such command in the runner): the hot
	 * path is a periodic self-healing snapshot (~4/sec), a lost beat is
	 * superseded by the next one, and failures are silently ignored — logging
	 * them would spam diagnostics at beat frequency. Transient commands are
	 * never journaled, so an ambiguous outcome has no replay to await.
	 */
	const sendProgressBeat = () => {
		const { materializedRevision: _fileStamp, ...patch } = status;
		void sendStateCommand(root, {
			type: "state_command",
			viewId,
			runId,
			source: "job-runner",
			kind: "run_progress",
			expectedRevision: null,
			payload: { statusPatch: patch },
		}).catch(() => {});
	};

	// Build worker args: pi --mode json -p --session <file> [--model m] [--thinking l] [--tools t] <prompt>
	const args = [
		...config.piArgsPrefix,
		"--mode",
		"json",
		"-p",
		"--session",
		config.sessionFile,
	];
	if (config.model) args.push("--model", config.model);
	if (config.thinkingLevel) args.push("--thinking", config.thinkingLevel);
	if (config.tools) args.push("--tools", config.tools);
	args.push(encodePromptForCliArg(config.prompt));

	appendDiagnostic(root, viewId, { source: "runner", runId, code: "worker_spawn", message: "Worker spawned", details: { command: config.piCommand, args: redactWorkerArgs(args) } });
	const worker = spawn(config.piCommand, args, {
		cwd: config.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		env: { ...process.env, AGENT_BOARD_NO_SWEEP: "1" },
	});

	status.pid = worker.pid ?? null;
	appendDiagnostic(root, viewId, { source: "runner", runId, code: "worker_pid", message: "Worker pid recorded", details: { pid: status.pid } });
	// The pid lands on disk via a transient progress beat (the worker's first
	// events would carry it too, but a silent worker must still be observable).
	sendProgressBeat();

	let stoppedByUser = false;
	let dirty = false;
	let flushTimer = null;

	const persist = (force = false) => {
		void force;
		status.evidenceSummary = summarizeEvidence(evidence);
		persistEvidenceArtifacts();
		if (coordinatorDisabled()) legacyPersistState({ root, viewId, runId, status });
		else sendProgressBeat();
		// Best-effort code-refs extraction shells out to git and can take hundreds of
		// ms; it only depends on evidence + git, never on state.json.
		updateCodeRefsFromEvidence(root, viewId, evidence, meta);
		dirty = false;
	};

	/**
	 * Persist only if the user hasn't marked the row done manually since the last
	 * persist. projectViewState() overwrites the row state unconditionally, so a
	 * post-exit model pass must never persist its stale in-memory status over a
	 * fresh manual completion.
	 */
	const persistUnlessManual = (force = false) => {
		const latestView = readState(root, viewId);
		if (isManualCompletion(latestView)) return false;
		persist(force);
		return true;
	};

	/**
	 * Runner-owned evidence artifacts (evidence files + code-refs). Written
	 * directly — the coordinator owns state.json/status.json, not these.
	 */
	const persistEvidenceArtifacts = () => {
		status.evidenceSummary = summarizeEvidence(evidence);
		writeRunEvidence(root, evidence);
		writeEvidence(root, evidence);
		updateCodeRefsFromEvidence(root, viewId, evidence, meta);
	};

	/**
	 * Refresh the evidence mirrors (status.evidenceSummary / state.review)
	 * through the coordinator: `patch_fields` carries only whitelisted mirror
	 * fields, and the coordinator's generic manual fence (source != user on a
	 * manually-completed row) is the authoritative guard — the old fresh-read
	 * + isManualCompletion pre-checks are no longer needed. Designed fences
	 * (manual_fence / no_change) are informational; ambiguous outcomes never
	 * fall back to a direct write.
	 */
	const refreshEvidenceMirrors = async () => {
		status.evidenceSummary = summarizeEvidence(evidence);
		const result = await sendStateCommand(root, {
			type: "state_command",
			viewId,
			runId: null,
			source: "job-runner",
			kind: "patch_fields",
			expectedRevision: null,
			payload: {
				state: { review: status.evidenceSummary },
				status: { evidenceSummary: status.evidenceSummary },
			},
		});
		if (result.status === "applied") {
			const fresh = readStatus(root, viewId, runId);
			if (fresh) Object.assign(status, fresh);
			return true;
		}
		if (result.reason === "manual_fence" || result.reason === "no_change") return false;
		if (result.reason === "coordinator_disabled") {
			// Legacy escape hatch: fresh-read + fence, pre-coordinator semantics.
			const freshStatus = readStatus(root, viewId, runId);
			if (freshStatus && !isManualCompletion(freshStatus)) {
				freshStatus.evidenceSummary = status.evidenceSummary;
				legacyWriteStatus(root, viewId, runId, freshStatus);
			}
			const freshState = readState(root, viewId);
			if (freshState && !isManualCompletion(freshState)) {
				freshState.review = status.evidenceSummary;
				legacyWriteState(root, viewId, freshState);
			}
			return true;
		}
		appendDiagnostic(root, viewId, { source: "runner", runId, ...commandRejectDiagnostic("evidence_mirror", "Evidence mirror", result.reason, "otherwise the next mirror refresh will converge"), details: { reason: result.reason } });
		return false;
	};

	/**
	 * Materialize the run's terminal state through the View State Coordinator
	 * (issue #91, A8 path 3): the runner submits minimal facts and the
	 * coordinator computes terminal semantics via finalizeRun, so a manual
	 * completion landing before the command is fenced by the coordinator
	 * (manual_fence), not by a file re-read (#46 class). Evidence artifacts stay
	 * direct (runner-owned). Ambiguous outcomes (timeout / connection_reset)
	 * NEVER fall back to a direct write: the command may already be journaled,
	 * and the coordinator's boot replay is the recovery path.
	 * coordinator_disabled keeps the pre-coordinator direct persist.
	 * @param {{ exitCode: number|null, stoppedByUser: boolean }} facts
	 * @returns {Promise<boolean>} whether the final state is known materialized
	 */
	const finalizeThroughCoordinator = async ({ exitCode, stoppedByUser: stopped }) => {
		const payload = { exitCode, stoppedByUser: stopped };
		if (status.endedAt != null) payload.endedAt = status.endedAt;
		// The close path cancels the pending throttled flush after the final
		// buffer flush, so a stopReason observed in the last burst (reduceEvent
		// sets it in memory only) never reached disk. Overlay it onto the payload:
		// finalizeSemanticState keys on stopReason alone for exit-0 exits, and the
		// coordinator already supports the payload overlay (issue #91).
		if (status.stopReason != null) payload.stopReason = status.stopReason;
		if (status.latestAssistantPreview) payload.latestAssistantPreview = status.latestAssistantPreview;
		if (status.lastAgentActivityAt != null) payload.lastAgentActivityAt = status.lastAgentActivityAt;
		const result = await sendStateCommand(root, {
			type: "state_command",
			viewId,
			runId,
			source: "job-runner",
			kind: "run_finalized",
			expectedRevision: null,
			payload,
		});
		if (result.status === "applied") {
			const fresh = readStatus(root, viewId, runId);
			if (fresh) Object.assign(status, fresh);
			await refreshEvidenceMirrors();
			return true;
		}
		if (result.reason === "coordinator_disabled") {
			persistEvidenceArtifacts();
			legacyPersistState({ root, viewId, runId, status });
			return true;
		}
		if (result.reason === "stale_run") {
			// Duplicate finalize or the run was already superseded — nothing to do.
			return false;
		}
		appendDiagnostic(root, viewId, { source: "runner", runId, ...commandRejectDiagnostic("run_finalize", "Run finalization", result.reason, "otherwise dashboard reconcile will converge the row"), details: { reason: result.reason } });
		return false;
	};

	const scheduleFlush = () => {
		if (flushTimer) {
			dirty = true;
			return;
		}
		persist();
		flushTimer = setTimeout(() => {
			flushTimer = null;
			if (dirty) scheduleFlush();
		}, WRITE_THROTTLE_MS);
	};

	// ---- stdout: JSON event stream -----------------------------------------
	let buffer = "";
	const onLine = (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		appendLine(eventsLog, trimmed);
		let event;
		try {
			event = JSON.parse(trimmed);
		} catch {
			appendDiagnostic(root, viewId, { source: "runner", runId, level: "warn", code: "malformed_event", message: "Worker emitted malformed JSON", details: { preview: trimmed.slice(0, 160) } });
			return;
		}
		// First line is the session header {type:"session",...}; nothing to reduce.
		if (event?.type === "session") return;
		const now = Date.now();
		const statusChanged = reduceEvent(status, event, now);
		const evidenceChanged = reduceEvidence(evidence, event, now);
		if (statusChanged || evidenceChanged) scheduleFlush();
	};

	worker.stdout.on("data", (chunk) => {
		const text = chunk.toString();
		try {
			appendLine(stdoutLog, text.replace(/\n$/, ""));
		} catch {
			/* ignore raw-log failures */
		}
		buffer += text;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) onLine(line);
	});

	worker.stderr.on("data", (chunk) => {
		const text = chunk.toString();
		appendLine(stderrLog, text.replace(/\n$/, ""));
		appendDiagnostic(root, viewId, { source: "runner", runId, level: "warn", code: "worker_stderr", message: "Worker wrote to stderr", details: { preview: text.slice(0, 300) } });
	});

	// ---- termination handling ----------------------------------------------
	const stop = () => {
		stoppedByUser = true;
		try {
			if (worker.pid && !worker.killed) worker.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		setTimeout(() => {
			try {
				if (worker.pid && !worker.killed) worker.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}, 4000).unref?.();
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);

	worker.on("error", async (err) => {
		// Cancel any in-flight throttled flush before finalizing: if the timer
		// callback lands during the sendStateCommand await below, the stale
		// persist() would overwrite the coordinator-materialized terminal state
		// and the close-path run_finalized would then bounce as stale_run
		// (symmetric with the close path's cancel; issue #91 fix round 1).
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		status.error = `Failed to launch worker: ${err instanceof Error ? err.message : String(err)}`;
		appendDiagnostic(root, viewId, { source: "runner", runId, level: "error", code: "worker_error", message: status.error, details: {} });
		finalizeRun(status, { exitCode: 1, stoppedByUser }, Date.now());
		finalizeEvidence(evidence, status, Date.now());
		persistEvidenceArtifacts();
		await finalizeThroughCoordinator({ exitCode: 1, stoppedByUser });
		process.exit(1);
	});

	worker.on("close", async (code) => {
		if (buffer.trim()) onLine(buffer);
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		finalizeRun(status, { exitCode: code ?? 0, stoppedByUser }, Date.now());
		finalizeEvidence(evidence, status, Date.now());
		appendDiagnostic(root, viewId, { source: "runner", runId, level: code ? "error" : "info", code: "worker_exit", message: `Worker exited with code ${code ?? 0}`, details: { code, stoppedByUser } });
		// Persist the terminal state (with the heuristic summary) IMMEDIATELY so the
		// dashboard flips to its final state at once. Then try to classify the final
		// bucket and upgrade the summary with cheap model passes. Slow/unreachable
		// model calls must never stall the row indefinitely.
		//
		// Issue #91 (A8 path 3): the terminal status/state materialize through the
		// View State Coordinator (finalizeThroughCoordinator) — only evidence
		// artifacts are written directly here. The in-flight hot-path flush was
		// cancelled above, so no throttled write can race the coordinator's patch.
		persistEvidenceArtifacts();
		await finalizeThroughCoordinator({ exitCode: code ?? 0, stoppedByUser });
		applyHeuristicAutoState(config, status, evidence)
			.then((changed) => {
				if (changed) {
					finalizeEvidence(evidence, status, Date.now());
					if (coordinatorDisabled()) persistUnlessManual(true);
					else refreshEvidenceMirrors();
				}
				return maybeModelAutoState(config, status, evidence);
			})
			.then((changed) => {
				if (changed) {
					finalizeEvidence(evidence, status, Date.now());
					if (coordinatorDisabled()) persistUnlessManual(true);
					else refreshEvidenceMirrors();
				}
				return maybeModelSummary(config, status);
			})
			.then(async (changed) => {
				if (!changed) return;
				if (coordinatorDisabled()) persistUnlessManual(true);
				else await patchSummaryThroughCoordinator(config, status);
			})
			.catch(() => {})
			.then(async () => {
				// The finalize chain must never prevent process.exit: a lock/fs failure
				// here used to pin the runner as a 100% CPU zombie (issue #33). Both
				// steps now await coordinator commands, so they run before the exit.
				try {
					await finalizeSteeringIfNeeded(config, status, evidence);
				} catch (err) {
					tryAppendDiagnostic(config, "finalize_steering_failed", err);
				}
				try {
					await drainQueuedFollowUp(config, status);
				} catch (err) {
					tryAppendDiagnostic(config, "follow_up_drain_failed", err);
				}
			})
			.finally(() => {
				process.exit(stoppedByUser ? 0 : (code ?? 0));
			});
	});
}

/**
 * Route the plan-ready row flip through the coordinator (`plan_ready`): the
 * decision layer carries the exact legacy patch (needs_input/exited/"Approve
 * this plan?") and its manual fence replaces the old file re-read guard.
 * recordPlanReady's steering.json write STAYS direct — steering is not a
 * coordinator artifact. The cheap pre-check remains as an optimization; the
 * coordinator's manual_fence is authoritative. Async because the command must
 * land before the exit-chain process.exit.
 * @param {import("../src/core/types.mjs").RunConfig} config @param {import("../src/core/types.mjs").RunStatus} status @param {import("../src/core/types.mjs").EvidenceSnapshot} evidence */
async function finalizeSteeringIfNeeded(config, status, evidence) {
	if (config.kind !== "plan" && config.kind !== "plan_change") return;
	if (status.semanticState === "failed" || status.semanticState === "stopped") return;
	// A manual completion racing the exit chain must not be resurrected for
	// approval: the user already closed this row. Same signal as the other
	// post-exit guards (completeView writes completed+autoState null to state.json).
	if (isManualCompletion(readState(config.root, config.viewId))) return;
	recordPlanReady(config.root, config.viewId, {
		runId: config.runId,
		planText: latestEvidenceText(evidence) || status.latestAssistantPreview || status.summary || "Plan ready",
	});
	if (coordinatorDisabled()) {
		legacyPlanReadyStateWrite(config.root, config.viewId, config.runId);
		return;
	}
	const result = await sendStateCommand(config.root, {
		type: "state_command",
		viewId: config.viewId,
		runId: config.runId,
		source: "job-runner",
		kind: "plan_ready",
		expectedRevision: null,
		payload: { runId: config.runId },
	});
	if (result.status === "applied") return;
	if (result.reason === "manual_fence" || result.reason === "no_change") return;
	appendDiagnostic(config.root, config.viewId, { source: "runner", runId: config.runId, ...commandRejectDiagnostic("plan_ready", "Plan-ready", result.reason, "otherwise dashboard reconcile will converge the row"), details: { reason: result.reason } });
}

/** @param {import("../src/core/types.mjs").RunConfig} config @param {import("../src/core/types.mjs").RunStatus} status */
async function drainQueuedFollowUp(config, status) {
	if (status.semanticState !== "idle" && status.semanticState !== "completed") return;
	// A manual completion racing the exit chain must never be followed up: the
	// user just finished this row, so don't launch a new run over it. The
	// in-memory status may be stale (fresh-read guards skip classification), so
	// check the authoritative state.json signal.
	if (isManualCompletion(readState(config.root, config.viewId))) return;
	if (config.kind === "plan" || config.kind === "plan_change") return;
	const claimed = claimNextFollowUp(config.root, config.viewId);
	if (!claimed.ok || !claimed.item) return;
	const item = claimed.item;
	const nextRunId = newRunId();
	const nextConfig = {
		...config,
		runId: nextRunId,
		kind: runKindForFollowUp(item),
		prompt: promptForFollowUp(config.root, config.viewId, item),
	};
	try {
		const { pid } = launchRun(config.root, nextConfig, { runnerScript: fileURLToPath(import.meta.url) });
		const nextStatus = createRunStatus(nextConfig, pid ?? null, Date.now());
		// Bootstrap the follow-up run through the coordinator: command.runId is
		// deliberately omitted (a parent-run runId would trip the generic stale-run
		// guard against the just-finalized parent); payload.newRunId governs the
		// state-side currentRunId. The new runner's own run_started then lands on
		// top of this bootstrap with the real pid.
		if (coordinatorDisabled()) {
			legacyFollowupBootstrap(config.root, config.viewId, nextStatus);
		} else {
			const result = await sendStateCommand(config.root, {
				type: "state_command",
				viewId: config.viewId,
				source: "job-runner",
				kind: "followup_started",
				expectedRevision: null,
				payload: { newRunId: nextRunId, statusPatch: { ...nextStatus } },
			});
			if (result.reason === "manual_fence") {
				// The user completed the row between the pre-check and this command.
				// The fence preserved their verdict (legacy clobbered it); the child
				// is already launched, so complete the item to avoid a double fire
				// and surface the lost follow-up.
				appendDiagnostic(config.root, config.viewId, { source: "queue", runId: nextRunId, level: "warn", code: "follow_up_fenced", message: "Manual completion fenced the follow-up bootstrap; the launched run continues but the row keeps its manual verdict", details: { kind: item.kind } });
				completeFollowUp(config.root, config.viewId, item.id, { runId: nextRunId });
				return;
			}
			if (result.status !== "applied" && result.reason !== "no_change" && result.reason !== "stale_run") {
				appendDiagnostic(config.root, config.viewId, { source: "queue", runId: nextRunId, ...commandRejectDiagnostic("follow_up_bootstrap", "Follow-up bootstrap", result.reason, "otherwise the launched runner's own run_started converges the row"), details: { reason: result.reason } });
			}
		}
		completeFollowUp(config.root, config.viewId, item.id, { runId: nextRunId });
		appendDiagnostic(config.root, config.viewId, { source: "queue", runId: nextRunId, code: "follow_up_started", message: "Queued follow-up started by JSON runner", details: { kind: item.kind } });
	} catch (err) {
		releaseFollowUp(config.root, config.viewId, item.id);
		appendDiagnostic(config.root, config.viewId, { source: "queue", level: "error", code: "follow_up_drain_failed", message: "JSON runner could not start queued follow-up", details: { error: err instanceof Error ? err.message : String(err) } });
	}
}

/** @param {import("../src/core/types.mjs").RunConfig} config @param {string} code @param {unknown} err */
function tryAppendDiagnostic(config, code, err) {
	try {
		appendDiagnostic(config.root, config.viewId, {
			source: "runner",
			runId: config.runId,
			level: "error",
			code,
			message: "Finalize step failed",
			details: { error: err instanceof Error ? err.message : String(err) },
		});
	} catch {
		/* root may be deleted — nothing to persist, exit anyway */
	}
}

/** @param {import("../src/core/types.mjs").FollowUpItem} item */
function runKindForFollowUp(item) {
	switch (item.kind) {
		case "plan_request":
			return "plan";
		case "plan_change":
			return "plan_change";
		case "plan_approval":
			return "plan_approval";
		default:
			return "reply";
	}
}

/** @param {import("../src/core/types.mjs").EvidenceSnapshot} evidence */
function latestEvidenceText(evidence) {
	return evidence.assistantEvidence?.[evidence.assistantEvidence.length - 1]?.text ?? "";
}

/** @param {string} root @param {string} viewId @param {import("../src/core/types.mjs").FollowUpItem} item */
function promptForFollowUp(root, viewId, item) {
	const steering = readSteering(root, viewId);
	switch (item.kind) {
		case "plan_request":
			return buildPlanRequestPrompt(item.text);
		case "plan_change":
			return buildPlanChangesPrompt(steering.planText, item.text);
		case "plan_approval":
			return buildApprovePlanPrompt(steering.planText);
		default:
			return item.text;
	}
}

function canAutoState(config, status, evidence) {
	if (!autoStateEnabled()) return false;
	if (config.kind === "plan" || config.kind === "plan_change") return false;
	if (status.semanticState === "failed" || status.semanticState === "stopped" || status.processState === "alive") return false;
	return Boolean((latestEvidenceText(evidence) || status.latestAssistantPreview || status.summary || "").trim());
}

/**
 * Submit one classification to the View State Coordinator (issue #91, A8 path 2).
 * The coordinator owns semantic state: applied patches are materialized by it and
 * this runner only refreshes its in-memory status from disk so any remaining
 * direct persist (PR #1 hot path) starts from authoritative fields. Designed
 * fences (manual_fence / no_change / stale_run) are informational, not errors.
 * Ambiguous transport outcomes (timeout / connection_reset) never fall back to a
 * direct write — the command may already be journaled, and the coordinator's
 * boot replay is the recovery path.
 * @param {import("../src/core/types.mjs").RunConfig} config
 * @param {import("../src/core/types.mjs").RunStatus} status mutated in place on apply (fresh coordinator fields)
 * @param {import("../src/core/types.mjs").AutoStateClassification} classification
 * @returns {Promise<boolean>} whether the classification was applied
 */
async function classifyThroughCoordinator(config, status, classification) {
	const result = await sendStateCommand(config.root, {
		type: "state_command",
		viewId: config.viewId,
		runId: config.runId,
		source: "job-runner",
		kind: "auto_state_classified",
		expectedRevision: null,
		payload: { classification },
	});
	if (result.status === "applied") {
		appendDiagnostic(config.root, config.viewId, { source: "runner", runId: config.runId, code: "auto_state_classified", message: "Auto-state classifier updated terminal state", details: { kind: classification.kind, confidence: classification.confidence, source: classification.source, reason: classification.reason } });
		const fresh = readStatus(config.root, config.viewId, config.runId);
		if (fresh) Object.assign(status, fresh);
		return true;
	}
	if (result.reason === "coordinator_disabled") {
		// Legacy escape hatch (AGENT_BOARD_COORDINATOR=off): apply locally; the
		// caller's persistUnlessManual keeps the pre-coordinator fence for this path.
		return applyAutoStateToStatus(status, classification, Date.now());
	}
	if (result.reason === "manual_fence" || result.reason === "no_change" || result.reason === "stale_run") {
		// Designed fences — informational, not errors.
		return false;
	}
	appendDiagnostic(config.root, config.viewId, { source: "runner", runId: config.runId, ...commandRejectDiagnostic("auto_state", "Auto-state classification", result.reason, "otherwise the next classification pass will converge the row"), details: { reason: result.reason } });
	return false;
}

async function applyHeuristicAutoState(config, status, evidence) {
	if (!canAutoState(config, status, evidence)) return false;
	// Cheap pre-check kept as an optimization (avoids a pointless command);
	// correctness no longer depends on it — the coordinator fences manual
	// completions authoritatively (manual_fence).
	const latestState = readState(config.root, config.viewId);
	if (isManualCompletion(latestState)) return false;
	const latest = latestEvidenceText(evidence) || status.latestAssistantPreview || status.summary || "";
	const classification = heuristicAutoState(latest, { lastAgentActivityAt: status.lastAgentActivityAt ?? null });
	return classifyThroughCoordinator(config, status, classification);
}

async function maybeModelAutoState(config, status, evidence) {
	if (!canAutoState(config, status, evidence)) return false;
	const model = autoStateModel();
	if (!model) return false;
	const latest = latestEvidenceText(evidence) || status.latestAssistantPreview || status.summary || "";
	const prompt = buildAutoStatePrompt(latest);
	const out = await runOneShot(
		config.piCommand,
		[...config.piArgsPrefix, "--mode", "json", "-p", "--no-session", "--model", model, prompt],
		15000,
	);
	// The user may have marked the row done manually during the model call. The
	// cheap pre-check avoids a pointless command; the coordinator's manual_fence
	// is the authoritative guard for races after this read.
	const fresh = readStatus(config.root, config.viewId, config.runId);
	if (!fresh || isManualCompletion(fresh)) return false;
	Object.assign(status, fresh);
	const classification = autoStateFromModelOrHeuristic(out, latest, { lastAgentActivityAt: status.lastAgentActivityAt ?? null });
	return classifyThroughCoordinator(config, status, classification);
}

/** Default cheap model for terminal summaries. Override/disable via $AGENT_BOARD_SUMMARY_MODEL. */
const DEFAULT_SUMMARY_MODEL = "gpt-4o";

/**
 * Cheap-model summary, ON BY DEFAULT (uses {@link DEFAULT_SUMMARY_MODEL}; override with
 * $AGENT_BOARD_SUMMARY_MODEL=<model>, disable with $AGENT_BOARD_SUMMARY_MODEL=off). Overrides
 * status.summary with a short model-generated line. On any failure (no API key, model
 * unavailable, timeout) it silently keeps the heuristic summary already in status.summary.
 * @param {import("../src/core/types.mjs").RunConfig} config
 * @param {import("../src/core/types.mjs").RunStatus} status
 * @returns {Promise<boolean>} whether the summary was upgraded.
 */
async function maybeModelSummary(config, status) {
	const configured = process.env.AGENT_BOARD_SUMMARY_MODEL ?? process.env.AGENT_VIEW_SUMMARY_MODEL;
	if (configured === "off") return false;
	const model = configured || DEFAULT_SUMMARY_MODEL;
	if (status.semanticState === "failed" || status.semanticState === "stopped") return false;
	const source = status.latestAssistantPreview || status.summary;
	if (!source) return false;
	const prompt = `In 8 words or fewer, summarize what this coding agent just did. No quotes.\n\n${source}`;
	const out = await runOneShot(
		config.piCommand,
		[...config.piArgsPrefix, "--mode", "json", "-p", "--no-session", "--model", model, prompt],
		15000,
	);
	// The user may have marked the row done manually during the summary call.
	// Updating the stale status and letting the caller persist would clobber the
	// manual completion, so bail out before touching the in-memory status.
	if (isManualCompletion(readState(config.root, config.viewId))) return false;
	const text = out.trim().split("\n").slice(-1)[0]?.trim();
	if (text) {
		status.summary = text.replace(/^["']|["']$/g, "").slice(0, 80);
		return true;
	}
	return false;
}

/**
 * Route the post-exit model-summary upgrade through the coordinator as a
 * `patch_fields` command (summary + latestAssistantPreview are whitelisted for
 * the job-runner source). The generic manual fence replaces the old
 * persistUnlessManual file re-read. runId stays null: the finished run's
 * currentRunId still points at it, so the coordinator binds the status patch
 * to the right file without tripping the stale-run guard.
 * @param {import("../src/core/types.mjs").RunConfig} config
 * @param {import("../src/core/types.mjs").RunStatus} status mutated in place on apply
 * @returns {Promise<boolean>} whether the summary patch was applied
 */
async function patchSummaryThroughCoordinator(config, status) {
	const result = await sendStateCommand(config.root, {
		type: "state_command",
		viewId: config.viewId,
		runId: null,
		source: "job-runner",
		kind: "patch_fields",
		expectedRevision: null,
		payload: {
			state: { summary: status.summary, latestAssistantPreview: status.latestAssistantPreview },
			status: { summary: status.summary },
		},
	});
	if (result.status === "applied") {
		const fresh = readStatus(config.root, config.viewId, config.runId);
		if (fresh) Object.assign(status, fresh);
		return true;
	}
	if (result.reason === "manual_fence" || result.reason === "no_change") return false;
	appendDiagnostic(config.root, config.viewId, { source: "runner", runId: config.runId, ...commandRejectDiagnostic("summary_patch", "Summary patch", result.reason, "otherwise dashboard reconcile will converge the row"), details: { reason: result.reason } });
	return false;
}

/**
 * Run a pi one-shot and return the concatenated assistant text from message_end events.
 * @param {string} command
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
function runOneShot(command, args, timeoutMs = 20000) {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: { ...process.env, AGENT_BOARD_NO_SWEEP: "1" } });
		let buf = "";
		child.stdout.on("data", (c) => {
			buf += c.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const e = JSON.parse(line);
					if (e?.type === "message_end" && e.message?.role === "assistant") {
						for (const b of e.message.content ?? []) {
							if (b.type === "text") out += b.text;
						}
					}
				} catch {
					/* ignore */
				}
			}
		});
		child.on("close", () => resolve(out));
		child.on("error", () => resolve(""));
		// Safety timeout so a hung summarizer never blocks finalization forever.
		setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			resolve(out);
		}, timeoutMs).unref?.();
	});
}

main();
