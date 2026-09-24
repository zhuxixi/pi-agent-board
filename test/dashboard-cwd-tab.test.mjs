import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "cwd-browse-tab-probe.ts");

test("cwd picker: browse-mode Tab completes and drills; favorites Tab unchanged (issue #127)", () => {
	// dashboard.ts uses TS parameter properties, which strip-only mode rejects;
	// --experimental-transform-types handles them (Node 22.7+ / 24).
	const out = execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const r = JSON.parse(out);
	const work = r.work;

	// A1: browse-mode Tab completes the highlighted candidate into the query.
	assert.equal(r.mode0, "browse");
	assert.deepEqual(r.sugg0, [work]);
	assert.equal(r.afterTab1.query, `${work}${sep}`);
	assert.equal(r.afterTab1.mode, "browse");
	assert.equal(r.afterTab1.suggestions[0], work);

	// A2: repeated Tab drills down like a shell (work/ -> work/app/), stopping at the leaf.
	assert.equal(r.afterTab2.query, `${join(work, "app")}${sep}`);
	assert.equal(r.afterTab2.mode, "browse");
	assert.equal(r.afterTab3, `${join(work, "app")}${sep}`);

	// A5: browse-mode hint advertises tab completion.
	assert.equal(r.browseHint, true);

	// A3: favorites mode keeps the original semantics (bare path, mode stays favorites).
	assert.equal(r.fav.query, work);
	assert.equal(r.fav.mode, "favorites");
});
