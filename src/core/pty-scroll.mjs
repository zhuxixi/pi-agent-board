export function clampInt(value, min, max) {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Lines scrolled per mouse-wheel event in the attach viewport when unset/invalid. */
export const DEFAULT_WHEEL_LINES = 1;
/** Lower bound for $AGENT_BOARD_WHEEL_LINES. */
export const MIN_WHEEL_LINES = 1;
/** Upper bound for $AGENT_BOARD_WHEEL_LINES. */
export const MAX_WHEEL_LINES = 50;

/**
 * Resolve how many lines a single mouse-wheel event scrolls in the attach viewport.
 *
 * Reads `AGENT_BOARD_WHEEL_LINES`, clamps it to `[MIN_WHEEL_LINES, MAX_WHEEL_LINES]`,
 * and falls back to `DEFAULT_WHEEL_LINES` when unset, empty, or non-numeric. macOS
 * inertial/momentum scrolling fires a *burst* of wheel events per gesture, so a small
 * value here already scrolls quickly; the previous fixed `5` overshot badly.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 */
export function resolveWheelLines(env = process.env) {
	const raw = String(env.AGENT_BOARD_WHEEL_LINES ?? "").trim();
	if (!raw) return DEFAULT_WHEEL_LINES;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_WHEEL_LINES;
	return clampInt(parsed, MIN_WHEEL_LINES, MAX_WHEEL_LINES);
}

function parseMouseEventPrefix(data, offset = 0) {
	const input = data.slice(offset);
	const sgr = /^\x1b\[(<|\?)(\d+);(\d+);(\d+)([Mm])/.exec(input);
	if (sgr) {
		const button = Number(sgr[2]);
		const col = Number(sgr[3]);
		const row = Number(sgr[4]);
		if (!Number.isFinite(button) || !Number.isFinite(col) || !Number.isFinite(row)) return null;
		return {
			length: sgr[0].length,
			raw: sgr[0],
			mouse: {
				encoding: sgr[1] === "?" ? "passive" : "sgr",
				button,
				col,
				row,
				action: sgr[5] === "m" ? "release" : button & 32 ? "move" : "press",
			},
		};
	}

	// X10/normal mouse: ESC [ M Cb Cx Cy. Cb is encoded as button + 32.
	if (input.startsWith("\x1b[M") && input.length >= 6) {
		const button = input.charCodeAt(3) - 32;
		return {
			length: 6,
			raw: input.slice(0, 6),
			mouse: {
				encoding: "x10",
				button,
				col: input.charCodeAt(4) - 32,
				row: input.charCodeAt(5) - 32,
				action: button & 32 ? "move" : "press",
			},
		};
	}
	return null;
}

/**
 * Parse a terminal mouse report.
 * Supports standard SGR (`CSI < ...`), passive SGR (`CSI ? ...`), and X10 mouse encodings.
 */
export function parseMouseEvent(data) {
	const parsed = parseMouseEventPrefix(data);
	return parsed && parsed.length === data.length ? parsed.mouse : null;
}

/**
 * Read a maximal run of concatenated mouse reports starting at `offset`. Returns the decoded events
 * with their exact raw byte sequences plus the consumed length, or null when no complete report
 * starts there.
 */
function parseMouseRun(data, offset = 0) {
	const events = [];
	let position = offset;
	for (;;) {
		const parsed = parseMouseEventPrefix(data, position);
		if (!parsed) break;
		events.push(parsed);
		position += parsed.length;
	}
	return events.length > 0 ? { events, length: position - offset } : null;
}

/**
 * Parse an input chunk that consists entirely of one or more concatenated mouse reports.
 * Returns each decoded event with its exact raw byte sequence, or null if any non-mouse
 * bytes are present in the chunk (all-or-nothing contract, pinned by unit tests and by the
 * X10 acceptance of issue #188 — do not relax it).
 */
export function parseMouseInputChunk(data) {
	if (!data) return null;
	const run = parseMouseRun(data);
	return run && run.length === data.length ? run.events : null;
}

/**
 * Issue #189: terminal *report* sequences, i.e. bytes the real terminal sends in answer to a query
 * instead of in answer to the user. Every query this stack forwards to the real terminal (child
 * OSC 11 probes, the host's colour batch, kitty protocol negotiation) is answered on the same stdin
 * stream the user types on, so a report is routinely coalesced with keys or mouse reports into one
 * read. Reports carry no user intent: they must reach the child unchanged, but they must not be
 * treated as typing (no selection clear, no viewport reset).
 *
 * Grounding of each pattern (pi-tui 1.x, the face this extension runs against):
 *  - focus in/out: DECSET 1004, enabled by pi's fullscreen TUI; reachable in regular mode only
 *    through leaked terminal state.
 *  - `CSI ? ... c`: DA1 reply — the host sends `\x1b[c` as the trailing sentinel of its colour
 *    batch (`pi-tui tui.js:57`).
 *  - `CSI ? ... u`: kitty keyboard flag reply to `\x1b[?u` (`pi-tui terminal.js:210`).
 *  - `CSI ? ... n`: mode/status reports, including the colour-scheme report `\x1b[?997;1n` that Pi
 *    parses (`pi-tui terminal-colors.js:19`).
 *  - `CSI ... t`: XTWINOPS replies — the host asks for the cell size with `\x1b[16t`
 *    (`pi-tui tui.js:603`) and consumes `CSI 6;h;wt`.
 *  - `OSC ... BEL|ST`: colour replies (OSC 10/11/12, OSC 4) and other reply bodies such as the
 *    program-status reply (OSC 7501); bodies are capped at 4096 bytes like the query carry.
 *  - `CSI > ... c` (DA2) has **no** source in this stack — kept as a defensive extra only, because
 *    no keystroke encodes as a `>`-prefixed CSI.
 *
 * Deliberately NOT matched, because a keystroke can look like them: `CSI ... R` (cursor-position
 * report but also modifier-F3), any `u` final without the `?` prefix (kitty key events),
 * `CSI ... $ y` (DECRPM — nothing in this stack queries modes), and DCS replies (no in-repo DCS
 * query). Unrecognised bytes keep today's keyboard semantics.
 */
const REPORT_PREFIXES = [
	/^\x1b\[[IO]/,
	/^\x1b\[\?\d+(?:;\d+)*c/,
	/^\x1b\[>\d+(?:;\d+)*c/,
	/^\x1b\[\?\d+(?:;\d+)*u/,
	/^\x1b\[\?\d+(?:;\d+)*n/,
	/^\x1b\[\d+(?:;\d+)*t/,
	/^\x1b\][^\x07\x1b]{0,4096}(?:\x07|\x1b\\)/,
];

/** Issue #189: the complete report sequence starting at `offset`, or null. */
function parseReportPrefix(data, offset = 0) {
	const input = data.slice(offset);
	for (const pattern of REPORT_PREFIXES) {
		const match = pattern.exec(input);
		if (match) return match[0];
	}
	return null;
}

/** Issue #189: the maximal run of concatenated report sequences at `offset`, or null. */
function parseReportRun(data, offset = 0) {
	let position = offset;
	for (;;) {
		const report = parseReportPrefix(data, position);
		if (!report) break;
		position += report.length;
	}
	return position > offset ? data.slice(offset, position) : null;
}

/** Merge a segment into the previous one when it has the same kind, else append it. */
function pushSegment(segments, segment) {
	const last = segments[segments.length - 1];
	if (last && last.kind === segment.kind) {
		if (last.kind === "mouse") last.events.push(...segment.events);
		else last.data += segment.data;
		return;
	}
	segments.push(segment);
}

/**
 * Issue #189: split one input read into ordered segments so the attach surface can dispatch per
 * kind instead of all-or-nothing. Mouse reports, terminal reports and everything else are returned
 * in arrival order, consecutive segments of the same kind merged.
 *
 * A partial escape sequence (a sequence split across reads) is not recognised and becomes keyboard
 * text — the same bytes the all-or-nothing parser used to forward.
 *
 * @param {string} data
 * @returns {Array<{kind: "mouse", events: Array<{length: number, raw: string, mouse: {encoding: string, button: number, col: number, row: number, action: string}}>} | {kind: "report", data: string} | {kind: "key", data: string}>}
 */
export function splitAttachInput(data) {
	if (!data) return [];
	const segments = [];
	let offset = 0;
	while (offset < data.length) {
		const mouse = parseMouseRun(data, offset);
		if (mouse) {
			pushSegment(segments, { kind: "mouse", events: mouse.events });
			offset += mouse.length;
			continue;
		}
		const report = parseReportRun(data, offset);
		if (report) {
			pushSegment(segments, { kind: "report", data: report });
			offset += report.length;
			continue;
		}
		// Neither a mouse report nor a terminal report: keyboard text up to the next escape.
		const next = data.indexOf("\x1b", offset + 1);
		const end = next === -1 ? data.length : next;
		pushSegment(segments, { kind: "key", data: data.slice(offset, end) });
		offset = end;
	}
	return segments;
}

/**
 * Issue #167: map a normalized pi-tui mouse event on the attach surface to an
 * action. "paste-primary" = middle-click paste (read X11 PRIMARY, forward as
 * input); null = not ours, the event falls through untouched (pi's fullscreen
 * selection, the wheel defer path, and everything else keep working). Pure by
 * contract: the env flag is resolved at the call site, never read here.
 */
export function resolveAttachMouseAction(event, { nativePasteEnabled }) {
	if (!nativePasteEnabled) return null;
	if (event.type === "press" && event.button === "middle") return "paste-primary";
	return null;
}

/**
 * Issue #174 (C): which X11 selection buffer middle-click paste reads.
 * "primary" = classic X11 middle-click semantics (default); "clipboard" =
 * escape hatch for environments where PRIMARY never updates (e.g. WSLg).
 * Unknown or unset values fall back to "primary". Pure: the raw env value is
 * read at the call site.
 */
export function resolvePasteSelectionSource(value) {
	return typeof value === "string" && value.trim().toLowerCase() === "clipboard" ? "clipboard" : "primary";
}

/**
 * Issue #174 (B2): whether a normalized mouse event ends a selection gesture
 * we should mirror into the X11 PRIMARY selection. Only release/click of the
 * left button with native paste enabled (pi's fullscreen selection owns the
 * gesture; we observe without consuming). Pure by contract.
 */
export function shouldMirrorSelectionToPrimary(event, { nativePasteEnabled }) {
	if (!nativePasteEnabled) return null;
	if ((event.type === "release" || event.type === "click") && event.button === "left") return "mirror-primary";
	return null;
}

/**
 * Issue #169: whether the attach surface should manage the OUTER terminal's
 * mouse mode. Only in regular TUI mode — in fullscreen, TuiAltScreen owns
 * mouse reporting (asserted once at startup, never re-asserted), so any write
 * from the attach surface can only downgrade or kill it. Old runtimes without
 * tui.mode behave as regular. Pure: both arguments are resolved at the call
 * site (mode from the TUI, the flag from the env-derived helper).
 */
export function shouldOwnOuterMouseMode(mode, mouseEnabled) {
	return mode !== "fullscreen" && !!mouseEnabled;
}

/**
 * Return +1 for wheel-up (scroll back), -1 for wheel-down, 0 for non-wheel input.
 * Supports standard/passive SGR and X10/normal mouse encodings.
 */
export function mouseWheelDirection(data) {
	const mouse = parseMouseEvent(data);
	if (!mouse || (mouse.button & 64) === 0) return 0;
	const wheelButton = mouse.button & 3;
	if (wheelButton === 0) return 1;
	if (wheelButton === 1) return -1;
	return 0; // horizontal wheel: ignore
}

/**
 * Issue #173 follow-up: translate a normalized pi-tui wheel event into the attach
 * viewport's line convention.
 *
 * pi-tui reports `wheelDelta` as logical lines where *negative scrolls up* (the SGR
 * wheel-up button decodes to direction -1), while `scrollViewportTop`/`tryScrollBy`
 * take a positive `linesUp`. The renderer's `routeWheel` fallback only moves real
 * `ScrollView` components, and the attach viewport paints its own xterm scrollback
 * instead — so a wheel event we hand back unconsumed scrolls nothing at all and the
 * fullscreen wheel goes dead.
 *
 * Returns 0 for non-wheel events and for a missing, non-finite, or zero delta, so
 * callers can fall through to pi's own handling.
 *
 * @param {{type?: string, wheelDelta?: number}|null|undefined} event
 * @returns {number}
 */
export function wheelScrollLinesUp(event) {
	if (!event || event.type !== "wheel") return 0;
	const delta = Number(event.wheelDelta);
	if (!Number.isFinite(delta) || delta === 0) return 0;
	return -delta;
}

/**
 * Compute the next local PTY viewport after a scroll gesture.
 *
 * `viewportTop === null` means follow bottom. `changed` reports whether the gesture
 * would visibly move the local scrollback viewport; callers can forward unconsumed
 * scroll keys/wheel events to the hosted TUI instead.
 */
export function scrollViewportTop(viewportTop, bottom, linesUp) {
	const safeBottom = Math.max(0, Math.floor(bottom));
	const current = viewportTop == null ? safeBottom : clampInt(viewportTop, 0, safeBottom);
	const next = clampInt(current - linesUp, 0, safeBottom);
	return {
		viewportTop: next >= safeBottom ? null : next,
		changed: next !== current,
	};
}

/**
 * Decide whether drag-selecting at/just beyond the viewport edge should auto-scroll.
 * Positive values scroll up into older output; negative values scroll down.
 */
export function selectionDragScrollLines(row, bodyHeight) {
	const safeHeight = Math.max(1, Math.floor(bodyHeight));
	const topRow = 2;
	const bottomRow = topRow + safeHeight - 1;
	const pointerRow = Math.floor(row);
	if (pointerRow < topRow) return 2;
	if (pointerRow === topRow) return 1;
	if (pointerRow > bottomRow) return -2;
	if (pointerRow === bottomRow) return -1;
	return 0;
}

/**
 * Return a safe temporary PTY size for an attach jiggle hold. The attach controller
 * keeps the child at this size until a clear or guard restores the original size;
 * near the minimum supported dimensions, only one safe dimension is changed, and
 * at 20x5 there is no valid alternate size.
 */
export function resizeJiggleSize(cols, rows) {
	const c = Math.max(1, Math.floor(cols));
	const r = Math.max(1, Math.floor(rows));
	if (c > 21 && r > 6) return { cols: c - 1, rows: r - 1 };
	if (r > 6) return { cols: c, rows: r - 1 };
	if (c > 21) return { cols: c - 1, rows: r };
	return null;
}
