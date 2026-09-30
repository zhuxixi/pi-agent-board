import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTestMs } from "../src/core/test-knobs.mjs";
import { HOST_PROBE_TIMEOUT_MS, resolveHostProbeTimeoutMs } from "../src/core/host-probe.mjs";
import { ATTACH_RECONNECT_TIMEOUT_MS, resolveAttachReconnectTimeoutMs } from "../src/core/pty-attach-reconnect.mjs";
import {
	HOST_RECOVERY_GRACE_MS,
	HOST_START_GRACE_MS,
	resolveAttachResolveTimeoutMs,
	resolveHostRecoveryGraceMs,
	resolveHostRecoveryPollMs,
	resolveHostStartGraceMs,
} from "../src/runtime/service.mjs";

/** Collect everything written to process.stderr while `fn` runs, then restore. */
function captureStderr(fn) {
	const chunks = [];
	const original = process.stderr.write;
	process.stderr.write = (chunk) => {
		chunks.push(String(chunk));
		return true;
	};
	try {
		fn();
	} finally {
		process.stderr.write = original;
	}
	return chunks;
}

test("resolveTestMs: unset or empty falls back to the default", () => {
	assert.equal(resolveTestMs({}, "AGENT_BOARD_TEST_UNIT_UNSET", 42), 42);
	assert.equal(resolveTestMs({ AGENT_BOARD_TEST_UNIT_UNSET: "" }, "AGENT_BOARD_TEST_UNIT_UNSET", 42), 42);
	// Whitespace-only is blank, not Number(" ") === 0 ⇒ a 0ms hot spin.
	assert.equal(resolveTestMs({ AGENT_BOARD_TEST_HOST_RECOVERY_POLL_MS: " " }, "AGENT_BOARD_TEST_HOST_RECOVERY_POLL_MS", 150), 150);
});

test("resolveTestMs: a numeric string is read as a number", () => {
	assert.equal(resolveTestMs({ AGENT_BOARD_TEST_UNIT_SET: "250" }, "AGENT_BOARD_TEST_UNIT_SET", 42), 250);
	assert.equal(resolveTestMs({ AGENT_BOARD_TEST_UNIT_ZERO: "0" }, "AGENT_BOARD_TEST_UNIT_ZERO", 42), 0);
});

test("resolveTestMs: invalid values fall back and warn exactly once per knob", () => {
	const name = "AGENT_BOARD_TEST_UNIT_INVALID";
	const chunks = captureStderr(() => {
		assert.equal(resolveTestMs({ [name]: "abc" }, name, 42), 42);
		// A second invalid read of the SAME knob must not add a second warning.
		assert.equal(resolveTestMs({ [name]: "-5" }, name, 42), 42);
	});
	assert.equal(chunks.length, 1);
	assert.match(chunks[0], /test-knobs: ignoring invalid AGENT_BOARD_TEST_UNIT_INVALID/);
	// The warning is one-shot per knob name, not global.
	const other = captureStderr(() => {
		assert.equal(resolveTestMs({ AGENT_BOARD_TEST_UNIT_OTHER: "nope" }, "AGENT_BOARD_TEST_UNIT_OTHER", 7), 7);
	});
	assert.equal(other.length, 1);
});

test("per-constant readers: defaults match the exported constants", () => {
	assert.equal(HOST_START_GRACE_MS, 10_000);
	assert.equal(HOST_RECOVERY_GRACE_MS, 5_000);
	assert.equal(HOST_PROBE_TIMEOUT_MS, 250);
	assert.equal(ATTACH_RECONNECT_TIMEOUT_MS, 15_000);
	assert.equal(resolveHostStartGraceMs({}), 10_000);
	assert.equal(resolveHostRecoveryGraceMs({}), 5_000);
	assert.equal(resolveHostRecoveryPollMs({}), 150);
	assert.equal(resolveAttachResolveTimeoutMs({}), 120_000);
	assert.equal(resolveHostProbeTimeoutMs({}), 250);
	assert.equal(resolveAttachReconnectTimeoutMs({}), 15_000);
	// Exported for compatibility — must not have drifted from the reader defaults.
	assert.equal(resolveHostStartGraceMs({}), HOST_START_GRACE_MS);
	assert.equal(resolveHostRecoveryGraceMs({}), HOST_RECOVERY_GRACE_MS);
	assert.equal(resolveHostProbeTimeoutMs({}), HOST_PROBE_TIMEOUT_MS);
	assert.equal(resolveAttachReconnectTimeoutMs({}), ATTACH_RECONNECT_TIMEOUT_MS);
});

test("per-constant readers: env overrides win", () => {
	assert.equal(resolveHostStartGraceMs({ AGENT_BOARD_TEST_HOST_START_GRACE_MS: "25" }), 25);
	assert.equal(resolveHostRecoveryGraceMs({ AGENT_BOARD_TEST_HOST_RECOVERY_GRACE_MS: "30" }), 30);
	assert.equal(resolveHostRecoveryPollMs({ AGENT_BOARD_TEST_HOST_RECOVERY_POLL_MS: "5" }), 5);
	assert.equal(resolveAttachResolveTimeoutMs({ AGENT_BOARD_TEST_ATTACH_RESOLVE_TIMEOUT_MS: "1000" }), 1000);
	assert.equal(resolveHostProbeTimeoutMs({ AGENT_BOARD_TEST_HOST_PROBE_TIMEOUT_MS: "40" }), 40);
	assert.equal(resolveAttachReconnectTimeoutMs({ AGENT_BOARD_TEST_ATTACH_RECONNECT_TIMEOUT_MS: "80" }), 80);
});
