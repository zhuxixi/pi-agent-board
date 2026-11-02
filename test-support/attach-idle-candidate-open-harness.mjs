// A/B harness for the post-merge idle candidate-open attach regression.
// Runs against ANY checkout (merged / premerge / fixed) via REPO_ROOT.
// Stimulus: protocol mode, reporter capability enabled, authoritative snapshot
// with a COMPLETE frame but viewProof unavailable (candidate-open), then idle.
// Expected: the component finishes its attach transition within the legacy
// deadlines (premerge behavior) instead of waiting forever.
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const timeoutMs = Number(process.env.HARNESS_TIMEOUT_MS ?? 8000);
const theme = { fg: (_c, text) => text, bold: (text) => text };
const keybindings = {};

function build() {
	const writes = [];
	let renders = 0;
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (data) => writes.push(data) },
		requestRender: () => { renders += 1; },
	};
	const component = new PtyAttachComponent(tui, theme, keybindings, () => {}, { socketPath: "/no/such/socket", title: "idle-candidate-open" });
	return { component, writes, renderCount: () => renders };
}

const frame = "\x1b[2J\x1b[H\x1b[?2026h\x1b[1;1HIDLE CURRENT SCREEN\x1b[?2026l";
// Same-size attach (the live regression shape): the component work area is
// term.rows - 2 (overlay chrome), so a matching snapshot begin carries 80x22.
const WORK_COLS = 80;
const WORK_ROWS = 22;

const h = build();
const c = h.component;
let done = null;
const doneResults = [];
try { c.on?.("done", (payload) => doneResults.push(payload)); } catch { /* event API optional */ }
const internals = c;
const started = Date.now();
const eventTrace = [];
const origHandle = internals.handleAttachEvent.bind(internals);
internals.handleAttachEvent = function (event, payload) {
	eventTrace.push({ event, atMs: Date.now() - started, proof: payload?.viewProof?.status ?? null, frame: typeof payload?.frame === "string" ? payload.frame.length : null, cols: payload?.cols ?? null, rows: payload?.rows ?? null });
	return origHandle(event, payload);
};
// Same-size attach: the constructor already sized the component to the
// work area (80x22 for a 24-row fake terminal); do NOT override it.
// Drive the real component entrypoints: mode -> status enable -> snapshot.
internals.handleAttachEvent("mode", "protocol");
internals.onSocketData?.(`${JSON.stringify({ type: "status", status: { frameWitness: { enabled: true } }, generation: "gen-1" })}\n`);
internals.handleAttachEvent("snapshotBegin", { cols: WORK_COLS, rows: WORK_ROWS });
internals.handleAttachEvent("snapshotReady", {
	frame,
	nextSeq: 2,
	viewProof: { status: "unavailable", reason: "candidate-open", proof: null, throughSeq: null, cursorVisible: null },
	viewProofRecords: [],
});
// The real connect path arms the settle/hard deadlines; drive the same entry
// so the deadline machinery is exercised exactly as in production.
internals.startAttachSettle();
while (Date.now() - started < timeoutMs) {
	await new Promise((r) => setTimeout(r, 100));
	if (c.attaching === false) { done = Date.now() - started; break; }
}
const visible = c.render(80).join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const result = {
	checkout: process.env.REPO_ROOT,
	settledMs: done,
	attaching: c.attaching,
	showsContent: visible.includes("IDLE CURRENT SCREEN"),
	visibleHead: visible.slice(0, 120),
	doneResults,
	renders: h.renderCount(),
	diagnostics: { committedView: internals.committedView !== null, resizeIntentRequired: internals.resizeIntentRequired, latestViewProofStatus: internals.latestViewProof?.status ?? null, latestViewProofReason: internals.latestViewProof?.reason ?? null, deadlineState: internals.deadlineState, notReadyReason: internals.notReadyReason, attachMode: internals.attachMode, frameWitnessAvailable: internals.frameWitnessAvailable, localHydrationState: internals.localHydrationState, protocolBaselineState: internals.protocolBaselineState, status: internals.status, resizeIntentSatisfied: internals.resizeIntentSatisfied },
	eventTrace,
};
try { c.dispose(); } catch {}
console.log(JSON.stringify(result));
process.exit(result.settledMs !== null && result.showsContent ? 0 : 1);
