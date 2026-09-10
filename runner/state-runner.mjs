#!/usr/bin/env node
/**
 * Detached auto-state classifier.
 *
 * Reads the latest assistant turn from evidence/state, asks a cheap model to classify
 * the terminal bucket, and updates state.json (and status.json when a run id exists).
 * Safe best-effort: on model failure it falls back to the same heuristic classifier.
 */
import { spawn } from "node:child_process";
import { readJson } from "../src/core/atomic.mjs";
import { appendDiagnostic } from "../src/core/diagnostics.mjs";
import { applyAutoStateToStatus, applyAutoStateToViewState, autoStateEnabled, autoStateFromModelOrHeuristic, autoStateModel, buildAutoStatePrompt, heuristicAutoState, isManualCompletion } from "../src/core/auto-state.mjs";
import { finalizeEvidence, readEvidence, summarizeEvidence, writeEvidence } from "../src/core/evidence.mjs";
import { updateCodeRefsFromEvidence } from "../src/core/code-refs-store.mjs";
import { readState, readStatus, readMeta, writeState, writeStatus } from "../src/core/store.mjs";
import { sendStateCommand } from "../src/core/coordinator-client.mjs";
import { commandRejectDiagnostic } from "../src/core/state-commands.mjs";

async function main() {
	const configPath = process.argv[2];
	if (!configPath) process.exit(2);
	/** @type {import("../src/core/types.mjs").AutoStateConfig|null} */
	const config = readJson(configPath, null);
	if (!config || !autoStateEnabled()) process.exit(0);

	// Read the view meta once so code-ref extraction reuses it on the evidence write.
	const meta = readMeta(config.root, config.viewId);

	const state = readState(config.root, config.viewId);
	if (!state || state.processState === "alive" || state.semanticState === "failed" || state.semanticState === "stopped") process.exit(0);
	// Cheap pre-check (optimization only): skip a pointless command when the
	// manual verdict is already materialized. The coordinator's manual_fence
	// stays the authoritative guard for races after this read.
	if (isManualCompletion(state)) process.exit(0);

	const evidence = readEvidence(config.root, config.viewId);
	const latest = latestEvidenceText(evidence) || state.latestAssistantPreview || state.summary || "";
	if (!latest.trim()) process.exit(0);

	if (state.autoState?.source === "model" && state.autoState.textHash === heuristicAutoState(latest).textHash) process.exit(0);

	const model = autoStateModel();
	let classification = heuristicAutoState(latest, { lastAgentActivityAt: state.lastAgentActivityAt ?? null });
	if (model) {
		const prompt = buildAutoStatePrompt(latest);
		const out = await runOneShot(
			config.piCommand,
			[...config.piArgsPrefix, "--mode", "json", "-p", "--no-session", "--model", model, prompt],
			{ timeoutMs: 15000, cwd: config.cwd, env: sanitizedEnv() },
		);
		classification = autoStateFromModelOrHeuristic(out, latest, { lastAgentActivityAt: state.lastAgentActivityAt ?? null });
	}

	// Issue #91 (A8 path 2): the classification lands through the View State
	// Coordinator — the single writer of state.json/status.json. A manual
	// completion is fenced by the coordinator (manual_fence), so this late pass
	// can no longer clobber the user's verdict (#46 class). Ambiguous transport
	// outcomes (timeout / connection_reset) NEVER fall back to a direct write:
	// the command may already be journaled, and the coordinator's boot replay
	// is the recovery path.
	const result = await sendStateCommand(config.root, {
		type: "state_command",
		viewId: config.viewId,
		runId: config.runId ?? null,
		source: "state-runner",
		kind: "auto_state_classified",
		expectedRevision: null,
		payload: { classification },
	});

	if (result.status === "applied") {
		appendDiagnostic(config.root, config.viewId, { source: "service", runId: config.runId, code: "auto_state_classified", message: "Auto-state classifier updated row state", details: { kind: classification.kind, confidence: classification.confidence, source: classification.source, reason: classification.reason } });
	} else if (result.reason !== "coordinator_disabled") {
		// Unified decided/ambiguous classification (CR r2 issue-3): decided
		// rejects (manual_fence/stale_run/…) log as info *_skipped — the
		// coordinator's verdict is authoritative; only genuinely ambiguous
		// outcomes (timeout/connection_reset) keep the recovery-path warn.
		appendDiagnostic(config.root, config.viewId, { source: "service", runId: config.runId, ...commandRejectDiagnostic("auto_state", "Auto-state classification", result.reason, "otherwise the next classification pass will converge the row"), details: { reason: result.reason } });
	}

	if (result.reason === "coordinator_disabled") {
		// Legacy escape hatch (AGENT_BOARD_COORDINATOR=off): pre-coordinator
		// direct-write behavior, unchanged.
		let changed = false;
		if (config.runId) {
			const status = readStatus(config.root, config.viewId, config.runId);
			if (status) {
				changed = applyAutoStateToStatus(status, classification, Date.now()) || changed;
				status.evidenceSummary = summarizeEvidence(finalizeEvidence(evidence, status, Date.now()));
				writeStatus(config.root, status);
			}
		}
		const latestState = readState(config.root, config.viewId) ?? state;
		changed = applyAutoStateToViewState(latestState, classification, Date.now()) || changed;
		finalizeEvidence(evidence, { semanticState: latestState.semanticState, usage: null }, Date.now());
		latestState.review = summarizeEvidence(evidence);
		writeEvidence(config.root, evidence);
		updateCodeRefsFromEvidence(config.root, config.viewId, evidence, meta);
		writeState(config.root, latestState);
		if (changed) {
			appendDiagnostic(config.root, config.viewId, { source: "service", runId: config.runId, code: "auto_state_classified", message: "Auto-state classifier updated row state", details: { kind: classification.kind, confidence: classification.confidence, source: classification.source, reason: classification.reason } });
		}
		process.exit(0);
	}

	// Evidence pipeline (coordinator-independent) stays direct: finalize the
	// evidence snapshot from a FRESH state read (reads are not writes — the
	// coordinator owns state.json/status.json writes, not reads), then persist
	// the evidence artifacts and code-refs.
	const postState = readState(config.root, config.viewId);
	finalizeEvidence(evidence, { semanticState: postState?.semanticState ?? state.semanticState, usage: null }, Date.now());
	writeEvidence(config.root, evidence);
	updateCodeRefsFromEvidence(config.root, config.viewId, evidence, meta);

	// Issue #91 PR #2 (Task 4): the evidence mirrors move behind the coordinator
	// too — one patch_fields command materializes review/evidenceSummary on both
	// files under a shared materializedRevision (previously two separately
	// fenced direct writes). The coordinator's generic manual_fence / stale_run
	// guards are authoritative; ambiguous outcomes (timeout / connection_reset)
	// NEVER fall back to a direct write — if the command was journaled, boot
	// replay recovers it, and the next classification pass re-derives mirrors
	// from the evidence files either way.
	const mirrorSummary = summarizeEvidence(evidence);
	const patch = await sendStateCommand(config.root, {
		type: "state_command",
		viewId: config.viewId,
		runId: config.runId ?? null,
		source: "state-runner",
		kind: "patch_fields",
		expectedRevision: null,
		payload: { state: { review: mirrorSummary }, status: { evidenceSummary: mirrorSummary } },
	});
	if (patch.status === "applied") {
		// Quiet success — mirrors materialized by the coordinator.
	} else if (patch.reason === "manual_fence" || patch.reason === "stale_run" || patch.reason === "no_change") {
		// Designed fences — informational: a manual verdict or a newer run owns
		// the row, or the mirrors already match.
		appendDiagnostic(config.root, config.viewId, { source: "service", runId: config.runId, code: "evidence_mirror_patch_skipped", message: `Evidence mirror patch not applied (${patch.reason})`, details: { reason: patch.reason } });
	} else {
		appendDiagnostic(config.root, config.viewId, { source: "service", runId: config.runId, level: "warn", code: "evidence_mirror_patch_ambiguous", message: `Evidence mirror patch outcome unknown (${patch.reason}); if the command was journaled, coordinator replay will recover it; the next classification pass re-derives the mirrors from the evidence files`, details: { reason: patch.reason } });
	}
}

