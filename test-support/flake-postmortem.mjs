/**
 * Flake postmortem black-box (issue #95 F3).
 *
 * When a real-process waitFor burns its budget, the failure currently says
 * only "timed out waiting" — the red carries no scene. formatPostmortem
 * renders the last observed durable state; capturePostmortem reads it from a
 * root; waitForWithPostmortem attaches it to the thrown error at timeout.
 * Pure rendering; the only I/O is capturePostmortem's reads.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import { readHost, readState, readStatus } from "../src/core/store.mjs";

/**
 * @param {{
 * 	status: object | null,
 * 	state: object | null,
 * 	host: object | null,
 * 	diagnosticsTail: object[],
 * 	journalTail: string[],
 * }} snapshot
 * @returns {string}
 */
export function formatPostmortem(snapshot) {
	const show = (label, value) => `${label}: ${value == null ? "<absent>" : JSON.stringify(value)}`;
	const lines = [
		"--- flake postmortem (last observed state at waitFor timeout) ---",
		show("status", snapshot.status),
		show("state", snapshot.state),
		show("host", snapshot.host),
		`diagnosticsTail: ${snapshot.diagnosticsTail.length ? JSON.stringify(snapshot.diagnosticsTail) : "<empty>"}`,
		`journalTail: ${snapshot.journalTail.length ? snapshot.journalTail.join(" | ") : "<empty>"}`,
	];
	return lines.join("\n");
}

/**
 * @param {string} root @param {string} viewId @param {string | null} runId
 * @returns {{ status: object | null, state: object | null, host: object | null, diagnosticsTail: object[], journalTail: string[] }}
 */
export function capturePostmortem(root, viewId, runId = null) {
	const safe = (fn) => {
		try {
			return fn();
		} catch {
			return null;
		}
	};
	let journalTail = [];
	try {
		const raw = readFileSync(join(root, "state-journal.jsonl"), "utf8");
		journalTail = raw.trim().split("\n").slice(-8);
	} catch {
		/* absent journal */
	}
	return {
		status: safe(() => (runId ? readStatus(root, viewId, runId) : null)),
		state: safe(() => readState(root, viewId)),
		host: safe(() => readHost(root, viewId)),
		diagnosticsTail: safe(() => (readDiagnostics(root, viewId) ?? []).slice(-8)) ?? [],
		journalTail,
	};
}

/**
 * waitFor with an optional postmortem. Success semantics identical to the
 * files' local helpers (poll → return the predicate value); on timeout throws
 * "timed out waiting" plus the capture thunk's postmortem, when provided.
 * @param {() => any | Promise<any>} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, capture?: () => string }} [opts]
 */
export async function waitForWithPostmortem(predicate, { timeoutMs = 15000, intervalMs = 25, capture = null } = {}) {
	const start = Date.now();
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() - start > timeoutMs) {
			const detail = capture ? "\n" + capture() : "";
			throw new Error("timed out waiting" + detail);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}
