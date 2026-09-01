/** Helpers for deciding whether local attach shortcuts should be handled. */

/**
 * Best-effort detection of Pi's empty prompt/input line from projected terminal text.
 * The attach surface must not steal editing keys (notably ←) while the child Pi editor
 * contains text. Pi renders empty editor lines with prompt/continuation glyphs such as
 * `›`, `┃`, or `│`; once user text is present, non-prompt content remains after this trim.
 * @param {string} line
 * @returns {boolean}
 */
export function isProbablyEmptyPiInputLine(line) {
	const withoutRightPadding = String(line || "").replace(/[\s\u00a0]+$/u, "");
	const content = withoutRightPadding.replace(/^[\s\u00a0›>┃│|┆╎╏:]+/u, "");
	return content.length === 0;
}

/** Glyphs Pi uses to render editor prompt / continuation lines (`>` main prompt,
 * `›`/`┃`/`│` and variants in older releases). Must stay in sync with the
 * trim charset of isProbablyEmptyPiInputLine below. */
const PROMPT_GLYPHS = "›>┃│|┆╎╏:";

/**
 * Whether the given terminal line looks like a Pi editor input line: leading
 * whitespace followed by a prompt/continuation glyph. The attach surface uses
 * this to locate the editor line inside the buffer instead of trusting the
 * terminal cursor, which wanders onto output/working lines while Pi streams
 * (issue #66).
 * @param {string} line
 * @returns {boolean}
 */
export function isProbablyPiInputLine(line) {
	const withoutLeftPadding = String(line || "").replace(/^[\s\u00a0]+/u, "");
	return withoutLeftPadding.length > 0 && PROMPT_GLYPHS.includes(withoutLeftPadding[0]);
}
