// Issue #278 A3/A4: Ctrl+G external editor (Nvim) must be projected live in
// modern protocol attach, with ownership-aware interaction state and strict
// restore fences. RED before the Task 4 component fix: the actual render must
// omit NVIM_VISIBLE_PROBE_1 while the underlying parser buffer contains it.
// Run via `node --experimental-transform-types` (TS parameter properties).
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";
import { exitAfterStdout } from "./stdout-flush.mjs";

// Exact child byte order observed on the real Pi 1.5.0 + Nvim round trip
// (design §3): a synchronized Pi alt-screen exit hands the terminal to Nvim;
// Nvim's own unframed ?1049h/?2026$p drawing does not close Pi frames; the
// next synchronized-output open is Pi taking the screen back.
const PI_STOP = "\x1b[?2026h\x1b[?1049l\x1b[?2026l";
const NVIM_START = "\x1b[?1049h\x1b[?2026$p\x1b[2J\x1b[HNVIM_VISIBLE_PROBE_1";
const NVIM_QUIT = "\x1b[?1049l";
const PI_RESTORE_OPEN = "\x1b[?1049h\x1b[?2026hPI_PARTIAL_MUST_NOT_SHOW";
// Supervisor ruling (Task 3): the close mirrors the real pi-tui restore frame
// (sync-open → Kitty delete-all APC → 2J+home → rows → sync-close). The
// brief's literal close without 2J+home leaves PI_PARTIAL_MUST_NOT_SHOW on the
// committed grid line, which made "omits the partial marker after close"
// unsatisfiable; proven against @xterm/headless before this scenario existed.
const PI_RESTORE_CLOSE = "\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2J\x1b[HPI_RESTORED\x1b[?2026l";
const PI_FRAME = "\x1b[2J\x1b[H\x1b[?2026h\x1b[1;1HPI_BEFORE_NVIM\x1b[?2026l";

const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
const keybindings = {} as never;

function harness() {
	const terminalWrites: string[] = [];
	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: (data: string) => terminalWrites.push(data) },
		requestRender: () => {},
	};
	const component = new PtyAttachComponent(tui as never, theme, keybindings, () => {}, { socketPath: "/no/such/socket", title: "external-editor-test" });
	return { component, tui, terminalWrites };
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

/** Modern committed mode with the attach transition already finished. */
function enterModernCommitted(component: PtyAttachComponent): void {
	const c = internals(component);
	c.attachMode = "protocol";
	c.frameWitnessAvailable = true;
	c.attaching = false;
	c.cols = 80;
	c.rows = 22;
}

// Harness fidelity (Task 3 review): wire fields live on exactly one event —
// `externalOutputActive` only on snapshotBegin (runner capture-end sample),
// `resnapshot` only on snapshotReady. No ownership mirroring into snapshotReady.
function emitSnapshot(component: PtyAttachComponent, frame: string, extra: Record<string, unknown> = {}) {
	const c = component as unknown as { handleAttachEvent: (event: string, payload: unknown) => void };
	c.handleAttachEvent("snapshotBegin", {
		cols: 80,
		rows: 22,
		...("externalOutputActive" in extra ? { externalOutputActive: (extra as any).externalOutputActive } : {}),
	});
	c.handleAttachEvent("snapshotReady", {
		frame,
		nextSeq: 1,
		...("resnapshot" in extra ? { resnapshot: (extra as any).resnapshot } : {}),
	});
}

function pushLive(component: PtyAttachComponent, data: string): void {
	(component as unknown as { handleAttachEvent: (event: string, payload: unknown) => void }).handleAttachEvent("output", data);
}

function bufferText(component: PtyAttachComponent): string {
	const buf = internals(component).term.buffer.active;
	const lines: string[] = [];
	for (let i = 0; i < buf.length; i += 1) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
	return lines.join("\n");
}

/** Absolute buffer row of the first line containing `needle` (live surface). */
function liveLineOf(component: PtyAttachComponent, needle: string): number {
	const buf = internals(component).term.buffer.active;
	for (let i = 0; i < buf.length; i += 1) {
		if ((buf.getLine(i)?.translateToString(true) ?? "").includes(needle)) return i;
	}
	throw new Error(`live buffer does not contain ${needle}`);
}

