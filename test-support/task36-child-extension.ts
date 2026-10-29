// Task36 test-only real-Pi child driver. It uses documented public UI APIs only
// and never imports or changes production code.
import { appendFileSync } from "node:fs";

const LOG = process.env.TASK36_CHILD_LOG ?? "";
const MODE = process.env.TASK36_CHILD_MODE ?? "busy";
const GENERATION = process.env.TASK36_GENERATION ?? "gen-1";
const COLD_DELAY = Number(process.env.TASK36_COLD_DELAY ?? "700");
let count = 0;
function record(event: Record<string, unknown>): void {
	if (LOG === "") return;
	try { appendFileSync(LOG, `${JSON.stringify({ wallMs: Date.now(), pid: process.pid, mode: MODE, ...event })}\n`); } catch { /* best effort */ }
}
function rows(): string[] {
	if (MODE === "busy") return [`TASK36 ${GENERATION} B HEADER`, `TASK36 B COUNTER ${count}`, "TASK36 B TAIL", "TASK36 B INPUT >"];
	if (MODE === "quiet") return [`TASK36 ${GENERATION} Q HEADER${count % 2 === 0 ? " " : ""}`, "TASK36 Q READY", "TASK36 Q TAIL", "TASK36 Q INPUT >"];
	if (MODE === "long-normal" || MODE === "long-alt") {
		const label = MODE === "long-alt" ? "LA" : "L";
		const updates = process.env.TASK36_L_DYNAMIC === "1" ? Array.from({ length: Math.min(count, 30) }, (_, i) => `TASK36 ${label} UPDATE ${i + 1}`) : [];
		return [`TASK36 ${label} HISTORY LOADED 301 ENTRIES 114703 BYTES`, ...updates, `TASK36 ${label} TAIL 中文最终回答 🎯${count % 2 === 0 ? " " : ""}`, `TASK36 ${label} INPUT >`];
	}
	if (MODE === "geometry") return [`TASK36 G TARGET ${GENERATION}`, "TASK36 G TAIL", "TASK36 G INPUT >"];
	if (MODE === "cold") return ["TASK36 C COMPLETE EDITOR", "TASK36 C TAIL", "TASK36 C INPUT >"];
	return [`TASK36 ${GENERATION} ${MODE.toUpperCase()} HEADER`, "TASK36 TAIL", "TASK36 INPUT >"];
}
export default function task36Child(pi: any): void {
	record({ event: "extension-load", argv: process.argv, mode: MODE });
	pi.on("session_start", (_event: unknown, ctx: any) => {
		let sessionEntries = null;
		try { const entries = ctx?.sessionManager?.getEntries?.(); sessionEntries = Array.isArray(entries) ? entries.length : null; } catch { /* unknown */ }
		record({ event: "session-start", hasUI: ctx?.hasUI === true, mode: ctx?.mode ?? null, sessionEntries });
		setTimeout(() => {
			try {
				const entries = ctx.sessionManager?.getEntries?.();
				record({ event: "session-history", count: Array.isArray(entries) ? entries.length : null, bytes: Array.isArray(entries) ? Buffer.byteLength(JSON.stringify(entries), "utf8") : null });
			} catch (error) {
				record({ event: "session-history", count: null, bytes: null, error: String(error) });
			}
		}, 500);
		if (ctx?.hasUI !== true || ctx.ui?.setWidget === undefined) { record({ event: "unsupported" }); return; }
		const makeComponent = (terminalRows: number | null) => ({
			render: (width: number): string[] => {
				count += 1;
				record({ event: "render", count, width, terminalRows, rows: rows() });
				return rows();
			},
			invalidate: () => {},
			dispose: () => record({ event: "dispose" }),
		});
		let stableBusyComponent: ReturnType<typeof makeComponent> | null = null;
		const apply = () => ctx.ui.setWidget("task36-child", (tui: any) => {
			const terminalRows = tui?.terminal?.rows ?? null;
			record({ event: "widget-factory", tuiMode: tui?.mode ?? null, cols: tui?.terminal?.columns ?? null, rows: terminalRows });
			if (MODE === "busy") {
				stableBusyComponent ??= makeComponent(terminalRows);
				return stableBusyComponent;
			}
			return makeComponent(terminalRows);
		}, { placement: "aboveEditor" });
		if (MODE === "cold") setTimeout(() => { record({ event: "cold-complete", delay: COLD_DELAY }); apply(); }, COLD_DELAY);
		else {
			apply();
			if (MODE === "busy") setInterval(apply, Number(process.env.TASK36_B_INTERVAL ?? "25")).unref?.();
			else if (MODE === "quiet" || MODE === "geometry" || MODE === "long-normal" || MODE === "long-alt") setInterval(apply, 200).unref?.();
		}
		record({ event: "widget-registered" });
		setInterval(() => {
			try { const text = ctx.ui.getEditorText?.() ?? null; record({ event: "editor-state", text }); } catch { /* unsupported */ }
		}, 200).unref?.();
	});
	pi.on("input", (event: any) => record({ event: "child-input", text: event?.text ?? null, source: event?.source ?? null }));
	pi.on("session_shutdown", () => record({ event: "session-shutdown" }));
}
