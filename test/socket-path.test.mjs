import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { controlPipeName, controlSocketPath, controlSocketPathFor, coordinatorEndpointPathFor, hostConfigPathFor, hostEndpointPathFor, resolveControlEndpoint, viewDir } from "../src/core/paths.mjs";

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

// ---- coordinator endpoint root-form invariance (issue #124) -----------------

test("coordinator pipe name is invariant to the root spelling (win32, issue #124)", () => {
	const forms = [
		"C:\\root\\board",
		"C:/root/board",
		"C:\\root\\board\\",
		"C:\\root\\.\\board",
	];
	const names = forms.map((r) => coordinatorEndpointPathFor("win32", r));
	for (const n of names) {
		assert.match(n, /^\\\\.\\pipe\\agent-board-coordinator-[0-9a-f]{16}$/);
		assert.ok(n.length <= 256, "named pipe name must fit the Windows 256-char limit");
	}
	assert.equal(new Set(names).size, 1, "one logical root must map to one pipe name regardless of spelling");
});

test("coordinator pipe name still isolates distinct roots (win32)", () => {
	assert.notEqual(
		coordinatorEndpointPathFor("win32", "C:\\root\\board-a"),
		coordinatorEndpointPathFor("win32", "C:\\root\\board-b"),
	);
});

test("coordinator endpoint keeps POSIX semantics unchanged", () => {
	const expected = join("/tmp/root", "coordinator.sock");
	assert.equal(coordinatorEndpointPathFor("linux", "/tmp/root"), expected);
	assert.equal(coordinatorEndpointPathFor("darwin", "/tmp/root"), expected);
	assert.equal(coordinatorEndpointPathFor("linux", "/tmp/root/"), expected, "path.join already normalizes on POSIX");
});

// ---- hosted child control endpoint discovery (issue #103) -------------------

test("resolveControlEndpoint prefers the runner-injected endpoint (issue #103)", () => {
	const injected = "/tmp/root/views/view_1/control.i1.sock";
	assert.equal(
		resolveControlEndpoint({ envSocketPath: injected, platform: "linux", root: "/tmp/root", viewId: "view_1" }),
		injected,
	);
	const pipe = "\\\\.\\pipe\\pi-agent-board-view_1-deadbeef";
	assert.equal(
		resolveControlEndpoint({ envSocketPath: pipe, platform: "win32", root: "C:\\root", viewId: "view_1" }),
		pipe,
		"a win32 pipe name is passed through verbatim",
	);
});

test("resolveControlEndpoint falls back to the stable per-view endpoint (issue #103)", () => {
	const expected = controlSocketPathFor("linux", "/tmp/root", "view_abc123");
	for (const envSocketPath of [undefined, null, "", "   "]) {
		assert.equal(
			resolveControlEndpoint({ envSocketPath, platform: "linux", root: "/tmp/root", viewId: "view_abc123" }),
			expected,
			`env value ${JSON.stringify(envSocketPath)} must fall back to the stable endpoint`,
		);
	}
	assert.equal(
		resolveControlEndpoint({ platform: "win32", root: "C:\\root", viewId: "view_abc123" }),
		controlSocketPathFor("win32", "C:\\root", "view_abc123"),
	);
});
