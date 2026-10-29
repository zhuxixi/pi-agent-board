// Issue #222 step 23b2c2: managed parser replacement + identity/callback fences.
// Run via `node --experimental-transform-types` (TS parameter properties).
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";
import { instrumentInnerParser } from "./pty-attach-ready-scenario.ts";

const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
const keybindings = {} as never;

function harness() {
	const terminalWrites: string[] = [];
	let renders = 0;
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (data: string) => terminalWrites.push(data) },
		requestRender: () => {
			renders += 1;
		},
	};
	const component = new PtyAttachComponent(tui as never, theme, keybindings, () => {}, { socketPath: "/no/such/socket", title: "parser-test" });
	return { component, terminalWrites, renderCount: () => renders };
}

const internals = (component: PtyAttachComponent) => component as unknown as any;

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function emitSnapshot(component: PtyAttachComponent, frame: string | null = "\x1b[2J\x1b[HHELLO", extra: Record<string, unknown> = {}) {
	const c = component as unknown as { handleAttachEvent: (event: string, payload: unknown) => void };
	c.handleAttachEvent("snapshotBegin", { cols: 80, rows: 22 });
	c.handleAttachEvent("snapshotReady", frame === null ? { empty: true, nextSeq: 1, ...extra } : { frame, nextSeq: 1, ...extra });
}

function feedStatusGeneration(component: PtyAttachComponent, generation: string): void {
	(component as unknown as { onSocketData: (text: string) => void }).onSocketData(
		`${JSON.stringify({ type: "status", status: { frameWitness: { enabled: true } }, generation })}\n`,
	);
}

function enterModernCommitted(component: PtyAttachComponent): void {
	const c = component as unknown as any;
	c.attachMode = "protocol";
	c.frameWitnessAvailable = true;
	c.attaching = false;
	c.cols = 80;
	c.rows = 22;
}

function committedFrame(text = "HELLO WORLD", extraRows = ""): string {
	return `\x1b[2J\x1b[H\x1b[?2026h\x1b[1;1H${text}${extraRows}\x1b[?2026l`;
}

function visibleText(component: PtyAttachComponent): string {
	return component.render(80).join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");
}

type Check = { name: string; ok: boolean; error?: string; details?: unknown };
const checks: Check[] = [];
async function check(name: string, fn: () => Promise<unknown> | unknown) {
	try {
		const details = await fn();
		checks.push({ name, ok: true, details });
	} catch (err) {
		checks.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
	}
}

function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}

