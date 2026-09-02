/**
 * Code-refs provider layer: per-platform regex rule bundles for extracting
 * issue/PR references from session evidence.
 *
 * A "provider" is pure data: one bundle of regex rules for a code platform
 * (GitHub, GitLab, or an internal/self-hosted platform defined by the user in
 * `<root>/providers.json`). User providers with the same name as a builtin are
 * append-merged: user rules run first, then builtin rules; scalar fields
 * (hosts/prefixes/urlTemplates) fall back to the builtin values when the user
 * does not set them.
 *
 * All functions here are pure (zero I/O) except `loadProviders`, the single
 * allowed I/O entry point, which reads `<root>/providers.json` through
 * `readJson` and caches the merged result by file mtime.
 */
import { statSync } from "node:fs";
import { readJson } from "./atomic.mjs";
import { providersPath } from "./paths.mjs";

/**
 * @typedef {Object} Provider
 * @property {string} name
 * @property {string[]} hosts  lowercase hosts this provider matches; [] = never matched by host
 * @property {string} issuePrefix
 * @property {string} prPrefix
 * @property {{issue?: string, pr?: string}|null} urlTemplates
 * @property {Rule[]} rules
 */

/**
 * @typedef {Object} Rule
 * @property {RegExp} regex  compiled from `pattern`, matched unanchored
 * @property {string} pattern
 * @property {"issue"|"pr"} kind
 * @property {"claim"|"action"|"view"} strength
 * @property {"capture"|"outputUrl"} numberFrom  "outputUrl" rules carry no capture group
 */

const VALID_KINDS = new Set(["issue", "pr"]);
const VALID_STRENGTHS = new Set(["claim", "action", "view"]);
const VALID_NUMBER_FROM = new Set(["capture", "outputUrl"]);

/** https://host[:port]/owner/repo(.git) */
const HTTPS_REMOTE_RE = /^https?:\/\/([^/:\s]+)(?::\d+)?\/(.+)$/;
/** git@host:owner/repo(.git) */
const SSH_REMOTE_RE = /^git@([^/:\s]+):(.+)$/;

/**
 * Lowercased host of a raw origin-remote URL, or null when it cannot be parsed.
 * Supports `https://host/owner/repo(.git)` and `git@host:owner/repo(.git)`; an
 * optional port is dropped.
 * @param {string|null} url
 * @returns {string|null}
 */
export function parseRemoteHost(url) {
	if (typeof url !== "string" || !url) return null;
	const match = HTTPS_REMOTE_RE.exec(url) ?? SSH_REMOTE_RE.exec(url);
	return match ? match[1].toLowerCase() : null;
}

/**
 * `owner/repo` path of a raw origin-remote URL (trailing `.git` stripped), or
 * null when it cannot be parsed. Supports the same https/ssh shapes as
 * `parseRemoteHost`; nested namespaces are kept (e.g. `group/sub/repo`).
 * @param {string|null} url
 * @returns {string|null}
 */
export function parseRemotePath(url) {
	if (typeof url !== "string" || !url) return null;
	const match = HTTPS_REMOTE_RE.exec(url) ?? SSH_REMOTE_RE.exec(url);
	if (!match) return null;
	const path = match[2].replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
	return path || null;
}

/**
 * Compile trusted rule specs into Rule objects. Throws on an invalid pattern;
 * only used for the builtin tables, which must stay valid.
 * @param {Array<{pattern: string, kind: "issue"|"pr", strength: "claim"|"action"|"view", numberFrom?: "capture"|"outputUrl"}>} specs
 * @returns {Rule[]}
 */
function compileRules(specs) {
	return specs.map((spec) => ({
		regex: new RegExp(spec.pattern),
		pattern: spec.pattern,
		kind: spec.kind,
		strength: spec.strength,
		numberFrom: spec.numberFrom ?? "capture",
	}));
}

