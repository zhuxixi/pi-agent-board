// Issue #222 step 19 (task-19-brief.md), evidence chain 1: deterministic
// snapshotReady catch-up + multiple parse queue. This is a NEW, separate
// scenario from the accepted attach/S battery and from the step-18 ENTRY
// scenario. It uses the REAL production terminal seams with NO socket/runner:
//
// - REAL `createTerminalModel` on the REAL @xterm/headless parser (never a
//   fake parser, never a timing poll),
// - REAL `createTerminalSubscription` (runner-side snapshot state machine),
// - REAL `createTerminalAttachClient` (UI-side snapshot state machine),
// - `rawSend` is the documented injection seam: when the subscription sends
//   the ACTUAL `snapshot_begin`, the driver synchronously `feedOutput`s F1
//   and F2 into the model. This forces the production-defined post-DTO
//   catch-up (the ring is the gap buffer; nothing is stashed twice), with no
//   timer and no hand-emitted `snapshotReady` — the client validates
//   continuity itself and emits `snapshotReady` before replaying the catch-up.
//
// Assertions are by real wire/event fields: `snapshot_begin.snapshotSeq`
// belongs to F0, `snapshot_frame` paints the literal F0 grid, the two catch-up
// `output` messages carry the exact subsequent seq values with the exact fed
// bytes, `snapshot_end.nextSeq` follows them, and the client's emitted event
// order is snapshotReady BEFORE the F1/F2 catch-up outputs. The parser queue
// (real parser write callbacks, FIFO) is recorded separately from the wire so
// the snapshot-frame parser callback is never mistaken for a catch-up
// callback, and the independent final grid is F2 (F0/F1 must not be mistaken
// for final).
//
// CLI: --case CATCHUP --repeat 1 --clock real --artifact-dir <owned path>.
// Unsupported cases/clocks/repeats fail explicitly (stderr + exit 2, no dummy
// success). A valid invocation prints exactly one JSON result line on stdout.
// Run via `node --experimental-transform-types` (kept for parity with the
// other scenarios; this module has no TS-parameter-property classes and is
// also importable under plain `node --test` for the pure-helper tests).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import xtermHeadless from "@xterm/headless";
import { createTerminalModel, defaultParserFactory, feedOutput, whenIdle } from "../src/core/terminal-model.mjs";
import { createTerminalSubscription } from "../src/core/terminal-attach-protocol.mjs";
import { createTerminalAttachClient } from "../src/core/terminal-attach-client.mjs";

const { Terminal: HeadlessTerminal } = /** @type {any} */ (xtermHeadless);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

export const CATCHUP_COLS = 80;
export const CATCHUP_ROWS = 6;

/**
 * One child output chunk for frame `id`: clear-screen + home, then three
 * deterministic rows. Each chunk is self-contained so the model's parser grid
 * after the LAST feed is unambiguously that frame (F2), and the snapshot frame
 * (F0) repaints the same literal grid on an independent raw terminal.
 */
export function frameData(id: string): string {
	return `\x1b[2J\x1b[H${id} HEADER\r\n${id} BODY\r\n${id} TAIL`;
}

/** Literal viewport rows for frame `id` (rows 3..CATCHUP_ROWS-1 stay blank). */
export function literalRows(id: string): string[] {
	const rows = [`${id} HEADER`, `${id} BODY`, `${id} TAIL`];
	while (rows.length < CATCHUP_ROWS) rows.push("");
	return rows;
}

/** Right-trim one grid row for literal comparison. */
export function rtrimRows(rows: readonly string[]): string[] {
	return rows.map((row) => row.replace(/\s+$/u, ""));
}

export function rowsEqual(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((text, i) => text === expected[i]);
}

/** The frame id carried by a chunk, or null when the chunk carries none. */
export function frameIdOf(data: string): string | null {
	for (const id of ["F0", "F1", "F2"]) {
		if (data.includes(`${id} HEADER`)) return id;
	}
	return null;
}

/** Paint a synthesized snapshot frame on an independent raw terminal. */
export async function paintFrame(frameDataStr: string): Promise<string[]> {
	const raw = new HeadlessTerminal({ cols: CATCHUP_COLS, rows: CATCHUP_ROWS, allowProposedApi: true });
	try {
		await new Promise<void>((resolveWrite) => raw.write(frameDataStr, resolveWrite));
		const painted: string[] = [];
		for (let y = 0; y < CATCHUP_ROWS; y++) painted.push(raw.buffer.active.getLine(y)?.translateToString(true) ?? "");
		return painted;
	} finally {
		raw.dispose();
	}
}

