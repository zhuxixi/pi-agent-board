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
	assert.equal(parsed.fullscreen.writes, 0, "fullscreen: zero mouse-mode/XTSHIFTESCAPE writes across ctor+timers+close");
	assert.equal(parsed.fullscreen.enableAtCtor, false, "fullscreen: no MOUSE_ENABLE at ctor");
	assert.equal(parsed.fullscreen.disableAtClose, false, "fullscreen: no MOUSE_DISABLE at close");
	assert.equal(parsed.regular.enableAtCtor, true, "regular: MOUSE_ENABLE at ctor preserved");
	assert.equal(parsed.regular.disableAtClose, true, "regular: MOUSE_DISABLE at close preserved");
	assert.equal(parsed.off.writes, 0, "AGENT_BOARD_ATTACH_MOUSE=0: zero writes including close");
	assert.equal(parsed.legacy.enableAtCtor, true, "old runtime (no mode): behaves like regular");
	assert.equal(parsed.legacy.disableAtClose, true, "old runtime (no mode): close disables like regular");
});