const GITHUB_RULES = [
	{ pattern: "gh\\s+issue\\s+edit\\s+#?(\\d+)(?=[\\s\\S]*--add-assignee)", kind: "issue", strength: "claim" },
	{ pattern: "gh\\s+issue\\s+(?:comment|edit|close|reopen)\\s+#?(\\d+)", kind: "issue", strength: "action" },
	{ pattern: "gh\\s+issue\\s+create\\b", kind: "issue", strength: "action", numberFrom: "outputUrl" },
	{ pattern: "gh\\s+pr\\s+(?:checkout|merge|comment|review|close)\\s+#?(\\d+)", kind: "pr", strength: "action" },
	{ pattern: "gh\\s+pr\\s+create\\b", kind: "pr", strength: "action", numberFrom: "outputUrl" },
	{ pattern: "github\\.com/[\\w.-]+/[\\w.-]+/pull/(\\d+)", kind: "pr", strength: "action" },
	{ pattern: "gh\\s+issue\\s+view\\s+#?(\\d+)", kind: "issue", strength: "view" },
	{ pattern: "gh\\s+pr\\s+(?:view|diff|checks)\\s+#?(\\d+)", kind: "pr", strength: "view" },
	{ pattern: "github\\.com/[\\w.-]+/[\\w.-]+/issues/(\\d+)", kind: "issue", strength: "view" },
];

const GITLAB_RULES = [
	{ pattern: "glab\\s+issue\\s+(?:edit|update)\\s+#?(\\d+)(?=[\\s\\S]*--assignee)", kind: "issue", strength: "claim" },
	{ pattern: "glab\\s+issue\\s+(?:note|comment|close|reopen)\\s+#?(\\d+)", kind: "issue", strength: "action" },
	{ pattern: "glab\\s+mr\\s+(?:checkout|merge)\\s+!?(\\d+)", kind: "pr", strength: "action" },
	{ pattern: "glab\\s+mr\\s+create\\b", kind: "pr", strength: "action", numberFrom: "outputUrl" },
	{ pattern: "/-/merge_requests/(\\d+)", kind: "pr", strength: "action" },
	{ pattern: "glab\\s+issue\\s+view\\s+#?(\\d+)", kind: "issue", strength: "view" },
	{ pattern: "glab\\s+mr\\s+view\\s+!?(\\d+)", kind: "pr", strength: "view" },
	{ pattern: "/-/issues/(\\d+)", kind: "issue", strength: "view" },
];

const GENERIC_RULES = [
	{ pattern: "/issues/(\\d+)", kind: "issue", strength: "view" },
	{ pattern: "/pull/(\\d+)", kind: "pr", strength: "action" },
	{ pattern: "/-/issues/(\\d+)", kind: "issue", strength: "view" },
	{ pattern: "/-/merge_requests/(\\d+)", kind: "pr", strength: "action" },
];

/**
 * Builtin GitHub + GitLab provider bundles (fresh objects per call).
 * @returns {Provider[]}
 */
export function builtinProviders() {
	return [githubProvider(), gitlabProvider()];
}

/**
 * Host-agnostic fallback provider used when no provider matches the repo host:
 * URL-only rules for the common issue/PR URL shapes, `#` / `▸#` prefixes, no
 * urlTemplates. Fresh object per call.
 * @returns {Provider}
 */
export function genericFallbackProvider() {
	return {
		name: "generic",
		hosts: [],
		issuePrefix: "#",
		prPrefix: "▸#",
		urlTemplates: null,
		rules: compileRules(GENERIC_RULES),
	};
}

/** @returns {Provider} */
function githubProvider() {
	return {
		name: "github",
		hosts: ["github.com"],
		issuePrefix: "#",
		prPrefix: "▸#",
		urlTemplates: {
			issue: "https://{host}/{owner}/{repo}/issues/{number}",
			pr: "https://{host}/{owner}/{repo}/pull/{number}",
		},
		rules: compileRules(GITHUB_RULES),
	};
}

/** @returns {Provider} */
function gitlabProvider() {
	return {
		name: "gitlab",
		hosts: ["gitlab.com"],
		issuePrefix: "#",
		prPrefix: "!",
		urlTemplates: {
			issue: "https://{host}/{owner}/{repo}/-/issues/{number}",
			pr: "https://{host}/{owner}/{repo}/-/merge_requests/{number}",
		},
		rules: compileRules(GITLAB_RULES),
	};
}

/**
 * Validate one raw provider config from `providers.json`.
 *
 * `name` and `rules` are required; an invalid provider yields `provider: null`.
 * Individual invalid rules are skipped with an error message while valid rules
 * are kept. Optional scalar fields (hosts/issuePrefix/prPrefix/urlTemplates)
 * are validated but left unset when absent, so `mergeProviders` can tell "user
 * did not set this" from "user set a value" and fall back to builtin fields.
 * @param {any} raw
 * @returns {{provider: Provider|null, errors: string[]}}
 */
