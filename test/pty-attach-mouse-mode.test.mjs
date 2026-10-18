import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-mouse-mode-scenario.ts");

// Component-level outer-mouse-mode ownership coverage (issue #169): the REAL
// PtyAttachComponent against a fake TUI write spy and a nonexistent control
// socket. Asserts zero mouse-mode writes in fullscreen across ctor + refresh
// window + close, the preserved regular-mode pairing, zero writes under the
// kill switch (incl. close — the previously unguarded disable), and old-runtime
// (mode absent) behaving like regular.
test("attach mouse-mode ownership: fullscreen writes nothing; regular pairing kept; kill switch silent", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	// Issue #207: pi-tui writes ENABLE_MOUSE exactly once at startup and never again, so a
	// lost handshake turns every wheel notch into an arrow key for the rest of the session.
	// The attach surface therefore re-asserts the enable form once on open. Issue #169's
	// actual contract -- never DOWNGRADE or kill the TUI's mode -- is preserved: the
	// disable form is still never written in fullscreen.
	assert.equal(parsed.fullscreen.enableAtCtor, true, "fullscreen: the one-shot mouse handshake is re-asserted at ctor");
	assert.equal(parsed.fullscreen.disableAtClose, false, "fullscreen: no MOUSE_DISABLE at close");
	assert.equal(parsed.fullscreen.disables, 0, "fullscreen: never writes a disable form");
	assert.equal(parsed.fullscreen.enables, 1, "fullscreen: exactly one re-assert, not a stream of them");
	assert.equal(parsed.regular.enableAtCtor, true, "regular: MOUSE_ENABLE at ctor preserved");
	assert.equal(parsed.regular.disableAtClose, true, "regular: MOUSE_DISABLE at close preserved");
	assert.equal(parsed.off.writes, 0, "AGENT_BOARD_ATTACH_MOUSE=0: zero writes including close");
	assert.equal(parsed.legacy.enableAtCtor, true, "old runtime (no mode): behaves like regular");
	assert.equal(parsed.legacy.disableAtClose, true, "old runtime (no mode): close disables like regular");
});
