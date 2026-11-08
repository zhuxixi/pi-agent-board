// Issue #284: attach recovery component harness with an injected clock.
// Run via `node --experimental-transform-types` (TS parameter properties).
//
// Pattern: test-support/pty-attach-parser-replacement-scenario.ts — a real
// headless xterm and the real PtyAttachComponent in a child process, driven
// through the component's REAL paths:
//   - connect/reconnect  → the socket 'connect' handler's attach-lifecycle
//     effects on the SAME component instance (connectionToken increment,
//     view/generation invalidation, startAttachSettle re-entry). The attach
//     client itself stays in its unit-tested state machine; its socket writes
//     are no-ops without a socket.
//   - hello/status       → real UI-owned socket JSON lines (onSocketData),
//     including the frameWitness capability enable/disable paths.
//   - snapshot/output/S/A/F records → real attach-client messages
//     (snapshot_begin/frame/end, seq-checked output, view_proof records) —
//     candidate proof states are driven through the real noteViewProofRecord
//     path, never by forging proof objects directly.
//   - geometry           → outer-terminal size change + render (the real
//     resizeIfNeeded/noteGeometryIntent path).
//
// The component is constructed with an injected { now, schedule, clear }
// clock: now() is a virtual time source and schedule/clear manage a timer
// queue that advance(ms) drains strictly in due order. Attach deadline
// boundaries (250ms settle / 2500ms cap / 250ms recovery budget) are
// therefore asserted on virtual time, never wall clock.
//
// Usage: node --experimental-transform-types attach-recovery-scenario.ts '<json program>'
// The program is a list of step objects; the result (one JSON line on stdout)
// carries a readout per step. Assertions live in
// test/attach-recovery-component.test.mjs.
import { ATTACH_RECOVERY_BUDGET_MS, PtyAttachComponent } from "../src/ui/pty-attach.ts";
import { exitAfterStdout } from "./stdout-flush.mjs";

const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
const keybindings = {} as never;

/** Virtual clock implementing the component's { now, schedule, clear } seam. */
function createVirtualClock(startAt: number) {
	let nowMs = startAt;
	let order = 0;
	let nextId = 1;
	const queue: Array<{ id: number; order: number; due: number; fn: () => void }> = [];
	const idOf = (handle: unknown): number => (typeof handle === "number" ? handle : -1);
	return {
		now: () => nowMs,
		schedule(fn: () => void, ms: number) {
			const entry = { id: nextId++, order: order++, due: nowMs + Math.max(0, ms), fn };
			queue.push(entry);
			queue.sort((a, b) => a.due - b.due || a.order - b.order);
			return entry.id;
		},
		clear(handle: unknown) {
			const index = queue.findIndex((entry) => entry.id === idOf(handle));
			if (index >= 0) queue.splice(index, 1);
		},
		/** Absolute virtual due time of a scheduled handle, null when absent. */
		dueOf(handle: unknown): number | null {
			return queue.find((entry) => entry.id === idOf(handle))?.due ?? null;
		},
		/** Advance virtual time by `ms`, draining due callbacks in order. */
		advance(ms: number): number {
			const target = nowMs + Math.max(0, ms);
			for (;;) {
				const entry = queue[0];
				if (entry === undefined || entry.due > target) break;
				queue.shift();
				nowMs = entry.due;
				entry.fn();
			}
			nowMs = target;
			return nowMs;
		},
	};
}

type VirtualClock = ReturnType<typeof createVirtualClock>;

function createHarness(clockStart: number) {
	const clock = createVirtualClock(clockStart);
	const terminalWrites: string[] = [];
	let renders = 0;
	const diagnostics: unknown[] = [];
	const tuiTerminal = { rows: 26, cols: 80, columns: 80, write: (data: string) => terminalWrites.push(data) };
	const tui = {
		terminal: tuiTerminal,
		requestRender: () => {
			renders += 1;
		},
	};
	const component = new PtyAttachComponent(tui as never, theme, keybindings, () => {}, {
		socketPath: "/no/such/attach-recovery-socket",
		title: "attach-recovery",
		clock: { now: clock.now, schedule: clock.schedule, clear: clock.clear },
		// T7: collect the settle diagnostics so tests can assert the recorded
		// recovery facts (numbers/finite enums only).
		onDiagnostic: (event: unknown) => {
			diagnostics.push(event);
		},
	});
	return { clock, component, tuiTerminal, terminalWrites, renderCount: () => renders, diagnostics };
}