export function validateProvider(raw) {
	const errors = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { provider: null, errors: ["provider must be an object"] };
	}
	if (typeof raw.name !== "string" || !raw.name.trim()) {
		errors.push("provider name must be a non-empty string");
		return { provider: null, errors };
	}
	const name = raw.name.trim();
	if (!Array.isArray(raw.rules)) {
		errors.push(`provider "${name}": rules must be an array`);
		return { provider: null, errors };
	}
	/** @type {Rule[]} */
	const rules = [];
	raw.rules.forEach((rule, index) => {
		const compiled = validateRule(rule, index, name, errors);
		if (compiled) rules.push(compiled);
	});
	/** @type {Provider} */
	const provider = { name, rules };
	validateScalarFields(raw, name, provider, errors);
	return { provider, errors };
}

/**
 * Count capturing groups in a regex source string, ignoring escaped chars,
 * character classes, non-capturing groups, and lookaround groups.
 * @param {string} source
 * @returns {number}
 */
function countCaptureGroups(source) {
	let count = 0;
	let inClass = false;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (inClass) {
			if (ch === "]") inClass = false;
			continue;
		}
		if (ch === "[") {
			inClass = true;
			continue;
		}
		if (ch === "(") {
			if (source[i + 1] === "?") {
				// (?<name>...) is a named capturing group; (?<=, ?<! are lookbehind.
				if (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") count++;
			} else {
				count++;
			}
		}
	}
	return count;
}

/**
 * Compile and validate one raw rule; returns null (and records an error) when
 * any field is missing or invalid. The regex must compile and, for
 * `numberFrom: "capture"` rules, must contain at least one capture group for
 * the number.
 * @param {any} raw
 * @param {number} index
 * @param {string} providerName
 * @param {string[]} errors
 * @returns {Rule|null}
 */
function validateRule(raw, index, providerName, errors) {
	const where = `provider "${providerName}" rule ${index}`;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		errors.push(`${where}: must be an object`);
		return null;
	}
	const { pattern, kind, strength, numberFrom } = raw;
	if (typeof pattern !== "string" || !pattern) {
		errors.push(`${where}: missing pattern`);
		return null;
	}
	if (!VALID_KINDS.has(kind)) {
		errors.push(`${where}: kind must be "issue" or "pr"`);
		return null;
	}
	if (!VALID_STRENGTHS.has(strength)) {
		errors.push(`${where}: strength must be "claim", "action", or "view"`);
		return null;
	}
	if (numberFrom !== undefined && !VALID_NUMBER_FROM.has(numberFrom)) {
		errors.push(`${where}: numberFrom must be "capture" or "outputUrl"`);
		return null;
	}
	let regex;
	try {
		regex = new RegExp(pattern);
	} catch (e) {
		errors.push(`${where}: invalid regex "${pattern}": ${e.message}`);
		return null;
	}
	const resolvedNumberFrom = numberFrom ?? "capture";
	if (resolvedNumberFrom === "capture" && countCaptureGroups(regex.source) === 0) {
		errors.push(`${where}: capture rule must have a capture group`);
		return null;
	}
	return { regex, pattern, kind, strength, numberFrom: resolvedNumberFrom };
}

/**
 * Validate optional scalar fields in place: malformed values are dropped (left
 * unset so mergeProviders falls back to the builtin) with an error recorded.
 * A scalar list is only assigned when at least one entry parsed, so an
 * all-invalid `hosts`/`urlTemplates` is treated as unset rather than as an
 * empty override that would clobber the builtin values.
 * @param {any} raw
 * @param {string} name
 * @param {Provider} provider
 * @param {string[]} errors
 */
