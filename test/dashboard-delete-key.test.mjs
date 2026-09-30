import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const PROBE = join(ROOT_DIR, "test-support", "dashboard-delete-key-probe.ts");

// One probe run feeds every assertion below.
const report = JSON.parse(
	execFileSync(process.execPath, ["--experimental-transform-types", PROBE], {
		encoding: "utf8",
		timeout: 60_000,
	}),
);

test("A1: x opens a (y/N) confirm prompt naming the selected session", () => {
	assert.equal(report.idlePrompt.mode, "confirm");
	assert.match(report.idlePrompt.prompt, /^Delete "(one|two)"\? Session file is preserved\. \(y\/N\)$/);
	assert.deepEqual(report.idlePrompt.archived, [], "nothing archived before the confirm key");
});

test("A1b: x on an empty list is a no-op", () => {
	assert.equal(report.emptyList.mode, "list");
	assert.equal(report.emptyList.pending, null);
});

test("A1c: busy rows warn that deletion stops the active run", () => {
	assert.equal(report.busyPrompt.mode, "confirm");
	assert.match(report.busyPrompt.prompt, /Stops the active run\./);
});

test("A3: n / esc / x / q cancel without deleting", () => {
	for (const [name, snap] of Object.entries(report.cancel)) {
		assert.equal(snap.mode, "list", `${name}: back to list mode`);
		assert.equal(snap.prompt, null, `${name}: prompt dismissed`);
		assert.equal(snap.notice, null, `${name}: no notice`);
		assert.deepEqual(snap.archived, [], `${name}: nothing archived`);
	}
});

test("A2: y archives the selected view, notices, and returns to the list", async () => {
	assert.deepEqual(report.confirm.archived, [report.confirm.beforeId]);
	assert.equal(report.confirm.mode, "list");
	assert.equal(report.confirm.notice, `Deleted "${report.confirm.beforeName}"`);
	assert.equal(report.confirm.level, "info");
	assert.ok(!report.confirm.orderedIds.includes(report.confirm.beforeId), "deleted row leaves the list");
	assert.notEqual(report.confirm.selectedId, report.confirm.beforeId, "selection leaves the deleted row");
	assert.equal(report.confirm.selectedId, report.confirm.orderedIds[0], "selection re-lands on the remaining row");
});

test("A5: x is literal text in insert mode", () => {
	assert.equal(report.insertMode.mode, "dispatch");
	assert.match(report.insertMode.input, /x/);
	assert.deepEqual(report.insertMode.archived, []);
});
test("A4: legacy ctrl+x double-press still deletes without a confirm step", () => {
	assert.equal(report.legacyDoublePress.mode, "list", "no confirm mode involved");
	assert.equal(report.legacyDoublePress.prompt, null);
	assert.deepEqual(report.legacyDoublePress.archived, ["v1"]);
});

test("A4b: ctrl+x outside the 500ms window only re-arms", () => {
	assert.deepEqual(report.legacySlow.archived, []);
	assert.equal(report.legacySlow.mode, "list");
});

test("A6: multi-select keeps ctrl+x and ignores plain x", () => {
	assert.equal(report.selectMode.afterX.mode, "select", "plain x is a no-op in select mode");
	assert.equal(report.selectMode.afterX.prompt, null);
	assert.equal(report.selectMode.ctrlX.mode, "confirm");
	assert.match(report.selectMode.ctrlX.prompt, /^Delete 1 done session\? Session files are preserved\. \(y\/N\)$/);
	assert.equal(report.selectMode.ctrlX.returnMode, "select");
	assert.deepEqual(report.selectMode.archived, [], "the batch path never routes through single-row archive");
	assert.deepEqual(report.selectMode.confirmed.archiveManyCalls, [[report.selectMode.target]], "y routes the batch through archiveMany");
	assert.ok(!report.selectMode.confirmed.orderedIds.includes(report.selectMode.target), "deleted row leaves the list");
});
