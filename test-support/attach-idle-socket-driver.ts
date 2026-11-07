// Child-process driver: attach a REAL PtyAttachComponent to a REAL runner
// socket (argv[2]) and report whether the transition settles, when (external
// wall clock), and which path settled it. Run with --experimental-transform-types.
//
// Issue #284 T8/A11: settle assertions stay on the EXTERNAL wall clock — no
// clock is injected and no threshold loosened. Flake governance is
// deterministic waiting: the bounded loop polls the settle condition
// (attaching === false) on a 25ms cadence instead of sleeping fixed amounts.
//
// Phase-lock rendezvous files (issue #284 T8) keep child emissions ordered
// against the attach without sleeps — the paths are derived from the token
// file the same way the reporter-lifecycle fixture derives its ".ready" file:
//   argv[5] snapshot gate — written once the component received its baseline
//            snapshot; the child then emits its held S/frame so the component
//            observes the REAL live viewProof record path (unknown+candidate-*
//            shape) instead of only snapshot coverage;
//   argv[6] budget gate   — written once the 250ms recovery budget elapsed;
//            drives post-budget closed frames for the continuous-stream case.
import { ATTACH_RECOVERY_BUDGET_MS, PtyAttachComponent } from "../src/ui/pty-attach.ts";
import { existsSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";

const socketPath = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 8000);
const needle = process.argv[4] ?? "IDLE-E2E VISIBLE LINE";
const snapshotGatePath = process.argv[5] ?? null;
const budgetGatePath = process.argv[6] ?? null;
console.error(`driver diag: exists=${existsSync(socketPath)} path=${socketPath}`);
await new Promise<void>((r) => {
	const s = createConnection(socketPath);
	s.on("connect", () => { console.error("driver diag: raw connect ok"); s.destroy(); r(); });
	s.on("error", (e) => { console.error(`driver diag: raw connect error: ${e.message}`); r(); });
});
const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
const tui = {
	// rows-2 is the component work area; 26 keeps it equal to the runner host's
	// 24 rows so the geometry gate stays closed (the live regression shape).
	terminal: { rows: 26, cols: 80, columns: 80, write: () => {} },
	requestRender: () => {},
};
// T7/T8: collect the settle diagnostics so the assertions can use the recorded
// recovery facts (numbers and finite enums only) instead of re-deriving them.
const diagnostics: Array<{ code?: string; details?: Record<string, unknown> }> = [];
const component = new PtyAttachComponent(tui as never, theme, {} as never, () => {}, {
	socketPath,
	title: "s-then-idle",
	onDiagnostic: (event) => {
		diagnostics.push(event as unknown as { code?: string; details?: Record<string, unknown> });
	},
});
const internals = component as unknown as {
	attaching: boolean; deadlineState: string; notReadyReason: string | null;
	readyReason: string | null; witnessLatched: boolean; frameWitnessAvailable: boolean;
	budgetArmed: boolean; budgetElapsed: boolean; attachStartedAt: number;
	lastProofStatus: string | null; lastProofStickyInvalid: boolean;
	geometryRevision: number; resizeIntentRequired: boolean; resizeIntentId: number;
	cols: number; rows: number; viewProofRecordCount: number; protocolBaselineState: string;
	latestViewProof: { status?: string; reason?: string } | null;
	committedView: {
		source?: string; sourceCols?: number; sourceRows?: number; contentKind?: string;
		identity?: { targetCols?: number; targetRows?: number; geometryRevision?: number };
	} | null;
};
const started = Date.now();
let settledMs: number | null = null;
let visible = "";
// Proof facts observed in the poll iteration that saw the settle (a record
// arriving after the settle must not color the at-settle assertions).
let recordCountAtSettle: number | null = null;
let snapshotGateWritten = false;
let budgetGateWritten = false;
while (Date.now() - started < timeoutMs) {
	visible = component.render(80).join("\n");
	if (snapshotGatePath !== null && !snapshotGateWritten && internals.protocolBaselineState === "valid-content") {
		snapshotGateWritten = true;
		writeFileSync(snapshotGatePath, "GO\n");
	}
	if (budgetGatePath !== null && !budgetGateWritten && internals.budgetElapsed) {
		budgetGateWritten = true;
		writeFileSync(budgetGatePath, "GO\n");
	}
	if (internals.attaching === false) {
		settledMs = Date.now() - started;
		recordCountAtSettle = internals.viewProofRecordCount;
		break;
	}
	await new Promise<void>((r) => setTimeout(r, 25));
}
const settleDiagnostic = diagnostics.filter((event) => event.code === "attach_settle_ready").at(-1) ?? null;
const committed = internals.committedView;
const result = {
	settledMs,
	attaching: internals.attaching,
	showsContent: visible.includes(needle),
	visibleHead: visible.slice(0, 120),
	readyReason: internals.readyReason,
	deadlineState: internals.deadlineState,
	notReadyReason: internals.notReadyReason,
	witnessLatched: internals.witnessLatched,
	frameWitnessAvailable: internals.frameWitnessAvailable,
	budget: {
		armed: internals.budgetArmed,
		elapsed: internals.budgetElapsed,
		deadlineAt: internals.attachStartedAt + ATTACH_RECOVERY_BUDGET_MS,
		// Wall-clock skew between the driver loop start and the component's
		// attachStartedAt makes this an observational fact, not an assertion basis.
		settledAfterBudgetMs: settledMs === null ? null : started + settledMs - (internals.attachStartedAt + ATTACH_RECOVERY_BUDGET_MS),
	},
	geometry: {
		revision: internals.geometryRevision,
		resizeIntentRequired: internals.resizeIntentRequired,
		resizeIntentId: internals.resizeIntentId,
		targetCols: internals.cols,
		targetRows: internals.rows,
		committedSource: committed === null ? null : {
			source: committed.source ?? null,
			sourceCols: committed.sourceCols ?? null,
			sourceRows: committed.sourceRows ?? null,
			contentKind: committed.contentKind ?? null,
			identityTargetCols: committed.identity?.targetCols ?? null,
			identityTargetRows: committed.identity?.targetRows ?? null,
		},
	},
	proof: {
		status: internals.lastProofStatus,
		stickyInvalid: internals.lastProofStickyInvalid,
		viewProofStatus: internals.latestViewProof?.status ?? null,
		viewProofReason: internals.latestViewProof?.reason ?? null,
		recordCount: internals.viewProofRecordCount,
		recordCountAtSettle,
	},
	settleDiagnostic: settleDiagnostic === null ? null : settleDiagnostic.details ?? null,
	diagnosticsCount: diagnostics.length,
	gates: { snapshot: snapshotGateWritten, budget: budgetGateWritten },
};
try { component.dispose(); } catch { /* best effort */ }
console.log(JSON.stringify(result));
process.exit(result.settledMs !== null && result.showsContent ? 0 : 1);