function validateScalarFields(raw, name, provider, errors) {
	if (raw.hosts !== undefined) {
		if (Array.isArray(raw.hosts)) {
			/** @type {string[]} */
			const hosts = [];
			raw.hosts.forEach((host, i) => {
				if (typeof host === "string" && host) hosts.push(host);
				else errors.push(`provider "${name}": hosts[${i}] must be a non-empty string`);
			});
			if (hosts.length > 0) provider.hosts = hosts;
		} else {
			errors.push(`provider "${name}": hosts must be an array of strings`);
		}
	}
	if (raw.issuePrefix !== undefined) {
		if (typeof raw.issuePrefix === "string") provider.issuePrefix = raw.issuePrefix;
		else errors.push(`provider "${name}": issuePrefix must be a string`);
	}
	if (raw.prPrefix !== undefined) {
		if (typeof raw.prPrefix === "string") provider.prPrefix = raw.prPrefix;
		else errors.push(`provider "${name}": prPrefix must be a string`);
	}
	if (raw.urlTemplates !== undefined) {
		if (raw.urlTemplates && typeof raw.urlTemplates === "object" && !Array.isArray(raw.urlTemplates)) {
			/** @type {{issue?: string, pr?: string}} */
			const templates = {};
			if (raw.urlTemplates.issue !== undefined) {
				if (typeof raw.urlTemplates.issue === "string") templates.issue = raw.urlTemplates.issue;
				else errors.push(`provider "${name}": urlTemplates.issue must be a string`);
			}
			if (raw.urlTemplates.pr !== undefined) {
				if (typeof raw.urlTemplates.pr === "string") templates.pr = raw.urlTemplates.pr;
				else errors.push(`provider "${name}": urlTemplates.pr must be a string`);
			}
			if (templates.issue !== undefined || templates.pr !== undefined) {
				provider.urlTemplates = templates;
			}
		} else {
			errors.push(`provider "${name}": urlTemplates must be an object`);
		}
	}
}

/**
 * Append-merge user providers over builtins (decision D3): a user provider
 * with the same name as a builtin gets its rules prepended to the builtin's
 * rules and its scalar fields override the builtin's when set; unknown names
 * are appended as-is with default scalars (`[]`, `#`, `▸#`, `null`). Builtin
 * objects are never mutated. Validation errors are the caller's concern; the
 * merge itself never throws.
 * @param {Provider[]} builtins
 * @param {Provider[]} user
 * @returns {Provider[]}
 */
export function mergeProviders(builtins, user) {
	const byName = new Map(builtins.map((p) => [p.name, p]));
	const merged = builtins.map((builtin) => {
		const override = user.find((p) => p.name === builtin.name);
		if (!override) return builtin;
		return {
			name: builtin.name,
			hosts: override.hosts ?? builtin.hosts,
			issuePrefix: override.issuePrefix ?? builtin.issuePrefix,
			prPrefix: override.prPrefix ?? builtin.prPrefix,
			urlTemplates: override.urlTemplates ?? builtin.urlTemplates,
			rules: [...override.rules, ...builtin.rules],
		};
	});
	for (const provider of user) {
		if (byName.has(provider.name)) continue;
		merged.push({
			name: provider.name,
			hosts: provider.hosts ?? [],
			issuePrefix: provider.issuePrefix ?? "#",
			prPrefix: provider.prPrefix ?? "▸#",
			urlTemplates: provider.urlTemplates ?? null,
			rules: provider.rules,
		});
	}
	return merged;
}

/**
 * Cached merged provider lists per store root. The cache key records the
 * `providers.json` mtime (null when the file is absent) so a file change
 * triggers a reload while unchanged files reuse the merged result. Validation
 * errors are cached alongside so they can be surfaced once per mtime.
 * @type {Map<string, {mtimeMs: number|null, providers: Provider[], errors: string[]}>}
 */
const providerCache = new Map();

/**
 * Resolve the effective provider list for a store root, together with any
 * per-provider validation errors from the user's `<root>/providers.json`.
 * Never throws — a missing, unparseable, or otherwise broken file falls back to
 * builtins alone; invalid provider entries are skipped and their messages
 * returned in `errors`. Cached by file mtime.
 * @param {string} root
 * @returns {{providers: Provider[], errors: string[]}}
 */
export function loadProvidersWithErrors(root) {
	const file = providersPath(root);
	let mtimeMs = null;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		// no providers.json → builtins only
	}
	const cached = providerCache.get(root);
	if (cached && cached.mtimeMs === mtimeMs) return { providers: cached.providers, errors: cached.errors };
	const loaded = loadProvidersUncached(file);
	providerCache.set(root, { mtimeMs, providers: loaded.providers, errors: loaded.errors });
	return loaded;
}

/**
 * Resolve the effective provider list for a store root (validation errors
 * discarded): builtins merged with the user's `<root>/providers.json` when
 * present. Never throws — a missing, unparseable, or otherwise broken file
 * falls back to builtins alone. Thin wrapper over {@link loadProvidersWithErrors}.
 * @param {string} root
 * @returns {Provider[]}
 */
export function loadProviders(root) {
	return loadProvidersWithErrors(root).providers;
}

/**
 * Read + validate + merge without consulting the cache.
 * @param {string} file
 * @returns {{providers: Provider[], errors: string[]}}
 */
