import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hasNodePty = await import("node-pty").then(() => true, () => false);
const script = fileURLToPath(new URL("../test-support/attach-startup-color-smoke.ts", import.meta.url));

test("cold attach never leaks an untracked background reply into a canonical PTY", {
	skip: process.platform === "win32" ? "requires POSIX PTY echo" : !hasNodePty && "node-pty unavailable",
	timeout: 15000,
}, () => {
	const result = JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", script], {
		encoding: "utf8",
		timeout: 10000,
	}));
	assert.equal(result.settleQueries, 0, "a missing public query API must not fall back to an unowned raw query");
	assert.deepEqual(result.settleInput, [], "settle must not inject a terminal reply into the still-starting child");
	assert.match(result.startupOutput, /BOOTING/);
	assert.doesNotMatch(result.startupOutput, /rgb:|\^\[\]11;/, "startup must stay free of echoed terminal replies");
	assert.equal(result.canonicalEchoReproduced, true, "positive control must reproduce the original visible remnant");
});
