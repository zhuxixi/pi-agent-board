// Component-level fallback-path scenarios (issue #91 phase 4, task 3 fix wave).
// Drives the REAL PtyAttachComponent against a scripted fake runner socket
// (line-delimited JSON, same wire shapes as runner/pty-runner.mjs) to pin the
// three review findings:
//   mismatch      (F1) fast frame_version_mismatch during the probe window →
//                 the legacy jiggle chain MUST still arm (a resize goes out).
//   downgrade     (F2) protocol→legacy downgrade AFTER the attach settle →
//                 the jiggle chain MUST re-arm (a resize goes out); the old
//                 `attaching &&` gate left it stopped forever post-settle.
//   restart-empty (F3) reconnect to a restarted runner answering an empty
//                 baseline → the dead session's frame MUST be wiped from the
//                 local buffer (term.reset), no banner to hide behind.
//   cold-empty-ghost (final-review F1) INITIAL attach answering an empty
//                 baseline → the constructor's screen.log warm-start (a poison
//                 marker written BEFORE construction) must be wiped too: the
//                 stale-frame reset cannot be gated on !attaching, or the dead
//                 session's tail renders in protocol mode once the banner lifts.
// Run via `node --experimental-transform-types`; SCENARIO_MODE selects the
// scenario; emits ONE JSON result line on stdout.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";

const mode = process.env.SCENARIO_MODE ?? "mismatch";
const root = mkdtempSync(join(tmpdir(), `agentview-fallback-${mode}-`));
const socketPath = join(root, "runner.sock");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() < start + timeoutMs) {
		if (predicate()) return true;
		await sleep(20);
	}
	return false;
}

function bufferText(term: any): string {
	const b = term.buffer.active;
	const lines: string[] = [];
	for (let y = 0; y < b.length; y++) {
		const line = b.getLine(y);
		if (!line) continue;
		let s = "";
		for (let x = 0; x < 200; x++) s += line.getCell(x)?.getChars() ?? "";
		lines.push(s);
	}
	return lines.join("\n");
}

const result: Record<string, unknown> = { ok: false, mode, error: null };
const openConns: any[] = [];
// Scenario-scope subscribe counter: reconnects arrive on a NEW connection, so
// per-connection state would misread the second subscribe as another first.
let subscribeCount = 0;
// cold-empty-ghost determinism gate: the fake runner holds the empty-baseline
// answer until the scenario body has OBSERVED the constructor's screen.log
// warm-start in the buffer, so both variants (gated reset = bug, unconditional
// reset = fix) run the identical ordering: poison lands → snapshot answer →
// settle. No reliance on replay/parse timing.
let allowGhostAnswer = false;
const server = createServer((socket) => {
	openConns.push(socket);
	let buffer = "";
	const send = (msg: Record<string, unknown>) => {
		try { socket.write(JSON.stringify(msg) + "\n"); } catch { /* client went away */ }
	};
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let msg: any;
			try { msg = JSON.parse(line); } catch { continue; }
			result.lastReceived = msg.type;
			if (msg.type === "resize") result.resizes = ((result.resizes as number) ?? 0) + 1;
			if (msg.type === "subscribe_terminal") {
				subscribeCount += 1;
				result.subscribeCount = subscribeCount;
				result.reconnectSinceSeq = typeof msg.sinceSeq === "number" ? msg.sinceSeq : undefined;
				if (mode === "mismatch") {
					send({ type: "error", code: "frame_version_mismatch", message: "frame version unsupported" });
				} else if (mode === "downgrade") {
					if (subscribeCount === 1) {
						// Valid empty baseline → live at lastSeq 0.
						send({ type: "snapshot_begin", snapshotSeq: 0, cols: 80, rows: 22, frameVersion: 1, empty: true });
						send({ type: "snapshot_end", nextSeq: 1 });
						send({ type: "output", seq: 1, data: "boot line\n" });
						send({ type: "output", seq: 2, data: "live line\n" });
					} else {
						// Answer every recovery subscribe with a deterministic failure:
						// snapshot_failed routes straight into resyncOrFail, so each
						// cycle burns one recovery attempt until the client exhausts
						// the budget and downgrades to legacy. (Stray seq outputs are
						// ignored while resyncing — they cannot drive the chain.)
						setTimeout(() => send({ type: "error", code: "snapshot_failed", message: "injected" }), 20);
					}
				} else if (mode === "restart-empty") {
					if (subscribeCount === 1) {
						send({ type: "snapshot_begin", snapshotSeq: 0, cols: 80, rows: 22, frameVersion: 1 });
						send({ type: "snapshot_frame", frameVersion: 1, data: "OLD-MARKER-XYZ dead frame\n" });
						send({ type: "snapshot_end", nextSeq: 1 });
						send({ type: "output", seq: 1, data: "live-one\n" });
					} else {
						// Reconnect to the "restarted" runner: fresh empty baseline
						// (no frame — the old child is gone).
						send({ type: "snapshot_begin", snapshotSeq: 0, cols: 80, rows: 22, frameVersion: 1, empty: true, resnapshot: true });
						send({ type: "snapshot_end", nextSeq: 1 });
					}
				} else if (mode === "cold-empty-ghost") {
					if (subscribeCount === 1) {
						// The common post-crash recovery attach: the runner is up but
						// the new child has not produced output yet → empty baseline,
						// no frame. Hold the answer until the warm-start poison has
						// landed (gate above), then answer; first live output follows
						// so the attach settle can finish and the banner lifts.
						void waitFor(() => allowGhostAnswer, 8000).then((armed) => {
							if (!armed) return;
							send({ type: "snapshot_begin", snapshotSeq: 0, cols: 80, rows: 22, frameVersion: 1, empty: true });
							send({ type: "snapshot_end", nextSeq: 1 });
							setTimeout(() => send({ type: "output", seq: 1, data: "fresh child line\n" }), 150);
						});
					}
				}
			}
		}
	});
});

