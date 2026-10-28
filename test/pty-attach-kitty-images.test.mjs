import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../test-support/kitty-images-smoke.ts", import.meta.url));

test("real attach Kitty rendering, clipping, cleanup and non-Kitty isolation", () => {
	const env = { ...process.env, AGENT_BOARD_FORWARD_IMAGES: "1" };
	delete env.NODE_TEST_CONTEXT; // This subprocess owns its own node:test runner.
	const output = execFileSync(process.execPath, ["--experimental-transform-types", "--test", "--test-reporter=tap", script], {
		encoding: "utf8",
		timeout: 30_000,
		env,
	});
	assert.match(output, /# pass 6/);
	assert.match(output, /# fail 0/);
});
