import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { controlPipeName, controlSocketPath, controlSocketPathFor, hostConfigPathFor, hostEndpointPathFor, viewDir } from "../src/core/paths.mjs";

test("controlSocketPath uses a named pipe on win32 (no filesystem socket path)", () => {
	const p = controlSocketPathFor("win32", "C:\\root", "view_abc123");
	assert.ok(p.startsWith("\\\\.\\pipe\\"), `expected \\\\.\\pipe\\ prefix, got ${p}`);
	assert.ok(p.includes("view_abc123"), "pipe name embeds the view id");
	assert.ok(p.length <= 256, "named pipe name must fit Windows 256-char limit");

	if (process.platform === "win32") {
		assert.equal(controlSocketPath("C:\\root", "view_abc123"), p, "live helper follows the platform");
		assert.equal(controlSocketPath("C:\\root", "view_abc123"), controlPipeName("view_abc123"));
	}
});

test("controlSocketPath keeps a file path on non-win32 platforms", () => {
	const expected = join(viewDir("/tmp/root", "view_abc123"), "control.sock");
	assert.equal(controlSocketPathFor("linux", "/tmp/root", "view_abc123"), expected);
	assert.equal(controlSocketPathFor("darwin", "/tmp/root", "view_abc123"), expected);

	if (process.platform !== "win32") {
		assert.equal(controlSocketPath("/tmp/root", "view_abc123"), expected, "live helper follows the platform");
	}
});

test("instance-specific host config and endpoint paths are unique per instance", () => {
	const a = hostConfigPathFor("/root", "view_1", "aaa");
	const b = hostConfigPathFor("/root", "view_1", "bbb");
	assert.notEqual(a, b);
	assert.match(a, /views\/view_1\/host-config\.aaa\.json$/);
	const s1 = hostEndpointPathFor("linux", "/root", "view_1", "aaa");
	const s2 = hostEndpointPathFor("linux", "/root", "view_1", "bbb");
	assert.notEqual(s1, s2);
	assert.match(s1, /views\/view_1\/control\.aaa\.sock$/);
	const p1 = hostEndpointPathFor("win32", "C:\\root", "view_1", "aaa");
	assert.match(p1, /^\\\\.\\pipe\\pi-agent-board-view_1-[0-9a-f]{8}$/);
	assert.ok(p1.length <= 256);
	assert.notEqual(hostEndpointPathFor("win32", "C:\\root", "view_1", "aaa"), hostEndpointPathFor("win32", "C:\\root", "view_1", "bbb"));
});
