import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-wheel-scenario.ts");

// Component-level fullscreen wheel coverage (issue #173 follow-up): the REAL
// PtyAttachComponent against a fake TUI and a nonexistent control socket, with
// its xterm scrollback filled directly. The renderer's routeWheel fallback only
// moves real ScrollView components, so a wheel event returned unconsumed scrolls
// nothing and the fullscreen wheel goes dead. No runner socket and no xclip stub
// are involved, so this case is portable across platforms.
test("attach fullscreen wheel: scrolls the local viewport, falls through when it cannot move", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.ok(parsed.room > 0, "scrollback must exceed one screen for the wheel to have room to move");
	assert.equal(parsed.upHandled, true, "wheel up must return {handled:true}");
	assert.equal(parsed.upRenderFalse, true, "wheel must suppress the redundant render (tryScrollBy already scheduled one)");
	assert.equal(parsed.upMovedByDelta, true, "wheel up must move the viewport up by exactly the reported delta");
	assert.equal(parsed.downHandled, true, "wheel down must be consumed while it still moves");
	assert.equal(parsed.downLandedOnBottom, true, "wheel down must land on follow-bottom");
	assert.equal(parsed.atBottomFallsThrough, true, "a disconnected attach must fall through instead of dropping a forward (issue #198)");
	assert.equal(parsed.missingDeltaFallsThrough, true, "a wheel report with no delta must fall through");
	assert.equal(parsed.nonWheelFallsThrough, true, "a non-wheel press must keep falling through");
	assert.equal(parsed.attachMouseOffFallsThrough, true, "AGENT_BOARD_ATTACH_MOUSE=0 must fall through in fullscreen too");
	assert.equal(parsed.attachMouseOffNoMove, true, "AGENT_BOARD_ATTACH_MOUSE=0 must not move the viewport");
	assert.equal(parsed.scrollSwitchOffFallsThrough, true, "AGENT_BOARD_ENABLE_MOUSE_SCROLL=0 must fall through in fullscreen too");
	assert.equal(parsed.scrollSwitchOffNoMove, true, "AGENT_BOARD_ENABLE_MOUSE_SCROLL=0 must not move the viewport");
	assert.equal(parsed.restoredAfterKillSwitch, true, "clearing the kill switches must restore local wheel scrolling");
});
