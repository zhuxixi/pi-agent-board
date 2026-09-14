import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyClientHello, EDITOR_REPORTER_CLIENT_ID, PROBE_CLIENT_ID } from "../src/core/control-clients.mjs";

test("classifyClientHello separates probes, the editor reporter and real clients", () => {
	assert.equal(classifyClientHello({ type: "hello", clientId: PROBE_CLIENT_ID }), "probe");
	assert.equal(classifyClientHello({ type: "hello", clientId: EDITOR_REPORTER_CLIENT_ID }), "reporter");
	assert.equal(classifyClientHello({ type: "hello", clientId: "ui-test" }), "client");
	assert.equal(classifyClientHello({ type: "hello" }), "client", "hello without a clientId is a real client");
});

test("classifyClientHello treats non-hello and malformed frames as plain clients", () => {
	assert.equal(classifyClientHello({ type: "editor_state", empty: true }), "client");
	assert.equal(classifyClientHello(null), "client");
	assert.equal(classifyClientHello(undefined), "client");
});

test("client id constants are the protocol strings the runner and reporter share", () => {
	assert.equal(PROBE_CLIENT_ID, "probe");
	assert.equal(EDITOR_REPORTER_CLIENT_ID, "editor-reporter");
});
