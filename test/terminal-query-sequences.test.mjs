import test from "node:test";
import assert from "node:assert/strict";
import { extractOscQuerySequences, toColorSchemeReport, OSC_QUERY_CARRY_MAX_BYTES } from "../src/core/terminal-query-sequences.mjs";
// Test-only import: round-trips our produced report through pi-tui's real
// parser. Production code must NOT import pi-tui (see module docblock).
import { parseTerminalColorSchemeReport } from "@earendil-works/pi-tui/dist/terminal-colors.js";

const Q_BEL = "\x1b]11;?\x07";
const Q_ST = "\x1b]11;?\x1b\\";
const SET_BEL = "\x1b]11;rgb:efef/f1f1/f5f5\x07";
const SET_ST = "\x1b]11;rgb:efef/f1f1/f5f5\x1b\\";
const NOTIFY_ON = "\x1b[?2031h";
const NOTIFY_OFF = "\x1b[?2031l";
const KITTY_DA = "\x1b[>7u\x1b[?u\x1b[c";

test("A1: OSC 11 query with BEL terminator is forwarded", () => {
	const { sequences, carry } = extractOscQuerySequences(`hello${Q_BEL}world`);
	assert.deepEqual(sequences, [Q_BEL]);
	assert.equal(carry, "");
});

test("A1: OSC 11 query with ST terminator is forwarded", () => {
	const { sequences, carry } = extractOscQuerySequences(Q_ST);
	assert.deepEqual(sequences, [Q_ST]);
	assert.equal(carry, "");
});

test("A1: OSC 11 SET form (rgb payload) is never forwarded — BEL and ST", () => {
	for (const set of [SET_BEL, SET_ST]) {
		const { sequences, carry } = extractOscQuerySequences(set);
		assert.deepEqual(sequences, [], `set form must not forward: ${JSON.stringify(set)}`);
		assert.equal(carry, "");
	}
});

test("A1: malformed OSC 11 query (junk before terminator) is not forwarded", () => {
	const { sequences } = extractOscQuerySequences("\x1b]11;?junk\x07");
	assert.deepEqual(sequences, []);
});

test("A1: 2031 notify on/off are forwarded as-is", () => {
	assert.deepEqual(extractOscQuerySequences(NOTIFY_ON).sequences, [NOTIFY_ON]);
	assert.deepEqual(extractOscQuerySequences(NOTIFY_OFF).sequences, [NOTIFY_OFF]);
});

test("A1: kitty/DA negotiation is neither forwarded nor mangled into carry", () => {
	const { sequences, carry } = extractOscQuerySequences(KITTY_DA);
	assert.deepEqual(sequences, []);
	assert.equal(carry, "");
});

test("A1: query and notify in one chunk forward in order", () => {
	const { sequences, carry } = extractOscQuerySequences(`${NOTIFY_ON}${Q_BEL}${NOTIFY_OFF}`);
	assert.deepEqual(sequences, [NOTIFY_ON, Q_BEL, NOTIFY_OFF]);
	assert.equal(carry, "");
});

test("A1: query split mid-escape is recognized after carry join", () => {
	const first = extractOscQuerySequences("x\x1b]1");
	assert.deepEqual(first.sequences, []);
	assert.equal(first.carry, "\x1b]1");
	const joined = extractOscQuerySequences(first.carry + "1;?\x07");
	assert.deepEqual(joined.sequences, [Q_BEL]);
	assert.equal(joined.carry, "");
});

test("A1: ST terminator itself split across chunks is recognized after carry join", () => {
	const first = extractOscQuerySequences("x" + Q_ST.slice(0, -1)); // ...\x1b
	assert.deepEqual(first.sequences, []);
	assert.equal(first.carry, Q_ST.slice(0, -1));
	const joined = extractOscQuerySequences(first.carry + Q_ST.slice(-1) + "tail");
	assert.deepEqual(joined.sequences, [Q_ST]);
	assert.equal(joined.carry, "");
});

test("A1: notify switch split across chunks is recognized after carry join", () => {
	const first = extractOscQuerySequences("a\x1b[?20");
	assert.deepEqual(first.sequences, []);
	assert.equal(first.carry, "\x1b[?20");
	const joined = extractOscQuerySequences(first.carry + "31h");
	assert.deepEqual(joined.sequences, [NOTIFY_ON]);
	assert.equal(joined.carry, "");
});

test("A1: unterminated query prefix is carried and capped under prefix flood", () => {
	const flood = Q_BEL.slice(0, -1).repeat(100); // `\x1b]11;?` × 100, no terminator
	const { sequences, carry } = extractOscQuerySequences(flood);
	assert.deepEqual(sequences, []);
	assert.ok(carry.length > 0, "partial query tail must be carried");
	assert.ok(carry.length <= OSC_QUERY_CARRY_MAX_BYTES, "carry must stay bounded");
});

test("A1: non-query content leaves an empty carry", () => {
	const { sequences, carry } = extractOscQuerySequences("plain output \x1b[2J reset");
	assert.deepEqual(sequences, []);
	assert.equal(carry, "");
});

test("A2: toColorSchemeReport round-trips through pi-tui's parser (format source: pi-tui dist/terminal-colors.js:19,57)", () => {
	assert.equal(parseTerminalColorSchemeReport(toColorSchemeReport("light")), "light");
	assert.equal(parseTerminalColorSchemeReport(toColorSchemeReport("dark")), "dark");
});

test("A2: report format matches the pi-tui grammar exactly (997 report code, 2=light 1=dark)", () => {
	assert.equal(toColorSchemeReport("light"), "\x1b[?997;2n");
	assert.equal(toColorSchemeReport("dark"), "\x1b[?997;1n");
});

test("A2: unknown/invalid scheme maps to empty string", () => {
	assert.equal(toColorSchemeReport("sepia"), "");
	assert.equal(toColorSchemeReport(""), "");
	assert.equal(toColorSchemeReport(undefined), "");
});

// Review F1a: a stale carry that fails to join a target is dropped, not kept.
test("stale carry is discarded when the next chunk fails to complete a target", () => {
	const first = extractOscQuerySequences("\x1b]1");
	assert.deepEqual(first, { sequences: [], carry: "\x1b]1" });
	// "\x1b]1" + "9xyz" never forms a target prefix chain ("9" cannot follow "]1")
	const second = extractOscQuerySequences("9xyz");
	assert.deepEqual(second, { sequences: [], carry: "" });
});

// Review F1b: the carry cap actually truncates (flood beyond OSC_QUERY_CARRY_MAX_BYTES).
test("unterminated tail is truncated to OSC_QUERY_CARRY_MAX_BYTES", () => {
	const flood = "\x1b]11;?" + "x".repeat(OSC_QUERY_CARRY_MAX_BYTES + 100);
	const { sequences, carry } = extractOscQuerySequences(flood);
	assert.deepEqual(sequences, []);
	assert.equal(carry.length, OSC_QUERY_CARRY_MAX_BYTES);
});

// Review F3a: nearest terminator wins when both BEL and ST follow the query.
test("nearest terminator wins when both BEL and ST are present", () => {
	const { sequences } = extractOscQuerySequences("\x1b]11;?\x07junk\x1b\\");
	assert.deepEqual(sequences, ["\x1b]11;?\x07"]);
});

// Review F3b: scan resumes correctly after a rejected junk OSC in the same chunk.
test("valid query after a rejected junk-form OSC is still forwarded", () => {
	const { sequences } = extractOscQuerySequences("\x1b]11;?junk\x07\x1b]11;?\x07");
	assert.deepEqual(sequences, ["\x1b]11;?\x07"]);
});
