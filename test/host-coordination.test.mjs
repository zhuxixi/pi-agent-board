import test from "node:test";
import assert from "node:assert/strict";
import {
	canFinalizeLegacyHost,
	canReplaceHost,
	classifyProbeResult,
	isStartingWithinGrace,
	ownsEndpoint,
	processIdentityState,
	sameHostOwner,
	shouldAcceptInput,
	shouldRetryBind,
	shouldYieldRunner,
} from "../src/core/host-coordination.mjs";

test("starting claim without runnerPid is protected inside grace", () => {
	const host = { state: "starting", claimAt: 1000, runnerPid: null, childPid: null };
	assert.equal(isStartingWithinGrace(host, 5000, 10_000), true);
	assert.equal(isStartingWithinGrace(host, 12_000, 10_000), false);
});

test("process identity states", () => {
	assert.equal(processIdentityState(null, null, null), "not_started");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: false }, 1), "dead");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: true, startToken: "t" }, 1), "owned");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: true, startToken: "u" }, 1), "foreign");
	assert.equal(processIdentityState({ pid: 1, startToken: null }, { alive: true }, 1), "unknown");
});

test("canReplaceHost refuses unknown observations", () => {
	const host = { state: "failed" };
	assert.equal(canReplaceHost({ host, runnerObservation: "unknown", childObservation: "dead", claimObservation: "dead", launchLeaseActive: false }), false);
	assert.equal(canReplaceHost({ host, runnerObservation: "dead", childObservation: "not_started", claimObservation: "dead", launchLeaseActive: false }), true);
	assert.equal(canReplaceHost({ host, runnerObservation: "dead", childObservation: "dead", claimObservation: "dead", launchLeaseActive: true }), false);
});

test("canFinalizeLegacyHost requires legacy record + dead pid + unreachable endpoint", () => {
	const base = { host: { instanceId: null, state: "alive" }, hostPid: 999999, hostPidAlive: false, probeClassification: "missing" };
	assert.equal(canFinalizeLegacyHost(base), true);
	assert.equal(canFinalizeLegacyHost({ ...base, probeClassification: "stale" }), true);
	assert.equal(canFinalizeLegacyHost({ ...base, host: { instanceId: null, state: "starting" } }), true);
	assert.equal(canFinalizeLegacyHost({ host: { instanceId: null, state: "starting" }, hostPid: 999999, hostPidAlive: false, probeClassification: "stale" }), true);
	assert.equal(canFinalizeLegacyHost({ ...base, host: { instanceId: "i1", state: "alive" } }), false, "new-protocol host never finalizes here");
	assert.equal(canFinalizeLegacyHost({ ...base, host: { instanceId: null, state: "stopping" } }), false, "stopping has its own recovery path");
	assert.equal(canFinalizeLegacyHost({ ...base, host: { instanceId: null, state: "exited" } }), false);
	assert.equal(canFinalizeLegacyHost({ ...base, host: { instanceId: null, state: "failed" } }), false);
	assert.equal(canFinalizeLegacyHost({ ...base, hostPid: null }), false, "unknown pid is unverifiable — never finalize");
	assert.equal(canFinalizeLegacyHost({ ...base, hostPidAlive: true }), false, "live runner stays conservative pending");
	assert.equal(canFinalizeLegacyHost({ ...base, probeClassification: "unknown" }), false);
	assert.equal(canFinalizeLegacyHost({ ...base, probeClassification: "occupied" }), false);
	assert.equal(canFinalizeLegacyHost({ ...base, probeClassification: "ready" }), false);
	assert.equal(canFinalizeLegacyHost({ ...base, probeClassification: "starting" }), false);
	assert.equal(canFinalizeLegacyHost({ ...base, host: null }), false);
});

test("ownsEndpoint compares dev+ino", () => {
	assert.equal(ownsEndpoint({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }), true);
	assert.equal(ownsEndpoint({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }), false);
});

test("classifyProbeResult maps probe snapshots", () => {
	assert.equal(classifyProbeResult({ connected: true, protocolValid: true, viewMatch: true, instanceMatch: true, state: "alive", readyAt: 1 }), "ready");
	assert.equal(classifyProbeResult({ connected: true, protocolValid: true, state: "starting" }), "starting");
	assert.equal(classifyProbeResult({ connected: true, protocolValid: true, viewMatch: false }), "occupied");
	assert.equal(classifyProbeResult({ connected: false, errorCode: "ENOENT" }), "missing");
	assert.equal(classifyProbeResult({ connected: false, errorCode: "ECONNREFUSED", isSocket: true }), "stale");
	assert.equal(classifyProbeResult({ connected: false, errorCode: "EACCES" }), "unknown");
});

test("sameHostOwner compares the fencing token", () => {
	assert.equal(sameHostOwner({ instanceId: "a" }, "a"), true);
	assert.equal(sameHostOwner({ instanceId: "a" }, "b"), false);
	assert.equal(sameHostOwner(null, "a"), false);
	assert.equal(sameHostOwner({ instanceId: "a" }, null), false);
	assert.equal(sameHostOwner({ instanceId: null }, null), false, "null instanceId never owns: no accidental legacy match");
});

test("shouldYieldRunner only yields to another active instance", () => {
	for (const state of ["starting", "alive", "stopping"]) {
		assert.equal(shouldYieldRunner({ host: { instanceId: "other", state }, instanceId: "mine" }), true, `state ${state} must yield`);
	}
	assert.equal(shouldYieldRunner({ host: { instanceId: "mine", state: "alive" }, instanceId: "mine" }), false, "own instance never yields");
	assert.equal(shouldYieldRunner({ host: { instanceId: "other", state: "exited" }, instanceId: "mine" }), false, "terminal foreign host does not yield");
	assert.equal(shouldYieldRunner({ host: null, instanceId: "mine" }), false, "no host record does not yield");
});

test("shouldAcceptInput requires a ready, unrevoked host", () => {
	assert.equal(shouldAcceptInput({ state: "alive", readyAt: 1, stopRequestedAt: null }), true);
	assert.equal(shouldAcceptInput({ state: "alive", readyAt: 1, stopRequestedAt: 5 }), false, "revoked host must refuse input");
	assert.equal(shouldAcceptInput({ state: "alive", readyAt: null }), false, "alive without readyAt is still starting");
	assert.equal(shouldAcceptInput({ state: "starting", readyAt: null }), false);
	assert.equal(shouldAcceptInput(null), false);
});

test("shouldRetryBind retries EADDRINUSE exactly once", () => {
	assert.equal(shouldRetryBind("EADDRINUSE", 0), true);
	assert.equal(shouldRetryBind("EADDRINUSE", 1), false);
	assert.equal(shouldRetryBind("EACCES", 0), false);
});
