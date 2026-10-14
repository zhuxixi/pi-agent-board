import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-alt-wheel-scenario.ts");

// Component-level alternate-buffer wheel coverage (issue #185): the REAL
// PtyAttachComponent against a real runner whose fake pty child holds the
// alternate screen. The attach's own scrollback is inert there, so a fullscreen
// wheel must be FORWARDED to the child as one synthesized SGR report (the
// PageUp/PageDown fallback), not scrolled locally; kill switches and unusable
// deltas still fall through untouched (#183 semantics).
test("attach alt wheel: forwards one SGR report per event, falls through on switches and unusable deltas", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.sawAltContent, true, "alternate-buffer session content must render before wheel dispatch");
	assert.equal(parsed.bufferType, "alternate", "the attach's xterm must be in the alternate buffer for this scenario");
	assert.equal(parsed.upHandled, true, "wheel up must return {handled:true}");
	assert.equal(parsed.upRenderFalse, true, "wheel must suppress the redundant render (the child redraws)");
	assert.equal(parsed.forwardedUp, "\x1b[<64;4;3M", "wheel up must forward exactly one SGR report (button 64, child-screen coords)");
	assert.equal(parsed.forwardedDown, "\x1b[<65;4;3M", "wheel down must forward button 65");
	assert.equal(parsed.viewportStayedNull, true, "the local viewport must stay on follow-bottom — the child owns the scroll");
	assert.equal(parsed.attachMouseOffFallsThrough, true, "AGENT_BOARD_ATTACH_MOUSE=0 must fall through in fullscreen too");
	assert.equal(parsed.attachMouseOffNoForward, true, "AGENT_BOARD_ATTACH_MOUSE=0 must forward nothing");
	assert.equal(parsed.scrollSwitchOffFallsThrough, true, "AGENT_BOARD_ENABLE_MOUSE_SCROLL=0 must fall through");
	assert.equal(parsed.scrollSwitchOffNoForward, true, "AGENT_BOARD_ENABLE_MOUSE_SCROLL=0 must forward nothing");
	assert.equal(parsed.missingDeltaFallsThrough, true, "a wheel report with no delta must fall through");
	assert.equal(parsed.missingDeltaNoForward, true, "a wheel report with no delta must forward nothing");
	assert.equal(parsed.restoredAfterKillSwitch, true, "clearing the kill switches must restore forwarding");
	assert.equal(parsed.disconnectedFallsThrough, true, "a disconnected host must fall through — the forward would be a silent no-op");
	assert.equal(parsed.disconnectedNoForward, true, "a disconnected host must forward nothing");
});