type Harness = ReturnType<typeof createHarness>;

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function settleTicks(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

/** The socket 'connect' handler's attach-lifecycle effects on the same
 *  component instance (see connect() in src/ui/pty-attach.ts). Reconnect is
 *  exactly this re-entry: connectionToken increments, the old connection's
 *  views/proofs are invalidated, the attach client resumes from its cursor,
 *  and startAttachSettle runs again. The first connect keeps the client in
 *  `probing` (its start() would only send the subscribe and arm a wall-clock
 *  probe timer; snapshot_begin is accepted from probing either way). The
 *  #284 witness latch is deliberately NOT touched here: it is attach-scoped
 *  (I6 latch layer), not connection-scoped. */
function simulateConnect(c: any): void {
	c.outputRenderScheduler.cancel();
	c.captureRecoveryView();
	c.connected = true;
	c.everConnected = true;
	c.connectionToken += 1;
	c.committedView = null;
	// View layer (I6): the old connection's proof facts are invalidated with
	// its view; only the new connection's snapshot/records rebuild them.
	c.latestViewProof = null;
	c.viewProofIdentity = null;
	c.viewProofTrailing.reset();
	c.currentWireGeneration = null;
	c.emptyResetPending = true;
	c.disconnectedAt = null;
	c.status = c.recoveryView !== null ? "reconnecting…" : "attached";
	if (c.attachMode === "protocol") c.attachClient.reconnect(c.attachClient.getLastSeq());
	c.startAttachSettle();
}

/** Snapshot viewProof presets: the two real arrival shapes per candidate
 *  state (runner coverageFor `unavailable+candidate-*`, live record path
 *  `unknown+candidate-*`), plus missing-evidence and invalid-coverage
 *  shapes. */
const VIEW_PROOF_PRESETS: Record<string, () => Record<string, unknown>> = {
	"unavailable-candidate-open": () => ({ status: "unavailable", reason: "candidate-open", proof: null, throughSeq: null, cursorVisible: null }),
	"unavailable-candidate-aborted": () => ({ status: "unavailable", reason: "candidate-aborted", proof: null, throughSeq: null, cursorVisible: null }),
	"unknown-candidate-open": () => ({ status: "unknown", reason: "candidate-open", proof: null, throughSeq: null, cursorVisible: null }),
	"unknown-candidate-aborted": () => ({ status: "unknown", reason: "candidate-aborted", proof: null, throughSeq: null, cursorVisible: null }),
	"no-proof": () => ({ status: "unknown", reason: "no-proof", proof: null, throughSeq: null, cursorVisible: null }),
	"no-output": () => ({ status: "unknown", reason: "no-output", proof: null, throughSeq: null, cursorVisible: null }),
	"output-gap": () => ({ status: "unknown", reason: "output-gap", proof: null, throughSeq: null, cursorVisible: null }),
	// Issue #288 trailing-family arrival shapes (spec §1): the runner snapshot
	// form (coverageFor `unavailable + trailing-unsafe`) and the UI live form
	// (noteViewProofOutput → `unknown + view-proof-trailing-<identifier>`).
	"unavailable-trailing-unsafe": () => ({ status: "unavailable", reason: "trailing-unsafe", proof: null, throughSeq: null, cursorVisible: null }),
	"unknown-trailing-csi-unknown": () => ({ status: "unknown", reason: "view-proof-trailing-csi-unknown", proof: null, throughSeq: null, cursorVisible: null }),
};

/** Frame-witness F metadata matching the component's current geometry. A
 *  `mismatchCols` step mints a metadata cols value that can never match the
 *  local target, for F-path gates that must keep waiting. */
function frameMetadata(c: any, mismatchCols = false): Record<string, unknown> {
	return {
		protocol: 1,
		cols: mismatchCols ? c.cols + 40 : c.cols,
		rows: c.rows,
		mode: "fullscreen",
		rendererEpoch: 1,
		sessionEpoch: 1,
		focusPresent: true,
		overlayPresent: false,
		intentId: 0,
		geometryRevision: 0,
	};
}

/** A complete runner-synthesized frame: clear + sync-open wrapper so the
 *  hydration write ends at a real close boundary and commits. */
function frameFor(step: Record<string, any>): string | null {
	if (step.empty === true) return null;
	if (typeof step.frame === "string") return step.frame;
	const text = typeof step.text === "string" ? step.text : "COMMITTED";
	return `\x1b[2J\x1b[H\x1b[?2026h\x1b[1;1H${text}\x1b[?2026l`;
}

function snapshotViewProof(step: Record<string, any>, c: any): Record<string, unknown> | undefined {
	if (step.proof === undefined || step.proof === "none") return undefined;
	if (step.proof === "covered") {
		return {
			status: "covered",
			reason: "exact-proof",
			proof: { marker: "F", seq: 1, frameId: 1, metadata: frameMetadata(c) },
			throughSeq: 1,
			cursorVisible: true,
		};
	}
	if (typeof step.proof === "object" && step.proof !== null) return step.proof;
	const preset = VIEW_PROOF_PRESETS[step.proof];
	if (preset === undefined) throw new Error(`unknown proof preset: ${String(step.proof)}`);
	return preset();
}

async function applySnapshot(h: Harness, step: Record<string, any>, state: ScenarioState): Promise<void> {
	const c = h.component as any;
	// A baseline replacement in the REAL protocol: the client is "live" after
	// the first snapshot and rejects unsolicited begins; the runner-driven path
	// is resnapshot_required → resubscribe → fresh snapshot (accepted from
	// "resyncing"). Same for post-reconnect snapshots ("resyncing" after
	// reconnect()). Without the flag the snapshot must be the probing first one.
	if (step.resnapshot === true) {
		c.onSocketData(`${JSON.stringify({ type: "resnapshot_required" })}\n`);
	}
	const cols = typeof step.cols === "number" ? step.cols : c.cols;
	const rows = typeof step.rows === "number" ? step.rows : c.rows;
	const beginSeq = typeof step.beginSeq === "number" ? step.beginSeq : 1;
	// Empty baselines carry no frame and no flush: the client expects the end
	// nextSeq to be begin-independent (terminal-attach-client finishCollecting).
	const nextSeq = typeof step.nextSeq === "number" ? step.nextSeq : step.empty === true ? 1 : beginSeq + 1;
	c.onSocketData(`${JSON.stringify({
		type: "snapshot_begin",
		cols,
		rows,
		generation: typeof step.generation === "string" ? step.generation : "gen-1",
		snapshotSeq: beginSeq,
		...(step.empty === true ? { empty: true } : {}),
	})}\n`);
	const frame = frameFor(step);
	if (typeof frame === "string") c.onSocketData(`${JSON.stringify({ type: "snapshot_frame", data: frame })}\n`);
	for (const record of Array.isArray(step.records) ? step.records : []) {
		c.onSocketData(`${JSON.stringify({ type: "view_proof", record })}\n`);
	}
	const viewProof = snapshotViewProof(step, c);
	c.onSocketData(`${JSON.stringify({ type: "snapshot_end", nextSeq, ...(viewProof === undefined ? {} : { viewProof }) })}\n`);
	state.lastSeq = nextSeq - 1;
	// Hydration is asynchronous (xterm parses on its own tick); wait for the
	// committed view — unless writes are held, which parks the write callback.
	await waitFor(
		() => c.committedView !== null || state.held.length > 0 || (step.empty === true && c.protocolBaselineState === "valid-empty"),
		"snapshot hydration",
	);
	await settleTicks();
}

async function applyOutput(h: Harness, step: Record<string, any>, state: ScenarioState): Promise<void> {
	const c = h.component as any;
	const raw = typeof step.data === "string" ? step.data : typeof step.text === "string" ? step.text : "OUTPUT";
	// openFrame: a ?2026 window that never closes — the parser stays mid-frame,
	// the frameState gate must keep the attach waiting (spec §3.1 predicate 3).
	const data = step.openFrame === true ? `\x1b[?2026h${raw}` : step.syncClose === false ? raw : `\x1b[?2026h${raw}\x1b[?2026l`;
	state.lastSeq = typeof step.seq === "number" ? step.seq : state.lastSeq + 1;
	c.onSocketData(`${JSON.stringify({ type: "output", seq: state.lastSeq, data })}\n`);
	if (state.held.length === 0) await waitFor(() => c.parserWritesInFlight === 0, "output parse drain", 1000);
	await settleTicks();
}

function applyRecord(h: Harness, step: Record<string, any>, state: ScenarioState): void {
	const c = h.component as any;
	const marker = step.marker;
	if (marker !== "S" && marker !== "A" && marker !== "F") throw new Error(`unknown record marker: ${String(marker)}`);
	const seq = typeof step.seq === "number" ? step.seq : state.lastSeq;
	const frameId = typeof step.frameId === "number" ? step.frameId : seq;
	const record =
		marker === "F"
			? { marker, seq, frameId, metadata: step.metadata ?? frameMetadata(c, step.mismatchCols === true) }
			: marker === "S"
				? { marker, seq, frameId }
				: { marker, seq, frameId, ...(typeof step.reason === "string" ? { reason: step.reason } : {}) };
	// Real path: the attach client sanitizes and seq-checks the record, then
	// noteViewProofRecord runs on the component.
	c.onSocketData(`${JSON.stringify({ type: "view_proof", record })}\n`);
}

/** Same-baseline coverage update through the REAL client path: a
 *  view_proof_state message is sanitized by the client and re-emitted as the
 *  component's `viewProof` event — the wire shape for no-proof / output-gap /
 *  runner coverage updates that arrive WITHOUT a new snapshot (which would
 *  change the baseline identity). */
function applyProofState(h: Harness, step: Record<string, any>): void {
	const c = h.component as any;
	const viewProof = snapshotViewProof(step, c);
	if (viewProof === undefined) throw new Error("proofState requires a proof preset or object");
	c.onSocketData(`${JSON.stringify({ type: "view_proof_state", viewProof })}\n`);
}

function applyGeometry(h: Harness, step: Record<string, any>): void {
	h.tuiTerminal.cols = step.cols;
	h.tuiTerminal.columns = step.cols;
	h.tuiTerminal.rows = step.rows + 2;
	// The real outer-resize path: the next render notices the new size.
	h.component.render(step.cols);
}

/** Issue #284 A09 counterexample (spec §3.1 predicate 4 / parent §8.5): the
 *  real paths keep the parser grid and the target in lockstep, so the state
 *  the predicate defends against — a committed view whose IDENTITY is already
 *  marked with the current target while the captured SOURCE grid stays at the
 *  old size — cannot be produced through them. The op surgically creates exactly
 *  that fact combination (identity axes rewritten to the new target, source
 *  dims and every other axis untouched) so the POLICY's refusal is observable:
 *  identity alone (I3) blesses it, only the recorded source geometry exposes
 *  it. Budget and cap must not publish it. */
function applyDivergeSourceFromTarget(h: Harness, step: Record<string, any>): void {
	const c = h.component as any;
	c.cols += typeof step.cols === "number" ? step.cols : 20;
	c.rows += typeof step.rows === "number" ? step.rows : 6;
	const view = c.committedView;
	if (view !== null && view !== undefined && view.identity != null) {
		view.identity.targetCols = c.cols;
		view.identity.targetRows = c.rows;
	}
}

function applyHoldWrites(h: Harness, state: ScenarioState): void {
	const c = h.component as any;
	if (state.heldTerm !== null) throw new Error("writes already held");
	state.heldTerm = c.term;
	state.heldWrite = c.term.write.bind(c.term);
	c.term.write = (data: string, cb?: () => void) => {
		state.held.push({ data, cb: cb ?? null });
	};
}

async function applyReleaseWrites(h: Harness, state: ScenarioState): Promise<void> {
	if (state.heldTerm === null) return;
	state.heldTerm.write = state.heldWrite;
	const held = state.held.splice(0);
	for (const entry of held) state.heldTerm.write(entry.data, entry.cb ?? undefined);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await settleTicks();
}

interface ScenarioState {
	clockStart: number;
	lastSeq: number;
	held: Array<{ data: string; cb: (() => void) | null }>;
	heldTerm: any;
	heldWrite: ((data: string, cb?: () => void) => void) | null;
	settledAt: number | null;
	wasAttaching: boolean;
	spy: { evaluateAttachReady: number; deferAttachSettle: number; finishAttachTransition: number; restoreLegacyDeadlines: number };
}

/** Count the shared convergence points so stale-callback tests can prove a
 *  fenced callback ran none of them. restoreLegacyDeadlines counts the #284
 *  T5 observable: a latched capability loss must never invoke it. */
function installSpy(component: PtyAttachComponent, state: ScenarioState): void {
	const c = component as any;
	for (const name of ["evaluateAttachReady", "deferAttachSettle", "finishAttachTransition", "restoreLegacyDeadlines"] as const) {
		const original = c[name].bind(component);
		c[name] = (...args: unknown[]) => {
			state.spy[name] += 1;
			return original(...args);
		};
	}
}

/** First non-empty committed row as plain text, so tests can tell the OLD
 *  retained view from a NEW rebuild (no fake refresh, no stale identity). */
function committedPreview(view: unknown): string | null {
	if (view === null || view === undefined) return null;
	for (const row of (view as { rows: Array<{ cells: { translateToString(trimRight?: boolean): string } }> }).rows) {
		const text = row.cells.translateToString(true).trim();
		if (text.length > 0) return text;
	}
	return "";
}

function readout(h: Harness, state: ScenarioState): Record<string, unknown> {
	const c = h.component as any;
	const dueRelative = (handle: unknown): number | null => {
		const due = h.clock.dueOf(handle);
		return due === null ? null : due - state.clockStart;
	};
	const committed = c.committedView;
	const proof = c.latestViewProof;
	return {
		now: h.clock.now(),
		attaching: c.attaching === true,
		closed: c.closed === true,
		attachMode: c.attachMode,
		frameWitnessAvailable: c.frameWitnessAvailable === true,
		witnessLatched: c.witnessLatched === true,
		committedPath: c.modernCommittedMode() === true,
		childInputReady: c.childInputReady === true,
		firstAttachSideEffectsApplied: c.firstAttachSideEffectsApplied === true,
		publishabilityState: c.publishabilityState,
		notReadyReason: c.notReadyReason ?? null,
		deadlineState: c.deadlineState,
		budget: {
			armed: c.budgetArmed ?? null,
			elapsed: c.budgetElapsed ?? null,
			timerPending: (c.attachRecoveryBudgetTimer ?? null) !== null,
			deadline: dueRelative(c.attachRecoveryBudgetTimer ?? null),
			// Attach-lifetime deadline timestamp (virtual or wall, per the
			// injected clock) — the diagnostics field's readout twin.
			deadlineAt: (c.attachStartedAt ?? null) === null ? null : c.attachStartedAt + ATTACH_RECOVERY_BUDGET_MS,
		},
		timers: {
			settlePending: (c.attachSettleTimer ?? null) !== null,
			settleDeadline: dueRelative(c.attachSettleTimer ?? null),
			hardPending: (c.attachHardTimeout ?? null) !== null,
			hardDeadline: dueRelative(c.attachHardTimeout ?? null),
		},
		identity: {
			connectionToken: c.connectionToken,
			baselineToken: c.baselineToken,
			parserEpoch: c.parserEpoch,
			geometryRevision: c.geometryRevision,
			resizeIntentRequired: c.resizeIntentRequired === true,
		},
		committedView:
			committed === null || committed === undefined
				? null
				: {
						present: true,
						connectionToken: committed.identity.connectionToken,
						baselineToken: committed.identity.baselineToken,
						generation: committed.identity.generation,
						rows: committed.rows.length,
						source: committed.source ?? null,
						sourceCols: committed.sourceCols ?? null,
						sourceRows: committed.sourceRows ?? null,
						contentKind: committed.contentKind ?? null,
						identityTargetCols: committed.identity.targetCols ?? null,
						identityTargetRows: committed.identity.targetRows ?? null,
					},
		committedViewValid: c.committedViewValid(),
		committedPreview: committedPreview(committed),
		latestViewProof: proof === null || proof === undefined ? null : { status: proof.status ?? null, reason: proof.reason ?? null },
		// Issue #284 §3.1.1 facts: the last classification assembled for the
		// policy and the sticky-invalid binding (bound baseline token; the
		// effective sticky state is binding === current baselineToken).
		// lastProofStickyInvalid exposes the diagnostic FIELD itself (post-update
		// state) so tests can assert the invalidation/recovery transitions the
		// settle readout records.
		proofStatus: c.lastProofStatus ?? null,
		stickyInvalid: (c.proofInvalidatedBaselineToken ?? null) !== null && c.proofInvalidatedBaselineToken === c.baselineToken,
		stickyBaseline: c.proofInvalidatedBaselineToken ?? null,
		lastProofStickyInvalid: c.lastProofStickyInvalid === true,
		// Issue #288 D1/I8 hard-dominance latch: the baseline token a HARD
		// invalid family classification latched on (effective state:
		// binding === current baselineToken, same as the sticky fact).
		// capRecoverable mirrors the policy fact the component assembles from
		// the latch (spec §2 D1).
		hardInvalidated: (c.proofHardInvalidatedThisBaseline ?? null) !== null && c.proofHardInvalidatedThisBaseline === c.baselineToken,
		hardInvalidatedBaseline: c.proofHardInvalidatedThisBaseline ?? null,
		capRecoverable: (c.proofHardInvalidatedThisBaseline ?? null) !== c.baselineToken,
		// Issue #284 §3.4: which path settled this attach (null while waiting).
		readyReason: c.readyReason ?? null,
		diagnosticsCount: h.diagnostics.length,
		viewProofRecordCount: c.viewProofRecordCount,
		lastSeq: c.attachClient.getLastSeq(),
		receivedOutput: c.receivedOutput === true,
		localHydrationState: c.localHydrationState,
		protocolBaselineState: c.protocolBaselineState,
		attachWaitToken: c.attachWaitToken,
		callbacks: { ...state.spy },
		settledAt: state.settledAt,
	};
}

async function applyStep(h: Harness, step: Record<string, any>, state: ScenarioState): Promise<void> {
	switch (step.op) {
		case "connect":
		case "reconnect":
			simulateConnect(h.component as any);
			break;
		case "hello":
		case "status": {
			const c = h.component as any;
			const line = {
				type: step.op === "hello" ? "hello" : "status",
				status: { frameWitness: { enabled: step.witness !== false } },
				generation: typeof step.generation === "string" ? step.generation : "gen-1",
			};
			c.onSocketData(`${JSON.stringify(line)}\n`);
			break;
		}
		case "mode":
			(h.component as any).handleAttachEvent("mode", step.value);
			break;
		case "snapshot":
			await applySnapshot(h, step, state);
			break;
		case "output":
			await applyOutput(h, step, state);
			break;
		case "record":
			applyRecord(h, step, state);
			break;
		case "proofState":
			applyProofState(h, step);
			break;
		case "geometry":
			applyGeometry(h, step);
			break;
		case "divergeSourceFromTarget":
			applyDivergeSourceFromTarget(h, step);
			break;
		case "advance":
			h.clock.advance(step.ms);
			break;
		case "holdWrites":
			applyHoldWrites(h, state);
			break;
		case "releaseWrites":
			await applyReleaseWrites(h, state);
			break;
		case "dispose":
			h.component.dispose();
			break;
		case "detach":
			(h.component as any).detach();
			break;
		case "noop":
			break;
		default:
			throw new Error(`unknown op: ${String(step.op)}`);
	}
	await settleTicks();
}

async function runProgram(program: Record<string, any>): Promise<Record<string, unknown>> {
	const startedAt = Date.now();
	const clockStart = typeof program.clockStart === "number" ? program.clockStart : 0;
	const h = createHarness(clockStart);
	const state: ScenarioState = {
		clockStart,
		lastSeq: 0,
		held: [],
		heldTerm: null,
		heldWrite: null,
		settledAt: null,
		wasAttaching: true,
		spy: { evaluateAttachReady: 0, deferAttachSettle: 0, finishAttachTransition: 0, restoreLegacyDeadlines: 0 },
	};
	installSpy(h.component, state);
	const steps: Array<Record<string, unknown>> = [];
	for (const step of Array.isArray(program.steps) ? program.steps : []) {
		await applyStep(h, step, state);
		const attaching = (h.component as any).attaching === true;
		if (state.settledAt === null && state.wasAttaching && !attaching) state.settledAt = h.clock.now();
		state.wasAttaching = attaching;
		steps.push({ op: step.op, readout: readout(h, state) });
	}
	const final = readout(h, state);
	try {
		h.component.dispose();
	} catch {
		/* best effort teardown */
	}
	return {
		ok: true,
		wallMs: Date.now() - startedAt,
		clockStart,
		steps,
		final,
		diagnostics: h.diagnostics,
	};
}

const programText = process.argv[2] ?? "{}";
runProgram(JSON.parse(programText))
	.then((result) => {
		exitAfterStdout(`${JSON.stringify(result)}\n`, result.ok === true ? 0 : 1);
	})
	.catch((err) => {
		process.stderr.write(`attach-recovery-scenario: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(1);
	});
