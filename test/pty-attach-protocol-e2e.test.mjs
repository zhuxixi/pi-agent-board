import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-protocol-scenario.ts");
const RESTART_SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-restart-scenario.ts");

// Component-level protocol-attach coverage (issue #91 phase 4): the REAL
// PtyAttachComponent against a REAL runner must attach via snapshot+subscribe
// (subscribe_terminal sent, session content rendered). Size-sync contract
// (CR R1 blocking): a same-size attach sends ZERO resizes (still pins protocol
// mode — the legacy shrink-and-hold attach always resizes at connect); a
// differing-size attach sends EXACTLY ONE resize to the true terminal size,
// never a jiggle shrink/restore pattern.
test("attach switch: component attaches via snapshot protocol with no jiggle resize", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.hostRows, 22, "default scenario must be the same-size case");
	assert.equal(parsed.sawContent, true, "session content must render (snapshot hydrate + live output)");
	assert.equal(parsed.subscribeSent, true, "component must send subscribe_terminal (protocol probe)");
	assert.equal(parsed.resizesBeforeContent, 0, "protocol attach must not send jiggle resizes before content");
	assert.equal(parsed.resizesTotal, 0, "same-size attach: snapshot_begin geometry matches → no resize at all");
	assert.deepEqual(parsed.resizeSizes, []);
});

test("size-sync: differing host/terminal geometry resizes exactly once to the TRUE size (CR R1 blocking)", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, SCENARIO_HOST_ROWS: "24" },
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.hostRows, 24, "scenario must run the differing-size case");
	assert.equal(parsed.sawContent, true, "session content must render at the corrected size");
	assert.equal(parsed.subscribeSent, true, "protocol probe still sent");
	// Exactly one resize, to the component's computed TRUE size (tui 24 rows -
	// 2 chrome = 22): the snapshot_begin size-sync. No jiggle shrink/restore
	// pattern (any resize at any other size fails this).
	assert.deepEqual(parsed.resizeSizes, [{ cols: 80, rows: 22 }]);
	assert.equal(parsed.resizesTotal, 1);
});

test("A6: component survives runner kill/restart — fresh baseline wipes old screen, recovery never reads screen.log, no jiggle across reconnect", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", RESTART_SCENARIO], {
		encoding: "utf8",
		timeout: 90_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.sawContent, true, "pre-kill session content must render");
	assert.equal(parsed.sawPreKillEcho, true, "pre-kill discriminator must be on the old screen");
	assert.equal(parsed.resizesBeforeContent, 0, "initial attach is protocol (no jiggle)");
	assert.equal(parsed.subscribeCount >= 2, true, "reconnect must re-subscribe (initial probe + reconnect)");
	assert.equal(parsed.convergedToNewChild, true, "UI must converge to the NEW child's output via fresh baseline hydrate");
	assert.equal(parsed.oldScreenVisibleAfterRestart, false, "old screen (pre-kill echo) must never reappear after the restart baseline (F3 pin)");
	assert.equal(parsed.poisonVisible, false, "screen.log must never feed recovery (poison marker never renders)");
	assert.equal(parsed.resizesTotal, 0, "no jiggle resizes across the whole session including restart reconnect");
});
