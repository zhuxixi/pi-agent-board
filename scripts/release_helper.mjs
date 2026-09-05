#!/usr/bin/env node
/**
 * Conventional-commit driven CHANGELOG helper (port of the jfox release
 * helper, adapted to this repo's Node stack and `vX.Y.Z` tags).
 *
 * Modes:
 *   node scripts/release_helper.mjs [--dry-run] [patch|minor|major|X.Y.Z]
 *     Compute the next version (default patch) from package.json, parse
 *     conventional commits since the last `v*` tag, and print a JSON result
 *     with a `changelog_preview`. Without --dry-run, also insert the section
 *     at the top of CHANGELOG.md.
 *   node scripts/release_helper.mjs verify
 *     Check that every functional commit (feat/fix/refactor/docs/perf) in
 *     `last v* tag..HEAD` has its trailing (#N) present in the CHANGELOG top
 *     section. Exits 1 with a missing list when the changelog has drifted
 *     (e.g. a PR merged after the section was generated).
 *
 * The pure functions below are exported for unit tests; the CLI layer is the
 * only place that touches git or the filesystem.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");
const CHANGELOG_MD = join(REPO_ROOT, "CHANGELOG.md");
const REPO_URL = "https://github.com/zhuxixi/pi-agent-board";
const COMPARE_BASE = `${REPO_URL}/compare`;

/** Conventional commit subject: type[(scope)][!]: message [(#N)] */
const CONVENTIONAL_RE =
	/^(feat|fix|perf|refactor|docs|chore|test)(?:\(([^)]*)\))?!?:\s+(.+?)(?:\s+\(#(\d+)\))?$/;
/** Version-squash subjects produced by `npm version` PRs, e.g. `0.5.2 (#74)`. */
const VERSION_SQUASH_RE = /^\d+\.\d+\.\d+(?:[-.][\w.]+)?\s*\(#\d+\)$/;
/** Functional whitelist for verify (CHANGELOG-worthy types). */
const FUNCTIONAL_TYPES = new Set(["feat", "fix", "refactor", "docs", "perf"]);

/**
 * Parse commit subject lines into changelog entries.
 * @param {Iterable<string>} lines
 * @returns {Array<{type: string, scope: string, message: string, pr: number|null}>}
 */
export function parseCommitLines(lines) {
	const entries = [];
	const seen = new Set();
	for (const raw of lines) {
		const s = String(raw ?? "").trim();
		if (!s) continue;
		if (VERSION_SQUASH_RE.test(s)) continue;
		if (/bump\s+version/i.test(s)) continue;
		if (s.startsWith("Merge ")) continue;
		const m = s.match(CONVENTIONAL_RE);
		const prTail = s.match(/\(#(\d+)\)\s*$/);
		const entry = m
			? { type: m[1], scope: m[2] || "", message: m[3].trim(), pr: m[4] ? Number(m[4]) : null }
			: { type: "other", scope: "", message: s, pr: prTail ? Number(prTail[1]) : null };
		const key = `${entry.type}|${entry.scope}|${entry.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push(entry);
	}
	return entries;
}

/**
 * Render one changelog section for a version.
 * @param {{version: string, date: string, entries: Array<{type: string, scope: string, message: string, pr: number|null}>, prevTag?: string|null}} opts
 * @returns {string}
 */
export function generateChangelog({ version, date, entries, prevTag = null }) {
	const groups = [
		["Features", (e) => e.type === "feat"],
		["Fixes", (e) => e.type === "fix"],
		["Performance", (e) => e.type === "perf"],
		["Changes", (e) => e.type !== "feat" && e.type !== "fix" && e.type !== "perf"],
	];
	const lines = [`## [${version}] - ${date}`, ""];
	for (const [title, keep] of groups) {
		const group = entries.filter(keep);
		if (group.length === 0) continue;
		lines.push(`### ${title}`, "");
		for (const e of group) {
			const scope = e.scope ? `**${e.scope}**: ` : "";
			const pr = e.pr ? ` (#${e.pr})` : "";
			lines.push(`- ${scope}${e.message}${pr}`);
		}
		lines.push("");
	}
	const prev = prevTag ? prevTag.replace(/^v/, "") : null;
	if (prev) lines.push(`[${version}]: ${COMPARE_BASE}/v${prev}...v${version}`);
	return lines.join("\n");
}

/**
 * PR numbers referenced inside the first `## [...]` section of a CHANGELOG.
 * @param {string} text
 * @returns {Set<number>}
 */
export function changelogTopPrs(text) {
	// Split before each `## [` heading and take the first real section — the
	// JS port of jfox's regex uses split because Python's \Z (absolute end)
	// has no JS equivalent and a `$` lookahead matches zero-width.
	const sections = String(text ?? "").split(/(?=^##\s*\[)/m);
	const first = sections.find((s) => /^##\s*\[/.test(s));
	const section = first ?? String(text ?? "");
	return new Set([...section.matchAll(/\(#(\d+)\)/g)].map((x) => Number(x[1])));
}

/**
 * Filter subject lines down to functional (CHANGELOG-worthy) commits:
 * conventional whitelist types, skipping merges, version squashes, and
 * `docs(changelog)` maintenance commits (their PRs fix the changelog itself
 * and must not feed back into verify — infinite loop guard, jfox #333).
 * @param {Iterable<string>} lines
 * @returns {string[]}
 */
export function functionalLines(lines) {
	const out = [];
	for (const raw of lines) {
		const s = String(raw ?? "").trim();
		if (!s || VERSION_SQUASH_RE.test(s) || /bump\s+version/i.test(s)) continue;
		if (s.startsWith("Merge ")) continue;
		const m = s.match(/^(\w+)(?:\(([^)]*)\))?!?:/);
		if (!m) continue;
		if (!FUNCTIONAL_TYPES.has(m[1].toLowerCase())) continue;
		if (m[1].toLowerCase() === "docs" && (m[2] || "").toLowerCase().includes("changelog")) continue;
		out.push(s);
	}
	return out;
}

/**
 * Pure verify: functional commit lines vs CHANGELOG text.
 * @param {{lines: Iterable<string>, changelogText: string}} input
 * @returns {{ok: boolean, missing: number[], extra: number[], functionalCommits: number}}
 */
export function verifyFrom({ lines, changelogText }) {
	const funcPrs = new Set();
	for (const s of functionalLines(lines)) {
		const m = s.match(/\(#(\d+)\)\s*$/);
		if (m) funcPrs.add(Number(m[1]));
	}
	const clPrs = changelogTopPrs(changelogText);
	const missing = [...funcPrs].filter((n) => !clPrs.has(n)).sort((a, b) => a - b);
	const extra = [...clPrs].filter((n) => !funcPrs.has(n)).sort((a, b) => a - b);
	return { ok: missing.length === 0, missing, extra, functionalCommits: funcPrs.size };
}

/**
 * Insert a rendered section above the first existing `## ` heading (or append
 * after the header when none exists yet).
 * @param {string} existing
 * @param {string} section
 * @returns {string}
 */
export function insertSection(existing, section) {
	const content = String(existing ?? "");
	const insertAt = content.indexOf("\n## ");
	if (insertAt === -1) return `${content.replace(/\s*$/, "")}\n\n${section}\n`;
	return `${content.slice(0, insertAt + 1)}${section}\n\n${content.slice(insertAt + 1)}`;
}

/** @returns {string|null} latest `v*` tag, null when the repo has none, throws on git errors (fail-closed) */
function lastTag(root = REPO_ROOT) {
	const tag = gitOut(["tag", "--list", "v*"], root);
	const tags = tag.split("\n").map((s) => s.trim()).filter(Boolean);
	if (tags.length === 0) return null;
	return gitOut(["describe", "--tags", "--abbrev=0", "--match", "v*"], root).trim() || null;
}

/** @param {string[]} args @param {string} root @returns {string} */
function gitOut(args, root) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** @returns {string[]} commit subjects in `lastTag..HEAD` (or all when no tag); throws on git errors */
function commitSubjects(tag, root = REPO_ROOT) {
	const range = tag ? `${tag}..HEAD` : "HEAD";
	return execFileSync("git", ["log", range, "--format=%s"], { cwd: root, encoding: "utf8" })
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** @returns {string} current version from package.json */
function currentVersion() {
	const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
	if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? "")) throw new Error(`package.json has no semver version: ${pkg.version}`);
	return pkg.version;
}

/** @param {string} arg @param {string} current */
export function nextVersion(arg, current) {
	const cur = current.split(".").map(Number);
	if (arg === "major") return `${cur[0] + 1}.0.0`;
	if (arg === "minor") return `${cur[0]}.${cur[1] + 1}.0`;
	if (arg === "patch") return `${cur[0]}.${cur[1]}.${cur[2] + 1}`;
	if (/^\d+\.\d+\.\d+$/.test(arg)) {
		// Component-wise compare — lexicographic join(".") misorders "0.10.0" vs "0.5.2".
		const parts = arg.split(".").map(Number);
		for (let i = 0; i < 3; i++) {
			if (parts[i] !== cur[i]) {
				if (parts[i] < cur[i]) throw new Error(`version ${arg} is not greater than current ${current}`);
				break;
			}
		}
		if (arg === current) throw new Error(`version ${arg} is not greater than current ${current}`);
		return arg;
	}
	throw new Error(`invalid version or bump type: ${arg} (expected patch/minor/major or X.Y.Z)`);
}

function main(argv) {
	if (argv[0] === "verify") {
		let result;
		try {
			const tag = lastTag();
			const lines = tag ? commitSubjects(tag) : [];
			const changelogText = existsSync(CHANGELOG_MD) ? readFileSync(CHANGELOG_MD, "utf8") : "";
			result = verifyFrom({ lines, changelogText });
			result.lastTag = tag;
		} catch (err) {
			// Fail-closed: a git/filesystem failure must block the release, not pass it.
			result = { ok: false, error: String(err?.message ?? err), missing: [], extra: [], functionalCommits: 0, lastTag: null };
		}
		console.log(JSON.stringify(result));
		process.exitCode = result.ok ? 0 : 1;
		return;
	}
	const dryRun = argv.includes("--dry-run");
	const versionArg = argv.find((a) => !a.startsWith("--")) ?? "patch";
	try {
	const current = currentVersion();
	const version = nextVersion(versionArg, current);
	const tag = lastTag();
	const entries = parseCommitLines(tag ? commitSubjects(tag) : commitSubjects(null));
	const date = new Date().toISOString().slice(0, 10);
	const changelogPreview = generateChangelog({ version, date, entries, prevTag: tag });
	const result = {
		current_version: current,
		new_version: version,
		last_tag: tag,
		changelog_summary: `${entries.filter((e) => e.type === "feat").length} features, ${entries.filter((e) => e.type === "fix").length} fixes, ${entries.filter((e) => !["feat", "fix"].includes(e.type)).length} changes`,
		changelog_preview: changelogPreview,
	};
	if (!dryRun) {
		const existing = existsSync(CHANGELOG_MD) ? readFileSync(CHANGELOG_MD, "utf8") : "# Changelog\n";
		writeFileSync(CHANGELOG_MD, insertSection(existing, changelogPreview));
		result.files_modified = ["CHANGELOG.md"];
	}
	console.log(JSON.stringify(result, null, 1));
	} catch (err) {
		console.log(JSON.stringify({ error: String(err?.message ?? err) }));
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2));
}
