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

/**
 * Pick the editor anchor line out of the buffer's inverse-video lines.
 *
 * Pi draws the editor's fake cursor as exactly ONE inverse CHARACTER (an
 * inverse space on an empty line, an inverse glyph inside a draft). Chat-area
 * inverse content — diff hunks from renderDiff, the inverse notification
 * banner, search highlights — is always a multi-character run. That difference
 * is the discriminator, because the editor line is frequently absent from the
 * buffer entirely (differential frames skip unchanged lines), which is what
 * made the old "bottom-most inverse line wins" anchor read chat content as a
 * draft and swallow ← (issue #103).
 *
 * Candidates are scanned bottom-up; anything that is not a single inverse
 * character is chat content and is skipped rather than trusted. A glyph row
 * keeps the pre-existing semantics of scenarios B/B3. A blank non-glyph row is
 * the new-style fake cursor. A single-inverse-character row that carries text
 * but no glyph is the new-style draft line: R1 deliberately does NOT trust it,
 * so the escape chain still releases the user (spec §2.1).
 *
 * Count characters, not cells: wide glyphs occupy two cells but yield one
 * `getChars()` entry (`草` = 2 cells / 1 char), so a cell-based rule would skip
 * every CJK fake cursor and break draft protection.
 *
 * @param {Array<{ text?: string, inverseCharCount?: number }>} candidates bottom-up
 * @returns {{ empty: boolean } | null} null = no trusted editor line (fall through)
 */
export function pickEditorAnchorLine(candidates) {
	for (const candidate of candidates ?? []) {
		if (Number(candidate?.inverseCharCount ?? 0) !== 1) continue;
		const text = String(candidate?.text ?? "");
		if (isProbablyPiInputLine(text)) return { empty: isProbablyEmptyPiInputLine(text) };
		if (text.trim().length === 0) return { empty: true };
	}
	return null;
}
