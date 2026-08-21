#!/usr/bin/env node
/**
 * Fake cold-booting pi for the attach shrink-and-hold E2E (issue #25).
 *
 * Prints boot noise immediately, then after STUB_TUI_DELAY_MS "starts the TUI":
 * installs the stdout resize listener (SIGWINCHes before this point are lost,
 * exactly like a booting pi-tui) and emits \x1b[?2026h-wrapped frames.
 *
 * Protocol semantics: the baseline is the size observed at TUI START (pi-tui
 * reads columns on first render). After that, any resize that changes the size
 * away from the baseline triggers a fullRender-style write containing the
 * full clear \x1b[2J\x1b[H\x1b[3J — mirroring pi-tui's widthChanged →
 * fullRender(true) path.
 */
const delay = Number(process.env.STUB_TUI_DELAY_MS ?? 8000);

process.stdout.write("boot: loading extensions...\n");

let started = false;
let baseline = null;
function startTui() {
	if (started) return;
	started = true;
	// Baseline = the size the TUI first renders at (matches pi-tui reading
	// process.stdout.columns on its first frame). Under the hold protocol the
	// attach has already shrunk the PTY by then, so this is the shrunk size —
	// the later restore to the original size is the width delta that forces
	// the fullRender.
	baseline = [process.stdout.columns, process.stdout.rows];
	process.stdout.on("resize", () => {
		const c = process.stdout.columns;
		const r = process.stdout.rows;
		if (c === baseline[0] && r === baseline[1]) return; // no size change
		baseline = [c, r]; // new baseline after the full render
		process.stdout.write(
			`\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jframe@${c}x${r}\x1b[?2026l`,
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
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
