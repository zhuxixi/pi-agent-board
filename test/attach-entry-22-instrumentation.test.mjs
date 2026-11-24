import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGET = "test/attach-entry-22.test.mjs";
const CASE_B = "step 22/24 B: 25 ms continuous real-entry modern publish";
const CASE_Q = "step 22/24 Q: nonempty-then-quiet real-entry modern publish";

function runTarget(env) {
	return new Promise((resolve, reject) => {
		// Node 24's default reporter is spec even when piped; the guard parses TAP
		// result rows, so the child must be told to emit TAP (Node 22 piped TAP by
		// default — same output, now explicit).
		const child = spawn(process.execPath, ["--test", "--test-reporter=tap", TARGET], {
			cwd: PACKAGE_ROOT,
			env,
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

function resultRows(stdout) {
	return stdout.split(/\r?\n/)
		// `# Subtest:` headers carry the same names; only result rows are outcomes.
		.filter((line) => /^(?:not )?ok \d+ - /.test(line));
}

test("A4: B/Q run clean and skip only under instrumentation", { timeout: 120_000 }, async () => { // budget: spawns the 4-case file twice (~20s clean + ~1s skipped); 2 min = 6x headroom
	// Node re-injects NODE_V8_COVERAGE into spawned children while coverage is
	// active in THIS process — even when the explicit env omits it — so deleting it
	// here is the only way the clean child is actually plain (design D3: the guard
	// constructs its own clean env; c8 exports the variable to the whole child tree).
	delete process.env.NODE_V8_COVERAGE;
	const { NODE_TEST_CONTEXT, ...base } = process.env;

	const clean = await runTarget(base);
	assert.equal(clean.signal, null, clean.stderr);
	assert.equal(clean.code, 0, `clean run failed\n${clean.stdout}\n${clean.stderr}`);
	for (const name of [CASE_B, CASE_Q]) {
		const row = resultRows(clean.stdout).find((line) => line.includes(name));
		assert.ok(row, `clean TAP row missing for ${name}\n${clean.stdout}`);
		assert.match(row, /^ok \d+ - /);
		assert.doesNotMatch(row, /# SKIP/i);
	}

	const covDir = mkdtempSync(join(tmpdir(), "issue305-cov-"));
	try {
		const instrumented = await runTarget({ ...base, NODE_V8_COVERAGE: covDir });
		assert.equal(instrumented.signal, null, instrumented.stderr);
		assert.equal(instrumented.code, 0, `instrumented run failed\n${instrumented.stdout}\n${instrumented.stderr}`);
		for (const name of [CASE_B, CASE_Q]) {
			const row = resultRows(instrumented.stdout).find((line) => line.includes(name));
			assert.ok(row, `instrumented TAP row missing for ${name}\n${instrumented.stdout}`);
			// Node's TAP escapes "#" as "\#" in skip directives; "\\?" = optional literal backslash.
			assert.match(row, /^ok \d+ - .*# SKIP issue \\?#305/);
		}
	} finally {
		rmSync(covDir, { recursive: true, force: true });
	}
});
