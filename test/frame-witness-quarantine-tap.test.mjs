import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGET = "test/attach-frame-witness.integration.test.mjs";
const CASE_NAME = "internal marker failure revokes capability via onUnavailable";

function runTargetFile() {
	// node --test sets NODE_TEST_CONTEXT in the children it spawns; an inherited value makes
	// this nested `node --test` skip running files entirely ("recursive run" warning, empty
	// stdout), so it must be scrubbed to measure the real target file.
	const { NODE_TEST_CONTEXT, ...parentEnv } = process.env;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--test", "--test-reporter=tap", TARGET], {
			cwd: PACKAGE_ROOT,
			env: parentEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
}

test("A7: TAP runs owned and skips only legacy with the issue reason", { timeout: 240_000 }, async () => { // budget: spawns the whole 29-case file; 4 min = 5.3x the 45.08s local measurement
	const result = await runTargetFile();
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.code, 0, `target file failed\n${result.stdout}\n${result.stderr}`);
	const rows = result.stdout
		.split(/\r?\n/)
		// TAP prints a `# Subtest:` header before each result line; both contain the case
		// name, so only `ok`/`not ok` rows may be parsed as the case's actual outcome.
		.filter((line) => /^(?:not )?ok \d+ - /.test(line) && line.includes(CASE_NAME));
	const owned = rows.find((line) => line.includes("(owned main)"));
	const legacy = rows.find((line) => line.includes("(legacy main)"));
	assert.ok(owned, `owned TAP row missing\n${result.stdout}`);
	assert.match(owned, /^ok \d+ - /);
	assert.doesNotMatch(owned, /# SKIP/i);
	assert.ok(legacy, `legacy TAP row missing\n${result.stdout}`);
	// Node's TAP reporter escapes "#" as "\#" inside the skip directive (verified on
	// Node 20 and 24), so the trailing "\\?" accepts both escaped and bare forms.
	assert.match(legacy, /^ok \d+ - .*# SKIP issue \\?#95/);
});
