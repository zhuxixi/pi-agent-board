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
import { join } from "node:path";
import { readJson } from "./atomic.mjs";

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
 * Compile and validate one raw rule; returns null (and records an error) when
 * any field is missing or invalid. The regex must compile and capture the
 * number in group 1 (except `numberFrom: "outputUrl"` rules).
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
	return { regex, pattern, kind, strength, numberFrom: numberFrom ?? "capture" };
}

/**
 * Validate optional scalar fields in place: malformed values are dropped (left
 * unset so mergeProviders falls back to the builtin) with an error recorded.
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
			provider.hosts = hosts;
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
			provider.urlTemplates = templates;
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
 * triggers a reload while unchanged files reuse the merged result.
 * @type {Map<string, {mtimeMs: number|null, providers: Provider[]}>}
 */
const providerCache = new Map();

/**
 * Resolve the effective provider list for a store root: builtins merged with
 * the user's `<root>/providers.json` when present. Never throws — a missing,
 * unparseable, or otherwise broken file falls back to builtins alone. The
 * merged result is cached by file mtime.
 * @param {string} root
 * @returns {Provider[]}
 */
export function loadProviders(root) {
	const file = join(root, "providers.json");
	let mtimeMs = null;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		// no providers.json → builtins only
	}
	const cached = providerCache.get(root);
	if (cached && cached.mtimeMs === mtimeMs) return cached.providers;
	const providers = loadProvidersUncached(file);
	providerCache.set(root, { mtimeMs, providers });
	return providers;
}

/**
 * Read + validate + merge without consulting the cache.
 * @param {string} file
 * @returns {Provider[]}
 */
function loadProvidersUncached(file) {
	const raw = readJson(file, null);
	if (!raw || typeof raw !== "object" || !Array.isArray(raw.providers)) return builtinProviders();
	/** @type {Provider[]} */
	const user = [];
	for (const entry of raw.providers) {
		const { provider } = validateProvider(entry);
		if (provider) user.push(provider);
	}
	return mergeProviders(builtinProviders(), user);
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
