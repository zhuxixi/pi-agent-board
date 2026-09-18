import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_ID_EDITOR_REPORTER, CLIENT_ID_PROBE, classifyClientHello } from "../src/core/host-protocol.mjs";

test("classifyClientHello recognizes the read-only probe handshake", () => {
	assert.equal(classifyClientHello({ type: "hello", clientId: CLIENT_ID_PROBE }), "probe");
});

test("classifyClientHello recognizes the resident editor reporter (issue #103)", () => {
	assert.equal(classifyClientHello({ type: "hello", clientId: CLIENT_ID_EDITOR_REPORTER }), "editor-reporter");
});

test("classifyClientHello treats every other hello as a real client", () => {
	assert.equal(classifyClientHello({ type: "hello", clientId: "ui-test" }), "client");
	assert.equal(classifyClientHello({ type: "hello" }), "client");
	assert.equal(classifyClientHello({ type: "hello", clientId: 42 }), "client");
	assert.equal(classifyClientHello({}), "client");
	assert.equal(classifyClientHello(null), "client");
	assert.equal(classifyClientHello(undefined), "client");
});
