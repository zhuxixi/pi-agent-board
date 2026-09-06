/**
 * Dashboard decision helpers for host prewarm and attach prelude (issue #70 A14).
 *
 * Pure functions extracted from src/ui/dashboard.ts so the branching contract is
 * node-testable without pi's TS loader (same pattern as commands/attach-decision.mjs).
 * `hostActive` covers starting/alive/stopping claims from store.loadRow — pending
 * claims count as an already-registered launch, so prewarm never re-spawns them.
 */

/**
 * Prewarm decision for the selected row.
 * - "mark-only": the row has an active host claim — mark it prewarmed WITHOUT
 *   calling prewarmHost (a pending/starting claim is already a launch; the old
 *   hostAlive guard re-checked it on every debounce tick).
 * - "skip": busy row without a host claim — no prewarm, no mark.
 * - "prewarm": no claim — call service.prewarmHost once; the caller marks only on ok.
 * @param {{ hostActive?: boolean, agentBusy?: boolean }} row
 * @returns {{ action: "mark-only" | "skip" | "prewarm" }}
 */
export function planPrewarm({ hostActive, agentBusy }) {
	if (hostActive) return { action: "mark-only" };
	if (agentBusy) return { action: "skip" };
	return { action: "prewarm" };
}

/**
 * Attach prelude for a dashboard row. A hostActive row attaches directly — the
 * async resolver owns starting/stopping wait, so no interrupt confirmation is
 * offered even when the row is busy. A busy row WITHOUT a host claim keeps the
 * existing stopFirst confirm; everything else attaches directly.
 * @param {{ hostActive?: boolean, agentBusy?: boolean }} row
 * @returns {{ plan: "attach" | "confirm-stop-first" }}
 */
export function planDashboardAttach({ hostActive, agentBusy }) {
	if (!hostActive && agentBusy) return { plan: "confirm-stop-first" };
	return { plan: "attach" };
}

/**
 * Map a service reply() result to the dashboard notice (issue #70: queued and
 * sent are different outcomes — a queued reply is durable, not yet delivered).
 * Result shapes from service.reply(): {ok:false,error} | {ok:true,queued:true}
 * | {ok:true,sent:true} | {ok:true,hostMode,fallbackReason?}.
 * @param {{ ok?: boolean, error?: string, queued?: boolean, sent?: boolean, hostMode?: string|null, fallbackReason?: string }} res
 * @returns {{ level: "info" | "warn" | "error", text: string }}
 */
export function replyNotice(res) {
	if (!res?.ok) return { level: "error", text: res?.error ?? "Reply failed" };
	if (res.queued) return { level: "info", text: "Reply queued — will deliver when the host is ready" };
	if (res.sent) return { level: "info", text: "Reply sent" };
	if (res.hostMode === "json-runner") {
		return { level: "warn", text: `Reply sent with non-live fallback: ${res.fallbackReason ?? "PTY unavailable"}` };
	}
	return { level: "info", text: "Reply sent" };
}