/** One real-parser write boundary (enqueue or drain) with its frame identity. */
export interface ParserQueueEvent {
	seq: number;
	kind: "write-enqueue" | "write-drain";
	frameId: string | null;
	bytes: number | null;
}

/**
 * Parser factory whose returned terminal wraps the REAL `write` to record
 * enqueue and write-callback (drain) boundaries in FIFO order, tagged with the
 * frame id of the fed chunk. This is observational only: the original write
 * and callback still run unchanged (never a parser replacement).
 */
export function makeQueueLoggingParserFactory(queue: ParserQueueEvent[]) {
	return (opts: { cols: number; rows: number; scrollback: number }) => {
		const real = defaultParserFactory(opts);
		const originalWrite = real.write.bind(real);
		(real as unknown as { write: (data: string, cb?: () => void) => void }).write = function (this: unknown, data: string, cb?: () => void) {
			const frameId = frameIdOf(data);
			queue.push({ seq: queue.length, kind: "write-enqueue", frameId, bytes: data.length });
			return originalWrite(data, () => {
				queue.push({ seq: queue.length, kind: "write-drain", frameId, bytes: null });
				cb?.();
			});
		};
		return real;
	};
}

/** Index of the first parser queue event matching a kind+frameId pair. */
export function queueIndexOf(queue: readonly ParserQueueEvent[], kind: ParserQueueEvent["kind"], frameId: string | null): number {
	return queue.findIndex((event) => event.kind === kind && event.frameId === frameId);
}

export interface CatchupWireMessage {
	type: string;
	[key: string]: unknown;
}

export interface CatchupClientEvent {
	event: string;
	payload: unknown;
}

/**
 * The one deterministic catch-up trial: REAL model/subscription/client, real
 * parser queue, and the `rawSend` injection feeding F1/F2 synchronously on the
 * actual `snapshot_begin`. Returns the complete evidence record; never throws
 * on a behavioral finding (findings are computed, not faked).
 */
