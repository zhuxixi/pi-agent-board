// Child-process driver: attach a REAL PtyAttachComponent to a REAL runner
// socket (argv[2]) and report whether the transition settles and what it
// shows. Run with --experimental-transform-types.
import { PtyAttachComponent } from "../src/ui/pty-attach.ts";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";

const socketPath = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 8000);
const needle = process.argv[4] ?? "IDLE-E2E VISIBLE LINE";
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
const component = new PtyAttachComponent(tui as never, theme, {} as never, () => {}, { socketPath, title: "s-then-idle" });
const internals = component as unknown as {
	attaching: boolean; deadlineState: string; notReadyReason: string | null;
	latestViewProof: { status?: string; reason?: string } | null; committedView: unknown;
};
const started = Date.now();
let settledMs: number | null = null;
let visible = "";
while (Date.now() - started < timeoutMs) {
	await new Promise<void>((r) => setTimeout(r, 100));
	visible = component.render(80).join("\n");
	if (internals.attaching === false) { settledMs = Date.now() - started; break; }
}
const result = {
	settledMs,
	attaching: internals.attaching,
	showsContent: visible.includes(needle),
	visibleHead: visible.slice(0, 120),
	deadlineState: internals.deadlineState,
	notReadyReason: internals.notReadyReason,
	latestViewProofStatus: internals.latestViewProof?.status ?? null,
	latestViewProofReason: internals.latestViewProof?.reason ?? null,
	committedView: internals.committedView !== null,
};
try { component.dispose(); } catch { /* best effort */ }
console.log(JSON.stringify(result));
process.exit(result.settledMs !== null && result.showsContent ? 0 : 1);
