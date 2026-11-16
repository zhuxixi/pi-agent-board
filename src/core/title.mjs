/** Title-generation helpers for session names. */

/** Default cheap model for session titles. Override via $AGENT_BOARD_TITLE_MODEL. */
export const DEFAULT_TITLE_MODEL = "openai-codex/gpt-5.5";

/** Default thinking level for session titles. Override via $AGENT_BOARD_TITLE_THINKING_LEVEL. */
export const DEFAULT_TITLE_THINKING_LEVEL = "low";

/**
 * Prompt for a short session title derived from the user's initial task.
 * @param {string} taskPrompt
 */
export function titlePrompt(taskPrompt) {
	return [
		"Write a concise title for this coding task.",
		"Rules:",
		"- 3 or 4 words max",
		"- plain text only",
		"- no quotes",
		"- no markdown",
		"- describe the task, not the format",
		"",
		`Task: ${String(taskPrompt || "").trim()}`,
	].join("\n");
}

/**
 * Normalize a model-generated title into a compact dashboard label.
 * @param {string|null|undefined} text
 * @param {string} fallback
 * @param {number} [maxWords]
 */
export function normalizeGeneratedTitle(text, fallback, maxWords = 4) {
	const cleaned = String(text || "")
		.replace(/^\s*(title\s*:\s*)?/i, "")
		.replace(/^['"`\-–—•*\s]+|['"`\-–—•*\s]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return fallback;
	const words = cleaned.split(/\s+/).filter(Boolean).slice(0, maxWords);
	const compact = words.join(" ").replace(/[.,;:!?]+$/g, "").trim();
	return compact || fallback;
}

/** Characters stripped from the edges of a message before greeting matching. */
const GREETING_EDGE_PUNCT = "！!？?。.,，、~～…;；:：";

/** Multi-word/multi-char greeting vocabulary (greedy longest-match units). */
const GREETINGS = [
	"good morning", "good afternoon", "good evening", "good day",
	"hello", "hi", "hey", "hiya", "yo", "sup", "howdy", "greetings", "morning",
	"你好", "您好", "嗨", "哈喽", "哈啰", "在吗", "在么",
	"早上好", "上午好", "早安", "下午好", "晚上好", "晚安",
];

/** Particles that may only appear after a greeting unit (suffix fillers). */
const GREETING_PARTICLES = ["there", "呀", "啊", "哦"];

const GREETING_SEPARATOR = new Set([" ", ...GREETING_EDGE_PUNCT.split("")]);

// Length-sorted match pools, precomputed once so longestUnitAt does not re-sort per position.
const GREETINGS_BY_LENGTH = [...GREETINGS].sort((a, b) => b.length - a.length);
const UNITS_BY_LENGTH = [...GREETINGS, ...GREETING_PARTICLES].sort((a, b) => b.length - a.length);

/**
 * True iff the ENTIRE message is greeting material: a greeting-first greedy
 * longest-match consume over the normalized string (issue #295). The first
 * consumed unit must be a GREETINGS entry; later units may be GREETINGS or
 * particles; adjacent duplicates need no separator.
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function isGreetingPrompt(text) {
	const normalized = String(text ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(new RegExp(`^[${escapeForCharClass(GREETING_EDGE_PUNCT)} ]+|[${escapeForCharClass(GREETING_EDGE_PUNCT)} ]+$`, "g"), "");
	if (!normalized) return false;
	let i = 0;
	let consumedGreeting = false;
	let first = true;
	while (i < normalized.length) {
		if (GREETING_SEPARATOR.has(normalized[i])) {
			i++;
			continue;
		}
		const unit = longestUnitAt(normalized, i, first);
		if (!unit) return false;
		if (unit.fromGreetings) consumedGreeting = true;
		first = false;
		i += unit.text.length;
	}
	return consumedGreeting;
}

/** @param {string} s @param {number} i @param {boolean} first */
function longestUnitAt(s, i, first) {
	const sorted = first ? GREETINGS_BY_LENGTH : UNITS_BY_LENGTH;
	for (const candidate of sorted) {
		if (s.startsWith(candidate, i)) return { text: candidate, fromGreetings: GREETINGS.includes(candidate) };
	}
	return null;
}

/** @param {string} chars */
function escapeForCharClass(chars) {
	return chars.replace(/[\\\]^-]/g, "\\$&");
}