export async function runCatchupTrial(): Promise<Record<string, unknown>> {
	const queue: ParserQueueEvent[] = [];
	const model = createTerminalModel({
		cols: CATCHUP_COLS,
		rows: CATCHUP_ROWS,
		scrollback: 200,
		parserFactory: makeQueueLoggingParserFactory(queue),
	});
	const wire: Record<string, unknown>[] = [];
	const clientEvents: CatchupClientEvent[] = [];

	const f0Seq = feedOutput(model, frameData("F0"));
	let f1Seq = -1;
	let f2Seq = -1;
	let injected = false;

	const sub = createTerminalSubscription({
		model,
		generation: "catchup-gen",
		send(msg: Record<string, unknown>) {
			wire.push(msg);
			// The production-defined injection seam: when the ACTUAL (non-empty)
			// snapshot_begin is sent, feed the two catch-up chunks synchronously so
			// the runner's post-DTO ring replay catches them. The client is fed the
			// begin first (collecting state), then the frame, then the flush.
			if (msg.type === "snapshot_begin" && msg.empty !== true && !injected) {
				injected = true;
				f1Seq = feedOutput(model, frameData("F1"));
				f2Seq = feedOutput(model, frameData("F2"));
			}
			client.handleMessage(msg);
		},
	} as any);

	const client = createTerminalAttachClient({
		send: (msg) => sub.handleMessage(msg),
		emit: (event, payload) => clientEvents.push({ event, payload }),
		forceLegacy: false,
		clientId: "catchup-client",
	});

	client.start();
	// The snapshot flow spans several async boundaries (capture, then frame
	// synthesis) before the frame/catch-up/end are sent, and the injected
	// F1/F2 parser writes drain on their own callbacks. Drain the real parser
	// and yield macrotasks until the full wire/event/queue sequence is
	// complete — deterministic and bounded, never a timing heuristic.
	for (let i = 0; i < 100; i++) {
		await whenIdle(model);
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (
			clientEvents.some((e) => e.event === "snapshotReady") &&
			clientEvents.filter((e) => e.event === "output").length === 2 &&
			model.pendingWrites === 0
		) {
			break;
		}
	}

	const begin = wire.find((m) => m.type === "snapshot_begin") ?? null;
	const frame = wire.find((m) => m.type === "snapshot_frame") ?? null;
	const end = wire.find((m) => m.type === "snapshot_end") ?? null;
	const outputs = wire.filter((m) => m.type === "output");

	const framePainted = frame && typeof frame.data === "string" ? rtrimRows(await paintFrame(frame.data as string)) : null;
	const finalGrid = rtrimRows(
		Array.from({ length: CATCHUP_ROWS }, (_, y) => (model.parser as unknown as { buffer: { active: { getLine: (n: number) => { translateToString: (t: boolean) => string } | null } } }).buffer.active.getLine(y)?.translateToString(true) ?? ""),
	);

	const snapshotReadyIndex = clientEvents.findIndex((e) => e.event === "snapshotReady");
	const firstOutputIndex = clientEvents.findIndex((e) => e.event === "output");
	const eventTypes = clientEvents.map((e) => e.event);

	const outputSeqs = outputs.map((m) => (typeof m.seq === "number" ? m.seq : null));
	const outputData = outputs.map((m) => (typeof m.data === "string" ? m.data : null));

	const f0Enq = queueIndexOf(queue, "write-enqueue", "F0");
	const f0Drain = queueIndexOf(queue, "write-drain", "F0");
	const f1Enq = queueIndexOf(queue, "write-enqueue", "F1");
	const f1Drain = queueIndexOf(queue, "write-drain", "F1");
	const f2Enq = queueIndexOf(queue, "write-enqueue", "F2");
	const f2Drain = queueIndexOf(queue, "write-drain", "F2");

	const verdict = {
		// snapshotSeq belongs to F0.
		snapshotSeqBelongsToF0: begin !== null && begin.snapshotSeq === f0Seq,
		beginSnapshotSeq: begin?.snapshotSeq ?? null,
		f0Seq,
		// snapshot_frame repaints the literal F0 grid on an independent parser.
		frameIsF0: framePainted !== null && rowsEqual(framePainted, literalRows("F0")),
		framePainted,
		// Catch-up outputs carry the exact subsequent seq values and exact bytes.
		outputSeqsExact: JSON.stringify(outputSeqs) === JSON.stringify([f1Seq, f2Seq]) && f1Seq === f0Seq + 1 && f2Seq === f1Seq + 1,
		outputSeqs,
		f1Seq,
		f2Seq,
		outputDataExact:
			outputData.length === 2 && outputData[0] === frameData("F1") && outputData[1] === frameData("F2"),
		outputData,
		// snapshot_end.nextSeq follows F2.
		endNextSeqFollowsF2: end !== null && end.nextSeq === f2Seq + 1,
		endNextSeq: end?.nextSeq ?? null,
		// The client emitted validated snapshotReady BEFORE the F1/F2 outputs.
		snapshotReadyBeforeCatchup:
			snapshotReadyIndex !== -1 &&
			firstOutputIndex !== -1 &&
			snapshotReadyIndex < firstOutputIndex &&
			eventTypes.filter((e) => e === "output").length === 2,
		eventTypes,
		snapshotReadyIndex,
		firstOutputIndex,
		// No duplication, no reordering, no dropped flush.
		noDuplicateNoReorderNoDrop: outputs.length === 2 && outputSeqs[0] === f0Seq + 1 && outputSeqs[1] === f0Seq + 2,
		outputCount: outputs.length,
		// Parser queue: the snapshot-frame callback is separate and precedes the
		// catch-up enqueues; multiple writes retain their true FIFO order.
		parserQueue: {
			order: queue.map((e) => `${e.kind}:${e.frameId ?? "?"}`),
			snapshotFrameParsedBeforeCatchupEnqueue: f0Enq !== -1 && f0Drain !== -1 && f0Enq < f0Drain && f0Drain < f1Enq,
			multipleWritesRetainQueueOrder: f1Enq !== -1 && f1Drain !== -1 && f2Enq !== -1 && f2Drain !== -1 && f1Enq < f2Enq && f1Drain < f2Drain,
			f0Enq,
			f0Drain,
			f1Enq,
			f1Drain,
			f2Enq,
			f2Drain,
		},
		// The independent final model grid is F2; F0/F1 are not mistaken for final.
		finalGridIsF2: rowsEqual(finalGrid, literalRows("F2")),
		finalGrid,
		finalGridNotF0: !rowsEqual(finalGrid, literalRows("F0")),
		finalGridNotF1: !rowsEqual(finalGrid, literalRows("F1")),
		mode: client.getMode(),
		lastSeq: client.getLastSeq(),
	};

	return { verdict, wire, clientEvents, parserQueue: queue, f0Seq, f1Seq, f2Seq };
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The one catch-up case: run the deterministic trial, write the evidence, and
 *  return the JSON result record. The artifact dir must not already exist. */
export async function runCatchupCase(options: { artifactDir: string }): Promise<Record<string, unknown>> {
	const { artifactDir } = options;
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists (overwrite refused): ${artifactDir}`);
	mkdirSync(artifactDir, { recursive: true });
	const scenarioHash = sha256File(join(REPO_ROOT, "test-support/attach-ready-catchup-scenario.ts"));
	const declared = {
		caseId: "CATCHUP",
		seam: "real createTerminalModel/createTerminalSubscription/createTerminalAttachClient; rawSend feeds F1/F2 synchronously on the actual snapshot_begin",
		frames: { F0: frameData("F0"), F1: frameData("F1"), F2: frameData("F2") },
		note: "deterministic behavior contract, not a performance distribution; no socket/runner/timer involved",
	};
	writeFileSync(join(artifactDir, "expectation.json"), JSON.stringify({ declared }, null, 2));

	const result = await runCatchupTrial();
	writeFileSync(join(artifactDir, "wire.json"), JSON.stringify(result.wire, null, 2));
	writeFileSync(join(artifactDir, "client-events.json"), JSON.stringify(result.clientEvents, null, 2));
	writeFileSync(join(artifactDir, "parser-queue.json"), JSON.stringify(result.parserQueue, null, 2));

	const verdict = result.verdict as Record<string, unknown>;
	const ok = Object.entries(verdict)
		.filter(([key]) => typeof verdict[key] === "boolean")
		.every(([, value]) => value === true);
	const record: Record<string, unknown> = {
		ok,
		caseId: "CATCHUP",
		repeat: 1,
		clock: "real",
		declared,
		...result,
		scenarioHash,
		error: null,
		artifactDir,
	};
	writeFileSync(join(artifactDir, "summary.json"), JSON.stringify(record, null, 2));
	return record;
}

// ---------------------------------------------------------------------------
// CLI surface (approved): --case CATCHUP --repeat 1 --clock real --artifact-dir
// <owned path>. Anything else fails explicitly (stderr + exit 2, no dummy
// success). A valid invocation runs the trial and prints exactly one JSON line.
// ---------------------------------------------------------------------------

function cliError(message: string): never {
	process.stderr.write(`attach-ready-catchup-scenario: ${message}\n`);
	process.exit(2);
}

export function parseCli(argv: string[]): { caseId: string; repeat: number; clock: string; artifactDir: string } {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i].startsWith("--") || i + 1 >= argv.length) cliError(`malformed arguments: ${argv.join(" ")}`);
		args.set(argv[i].slice(2), argv[i + 1]);
	}
	const caseId = args.get("case") ?? cliError("missing --case");
	if (caseId !== "CATCHUP") cliError(`unsupported --case ${JSON.stringify(caseId)} (only CATCHUP is implemented)`);
	const repeat = Number(args.get("repeat") ?? cliError("missing --repeat"));
	if (repeat !== 1) cliError(`unsupported --repeat ${JSON.stringify(args.get("repeat"))} (only 1 is implemented)`);
	const clock = args.get("clock") ?? cliError("missing --clock");
	if (clock !== "real") cliError(`unsupported --clock ${JSON.stringify(clock)} (only "real" is implemented)`);
	const artifactDir = args.get("artifact-dir") ?? cliError("missing --artifact-dir");
	return { caseId, repeat, clock, artifactDir };
}

const isMain = (() => {
	try {
		return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
	} catch {
		return false;
	}
})();

if (isMain) {
	const cli = parseCli(process.argv.slice(2));
	if (existsSync(cli.artifactDir)) cliError(`artifact dir already exists (overwrite refused): ${cli.artifactDir}`);
	runCatchupCase({ artifactDir: cli.artifactDir })
		.then((result) => {
			process.stdout.write(JSON.stringify(result) + "\n");
			process.exit(0);
		})
		.catch((err) => {
			process.stderr.write(`attach-ready-catchup-scenario: trial harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
			process.exit(1);
		});
}
