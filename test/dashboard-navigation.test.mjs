import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "navigation-wrap.ts");

test("list arrow-key navigation wraps around at both ends (issue #52)", () => {
	// dashboard.ts uses TS parameter properties, which strip-only mode rejects;
	// --experimental-transform-types handles them (Node 22.7+ / 24).
	const out = execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const { ids, seq } = JSON.parse(out);
	assert.equal(ids.length, 3, "probe must see 3 rows");
	assert.deepEqual(
		seq,
		[ids[0], ids[1], ids[2], ids[0], ids[2]],
		"down past the last row wraps to first; up past the first wraps to last",
	);
});
