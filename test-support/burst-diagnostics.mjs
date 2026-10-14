/**
 * Test-side judgement block for the A5 burst case (issue #184).
 *
 * The durable-state postmortem cannot tell "the child never emitted the rows"
 * from "the snapshot frame window truncated them": both end as an empty
 * diagnostics/journal with a healthy host. These counters can — the driver is
 * subscribed BEFORE the burst, so a complete driver range proves the child wrote
 * every row and the loss sits in the frame / catch-up path.
 *
 * Pure: no I/O, no timers, no assertions (judgement stays in the test case).
 */

/**
 * @param {string} text arbitrary chunk text (many lines, a partial line, or no
 *   burst content at all)
 * @returns {number[]} unique `burstline-NNNN` ids, ascending
 */
export function collectBurstIds(text) {
	const ids = new Set();
	for (const m of String(text ?? "").matchAll(/burstline-(\d{4})/g)) ids.add(Number(m[1]));
	return [...ids].sort((a, b) => a - b);
}

/**
 * @param {number[]} ids ascending ids
 * @returns {string} `3 [1..3]`, or `0` when empty
 */
function formatRange(ids) {
	if (ids.length === 0) return "0";
	return `${ids.length} [${ids[0]}..${ids[ids.length - 1]}]`;
}

/**
 * Render the block appended to a failing wait's postmortem.
 * @param {{
 *   expectedRows: number,
 *   driverTexts?: string[],
 *   frameText?: string,
 *   liveTexts?: string[],
 * }} input `expectedRows` is the burst size the case asserts; `driverTexts` come
 *   from the client that was subscribed BEFORE the burst, `frameText`/`liveTexts`
 *   from the client under test.
 * @returns {string}
 */
export function formatBurstDiagnostics({ expectedRows, driverTexts = [], frameText = "", liveTexts = [] }) {
	const driverIds = collectBurstIds(driverTexts.join("\n"));
	const frameIds = collectBurstIds(frameText);
	const liveIds = collectBurstIds(liveTexts.join("\n"));
	const union = new Set([...frameIds, ...liveIds]);
	const missing = [];
	for (let i = 1; i <= expectedRows; i += 1) {
		if (!union.has(i)) missing.push(i);
	}
	const shown = missing.slice(0, 10).join(", ");
	const missingText = missing.length === 0
		? "<none>"
		: `${missing.length} [${shown}${missing.length > 10 ? ", …" : ""}]`;
	return [
		"--- burst coverage (test-side judgement, issue #184) ---",
		`expectedRows: ${expectedRows}`,
		`driverRows: ${formatRange(driverIds)}`,
		`frameRows: ${formatRange(frameIds)}`,
		`liveRows: ${liveIds.length}`,
		`unionRows: ${union.size}`,
		`missing: ${missingText}`,
	].join("\n");
}
