import { Key, matchesKey } from "@earendil-works/pi-tui";

/**
 * Issue #147: key resolution for the in-attach delete gesture. Pure — never
 * reads socket/connection/editor state, so the gesture works even while the
 * host is down. Second ctrl+x is swallowed (cancel-swallow, user adjudication
 * 2026-10-10): the chord is a confirm toggle here, and forwarding it would
 * inject one message.copy into the child Pi.
 * @param {{ confirmArmed: boolean }} state
 * @param {string} data raw key chunk
 * @returns {{ action: "arm" | "confirm" | "cancel" | "cancel-swallow" | "forward", confirmArmed: boolean }}
 */
export function resolveAttachDeleteKey(state, data) {
	if (matchesKey(data, Key.ctrl("x"))) {
		return state.confirmArmed ? { action: "cancel-swallow", confirmArmed: false } : { action: "arm", confirmArmed: true };
	}
	if (state.confirmArmed) {
		if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
			return { action: "confirm", confirmArmed: false };
		}
		return { action: "cancel", confirmArmed: false };
	}
	return { action: "forward", confirmArmed: false };
}
