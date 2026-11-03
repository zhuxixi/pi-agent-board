import { Key, matchesKey } from "@earendil-works/pi-tui";

/**
 * Issue #266: the attach view's unconditional detach chords. Pure — no
 * component state, no socket, no editor cache: a chord is exit intent or it is
 * forwarded. Callers must run the #147 delete-confirm resolver first, so an
 * armed confirm still cancels before the chord closes the surface.
 *
 * - `ctrl+\` (raw 0x1c) — the terminal-independent escape (issue #126): one raw
 *   ASCII byte every terminal forwards unchanged in raw mode; the kitty CSI-u
 *   and modifyOtherKeys encodings of the same chord match too.
 * - `ctrl+left` — unambiguous intent while a draft sits in the editor
 *   (issue #89); a single ← stays gated on the pushed editorEmpty channel.
 * - `alt+h` — vim's h is "left" (issue #266). The bare letter must keep
 *   reaching the child editor, so the chord is the modified key; a segment
 *   that coalesces the chord with other bytes does not match and is forwarded
 *   unchanged.
 * @param {string} data one key segment from splitAttachInput
 * @returns {boolean}
 */
export function resolveAttachDetachChord(data) {
	return (
		matchesKey(data, "ctrl+\\") ||
		matchesKey(data, Key.ctrl("left")) ||
		matchesKey(data, Key.alt("h"))
	);
}