function loadProvidersUncached(file) {
	const raw = readJson(file, null);
	if (!raw || typeof raw !== "object" || !Array.isArray(raw.providers)) {
		return { providers: builtinProviders(), errors: [] };
	}
	/** @type {Provider[]} */
	const user = [];
	/** @type {string[]} */
	const errors = [];
	for (const entry of raw.providers) {
		const { provider, errors: entryErrors } = validateProvider(entry);
		if (provider) user.push(provider);
		errors.push(...entryErrors);
	}
	return { providers: mergeProviders(builtinProviders(), user), errors };
}

/**
 * Clear the loadProviders cache. Test-only helper.
 * @returns {void}
 */
export function clearProvidersCacheForTests() {
	providerCache.clear();
}

/**
 * Pick the provider whose hosts contain `host` (exact match, lowercased). A
 * null/empty host or no match falls back to the generic URL-only provider.
 * @param {Provider[]} providers
 * @param {string|null} host
 * @returns {Provider}
 */
export function matchProvider(providers, host) {
	if (typeof host === "string" && host) {
		const needle = host.toLowerCase();
		for (const provider of providers) {
			for (const candidate of provider.hosts) {
				if (candidate.toLowerCase() === needle) return provider;
			}
		}
	}
	return genericFallbackProvider();
}

/**
 * @typedef {Object} Ref
 * @property {"issue"|"pr"} kind
 * @property {number} number
 * @property {"claim"|"action"|"view"|"mention"} strength
 * @property {"high"|"medium"|"low"} confidence
 * @property {string} source
 * @property {string|null} url
 * @property {number} lastIndex
 */

/**
 * @typedef {Object} CodeRefsResult
 * @property {string} provider
 * @property {Ref|null} issue
 * @property {Ref|null} pr
 * @property {Ref[]} allRefs
 */

const STRENGTH_RANK = { claim: 3, action: 2, view: 1, mention: 0 };
const REF_CONFIDENCE = { claim: "high", action: "high", view: "medium", mention: "low" };

/** URL rules carry a `/issues/`, `/pull/`, or `/merge_requests/` path segment. */
const URL_RULE_RE = /issues\/|pull\/|merge_requests\//;
/**
 * Back-link inside an explicit `pr create` command body: closing keywords
 * (optionally followed by "issue") or the legacy bare `issue #N` form.
 * Word boundaries keep embedded keywords (prefix/disclose/unresolved) out;
 * `(?!\w)` rejects longer numbers instead of truncating them to 7 digits.
 */