try {
	await new Promise<void>((resolveWait, rejectWait) => {
		server.once("error", rejectWait);
		server.listen(socketPath, () => resolveWait());
	});

	const sent: string[] = [];
	const socketProto = Socket.prototype as any;
	const origWrite = socketProto.write;
	socketProto.write = function (data: any, ...rest: any[]) {
		if (typeof data === "string") sent.push(data);
		return origWrite.call(this, data, ...rest);
	};

	// cold-empty-ghost precondition: poison the screen.log BEFORE construction so
	// the constructor's warm-start replay loads the dead session's tail into the
	// local buffer — exactly what a real post-crash attach sees.
	const screenLogPath = join(root, "screen.log");
	if (mode === "cold-empty-ghost") {
		writeFileSync(screenLogPath, "POISON-GHOST-XYZ dead session tail\n");
	}

	const tui = {
		terminal: { rows: 24, cols: 80, columns: 80, write: () => {} },
		requestRender: () => {},
	};
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const component = new PtyAttachComponent(
		tui as never,
		theme,
		{} as never,
		() => {},
		{ socketPath, screenLogPath: join(root, "screen.log"), title: `fallback ${mode}` } as never,
	);

	// Pump renders so scheduleRender-driven paths progress like a real TUI.
	const pump = setInterval(() => { try { component.render(80); } catch { /* scenario teardown */ } }, 40);

	try {
		if (mode === "mismatch") {
			// F1: the mismatch lands ~instantly; without the fix the 100ms race
			// guard skips arming (mode already legacy) → no resize ever.
			await waitFor(() => (result.resizes as number) > 0, 3000);
			result.ok = (result.resizes as number) > 0;
		} else if (mode === "downgrade") {
			// Settle must finish FIRST (attaching=false) so the downgrade branch's
			// old `attaching &&` gate is provably the blocker under test.
			const settled = await waitFor(() => (component as any).attaching === false, 5000);
			const resizesBeforeStorm = (result.resizes as number) ?? 0;
			result.settled = settled;
			result.resizesBeforeStorm = resizesBeforeStorm;
			// Initiate the storm: the first seq gap (expected 3) starts the
			// recovery chain; every recovery subscribe is answered with another
			// gap (server-side) until the budget is exhausted.
			if (openConns[0]) { try { openConns[0].write(JSON.stringify({ type: "output", seq: 9, data: "gap-init\n" }) + "\n"); } catch {} }
			await waitFor(() => (result.resizes as number) > resizesBeforeStorm, 5000);
			result.ok = settled && (result.resizes as number) > resizesBeforeStorm;
		} else if (mode === "restart-empty") {
			// F3: dead session frame hydrates, settle finishes, runner "restarts",
			// reconnect answers an empty baseline → buffer must be wiped.
			const sawMarker = await waitFor(() => bufferText((component as any).term).includes("OLD-MARKER-XYZ"), 4000);
			const settled = await waitFor(() => (component as any).attaching === false, 5000);
			result.sawMarker = sawMarker;
			result.settled = settled;
			if (!sawMarker || !settled) throw new Error("preconditions failed: marker/settle");
			// Kill connection 1: the component must treat it as a disconnect,
			// schedule reconnect, and resume the SAME client instance.
			if (openConns[0]) { try { openConns[0].destroy(); } catch {} }
			const reconnected = await waitFor(() => (result.subscribeCount as number) >= 2, 4000);
			result.reconnected = reconnected;
			result.reconnectSinceSeq = (result as any).reconnectSinceSeq;
			const wiped = await waitFor(() => !bufferText((component as any).term).includes("OLD-MARKER-XYZ"), 3000);
			result.wiped = wiped;
			result.ok = reconnected && wiped;
		} else if (mode === "cold-empty-ghost") {
			// Final-review F1: initial attach + empty baseline must wipe the
			// screen.log warm-start, not just post-attach reconnects. Precondition
			// proves the poison actually entered the buffer via the constructor
			// replay; the assertion runs AFTER settle (banner lifted), where the
			// gated `&& !this.attaching` variant leaves the ghost rendering.
			const poisonInBuffer = await waitFor(() => bufferText((component as any).term).includes("POISON-GHOST-XYZ"), 4000);
			result.poisonInBuffer = poisonInBuffer;
			if (!poisonInBuffer) throw new Error("precondition failed: warm-start poison never entered the buffer");
			// Poison confirmed in the buffer → only now may the runner answer the
			// subscribe with the empty baseline and let the scenario play out.
			allowGhostAnswer = true;
			const settled = await waitFor(() => (component as any).attaching === false, 8000);
			result.settled = settled;
			// Protocol-mode discriminator: attach must have sent zero resizes.
			result.resizes = (result.resizes as number) ?? 0;
			const ghostRendered = bufferText((component as any).term).includes("POISON-GHOST-XYZ");
			result.ghostRendered = ghostRendered;
			result.ok = poisonInBuffer && settled && !ghostRendered && result.resizes === 0;
		}
	} finally {
		clearInterval(pump);
		try { component.dispose(); } catch {}
		socketProto.write = origWrite;
	}
} catch (err) {
	result.error = err instanceof Error ? err.message : String(err);
}

server.close();
await sleep(30);
try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); } catch {}
console.log(JSON.stringify(result));
