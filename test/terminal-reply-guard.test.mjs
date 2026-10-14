import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyReplyEvent,
	createReplyGuard,
	isReplyGuardEnabled,
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

test("A2: a four-read DA1 reply is absorbed end to end", () => {
	const guard = createReplyGuard();
	let now = 1000;
	for (const chunk of DA1_CHUNKS.slice(0, 3)) {
		assert.deepEqual(guard.feed(chunk, now), { action: "swallow" }, JSON.stringify(chunk));
		now += 60;
	}
	assert.deepEqual(guard.feed(DA1_CHUNKS[3], now), { action: "swallow" });
	assert.equal(guard.pendingSince(), null, "completion closes the window");
	assert.deepEqual(guard.feed("hello", now + 1), { action: "pass" }, "the guard is idle again");
});

test("A3: the window absorbs plain fragments, expires on time, and resets", () => {
	const guard = createReplyGuard();
	assert.deepEqual(guard.feed("\x1b[?61;6;", 1000), { action: "swallow" });
	assert.deepEqual(guard.feed("7;22;", 1060), { action: "swallow" });
	assert.equal(guard.pendingSince(), 1000, "the window is anchored at the head, not at the last fragment");
	assert.equal(guard.expire(1249), null, "an early timer must not close the window");
	assert.equal(guard.pendingSince(), 1000);
	assert.deepEqual(guard.expire(1250), { action: "swallow" }, "expiry drops the incomplete prefix");
	assert.equal(guard.pendingSince(), null);
	assert.deepEqual(guard.feed("plain", 1300), { action: "pass" }, "state is idle after expiry");
});

test("A3: the absorb cap bounds the loss and drops the overflowing event", () => {
	const guard = createReplyGuard({ maxAbsorbBytes: 16 });
	assert.deepEqual(guard.feed("\x1b[6;", 1000), { action: "swallow" });
	assert.deepEqual(guard.feed("0123456789", 1010), { action: "swallow" }, "14 bytes: still absorbed");
	assert.deepEqual(guard.feed("XYZ", 1020), { action: "swallow" }, "overflow is dropped, not passed");
	assert.equal(guard.pendingSince(), null, "overflow closes the window");
	assert.deepEqual(guard.feed("after", 1030), { action: "pass" });
});

test("A3: reset() leaves no residue and windows do not leak across events", () => {
	const guard = createReplyGuard();
	guard.feed("\x1b[?1;", 1000);
	guard.reset();
	assert.equal(guard.pendingSince(), null);
	assert.deepEqual(guard.feed("tail", 1010), { action: "pass" }, "a reset window must not absorb");
	assert.deepEqual(guard.feed("\x1b[?61;6;", 1100), { action: "swallow" }, "a later head arms normally");
	assert.deepEqual(guard.expire(1400), { action: "swallow" });
	assert.deepEqual(guard.feed("\x1b]11;rgb:", 1500), { action: "swallow" }, "the next window is independent");
	assert.deepEqual(guard.feed("2887/2a18/353c\x07", 1510), { action: "forward", data: "\x1b]11;rgb:2887/2a18/353c\x07" });
});

test("A3: an 'other' event ends the window, passes, and protects later text", () => {
	for (const seq of ["\x1b[5~", "\x1b[<35;20;5M", "\x1b[200~hi\x1b[201~"]) {
		const guard = createReplyGuard();
		guard.feed("\x1b[?61;6;", 1000);
		assert.deepEqual(guard.feed(seq, 1010), { action: "pass" }, JSON.stringify(seq));
		assert.equal(guard.pendingSince(), null, JSON.stringify(seq));
		assert.deepEqual(guard.feed("hello", 1020), { action: "pass" }, "the dropped buffer must not swallow later text");
	}
});

test("A3: a new reply head re-arms and the stale buffer is gone", () => {
	const guard = createReplyGuard();
	assert.deepEqual(guard.feed("\x1b[?61;6;", 1000), { action: "swallow" });
	assert.deepEqual(guard.feed("\x1b]11;", 1100), { action: "swallow" }, "the new head wins");
	assert.equal(guard.pendingSince(), 1100, "the window restarts at the new head");
	assert.equal(guard.expire(1250), null, "not yet 250ms after the new head");
	assert.deepEqual(guard.feed("rgb:2887/2a18/353c\x07", 1300), { action: "forward", data: "\x1b]11;rgb:2887/2a18/353c\x07" }, "the forwarded bytes carry no stale DA prefix");
	assert.equal(guard.pendingSince(), null);
});

test("A3: a complete reply inside an open window is handled alone, never joined", () => {
	const guard = createReplyGuard();
	guard.feed("\x1b]11;rgb:", 1000);
	assert.deepEqual(guard.feed(OSC11_REPLY, 1050), { action: "forward", data: OSC11_REPLY }, "byte-for-byte, without the stale prefix");
	assert.equal(guard.pendingSince(), null);
	const dropped = createReplyGuard();
	dropped.feed("\x1b[?61;6;", 1000);
	assert.deepEqual(dropped.feed("\x1b[?1u", 1010), { action: "swallow" }, "a stale buffer plus a fresh kitty reply still drops");
	assert.equal(dropped.pendingSince(), null);
	assert.deepEqual(createReplyGuard().feed(OSC11_REPLY, 1000), { action: "forward", data: OSC11_REPLY }, "idle + complete forwards the whole event");
	assert.deepEqual(createReplyGuard().feed("\x1b[?1u", 1000), { action: "swallow" }, "idle + complete drop swallows");
});

test("A3: the spec's window and cap are pinned", () => {
	assert.equal(REPLY_GUARD_WINDOW_MS, 250);
	assert.equal(REPLY_GUARD_MAX_ABSORB_BYTES, 64);
});

test("A4: near-miss prefixes arm the window, unknown complete CSI does not", () => {
	assert.deepEqual(classifyReplyEvent("\x1b[?61;6;"), { kind: "reply-head", family: "device-attributes" }, "a DA1 prefix is a reply head");
	for (const seq of ["\x1b[?1;", "\x1b[6;", "\x1b[6;24;80", "\x1b]11;", "\x1bP"]) {
		const guard = createReplyGuard();
		assert.deepEqual(guard.feed(seq, 1000), { action: "swallow" }, JSON.stringify(seq));
		assert.equal(guard.pendingSince(), 1000, JSON.stringify(seq));
	}
	const guard = createReplyGuard();
	assert.deepEqual(guard.feed("\x1b[1;2R", 1000), { action: "pass" });
	assert.equal(guard.pendingSince(), null, "a complete unknown CSI must not arm the guard");
});

test("A5: a fragmented color reply is joined and forwarded whole", () => {
	const guard = createReplyGuard();
	assert.deepEqual(guard.feed("\x1b]11;rgb:", 1000), { action: "swallow" });
	assert.deepEqual(guard.feed("2887/2a18/", 1060), { action: "swallow" });
	assert.deepEqual(guard.feed("353c\x1b\\", 1120), { action: "forward", data: "\x1b]11;rgb:2887/2a18/353c\x1b\\" });
	assert.equal(guard.pendingSince(), null);
});

test("A7: the kill switch accepts 0/off/false and defaults to enabled", () => {
	assert.equal(isReplyGuardEnabled(undefined), true);
	assert.equal(isReplyGuardEnabled(""), true);
	assert.equal(isReplyGuardEnabled("1"), true);
	assert.equal(isReplyGuardEnabled(" ON "), true);
	for (const off of ["0", "off", "false", " 0 ", "OFF", "False"]) {
		assert.equal(isReplyGuardEnabled(off), false, JSON.stringify(off));
	}
});
