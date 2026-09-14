import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = join(ROOT_DIR, "test-support", "pty-attach-protocol-scenario.ts");

// Component-level protocol-attach coverage (issue #91 phase 4): the REAL
// PtyAttachComponent against a REAL runner must attach via snapshot+subscribe
// (subscribe_terminal sent, session content rendered, and — the protocol-mode
// discriminator — zero resize messages, since the legacy shrink-and-hold
// attach always resizes at connect).
test("attach switch: component attaches via snapshot protocol with no jiggle resize", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
	assert.equal(parsed.error, null, `scenario error: ${parsed.error}`);
	assert.equal(parsed.sawContent, true, "session content must render (snapshot hydrate + live output)");
	assert.equal(parsed.subscribeSent, true, "component must send subscribe_terminal (protocol probe)");
	assert.equal(parsed.resizesBeforeContent, 0, "protocol attach must not send jiggle resizes before content");
	assert.equal(parsed.resizesTotal, 0, "no jiggle resizes at all in protocol mode (no user resize in scenario)");
});