function renderText(component: PtyAttachComponent): string {
	return component.render(80).join("\n");
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
function assertEqual(actual: unknown, expected: unknown, message: string): void {
	if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Drive a fresh harness into the Nvim-owns-the-screen state. Returns seeded internals. */
async function driveIntoExternal(h: ReturnType<typeof harness>) {
	const c = internals(h.component);
	enterModernCommitted(h.component);
	emitSnapshot(h.component, PI_FRAME);
	await waitFor(() => c.committedView !== null, "committed Pi frame before Ctrl+G");
	pushLive(h.component, PI_STOP);
	pushLive(h.component, NVIM_START);
	await waitFor(() => bufferText(h.component).includes("NVIM_VISIBLE_PROBE_1"), "live Nvim bytes parsed");
	return c;
}

async function run(): Promise<{ ok: boolean; checks: Check[] }> {
	await check("external editor output is projected live while the child owns the screen", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			enterModernCommitted(h.component);
			emitSnapshot(h.component, PI_FRAME);
			await waitFor(() => c.committedView !== null, "committed Pi frame before Ctrl+G");
			assert(renderText(h.component).includes("PI_BEFORE_NVIM"), "committed Pi frame renders before Ctrl+G");
			// Seed interaction state that an ownership change must clear (design D6).
			c.viewportTop = 0;
			c.selection = { anchor: { line: 0, col: 0 }, focus: { line: 0, col: 5 } };
			c.lastClickPoint = { line: 0, col: 1 };
			c.lastClickAt = Date.now();
			pushLive(h.component, PI_STOP);
			pushLive(h.component, NVIM_START);
			await waitFor(() => bufferText(h.component).includes("NVIM_VISIBLE_PROBE_1"), "live Nvim bytes parsed");
			// The RED oracle: the buffer is healthy, the visible projection is not.
			assert(bufferText(h.component).includes("NVIM_VISIBLE_PROBE_1"), "underlying buffer holds the live Nvim probe");
			const externalRender = renderText(h.component);
			assert(externalRender.includes("NVIM_VISIBLE_PROBE_1"), "actual render projects the live Nvim probe (buffer has it, render does not)");
			assertEqual(c.externalOutputActive, true, "synchronized Pi alt-screen exit activates external ownership");
			assertEqual(c.viewportTop, null, "external entry clears the stale Pi viewport");
			assertEqual(c.selection, null, "external entry clears the stale Pi selection");
			assertEqual(c.lastClickPoint, null, "external entry clears the pending click");
			const probeLine = liveLineOf(h.component, "NVIM_VISIBLE_PROBE_1");
			assert(
				c.interactionLine(probeLine).translateToString(true).includes("NVIM_VISIBLE_PROBE_1"),
				"live interaction addressing reads the Nvim line, not the stale committed Pi view",
			);
			// Input forwarding is unchanged (design D8): the typed bytes reach the
			// socket exactly as input messages while Nvim owns the screen.
			const written: string[] = [];
			c.socket = { write: (line: string) => written.push(line), destroy: () => {}, end: () => {} };
			c.connected = true;
			h.component.handleInput("\x07");
			h.component.handleInput("iNVIM_VISIBLE_PROBE_1");
			const inputs = written
				.map((line) => JSON.parse(line))
				.filter((msg) => msg.type === "input")
				.map((msg) => msg.data);
			assert(JSON.stringify(inputs) === JSON.stringify(["\x07", "iNVIM_VISIBLE_PROBE_1"]), `input messages carry exactly the typed bytes: ${JSON.stringify(inputs)}`);
			// Restore fences: an open Pi frame is never projected as a live partial;
			// only the real close commits and displays the restored Pi grid.
			pushLive(h.component, NVIM_QUIT);
			pushLive(h.component, PI_RESTORE_OPEN);
			await waitFor(() => bufferText(h.component).includes("PI_PARTIAL_MUST_NOT_SHOW"), "partial restore bytes parsed");
			assert(!renderText(h.component).includes("PI_PARTIAL_MUST_NOT_SHOW"), "an open restore frame is never projected");
			pushLive(h.component, PI_RESTORE_CLOSE);
			await waitFor(() => renderText(h.component).includes("PI_RESTORED"), "restore close commits the restored Pi grid");
			const restored = renderText(h.component);
			assert(restored.includes("PI_RESTORED"), "restored Pi content renders");
			assert(!restored.includes("NVIM_VISIBLE_PROBE_1"), "no Nvim residue after the restore close");
			assert(!restored.includes("PI_PARTIAL_MUST_NOT_SHOW"), "no partial-frame residue after the restore close");
			assertEqual(c.externalOutputActive, false, "synchronized restore open ends external ownership");
			assertEqual(c.cols, 80, "geometry retained (cols)");
			assertEqual(c.rows, 22, "geometry retained (rows)");
			assertEqual(c.committedView.identity.targetCols, 80, "committed identity cols");
			assertEqual(c.committedView.identity.targetRows, 22, "committed identity rows");
			assertEqual(c.committedView.rows.length, 22, "committed view spans the full 80x22 body");
			return { inputs, restored: true };
		} finally {
			h.component.dispose();
		}
	});

	await check("same-generation resnapshot adopts runner ownership and keeps the live projection", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			await driveIntoExternal(h);
			// Task 2 wire fact: the runner samples ownership into snapshot_begin.
			emitSnapshot(h.component, "\x1b[2J\x1b[H\x1b[?2026h\x1b[1;1HNVIM_AFTER_RESNAPSHOT\x1b[?2026l", { externalOutputActive: true, resnapshot: true });
			await waitFor(() => c.localHydrationState === "complete" && bufferText(h.component).includes("NVIM_AFTER_RESNAPSHOT"), "resnapshot hydrated");
			assert(renderText(h.component).includes("NVIM_AFTER_RESNAPSHOT"), "live projection resumes after the same-generation resnapshot");
			assertEqual(c.externalOutputActive, true, "runner ownership boolean adopted at snapshotBegin");
			return { hydrated: true };
		} finally {
			h.component.dispose();
		}
	});

	await check("open-frame hydration never exposes partial content without external ownership", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			enterModernCommitted(h.component);
			emitSnapshot(h.component, "\x1b[2J\x1b[H\x1b[?2026hOPEN_HYDRATION_PARTIAL");
			await waitFor(() => c.localHydrationState === "complete", "open hydration parsed");
			assertEqual(c.committedView, null, "open hydration does not commit");
			assert(!renderText(h.component).includes("OPEN_HYDRATION_PARTIAL"), "blank protection while the hydrated frame is open");
			pushLive(h.component, "\x1b[?2026l");
			await waitFor(() => c.committedView !== null, "real close commits the hydrated frame");
			assert(renderText(h.component).includes("OPEN_HYDRATION_PARTIAL"), "the closed frame publishes");
			assertEqual(c.externalOutputActive, false, "an absent snapshot boolean never invents ownership");
			return { published: true };
		} finally {
			h.component.dispose();
		}
	});

	await check("same-generation resize preserves the external live projection", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			await driveIntoExternal(h);
			// A real terminal resize arrives through the render path (design D7).
			h.tui.terminal.cols = 100;
			h.tui.terminal.columns = 100;
			h.tui.terminal.rows = 30;
			const resized = h.component.render(100).join("\n");
			assert(resized.includes("NVIM_VISIBLE_PROBE_1"), "live projection survives the same-generation resize");
			assertEqual(c.externalOutputActive, true, "ownership survives the same-generation resize");
			assertEqual(c.cols, 100, "resized cols adopted");
			assertEqual(c.rows, 28, "resized rows adopted");
			return { resized: true };
		} finally {
			h.component.dispose();
		}
	});

	await check("epoch reset and a new generation clear external ownership", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			await driveIntoExternal(h);
			c.handleAttachEvent("epochReset", {});
			assertEqual(c.externalOutputActive, false, "epoch reset clears ownership");
			await driveIntoExternal(h);
			c.handleAttachEvent("snapshotBegin", { cols: 80, rows: 22, generation: "gen-2" });
			assertEqual(c.externalOutputActive, false, "a new generation without the boolean resets ownership");
			return { reset: true };
		} finally {
			h.component.dispose();
		}
	});

	await check("legacy fallback resets ownership and renders the live buffer", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			await driveIntoExternal(h);
			c.handleAttachEvent("mode", "legacy");
			assert(renderText(h.component).includes("NVIM_VISIBLE_PROBE_1"), "legacy projection renders the live buffer");
			assertEqual(c.externalOutputActive, false, "legacy fallback resets ownership");
			// Fix-round regression: legacy mode must not run ownership adoption or
			// interaction cleanup. Seed interaction state, then drive the synced
			// alt-screen-exit handoff a Ctrl+G would emit; legacy keeps everything.
			c.viewportTop = 0;
			c.selection = { anchor: { line: 0, col: 0 }, focus: { line: 0, col: 5 } };
			c.selectionDragging = true;
			c.lastClickPoint = { line: 0, col: 1 };
			c.lastClickAt = Date.now();
			const seededSelection = c.selection;
			const seededClickPoint = c.lastClickPoint;
			const eventsBefore = c.parserObserverEvents;
			pushLive(h.component, PI_STOP);
			await waitFor(() => c.parserObserverEvents >= eventsBefore + 2, "synced handoff bytes parsed");
			assertEqual(c.externalOutputActive, false, "legacy handoff never activates ownership");
			assertEqual(c.viewportTop, 0, "legacy handoff keeps the scroll viewport");
			assertEqual(c.selection, seededSelection, "legacy handoff keeps the selection");
			assertEqual(c.selectionDragging, true, "legacy handoff keeps the drag flag");
			assertEqual(c.lastClickPoint, seededClickPoint, "legacy handoff keeps the click point");
			return { legacy: true };
		} finally {
			h.component.dispose();
		}
	});

	await check("dispose clears ownership and closes the surface", async () => {
		const h = harness();
		const c = internals(h.component);
		try {
			await driveIntoExternal(h);
			h.component.dispose();
			assertEqual(c.closed, true, "closed flag");
			assertEqual(c.externalOutputActive, false, "dispose clears ownership");
			assert(c.committedView === null, "dispose clears the committed view");
			assert(h.component.render(80).length === 0, "a closed surface renders nothing");
			return { disposed: true };
		} finally {
			h.component.dispose();
		}
	});

	return { ok: checks.every((entry) => entry.ok), checks };
}

run()
	.then((result) => {
		exitAfterStdout(`${JSON.stringify(result)}\n`, result.ok ? 0 : 1);
	})
	.catch((err) => {
		process.stderr.write(`external-editor-scenario: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(1);
	});
