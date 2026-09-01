#!/usr/bin/env node
/**
 * Fake HOT pi TUI for the issue #42 net-zero-collapse E2E.
 *
 * Already rendering when the attach connects ("hot session"): emits a
 * differential frame (2026h, NO clear) every STUB_FRAME_MS. Faithfully models
 * the two pi-tui behaviors the race depends on:
 *   1. resize handling is deferred (pi-tui: 16ms render throttle, stretched to
 *      STUB_RESIZE_LATENCY_MS here so the race window is deterministic), and
 *   2. the handler reads the CURRENT PTY size — so a shrink+restore pair that
 *      lands within one latency window reads back the baseline size and
 *      renders NOTHING (net-zero collapse, widthChanged=false).
 * A resize that survives alone (a real delta) triggers a fullRender-style
 * write with the full clear, exactly like pi-tui's widthChanged →
 * fullRender(true) path.
 */
const frameMs = Number(process.env.STUB_FRAME_MS ?? 15);
const latencyMs = Number(process.env.STUB_RESIZE_LATENCY_MS ?? 150);

const baseline = [process.stdout.columns, process.stdout.rows];
process.stdout.write(`\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jboot@${baseline[0]}x${baseline[1]}\x1b[?2026l`);

let tick = 0;
setInterval(() => {
	tick += 1;
	// Differential frame: frame-start marker, no clear — the in-flight output
	// that trips the attach controller's frameStart fast path (issue #42).
	process.stdout.write(`\x1b[?2026hstub: working... ${tick}\x1b[?2026l`);
}, frameMs);

let pending = null;
process.stdout.on("resize", () => {
	// Coalesce like pi-tui's throttled requestRender(): one delayed handler,
	// reads the size at fire time — by then both shrink and restore may have
	// landed, collapsing to a net-zero change that renders nothing.
	if (pending) clearTimeout(pending);
	pending = setTimeout(() => {
		pending = null;
		const c = process.stdout.columns;
		const r = process.stdout.rows;
		if (c === baseline[0] && r === baseline[1]) return; // net-zero: silent
		baseline[0] = c;
		baseline[1] = r;
		process.stdout.write(`\x1b[?2026h\x1b[2J\x1b[H\x1b[3JfullRender@${c}x${r}\x1b[?2026l`);
	}, latencyMs);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
