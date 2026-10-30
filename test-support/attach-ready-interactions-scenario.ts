// Issue #222 step 19 (task-19-brief.md), evidence chains 2–4. Three evidence
// topologies, explicitly separated:
//
// - MAINSCREEN (chain 2): the fixture child (fake-pty-mainscreen-pi.mjs) owns
//   a REAL TuiMainScreen + REAL ProcessTerminal + a CURSOR_MARKER component.
//   The scenario captures the child's stdout bytes and parses them through the
//   accepted AttachPresentationObserver. This is the DIRECT child-renderer
//   cursor-tail proof (the brief's chain 2 is renderer-focused).
// - SELECTION (chain 3): the REAL attach topology — REAL runner/pty-runner.mjs
//   hosting the fixture child on a REAL PTY, a REAL PtyAttachComponent mounted
//   on the accepted observer, and real arrow input driven through the REAL
//   outer TUI inputHandler (observer.inputHandler → TuiAltScreen →
//   PtyAttachComponent → {type:"input"} → runner → child PTY → child
//   SelectList). The child's real getSelectedItem()/focus are fixture truth.
// - SCROLL (chain 4): the same REAL attach topology; real wheel-up SGR input
//   driven through the outer inputHandler, forwarded as a synthesized
//   {type:"input"} SGR report to the child, which scrolls its REAL
//   fullscreen ScrollView. scrollTop/isFollowingEnd/top visible text are
//   fixture truth; the outer grid independently confirms upscroll, post-append
//   stability and scroll-to-end.
//
// - SELECTION-COMPONENT / SCROLL-COMPONENT: the pre-attach direct-stdin
//   component-only supporting evidence (the child's SelectList/ScrollView
//   semantics with piped stdin), relabeled explicitly as NOT attach evidence.
//
// Truths stay independent: child event logs (frameComplete / getSelectedItem /
// scrollTop / isFollowingEnd / top text) are fixture truth; the parent's
// observer grids derive only from captured bytes or the outer attach surface.
// No candidate ready flag is truth; no forced attaching/input/ready/render
// state.
//
// CLI: --case MAINSCREEN|SELECTION|SCROLL|SELECTION-COMPONENT|SCROLL-COMPONENT
// --repeat 1 --clock real --artifact-dir <owned path>. Unsupported
// cases/clocks/repeats fail explicitly (stderr + exit 2, no dummy success). A
// valid invocation prints exactly one JSON result line on stdout. Run via
// `node --experimental-transform-types`.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AttachPresentationObserver, type PresentationObservation } from "./attach-presentation-fixture.ts";
import { WORK_AREA, withDiagTrial } from "./pty-attach-ready-scenario.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const now = () => performance.now();
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

const MAINSCREEN_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-mainscreen-pi.mjs");
const INTERACTIVE_CHILD = resolve(REPO_ROOT, "test-support/fake-pty-interactive-pi.mjs");

