import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../test-support/attach-settle-scheme-smoke.ts", import.meta.url));

test("attach settle scheme probe: new/old/none APIs, failures, kill switch", () => {
	const out = JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", script], {
		encoding: "utf-8",
		timeout: 20000,
	}));

	// A1 — new API delivers light and dark once each.
	assert.deepEqual(out.newApiLight.sent, ["\x1b[?997;2n"], "A1 light: one 997;2");
	assert.deepEqual(out.newApiDark.sent, ["\x1b[?997;1n"], "A1 dark: one 997;1");
	assert.equal(out.newApiLight.diagnostics[0].details.probeApi, "colors");
	assert.equal(out.newApiLight.diagnostics[0].details.outcome, "reported");
	assert.equal(out.newApiLight.diagnostics[0].details.report, "997;2");
	assert.equal(out.newApiLight.diagnostics[0].level, "info");

	// A2 — old API fallback still delivers.
	assert.deepEqual(out.oldApi.sent, ["\x1b[?997;2n"], "A2 old API delivers");
	assert.equal(out.oldApi.diagnostics[0].details.probeApi, "background");

	// A3 — neither API: no probe, no raw write, no send.
	assert.deepEqual(out.noApi.sent, [], "A3 sends nothing");
	assert.deepEqual(out.noApi.writes, [], "A3 never writes an unowned raw query");
	assert.equal(out.noApi.diagnostics[0].details.probeApi, "none");
	assert.equal(out.noApi.diagnostics[0].details.outcome, "no_probe_api");
	assert.equal(out.noApi.diagnostics[0].level, "warn");

	// A9 — failure branches send nothing and classify.
	for (const [key, outcome] of [["timeout", "timeout"], ["error", "error"], ["noBackground", "no_background"]]) {
		assert.deepEqual(out[key].sent, [], `${key}: no 997 on failure`);
		assert.equal(out[key].diagnostics[0].details.outcome, outcome);
		assert.equal(out[key].diagnostics[0].level, "warn");
	}

	// Kill switch — suppressed, info, no probeApi.
	assert.deepEqual(out.killSwitch.sent, [], "kill switch sends nothing");
	assert.equal(out.killSwitch.diagnostics[0].details.outcome, "suppressed");
	assert.equal(out.killSwitch.diagnostics[0].details.probeApi, undefined);
	assert.equal(out.killSwitch.diagnostics[0].level, "info");

	// A5 — late replies: dedup, closed guard, timeout-then-late delivery.
	assert.deepEqual(out.lateSame.sent, ["\x1b[?997;2n"], "same-scheme late reply is deduped");
	assert.equal(out.lateSame.diagnostics.at(-1).details.outcome, "duplicate_skipped");
	assert.equal(out.lateSame.diagnostics.at(-1).level, "info");

	assert.deepEqual(out.lateDifferent.sent, ["\x1b[?997;2n", "\x1b[?997;1n"], "different-scheme late reply delivers");
	const lateDiff = out.lateDifferent.diagnostics.at(-1);
	assert.equal(lateDiff.details.outcome, "reported");
	assert.equal(lateDiff.details.late, true);
	assert.equal(lateDiff.details.report, "997;1");

	assert.deepEqual(out.lateAfterTimeout.sent, ["\x1b[?997;1n"], "timeout-then-late still delivers (sentScheme null)");
	assert.equal(out.lateAfterTimeout.diagnostics[0].details.outcome, "timeout");
	assert.equal(out.lateAfterTimeout.diagnostics.at(-1).details.outcome, "reported");

	assert.deepEqual(out.lateClosed.sent, ["\x1b[?997;2n"], "closed late reply sends nothing beyond the initial delivery");
	assert.equal(out.lateClosed.diagnostics.at(-1).details.outcome, "dropped_closed");
	assert.equal(out.lateClosed.diagnostics.at(-1).level, "info");

	// CR round-1 advisory: a disconnected control socket never claims "reported".
	assert.deepEqual(out.disconnected.sent, [], "disconnected settle sends nothing");
	assert.equal(out.disconnected.diagnostics[0].details.outcome, "dropped_disconnected");
	assert.equal(out.disconnected.diagnostics[0].level, "warn");
	assert.equal(out.disconnected.diagnostics.at(-1).details.outcome, "dropped_disconnected",
		"same-scheme late reply re-attempts delivery (no duplicate_skipped lie)");
	assert.equal(out.disconnected.diagnostics.some((d) => d.details.outcome === "duplicate_skipped"), false,
		"dedup baseline must stay unset while disconnected");
});
