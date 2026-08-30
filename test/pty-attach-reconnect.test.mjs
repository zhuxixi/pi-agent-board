import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ATTACH_HOST_START_TIMEOUT_MS,
	ATTACH_RECONNECT_TIMEOUT_MS,
	evaluateAttachReconnect,
	shouldEscapeAttach,
} from "../src/core/pty-attach-reconnect.mjs";

test("shouldEscapeAttach detaches unconditionally while disconnected", () => {
	assert.equal(shouldEscapeAttach(false, false), true);
	assert.equal(shouldEscapeAttach(false, true), true);
	assert.equal(shouldEscapeAttach(true, true), true);
	// Connected + non-empty child input line → the key must be forwarded, not detach.
	assert.equal(shouldEscapeAttach(true, false), false);
});

test("evaluateAttachReconnect: previously-connected host gives 15s after disconnect", () => {
	const t0 = 1_000_000;
	const base = { everConnected: true, disconnectedAt: t0, connectStartedAt: t0 - 600_000 };
	assert.deepEqual(evaluateAttachReconnect({ ...base, now: t0 + 14_999 }), { giveUp: false, status: null });
	assert.deepEqual(evaluateAttachReconnect({ ...base, now: t0 + 15_000 }), { giveUp: true, status: "host exited" });
	assert.equal(ATTACH_RECONNECT_TIMEOUT_MS, 15_000);
});

test("evaluateAttachReconnect: never-connected host gets a long start window", () => {
	const t0 = 1_000_000;
	const base = { everConnected: false, disconnectedAt: null, connectStartedAt: t0 };
	assert.deepEqual(evaluateAttachReconnect({ ...base, now: t0 + ATTACH_HOST_START_TIMEOUT_MS - 1 }), { giveUp: false, status: null });
	assert.deepEqual(evaluateAttachReconnect({ ...base, now: t0 + ATTACH_HOST_START_TIMEOUT_MS }), { giveUp: true, status: "host not reachable" });
});

test("evaluateAttachReconnect never gives up before any timeout", () => {
	const t0 = 1_000_000;
	assert.deepEqual(evaluateAttachReconnect({ everConnected: false, disconnectedAt: null, connectStartedAt: t0, now: t0 + 1 }), { giveUp: false, status: null });
	assert.deepEqual(evaluateAttachReconnect({ everConnected: true, disconnectedAt: t0, connectStartedAt: t0, now: t0 + 1 }), { giveUp: false, status: null });
});
