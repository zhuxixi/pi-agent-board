import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("PTY attach header places a stored PR/MR beside the session name", () => {
	const fixture = fileURLToPath(new URL("../test-support/pty-attach-pr-header.ts", import.meta.url));
	const headers = JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", fixture], {
		encoding: "utf8", timeout: 15_000,
	}));
	assert.equal(headers.length, 3);
	assert.match(headers[0], /^ nick whatsapp /);
	assert.doesNotMatch(headers[0], /PR #|MR !/);
	assert.match(headers[1], /^ nick whatsapp · PR #271 /);
	assert.match(headers[2], /^ nick whatsapp · MR !42 /);
});
