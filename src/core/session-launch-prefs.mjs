import { activeBranchEntries, parseSessionEntries } from "./session-entries.mjs";

/**
 * Pure launch-prefs policy (issue #286): decide per dimension whether an
 * explicit --model / --thinking flag must be passed when spawning a child pi,
 * or whether the flag must be omitted so pi restores the session's own last
 * selection (pi only restores a dimension when no explicit flag is given).
 *
 * Mirrors pi 1.5.0 createAgentSession's restore gates on the normal path:
 * - model restores when the branch has >=1 message entry AND (a model_change
 *   entry OR an assistant message entry);
 * - thinking restores (to the session's own value) only when the branch has a
 *   thinking_level_change entry (otherwise pi would restore the SETTINGS
 *   default, not the view's defaultThinking — keep passing the explicit flag).
 * Pure policy: no fs, no clock. The caller owns reading the session file.
 * @param {{ model: string|null, thinkingLevel: string|null }} defaults view launch defaults (meta.defaultModel/defaultThinking)
 * @param {string|null} text raw session JSONL, or null when unreadable/missing
 */
export function resolveLaunchModelPrefs(defaults, text) {
	const model = defaults?.model ?? null;
	const thinkingLevel = defaults?.thinkingLevel ?? null;
	let droppedModel = false;
	let droppedThinking = false;

	if (text) {
		const { entries, byId } = parseSessionEntries(text);
		const branch = activeBranchEntries(entries, byId);
		const hasMessage = branch.some((e) => e.type === "message");
		if (hasMessage) {
			const modelRestorable = branch.some(
				(e) => e.type === "model_change" || (e.type === "message" && e.message?.role === "assistant"),
			);
			const thinkingRestorable = branch.some((e) => e.type === "thinking_level_change");
			droppedModel = modelRestorable && model !== null;
			droppedThinking = thinkingRestorable && thinkingLevel !== null;
		}
	}

	return {
		model: droppedModel ? null : model,
		thinkingLevel: droppedThinking ? null : thinkingLevel,
		droppedModel,
		droppedThinking,
	};
}
