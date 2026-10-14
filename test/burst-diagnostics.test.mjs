import assert from "node:assert/strict";
import { test } from "node:test";
import { collectBurstIds, formatBurstDiagnostics } from "../test-support/burst-diagnostics.mjs";

// issue #184: the A5 burst failure used to be undiagnosable — the durable-state
// postmortem cannot tell "the child never wrote the rows" from "the snapshot
// frame window truncated them". These counters can.

test("collectBurstIds extracts unique ascending ids from arbitrary chunks", () => {
	assert.deepEqual(collectBurstIds(""), []);
	assert.deepEqual(collectBurstIds("nothing to see here\n"), []);
	assert.deepEqual(collectBurstIds("burstline-0001-pppp\nburstline-0002-pppp"), [1, 2]);
	// chunks may repeat ids (frame + catch-up flush) — the union must dedupe and sort
	assert.deepEqual(collectBurstIds("burstline-0400-a\nburstline-0001-b\nburstline-0400-c"), [1, 400]);
	assert.deepEqual(collectBurstIds("prefix burstline-0012-txt suffix burstline-0013"), [12, 13]);
});

test("formatBurstDiagnostics renders counts, ranges and missing ids", () => {
	const full = formatBurstDiagnostics({
		expectedRows: 3,
		driverTexts: ["burstline-0001-a\nburstline-0002-b\nburstline-0003-c"],
		frameText: "burstline-0002-b\nburstline-0003-c",
		liveTexts: ["burstline-0001-a"],
	});
	assert.match(full, /--- burst coverage \(test-side judgement, issue #184\) ---/);
	assert.match(full, /expectedRows: 3/);
	assert.match(full, /driverRows: 3 \[1\.\.3\]/);
	assert.match(full, /frameRows: 2 \[2\.\.3\]/);
	assert.match(full, /liveRows: 1/);
	assert.match(full, /unionRows: 3/);
	assert.match(full, /missing: <none>/);

	const truncated = formatBurstDiagnostics({
		expectedRows: 5,
		driverTexts: ["burstline-0001-a\nburstline-0002-b\nburstline-0003-c\nburstline-0004-d\nburstline-0005-e"],
		frameText: "burstline-0004-d\nburstline-0005-e",
		liveTexts: [],
	});
	assert.match(truncated, /unionRows: 2/);
	assert.match(truncated, /missing: 3 \[1, 2, 3\]/);
});

test("formatBurstDiagnostics prints zeros when nothing was observed yet", () => {
	const empty = formatBurstDiagnostics({ expectedRows: 200 });
	assert.match(empty, /driverRows: 0/);
	assert.match(empty, /frameRows: 0/);
	assert.match(empty, /liveRows: 0/);
	assert.match(empty, /unionRows: 0/);
	assert.match(empty, /missing: 200 \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …\]/);
});
