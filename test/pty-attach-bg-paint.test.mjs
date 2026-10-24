// Issue #232: attach must not trim cells that carry only a non-default background.
// The fixture (test-support/attach-bg-paint-smoke.ts) drives a real @xterm/headless
// terminal through PtyAttachComponent.render(). Its background-only cells come from
// erase sequences (EL/ED) under an active bg, so these assertions fail whenever the
// render bound falls back to the last character.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

const FIXTURE = new URL("../test-support/attach-bg-paint-smoke.ts", import.meta.url);
const CURSOR_MARKER = "\x1b_pi:c\x07";
/** SGR params of the fixture's theme background (#1e1e2e). */
const PAINT_BG = [48, 2, 30, 30, 46];
const COLUMNS = 80;
const projections = JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", fileURLToPath(FIXTURE)], {
	encoding: "utf8",
	timeout: 30_000,
}));

function hasSequence(params, sequence) {
	for (let i = 0; i + sequence.length <= params.length; i++) {
		if (sequence.every((value, offset) => params[i + offset] === value)) return true;
	}
	return false;
}

/**
 * Split a projected line into SGR runs with the 0-based display column each run
 * starts at. Columns are counted per character, so only call this on ASCII lines
 * (A4 measures wide chars with `visibleWidth` instead). Throws on any escape
 * other than SGR: the fixture never emits links.
 */
function sgrRuns(line) {
	const runs = [];
	let params = [];
	let text = "";
	let col = 0;
	let startCol = 0;
	const flush = () => {
		if (!text) return;
		runs.push({ col: startCol, text, params });
		text = "";
	};
	for (let i = 0; i < line.length; ) {
		if (line.startsWith(CURSOR_MARKER, i)) {
			i += CURSOR_MARKER.length;
			continue;
		}
		const sgr = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
		if (sgr) {
			flush();
			params = sgr[1] ? sgr[1].split(";").map(Number) : [0];
			startCol = col;
			i += sgr[0].length;
			continue;
		}
		if (line[i] === "\x1b") throw new Error(`unexpected escape in projected line: ${JSON.stringify(line.slice(i, i + 12))}`);
		text += line[i];
		col += 1;
		i += 1;
	}
	flush();
	return runs;
}

function displayText(line) {
	return line.replaceAll(CURSOR_MARKER, "").replaceAll(/\x1b\[[0-9;]*m/g, "");
}

function inverseRows(lines) {
	return lines.flatMap((line, row) => (sgrRuns(line).some((run) => run.params.includes(7)) ? [row] : []));
}

test("A1: a blank line painted with a non-default bg renders its full width", () => {
	const lines = projections.blankPainted;
	assert.equal(lines.length, 10);
	for (const [row, line] of lines.entries()) {
		assert.notEqual(line, "", `body line ${row} dropped its background`);
		const runs = sgrRuns(line);
		assert.equal(runs.length, 1, `body line ${row} should be one SGR run`);
		assert.equal(runs[0].col, 0);
		assert.equal(runs[0].text, " ".repeat(COLUMNS), `body line ${row} should pad to the full width`);
		assert.ok(hasSequence(runs[0].params, PAINT_BG), `body line ${row} lost its background SGR`);
	}
});

test("A2: a content line renders the trailing background from the last painted column", () => {
	const line = projections.contentPainted.find((candidate) => candidate.includes("AB"));
	assert.ok(line, "fixture did not render the AB row");
	const runs = sgrRuns(line);
	// Cols 2-39 share the default attributes of "AB", so they stay in the first run.
	assert.equal(runs.length, 2);
	assert.equal(runs[0].col, 0);
	assert.equal(runs[0].text, "AB" + " ".repeat(38));
	assert.ok(!hasSequence(runs[0].params, PAINT_BG));
	assert.equal(runs[1].col, 40);
	assert.equal(runs[1].text, " ".repeat(40));
	assert.ok(hasSequence(runs[1].params, PAINT_BG));
	assert.equal(visibleWidth(displayText(line)), COLUMNS);
});

test("A3: default-background blank lines stay empty strings", () => {
	const lines = projections.plain;
	assert.equal(displayText(lines[0]), "hello");
	assert.equal(displayText(lines[1]), "world");
	for (let row = 2; row < lines.length; row++) {
		assert.equal(lines[row], "", `body line ${row} gained bytes without any background paint`);
	}
});

test("A4: a wide char keeps its padding aligned after an erased painted region", () => {
	const line = projections.wide[0];
	assert.equal(visibleWidth(displayText(line)), COLUMNS);
	assert.equal(displayText(line), "中" + " ".repeat(78));
	// The erase starts right of the continuation cell (col 2), so the paint run is 78 cells.
	const painted = new RegExp(`\\x1b\\[[0-9;]*${PAINT_BG.join(";")}m( *)\\x1b\\[0m$`).exec(line);
	assert.ok(painted, "painted tail SGR missing");
	assert.equal(painted[1].length, 78);
});

test("A5: a visible cursor inside the painted region is painted exactly once", () => {
	const lines = projections.cursor;
	assert.deepEqual(inverseRows(lines), [5]);
	const line = lines[5];
	assert.equal(line.split(CURSOR_MARKER).length - 1, 1);
	const inverse = sgrRuns(line).filter((run) => run.params.includes(7));
	assert.equal(inverse.length, 1);
	assert.equal(inverse[0].col, 30);
	assert.equal(inverse[0].text, " ", "the inverse block must cover exactly one cell");
	assert.equal(visibleWidth(displayText(line)), COLUMNS);
});

test("A9: a selection over painted padding renders inverse video", () => {
	const line = projections.selection[5];
	assert.deepEqual(inverseRows(projections.selection), [5]);
	const runs = sgrRuns(line);
	const selected = runs.filter((run) => run.params.includes(7));
	assert.equal(selected.length, 1);
	assert.equal(selected[0].col, 20);
	assert.equal(selected[0].text, " ".repeat(41), "cols 20-60 inclusive must all be selected");
	assert.ok(hasSequence(selected[0].params, PAINT_BG), "selection must keep the line background");
	assert.equal(visibleWidth(displayText(line)), COLUMNS);
	// The copy path reads buffer cells, never the rendered padding: a selection over
	// blank painted cells copies nothing.
	assert.equal(projections.selectionText, "");
});
