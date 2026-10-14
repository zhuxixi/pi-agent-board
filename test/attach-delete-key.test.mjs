import assert from "node:assert/strict";
import test from "node:test";
import { resolveAttachDeleteKey } from "../src/core/attach-delete.mjs";

test("resolveAttachDeleteKey: full branch matrix (issue #147 A1)", () => {
	// arm: not armed + ctrl+x (raw 0x18)
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: false }, "\x18"), { action: "arm", confirmArmed: true });
	// confirm: armed + y / Y / enter (\r)
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: true }, "y"), { action: "confirm", confirmArmed: false });
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: true }, "Y"), { action: "confirm", confirmArmed: false });
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: true }, "\r"), { action: "confirm", confirmArmed: false });
	// cancel: armed + other keys (forwarded)
	for (const key of ["n", "\x1b", "a", "\x1b[D", "\x1b[5~", " "]) {
		assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: true }, key), { action: "cancel", confirmArmed: false }, `key=${JSON.stringify(key)}`);
	}
	// cancel-swallow: armed + second ctrl+x (user adjudication 2026-10-10)
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: true }, "\x18"), { action: "cancel-swallow", confirmArmed: false });
	// forward: not armed + anything else
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: false }, "x"), { action: "forward", confirmArmed: false });
	assert.deepEqual(resolveAttachDeleteKey({ confirmArmed: false }, "\r"), { action: "forward", confirmArmed: false });
});