const PR_CREATE_BACKLINK_RE =
	/\b(?:(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s+(?:issue\s+)?|issue\s+)#(\d{1,7})(?!\w)/i;
/**
 * Back-link in later assistant evidence: canonical closing-keyword syntax
 * only (`closes #N` etc.). A bare `issue #N` mention — e.g. a code-review
 * report's finding number — never matches here (issue #65).
 */
const PR_FOLLOWUP_BACKLINK_RE =
	/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s+#(\d{1,7})(?!\w)/i;

/**
 * Match a PR→issue back-link in the text of an explicit `pr create` command
 * (closing keywords or the legacy bare `issue #N` body form).
 * @param {string} text
 * @returns {number|null}
 */
function matchPrCreateBacklink(text) {
	const m = PR_CREATE_BACKLINK_RE.exec(text);
	return m ? Number(m[1]) : null;
}

/**
 * Match a PR→issue back-link in later assistant evidence — canonical
 * closing-keyword syntax only, never a bare `issue #N` (issue #65).
 * @param {string} text
 * @returns {number|null}
 */
function matchPrFollowupBacklink(text) {
	const m = PR_FOLLOWUP_BACKLINK_RE.exec(text);
	return m ? Number(m[1]) : null;
}
/** `issue-<N>-...` worktree/branch naming convention (engine-builtin). */
const WORKTREE_RE = /(?:^|[/\\])issue-(\d{1,7})(?:-|$)/;
/** Bare `#N` mentions. */
const MENTION_RE = /#(\d{1,7})/g;

/** Worktree/branch naming is session metadata, treated as before the transcript. */
const WORKTREE_INDEX = -1;

/** @param {Rule} rule */
function isUrlRule(rule) {
	return URL_RULE_RE.test(rule.pattern);
}

/**
 * @param {Array<{kind: "issue"|"pr", number: number, strength: string, source: string, lastIndex: number}>} candidates
 */
function addCandidate(candidates, kind, number, strength, source, lastIndex) {
	if (!Number.isInteger(number) || number <= 0) return;
	candidates.push({ kind, number, strength, source, lastIndex });
}

/**
 * Extract issue/PR references from session evidence against one provider. Pure
 * (zero I/O): the caller has already resolved the provider for the repo host
 * and passes `repoUrl` (`owner/repo`) plus `host` for urlTemplate filling.
 *
 * `input.commands` are scanned in array order; `input.assistantTexts` are
 * treated as the ordered sequence continuing after commands (indexes keep
 * counting). Rule strengths rank `claim > action > view > mention`; a tie in
 * strength is broken by the highest `lastIndex`.
 *
 * @param {{commands: Array<{command: string}>, assistantTexts: string[], worktreePath: string|null, branch: string|null, repoUrl: string|null, host: string|null}} input
 * @param {Provider} provider
 * @returns {CodeRefsResult}
 */
export function extractCodeRefs(input, provider) {
	input = input ?? {};
	const commands = Array.isArray(input.commands) ? input.commands : [];
	const assistantTexts = Array.isArray(input.assistantTexts) ? input.assistantTexts : [];
	const worktreePath = input.worktreePath ?? null;
	const branch = input.branch ?? null;
	const repoUrl = input.repoUrl ?? null;
	const host = input.host ?? null;
	const rules = provider.rules;

	/** @type {Array<{kind: "issue"|"pr", number: number, strength: string, source: string, lastIndex: number}>} */
	const candidates = [];
	/** @type {Array<{kind: "issue"|"pr", index: number}>} */
	const pendingCreates = [];

	// Rule 1: commands in order, against every provider rule.
	commands.forEach((cmd, index) => {
		const text = cmd && typeof cmd.command === "string" ? cmd.command : "";
		if (!text) return;
		for (const rule of rules) {
			const m = rule.regex.exec(text);
			if (!m) continue;
			if (rule.numberFrom === "outputUrl") {
				pendingCreates.push({ kind: rule.kind, index });
				// Rule 4: PR back-link within a pr create command.
				if (rule.kind === "pr") applyPrBacklink(text, index, candidates);
			} else {
				addCandidate(candidates, rule.kind, Number(m[1]), rule.strength, "command", index);
			}
		}
	});

	// Rule 2: assistant texts (indexes continue after commands) with URL rules only.
	const urlRules = rules.filter(isUrlRule);
	assistantTexts.forEach((text, i) => {
		const index = commands.length + i;
		if (typeof text !== "string" || !text) return;
		for (const rule of urlRules) {
			const m = rule.regex.exec(text);
			if (!m) continue;
			addCandidate(candidates, rule.kind, Number(m[1]), rule.strength, "url", index);
		}
	});

	// Rule 3: resolve pending create markers against subsequent evidence.
	for (let mi = 0; mi < pendingCreates.length; mi++) {
		const marker = pendingCreates[mi];
		const resolved = resolveCreate(marker, commands, assistantTexts, urlRules);
		if (resolved) {
			addCandidate(candidates, marker.kind, resolved.number, "action", "create-url", resolved.index);
		}
		// Rule 4b: the issue back-link of a created PR may live in a later
		// assistant message ("This PR closes #40") or in --body-file content
		// that never appears in the command string — scan subsequent evidence
		// for the back-link pattern as well (not just the command itself).
		// The scan stops at the NEXT pr-create marker so an earlier create
		// never absorbs a later PR's back-link.
		if (marker.kind === "pr") {
			const nextPr = pendingCreates.slice(mi + 1).find((m) => m.kind === "pr");
			const backlink = resolveBacklinkAfter(marker, commands, assistantTexts, nextPr?.index ?? Infinity);
			if (backlink) addCandidate(candidates, "issue", backlink.number, "claim", "pr-backlink", backlink.index);
		}
	}

	// Rule 5: worktree/branch naming (engine-builtin, not configurable).
	for (const value of [worktreePath, branch]) {
		if (typeof value !== "string" || !value) continue;
		const m = WORKTREE_RE.exec(value);
		if (m) addCandidate(candidates, "issue", Number(m[1]), "claim", "worktree", WORKTREE_INDEX);
	}

	// Rule 7 (first half): drop view signals seen fewer than twice. This runs
	// before the mention check so a single discarded view does not suppress the
	// bare-`#N` fallback.
	discardWeakViews(candidates);

	// Rule 6: bare `#N` mention fallback, only when no stronger issue signal.
	if (!hasIssueCandidateAtLeastView(candidates)) {
		const mention = mentionFallback(assistantTexts, commands.length);
		if (mention) addCandidate(candidates, "issue", mention.number, "mention", "mention", mention.lastIndex);
	}

	// Rule 7 (second half): aggregate winners + allRefs.
	return aggregate(candidates, provider, repoUrl, host);
}

/**
 * @param {string} text
 * @param {number} index
 * @param {Array<{kind: "issue"|"pr", number: number, strength: string, source: string, lastIndex: number}>} candidates
 */
function applyPrBacklink(text, index, candidates) {
	const number = matchPrCreateBacklink(text);
	if (number !== null) addCandidate(candidates, "issue", number, "claim", "pr-body", index);
}

/**
 * Find the first PR→issue back-link ("Closes #N" etc.) in evidence AFTER a
 * `pr create` marker — covers assistant messages and later commands alike.
 * The scan stops before `stopBefore` (typically the next pr-create marker).
 * @param {{kind: "issue"|"pr", index: number}} marker
 * @param {Array<{command: string}>} commands
 * @param {string[]} assistantTexts
 * @param {number} [stopBefore]
 */
function resolveBacklinkAfter(marker, commands, assistantTexts, stopBefore = Infinity) {
	const total = Math.min(commands.length + assistantTexts.length, stopBefore);
	for (let index = marker.index + 1; index < total; index++) {
		const text = evidenceTextAt(index, commands, assistantTexts);
		if (!text) continue;
		const number = matchPrFollowupBacklink(text);
		if (number !== null) return { number, index };
	}
	return null;
}

/**
 * @param {{kind: "issue"|"pr", index: number}} marker
 * @param {Array<{command: string}>} commands
 * @param {string[]} assistantTexts
 * @param {Rule[]} urlRules
 */
function resolveCreate(marker, commands, assistantTexts, urlRules) {
	const total = commands.length + assistantTexts.length;
	for (let index = marker.index + 1; index < total; index++) {
		const text = evidenceTextAt(index, commands, assistantTexts);
		if (!text) continue;
		for (const rule of urlRules) {
			if (rule.kind !== marker.kind) continue;
			const m = rule.regex.exec(text);
			if (m) return { number: Number(m[1]), index };
		}
	}
	return null;
}

/**
 * @param {number} index
 * @param {Array<{command: string}>} commands
 * @param {string[]} assistantTexts
 */
function evidenceTextAt(index, commands, assistantTexts) {
	if (index < commands.length) {
		const cmd = commands[index];
		return cmd && typeof cmd.command === "string" ? cmd.command : "";
	}
	const text = assistantTexts[index - commands.length];
	return typeof text === "string" ? text : "";
}

/**
 * Remove view candidates whose number was viewed fewer than twice (D1: view
 * signals only count at frequency >= 2). Mutates `candidates` in place.
 * @param {Array<{kind: "issue"|"pr", number: number, strength: string, source: string, lastIndex: number}>} candidates
 */
function discardWeakViews(candidates) {
	const counts = new Map();
	for (const c of candidates) {
		if (c.strength !== "view") continue;
		const key = `${c.kind}:${c.number}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	for (let i = candidates.length - 1; i >= 0; i--) {
		const c = candidates[i];
		if (c.strength === "view" && (counts.get(`${c.kind}:${c.number}`) ?? 0) < 2) {
			candidates.splice(i, 1);
		}
	}
}

/**
 * @param {Array<{kind: "issue"|"pr", number: number, strength: string, source: string, lastIndex: number}>} candidates
 */
function hasIssueCandidateAtLeastView(candidates) {
	return candidates.some((c) => c.kind === "issue" && STRENGTH_RANK[c.strength] >= STRENGTH_RANK.view);
}

/**
 * Count bare `#N` mentions over the last 20 assistant texts. Returns the
 * winner (and its last occurrence index) only when it appears at least 3 times
 * and at least twice as often as the runner-up; otherwise null.
 * @param {string[]} assistantTexts
 * @param {number} baseIndex
 */
function mentionFallback(assistantTexts, baseIndex) {
	const start = Math.max(0, assistantTexts.length - 20);
	const counts = new Map();
	const lastIndex = new Map();
	for (let i = start; i < assistantTexts.length; i++) {
		const text = assistantTexts[i];
		if (typeof text !== "string") continue;
		for (const m of text.matchAll(MENTION_RE)) {
			const n = Number(m[1]);
			counts.set(n, (counts.get(n) ?? 0) + 1);
			lastIndex.set(n, baseIndex + i);
		}
	}
	if (counts.size === 0) return null;
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	const winner = ranked[0];
	const runnerUp = ranked[1]?.[1] ?? 0;
	if (winner[1] < 3 || winner[1] < 2 * runnerUp) return null;
	return { number: winner[0], lastIndex: lastIndex.get(winner[0]) ?? baseIndex };
}

/**
 * @param {Array<{kind: "issue"|"pr", number: number, strength: string, source: string, lastIndex: number}>} candidates
 * @param {Provider} provider
 * @param {string|null} repoUrl
 * @param {string|null} host
 */
function aggregate(candidates, provider, repoUrl, host) {
	/** @type {Map<string, {kind: "issue"|"pr", number: number, strength: string, source: string, lastIndex: number}>} */
	const byKey = new Map();
	for (const c of candidates) {
		const key = `${c.kind}:${c.number}`;
		const prev = byKey.get(key);
		if (!prev) {
			byKey.set(key, c);
			continue;
		}
		const rank = STRENGTH_RANK[c.strength];
		const prevRank = STRENGTH_RANK[prev.strength];
		// Stronger wins; equal strength → most recent; equal recency → the more
		// specific later-derived signal (e.g. create-url beats url).
		if (rank > prevRank || (rank === prevRank && c.lastIndex >= prev.lastIndex)) {
			byKey.set(key, c);
		}
	}

	const issue = pickWinner(byKey, "issue");
	const pr = pickWinner(byKey, "pr");
	const allRefs = [...byKey.values()]
		.sort((a, b) => STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength] || b.lastIndex - a.lastIndex)
		.slice(0, 10)
		.map((c) => toRef(c, provider, repoUrl, host));

	return {
		provider: provider.name,
		issue: issue ? toRef(issue, provider, repoUrl, host) : null,
		pr: pr ? toRef(pr, provider, repoUrl, host) : null,
		allRefs,
	};
}

/**
 * @param {Map<string, {kind: "issue"|"pr", number: number, strength: string, source: string, lastIndex: number}>} byKey
 * @param {"issue"|"pr"} kind
 */
function pickWinner(byKey, kind) {
	let best = null;
	for (const c of byKey.values()) {
		if (c.kind !== kind) continue;
		if (!best) {
			best = c;
			continue;
		}
		const rank = STRENGTH_RANK[c.strength];
		const bestRank = STRENGTH_RANK[best.strength];
		if (rank > bestRank || (rank === bestRank && c.lastIndex > best.lastIndex)) best = c;
	}
	return best;
}

/**
 * @param {{kind: "issue"|"pr", number: number, strength: string, source: string, lastIndex: number}} c
 * @param {Provider} provider
 * @param {string|null} repoUrl
 * @param {string|null} host
 * @returns {Ref}
 */
function toRef(c, provider, repoUrl, host) {
	return {
		kind: c.kind,
		number: c.number,
		strength: c.strength,
		confidence: REF_CONFIDENCE[c.strength],
		source: c.source,
		url: c.strength === "mention" ? null : fillUrl(provider, c.kind, c.number, repoUrl, host),
		lastIndex: c.lastIndex,
	};
}

/**
 * Fill a provider urlTemplate (`{host}`, `{owner}`, `{repo}`, `{number}`).
 * Returns null when there is no template for the kind or no repoUrl.
 * @param {Provider} provider
 * @param {"issue"|"pr"} kind
 * @param {number} number
 * @param {string|null} repoUrl
 * @param {string|null} host
 */
function fillUrl(provider, kind, number, repoUrl, host) {
	const template = provider.urlTemplates?.[kind];
	if (!template || typeof repoUrl !== "string" || !repoUrl) return null;
	// Templates embed {host}; without a host the URL would be malformed, so bail.
	if (template.includes("{host}") && !host) return null;
	const { owner, repo } = splitRepoUrl(repoUrl);
	return template
		.replaceAll("{host}", typeof host === "string" ? host : "")
		.replaceAll("{owner}", owner)
		.replaceAll("{repo}", repo)
		.replaceAll("{number}", String(number));
}

/**
 * Split an `owner/repo` path into its owner and repo parts (repo name minus
 * any trailing `.git`).
 * @param {string} repoUrl
 */
function splitRepoUrl(repoUrl) {
	const path = repoUrl.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
	const slash = path.lastIndexOf("/");
	if (slash === -1) return { owner: "", repo: path };
	return { owner: path.slice(0, slash), repo: path.slice(slash + 1) };
}
