/**
 * IME cursor-rect flicker fix (issue #28).
 *
 * pi-tui's doRender() emits each frame as separate terminal.write() calls:
 *
 *   1. ESC[?2026h ...content... ESC[?2026l   (differential/full frame, sync block)
 *   2. ESC[<n>A/B ESC[<col>G                  (positionHardwareCursor park write)
 *   3. ESC[?25l                               (hideCursor - bypasses write())
 *
 * The park sequences sit OUTSIDE the synchronized-output block. Terminals that
 * honor ?2026 (WezTerm et al.) present a frame and report the IME cursor
 * rectangle at each ?2026l boundary, so every frame produces two cursor-rect
 * reports at different positions (diff-write end vs parked input line) and the
 * IME candidate window bounces at frame rate. E2E measured on WezTerm + fcitx5:
 * ~20 position changes / 4s with the split writes, 0 with the park inside the
 * block (see issue #28 for the full experiment).
 *
 * This module wraps a Terminal instance's write/hideCursor/showCursor at runtime
 * and folds the out-of-block park/hide sequences back INSIDE the frame's sync
 * block, re-emitting the frame as a single write. Content is byte-identical up
 * to reordering of the trailing ?2026l; nothing is dropped or added.
 *
 * Safety properties (issue #28):
 * - No match -> passthrough: any write that isn't a pure cursor-park/hide
 *   sequence flushes the held frame unchanged first, preserving byte order.
 * - The three writes happen inside one synchronous doRender() stack, so a
 *   process.nextTick flush is enough to see them all; the added latency is
 *   sub-millisecond.
 * - Uninstall restores the original methods; a WeakMap makes overlapping
 *   installs on the same terminal refcounted and idempotent.
 * - Kill switch: AGENT_BOARD_IME_FIX=0 disables installation entirely.
 *
 * If pi-tui ever folds positionHardwareCursor into the sync block upstream,
 * the "pure park sequence following a sync-end write" pattern stops matching
 * and this wrapper degrades to a passthrough (one buffered write per frame,
 * same bytes) - no behavior change.
 */

const ESC = String.fromCharCode(27);
/** ESC[?2026l - end of a synchronized-output block. */
const SYNC_END = ESC + "[?2026l";

/**
 * Cursor sequences positionHardwareCursor() emits after a frame: relative row
 * moves (ESC[<n>A / ESC[<n>B, n optional) and an absolute column set
 * (ESC[<col>G), plus the cursor visibility toggles (ESC[?25l/h). These are
 * the ONLY sequences safe to fold into the block - anything else (line clears,
 * absolute positioning, OSC/DCS queries, content) flushes the held frame.
 */
const PARK_SEQUENCE = new RegExp(
	"^(?:" + ESC + "\\[\\d*[AB]|" + ESC + "\\[\\d+G|" + ESC + "\\[\\?25[hl])*$",
);

/** True when a write ends a synchronized-output block (pi-tui frame writes do). */
export function endsWithSyncEnd(data) {
	return typeof data === "string" && data.endsWith(SYNC_END);
}

/** True when data is exclusively cursor park/visibility sequences (see above). */
export function isPureCursorParking(data) {
	return typeof data === "string" && data.length > 0 && PARK_SEQUENCE.test(data);
}

/** Insert seq just before the trailing SYNC_END of a held frame write. */
export function mergeIntoSyncBlock(held, seq) {
	return held.slice(0, held.length - SYNC_END.length) + seq + SYNC_END;
}

/** terminal -> active wrapper, so overlapping installs share one wrapper. */
const activeWrappers = new WeakMap();

/**
 * Each wrapTerminalWrites() call returns its own guarded handle: idempotent
 * per handle, refcounted across handles — the patch is torn down only when
 * the LAST caller uninstalls (CR round 1, issue-1).
 */
function refcountedUninstall(entry) {
	let done = false;
	return () => {
		if (done) return;
		done = true;
		entry.refs -= 1;
		if (entry.refs > 0) return;
		entry.teardown();
	};
}

/**
 * Patch write/hideCursor/showCursor on a terminal instance so each frame's
 * out-of-block park/hide sequences are folded into the frame's sync block and
 * emitted as one write. Returns an uninstall function (idempotent, drops the
 * patch when the last caller uninstalls).
 */
export function wrapTerminalWrites(terminal) {
	if (!terminal || typeof terminal.write !== "function" || typeof terminal.hideCursor !== "function" || typeof terminal.showCursor !== "function") {
		throw new Error("terminal must expose write/hideCursor/showCursor");
	}
	const existing = activeWrappers.get(terminal);
	if (existing) {
		existing.refs += 1;
		return refcountedUninstall(existing);
	}

	const original = {
		write: terminal.write.bind(terminal),
		hideCursor: terminal.hideCursor.bind(terminal),
		showCursor: terminal.showCursor.bind(terminal),
	};
	/** Frame write ending in SYNC_END, accumulating park/hide merges. */
	let held = null;
	let flushScheduled = false;

	const flush = () => {
		if (held === null) return;
		const out = held;
		held = null;
		original.write(out);
	};

	const scheduleFlush = () => {
		if (flushScheduled) return;
		flushScheduled = true;
		process.nextTick(() => {
			flushScheduled = false;
			flush();
		});
	};

	/** Fold a park/hide seq into the held frame, or emit it standalone. */
	const mergeOrEmit = (seq, directEmit) => {
		if (held !== null) {
			held = mergeIntoSyncBlock(held, seq);
			return;
		}
		directEmit();
	};

	terminal.write = (data) => {
		if (typeof data !== "string" || data.length === 0) {
			flush();
			original.write(data);
			return;
		}
		if (held !== null) {
			// Only a pure park/hide burst may join the held frame; anything
			// else means this isn't a doRender park tail - flush unchanged.
			if (isPureCursorParking(data)) {
				held = mergeIntoSyncBlock(held, data);
				return;
			}
			flush();
		}
		if (endsWithSyncEnd(data)) {
			held = data;
			scheduleFlush();
			return;
		}
		original.write(data);
	};

	terminal.hideCursor = () => mergeOrEmit(ESC + "[?25l", original.hideCursor);
	terminal.showCursor = () => mergeOrEmit(ESC + "[?25h", original.showCursor);

	const entry = { refs: 1, teardown: null };
	entry.teardown = () => {
		flush();
		terminal.write = original.write;
		terminal.hideCursor = original.hideCursor;
		terminal.showCursor = original.showCursor;
		activeWrappers.delete(terminal);
	};

	activeWrappers.set(terminal, entry);
	return refcountedUninstall(entry);
}

/**
 * Install the coalescer on a TUI's terminal. Never throws: on any surprise
 * (shape change upstream, kill switch) it returns null and behavior stays
 * exactly as today.
 */
export function installImeCursorCoalesce(tui) {
	if (process.env.AGENT_BOARD_IME_FIX === "0") return null;
	try {
		const terminal = tui && tui.terminal;
		if (!terminal || typeof terminal.write !== "function" || typeof terminal.hideCursor !== "function" || typeof terminal.showCursor !== "function") {
			return null;
		}
		return wrapTerminalWrites(terminal);
	} catch {
		return null;
	}
}
