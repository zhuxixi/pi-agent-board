import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-wheel-fallback-scenario.ts");

// Production topology (issue #198): the child holds the alternate screen but its
// one-shot enable fell outside the attach's 100 KB screen-log replay window, so
// the attach's own buffer reads `normal` and the local viewport cannot move.
// The fullscreen wheel must still reach the child — the fallback is what makes
// the feature work in a real (long-lived) session, not the buffer-type signal.
test("attach wheel fallback: forwards to the child when the local viewport cannot move", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 90_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.ok(parsed.screenLogBytes > 130_000, "the child must flood past the 100 KB replay window before attaching");
	assert.equal(parsed.sawContent, true, "session content must render before wheel dispatch");
	assert.equal(parsed.bufferType, "normal", "topology pin: with the enable outside the replay window the attach reads `normal`");
	assert.equal(parsed.localRoom, 0, "topology pin: the attach-local viewport has no room to travel");
	assert.equal(parsed.upHandled, true, "wheel up must return {handled:true} even though the local viewport cannot move");
	assert.equal(parsed.upRenderFalse, true, "wheel must suppress the redundant render");
	assert.equal(parsed.forwardedUp, "\x1b[<64;4;3M", "wheel up must reach the child as one SGR report (button 64)");
	assert.equal(parsed.forwardedDown, "\x1b[<65;4;3M", "wheel down must reach the child as one SGR report (button 65)");
	assert.equal(parsed.viewportStayedNull, true, "the attach's own viewport must stay on follow-bottom");
	assert.equal(parsed.attachMouseOffFallsThrough, true, "AGENT_BOARD_ATTACH_MOUSE=0 must fall through");
	assert.equal(parsed.attachMouseOffNoForward, true, "AGENT_BOARD_ATTACH_MOUSE=0 must forward nothing");
});
