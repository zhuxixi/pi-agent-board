/**
 * Read and project a managed Pi session file into a simple display model for the
 * dashboard's non-interrupting session view.
 *
 * We show the current active branch only: starting from the last appended entry
 * (the active leaf in normal Pi append semantics), walk parentId links to root,
 * then render messages / visible custom messages / summaries on that branch.
 */
import { existsSync, readFileSync } from "node:fs";
import { activeBranchEntries, parseSessionEntries } from "./session-entries.mjs";

/**
 * @typedef {Object} SessionViewItem
 * @property {string} id
 * @property {"user"|"assistant"|"custom"|"note"} role
 * @property {string} label
 * @property {string} text
 * @property {string} timestamp
 * @property {string} entryType
 */

/**
 * @typedef {Object} SessionViewData
 * @property {{ id:string, cwd:string }|null} header
 * @property {SessionViewItem[]} items
 * @property {string|null} error
 */

/**
 * Load and parse one session file.
 * @param {string} sessionFile
 * @returns {SessionViewData}
 */
export function loadSessionView(sessionFile) {
	if (!sessionFile || !existsSync(sessionFile)) {
		return { header: null, items: [], error: "Session file not created yet." };
	}
	try {
		return parseSessionText(readFileSync(sessionFile, "utf8"));
	} catch (err) {
		return {
			header: null,
			items: [],
			error: `Couldn't read session: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Parse session JSONL into a displayable active branch.
 * @param {string} text
 * @returns {SessionViewData}
 */
export function parseSessionText(text) {
	const { header, entries, byId } = parseSessionEntries(text);
	if (entries.length === 0) return { header, items: [], error: null };
	const branch = activeBranchEntries(entries, byId);
	const items = branch.flatMap(displayItemsForEntry);
	return { header, items, error: null };
}

/**
 * @param {any} entry
 * @returns {SessionViewItem[]}
 */
function displayItemsForEntry(entry) {
	switch (entry?.type) {
		case "message": {
			const role = entry.message?.role;
			const text = contentText(entry.message?.content);
			if (!text) return [];
			if (role === "user") {
				return [{ id: entry.id, role: "user", label: "you", text, timestamp: String(entry.timestamp || ""), entryType: entry.type }];
			}
			if (role === "assistant") {
				return [{ id: entry.id, role: "assistant", label: "agent", text, timestamp: String(entry.timestamp || ""), entryType: entry.type }];
			}
			return [{ id: entry.id, role: "note", label: String(role || "message"), text, timestamp: String(entry.timestamp || ""), entryType: entry.type }];
		}
		case "custom_message": {
			if (entry.display === false) return [];
			const text = contentText(entry.content);
			if (!text) return [];
			return [{
				id: entry.id,
				role: "custom",
				label: String(entry.customType || "context"),
				text,
				timestamp: String(entry.timestamp || ""),
				entryType: entry.type,
			}];
		}
		case "branch_summary":
			return [{
				id: entry.id,
				role: "note",
				label: "branch summary",
				text: String(entry.summary || "").trim(),
				timestamp: String(entry.timestamp || ""),
				entryType: entry.type,
			}].filter((x) => x.text);
		case "compaction":
			return [{
				id: entry.id,
				role: "note",
				label: "compaction",
				text: String(entry.summary || "").trim(),
				timestamp: String(entry.timestamp || ""),
				entryType: entry.type,
			}].filter((x) => x.text);
		default:
			return [];
	}
}

/**
 * Convert Pi message/content blocks to plain text.
 * @param {any} content
 * @returns {string}
 */
function contentText(content) {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n")
		.trim();
}
