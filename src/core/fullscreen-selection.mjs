import { isFullscreenSelectionEnd } from "./pty-scroll.mjs";

/**
 * @typedef {Object} FullscreenSelectionSettlerOptions
 * @property {{ getActiveSelectionText?: () => string | undefined, getCopyOnSelect?: () => boolean, clearTextSelection?: () => void }} host - The TuiAltScreen-shaped seam (see the header note); every access is feature-detected.
 * @property {(text: string) => void} [mirror] - X11 PRIMARY write (attach supplies it; the board omits it).
 * @property {() => void} [repaint] - One repaint after a successful clear.
 * @property {(cb: () => void) => void} [schedule] - Deferral transport; defaults to process.nextTick (issue #174).
 * @property {() => boolean} [shouldSettle] - Runtime lifecycle gate, checked inside the deferred callback.
 */

/**
 * Issue #258 (+ #172/#174 refactor): one place that settles pi's fullscreen
 * selection after copy-on-select, so the attach overlay and the board cannot
 * drift. All I/O is injected (repo convention: pure/testable core, thin shell).
 *
 * host: the TuiAltScreen-shaped seam — getActiveSelectionText /
 *   clearTextSelection are private in pi-tui typings (runtime plain methods),
 *   getCopyOnSelect is public. Every access is feature-detected so an older or
 *   newer pi-tui degrades to the pre-settle behaviour instead of throwing.
 * mirror: attach passes its X11 PRIMARY write (self-gated on
 *   AGENT_BOARD_ATTACH_NATIVE_PASTE inside writePrimarySelection); the board omits it.
 * repaint: schedules one repaint after a successful clear.
 * schedule: deferral transport, defaults to process.nextTick — overlays are
 *   dispatched BEFORE TuiAltScreen finalizes and copies the selection, so the
 *   settle must run after that event completes (issue #174).
 * shouldSettle: runtime lifecycle gate — checked inside the deferred callback
 *   before any host read. attach passes () => !this.closed; the board passes
 *   () => !this.disposed. The gesture serial cannot cover unmount/close: it
 *   only grows on presses this component still observes.
 *
 * @param {FullscreenSelectionSettlerOptions} [options]
 * @returns {{ observeMouse(event: unknown): void }} Observe-only mouse listener; selection endings queue one deferred settle.
 */
export function createFullscreenSelectionSettler({ host, mirror, repaint, schedule = (cb) => process.nextTick(cb), shouldSettle } = {}) {
	let serial = 0;
	const settle = () => {
		if (typeof shouldSettle === "function" && !shouldSettle()) return;
		const text = host.getActiveSelectionText?.();
		if (typeof text !== "string" || text.length === 0) return;
		if (mirror) mirror(text);
		if (host.getCopyOnSelect?.() === false) return;
		if (typeof host.clearTextSelection !== "function") return;
		host.clearTextSelection();
		repaint?.();
	};
	return {
		/** Observe only — never consumes; callers return undefined for these events. */
		observeMouse(event) {
			if (!event || typeof event !== "object") return;
			if (event.type === "press" && event.button === "left") serial += 1;
			if (!isFullscreenSelectionEnd(event)) return;
			const captured = serial;
			schedule(() => {
				if (captured !== serial) return;
				settle();
			});
		},
	};
}
