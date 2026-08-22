import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SMOKE_SCRIPT = join(ROOT_DIR, "test-support", "ui-smoke.ts");

test("TS UI entrypoints construct, render, and dispose under transform-types", () => {
	// dashboard.ts and pty-attach.ts use TS parameter properties, which strip-only
	// mode rejects; --experimental-transform-types handles them (Node 22.7+ / 24).
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SMOKE_SCRIPT], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const parsed = JSON.parse(out);
	assert.equal(parsed.ok, true);
	assert.ok(parsed.dashLines >= 1, "dashboard must render at least one line");
	assert.ok(parsed.attachLines >= 1, "pty-attach must render at least one line");
});
