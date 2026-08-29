import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { requestDashboardRender } from "../src/core/dashboard-render.mjs";

test("dashboard repaint preserves Pi TUI differential render state", () => {
	const calls = [];
	requestDashboardRender({ requestRender: (...args) => calls.push(args) });
	assert.deepEqual(calls, [[]]);
});

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const REFS_RENDER_SCRIPT = join(ROOT_DIR, "test-support", "dashboard-refs-render.ts");

test("dashboard row line shows issue/PR badge and peek renders the Refs section", () => {
	// dashboard.ts uses TS parameter properties, which strip-only mode rejects;
	// --experimental-transform-types handles them (Node 22.7+ / 24).
	const out = execFileSync(process.execPath, ["--experimental-transform-types", REFS_RENDER_SCRIPT], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const parsed = JSON.parse(out);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.rowHasBadge, true, "row line must include the '#40 ▸#45' badge");
	assert.equal(parsed.plainRowHasNoBadge, true, "row without codeRefs must have no refs badge");
	assert.equal(parsed.peekHasRefs, true, "peek must render a Refs section");
	assert.equal(parsed.peekHasProvider, true, "peek Refs section must name the provider");
	assert.equal(parsed.peekHasRefLine, true, "peek Refs must list the issue ref line");
	assert.equal(parsed.peekHasPrLine, true, "peek Refs must list the pr ref line");
	assert.equal(parsed.peekHasMentionLine, true, "peek Refs must list lower-confidence mention refs");
	assert.equal(parsed.plainPeekHasNoRefs, true, "peek without codeRefs must omit the Refs section");
});
