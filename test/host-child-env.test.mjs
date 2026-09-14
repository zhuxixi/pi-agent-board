import assert from "node:assert/strict";
import { test } from "node:test";
import { hostChildEnv } from "../src/core/host-child-env.mjs";

test("hostChildEnv exports the hosted-child markers and the bound control endpoint", () => {
	const env = hostChildEnv({
		root: "/tmp/root",
		viewId: "view_1",
		socketPath: "/tmp/root/views/view_1/control.i1.sock",
		baseEnv: { PATH: "/usr/bin", AGENT_BOARD_ROOT: "/stale" },
		extraEnv: { CUSTOM: "1" },
	});
	assert.equal(env.PATH, "/usr/bin", "ambient environment is preserved");
	assert.equal(env.CUSTOM, "1", "per-launch env is preserved");
	assert.equal(env.AGENT_BOARD_ROOT, "/tmp/root", "fixed keys override a stale ambient value");
	assert.equal(env.AGENT_BOARD_VIEW_ID, "view_1");
	assert.equal(env.AGENT_BOARD_CHILD, "1");
	assert.equal(env.AGENT_BOARD_HOSTED, "pty");
	assert.equal(env.AGENT_BOARD_CONTROL_SOCKET, "/tmp/root/views/view_1/control.i1.sock");
	// Legacy aliases stay exported for older child extension builds.
	assert.equal(env.AGENT_VIEW_ROOT, "/tmp/root");
	assert.equal(env.AGENT_VIEW_VIEW_ID, "view_1");
	assert.equal(env.AGENT_VIEW_CHILD, "1");
	assert.equal(env.AGENT_VIEW_HOSTED, "pty");
});

test("hostChildEnv defaults baseEnv and extraEnv to empty objects", () => {
	const env = hostChildEnv({ root: "/r", viewId: "v", socketPath: "/r/v/control.sock" });
	assert.equal(env.AGENT_BOARD_CONTROL_SOCKET, "/r/v/control.sock");
	assert.equal(env.AGENT_VIEW_CHILD, "1");
});
