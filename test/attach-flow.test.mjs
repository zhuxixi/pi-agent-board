import test from "node:test";
import assert from "node:assert/strict";
import { planAttachPrelude, planAttachResolved } from "../src/commands/attach-decision.mjs";

/**
 * Task 14 (issue #70): the attach prelude/resolution decision tables, extracted from the two
 * near-duplicate attach() implementations (attach-flow.ts + agent-board.ts) so the branching
 * contract is node-testable without pi's TS loader.
 */

test("resolved pty plans open-pty with socketPath passthrough", () => {
	const plan = planAttachResolved({ kind: "pty", socketPath: "/tmp/s.sock", sessionFile: "/s.jsonl", instanceId: "i1" });
	assert.deepEqual(plan, { plan: "open-pty", socketPath: "/tmp/s.sock" });
});

test("resolved session plans session-switch with sessionFile passthrough", () => {
	assert.deepEqual(planAttachResolved({ kind: "session", sessionFile: "/s.jsonl" }), { plan: "session-switch", sessionFile: "/s.jsonl" });
});

test("resolved pending with reason plans notify-pending carrying the reason", () => {
	const plan = planAttachResolved({ kind: "pending", sessionFile: "/s.jsonl", reason: "host starting" });
	assert.deepEqual(plan, { plan: "notify-pending", reason: "host starting" });
});

test("resolved pending without reason falls back to the default message", () => {
	const plan = planAttachResolved({ kind: "pending", sessionFile: "/s.jsonl" });
	assert.deepEqual(plan, { plan: "notify-pending", reason: "Session host is starting — try again shortly." });
});

test("resolved missing plans notify-missing", () => {
	assert.deepEqual(planAttachResolved({ kind: "missing" }), { plan: "notify-missing" });
});

test("pty resolution with a null socketPath degrades to notify-pending, not missing", () => {
	// The resolver JSDoc types socketPath as string | null; a pty result without a
	// usable path is a transient inconsistency — retry later, don't claim the session vanished.
	const plan = planAttachResolved({ kind: "pty", socketPath: null, sessionFile: "/s.jsonl", instanceId: null });
	assert.deepEqual(plan, { plan: "notify-pending", reason: "Session host is starting — try again shortly." });
});

test("live json-runner without hostActive and without stopFirst warns before the resolver runs", () => {
	assert.deepEqual(planAttachPrelude({ rowAlive: true, rowHostActive: false, stopFirst: false }), { plan: "warn-running" });
});

test("live json-runner with stopFirst plans stop-first (stop, then proceed to resolver)", () => {
	assert.deepEqual(planAttachPrelude({ rowAlive: true, rowHostActive: false, stopFirst: true }), { plan: "stop-first" });
});

test("starting hostActive and dead rows pass the prelude through to the resolver", () => {
	// hostActive covers starting/alive/stopping: attach no longer blocks on the JSON-runner warning.
	assert.deepEqual(planAttachPrelude({ rowAlive: true, rowHostActive: true, stopFirst: false }), { plan: "proceed" });
	// No live run at all: proceed.
	assert.deepEqual(planAttachPrelude({ rowAlive: false, rowHostActive: false, stopFirst: false }), { plan: "proceed" });
	// stopFirst with an already-dead row: nothing to stop, proceed straight to the resolver.
	assert.deepEqual(planAttachPrelude({ rowAlive: false, rowHostActive: false, stopFirst: true }), { plan: "proceed" });
});
