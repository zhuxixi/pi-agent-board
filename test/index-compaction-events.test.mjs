import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Issue #297: the compaction hooks live in the extension registration layer,
 * which the service harness never exercises — a typo there would only surface
 * in a manual run, so pin the three names as static text. */
test("the extension registers every compaction hook (issue #297)", () => {
	const source = readFileSync(ENTRY, "utf8");
	for (const hook of ["session_before_compact", "session_compact", "session_compact_failed"]) {
		assert.match(source, new RegExp(`pi\\.on\\("${hook}"`), `missing pi.on("${hook}") registration`);
	}
});
