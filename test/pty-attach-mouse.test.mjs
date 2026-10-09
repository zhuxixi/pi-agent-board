import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-mouse-scenario.ts");

// Component-level coverage (issue #167): the REAL PtyAttachComponent against a
// REAL runner socket, with a PATH-stubbed xclip printing a fixture string.
// Asserts the fullscreen handleMouse path pastes PRIMARY as input, the legacy
// handleInput SGR path still does (regular-mode regression), and the
// AGENT_BOARD_ATTACH_NATIVE_PASTE=0 kill switch turns both off.
test("attach mouse: middle-press handleMouse pastes PRIMARY; legacy path intact; kill switch honored", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.sawContent, true, "session content must render before mouse dispatch");
	assert.equal(parsed.fullscreenHandled, true, "handleMouse(middle press) must return {handled:true, render:false}");
	assert.equal(parsed.fullscreenInput, "primary-paste-fixture", "PRIMARY fixture must reach the attach socket as input");
	assert.equal(parsed.offUndefined, true, "kill switch: handleMouse must return undefined");
	assert.equal(parsed.offNoInput, true, "kill switch: no input may be forwarded");
	assert.equal(parsed.legacyInput, "primary-paste-fixture", "legacy SGR middle press must still paste");
});
