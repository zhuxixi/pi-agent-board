// Issue #278 A5: REAL managed Pi + real runner/PTY + real Nvim Ctrl+G external
// editor round trip through real PtyAttachComponent instances.
// Opt-in lane: PI278_REAL_NVIM=1 node --test test/attach-external-editor.real.test.mjs
// Optional fresh PI278_ARTIFACT_DIR retains the full evidence (renders, buffer
// facts, frameWitness snapshots, cleanup). No model request, no auth/global
// change; isolated root, PI_CODING_AGENT_DIR, and child cwd.
// Registered only in the opt-in lane so the default `npm test` inventory keeps
// its existing skip count (this file contributes no skipped test case when off).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DRIVER = resolve(REPO_ROOT, "test-support/attach-external-editor-real.ts");
const enabled = process.env.PI278_REAL_NVIM === "1";
const reason = "set PI278_REAL_NVIM=1 to run the real Pi/Nvim external editor round trip";
const ARTIFACT_DIR = process.env.PI278_ARTIFACT_DIR ? resolve(process.env.PI278_ARTIFACT_DIR) : null;

if (enabled) test(`issue #278 real Ctrl+G/Nvim attach round trip [${reason}]`, async (t) => {
	// Freshness is asserted here; the DRIVER creates the directory so an
	// already-existing path can only come from a previous run, never from us.
	assert.ok(!ARTIFACT_DIR || !existsSync(ARTIFACT_DIR), "PI278_ARTIFACT_DIR must be fresh (overwrite refused)");
	const pi = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).stdout.trim();
	const nvim = spawnSync("sh", ["-lc", "command -v nvim"], { encoding: "utf8" }).stdout.trim();
	if (pi === "" || nvim === "") {
		// A5 stays pending, never a false pass: the lane reports an explicit skip.
		t.skip(`real executables unavailable: pi=${pi === "" ? "missing" : pi} nvim=${nvim === "" ? "missing" : nvim}`);
		return;
	}
	const result = spawnSync(process.execPath, ["--experimental-transform-types", DRIVER], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 480_000,
		env: {
			...process.env,
			PI278_PI: realpathSync(pi),
			PI278_NVIM: realpathSync(nvim),
			...(ARTIFACT_DIR ? { PI278_ARTIFACT_DIR: ARTIFACT_DIR } : {}),
		},
	});
	const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).at(-1);
	const parsed = line ? JSON.parse(line) : null;
	if (ARTIFACT_DIR) {
		mkdirSync(ARTIFACT_DIR, { recursive: true });
		writeFileSync(join(ARTIFACT_DIR, "driver-stdout.txt"), result.stdout ?? "");
		writeFileSync(join(ARTIFACT_DIR, "driver-stderr.txt"), result.stderr ?? "");
		writeFileSync(join(ARTIFACT_DIR, "wrapper-result.json"), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message ?? null, parsed }, null, 2));
	}
	assert.equal(result.status, 0, `real driver failed (artifacts: ${ARTIFACT_DIR ?? "not requested"}): ${(result.stderr ?? "").slice(-2000)}\n${JSON.stringify(parsed, null, 2)?.slice(-4000)}`);
	assert.equal(parsed?.ok, true, `real round trip failed (artifacts: ${ARTIFACT_DIR ?? "not requested"}): ${JSON.stringify(parsed, null, 2)?.slice(-4000)}`);
	assert.equal(parsed.cleanup.naturalExit, true, "child and runner exited naturally with no forced kill");
	assert.deepEqual(parsed.cleanup.forcedKills, []);
	assert.equal(parsed.cleanup.rootRemoved, true);
	assert.equal(parsed.cleanup.agentDirRemoved, true);
});
