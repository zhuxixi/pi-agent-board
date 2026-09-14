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

/**
 * Whether a buffer line may be trusted as Pi's editor line (issue #103).
 *
 * Pi paints the editor caret as a single inverse cell and, on an empty editor,
 * nothing else on that line; older variants prefix a prompt glyph. Chat-area
 * content is NOT distinguishable by attributes alone — diff rows and
 * notification bars also carry inverse cells — so "the line has an inverse
 * cell" can never be the anchor criterion by itself. A line that fails this
 * guard is skipped and the scan continues upward; when nothing qualifies the
 * caller escapes (detaches) rather than trapping the user (issues #48/#69/#72).
 * @param {{ text: string, inverseCellCount: number }} line
 * @returns {boolean}
 */
export function isEditorAnchorLine({ text, inverseCellCount }) {
	if (!(inverseCellCount > 0)) return false;
	if (inverseCellCount === 1 && isProbablyEmptyPiInputLine(text)) return true;
	return isProbablyPiInputLine(text);
}

/**
 * Resolve the ← detach gate's emptiness signal: when the child Pi pushes its
 * authoritative editor state (boolean), it wins; when it is unknown (null/
 * undefined — child extension missing or socket never connected), fall back
 * to the render heuristic.
 * @param {boolean | null | undefined} editorEmpty
 * @param {boolean} heuristic
 * @returns {boolean}
 */
export function resolveEditorEmpty(editorEmpty, heuristic) {
	return editorEmpty === null || editorEmpty === undefined ? heuristic : editorEmpty;
}
