import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const SMOKE_SCRIPT = join(ROOT_DIR, "test-support", "desync-heal-smoke.ts");

// Issue #11: runtime desync detect + rate-limited heal — component wiring gates.
test("desync heal wiring: 7 gates + heal loop", () => {
	const out = execFileSync(process.execPath, ["--experimental-transform-types", SMOKE_SCRIPT], {
		encoding: "utf8",
		timeout: 60_000,
	});
	const parsed = JSON.parse(out);
	assert.equal(parsed.healthyIdleNoHeal, true, "H1 healthy idle must not heal");
	assert.equal(parsed.desyncHealsOnce, true, "H2 desync must heal exactly once (rate limit + chain gate)");
	assert.equal(parsed.preSettleNoHeal, true, "H3 pre-settle must not heal");
	assert.equal(parsed.noFrameNoHeal, true, "H4 no TUI frame must not heal");
	assert.equal(parsed.scrolledOutNoHeal, true, "H5 cursor out of viewport must not heal");
	assert.equal(parsed.recentOutputNoHeal, true, "H6 recent output must not heal");
	assert.equal(parsed.healLoopCloses, true, "H7 child clear must close the heal loop without a second heal");
});
