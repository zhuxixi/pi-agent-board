/**
 * Decide whether the next attach repaint should force a full clear.
 *
 * The first attach paint always forces once so the previous dashboard/session surface
 * cannot ghost behind the overlay. Later paints stay differential unless a caller
 * explicitly requests a hard reset.
 */
export function nextAttachRender(firstPaint, force = false) {
	return {
		force: Boolean(force || firstPaint),
		firstPaint: false,
	};
}

/**
 * Attach output should repaint only after @xterm/headless finishes parsing the chunk.
 * Status/control messages can repaint immediately because they mutate header/overlay state.
 */
export function shouldScheduleAttachRenderForMessage(type) {
	return type === "hello" || type === "status" || type === "exit" || type === "error";
}

export const ATTACH_OUTPUT_RENDER_INTERVAL_MS = 40;

/**
 * Resolve the PTY cursor to an ABSOLUTE buffer row for the projected window
 * [start, start + height). xterm's buffer cursorY is relative to baseY (the child
 * terminal's viewport top when scrolled to bottom), so the absolute row is
 * baseY + cursorY. Returns null when the cursor is outside the projected window
 * (e.g. the user scrolled up into history).
 *
 * The returned row must stay absolute: projection loops pass absolute buffer
 * indices (buf.getLine(i) for i in [start, end)) and mouse selection points are
 * absolute too. Returning a start-relative row only matches while start === 0;
 * once scrollback exists the cursor cell never matches, which silently drops the
 * visible PTY-cursor block AND the CURSOR_MARKER used to position the hardware
 * cursor for IME candidate windows.
 */
export function projectPtyCursor(buf, start, height) {
	if (typeof buf.cursorX !== "number" || typeof buf.cursorY !== "number" || buf.cursorX < 0 || buf.cursorY < 0) return null;
	const row = buf.baseY + buf.cursorY;
	if (row < start || row >= start + height) return null;
	return { row, col: buf.cursorX };
}

/**
 * Coalesce PTY parser callbacks into a bounded stream of repaint requests.
 *
 * node-pty commonly splits one child-TUI update across many small chunks. Rendering
 * after each @xterm/headless write callback exposes those intermediate frames and can
 * drive the outer TUI near its 60 fps limit. A trailing throttle keeps output live
 * while presenting only parsed snapshots at roughly 25 fps.
 */
export function createAttachOutputRenderScheduler(requestRender, delayMs = ATTACH_OUTPUT_RENDER_INTERVAL_MS) {
	let timer = null;
	let disposed = false;
	return {
		request() {
			if (disposed || timer) return;
			timer = setTimeout(() => {
				timer = null;
				if (!disposed) requestRender();
			}, delayMs);
			timer.unref?.();
		},
		dispose() {
			disposed = true;
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}

/**
 * Classify the PTY cursor's alignment for runtime desync detection (issue #11).
 *
 * Healthy idle pi: the child pi-tui parks the hardware cursor on the editor
 * marker, whose cell is the inverse-video "fake cursor" — so the cursor cell
 * itself is inverse. A desynced buffer leaves the cursor parked elsewhere
 * (typically where the last differential write ended), on a non-inverse cell.
 * Width-0 cells are CJK continuation cells and out-of-range columns sit past
 * the line's cells; in both cases the meaningful attribute lives on the
 * preceding cell, so we look left. Returns:
 *   "aligned"    — cursor resolves to an inverse cell (healthy);
 *   "misaligned" — cursor resolves to a non-inverse cell (candidate desync;
 *                  callers gate this with an output-quietness window);
 *   "unknown"    — no cursor (scrolled out of the projected viewport) or no
 *                  buffer line (defensive); never treat these as desync.
 */
export function detectCursorDesync(buf, cursor) {
	if (!cursor) return "unknown";
	const line = buf.getLine(cursor.row);
	if (!line) return "unknown";
	let x = cursor.col;
	let cell = line.getCell(x);
	while ((!cell || cell.getWidth() === 0) && x > 0) {
		x--;
		cell = line.getCell(x);
	}
	if (!cell) return "misaligned";
	return cell.isInverse() ? "aligned" : "misaligned";
}
