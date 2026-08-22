import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	diagnoseNodePtyFailure,
	ensureNodePtySpawnHelperExecutable,
	nodePtyFallbackMessage,
	nodePtySpawnHelperPaths,
	probeNodePtyEnvironment,
	resolveNodePtyPackageRoot,
} from "../src/core/pty-support.mjs";

const requireForPty = createRequire(import.meta.url);

/** Build a fake `require.resolve` rooted at a temp dir. */
function fakeRequire(root, { resolveFails = false } = {}) {
	return {
		resolve(request) {
			if (resolveFails) throw new Error("module not found");
			if (request === "node-pty/package.json") return join(root, "node-pty", "package.json");
			throw new Error(`unexpected request ${request}`);
		},
	};
}

test("resolveNodePtyPackageRoot returns the installed node-pty root", () => {
	const root = resolveNodePtyPackageRoot(requireForPty);
	assert.ok(root, "node-pty is installed as a dev dependency");
	assert.ok(root.endsWith("/"), "returns a directory prefix");
});

test("resolveNodePtyPackageRoot returns null when resolution fails", () => {
	assert.equal(resolveNodePtyPackageRoot(fakeRequire("/tmp", { resolveFails: true })), null);
});

test("nodePtySpawnHelperPaths builds prebuild and build paths", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-pty-paths-"));
	try {
		const paths = nodePtySpawnHelperPaths(fakeRequire(root), "linux", "x64");
		assert.deepEqual(paths, [
			join(root, "node-pty", "prebuilds", "linux-x64", "spawn-helper"),
			join(root, "node-pty", "build", "Release", "spawn-helper"),
		]);
		assert.deepEqual(nodePtySpawnHelperPaths(fakeRequire(root, { resolveFails: true })), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureNodePtySpawnHelperExecutable chmods non-executable helpers and skips the rest", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-pty-chmod-"));
	try {
		const prebuildDir = join(root, "node-pty", "prebuilds", "darwin-arm64");
		mkdirSync(prebuildDir, { recursive: true });
		const nonExec = join(prebuildDir, "spawn-helper");
		writeFileSync(nonExec, "#!/bin/sh\n", { mode: 0o644 });

		const touched = ensureNodePtySpawnHelperExecutable(fakeRequire(root), "darwin", "arm64");
		assert.deepEqual(touched, [nonExec]);
		assert.equal(Boolean(statSync(nonExec).mode & 0o111), true, "chmod must actually set an execute bit");
		// Second pass: helper is now executable, so nothing is touched.
		assert.deepEqual(ensureNodePtySpawnHelperExecutable(fakeRequire(root), "darwin", "arm64"), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("probeNodePtyEnvironment reports a missing helper", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-pty-probe-"));
	try {
		const probe = probeNodePtyEnvironment(fakeRequire(root), "linux", "x64");
		assert.equal(probe.helperExists, false);
		assert.equal(probe.helperExecutable, null);
		assert.equal(probe.helperQuarantined, null);
		assert.ok(probe.helperPath, "first candidate path is reported even when missing");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("probeNodePtyEnvironment detects a present non-executable helper", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-pty-probe-"));
	try {
		const helper = join(root, "node-pty", "prebuilds", "linux-x64", "spawn-helper");
		mkdirSync(join(helper, ".."), { recursive: true });
		writeFileSync(helper, "#!/bin/sh\n", { mode: 0o644 });
		const probe = probeNodePtyEnvironment(fakeRequire(root), "linux", "x64");
		assert.equal(probe.helperExists, true);
		assert.equal(probe.helperExecutable, false);
		assert.equal(probe.helperQuarantined, null, "xattr probe only runs on darwin");
		chmodSync(helper, 0o755);
		assert.equal(probeNodePtyEnvironment(fakeRequire(root), "linux", "x64").helperExecutable, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("probeNodePtyEnvironment runs the darwin quarantine check", () => {
	const root = mkdtempSync(join(tmpdir(), "agentview-pty-probe-"));
	try {
		const helper = join(root, "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
		mkdirSync(join(helper, ".."), { recursive: true });
		writeFileSync(helper, "#!/bin/sh\n", { mode: 0o755 });
		// On Linux there is no `xattr` binary: spawnSync returns status null
		// without throwing, so the quarantine check resolves to false — but the
		// darwin code path itself must run without erroring.
		const probe = probeNodePtyEnvironment(fakeRequire(root), "darwin", "arm64");
		assert.equal(probe.helperExists, true);
		assert.equal(probe.helperExecutable, true);
		assert.equal(probe.helperQuarantined, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("diagnoseNodePtyFailure maps the disabled-env override", () => {
	const issue = diagnoseNodePtyFailure("AGENT_BOARD_DISABLE_PTY=1");
	assert.equal(issue.id, "disabled-env");
	assert.match(issue.fixHint, /AGENT_BOARD_DISABLE_PTY/);
});

test("diagnoseNodePtyFailure maps a missing node-pty module", () => {
	const issue = diagnoseNodePtyFailure('Cannot find module "node-pty"');
	assert.equal(issue.id, "missing-module");
	assert.match(issue.fixHint, /reinstall/i);
	assert.ok(issue.steps.length >= 2);
});

test("diagnoseNodePtyFailure maps missing native bindings", () => {
	const issue = diagnoseNodePtyFailure("Could not locate the bindings file");
	assert.equal(issue.id, "native-missing");
	assert.match(issue.fixHint, /reinstall or rebuild node-pty/i);
});

test("diagnoseNodePtyFailure maps native ABI mismatches", () => {
	const issue = diagnoseNodePtyFailure("Module did not self-register: NODE_MODULE_VERSION mismatch");
	assert.equal(issue.id, "native-mismatch");
	assert.match(issue.fixHint, /same Node version and architecture/i);
});

test("diagnoseNodePtyFailure maps the macOS helper variants", () => {
	const darwin = { platform: "darwin" };

	const missing = diagnoseNodePtyFailure("spawn-helper: posix_spawnp failed", {
		...darwin,
		probe: { helperPath: "/x/spawn-helper", helperExists: false, helperExecutable: null, helperQuarantined: null },
	});
	assert.equal(missing.id, "macos-spawn-helper-missing");

	const notExec = diagnoseNodePtyFailure("permission denied", {
		...darwin,
		probe: { helperPath: "/tmp/spawn-helper", helperExists: true, helperExecutable: false, helperQuarantined: null },
	});
	assert.equal(notExec.id, "macos-spawn-helper-mode");
	assert.match(notExec.summary, /does not have execute permission/i);
	assert.ok(notExec.steps.some((step) => step.includes("chmod +x '/tmp/spawn-helper'")), "steps must quote the exact helper path");

	const quarantined = diagnoseNodePtyFailure("operation not permitted", {
		...darwin,
		probe: { helperPath: "/x/spawn-helper", helperExists: true, helperExecutable: true, helperQuarantined: true },
	});
	assert.equal(quarantined.id, "macos-spawn-helper-quarantine");
	assert.ok(quarantined.steps.some((step) => step.includes("xattr")));

	const blocked = diagnoseNodePtyFailure("EACCES spawning", { ...darwin, probe: null });
	assert.equal(blocked.id, "macos-spawn-helper");

	// Non-darwin platforms must not take the macOS branch for the same reason.
	const other = diagnoseNodePtyFailure("permission denied", { platform: "linux" });
	assert.equal(other.id, "generic");
});

test("diagnoseNodePtyFailure falls back to generic with a cleaned reason", () => {
	const issue = diagnoseNodePtyFailure("  some   weird\n\nerror ", { platform: "linux" });
	assert.equal(issue.id, "generic");
	assert.equal(issue.rawReason, "some weird error");
	const blank = diagnoseNodePtyFailure(null, { platform: "linux" });
	assert.equal(blank.rawReason, "unknown error");
});

test("nodePtyFallbackMessage renders issues and diagnoses bare reasons", () => {
	assert.equal(nodePtyFallbackMessage({ ok: true }), undefined);

	const withIssue = nodePtyFallbackMessage({ ok: false, issue: diagnoseNodePtyFailure("AGENT_BOARD_DISABLE_PTY=1") });
	assert.match(withIssue, /PTY is disabled/);
	assert.match(withIssue, /Press ! for exact steps/);

	// Bare reason without an issue diagnoses from scratch.
	const bareReason = nodePtyFallbackMessage({ ok: false, reason: "posix_spawnp failed" });
	assert.match(bareReason, /Live PTY is disabled/i);
	assert.match(bareReason, /Press ! for exact steps/);

	const missingModule = nodePtyFallbackMessage({ ok: false, reason: "Cannot find module 'node-pty'" });
	assert.match(missingModule, /node-pty dependency is missing/);
});
