import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-selection-mirror-scenario.ts");

// Component-level coverage (issue #174 B2): the REAL PtyAttachComponent with a
// fake fullscreen TUI (getActiveSelectionText fixture) and a PATH-stubbed
// bidirectional xclip that records reads/writes to a log. Asserts the mirror
// fires on left release/click (deferred one tick), never consumes the event,
// skips empty selections, honors the kill switch, and ignores non-endings.
test("attach selection mirror: left release/click mirrors pi's selection into PRIMARY", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.releaseResultUndefined, true, "release(left) must return undefined (observe only)");
	assert.equal(parsed.mirrorWrites, 1, "exactly one PRIMARY write for the drag-style release");
	assert.equal(parsed.mirrorText, "mirror-fixture-text", "the mirrored text is getActiveSelectionText()'s value");
	assert.equal(parsed.mirrorWriteArgs, "write -selection primary ", "the mirror write targets the X11 PRIMARY selection");
	assert.equal(parsed.clickResultUndefined, true, "click(left) must return undefined");
	assert.equal(parsed.clickMirrorWrites, 1, "the click case also mirrors (selection non-empty)");
	assert.equal(parsed.emptyWrites, 0, "empty selection must not write");
	assert.equal(parsed.killSwitchWrites, 0, "NATIVE_PASTE=0 must disable the mirror");
	assert.equal(parsed.nonEndingWrites, 0, "press/move must not trigger the mirror");
	assert.equal(parsed.middleHandled, true, "middle press still pastes (handled)");
	assert.equal(parsed.clipboardReads, 1, "PASTE_SOURCE=clipboard: exactly one clipboard read");
	assert.equal(parsed.clipboardReadSource, "read -o -selection clipboard", "the read targets the clipboard selection");
	// Issue #172: the copy-on-release highlight must not outlive the copy.
	assert.equal(parsed.releaseClears, 1, "a drag release must clear pi's selection once");
	assert.equal(parsed.clickClears, 1, "a click ending with a live selection clears too");
	assert.equal(parsed.emptyClears, 0, "an empty selection must not clear");
	assert.equal(parsed.killSwitchClears, 1, "the clear is not governed by AGENT_BOARD_ATTACH_NATIVE_PASTE");
	assert.equal(parsed.nonEndingClears, 0, "press/move must not clear");
	assert.equal(parsed.copyOnSelectOffWrites, 1, "the PRIMARY mirror still runs with copy-on-select off");
	assert.equal(parsed.copyOnSelectOffClears, 0, "copy-on-select off keeps the selection for Ctrl+X");
	assert.equal(parsed.fallbackError, null, "a missing clearTextSelection must degrade, not throw");
	assert.equal(parsed.fallbackWrites, 1, "the PRIMARY mirror still runs without the clear method");
});
