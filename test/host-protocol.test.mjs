import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_ID_EDITOR_REPORTER, CLIENT_ID_PROBE, classifyClientHello, helloBookkeeping } from "../src/core/host-protocol.mjs";

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

test("helloBookkeeping keeps a probe out of clients and out of host.json (issue #130)", () => {
	assert.deepEqual(helloBookkeeping("probe"), {
		keepInClients: false,
		registerReporter: false,
		flipAttachedEver: false,
		persist: false,
		suppressCloseWrite: true,
	});
});

test("helloBookkeeping keeps the resident reporter bookkeeping-only (issue #103)", () => {
	assert.deepEqual(helloBookkeeping("editor-reporter"), {
		keepInClients: false,
		registerReporter: true,
		flipAttachedEver: false,
		persist: true,
		suppressCloseWrite: false,
	});
});

test("helloBookkeeping counts a real client as a full attachment", () => {
	assert.deepEqual(helloBookkeeping("client"), {
		keepInClients: true,
		registerReporter: false,
		flipAttachedEver: true,
		persist: true,
		suppressCloseWrite: false,
	});
});

test("helloBookkeeping is total over classifyClientHello and defaults to the conservative client row", () => {
	// Every kind the handshake can produce must have a row — and an unknown kind
	// must fall back to counting the socket, never to silently dropping it.
	const produced = [
		classifyClientHello({ type: "hello", clientId: CLIENT_ID_PROBE }),
		classifyClientHello({ type: "hello", clientId: CLIENT_ID_EDITOR_REPORTER }),
		classifyClientHello({ type: "hello" }),
	];
	for (const kind of produced) {
		const book = helloBookkeeping(kind);
		assert.equal(typeof book.keepInClients, "boolean", `missing policy row for ${kind}`);
	}
	assert.equal(helloBookkeeping("probe").keepInClients, false, "the probe row is the one that must not count");
	assert.deepEqual(helloBookkeeping(undefined), helloBookkeeping("client"), "unknown kinds count as clients (conservative)");
});
