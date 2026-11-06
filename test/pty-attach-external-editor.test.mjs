// Issue #278 A3/A4: Ctrl+G external editor (Nvim) live projection in modern
// protocol attach. RED before the Task 4 component fix: the scenario's first
// check must fail because the actual render omits NVIM_VISIBLE_PROBE_1 while
// the underlying parser buffer contains it.
// The component uses TS parameter properties, so the real harness runs in a
// transform-types child process (same seam as the existing attach scenarios).
// Failure artifacts are PRESERVED (path in the assertion message) so the RED
// evidence survives the test run; the temp dir is removed on success.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = resolve(REPO_ROOT, "test-support/pty-attach-external-editor-scenario.ts");

test("issue #278: external editor live projection, interaction ownership and restore fences", () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "pi278-external-editor-"));
	let ok = false;
	try {
		const result = spawnSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: 60_000,
		});
		const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).at(-1);
		const parsed = line ? JSON.parse(line) : null;
		writeFileSync(join(artifactDir, "result.json"), JSON.stringify({ status: result.status, parsed, stderr: result.stderr }, null, 2));
		ok = result.status === 0 && parsed?.ok === true;
		assert.equal(result.status, 0, `scenario failed (artifact preserved at ${artifactDir}): ${(result.stderr ?? "").slice(-2000)}\n${JSON.stringify(parsed, null, 2)}`);
		assert.equal(parsed.ok, true, `scenario checks failed (artifact preserved at ${artifactDir}): ${JSON.stringify(parsed, null, 2)}`);
		assert.deepEqual(parsed.checks.filter((check) => !check.ok), []);
		assert.equal(parsed.checks.length, 7);
		assert.deepEqual(
			parsed.checks.map((check) => check.name),
			[
				"external editor output is projected live while the child owns the screen",
				"same-generation resnapshot adopts runner ownership and keeps the live projection",
				"open-frame hydration never exposes partial content without external ownership",
				"same-generation resize preserves the external live projection",
				"epoch reset and a new generation clear external ownership",
				"legacy fallback resets ownership and renders the live buffer",
				"dispose clears ownership and closes the surface",
			],
		);
	} finally {
		if (!ok) {
			// RED/failure lane: keep the artifact for the issue #278 evidence trail.
			console.error(`pty-attach-external-editor: failure artifact preserved at ${artifactDir}`);
		} else {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	}
});
