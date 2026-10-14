import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyReplyEvent,
	REPLY_GUARD_MAX_ABSORB_BYTES,
	REPLY_GUARD_WINDOW_MS,
} from "../src/core/terminal-reply-guard.mjs";

// Real bytes from upstream earendil-works/pi#10657 (WezTerm 20240203 + ConPTY):
// a DA1 reply delivered as four reads, more than 50ms apart.
const DA1 = "\x1b[?61;6;7;22;23;24;28;32;42c";
const DA1_CHUNKS = ["\x1b[?61;6;", "7;22;23;", "24;28;32", ";42c"];
const OSC11_REPLY = "\x1b]11;rgb:2887/2a18/353c\x1b\\";

test("A1: complete drop-family replies classify as drop", () => {
	for (const [family, seq] of [
		["device-attributes", DA1],
		["device-attributes", "\x1b[?c"],
		["device-attributes", "\x1b[=1;2c"],
		["device-attributes", "\x1b[>41;330;0c"],
		["kitty-flags", "\x1b[?1u"],
		["kitty-flags", "\x1b[?61;6u"],
		["cell-size", "\x1b[6;24;80t"],
		["dcs", "\x1bP>|WezTerm 20240203\x1b\\"],
	]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "reply-complete", family, action: "drop" }, JSON.stringify(seq));
	}
});

test("A1: near-miss shapes keep the designed classification", () => {
	// Complete but parameterless DA1 → drop (complete shape wins over "incomplete").
	assert.deepEqual(classifyReplyEvent("\x1b[?c"), { kind: "reply-complete", family: "device-attributes", action: "drop" });
	// Unknown third value on the scheme report → forward (the child's parser rejects it).
	assert.deepEqual(classifyReplyEvent("\x1b[?997;3n"), { kind: "reply-complete", family: "color-scheme", action: "forward" });
	// Complete but unknown CSI (DSR) → not a reply family: pass as "other".
	assert.deepEqual(classifyReplyEvent("\x1b[1;2R"), { kind: "other" });
});

test("A5: color replies are forward-family, both terminators", () => {
	for (const seq of [
		OSC11_REPLY,
		"\x1b]11;rgb:efef/f1f1/f5f5\x07",
		"\x1b]10;rgb:ffff/ffff/ffff\x07",
		"\x1b]12;rgb:0000/0000/0000\x1b\\",
		"\x1b]4;0;rgb:0000/0000/0000\x07",
	]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "reply-complete", family: "osc-color", action: "forward" }, JSON.stringify(seq));
	}
	for (const seq of ["\x1b[?997;1n", "\x1b[?997;2n"]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "reply-complete", family: "color-scheme", action: "forward" }, JSON.stringify(seq));
	}
});

test("A4: non-reply input is 'other' (escape-led) or 'plain' (text), never a reply", () => {
	for (const seq of [
		"\x1b[5~", "\x1b[6~", "\x1b[H", "\x1b[F", "\x1b[3~", "\x1b[<35;20;5M",
		"\x1bOA", "\x1bOB", "\x1b", "\x1bz", "\x1b[27;5;92~", "\x1b[92;5u",
		"\x1b[200~paste\x1b[201~", "\x1b[1;5D", "\x1b[1;2R",
	]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "other" }, JSON.stringify(seq));
	}
	for (const seq of ["hello", "7;22;23;", ";42c", "24;28;32"]) {
		assert.deepEqual(classifyReplyEvent(seq), { kind: "plain" }, JSON.stringify(seq));
	}
	assert.deepEqual(classifyReplyEvent(""), { kind: "plain" }, "an empty event is inert");
});
