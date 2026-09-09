#!/usr/bin/env node
/**
 * Fake healthy pi for the desync-health E2E (issue #11).
 *
 * Behaves like a real pi-tui around an attach:
 *   1. Boot stream: incremental TUI frames (2026h-wrapped, NO clear) every
 *      400ms for the first ~5s — like pi loading extensions/models — each
 *      re-parking the hardware cursor ON the inverse fake-cursor cell.
 *   2. Resize → fullRender(true): clear (\x1b[2J) + repaint, re-parked.
 *   3. Then idle: silent, keepalive only.
 *
 * This gives the attach's shrink-and-hold chain a clear to observe, teaches
 * the controller tuiFrameSeen (a clear-less frame MUST be fed while the chain
 * is active — within one chunk a clear wins over a frame start, and feed()
 * goes inert after the clear, so post-clear frames can never teach it), and
 * then leaves ≥1.5s of silence so the desync probe's quiet window opens and
 * the aligned gate is genuinely exercised (cursor parked on the inverse cell
 * → aligned → no heal).
 *
 * The editor line sits on the second-to-last row: the attach view's projection
 * window is bottom-anchored, so a healthy child must park its cursor inside
 * the lower viewport — as real pi-tui does.
 */
const BOOT_STREAM_MS = 5000;
const BOOT_FRAME_INTERVAL_MS = 400;
const baseline = [process.stdout.columns, process.stdout.rows];

/** Incremental idle frame: no clear, cursor parked on the inverse fake cursor. */
function idleFrame() {
	const row = Math.max(2, process.stdout.rows - 1);
	// "> " (cols 1-2) + inverse space (col 3 = fake cursor) + " editor";
	// trailing CUP parks the hardware cursor ON the inverse cell (col 3).
	process.stdout.write(`\x1b[?2026hready\n\x1b[${row};1H> \x1b[7m \x1b[0m editor\x1b[${row};3H\x1b[?2026l`);
}

/** widthChanged → fullRender(true): full clear + repaint, re-parked cursor. */
function fullFrame() {
	const row = Math.max(2, process.stdout.rows - 1);
	process.stdout.write(`\x1b[?2026h\x1b[2J\x1b[Hready\n\x1b[${row};1H> \x1b[7m \x1b[0m editor\x1b[${row};3H\x1b[?2026l`);
}

process.stdout.on("resize", () => {
	const c = process.stdout.columns;
	const r = process.stdout.rows;
	if (c === baseline[0] && r === baseline[1]) return;
	baseline[0] = c;
	baseline[1] = r;
	fullFrame();
});

idleFrame();
const bootStream = setInterval(idleFrame, BOOT_FRAME_INTERVAL_MS);
setTimeout(() => clearInterval(bootStream), BOOT_STREAM_MS);
// Keepalive: a real idle pi has live handles; without a pending timer the
// event loop drains and the child exits before the attach resizes it.
setInterval(() => {}, 60_000);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
