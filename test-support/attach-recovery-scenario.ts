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
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";
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
	});
	return { clock, component, tuiTerminal, terminalWrites, renderCount: () => renders };
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
 *  probe timer; snapshot_begin is accepted from probing either way). */
function simulateConnect(c: any): void {
	c.outputRenderScheduler.cancel();
	c.captureRecoveryView();
	c.connected = true;
	c.everConnected = true;
	c.connectionToken += 1;
	c.committedView = null;
	c.currentWireGeneration = null;
	c.emptyResetPending = true;
	c.disconnectedAt = null;
	c.status = c.recoveryView !== null ? "reconnecting…" : "attached";
	if (c.attachMode === "protocol") c.attachClient.reconnect(c.attachClient.getLastSeq());
	c.startAttachSettle();
}

/** Snapshot viewProof presets: the two real arrival shapes per candidate
 *  state (runner coverageFor `unavailable+candidate-*`, live record path
 *  `unknown+candidate-*`), plus missing-evidence and covered shapes. */
const VIEW_PROOF_PRESETS: Record<string, () => Record<string, unknown>> = {
	"unavailable-candidate-open": () => ({ status: "unavailable", reason: "candidate-open", proof: null, throughSeq: null, cursorVisible: null }),
	"unavailable-candidate-aborted": () => ({ status: "unavailable", reason: "candidate-aborted", proof: null, throughSeq: null, cursorVisible: null }),
	"unknown-candidate-open": () => ({ status: "unknown", reason: "candidate-open", proof: null, throughSeq: null, cursorVisible: null }),
	"unknown-candidate-aborted": () => ({ status: "unknown", reason: "candidate-aborted", proof: null, throughSeq: null, cursorVisible: null }),
	"no-proof": () => ({ status: "unknown", reason: "no-proof", proof: null, throughSeq: null, cursorVisible: null }),
	"no-output": () => ({ status: "unknown", reason: "no-output", proof: null, throughSeq: null, cursorVisible: null }),
};

/** Frame-witness F metadata matching the component's current geometry. */
function frameMetadata(c: any): Record<string, unknown> {
	return {
		protocol: 1,
		cols: c.cols,
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
	const cols = typeof step.cols === "number" ? step.cols : c.cols;
	const rows = typeof step.rows === "number" ? step.rows : c.rows;
	const beginSeq = typeof step.beginSeq === "number" ? step.beginSeq : 1;
	const nextSeq = typeof step.nextSeq === "number" ? step.nextSeq : beginSeq + 1;
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
	const data = step.syncClose === false ? raw : `\x1b[?2026h${raw}\x1b[?2026l`;
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
			? { marker, seq, frameId, metadata: step.metadata ?? frameMetadata(c) }
			: marker === "S"
				? { marker, seq, frameId }
				: { marker, seq, frameId, ...(typeof step.reason === "string" ? { reason: step.reason } : {}) };
	// Real path: the attach client sanitizes and seq-checks the record, then
	// noteViewProofRecord runs on the component.
	c.onSocketData(`${JSON.stringify({ type: "view_proof", record })}\n`);
}

function applyGeometry(h: Harness, step: Record<string, any>): void {
	h.tuiTerminal.cols = step.cols;
	h.tuiTerminal.columns = step.cols;
	h.tuiTerminal.rows = step.rows + 2;
	// The real outer-resize path: the next render notices the new size.
	h.component.render(step.cols);
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
	spy: { evaluateAttachReady: number; deferAttachSettle: number; finishAttachTransition: number };
}

/** Count the shared convergence points so stale-callback tests can prove a
 *  fenced callback ran none of them. */
function installSpy(component: PtyAttachComponent, state: ScenarioState): void {
	const c = component as any;
	for (const name of ["evaluateAttachReady", "deferAttachSettle", "finishAttachTransition"] as const) {
		const original = c[name].bind(component);
		c[name] = (...args: unknown[]) => {
			state.spy[name] += 1;
			return original(...args);
		};
	}
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
		publishabilityState: c.publishabilityState,
		notReadyReason: c.notReadyReason ?? null,
		deadlineState: c.deadlineState,
		budget: {
			armed: c.budgetArmed ?? null,
			elapsed: c.budgetElapsed ?? null,
			timerPending: (c.attachRecoveryBudgetTimer ?? null) !== null,
			deadline: dueRelative(c.attachRecoveryBudgetTimer ?? null),
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
					},
		committedViewValid: c.committedViewValid(),
		latestViewProof: proof === null || proof === undefined ? null : { status: proof.status ?? null, reason: proof.reason ?? null },
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
		case "geometry":
			applyGeometry(h, step);
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
		spy: { evaluateAttachReady: 0, deferAttachSettle: 0, finishAttachTransition: 0 },
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