/** @param {import("../src/core/types.mjs").EvidenceSnapshot} evidence */
function latestEvidenceText(evidence) {
	return evidence.assistantEvidence?.[evidence.assistantEvidence.length - 1]?.text ?? "";
}

function sanitizedEnv() {
	const env = { ...process.env };
	delete env.AGENT_BOARD_CHILD;
	delete env.AGENT_VIEW_CHILD;
	delete env.AGENT_BOARD_VIEW_ID;
	delete env.AGENT_VIEW_VIEW_ID;
	delete env.AGENT_BOARD_HOSTED;
	delete env.AGENT_VIEW_HOSTED;
	// Board-spawned classifier workers must not arm the warm-host sweeper
	// (they share the board root with real hosts).
	env.AGENT_BOARD_NO_SWEEP = "1";
	return env;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
function runOneShot(command, args, opts = {}) {
	return new Promise((resolve) => {
		let out = "";
		let settled = false;
		const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		let buf = "";
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve(out);
		};
		child.stdout.on("data", (c) => {
			buf += c.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const e = JSON.parse(line);
					if (e?.type === "message_end" && e.message?.role === "assistant") {
						for (const b of e.message.content ?? []) if (b.type === "text") out += b.text;
					}
				} catch {
					/* ignore */
				}
			}
		});
		child.on("close", finish);
		child.on("error", finish);
		setTimeout(() => {
			try { child.kill("SIGKILL"); } catch {}
			finish();
		}, opts.timeoutMs ?? 20000).unref?.();
	});
}

main().catch(() => process.exit(0));
