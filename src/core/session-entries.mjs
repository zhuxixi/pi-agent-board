/**
 * Shared session-JSONL structure primitives — the single source of branch
 * semantics for everything agent-board reads out of a pi session file.
 * Extracted verbatim from session-view.mjs (issue #286); display code and
 * launch-prefs policy both consume these so they can never drift apart.
 *
 * The file is a tree: every entry has `id` + `parentId`; the active branch is
 * the root→leaf path ending at the last entry (pi's SessionManager.getBranch
 * picks the same leaf when no explicit leaf is recorded).
 */

/**
 * Parse raw JSONL text into a header plus a tree index.
 * Malformed lines, non-objects, and id-less entries are skipped.
 * @param {string} text
 * @returns {{ header: { id: string, cwd: string } | null, entries: any[], byId: Map<string, any> }}
 */
export function parseSessionEntries(text) {
	/** @type {{ id: string, cwd: string } | null} */
	let header = null;
	/** @type {any[]} */
	const entries = [];
	/** @type {Map<string, any>} */
	const byId = new Map();

	for (const rawLine of String(text || "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type === "session") {
			header = { id: String(entry.id || ""), cwd: String(entry.cwd || "") };
			continue;
		}
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
		entries.push(entry);
		byId.set(entry.id, entry);
	}

	return { header, entries, byId };
}

/**
 * Walk from the last entry to the root following parentId pointers.
 * Root→leaf order. A broken parentId ends the walk; a seen-set guards cycles.
 * @param {any[]} entries
 * @param {Map<string, any>} byId
 * @returns {any[]}
 */
export function activeBranchEntries(entries, byId) {
	if (!entries.length) return [];
	/** @type {any[]} */
	const out = [];
	const seen = new Set();
	let cur = entries[entries.length - 1];
	while (cur && typeof cur.id === "string" && !seen.has(cur.id)) {
		out.push(cur);
		seen.add(cur.id);
		cur = cur.parentId ? byId.get(cur.parentId) ?? null : null;
	}
	out.reverse();
	return out;
}
