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
		// Cb packs the button (bits 0-1), modifiers (2-4), motion (5) and wheel (6),
		// except bit value 3 in bits 0-1: the protocol's release code, which carries
		// no button identity. Decoding it as a press made the attach surface clear
		// the drag selection on release instead of copying it (issue #188). Wheel
		// reports never carry a release, so bit 6 keeps the press classification.
		const button = input.charCodeAt(3) - 32;
		const motion = (button & 32) !== 0;
		const wheel = (button & 64) !== 0;
		const release = !motion && !wheel && (button & 3) === 3;
		return {
			length: 6,
			raw: input.slice(0, 6),
			mouse: {
				encoding: "x10",
				button,
				col: input.charCodeAt(4) - 32,
				row: input.charCodeAt(5) - 32,
				action: release ? "release" : motion ? "move" : "press",
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
 * Issue #185: route a normalized wheel event (fullscreen handleMouse path) to the
 * surface that should scroll.
 *
 * "local" — scroll the attach's own xterm scrollback (normal buffer, where the
 * scrollback actually holds history). The caller still downgrades to "none"
 * itself when `tryScrollBy` cannot move: that decision needs the live viewport.
 * "child" — forward one synthesized SGR wheel report instead (alternate
 * buffer: xterm's alternate buffer keeps no scrollback, so the hosted child's
 * own viewport is the only thing that can scroll).
 * "none"  — leave the event to pi (kill switches, or an unusable delta).
 *
 * Pure by contract: `bufferType` is `this.term.buffer.active.type` at the call
 * site, `wheelLinesUp` comes from `wheelScrollLinesUp()`, and the switch state
 * is resolved by the caller.
 *
 * @param {{bufferType?: string, wheelLinesUp?: number, mouseEnabled?: boolean}|null|undefined} input
 * @returns {"local"|"child"|"none"}
 */
export function resolveAttachWheelRoute({ bufferType, wheelLinesUp, mouseEnabled } = {}) {
	if (!mouseEnabled || wheelLinesUp === 0) return "none";
	return bufferType === "alternate" ? "child" : "local";
}

/**
 * Issue #185: encode one synthesized SGR wheel report for the hosted child.
 *
 * `"up"` maps to button 64 and `"down"` to 65 — the plain report a terminal
 * sends for a wheel notch. Coordinates are 1-based child-screen cells (the
 * attach body rendered 1:1), floored and clamped to >= 1 so a malformed
 * coordinate can never produce an invalid report. One report per received
 * event: the child applies its own wheel acceleration, exactly as it would for
 * a real terminal.
 *
 * @param {"up"|"down"} direction
 * @param {{col?: number, row?: number}} coords
 * @returns {string}
 */
export function encodeWheelReport(direction, { col, row } = {}) {
	const button = direction === "up" ? 64 : 65;
	const cell = (v) => (Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1);
	return `\x1b[<${button};${cell(col)};${cell(row)}M`;
}

/**
 * Issue #205: history floor left behind by snapshot hydration.
 *
 * Hydrating a frame taller than the local terminal scrolls its top rows into the
 * local emulator's scrollback. The frame writes genuine scrollback rows first and the
 * viewport rows after them, so an overflowing hydrate lays the local buffer out as
 * `[genuine history][manufactured rows][viewport]`: the manufactured block does not sit
 * below the real history but between it and the viewport, and every local scroll
 * traverses it. No single floor can skip that block while keeping the older genuine
 * rows, so an overflow disables local history entirely rather than hiding the oldest
 * real rows. A hydrate that did not overflow leaves only real history above the
 * viewport, so the base is the floor. Unvalidated input (an older runner that sends no
 * `scrollbackLines`) degrades to the safe floor, never NaN. Pure by contract.
 *
 * @param {number} baseYAfter
 * @param {number|undefined} scrollbackLines
 * @returns {number}
 */
export function historyFloorAfterHydrate(baseYAfter, scrollbackLines) {
	const safeBase = Number.isFinite(baseYAfter) ? Math.max(0, Math.floor(baseYAfter)) : 0;
	const safeScrollback = Number.isFinite(scrollbackLines) ? Math.max(0, Math.floor(scrollbackLines)) : 0;
	// Issue #205: the frame writes genuine scrollback rows first and viewport rows after
	// them, so hydration that overflows puts the manufactured rows BETWEEN the genuine
	// history and the viewport — any local scroll necessarily traverses them. Disable
	// local history for that case rather than sacrificing the oldest genuine rows.
	// No overflow means every row above the viewport is real history.
	return safeBase > safeScrollback ? safeBase : 0;
}

/**
 * Issue #205: how many rows of the local buffer are genuine history.
 *
 * Everything below `historyFloor` is pseudo scrollback produced by hydration (see
 * `historyFloorAfterHydrate`); only the rows above it may answer a wheel notch. A
 * floor at or past the base clamps to no history. Pure by contract.
 *
 * @param {number} baseY
 * @param {number} historyFloor
 * @returns {number}
 */
export function scrollableHistoryLines(baseY, historyFloor) {
	const safeBase = Number.isFinite(baseY) ? Math.max(0, Math.floor(baseY)) : 0;
	const safeFloor = Number.isFinite(historyFloor) ? Math.max(0, Math.floor(historyFloor)) : 0;
	return Math.max(0, safeBase - Math.min(safeBase, safeFloor));
}

/**
 * Compute the next local PTY viewport after a scroll gesture.
 *
 * `viewportTop === null` means follow bottom. `changed` reports whether the gesture
 * would visibly move the local scrollback viewport; callers can forward unconsumed
 * scroll keys/wheel events to the hosted TUI instead. `floor` is the lowest reachable
 * row (issue #205): hydration can manufacture pseudo scrollback below it, which the
 * gesture must neither scroll to nor report as consumed. The default 0 keeps the
 * pre-floor behaviour for callers that have no hydration floor to enforce.
 */
export function scrollViewportTop(viewportTop, bottom, linesUp, floor = 0) {
	const safeBottom = Math.max(0, Math.floor(bottom));
	const safeFloor = clampInt(floor, 0, safeBottom);
	const current = viewportTop == null ? safeBottom : clampInt(viewportTop, safeFloor, safeBottom);
	const next = clampInt(current - linesUp, safeFloor, safeBottom);
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

/**
 * Issue #187: two mouse points are "the same" within the 1-cell coordinate slack
 * terminals report. Buffer-space comparison ({line, col}) — shared by double-click
 * detection. Moved here from pty-attach.ts so both comparisons have one definition.
 * Pure by contract.
 *
 * @param {{line: number, col: number}} a
 * @param {{line: number, col: number}} b
 * @returns {boolean}
 */
export function sameMousePoint(a, b) {
	return a.line === b.line && Math.abs(a.col - b.col) <= 1;
}

/**
 * Issue #187: two SCREEN cells are "the same" within the same 1-cell slack. Screen
 * space ({row, col}) is what the pointer actually did; buffer space drifts while a
 * session streams (the viewport base moves), which is why the drag/click decision must
 * not compare buffer points captured at two different moments. Pure by contract.
 *
 * @param {{row: number, col: number}} a
 * @param {{row: number, col: number}} b
 * @returns {boolean}
 */
export function sameScreenCell(a, b) {
	return a.row === b.row && Math.abs(a.col - b.col) <= 1;
}

/**
 * Issue #187: whether a mouse release ends a real selection drag. Terminals such as
 * Warp deliver a fast drag as press + release with zero motion events, so the move flag
 * alone is not sufficient — the gesture geometry decides. Both points are SCREEN cells
 * as reported by the terminal (never the clamped buffer point). Missing geometry (no
 * screen anchor recorded) degrades to the pre-fix answer: not a drag. Pure by contract.
 *
 * @param {{dragging: boolean, pressScreen: ({row: number, col: number}|undefined|null), releaseScreen: ({row: number, col: number}|undefined|null)}} input
 * @returns {boolean}
 */
export function selectionReleaseIsDrag({ dragging, pressScreen, releaseScreen }) {
	if (dragging) return true;
	if (!pressScreen || !releaseScreen) return false;
	return !sameScreenCell(pressScreen, releaseScreen);
}
