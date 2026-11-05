import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PROBE = fileURLToPath(new URL("../test-support/dashboard-fold.ts", import.meta.url));

test("section folding preserves navigation, safe actions, search, polling, and saved preferences", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(JSON.parse(out).ok, true);
});

test("folding renders and receives keys through real regular/fullscreen TUI overlays", () => {
	const probe = fileURLToPath(new URL("../test-support/dashboard-tui-modes.ts", import.meta.url));
	const out = execFileSync(process.execPath, ["--experimental-transform-types", probe], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const results = JSON.parse(out);
	assert.deepEqual(results.map(({ mode }) => mode), ["regular", "fullscreen"]);
	for (const result of results) {
		assert.equal(result.ok, true);
		assert.ok(result.frames > 20, "must exercise multiple differential frames and resizing");
	}
});
