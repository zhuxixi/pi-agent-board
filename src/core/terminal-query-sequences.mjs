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
	return Object.hasOwn(COLOR_SCHEME_REPORTS, scheme) ? COLOR_SCHEME_REPORTS[scheme] : "";
}

/**
 * Issue #148: derive the color scheme from an OSC 11 background reply, so the
 * attach client can answer the scheme question itself instead of relying on
 * the child's own probe being resolved (Pi's leaked pending state swallows the
 * first late reply — see the issue for the exact swallow path).
 *
 * Mirrors Pi's own threshold (`getRgbColorLuminance` + `>= 0.5` in the theme
 * detection code) so a client-side answer matches what Pi would have
 * concluded from the same reply. Relative luminance per WCAG/sRGB.
 *
 * @param rgb - parsed reply channels ({r,g,b} in 0-255), or undefined.
 * @returns "light" / "dark", or undefined when the input is not a usable rgb.
 */
export function colorSchemeForBackgroundRgb(rgb) {
	if (!rgb || typeof rgb !== "object") return undefined;
	const { r, g, b } = rgb;
	if (![r, g, b].every((channel) => Number.isFinite(channel))) return undefined;
	const luminance = 0.2126 * toLinearChannel(r) + 0.7152 * toLinearChannel(g) + 0.0722 * toLinearChannel(b);
	return luminance >= 0.5 ? "light" : "dark";
}

function toLinearChannel(channel) {
	const value = channel / 255;
	return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

// --- Attach settle scheme probe (issue #161) -------------------------------
// pi-tui >= 0.99 renamed queryTerminalBackgroundColor -> queryTerminalColors.
// This repo compiles against pi-tui 0.79.8 but the extension runs against the
// host pi's pi-tui (peerDependencies "*"), so the probe feature-detects at
// runtime. Local structural typedefs only — TerminalColors does not exist on
// the 0.79.8 compile face and must not be imported.

/** @typedef {{ r: number, g: number, b: number }} SettleRgb */
/** @typedef {{ background?: SettleRgb, foreground?: SettleRgb, palette?: SettleRgb[] }} TerminalColorsLike */
/** @typedef {{ queryTerminalColors?: (opts: { timeoutMs: number, onLateReply?: (colors: TerminalColorsLike) => void }) => Promise<TerminalColorsLike>, queryTerminalBackgroundColor?: (opts: { timeoutMs: number }) => Promise<SettleRgb|undefined> }} SettleProbeSurface */
/** @typedef {{ rgb?: SettleRgb, anyColors: boolean }} SettleProbeResult */

/**
 * Issue #161: detect which terminal color query API a TUI surface exposes.
 * Detection is pure; the returned adapter only calls the passed-in surface.
 * @param {SettleProbeSurface} tuiLike
 * @returns {{ api: "colors"|"background"|"none", invoke: (tui: SettleProbeSurface, timeoutMs: number, onLateReply?: (colors: TerminalColorsLike) => void) => Promise<SettleProbeResult> }}
 */
export function resolveProbeApi(tuiLike) {
	if (tuiLike && typeof tuiLike.queryTerminalColors === "function") {
		return {
			api: "colors",
			invoke: async (tui, timeoutMs, onLateReply) => {
				const colors = await tui.queryTerminalColors({ timeoutMs, onLateReply });
				return { rgb: backgroundRgbFromTerminalColors(colors), anyColors: hasAnyColor(colors) };
			},
		};
	}
	if (tuiLike && typeof tuiLike.queryTerminalBackgroundColor === "function") {
		return {
			api: "background",
			invoke: async (tui, timeoutMs) => {
				const rgb = await tui.queryTerminalBackgroundColor({ timeoutMs });
				return { rgb, anyColors: rgb !== undefined };
			},
		};
	}
	return { api: "none", invoke: async () => ({ rgb: undefined, anyColors: false }) };
}

/** @param {TerminalColorsLike} colors @returns {SettleRgb|undefined} */
export function backgroundRgbFromTerminalColors(colors) {
	return colors && typeof colors === "object" ? colors.background : undefined;
}

/** @param {TerminalColorsLike} colors @returns {boolean} */
function hasAnyColor(colors) {
	if (!colors || typeof colors !== "object") return false;
	if (colors.background !== undefined || colors.foreground !== undefined) return true;
	return Array.isArray(colors.palette) && colors.palette.some((c) => c !== undefined);
}

const SETTLE_SCHEME_WARN_OUTCOMES = new Set(["timeout", "error", "no_background", "no_probe_api", "dropped_disconnected"]);

/**
 * Issue #161: build the DiagnosticEvent-compatible patch for the settle scheme
 * flow. Field names MUST stay inside normalizeDiagnostic's whitelist
 * (level/code/runId/source/message/details) — anything else is silently
 * dropped. Warn only when delivery was expected but failed; routine outcomes
 * (dedup, quick detach, kill switch) stay info so warningCount stays meaningful.
 * @param {{ probeApi?: "colors"|"background"|"none", outcome: "reported"|"timeout"|"error"|"no_background"|"no_probe_api"|"dropped_closed"|"dropped_disconnected"|"duplicate_skipped"|"suppressed", report?: string, late?: boolean }} details
 * @returns {{ source: string, level: "info"|"warn", code: string, message: string, details: { probeApi?: string, outcome: string, report?: string, late?: boolean } }}
 */
export function buildSettleSchemePatch(details) {
	const parts = [details.outcome];
	if (details.probeApi) parts.push(`via ${details.probeApi}`);
	if (details.report) parts.push(details.report);
	if (details.late) parts.push("late");
	const patch = {
		source: "attach",
		level: SETTLE_SCHEME_WARN_OUTCOMES.has(details.outcome) ? "warn" : "info",
		code: "attach_settle_scheme",
		message: `attach settle scheme: ${parts.join(" ")}`,
		details: { outcome: details.outcome },
	};
	if (details.probeApi !== undefined) patch.details.probeApi = details.probeApi;
	if (details.report !== undefined) patch.details.report = details.report;
	if (details.late !== undefined) patch.details.late = details.late;
	return patch;
}
