import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../test-support/attach-reply-guard-smoke.ts", import.meta.url));
const DA1_CHUNKS = ["\x1b[?61;6;", "7;22;23;", "24;28;32", ";42c"];
let cached = null;
const run = () => (cached ??= JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", script], {
	encoding: "utf8", timeout: 15000,
})));

test("A6: fragmented DA1 never reaches the child, color replies still do", () => {
	const out = run();
	assert.deepEqual(out.guardedFragments, [], "four DA1 reads through the real handleInput must emit no input frame");
	assert.deepEqual(out.guardedColorReply, ["\x1b]11;rgb:2887/2a18/353c\x1b\\"], "a complete color reply is forwarded byte-for-byte");
	assert.deepEqual(out.killSwitchFragments, DA1_CHUNKS, "AGENT_BOARD_REPLY_GUARD=0 restores the pre-#170 passthrough");
});

test("A7: an armed window sends nothing and dispose() cleans it up", () => {
	const out = run();
	assert.deepEqual(out.armedFrames, [], "an armed guard must not emit frames");
	assert.notEqual(out.pendingBeforeDispose, null, "the smoke needs an open window for the cleanup assertion");
	assert.equal(out.pendingAfterDispose, null, "dispose() resets the guard");
	assert.equal(out.timerAfterDispose, null, "dispose() clears the window timer");
});
