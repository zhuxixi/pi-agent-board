import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "dashboard-position-keep-probe.ts");

// One probe run feeds every assertion below.
const report = JSON.parse(
	execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 120_000,
	}),
);

test("A2: h on a middle row keeps the slot — the row below takes the cursor", () => {
	assert.equal(report.holdMiddle.demotedId, "v3");
	assert.equal(report.holdMiddle.selectedId, "v4", "cursor must not follow the demoted row");
	assert.notEqual(report.holdMiddle.selectedId, report.holdMiddle.demotedId);
});

test("A3: h on the last row selects the previous row", () => {
	assert.equal(report.holdLast.selectedId, "v4");
});

test("A4: h on the only row keeps it selected", () => {
	assert.equal(report.holdOnly.selectedId, "v1");
	assert.deepEqual(report.holdOnly.orderedIds, ["v1"]);
});

test("A6: unhold keeps the slot instead of staying on the resumed row", () => {
	assert.equal(report.unhold.demotedId, "v3");
	assert.equal(report.unhold.selectedId, "v4", "the resumed row must not keep the cursor");
});

test("A8 (h branch): a rejected hold leaves the cursor in place", () => {
	assert.equal(report.holdFailed.selectedId, "v3");
	assert.equal(report.holdFailed.notice, "boom");
});

test("A9: filtering does not send the cursor to the top when the demoted row leaves the result", () => {
	assert.equal(report.holdFiltered.selectedId, "v4");
	assert.ok(!report.holdFiltered.orderedIds.includes(report.holdFiltered.demotedId), "held row leaves the s:idle filter");
});

test("A10: peek keeps its own target while the list cursor moves to the slot", () => {
	assert.equal(report.holdPeek.mode, "peek");
	assert.equal(report.holdPeek.peekId, "v3");
	assert.equal(report.holdPeek.selectedId, "v4");
});

test("A11: background-driven transitions still follow the row", () => {
	assert.equal(report.backgroundFollow.selectedId, "v3", "follow is the established behavior outside the demote commands");
});

test("A5: d+y on a middle row keeps the slot", () => {
	assert.equal(report.doneMiddle.demotedId, "v3");
	assert.equal(report.doneMiddle.selectedId, "v4");
});

test("A8 (done branch): a rejected mark-completed leaves the cursor in place", () => {
	assert.equal(report.doneFailed.selectedId, "v3");
	assert.equal(report.doneFailed.notice, "boom");
});

test("A7: batch done selects the row after the block, not a completed id", () => {
	assert.equal(report.batchMiddle.selectedId, "v4");
	assert.ok(!report.batchMiddle.doneIds.includes(report.batchMiddle.selectedId));
});

test("A7 (block at the end): the previous row wins when nothing follows", () => {
	assert.equal(report.batchEnd.selectedId, "v3");
});

test("A7: the batch anchor follows board order, not selection order", () => {
	assert.deepEqual(report.batchBoardOrder.doneIds, ["v5", "v2"], "selection order must differ from board order");
	assert.equal(report.batchBoardOrder.selectedId, "v3", "doneIds[0] (v5) would anchor on v4; board order (v2) anchors on v3");
});

test("A13: a batch that completed nothing leaves the cursor alone", () => {
	assert.equal(report.batchAllSkipped.selectedId, "v3");
});
