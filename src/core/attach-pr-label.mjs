/**
 * Label the winning persisted PR/MR reference for the attach header. Issue-only
 * references and malformed numbers never become a session title badge.
 * @param {import("./types.mjs").CodeRefsSummary|null|undefined} summary
 * @returns {string}
 */
export function attachPrLabel(summary) {
	const pr = summary?.pr;
	if (pr?.kind !== "pr" || !Number.isSafeInteger(pr.number) || pr.number <= 0) return "";
	const isMr = summary.provider === "gitlab" || summary.prPrefix === "!";
	return `${isMr ? "MR !" : "PR #"}${pr.number}`;
}