function sha256(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function rtrimRows(rows: readonly string[]): string[] {
	return rows.map((row) => row.replace(/\s+$/u, ""));
}

export function rowsEqual(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((text, i) => text === expected[i]);
}

/** All inverse-video cells of one observer grid (width-0 continuation cells are
 *  skipped so a wide glyph is never double-counted). Recorded as DATA. */
export function inverseCellsOf(observation: PresentationObservation): Array<{ x: number; y: number }> {
	const points: Array<{ x: number; y: number }> = [];
	for (let y = 0; y < observation.grid.length; y++) {
		const cells = observation.grid[y].cells;
		for (let x = 0; x < cells.length; x++) {
			if (cells[x].inverse && cells[x].width !== 0) points.push({ x, y });
		}
	}
	return points;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const start = now();
	while (now() - start < timeoutMs) {
		if (predicate()) return;
		await sleep(20);
	}
	throw new Error(`timed out waiting for: ${label}`);
}

function readEventsSafe(eventsPath: string): any[] {
	try {
		return readFileSync(eventsPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

/** Write an artifact and record any failure (I1: never swallow evidence loss). */
function makeArtifactWriter(artifactDir: string, errors: string[]) {
	return (name: string, value: unknown) => {
		try {
			writeFileSync(join(artifactDir, name), JSON.stringify(value, null, 2));
		} catch (err) {
			errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
}

// ---------------------------------------------------------------------------
// case MAINSCREEN (chain 2): regular renderer cursor tail (direct child renderer)
// ---------------------------------------------------------------------------

const MAIN_ROWS = ["MAIN HEADER", "MAIN BODY one", "MAIN BODY two", "MAIN TAIL", "MAIN INPUT >"];
const MAIN_CURSOR = { x: 11, y: 4 };
const MAIN_COLS = 80;
const MAIN_ROWS_COUNT = 24;
const DETACH_INPUT = "\x1c";

interface OwnedDirectChild {
	child: ChildProcess;
	stdout: string;
	stderr: string;
	eventsPath: string;
	exitCode: number | null;
	signalCode: string | null;
	killed: boolean;
	exited: Promise<unknown>;
}

function spawnDirectChild(childPath: string, env: Record<string, string>, eventsPath: string): OwnedDirectChild {
	const child = spawn(process.execPath, [childPath], {
		env: { ...process.env, ...env, FAKE_PTY_EVENTS_PATH: eventsPath },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const owned: OwnedDirectChild = { child, stdout: "", stderr: "", eventsPath, exitCode: null, signalCode: null, killed: false, exited: new Promise((r) => child.once("exit", r)) };
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		owned.stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		owned.stderr += chunk;
	});
	child.on("exit", (code, signal) => {
		owned.exitCode = code;
		owned.signalCode = signal;
	});
	return owned;
}

async function waitDirectChildExit(owned: OwnedDirectChild, timeoutMs: number): Promise<void> {
	await Promise.race([owned.exited, sleep(timeoutMs)]);
}

async function killDirectChild(owned: OwnedDirectChild): Promise<void> {
	if (owned.exitCode !== null || owned.signalCode !== null) return;
	if (owned.child.pid == null) return;
	try {
		process.kill(owned.child.pid, "SIGKILL");
		owned.killed = true;
	} catch {
		/* already exited */
	}
	await Promise.race([owned.exited, sleep(500)]);
}

export async function runMainscreenCase(options: { artifactDir: string }): Promise<Record<string, unknown>> {
	const { artifactDir } = options;
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists (overwrite refused): ${artifactDir}`);
	mkdirSync(artifactDir, { recursive: true });
	const artifactErrors: string[] = [];
	const writeArtifact = makeArtifactWriter(artifactDir, artifactErrors);
	const declared = {
		caseId: "MAINSCREEN",
		frame: { id: "MAIN", rows: MAIN_ROWS, cursor: MAIN_CURSOR },
		note: "real TuiMainScreen + ProcessTerminal + a focusable CURSOR_MARKER component; the renderer emits sync OPEN/body/CLOSE then the cursor parking + hide tail",
	};
	writeArtifact("expectation.json", { declared });

	const root = mkdtempSync(join(tmpdir(), "s19-mainscreen-"));
	const eventsPath = join(root, "events.jsonl");
	const owned = spawnDirectChild(MAINSCREEN_CHILD, { COLUMNS: String(MAIN_COLS), LINES: String(MAIN_ROWS_COUNT) }, eventsPath);
	let trialError: string | null = null;
	let evidence: Record<string, unknown> = {};

	try {
		await waitFor(() => readEventsSafe(eventsPath).some((e) => e.event === "frameComplete"), 8000, "mainscreen frameComplete");
		await waitDirectChildExit(owned, 5000);
		const events = readEventsSafe(eventsPath);
		const frameComplete = events.find((e) => e.event === "frameComplete") ?? null;
		const observer = new AttachPresentationObserver({ cols: MAIN_COLS, rows: MAIN_ROWS_COUNT });
		observer.write(owned.stdout);
		await observer.whenIdle();
		const frames = observer.observations.filter((o) => o.kind === "frame");
		// Frame-aware close/park/hide: use the frame that paints the literal
		// MAIN grid, and the parking/hide writes that FOLLOW its close write.
		const literalFrame = frames.find((o) => rowsEqual(rtrimRows(o.grid.slice(0, MAIN_ROWS.length).map((r) => r.text)), MAIN_ROWS)) ?? null;
		const fullFrameBlankBelowInput = literalFrame !== null && literalFrame.grid.slice(MAIN_ROWS.length).every((row) => row.text.replace(/\s+$/u, "") === "");
		const frameInverseCells = literalFrame ? inverseCellsOf(literalFrame) : [];
		const lastObservation = observer.observations[observer.observations.length - 1] ?? null;
		// Byte ordering: the CLOSE delimiter, then the parking move, then the
		// final hide. Locate them relative to the literal frame's own write
		// boundary (M2: frame-aware, not global first/last indexes).
		const closeOffsets: number[] = [];
		let searchFrom = 0;
		for (;;) {
			const idx = owned.stdout.indexOf("\x1b[?2026l", searchFrom);
			if (idx === -1) break;
			closeOffsets.push(idx);
			searchFrom = idx + 1;
		}
		const frameCloseOffset = literalFrame ? closeOffsets.find((off) => owned.stdout.slice(0, off).includes("MAIN HEADER")) ?? -1 : -1;
		const parkOffset = frameCloseOffset >= 0 ? owned.stdout.indexOf("\x1b[12G", frameCloseOffset) : -1;
		const hideOffset = frameCloseOffset >= 0 ? owned.stdout.indexOf("\x1b[?25l", frameCloseOffset) : -1;
		const cursorTailFollowsClose = frameCloseOffset !== -1 && parkOffset !== -1 && hideOffset !== -1 && frameCloseOffset < parkOffset && parkOffset < hideOffset;
		evidence = {
			frameMatchesLiteral: literalFrame !== null,
			frameRows: literalFrame ? rtrimRows(literalFrame.grid.slice(0, MAIN_ROWS.length).map((r) => r.text)) : null,
			blankRowsBelowInput: fullFrameBlankBelowInput,
			blankRowsBelowText: literalFrame ? literalFrame.grid.slice(MAIN_ROWS.length).map((r) => r.text.replace(/\s+$/u, "")) : null,
			frameInverseCellsEmpty: frameInverseCells.length === 0,
			frameInverseCells: frameInverseCells,
			noExtraCursor: frameInverseCells.length === 0,
			cursorTailFollowsClose,
			byteOffsets: { frameCloseOffset, parkOffset, hideOffset },
			outerCursorMatches: lastObservation !== null && lastObservation.cursor.x === MAIN_CURSOR.x && lastObservation.cursor.y === MAIN_CURSOR.y && lastObservation.cursor.visible === false,
			outerCursor: lastObservation ? { x: lastObservation.cursor.x, y: lastObservation.cursor.y, visible: lastObservation.cursor.visible } : null,
			frameCompletePresent: frameComplete !== null,
			frameComplete: frameComplete ? { frameId: frameComplete.frameId, sampledDims: frameComplete.sampledDims, closeWriteIndex: frameComplete.closeWriteIndex, tailHideWriteIndex: frameComplete.tailHideWriteIndex, frameBytesSha256: frameComplete.frameBytesSha256, frameBytesLength: frameComplete.frameBytesLength } : null,
			childClock: frameComplete?.clock ?? null,
		};
		writeArtifact("observations.json", observer.observations);
		writeArtifact("writes.json", observer.writes);
		writeArtifact("controls.json", observer.controls);
		observer.dispose();
	} catch (err) {
		trialError = err instanceof Error ? (err.stack ?? err.message) : String(err);
	} finally {
		await killDirectChild(owned);
		writeArtifact("child-stdout-sha256", { sha256: sha256(owned.stdout), bytes: Buffer.byteLength(owned.stdout, "utf8") });
		writeArtifact("child-events.jsonl", readEventsSafe(eventsPath));
		writeArtifact("stderr.txt", { stderr: owned.stderr });
	}

	const ok = trialError === null && artifactErrors.length === 0 && Object.entries(evidence).filter(([k]) => typeof evidence[k] === "boolean").every(([, v]) => v === true);
	if (artifactErrors.length > 0 || trialError !== null) {
		// I1: retain the owned root when evidence writes failed or the trial errored.
	} else {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
	const record: Record<string, unknown> = {
		ok,
		caseId: "MAINSCREEN",
		repeat: 1,
		clock: "real",
		declared,
		evidence,
		childExit: { exitCode: owned.exitCode, signalCode: owned.signalCode, killed: owned.killed },
		scenarioHash: sha256File(join(REPO_ROOT, "test-support/attach-ready-interactions-scenario.ts")),
		artifactErrors,
		error: trialError,
		artifactDir,
	};
	writeArtifact("summary.json", record);
	return record;
}

// ---------------------------------------------------------------------------
// REAL attach cases (chains 3 and 4) through the accepted withDiagTrial shell
// ---------------------------------------------------------------------------

/** Drive one real input through the outer TUI inputHandler and wait for the
 *  count of matching {type:"input"} tx messages to INCREASE (so a repeated
 *  identical input can never pass from an earlier message — R6). Exported for
 *  the repeated-input sequencing unit test. */
export async function driveAttachInput(h: any, data: string, txMatch: (m: any) => boolean, label: string, timeoutMs = 8000): Promise<void> {
	const before = h.txMessages().filter(txMatch).length;
	h.primary.observer.inputHandler(data);
	await waitFor(() => h.txMessages().filter(txMatch).length > before, timeoutMs, label);
}

/** Pure success predicate for a real-attach diag trial (R3): the attach result
 *  is ok only when the diag harness completed, wrote every artifact, its owned
 *  cleanup is proven ok, no teardown violation was recorded, and every boolean
 *  evidence field is true. Exported so the negative gating is unit-tested
 *  without a real runner. */
export function attachOkFromDiag(result: Record<string, unknown>, evidence: Record<string, unknown>): boolean {
	const cleanup = (result.cleanup ?? {}) as Record<string, unknown>;
	const teardownViolations = Array.isArray(result.teardownViolations) ? result.teardownViolations : [];
	return (
		result.ok === true &&
		Array.isArray(result.artifactErrors) &&
		(result.artifactErrors as unknown[]).length === 0 &&
		cleanup.ok === true &&
		teardownViolations.length === 0 &&
		Object.entries(evidence)
			.filter(([k]) => typeof (evidence as any)[k] === "boolean")
			.every(([, v]) => v === true)
	);
}

export async function runSelectionAttachCase(options: { artifactDir: string }): Promise<Record<string, unknown>> {
	const { artifactDir } = options;
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists (overwrite refused): ${artifactDir}`);
	const declared = {
		caseId: "SELECTION",
		topology: "real attach: runner/pty-runner.mjs + PtyAttachComponent + TuiAltScreen observer; real outer inputHandler input",
		items: ["Alpha", "Beta", "Gamma", "Delta"],
		note: "arrow input flows observer.inputHandler → outer TuiAltScreen → PtyAttachComponent → {type:'input'} → runner PTY → child SelectList",
	};

	const result = await withDiagTrial(
		{
			caseId: "SELECTION",
			childPath: INTERACTIVE_CHILD,
			childEnv: (eventsPath) => ({ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_INTERACTIVE_MODE: "selection", FAKE_PTY_EVENTS_PATH: eventsPath }),
			hostCols: WORK_AREA.cols,
			hostRows: WORK_AREA.rows,
			artifactDir,
			attachScreenLog: true,
			forceLegacy: true,
			declared,
		},
		async (h: any) => {
			// The component is the layout root but not auto-focused; focus it so
			// the real outer keyboard input reaches handleInput.
			h.primary.tui.setFocus(h.primary.component);
			await waitFor(() => h.readChildEvents().some((e: any) => e.event === "ready"), 15000, "selection child ready");
			await waitFor(() => h.primary.observer.observations.some((o: any) => o.grid.some((row: any) => row.text.includes("→ Alpha"))), 15000, "outer Alpha rendered");

			// Down arrow → Beta.
			await driveAttachInput(h, "\x1b[B", (m: any) => m.type === "input" && m.msg.data === "\x1b[B", "input tx for down arrow 1");
			await waitFor(() => h.primary.observer.observations.some((o: any) => o.grid.some((row: any) => row.text.includes("→ Beta"))), 15000, "outer Beta rendered");

			// Down arrow → Gamma.
			await driveAttachInput(h, "\x1b[B", (m: any) => m.type === "input" && m.msg.data === "\x1b[B", "input tx for down arrow 2");
			await waitFor(() => h.primary.observer.observations.some((o: any) => o.grid.some((row: any) => row.text.includes("→ Gamma"))), 15000, "outer Gamma rendered");

			const events = h.readChildEvents();
			const selectionEvents = events.filter((e: any) => e.event === "selection").map((e: any) => ({ selectedItem: e.selectedItem, selectedIndex: e.selectedIndex, focusIsSelectList: e.focusIsSelectList }));
			const frames = h.primary.observer.observations.filter((o: any) => o.kind === "frame");
			const frameContains = (text: string) => frames.some((o: any) => o.grid.some((row: any) => row.text.includes(text)));
			const txInputs = h.txMessages().filter((m: any) => m.type === "input").map((m: any) => m.msg.data);

			// Real outer detach (Ctrl+\) — unconditional detach through handleInput.
			h.primary.observer.inputHandler(DETACH_INPUT);
			await waitFor(() => h.txMessages().some((m: any) => m.type === "detach"), 8000, "detach tx");

			return {
				evidence: {
					initialSelectionRendered: frameContains("→ Alpha"),
					selectionChangedToBeta: frameContains("→ Beta"),
					selectionChangedToGamma: frameContains("→ Gamma"),
					selectionEvents,
					selectionEventSequenceMatches: JSON.stringify(selectionEvents.map((e: any) => e.selectedItem?.label)) === JSON.stringify(["Beta", "Gamma"]),
					focusKeptOnSelectList: selectionEvents.length >= 2 && selectionEvents.every((e: any) => e.focusIsSelectList === true),
					txInputs,
					downArrowTxDelivered: txInputs.filter((d: string) => d === "\x1b[B").length >= 2,
					detachTxDelivered: h.txMessages().some((m: any) => m.type === "detach"),
				},
			};
		},
	);

	const attachEvidence = result.evidence as Record<string, unknown> | undefined;
	const attachOk = attachOkFromDiag(result, attachEvidence ?? {});
	const record: Record<string, unknown> = {
		ok: attachOk,
		caseId: "SELECTION",
		repeat: 1,
		clock: "real",
		declared,
		evidence: attachEvidence,
		diagTrial: { ok: result.ok, cleanup: result.cleanup, artifactErrors: result.artifactErrors, teardownViolations: result.teardownViolations ?? [], error: result.error },
		scenarioHash: sha256File(join(REPO_ROOT, "test-support/attach-ready-interactions-scenario.ts")),
		error: result.error ?? null,
		artifactDir,
	};
	// R1: preserve withDiagTrial's original summary.json; write the composite
	// attach result to a distinct file.
	writeFileSync(join(artifactDir, "summary-attach.json"), JSON.stringify(record, null, 2));
	return record;
}

export async function runScrollAttachCase(options: { artifactDir: string }): Promise<Record<string, unknown>> {
	const { artifactDir } = options;
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists (overwrite refused): ${artifactDir}`);
	const declared = {
		caseId: "SCROLL",
		topology: "real attach: runner/pty-runner.mjs + PtyAttachComponent + TuiAltScreen observer; real outer inputHandler wheel input",
		note: "wheel SGR input flows observer.inputHandler → outer TuiAltScreen → PtyAttachComponent.handleMouse → synthesized {type:'input'} SGR wheel → runner PTY → child ScrollView",
	};

	const result = await withDiagTrial(
		{
			caseId: "SCROLL",
			childPath: INTERACTIVE_CHILD,
			childEnv: (eventsPath) => ({ AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1", FAKE_PTY_INTERACTIVE_MODE: "scroll", FAKE_PTY_EVENTS_PATH: eventsPath }),
			hostCols: WORK_AREA.cols,
			hostRows: WORK_AREA.rows,
			artifactDir,
			attachScreenLog: true,
			frameWitness: true,
			declared,
		},
		async (h: any) => {
			// The component is the layout root but not auto-focused; focus it so
			// the real outer keyboard input (detach) reaches handleInput.
			h.primary.tui.setFocus(h.primary.component);
			await waitFor(() => h.readChildEvents().some((e: any) => e.event === "ready"), 15000, "scroll child ready");
			const initial = h.readChildEvents().find((e: any) => e.event === "ready")?.initial ?? null;
			const initialTop = typeof initial?.topText === "string" ? initial.topText : null;
			await waitFor(
				() => initialTop !== null && h.primary.observer.observations.some((o: any) => o.kind === "frame" && o.grid.some((row: any) => row.text.includes(initialTop))),
				15000,
				"outer scroll surface published before wheel input",
			);

			// Real wheel-up SGR input through the outer inputHandler. The attach
			// forwards a synthesized SGR wheel report (encodeWheelReport("up")).
			const wheelUpTx = (m: any) => m.type === "input" && typeof m.msg.data === "string" && (m.msg.data as string).includes("<64;") && (m.msg.data as string).endsWith("M");
			for (let i = 0; i < 3; i++) {
				await driveAttachInput(h, "\x1b[<64;1;1M", wheelUpTx, `wheel-up tx ${i + 1}`);
				await waitFor(() => h.readChildEvents().some((e: any) => e.event === "scroll" && e.phase === `wheel-up-${i + 1}`), 8000, `child wheel-up ${i + 1}`);
			}
			// R2: read the wheel-up top text and wait for the OUTER grid to show it
			// (the attach settles ~250ms after the last wheel output and paints the
			// upscrolled viewport BEFORE the child's delayed append/scroll-to-end).
			const wheel3TopEarly = (() => {
				const ev = h.readChildEvents().find((e: any) => e.event === "scroll" && e.phase === "wheel-up-3") ?? null;
				return typeof ev?.topText === "string" ? ev.topText : null;
			})();
			await waitFor(
				() => wheel3TopEarly !== null && h.primary.observer.observations.some((o: any) => o.kind === "frame" && o.grid.some((row: any) => row.text.includes(wheel3TopEarly))),
				15000,
				"outer grid shows wheel-up top text",
			);
			// Wait for the child's event-driven append + scrollToEnd (real events).
			await waitFor(() => h.readChildEvents().some((e: any) => e.event === "scroll" && e.phase === "post-append"), 10000, "child post-append");
			await waitFor(() => h.readChildEvents().some((e: any) => e.event === "scroll" && e.phase === "scroll-to-end"), 10000, "child scroll-to-end");
			// The child's screen must actually hydrate on the outer attach surface
			// (receivedOutput path) before the grid evidence is read.
			await waitFor(() => h.primary.observer.observations.some((o: any) => o.grid.some((row: any) => row.text.includes("HIST-") || row.text.includes("DOCK"))), 15000, "outer scroll content hydrated");

			const events = h.readChildEvents();
			const scrollEvent = (phase: string) => events.find((e: any) => e.event === "scroll" && e.phase === phase) ?? null;
			const wheel3 = scrollEvent("wheel-up-3");
			const postAppend = scrollEvent("post-append");
			const scrollToEnd = scrollEvent("scroll-to-end");
			const txInputs = h.txMessages().filter((m: any) => m.type === "input").map((m: any) => m.msg.data);
			const wheelTxDelivered = txInputs.filter((d: string) => typeof d === "string" && d.includes("<64;") && d.endsWith("M")).length >= 3;
			// Independent outer-grid evidence: the child's re-render reaches the
			// outer surface. Row 0 is the attach header; row 1 is the first body
			// row (the child screen's rows 2..23, a 2-row clip of the 24-row
			// child viewport — the child's own scrollTop row is clipped at top).
			const frames = h.primary.observer.observations.filter((o: any) => o.kind === "frame");
			const firstBodyRows = frames.map((o: any) => (o.grid[1]?.text ?? "").replace(/\s+$/u, ""));

			// Real outer detach (Ctrl+\).
			h.primary.observer.inputHandler(DETACH_INPUT);
			await waitFor(() => h.txMessages().some((m: any) => m.type === "detach"), 8000, "detach tx");

			return {
				evidence: {
					initial,
					initialFollowsEnd: initial !== null && initial.isFollowingEnd === true,
					wheel3,
					wheelUpscroll: wheel3 !== null && wheel3.isFollowingEnd === false && initial !== null && wheel3.scrollTop === initial.scrollTop - 3,
					postAppend,
					postAppendNoJump: postAppend !== null && wheel3 !== null && postAppend.isFollowingEnd === false && postAppend.scrollTop === wheel3.scrollTop && postAppend.topText === postAppend.topTextBeforeAppend,
					scrollToEnd,
					scrollToEndRestored: scrollToEnd !== null && scrollToEnd.isFollowingEnd === true && postAppend !== null && scrollToEnd.scrollTop > postAppend.scrollTop,
					wheelTxDelivered,
					detachTxDelivered: h.txMessages().some((m: any) => m.type === "detach"),
					firstBodyRows,
					outerGridShowsChildContent: firstBodyRows.some((r: string) => r.includes("HIST-") || r.includes("DOCK") || r.includes("EDITOR")),
					outerGridShowsUpscrollTop: wheel3 !== null && typeof (wheel3 as any)?.topText === "string" && firstBodyRows.includes((wheel3 as any).topText),
					outerGridShowsScrollToEndTop: scrollToEnd !== null && firstBodyRows.includes((scrollToEnd as any)?.topText),
				},
			};
		},
	);

	const attachEvidence = result.evidence as Record<string, unknown> | undefined;
	const attachOk = attachOkFromDiag(result, attachEvidence ?? {});
	const record: Record<string, unknown> = {
		ok: attachOk,
		caseId: "SCROLL",
		repeat: 1,
		clock: "real",
		declared,
		evidence: attachEvidence,
		diagTrial: { ok: result.ok, cleanup: result.cleanup, artifactErrors: result.artifactErrors, teardownViolations: result.teardownViolations ?? [], error: result.error },
		scenarioHash: sha256File(join(REPO_ROOT, "test-support/attach-ready-interactions-scenario.ts")),
		error: result.error ?? null,
		artifactDir,
	};
	// R1: preserve withDiagTrial's original summary.json; write the composite
	// attach result to a distinct file.
	writeFileSync(join(artifactDir, "summary-attach.json"), JSON.stringify(record, null, 2));
	return record;
}

// ---------------------------------------------------------------------------
// Direct-stdin component-only supporting evidence (NOT attach evidence)
// ---------------------------------------------------------------------------

/** Spawn the interactive child on a PIPED stdin (component-only topology) and
 *  drive real input bytes; the child's SelectList/ScrollView semantics are
 *  fixture truth. This is explicitly NOT the attach input chain. */
async function runInteractiveComponentCase(options: { artifactDir: string; mode: "selection" | "scroll"; inputs: string[]; finish?: "detach" | "none" }): Promise<Record<string, unknown>> {
	const { artifactDir, mode, inputs } = options;
	const caseId = mode === "selection" ? "SELECTION-COMPONENT" : "SCROLL-COMPONENT";
	if (existsSync(artifactDir)) throw new Error(`attempt artifact dir already exists (overwrite refused): ${artifactDir}`);
	mkdirSync(artifactDir, { recursive: true });
	const artifactErrors: string[] = [];
	const writeArtifact = makeArtifactWriter(artifactDir, artifactErrors);
	const declared = {
		caseId,
		topology: "direct-stdin component-only supporting evidence (piped child stdin, NOT the attach input chain)",
		mode,
	};
	writeArtifact("expectation.json", { declared });

	const root = mkdtempSync(join(tmpdir(), `s19-${mode}-component-`));
	const eventsPath = join(root, "events.jsonl");
	const owned = spawnDirectChild(INTERACTIVE_CHILD, { FAKE_PTY_INTERACTIVE_MODE: mode }, eventsPath);
	let trialError: string | null = null;
	let evidence: Record<string, unknown> = {};

	try {
		await waitFor(() => readEventsSafe(eventsPath).some((e) => e.event === "ready"), 8000, `${mode} component ready`);
		if (mode === "selection") {
			for (let i = 0; i < inputs.length; i++) {
				owned.child.stdin?.write(inputs[i]);
				// Event-driven wait: wait for the (i+1)-th selection event, not a
				// fixed sleep and not a pre-existing event.
				await waitFor(() => readEventsSafe(eventsPath).filter((e) => e.event === "selection").length >= i + 1, 8000, `selection event ${i + 1}`);
			}
		} else {
			for (let i = 0; i < inputs.length; i++) {
				owned.child.stdin?.write(inputs[i]);
				const awaitedPhase = `wheel-up-${i + 1}`;
				await waitFor(() => readEventsSafe(eventsPath).some((e) => e.event === "scroll" && e.phase === awaitedPhase), 8000, awaitedPhase);
			}
		}
		// For scroll, wait for the child's event-driven append + scrollToEnd.
		if (mode === "scroll") {
			await waitFor(() => readEventsSafe(eventsPath).some((e) => e.event === "scroll" && e.phase === "post-append"), 10000, "post-append");
			await waitFor(() => readEventsSafe(eventsPath).some((e) => e.event === "scroll" && e.phase === "scroll-to-end"), 10000, "scroll-to-end");
		}
		const events = readEventsSafe(eventsPath);
		if (mode === "selection") {
			const selectionEvents = events.filter((e) => e.event === "selection").map((e) => ({ selectedItem: e.selectedItem, selectedIndex: e.selectedIndex, focusIsSelectList: e.focusIsSelectList }));
			evidence = {
				selectionEvents,
				selectionEventSequenceMatches: JSON.stringify(selectionEvents.map((e) => e.selectedItem?.label)) === JSON.stringify(["Beta", "Gamma"]),
				focusKeptOnSelectList: selectionEvents.length >= 2 && selectionEvents.every((e) => e.focusIsSelectList === true),
				componentOnly: true,
			};
		} else {
			const scrollEvent = (phase: string) => events.find((e) => e.event === "scroll" && e.phase === phase) ?? null;
			const wheel3 = scrollEvent("wheel-up-3");
			const postAppend = scrollEvent("post-append");
			const scrollToEnd = scrollEvent("scroll-to-end");
			evidence = {
				wheel3,
				postAppend,
				scrollToEnd,
				wheelUpscroll: wheel3 !== null && wheel3.isFollowingEnd === false,
				postAppendNoJump: postAppend !== null && postAppend.isFollowingEnd === false && postAppend.scrollTop === (wheel3 as any)?.scrollTop,
				scrollToEndRestored: scrollToEnd !== null && scrollToEnd.isFollowingEnd === true,
				componentOnly: true,
			};
		}
		writeArtifact("child-events.jsonl", events);
	} catch (err) {
		trialError = err instanceof Error ? (err.stack ?? err.message) : String(err);
	} finally {
		await killDirectChild(owned);
		writeArtifact("stderr.txt", { stderr: owned.stderr });
	}

	const ok = trialError === null && artifactErrors.length === 0 && Object.entries(evidence).filter(([k]) => typeof evidence[k] === "boolean").every(([, v]) => v === true);
	if (artifactErrors.length > 0 || trialError !== null) {
		/* retain root */
	} else {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
	const record: Record<string, unknown> = {
		ok,
		caseId,
		repeat: 1,
		clock: "real",
		declared,
		evidence,
		childExit: { exitCode: owned.exitCode, signalCode: owned.signalCode, killed: owned.killed },
		scenarioHash: sha256File(join(REPO_ROOT, "test-support/attach-ready-interactions-scenario.ts")),
		artifactErrors,
		error: trialError,
		artifactDir,
	};
	writeArtifact("summary.json", record);
	return record;
}

// ---------------------------------------------------------------------------
// CLI surface (approved)
// ---------------------------------------------------------------------------

function cliError(message: string): never {
	process.stderr.write(`attach-ready-interactions-scenario: ${message}\n`);
	process.exit(2);
}

export function parseCli(argv: string[]): { caseId: string; repeat: number; clock: string; artifactDir: string } {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i].startsWith("--") || i + 1 >= argv.length) cliError(`malformed arguments: ${argv.join(" ")}`);
		args.set(argv[i].slice(2), argv[i + 1]);
	}
	const caseId = args.get("case") ?? cliError("missing --case");
	const supported = new Set(["MAINSCREEN", "SELECTION", "SCROLL", "SELECTION-COMPONENT", "SCROLL-COMPONENT"]);
	if (!supported.has(caseId)) cliError(`unsupported --case ${JSON.stringify(caseId)} (only MAINSCREEN, SELECTION, SCROLL, SELECTION-COMPONENT and SCROLL-COMPONENT are implemented)`);
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
	let run: Promise<Record<string, unknown>>;
	if (cli.caseId === "MAINSCREEN") run = runMainscreenCase({ artifactDir: cli.artifactDir });
	else if (cli.caseId === "SELECTION") run = runSelectionAttachCase({ artifactDir: cli.artifactDir });
	else if (cli.caseId === "SCROLL") run = runScrollAttachCase({ artifactDir: cli.artifactDir });
	else if (cli.caseId === "SELECTION-COMPONENT") run = runInteractiveComponentCase({ artifactDir: cli.artifactDir, mode: "selection", inputs: ["\x1b[B", "\x1b[B"] });
	else run = runInteractiveComponentCase({ artifactDir: cli.artifactDir, mode: "scroll", inputs: ["\x1b[<64;1;1M", "\x1b[<64;1;1M", "\x1b[<64;1;1M"] });
	run
		.then((result) => {
			process.stdout.write(JSON.stringify(result) + "\n");
			process.exit(0);
		})
		.catch((err) => {
			process.stderr.write(`attach-ready-interactions-scenario: trial harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
			process.exit(1);
		});
}
