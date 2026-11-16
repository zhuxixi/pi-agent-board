/**
 * Title-generation orchestration with fully injected effects (issue #295).
 * The runner shell owns env resolution and real I/O; this module owns
 * sequencing and the write-back guard so it is unit-testable with a fake clock.
 */
import { firstSubstantiveUserPrompt, isGreetingPrompt, normalizeGeneratedTitle } from "./title.mjs";

/** Default poll interval while waiting for a substantive user message. */
export const TITLE_POLL_INTERVAL_MS = 15_000;

/** Default total budget for the greeting poll loop. */
export const TITLE_POLL_BUDGET_MS = 300_000;

/**
 * @typedef {Object} TitleFlowDeps
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(root: string, viewId: string) => any|null} readMeta
 * @property {(meta: any) => void} commitMeta
 * @property {(config: any) => string|null} readSessionText
 * @property {(prompt: string) => Promise<string|null>} runOneShot
 */

/**
 * Generate a title for a view. Non-greeting prompts generate immediately
 * (today's behavior). Greeting prompts poll the session file for the first
 * substantive user message until the budget runs out, then exit quietly.
 * @param {import("./types.mjs").TitleConfig} config
 * @param {TitleFlowDeps} deps
 */
export async function runTitleFlow(config, deps) {
	if (!isGreetingPrompt(config.prompt)) {
		await generateOnce(config, deps, config.prompt);
		return;
	}
	const interval = config.pollIntervalMs ?? TITLE_POLL_INTERVAL_MS;
	const deadline = deps.now() + (config.pollBudgetMs ?? TITLE_POLL_BUDGET_MS);
	while (deps.now() < deadline) {
		await deps.sleep(interval);
		const text = deps.readSessionText(config);
		const prompt = text ? firstSubstantiveUserPrompt(text) : null;
		if (prompt) {
			await generateOnce(config, deps, prompt);
			return;
		}
	}
}

/**
 * One guarded title generation: last-line extraction, normalize, fallback-only
 * write (manual renames always win — meta is re-read right before the guard).
 * @param {import("./types.mjs").TitleConfig} config
 * @param {TitleFlowDeps} deps
 * @param {string} prompt
 */
async function generateOnce(config, deps, prompt) {
	const out = await deps.runOneShot(prompt);
	const last = out?.trim().split("\n").slice(-1)[0]?.trim() ?? "";
	const title = normalizeGeneratedTitle(last, config.fallbackName);
	if (!title || title === config.fallbackName) return;
	const meta = deps.readMeta(config.root, config.viewId);
	if (!meta) return;
	if (meta.name !== config.fallbackName) return;
	meta.name = title;
	deps.commitMeta(meta);
}
