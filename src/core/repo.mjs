/** Git repository identity. Pure node (shells out to `git`); returns null off-repo. */
import { execFileSync } from "node:child_process";
import { parseRemoteHost } from "./code-refs.mjs";

/**
 * Resolve the git repo root containing `cwd`, or null if not in a repo.
 * @param {string} cwd
 * @returns {string|null}
 */
export function gitRepoRoot(cwd) {
	try {
		const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const root = out.trim();
		return root || null;
	} catch {
		return null;
	}
}

/**
 * Whether two directories resolve to the same git repo root.
 * @param {string|null} rootA
 * @param {string|null} rootB
 * @returns {boolean}
 */
export function sameRepo(rootA, rootB) {
	return Boolean(rootA && rootB && rootA === rootB);
}

/**
 * Whether the repo has uncommitted changes (dirty). Best-effort; false on error/off-repo.
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function isDirty(repoRoot) {
	try {
		const out = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Cached origin-remote URL per repo root. Failures are cached as null so each
 * repo root is only ever queried once per process.
 * @type {Map<string, string|null>}
 */
const remoteUrlCache = new Map();

/**
 * Raw URL of the `origin` remote of `repoRoot`, or null when the repo has no
 * origin remote or is not a repo. The result (including misses) is cached per
 * repoRoot.
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function gitRemoteUrl(repoRoot) {
	const cached = remoteUrlCache.get(repoRoot);
	if (cached !== undefined) return cached;
	let url = null;
	try {
		const out = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		url = out.trim() || null;
	} catch {
		// not a repo or no origin remote
	}
	remoteUrlCache.set(repoRoot, url);
	return url;
}

/**
 * Host of the `origin` remote of `repoRoot`, lowercased and without port, or
 * null when the repo has no origin remote or is not a repo. Supports
 * `https://host/owner/repo(.git)` and `git@host:owner/repo(.git)`; parsed from
 * the cached raw remote URL.
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function gitRemoteHost(repoRoot) {
	return parseRemoteHost(gitRemoteUrl(repoRoot));
}

/**
 * Clear the gitRemoteHost cache. Test-only helper.
 * @returns {void}
 */
export function clearRemoteHostCacheForTests() {
	remoteUrlCache.clear();
}
