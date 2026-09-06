import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { planDashboardAttach, planPrewarm, replyNotice } from "../src/ui/dashboard-decisions.mjs";

/**
 * Task 15 (issue #70 A14): dashboard prewarm idempotence + attach prelude decisions,
 * extracted as pure functions so the contract is node-testable without pi's TS loader
 * (same pattern as src/commands/attach-decision.mjs from Task 14). The .ts wiring is
 * exercised by test-support/dashboard-prewarm-smoke.ts below.
 */

// ---- planPrewarm -----------------------------------------------------------

test("planPrewarm: active host claim marks prewarmed without a service call", () => {
	// starting/alive/stopping claims already have a launch — pending counts as launched.
	assert.deepEqual(planPrewarm({ hostActive: true, agentBusy: false }), { action: "mark-only" });
	assert.deepEqual(planPrewarm({ hostActive: true, agentBusy: true }), { action: "mark-only" });
});

test("planPrewarm: busy row without a host claim neither prewarms nor marks", () => {
	assert.deepEqual(planPrewarm({ hostActive: false, agentBusy: true }), { action: "skip" });
});

test("planPrewarm: idle row calls prewarmHost; caller marks only on ok", () => {
	assert.deepEqual(planPrewarm({ hostActive: false, agentBusy: false }), { action: "prewarm" });
});

// ---- planDashboardAttach ---------------------------------------------------

test("planDashboardAttach: hostActive row attaches directly, no interrupt confirm", () => {
	// The async resolver owns starting/stopping wait; busy-or-not is irrelevant here.
	assert.deepEqual(planDashboardAttach({ hostActive: true, agentBusy: true }), { plan: "attach" });
	assert.deepEqual(planDashboardAttach({ hostActive: true, agentBusy: false }), { plan: "attach" });
});

test("planDashboardAttach: busy row without a host claim goes through the stopFirst confirm", () => {
	assert.deepEqual(planDashboardAttach({ hostActive: false, agentBusy: true }), { plan: "confirm-stop-first" });
});

test("planDashboardAttach: plain idle row attaches directly", () => {
	assert.deepEqual(planDashboardAttach({ hostActive: false, agentBusy: false }), { plan: "attach" });
});

// ---- replyNotice ------------------------------------------------------------

test("replyNotice: failed reply surfaces the service error", () => {
	assert.deepEqual(replyNotice({ ok: false, error: "Unknown session" }), { level: "error", text: "Unknown session" });
	assert.deepEqual(replyNotice({ ok: false }), { level: "error", text: "Reply failed" });
});

test("replyNotice: queued result reports queued, not sent", () => {
	// {ok:true, queued:true} arrives when the host is starting/busy or the ack was lost.
	assert.deepEqual(
		replyNotice({ ok: true, queued: true, summary: { queuedCount: 1 } }),
		{ level: "info", text: "Reply queued — will deliver when the host is ready" },
	);
});

test("replyNotice: acked host delivery reports sent", () => {
	assert.deepEqual(replyNotice({ ok: true, sent: true, item: { id: "q1" } }), { level: "info", text: "Reply sent" });
});

test("replyNotice: json-runner fallback keeps the warn notice with reason", () => {
	assert.deepEqual(
		replyNotice({ ok: true, hostMode: "json-runner", fallbackReason: "node-pty missing" }),
		{ level: "warn", text: "Reply sent with non-live fallback: node-pty missing" },
	);
});

test("replyNotice: freshly launched pty host reports sent", () => {
	assert.deepEqual(replyNotice({ ok: true, hostMode: "pty" }), { level: "info", text: "Reply sent" });
});

// ---- .ts wiring smoke (dashboard.ts via --experimental-transform-types) ------

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SMOKE_SCRIPT = join(ROOT_DIR, "test-support", "dashboard-prewarm-smoke.ts");

test("dashboard wiring: prewarm idempotence and attach prelude (hostActive semantics)", () => {
	// dashboard.ts uses TS parameter properties; --experimental-transform-types handles them.
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SMOKE_SCRIPT], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const parsed = JSON.parse(out);
	assert.equal(parsed.ok, true, `smoke script must succeed: ${JSON.stringify(parsed)}`);
	assert.equal(parsed.startingHostPrewarmCalls, 0, "starting-host row must not trigger prewarmHost");
	assert.equal(parsed.startingHostMarked, true, "starting-host row must still mark prewarmedId");
	assert.equal(parsed.idlePrewarmCalls, 1, "idle row must call prewarmHost exactly once (idempotent re-entry)");
	assert.equal(parsed.idleMarked, true, "ok:true prewarm must mark prewarmedId");
	assert.equal(parsed.idleFailMarked, false, "ok:false prewarm must NOT mark prewarmedId");
	assert.equal(parsed.hostActiveAttachDirect, true, "hostActive row must attach directly with stopFirst:false");
	assert.equal(parsed.hostActiveAttachModeConfirm, false, "hostActive row must not enter the confirm prompt");
	assert.equal(parsed.busyAttachDoneCalled, false, "busy non-host row must not attach before confirmation");
	assert.equal(parsed.busyAttachModeConfirm, true, "busy non-host row must enter the confirm prompt");
});
