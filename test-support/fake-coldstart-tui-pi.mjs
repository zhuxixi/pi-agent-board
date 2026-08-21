#!/usr/bin/env node
/**
 * Fake cold-booting pi for the attach jiggle E2E (issue #10).
 *
 * Prints boot noise immediately, then after STUB_TUI_DELAY_MS "starts the TUI":
 * installs the stdout resize listener (SIGWINCHes before this point are lost,
 * exactly like a booting pi-tui) and emits frames wrapped in \x1b[?2026h/l.
 * Any resize observed after start triggers a fullRender-style write containing
 * the full clear sequence \x1b[2J\x1b[H\x1b[3J.
 */
const delay = Number(process.env.STUB_TUI_DELAY_MS ?? 8000);

process.stdout.write("boot: loading extensions...\n");

let started = false;
function startTui() {
	if (started) return;
	started = true;
	process.stdout.on("resize", () => {
		process.stdout.write(
			`\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jframe@${process.stdout.columns}x${process.stdout.rows}\x1b[?2026l`,
		);
	});
	process.stdout.write("\x1b[?2004h\x1b[?25l");
	frame();
}
function frame() {
	process.stdout.write("\x1b[?2026hstub: working...\x1b[?2026l");
}
setTimeout(startTui, delay);
setInterval(() => {
	if (started) frame();
}, 100);
setInterval(() => {}, 1000); // keep alive
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
