// Issue #222 step 23a production adapter (task-23a-adapter-brief.md): opt-in REAL-Pi
// smoke for `src/core/attach-frame-reporter.mjs`.
//
// Spawns the actual managed Pi launcher in a real PTY with an owned isolated
// PI_CODING_AGENT_DIR, loads the PRODUCTION adapter (byte-identical copies of
// `src/core/attach-frame-{proof,reporter}.mjs` next to the repo probe extension), and
// validates the REAL DCS markers the adapter writes into the ordered terminal stream.
// No model request, no credentials, no global change. Opt-in:
//
//   PI23A_PROD_SMOKE=1 node --test test/pi23a-production-adapter.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = resolve(REPO_ROOT, "test-support/pi23a-production-smoke-runner.mjs");
const enabled = process.env.PI23A_PROD_SMOKE === "1";
const smoke = enabled ? test : test.skip;
const reason = "set PI23A_PROD_SMOKE=1 to run the real-Pi production-adapter smoke";

smoke(`production adapter real-Pi smoke [${reason}]`, () => {
	const root = mkdtempSync(join(tmpdir(), "pi23a-prod-test-"));
	const artifactDir = join(root, "artifacts");
	try {
		const run = spawnSync(process.execPath, [RUNNER, artifactDir], { encoding: "utf8", timeout: 300_000 });
		assert.equal(run.status, 0, `runner exit: ${run.stdout}${run.stderr}`);
		const result = JSON.parse(readFileSync(join(artifactDir, "result.json"), "utf8"));
		assert.equal(result.status, "completed");
		// Load proof: the PRODUCTION modules loaded byte-identically from inside Pi.
		const load = result.steps.load;
		assert.equal(load.loadCount, 1);
		assert.equal(load.realpathMatches, true);
		assert.equal(load.byteIdentical, true, "probe + production reporter/proof hashes match the repo sources");
		assert.equal(load.packages["@earendil-works/pi-coding-agent"]?.version, "1.4.0");
		// Capability handshake: only the owned fake endpoint enabled it.
		assert.equal(result.steps.install.installed, true);
		assert.deepEqual(result.steps.install.hello, [{ type: "hello", clientId: "frame-reporter", frameWitness: { protocol: 1, sessionEpoch: 1 } }]);
		assert.deepEqual(result.steps.install.installedKeys.sort(), ["columns", "hideCursor", "rows", "showCursor", "start", "stop", "write"]);
		// Real markers in the real stream.
		const markers = result.markers;
		assert.ok(markers.count >= 2, "the adapter wrote real markers into the ordered stream");
		assert.equal(markers.allValid, true);
		assert.equal(markers.allWithinLimit, true, "every complete marker is <= 4096 bytes");
		assert.equal(markers.sBeforeFPerFrame, true, "S precedes F for each proven frame");
		assert.equal(markers.frameIdsStrictlyIncreasing, true, "frame ids are strictly increasing within the token");
		assert.deepEqual(markers.sequence.slice(0, 2).map((entry) => entry.kind), ["S", "F"]);
		// Mode switch: the real renderer stop suspends the adapter and it re-arms.
		assert.equal(result.steps.modeSwitch.modeEvent.mode, "regular");
		assert.equal(result.steps.modeSwitch.modeEvent.reinstalled, true, "the adapter re-installs on the new renderer");
		assert.equal(result.steps.modeSwitch.modeEvent.state, "enabled");
		// fix1: a real POST-SWITCH regular S->F witness (OPEN -> CLOSE -> park -> visibility).
		assert.ok(result.steps.modeSwitch.regularS.length > 0, "a regular frame emitted S after the switch");
		assert.ok(result.steps.modeSwitch.regularF.length > 0, "a regular frame completed with F after the switch");
		const regularFrames = result.markers.details
			.map((marker) => marker.decoded)
			.filter((marker) => marker !== null && marker.kind === "F" && marker.metadata.mode === "regular");
		assert.ok(regularFrames.length > 0, "a real regular F marker carries mode=regular metadata");
		for (const frame of regularFrames) {
			const sIndex = result.markers.sequence.findIndex((entry) => entry.kind === "S" && entry.frameId === frame.frameId);
			const fIndex = result.markers.sequence.findIndex((entry) => entry.kind === "F" && entry.frameId === frame.frameId);
			assert.ok(sIndex >= 0 && sIndex < fIndex, `regular frame ${frame.frameId} has S before F`);
		}
		// Stop: every own shadow restored.
		assert.equal(result.steps.stop.state, "disposed");
		assert.equal(result.steps.stop.restores.filter((entry) => entry.result === "restored").length, 7);
		// Shutdown + isolation.
		assert.equal(result.steps.exit.exited, true);
		assert.equal(result.steps.exit.exitCode, 0);
		assert.equal(result.steps.exit.shutdown.reason, "quit");
		assert.equal(result.isolation.rootRemoved, true);
		assert.deepEqual(result.unknown, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
