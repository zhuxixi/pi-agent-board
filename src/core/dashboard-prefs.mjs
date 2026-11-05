/** Dashboard-only display preferences; never changes session state. */
import { join } from "node:path";
import { atomicWriteJson, readJson } from "./atomic.mjs";
import { GROUP_ORDER } from "./types.mjs";

/**
 * Keep only known section states, in display order, without duplicates.
 * @param {unknown} value
 * @returns {import("./types.mjs").SemanticState[]}
 */
export function normalizeFoldedSections(value) {
	if (!Array.isArray(value)) return [];
	return GROUP_ORDER.filter((state) => value.includes(state));
}

/** @param {string} root @returns {import("./types.mjs").SemanticState[]} */
export function readFoldedSections(root) {
	const prefs = readJson(join(root, "dashboard-prefs.json"), null);
	return normalizeFoldedSections(prefs?.foldedSections);
}

/**
 * @param {string} root
 * @param {Iterable<import("./types.mjs").SemanticState>} states
 */
export function saveFoldedSections(root, states) {
	atomicWriteJson(join(root, "dashboard-prefs.json"), {
		version: 1,
		foldedSections: normalizeFoldedSections([...states]),
	});
}
