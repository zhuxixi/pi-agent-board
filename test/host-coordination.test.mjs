import test from "node:test";
import assert from "node:assert/strict";
import {
	canFinalizeLegacyHost,
	canReplaceHost,
	classifyProbeResult,
	classifyUnverifiableProcess,
	commandLineMentions,
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

test("processIdentityState: an identity-bearing record is never not_started", () => {
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: true, startToken: "t" }, null), "owned");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: true, startToken: "u" }, null), "foreign");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: false }, null), "dead");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: true, startToken: null }, null), "unknown");
});

test("processIdentityState: not_started needs both identity and spawnedAt to be absent", () => {
	assert.equal(processIdentityState(null, null, null), "not_started");
	assert.equal(processIdentityState(undefined, null, null), "not_started");
});

test("commandLineMentions normalizes slashes/case and respects path boundaries", () => {
	assert.equal(commandLineMentions('node C:\\x\\cli.js --session "C:\\a b\\s.jsonl"', "C:/a b/s.jsonl"), true);
	assert.equal(commandLineMentions("NODE --session c:\\A\\S.JSONL", "C:\\a\\s.jsonl"), true);
	// prefix trap: view_abc must not match view_abcd
	assert.equal(commandLineMentions("node x --session C:\\v\\view_abcd.jsonl", "C:\\v\\view_abc.jsonl"), false);
	assert.equal(commandLineMentions("node x --session C:\\v\\session-2.jsonl", "C:\\v\\session.jsonl"), false);
	// suffix trap: the fragment must not match as a prefix of a longer file name
	assert.equal(commandLineMentions("node x --session C:\\v\\s.jsonl.bak", "C:\\v\\s.jsonl"), false);
	assert.equal(commandLineMentions("", "C:\\v\\s.jsonl"), false);
});

test("classifyUnverifiableProcess truth table", () => {
	const probe = (creationTimeMs, commandLine) => ({ creationTimeMs, commandLine });
	const base = { spawnedAt: 1_000_000, expectedCommandFragment: "C:\\v\\s.jsonl", toleranceMs: 5_000 };
	assert.equal(classifyUnverifiableProcess({ ...base, probe: null }), "unknown");
	assert.equal(classifyUnverifiableProcess({ ...base, probe: probe(9_999_999, "node --session C:\\v\\s.jsonl") }), "owned");
	assert.equal(classifyUnverifiableProcess({ ...base, probe: probe(9_999_999, "node other.js") }), "foreign");
	assert.equal(classifyUnverifiableProcess({ ...base, probe: probe(1_002_000, null) }), "owned");
	assert.equal(classifyUnverifiableProcess({ ...base, probe: probe(900_000, null) }), "foreign");
	assert.equal(classifyUnverifiableProcess({ ...base, probe: probe(1_020_000, null) }), "foreign");
	// command line wins over a null spawnedAt
	assert.equal(classifyUnverifiableProcess({ ...base, spawnedAt: null, probe: probe(5, "node --session C:\\v\\s.jsonl") }), "owned");
	// no signal at all
	assert.equal(classifyUnverifiableProcess({ ...base, spawnedAt: null, probe: probe(1_000_000, null) }), "unknown");
	assert.equal(classifyUnverifiableProcess({ ...base, expectedCommandFragment: null, probe: probe(1_000_000, "node x") }), "owned");
});

test("canReplaceHost refuses unknown observations", () => {
	const host = { state: "failed" };
	assert.equal(canReplaceHost({ host, runnerObservation: "unknown", childObservation: "dead", launchLeaseActive: false }), false);
	assert.equal(canReplaceHost({ host, runnerObservation: "dead", childObservation: "not_started", launchLeaseActive: false }), true);
	assert.equal(canReplaceHost({ host, runnerObservation: "dead", childObservation: "dead", launchLeaseActive: true }), false);
});

test("canReplaceHost allows replacing a terminal host whose claimPid is still alive (issue #99)", () => {
	// The bug: an exited/failed host keeps its claimPid (the dashboard process
	// that wrote the claim), and a live pid observed as "unknown" used to block
	// replacement forever — attach pended to "host start timed out". Claim
	// protection only matters while a claim is mid-transaction (state
	// "starting"); a terminal host cannot still be being launched.
	assert.equal(canReplaceHost({ host: { state: "exited" }, runnerObservation: "dead", childObservation: "dead", launchLeaseActive: false }), true);
	assert.equal(canReplaceHost({ host: { state: "failed" }, runnerObservation: "dead", childObservation: "dead", launchLeaseActive: false }), true);
});

test("canReplaceHost still refuses unknown runner/child observations (issue #99 conservatism)", () => {
	assert.equal(canReplaceHost({ host: { state: "exited" }, runnerObservation: "unknown", childObservation: "dead", launchLeaseActive: false }), false);
	assert.equal(canReplaceHost({ host: { state: "exited" }, runnerObservation: "dead", childObservation: "unknown", launchLeaseActive: false }), false);
	assert.equal(canReplaceHost({ host: { state: "failed" }, runnerObservation: "unknown", childObservation: "unknown", launchLeaseActive: false }), false);
});

test("canReplaceHost refuses non-terminal hosts and null host (issue #99)", () => {
	for (const state of ["starting", "alive", "stopping"]) {
		assert.equal(canReplaceHost({ host: { state }, runnerObservation: "dead", childObservation: "dead", launchLeaseActive: false }), false, `state ${state} must refuse`);
	}
	assert.equal(canReplaceHost({ host: null, runnerObservation: "dead", childObservation: "dead", launchLeaseActive: false }), false);
});

test("canReplaceHost SAFE_TO_RELEASE boundary regression (issue #99)", () => {
	assert.equal(canReplaceHost({ host: { state: "exited" }, runnerObservation: "foreign", childObservation: "dead", launchLeaseActive: false }), true, "foreign runner (pid reuse) is releasable");
	assert.equal(canReplaceHost({ host: { state: "exited" }, runnerObservation: "not_started", childObservation: "not_started", launchLeaseActive: false }), true);
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
