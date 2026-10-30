// Issue #222 step 23b2c2: managed parser replacement + callback fences.
// The component uses TS parameter properties, so the real harness runs in a
// transform-types child process (same seam as the existing attach scenarios).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCENARIO = resolve(REPO_ROOT, "test-support/pty-attach-parser-replacement-scenario.ts");

test("step 23b2c2: parser replacement, callback fences, empty reset and observer reattach", () => {
	const artifactDir = mkdtempSync(join(tmpdir(), "parser-replacement-"));
	try {
		const result = spawnSync(process.execPath, ["--experimental-transform-types", SCENARIO], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: 60_000,
		});
		const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).at(-1);
		const parsed = line ? JSON.parse(line) : null;
		writeFileSync(join(artifactDir, "result.json"), JSON.stringify({ status: result.status, parsed, stderr: result.stderr }, null, 2));
		assert.equal(result.status, 0, `scenario failed: ${(result.stderr ?? "").slice(-2000)}\n${JSON.stringify(parsed, null, 2)}`);
		assert.equal(parsed.ok, true, JSON.stringify(parsed, null, 2));
		assert.deepEqual(parsed.checks.filter((check) => !check.ok), []);
		assert.equal(parsed.checks.length, 27);
		assert.deepEqual(
			parsed.checks.map((check) => check.name),
			[
				"snapshotReady replaces with observers before the frame",
				"RED fix1: snapshotReady adopts fresh viewProof/records facts",
				"RED fix1 addendum: resnapshot-with-frame/no-proof is not empty-baseline",
				"RED fix1: replacement failure drops subsequent protocol output",
				"RED fix1: observer-unavailable constructor falls back to legacy",
				"RED fix1: shared instrument captures the first post-replacement enqueue+drain",
				"late old-parser callback after newer baseline has zero effects",
				"same-parser reconnect invalidates old-connection callback",
				"dispose invalidates callbacks and releases observers",
				"empty/resnapshot replaces content and clears floor without first hooks",
				"creation/observer failure writes nothing to the old parser",
				"instrumentInnerParser reattaches per replacement with ordered identities",
				"step25: post-proof replay must be contiguous or coverage fails closed",
				"step25: synchronous parser write throw restores the in-flight counter",
				"step25: stale-epoch callback never cancels a newer in-flight count",
				"step25 fix1: display-A/parser-B selection, copy, word and interaction range stay committed",
				"step25 fix2: OSC8 and plain URL hits stay on committed A after parser B URLs differ",
				"step25 fix1: CJK width/copy and background attrs survive the committed snapshot",
				"step25 fix2: open-block scroll records intent and applies it only at the real close",
				"step25 fix1: hydration ending open commits nothing until a real close",
				"step25 fix2: post-close DECTCEM is parser-drained but leaves the committed grid unchanged",
				"step26 fix2: every early sync advances; next render consumes one; divergence/A same-size",
				"step27: same-generation recovery displays last complete view and interactions",
				"step27: new committed content replaces recovery atomically",
				"step27: epoch/empty/geometry/dispose invalidate recovery and current",
				"step28: old wait-identity deadline callbacks are no-ops; current expiry still fires",
				"step28: close adapter cancels old frame but a later unrelated render still works",
			],
		);
	} finally {
		rmSync(artifactDir, { recursive: true, force: true });
	}
});
