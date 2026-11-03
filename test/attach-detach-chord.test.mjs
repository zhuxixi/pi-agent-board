import assert from "node:assert/strict";
import test from "node:test";
import { resolveAttachDetachChord } from "../src/core/attach-detach.mjs";
import { splitAttachInput } from "../src/core/pty-scroll.mjs";

// Issue #266 A1: the three unconditional detach chords, each in the encodings a
// real terminal can emit (legacy ESC-prefix / kitty CSI-u / modifyOtherKeys),
// plus the negative matrix that keeps ordinary typing out of the chord set.
const POSITIVE = [
	["ctrl+\\ raw 0x1c", "\x1c"],
	["ctrl+\\ kitty CSI-u", "\x1b[92;5u"],
	["ctrl+\\ modifyOtherKeys", "\x1b[27;5;92~"],
	["ctrl+left xterm", "\x1b[1;5D"],
	["ctrl+left SS3", "\x1bOd"],
	["ctrl+left kitty KP", "\x1b[57417;5u"],
	["alt+h legacy ESC prefix", "\x1bh"],
	["alt+h kitty CSI-u", "\x1b[104;3u"],
	["alt+h kitty alternate key", "\x1b[104:104;3u"],
	["alt+h kitty event type", "\x1b[104;3:1u"],
	["alt+h modifyOtherKeys", "\x1b[27;3;104~"],
];

const NEGATIVE = [
	["bare h", "h"],
	["shifted legacy alt+H", "\x1bH"],
	["ctrl+x", "\x18"],
	["ctrl+alt+h kitty", "\x1b[104;7u"],
	["shift+alt+h kitty", "\x1b[104;4u"],
	["alt+h with text codepoint", "\x1b[104;3;104u"],
	// The spec's D3 unbinds Alt+←: chord-shaped but not a detach chord.
	["alt+left xterm", "\x1b[1;3D"],
	["plain text", "abc"],
	["lone escape", "\x1b"],
	["ctrl+] passthrough", "\x1d"],
];

test("resolveAttachDetachChord: encoding matrix (issue #266 A1)", () => {
	for (const [label, data] of POSITIVE) {
		assert.equal(resolveAttachDetachChord(data), true, `${label} must detach`);
	}
	for (const [label, data] of NEGATIVE) {
		assert.equal(resolveAttachDetachChord(data), false, `${label} must not detach`);
	}
});

// A4: a bracketed paste is one key segment; ESC h inside it must never resolve.
test("resolveAttachDetachChord: paste containing ESC h never detaches (issue #266 A4)", () => {
	const segments = splitAttachInput("\x1b[200~a\x1bhb\x1b[201~");
	assert.equal(segments.length, 1);
	assert.equal(segments[0].kind, "key");
	assert.equal(resolveAttachDetachChord(segments[0].data), false);
});

test("resolveAttachDetachChord: ESC and h in separate reads are not the chord (issue #266 A4)", () => {
	const escSegments = splitAttachInput("\x1b");
	const hSegments = splitAttachInput("h");
	assert.equal(resolveAttachDetachChord(escSegments[0].data), false);
	assert.equal(resolveAttachDetachChord(hSegments[0].data), false);
});
