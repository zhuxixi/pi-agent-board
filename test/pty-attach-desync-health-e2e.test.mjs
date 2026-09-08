import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const E2E_SCRIPT = join(ROOT_DIR, "test-support", "desync-health-e2e.ts");

const hasNodePty = await import("node-pty").then(
	() => true,
	() => false,
);

function parseResultLine(out) {
	// The harness prints exactly one JSON line; parse the last JSON-looking
	// line so runner/scheduler noise on the pipe can never break the wrapper.
	const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
	assert.ok(lines.length > 0, `no JSON result line in harness output:\n${out}`);
	return JSON.parse(lines[lines.length - 1]);
}

// Issue #11 (A4): a real runner + healthy idle TUI child must never trigger a
// runtime desync heal across the full attach lifecycle (shrink-and-hold chain
// completes, settle fires, ≥3 probe ticks observe an aligned idle screen).
test(
	"desync health e2e: healthy idle session triggers no heal",
	{ skip: !hasNodePty && "node-pty unavailable", timeout: 60_000 },
	() => {
		const out = execFileSync(process.execPath, ["--experimental-transform-types", E2E_SCRIPT], {
			encoding: "utf8",
			timeout: 55_000,
		});
		const parsed = parseResultLine(out);
		assert.equal(parsed.healedNever, true, "healCount must stay 0 on a healthy idle session");
		assert.equal(parsed.chainDone, true, "attach chain must complete");
		assert.equal(parsed.held, false, "no hold left armed");
	},
);
