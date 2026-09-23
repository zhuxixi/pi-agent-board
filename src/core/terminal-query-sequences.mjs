/**
 * Terminal query sequence extraction and color-scheme report mapping for the
 * PTY attach client (issue #128).
 *
 * The attach client rebuilds the child screen in a headless terminal model, so
 * the child's terminal capability queries (OSC 11 background color, color
 * scheme change notifications) are consumed locally and never reach the real
 * terminal. extractOscQuerySequences pulls exactly those query/notify forms
 * out of the child output stream so the attach client can forward them to the
 * real terminal; the replies travel back through the existing input
 * passthrough (handleInput fallback). Setting forms (e.g. `\x1b]11;rgb:...`)
 * are deliberately NOT extracted: forwarding those would repaint the local
 * terminal's own colors.
 *
 * Kitty keyboard protocol / DA1 negotiation (`\x1b[>7u`, `\x1b[?u`, `\x1b[c`)
 * is intentionally out of scope: the child negotiates once at spawn, before
 * any attach client exists, and pushing kitty flags would retune the shared
 * real-terminal keyboard stack under the local Pi's feet.
 *
 * Pure functions only — no I/O, no pi-tui import (the report format below is
 * pinned by unit tests that round-trip it through pi-tui's parser).
 */

// OSC 11 background-color QUERY. The `?` payload is what makes it a query;
// the SET form `\x1b]11;rgb:...` never matches this prefix (`;r` vs `;?`).
const OSC11_QUERY_PREFIX = "\x1b]11;?";
const OSC11_QUERY_BEL = OSC11_QUERY_PREFIX + "\x07";
const OSC11_QUERY_ST = OSC11_QUERY_PREFIX + "\x1b\\";

// Color-scheme change notification switch (host Pi toggles it at startup and
// when its own setting changes; the real terminal then reports scheme changes
// as `\x1b[?997;{1|2}n` reports). Fixed-form CSI, no variadic fields.
const COLOR_SCHEME_NOTIFY_ON = "\x1b[?2031h";
const COLOR_SCHEME_NOTIFY_OFF = "\x1b[?2031l";

// Carry slack aligned with the extractor family in pty-attach.ts (payload cap
// + 4096). Our longest target is 8 bytes, so 4096 is ample even for a
// malformed no-terminator tail, and slice(-N) keeps the carry bounded.
export const OSC_QUERY_CARRY_MAX_BYTES = 4096;

const TARGETS = [OSC11_QUERY_PREFIX, COLOR_SCHEME_NOTIFY_ON, COLOR_SCHEME_NOTIFY_OFF];
const MAX_TARGET_LENGTH = Math.max(...TARGETS.map((t) => t.length));

/**
 * Extract forwardable terminal query / notify sequences from a child output
 * chunk. Returns the sequences (in order) and the carry: the unmatched tail
 * to prepend to the next chunk. The carry is either a target prefix suffix
 * (sequence split across chunks) or an unterminated OSC 11 query waiting for
 * its BEL/ST terminator.
 */
export function extractOscQuerySequences(input) {
	const sequences = [];
	let scanFrom = 0;
	let carryStart = -1;
	while (scanFrom < input.length) {
		const osc = input.indexOf(OSC11_QUERY_PREFIX, scanFrom);
		const notifyOn = input.indexOf(COLOR_SCHEME_NOTIFY_ON, scanFrom);
		const notifyOff = input.indexOf(COLOR_SCHEME_NOTIFY_OFF, scanFrom);
		const start = firstIndex(firstIndex(osc, notifyOn), notifyOff);
		if (start < 0) break;
		if (start === osc) {
			const after = start + OSC11_QUERY_PREFIX.length;
			const bel = input.indexOf("\x07", after);
			const st = input.indexOf("\x1b\\", after);
			const end = firstTerminator(bel, st);
			if (!end) {
				carryStart = start;
				break;
			}
			const [endIndex, terminatorLength] = end;
			const seq = input.slice(start, endIndex + terminatorLength);
			// Strict form: an OSC 11 query has no payload between `?` and the
			// terminator. Anything else (e.g. `\x1b]11;?<junk>\x07`) is not a
			// query we forward.
			if (seq === OSC11_QUERY_BEL || seq === OSC11_QUERY_ST) sequences.push(seq);
			scanFrom = endIndex + terminatorLength;
		} else {
			// Fixed-form CSI notify switch: an indexOf hit is always complete.
			const seq = start === notifyOn ? COLOR_SCHEME_NOTIFY_ON : COLOR_SCHEME_NOTIFY_OFF;
			sequences.push(seq);
			scanFrom = start + seq.length;
		}
	}
	const carry = carryStart >= 0
		? input.slice(carryStart).slice(-OSC_QUERY_CARRY_MAX_BYTES)
		: queryPrefixSuffix(input);
	return { sequences, carry };
}

/**
 * Longest suffix of `input` that is a strict prefix of one of our target
 * sequences (empty when none matches). Used as the carry when every target
 * occurrence in this chunk was complete.
 */
function queryPrefixSuffix(input) {
	const max = Math.min(input.length, MAX_TARGET_LENGTH - 1);
	for (let len = max; len > 0; len--) {
		const suffix = input.slice(-len);
		if (TARGETS.some((t) => t.startsWith(suffix))) return suffix;
	}
	return "";
}

function firstIndex(a, b) {
	if (a < 0) return b;
	if (b < 0) return a;
	return Math.min(a, b);
}

function firstTerminator(bel, st) {
	if (bel < 0 && st < 0) return null;
	if (bel >= 0 && (st < 0 || bel < st)) return [bel, 1];
	return [st, 2];
}

// Color-scheme report expected by pi-tui's parseTerminalColorSchemeReport
// (node_modules/@earendil-works/pi-tui/dist/terminal-colors.js:19):
// /^\x1b\[\?997;(1|2)n$/ with "2" => light, "1" => dark (line 57). Note the
// report code point is 997 — the QUERY the host sends is `\x1b[?996n`.
const COLOR_SCHEME_REPORTS = {
	light: "\x1b[?997;2n",
	dark: "\x1b[?997;1n",
};

/**
 * Map a color scheme ("light" | "dark") to the report sequence the host Pi's
 * pi-tui parser consumes. Returns "" for anything else; callers skip sending
 * on empty.
 */
export function toColorSchemeReport(scheme) {
	return COLOR_SCHEME_REPORTS[scheme] ?? "";
}