async function run(): Promise<{ ok: boolean; checks: Check[] }> {
	await check("snapshotReady replaces with observers before the frame", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			const before = c.term;
			(h.component as any).handleAttachEvent("snapshotBegin", { cols: 80, rows: 22 });
			assert(c.term === before, "snapshotBegin must not replace");
			(h.component as any).handleAttachEvent("snapshotReady", { frame: "\x1b[2J\x1b[H\x1b[?2026hHELLO\x1b[?2026l", nextSeq: 1 });
			const after = c.term;
			assert(after !== before, "snapshotReady must replace");
			assert(c.baselineToken === 1, "baselineToken increments");
			assert(c.parserEpoch === 2, "parserEpoch increments");
			assert(after.cols === c.cols && after.rows === c.rows, "same constructor dimensions");
			assert(typeof after.parser.registerCsiHandler === "function", "new parser exposes public hooks");
			await waitFor(() => c.receivedOutput === true, "frame drain");
			const line = after.buffer.active.getLine(0)?.translateToString(true) ?? "";
			assert(/HELLO/.test(line), "new parser parsed the frame");
			assert(c.parserObserverEvents >= 2, "?2026 observers ran");
			assert(c.parserSyncOpen === false, "sync block closed");
			return { parserEpoch: c.parserEpoch, baselineToken: c.baselineToken };
		} finally {
			h.component.dispose();
		}
	});

	await check("RED fix1: snapshotReady adopts fresh viewProof/records facts", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			const oldProof = { status: "covered", reason: "exact-proof", proof: { marker: "F", seq: 1 }, throughSeq: 1, cursorVisible: true };
			const newProof = { status: "covered", reason: "exact-proof", proof: { marker: "F", seq: 2 }, throughSeq: 2, cursorVisible: true };
			c.latestViewProof = oldProof;
			c.viewProofRecords = [{ marker: "F", seq: 1 }];
			c.viewProofRecordCount = 1;
			const freshRecord = { marker: "F", seq: 2 };
			emitSnapshot(h.component, "\x1b[2J\x1b[HFRESH", { viewProof: newProof, viewProofRecords: [freshRecord] });
			assert(c.latestViewProof === newProof, "snapshotReady must adopt the fresh proof");
			assert(c.viewProofRecords.length === 1 && c.viewProofRecords[0] === freshRecord, "records are adopted");
			assert(c.viewProofRecordCount === 1, "record count resets to the current baseline");
			return { latest: c.latestViewProof, count: c.viewProofRecordCount };
		} finally {
			h.component.dispose();
		}
	});

	await check("RED fix1 addendum: resnapshot-with-frame/no-proof is not empty-baseline", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			const oldProof = { status: "covered", reason: "exact-proof", proof: { marker: "F", seq: 1 }, throughSeq: 1, cursorVisible: true };
			c.latestViewProof = oldProof;
			emitSnapshot(h.component, "\x1b[2J\x1b[HFIRST");
			c.latestViewProof = oldProof;
			emitSnapshot(h.component, "\x1b[2J\x1b[HFRAME-AFTER-RESNAPSHOT", { resnapshot: true });
			assert((c.latestViewProof as any) === null || (c.latestViewProof as any)?.reason !== "empty-baseline", "RED: resnapshot-with-frame got empty-baseline reason");
			assert((c as any).protocolBaselineState === "valid-content", "resnapshot with a frame is valid-content");
			return { latest: c.latestViewProof };
		} finally {
			h.component.dispose();
		}
	});

	await check("RED fix1: replacement failure drops subsequent protocol output", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			emitSnapshot(h.component);
			await waitFor(() => c.receivedOutput === true, "initial content");
			const beforeTerm = c.term;
			const beforeText = beforeTerm.buffer.active.getLine(0)?.translateToString(true) ?? "";
			const originalInstall = c.installParserObservers.bind(h.component);
			c.installParserObservers = () => [];
			const client = c.attachClient;
			let resyncs = 0;
			let legacies = 0;
			const originalResync = client.requestResync.bind(client);
			const originalLegacy = client.forceLegacy.bind(client);
			client.requestResync = (reason?: string) => { resyncs += 1; return originalResync(reason); };
			client.forceLegacy = (reason?: string) => { legacies += 1; return originalLegacy(reason); };
			for (let attempt = 0; attempt < 4; attempt += 1) {
				(h.component as any).handleAttachEvent("snapshotBegin", { cols: 80, rows: 22 });
				(h.component as any).handleAttachEvent("snapshotReady", { frame: `\x1b[2J\x1b[HFAILED-${attempt}`, nextSeq: 2 + attempt });
				(h.component as any).handleAttachEvent("output", `LEAKED-LIVE-BYTES-${attempt}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
			const afterText = beforeTerm.buffer.active.getLine(0)?.translateToString(true) ?? "";
			assert(!afterText.includes("LEAKED-LIVE-BYTES"), "RED: failed replacement leaked live output into old parser");
			assert(c.localHydrationState === "failed", "replacement failure state persists");
			assert(resyncs === 3, `bounded fresh resync attempts: ${resyncs}`);
			assert(legacies === 1, `legacy forced after the third retry: ${legacies}`);
			c.installParserObservers = originalInstall;
			return { beforeText, afterText, resyncs, legacies };
		} finally {
			h.component.dispose();
		}
	});

	await check("RED fix1: observer-unavailable constructor falls back to legacy", async () => {
		const proto = PtyAttachComponent.prototype as any;
		const original = proto.installParserObservers;
		proto.installParserObservers = () => [];
		let component: PtyAttachComponent | null = null;
		try {
			let error: unknown = null;
			try {
				const h = harness();
				component = h.component;
			} catch (err) {
				error = err;
			}
			assert(error === null, `constructor threw (${error instanceof Error ? error.message : String(error)})`);
			assert((component as any).attachMode === "legacy", "observer-unavailable forced legacy");
			assert((component as any).attachClient.getMode() === "legacy", "client capability is legacy");
			return { mode: (component as any)?.attachMode };
		} finally {
			proto.installParserObservers = original;
			component?.dispose?.();
		}
	});

	await check("RED fix1: shared instrument captures the first post-replacement enqueue+drain", async () => {
		const h = harness();
		const c = internals(h.component);
		const log: any[] = [];
		const detach = instrumentInnerParser(h.component, log as never);
		try {
			emitSnapshot(h.component);
			await waitFor(() => c.receivedOutput === true, "first frame");
			const epoch2 = log.filter((event) => event.parserEpoch === 2);
			assert(epoch2.some((event) => event.kind === "enqueue"), "RED: first epoch-2 enqueue missed");
			await waitFor(() => epoch2.some((event) => event.kind === "drain"), "epoch-2 drain");
			return { epoch2: epoch2.filter((event) => event.kind === "enqueue" || event.kind === "drain") };
		} finally {
			detach();
			h.component.dispose();
		}
	});

	await check("late old-parser callback after newer baseline has zero effects", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			const original = c.term;
			let pending: (() => void) | null = null;
			c.term = {
				write(_data: string, callback?: () => void) {
					pending = callback ?? null;
				},
				resize() {},
				reset() {},
				buffer: { active: { baseY: 0, type: "normal", length: 1, getLine: () => undefined } },
				parser: { registerCsiHandler: () => ({ dispose() {} }) },
			};
			c.parserObservers = [];
			c.pushOutput("OLD", { authoritative: true, scrollbackLines: 0 });
			assert(typeof pending === "function", "old callback captured");
			(h.component as any).handleAttachEvent("snapshotBegin", { cols: 80, rows: 22 });
			(h.component as any).handleAttachEvent("snapshotReady", { frame: "\x1b[2J\x1b[HNEW", nextSeq: 1 });
			await waitFor(() => c.receivedOutput === true && c.localHydrationState === "complete", "new frame");
			c.historyFloor = 77;
			c.attachSettleTimer = "sentinel";
			let settleCalls = 0;
			let renderRequests = 0;
			c.deferAttachSettle = () => {
				settleCalls += 1;
			};
			c.outputRenderScheduler.request = () => {
				renderRequests += 1;
			};
			c.latestViewProof = "proof-sentinel";
			(pending as unknown as () => void)();
			assert(c.historyFloor === 77, "old callback cannot rewrite floor");
			assert(c.attachSettleTimer === "sentinel", "old callback cannot reschedule settle");
			assert(settleCalls === 0 && renderRequests === 0, "old callback cannot request work");
			assert(c.latestViewProof === "proof-sentinel", "old callback cannot alter proof facts");
			original.dispose?.();
			return { staleSettle: settleCalls, staleRender: renderRequests };
		} finally {
			h.component.dispose();
		}
	});

	await check("same-parser reconnect invalidates old-connection callback", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			let pending: (() => void) | null = null;
			const term = c.term;
			const originalWrite = term.write.bind(term);
			term.write = (data: string, cb?: () => void) => originalWrite(data, () => (pending = cb ?? null));
			c.pushOutput("OLD-CONNECTION", { authoritative: true, scrollbackLines: 0 });
			await waitFor(() => typeof pending === "function", "old-connection callback captured");
			c.connectionToken += 1;
			let settleCalls = 0;
			let renderRequests = 0;
			c.deferAttachSettle = () => {
				settleCalls += 1;
			};
			c.outputRenderScheduler.request = () => {
				renderRequests += 1;
			};
			(pending as unknown as () => void)();
			assert(settleCalls === 0 && renderRequests === 0, "stale connection callback fenced");
			term.write = originalWrite;
			return { settleCalls, renderRequests };
		} finally {
			h.component.dispose();
		}
	});

	await check("dispose invalidates callbacks and releases observers", async () => {
		const h = harness();
		const c = internals(h.component);
		let pending: (() => void) | null = null;
		const term = c.term;
		const originalWrite = term.write.bind(term);
		term.write = (data: string, cb?: () => void) => originalWrite(data, () => (pending = cb ?? null));
		c.pushOutput("PENDING", { authoritative: true });
		await waitFor(() => typeof pending === "function", "dispose callback captured");
		h.component.dispose();
		assert((h.component as any).closed === true, "closed flag");
		assert(c.parserObservers.length === 0, "observers released");
		let settleCalls = 0;
		c.deferAttachSettle = () => {
			settleCalls += 1;
		};
		(pending as unknown as () => void)();
		assert(settleCalls === 0, "disposed callback fenced");
		return { settleCalls };
	});

	await check("empty/resnapshot replaces content and clears floor without first hooks", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			emitSnapshot(h.component);
			await waitFor(() => c.receivedOutput === true, "initial content");
			c.historyFloor = 9;
			let finishCalls = 0;
			const originalFinish = c.finishAttachTransition.bind(h.component);
			c.finishAttachTransition = () => {
				finishCalls += 1;
				originalFinish();
			};
			(h.component as any).handleAttachEvent("snapshotBegin", { cols: 80, rows: 22 });
			(h.component as any).handleAttachEvent("snapshotReady", { empty: true, nextSeq: 1 });
			assert(c.historyFloor === 0, "floor cleared");
			const text = c.term.buffer.active.getLine(0)?.translateToString(true) ?? "";
			assert(text === "", "old content removed");
			assert(c.protocolBaselineState === "valid-empty", "baseline fact empty");
			assert(c.firstAttachSideEffectsApplied === false, "first side-effect fact unchanged");
			assert(finishCalls === 0 && (h.component as any).attaching === true, "no first hooks on replacement");
			return { finishCalls, text };
		} finally {
			h.component.dispose();
		}
	});

	await check("creation/observer failure writes nothing to the old parser", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			emitSnapshot(h.component);
			await waitFor(() => c.receivedOutput === true, "initial content");
			const beforeTerm = c.term;
			const beforeText = beforeTerm.buffer.active.getLine(0)?.translateToString(true) ?? "";
			const beforeEpoch = c.parserEpoch;
			const beforeBaseline = c.baselineToken;
			const originalInstall = c.installParserObservers.bind(h.component);
			c.installParserObservers = () => [];
			(h.component as any).handleAttachEvent("snapshotBegin", { cols: 80, rows: 22 });
			(h.component as any).handleAttachEvent("snapshotReady", { frame: "\x1b[2J\x1b[HFAILED-REPLACEMENT", nextSeq: 2 });
			assert(c.term === beforeTerm, "old parser retained");
			assert(c.parserEpoch === beforeEpoch && c.baselineToken === beforeBaseline, "identity unchanged");
			const afterText = beforeTerm.buffer.active.getLine(0)?.translateToString(true) ?? "";
			assert(afterText === beforeText, "no write to old parser");
			c.installParserObservers = originalInstall;
			return { beforeEpoch, beforeBaseline };
		} finally {
			h.component.dispose();
		}
	});

	await check("instrumentInnerParser reattaches per replacement with ordered identities", async () => {
		const h = harness();
		const c = internals(h.component);
		const log: unknown[] = [];
		const detach = instrumentInnerParser(h.component, log as never);
		try {
			emitSnapshot(h.component);
			await waitFor(() => c.receivedOutput === true, "first frame");
			await waitFor(() => (log as any[]).filter((event) => event.kind === "parser-attach").length >= 1, "first attach");
			(h.component as any).handleAttachEvent("snapshotBegin", { cols: 80, rows: 22 });
			(h.component as any).handleAttachEvent("snapshotReady", { frame: "\x1b[2J\x1b[H\x1b[?2026hSECOND\x1b[?2026l", nextSeq: 2 });
			await waitFor(() => c.receivedOutput === true, "second frame");
			await waitFor(() => (log as any[]).filter((event) => event.kind === "parser-attach").length >= 3, "reattach");
			c.pushOutput("AFTER-REATTACH", { forwardProtocols: true });
			await waitFor(() => (log as any[]).some((event) => event.kind === "enqueue" && event.parserEpoch === 3), "observed epoch-3 write");
			const events = log as any[];
			const attaches = events.filter((event) => event.kind === "parser-attach");
			assert(attaches.length >= 3, "initial + two replacement attachments");
			assert(attaches[0].parserEpoch === 1 && attaches[0].baselineToken === 0, "initial identity");
			assert(attaches.some((event: any) => event.parserEpoch === 2 && event.baselineToken === 1), "first replacement identity");
			assert(attaches.at(-1).parserEpoch === 3 && attaches.at(-1).baselineToken === 2, "second replacement identity");
			assert(events.some((event) => event.kind === "enqueue" && event.parserEpoch === 3), "new parser write observed");
			const stale = events.filter((event) => (event.kind === "drain" || event.kind === "csi-open" || event.kind === "csi-close") && event.stale === true);
			assert(stale.length === 0, "no late callback in clean replacement");
			return { attaches, stale: stale.length };
		} finally {
			detach();
			h.component.dispose();
		}
	});

	await check("step25: post-proof replay must be contiguous or coverage fails closed", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			c.attachMode = "protocol";
			c.frameWitnessAvailable = true;
			c.latestViewProof = { status: "covered", reason: "safe-trailing", proof: { marker: "F", seq: 1 }, throughSeq: 1 };
			c.recentProtocolOutput = [{ seq: 2, data: "\x1b[?25l" }, { seq: 4, data: "\x1b[?25l" }];
			c.attachClient.getLastSeq = () => 4;
			c.noteViewProofRecord({ marker: "F", seq: 1, frameId: 1, metadata: {} });
			assert(c.latestViewProof.status === "unknown", "a replay gap must invalidate coverage");
			assert(c.latestViewProof.reason === "view-proof-replay-gap", `gap reason retained: ${String(c.latestViewProof.reason)}`);
			return { reason: c.latestViewProof.reason };
		} finally {
			h.component.dispose();
		}
	});

	await check("step25: synchronous parser write throw restores the in-flight counter", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			c.parserWritesInFlight = 0;
			c.term.write = () => { throw new Error("write boom"); };
			c.pushOutput("THROW");
			assert(c.parserWritesInFlight === 0, "throw must not strand the counter");
			return { parserWritesInFlight: c.parserWritesInFlight };
		} finally {
			h.component.dispose();
		}
	});

	await check("step25: stale-epoch callback never cancels a newer in-flight count", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			let pending: (() => void) | null = null;
			c.term.write = (_data: string, callback?: () => void) => { pending = callback ?? null; };
			c.parserWritesInFlight = 0;
			c.pushOutput("OLD");
			assert(c.parserWritesInFlight === 1, "old write counted");
			c.parserEpoch += 1;
			c.parserWritesInFlight = 1;
			(pending as unknown as (() => void))();
			assert(c.parserWritesInFlight === 1, "stale callback must return before decrement");
			return { parserWritesInFlight: c.parserWritesInFlight };
		} finally {
			h.component.dispose();
		}
	});

	await check("step25 fix1: display-A/parser-B selection, copy, word and interaction range stay committed", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			enterModernCommitted(h.component);
			emitSnapshot(h.component, committedFrame());
			await waitFor(() => c.committedView !== null, "committed A");
			c.pushOutput("\x1b[2J\x1b[HPARSER-B", { forwardProtocols: true });
			await waitFor(() => c.term.buffer.active.getLine(0)?.translateToString(true).includes("PARSER-B") === true, "parser B mutated");
			assert(c.committedView.rows[0].cells.translateToString(true) === "HELLO WORLD", "committed grid remains A");
			c.selection = { anchor: { line: 0, col: 0 }, focus: { line: 0, col: 10 } };
			assert(c.selectionText() === "HELLO WORLD", "copy text comes from committed A, not parser B");
			const beforeCopies = h.terminalWrites.filter((entry) => entry.includes("\x1b]52;c;")).length;
			c.copySelectionToClipboard();
			const copies = h.terminalWrites.filter((entry) => entry.includes("\x1b]52;c;"));
			assert(copies.length === beforeCopies + 1, "committed selection copied once");
			c.selectWordAtPoint({ line: 0, col: 1 });
			assert(c.selectionText() === "HELLO", "word selection uses committed A");
			return { committed: c.committedView.rows[0].cells.translateToString(true), copies: copies.length };
		} finally {
			h.component.dispose();
		}
	});

	await check("step25 fix2: OSC8 and plain URL hits stay on committed A after parser B URLs differ", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			enterModernCommitted(h.component);
			emitSnapshot(h.component, committedFrame("A-PLAIN https://a.example/one", "\x1b[2;1Hhttps://a.example/one\x1b[3;1H\x1b]8;;https://a.example/osc\x07A-OSC\x1b]8;;\x07"));
			await waitFor(() => c.committedView !== null, "committed links A");
			c.pushOutput("\x1b[2J\x1b[H\x1b[2;1Hhttps://b.example/two\x1b[3;1H\x1b]8;;https://b.example/osc\x07B-OSC\x1b]8;;\x07", { forwardProtocols: true });
			await waitFor(() => c.term.buffer.active.getLine(1)?.translateToString(true).includes("b.example") === true, "parser B links mutated");
			assert(c.linkAtPoint({ line: 1, col: 3 }) === "https://a.example/one", "plain hit remains committed A");
			assert(c.linkAtPoint({ line: 2, col: 2 }) === "https://a.example/osc", "OSC8 hit remains committed A");
			assert(c.term.buffer.active.getLine(1)?.translateToString(true).includes("b.example") === true, "parser B really differs");
			return { plain: c.linkAtPoint({ line: 1, col: 3 }), osc8: c.linkAtPoint({ line: 2, col: 2 }) };
		} finally {
			h.component.dispose();
		}
	});

	await check("step25 fix1: CJK width/copy and background attrs survive the committed snapshot", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			enterModernCommitted(h.component);
			emitSnapshot(h.component, committedFrame("\x1b[41mBG\x1b[0m", "\x1b[2;1H你好世界"));
			await waitFor(() => c.committedView !== null, "committed CJK");
			c.selection = { anchor: { line: 1, col: 0 }, focus: { line: 1, col: 7 } };
			assert(c.selectionText() === "你好世界", "wide CJK copy");
			const render = h.component.render(80).join("\n");
			assert(render.includes("BG"), "background text retained");
			const bgCell = c.committedView.rows[0].cells.getCell(0);
			assert(bgCell?.isBgPalette() === true && bgCell.getBgColor() === 1, "background palette attribute retained");
			assert(c.committedView.rows[1].cells.getCell(0)?.getWidth() === 2, "CJK leading cell width retained");
			return { text: c.selectionText(), width: c.committedView.rows[1].cells.getCell(0)?.getWidth() };
		} finally {
			h.component.dispose();
		}
	});

	await check("step25 fix2: open-block scroll records intent and applies it only at the real close", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			enterModernCommitted(h.component);
			emitSnapshot(h.component, committedFrame());
			await waitFor(() => c.committedView !== null, "committed scroll view");
			c.pushOutput("\x1b[?2026h" + Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\r\n"), { forwardProtocols: true });
			await waitFor(() => c.parserSyncOpen === true, "parser sync block really open");
			await waitFor(() => c.term.buffer.active.length > 22, "scroll history created inside open block");
			c.viewportTop = null;
			const before = h.component.render(80).join("\n");
			const forwarded = c.tryScrollBy(1) === false;
			assert(forwarded === true, "modern wheel always returns false for child forwarding");
			assert(c.viewportTop !== null, "viewport intent recorded while open");
			const intent = c.viewportTop;
			assert(h.component.render(80).join("\n") === before, "display stays on committed A while open");
			c.pushOutput("\x1b[?2026l", { forwardProtocols: true });
			await waitFor(() => c.parserSyncOpen === false && c.committedView !== null && c.committedView.start === intent, "close applies intent");
			const bottom = Math.max(0, c.term.buffer.active.length - 22);
			assert(c.committedView.start < bottom, "close did not force the bottom");
			assert(h.component.render(80).join("\n") !== before, "verified close paints the intended complete range");
			return { forwarded, intent, start: c.committedView.start, bottom };
		} finally {
			h.component.dispose();
		}
	});

	await check("step25 fix1: hydration ending open commits nothing until a real close", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			enterModernCommitted(h.component);
			(h.component as any).handleAttachEvent("snapshotBegin", { cols: 80, rows: 22 });
			(h.component as any).handleAttachEvent("snapshotReady", { frame: "\x1b[2J\x1b[H\x1b[?2026hOPEN-CONTENT", nextSeq: 1 });
			await waitFor(() => c.localHydrationState === "complete", "hydration complete");
			assert(c.committedView === null, "open hydration does not commit");
			c.pushOutput("\x1b[?2026l", { forwardProtocols: true });
			await waitFor(() => c.committedView !== null, "later real close commits");
			return { committedRows: c.committedView.rows.length };
		} finally {
			h.component.dispose();
		}
	});

	await check("step25 fix2: post-close DECTCEM is parser-drained but leaves the committed grid unchanged", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			enterModernCommitted(h.component);
			emitSnapshot(h.component, committedFrame());
			await waitFor(() => c.committedView !== null, "committed before DECTCEM");
			const before = h.component.render(80).join("\n");
			const beforeCursor = { ...c.committedView.cursor };
			let drained = false;
			const originalWrite = c.term.write.bind(c.term);
			c.term.write = (data: string, callback?: () => void) => originalWrite(data, () => {
				drained = true;
				callback?.();
			});
			c.pushOutput("\x1b[?25l", { forwardProtocols: true });
			await waitFor(() => drained === true, "DECTCEM parser drain");
			c.term.write = originalWrite;
			assert(h.component.render(80).join("\n") === before, "DECTCEM cannot paint a new grid");
			assert(c.committedView.cursor.row === beforeCursor.row && c.committedView.cursor.col === beforeCursor.col, "cursor position unchanged");
			return { beforeCursor, afterCursor: c.committedView.cursor, drained };
		} finally {
			h.component.dispose();
		}
	});

	await check("step26 fix2: every early sync advances; next render consumes one; divergence/A same-size", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			c.cols = 80;
			c.rows = 22;
			c.geometryRevision = 0;
			c.noteGeometryIntent(80, 22, { early: true });
			c.noteGeometryIntent(80, 22, { early: true });
			assert(c.geometryRevision === 2, "two independent early A mismatches each advance");
			c.resizeIfNeeded(80);
			assert(c.geometryRevision === 2, "the next render consumes the pending early target without another intent");
			// Child/runner diverges externally to B while the local target remains A.
			c.term.resize(100, 28);
			c.noteGeometryIntent(80, 22, { early: true });
			assert(c.geometryRevision === 3, "a later size-sync back to A is a new intent");
			c.resizeIfNeeded(80);
			assert(c.geometryRevision === 3, "only the render consumes the pending pair");
			c.resizeIfNeeded(80);
			assert(c.geometryRevision === 3, "same-size render emits zero intent");
			return { revision: c.geometryRevision };
		} finally {
			h.component.dispose();
		}
	});

	await check("step27: same-generation recovery displays last complete view and interactions", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			enterModernCommitted(h.component);
			feedStatusGeneration(h.component, "gen-1");
			emitSnapshot(h.component, committedFrame("RECOVERY-A"));
			await waitFor(() => c.committedView !== null, "committed recovery A");
			c.captureRecoveryView();
			c.committedView = null;
			c.status = "reconnecting…";
			assert(c.recoveryView !== null, "recovery view retained");
			assert(c.activeCommittedView() !== null, "recovery is displayable");
			assert(c.activeCommittedView().rows[0].cells.translateToString(true) === "RECOVERY-A", "recovery grid is A");
			c.selection = { anchor: { line: 0, col: 0 }, focus: { line: 0, col: 9 } };
			assert(c.selectionText() === "RECOVERY-A", "selection reads recovery view");
			assert(h.component.render(80).join("\n").includes("reconnecting"), "reconnecting status remains visible");
			c.currentWireGeneration = null;
			assert(c.recoveryViewValid() === false, "missing/UNKNOWN current generation fails closed");
			feedStatusGeneration(h.component, "gen-1");
			assert(c.recoveryViewValid() === true, "exact known same generation permits recovery");
			return { recovery: c.recoveryView !== null };
		} finally {
			h.component.dispose();
		}
	});

	await check("step27: new committed content replaces recovery atomically", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			enterModernCommitted(h.component);
			emitSnapshot(h.component, committedFrame("RECOVERY-A"));
			await waitFor(() => c.committedView !== null, "committed A");
			emitSnapshot(h.component, committedFrame("RECOVERY-B"));
			assert(c.recoveryView !== null, "replaceParser captures the current A view before nonempty resnapshot");
			assert(c.recoveryView.rows[0].cells.translateToString(true) === "RECOVERY-A", "captured recovery row is A");
			await waitFor(() => c.committedView !== null && c.committedView.rows[0].cells.translateToString(true) === "RECOVERY-B", "committed B");
			assert(c.recoveryView === null, "new committed B replaces recovery atomically");
			assert(c.activeCommittedView().rows[0].cells.translateToString(true) === "RECOVERY-B", "active view is B");
			return { first: c.activeCommittedView().rows[0].cells.translateToString(true) };
		} finally {
			h.component.dispose();
		}
	});

	await check("step27: epoch/empty/geometry/dispose invalidate recovery and current", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			enterModernCommitted(h.component);
			emitSnapshot(h.component, committedFrame("RECOVERY-A"));
			await waitFor(() => c.committedView !== null, "committed A");
			c.captureRecoveryView();
			c.committedView = null;
			(h.component as any).handleAttachEvent("epochReset", {});
			assert(c.recoveryView === null && c.committedView === null, "epoch reset clears both");
			emitSnapshot(h.component, committedFrame("RECOVERY-A"));
			await waitFor(() => c.committedView !== null, "committed A again");
			c.captureRecoveryView();
			(h.component as any).handleAttachEvent("snapshotBegin", { cols: 80, rows: 22, generation: c.recoveryGeneration });
			(h.component as any).handleAttachEvent("snapshotReady", { empty: true, nextSeq: 1 });
			assert(c.recoveryView === null && c.committedView === null, "new empty baseline clears both");
			emitSnapshot(h.component, committedFrame("RECOVERY-A"));
			await waitFor(() => c.committedView !== null, "committed A third");
			c.captureRecoveryView();
			c.geometryRevision += 1;
			assert(c.recoveryViewValid() === false, "geometry change invalidates recovery");
			c.committedView = null;
			c.recoveryView = null;
			emitSnapshot(h.component, committedFrame("RECOVERY-A"));
			await waitFor(() => c.committedView !== null, "committed A before dispose");
			c.captureRecoveryView();
			h.component.dispose();
			assert(c.committedView === null && c.recoveryView === null, "dispose clears committed and recovery");
			return { invalidated: true };
		} finally {
			h.component.dispose();
		}
	});

	await check("step28: old wait-identity deadline callbacks are no-ops; current expiry still fires", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			c.attaching = true;
			c.attachMode = "legacy";
			c.attachWaitToken = 2;
			c.handleAttachSettleTimeout(1);
			assert(c.attaching === true, "old settle identity cannot finish the newer wait");
			c.handleAttachHardTimeout(1);
			assert(c.attaching === true, "old hard identity cannot finish the newer wait");
			c.handleAttachSettleTimeout(2);
			assert(c.attaching === false, "current wait identity can still finish/expire");
			return { currentToken: c.attachWaitToken };
		} finally {
			h.component.dispose();
		}
	});

	await check("step28: close adapter cancels old frame but a later unrelated render still works", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			let cancelled = 0;
			let renders = 0;
			const tui = h.component as unknown as { tui?: unknown };
			const seam = (h.component as unknown as { tui: { cancelRenderTimer?: () => void; renderRequested?: boolean; stopped?: boolean; requestRender: () => void } }).tui;
			seam.cancelRenderTimer = () => { cancelled += 1; };
			seam.renderRequested = true;
			seam.stopped = false;
			seam.requestRender = () => { renders += 1; };
			c.scheduleRender(true);
			assert(renders === 1, "old attach render requested");
			h.component.dispose();
			assert(cancelled === 1, "close used the host cancel seam");
			assert(Boolean(seam.renderRequested) === false, "queued old attach render is cancelled");
			assert(Boolean(seam.stopped) === false, "TUI is not stopped");
			seam.renderRequested = true;
			seam.requestRender();
			assert(Number(renders) === 2, "a new unrelated render request still works");
			assert(Boolean(seam.stopped) === false, "later render is not suppressed");
			void tui;
			void c;
			return { cancelled, renders, stopped: seam.stopped };
		} finally {
			h.component.dispose();
		}
	});

	return { ok: checks.every((entry) => entry.ok), checks };
}

run()
	.then((result) => {
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exit(result.ok ? 0 : 1);
	})
	.catch((err) => {
		process.stderr.write(`parser-replacement-scenario: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(1);
	});
