/**
 * Inbound terminal reply guard for the PTY attach client (issue #170).
 *
 * pi-tui hands replies to forwarded terminal queries to this overlay as input
 * fragments: the prefix arms a 50ms sequence timeout in StdinBuffer and a
 * 150ms negotiation flush in ProcessTerminal, so a CSI-shaped reply head is
 * emitted as an input event and the remaining fragments arrive as plain text.
 * The overlay's passthrough then feeds that garbage into the child's editor
 * (upstream earendil-works/pi#10657 — a DA1 reply arrives as four reads and
 * shows up in the child as a stable `c7c`).
 *
 * This module classifies every inbound event and the state machine below
 * swallows reply fragments until the sequence completes. Color replies (OSC
 * 4/10/11/12 and the 997 scheme report) are forwarded as ONE whole sequence,
 * because the child's pi-tui parsers anchor `^...$`; everything else falls
 * through untouched (issue #128 decision: the child negotiates at spawn, a late
 * DA/kitty reply is meaningless to it, and forwarding kitty flags would retune
 * the shared real-terminal keyboard stack).
 *
 * Pure only: no I/O, no timers, no `process.env`, no pi-tui import. Time is
 * injected by the caller (see `armReplyGuardTimer` in src/ui/pty-attach.ts).
 */

/** How long an open reply window stays open for trailing fragments (spec §3.3). */
export const REPLY_GUARD_WINDOW_MS = 250;

/** Bound on how much of a user's fast typing an open window may absorb. */
export const REPLY_GUARD_MAX_ABSORB_BYTES = 64;

// Complete reply shapes that are dropped. The child's negotiation happened at
// spawn, before any attach client existed, so a late reply can only pollute its
// input or retune keyboards that no longer asked.
const DROP_SHAPES = [
	// DA1 / DA3 (`\x1b[?...c`, `\x1b[=...c`) and DA2 (`\x1b[>...c`).
	{ family: "device-attributes", pattern: /^\x1b\[[?>=][0-9;]*c$/ },
	// kitty keyboard flags reply.
	{ family: "kitty-flags", pattern: /^\x1b\[\?[0-9;]*u$/ },
	// XTWINOPS cell-size report (`\x1b[6;<rows>;<cols>t`).
	{ family: "cell-size", pattern: /^\x1b\[6;[0-9]+;[0-9]+t$/ },
	// DCS replies such as XTVersion.
	{ family: "dcs", pattern: /^\x1bP[\s\S]*\x1b\\$/ },
];

// Complete reply shapes that are forwarded whole: the child's pi-tui parsers
// consume them (automatic light/dark theme) and only as one sequence.
const FORWARD_SHAPES = [
	// `\x1b[?997;<n>n` color-scheme report. Any single digit is forwarded — value
	// validation belongs to the child's parser, not to this guard.
	{ family: "color-scheme", pattern: /^\x1b\[\?997;[0-9]+n$/ },
	// OSC 4 palette / 10 foreground / 11 background / 12 cursor color replies,
	// BEL- or ST-terminated.
	{ family: "osc-color", pattern: /^\x1b\](?:4;[0-9]+|10|11|12);[\s\S]*(?:\x07|\x1b\\)$/ },
];

// Prefixes that can only start a reply and can never be a key/mouse/paste
// encoding — only these arm an absorption window. Deliberately absent: bare
// `\x1b`, `\x1b[`, `\x1b[5`/`\x1b[6` (PageUp/PageDown heads), `\x1b[<` (SGR
// mouse), `\x1bO` (SS3).
const REPLY_HEADS = [
	{ family: "device-attributes", prefix: "\x1b[?" },
	{ family: "device-attributes", prefix: "\x1b[>" },
	{ family: "cell-size", prefix: "\x1b[6;" },
	{ family: "dcs", prefix: "\x1bP" },
	{ family: "osc-color", prefix: "\x1b]1" },
	{ family: "osc-color", prefix: "\x1b]4" },
];

/**
 * Classify one inbound input event. Complete reply shapes win over head
 * prefixes (a complete kitty reply also starts with `\x1b[?`); escape-led
 * events that are neither are keys, mouse or paste data.
 */
export function classifyReplyEvent(data) {
	if (typeof data !== "string" || data.length === 0) return { kind: "plain" };
	for (const shape of DROP_SHAPES) {
		if (shape.pattern.test(data)) return { kind: "reply-complete", family: shape.family, action: "drop" };
	}
	for (const shape of FORWARD_SHAPES) {
		if (shape.pattern.test(data)) return { kind: "reply-complete", family: shape.family, action: "forward" };
	}
	for (const head of REPLY_HEADS) {
		if (data.startsWith(head.prefix)) return { kind: "reply-head", family: head.family };
	}
	// Everything else that starts with ESC is a key/mouse/paste encoding; plain
	// text may be a reply tail fragment (those never start with ESC after the
	// upstream split, see the field evidence in the issue).
	return data.startsWith("\x1b") ? { kind: "other" } : { kind: "plain" };
}
