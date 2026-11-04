import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "cwd-favorites-pool-probe.ts");

test("cwd picker: favorites search covers entries ranked below the old 8-entry cap (issue #262)", () => {
	// dashboard.ts uses TS parameter properties, which strip-only mode rejects;
	// --experimental-transform-types handles them (Node 22.7+ / 24).
	const out = execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const r = JSON.parse(out);
	assert.equal(r.mode, "favorites");
	assert.deepEqual(r.suggestions, [r.target]);
});
