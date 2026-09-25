#!/usr/bin/env node
/**
 * Release orchestrator — the single entry point for a release, from a clean
 * `main` to a published npm version.
 *
 * Flow (prose version: docs/RELEASE.md):
 *
 *   precheck → prepare <bump> → open-pr <version>
 *     → merge the PR with a MERGE COMMIT
 *     → finish <version>   (creates the GitHub Release)
 *     → .github/workflows/publish.yml publishes to npm with provenance
 *
 * Two ordering rules are baked in, because breaking either one ships a version
 * that `main` does not contain, or skips a version's notes:
 *
 * 1. The CHANGELOG section is generated BEFORE `npm version`, because
 *    `npm version` commits and tags the bump and would empty the commit range
 *    the section is rendered from.
 * 2. The GitHub Release is created AFTER the release PR is merged, and only
 *    once the tag is an ancestor of `origin/main`. A squash-merged release PR
 *    leaves the tag orphaned; `finish` refuses to continue in that case
 *    instead of publishing a version whose bump commit never reached main.
 *
 * Modes:
 *
 *   node scripts/release.mjs precheck
 *     Read-only gate: on main, clean tree, in sync with origin, no open
 *     release/* PR, last tag reachable from origin/main, and at least one
 *     functional commit to release.
 *   node scripts/release.mjs prepare <patch|minor|major|X.Y.Z> [--dry-run]
 *     Runs the gate, renders the CHANGELOG section from conventional commits,
 *     commits it, runs `npm version` (bump commit + tag), and switches to
 *     `release/vX.Y.Z`. Nothing leaves the machine.
 *   node scripts/release.mjs open-pr <version> [--dry-run]
 *     Pushes the release branch and its tag, then opens the release PR.
 *   node scripts/release.mjs finish <version> [--dry-run] [--sync-main]
 *     After the PR is merged: checks tag ancestry and CHANGELOG sync, then
 *     creates the GitHub Release — the CI publish trigger. `--sync-main`
 *     additionally resets a clean local main to origin/main.
 *   node scripts/release.mjs notes <version>
 *     Prints the CHANGELOG section for a version (the GitHub Release notes).
 *
 * Every mode is fail-closed: a failed check stops the run with exit code 1 and
 * a JSON body naming the failure. All modes print JSON except `notes`, which
 * prints the section itself so it can be redirected to a file.
 *
 * Changelog rendering is delegated to the pure, unit-tested functions in
 * release_helper.mjs; the git/npm/gh side effects live here and nowhere else.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	functionalLines,
	generateChangelog,
	hasSection,
	insertSection,
	nextVersion,
	parseCommitLines,
	verifyFrom,
} from "./release_helper.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG_MD = join(REPO_ROOT, "CHANGELOG.md");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");
const MAIN_BRANCH = "main";
const PACKAGE_NAME = "@zhuxixi/pi-agent-board";
const COMMANDS = new Set(["precheck", "prepare", "open-pr", "finish", "notes"]);
const FLAGS = new Set(["--dry-run", "--sync-main"]);

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested in test/release-flow.test.mjs)
 * ------------------------------------------------------------------ */

/** Branch a version is prepared on: `release/v0.9.0`. */
export function releaseBranchName(version) {
	return `release/v${version}`;
}

/**
 * The `## [version]` section of a CHANGELOG, without the trailing link
 * reference definition — i.e. the body used as GitHub Release notes.
 * @param {string} changelogText
 * @param {string} version
 * @returns {string|null} null when the section is absent
 */
export function extractReleaseSection(changelogText, version) {
	const text = String(changelogText ?? "");
	const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const heading = new RegExp(`^##\\s*\\[${escaped}]`, "m");
	const match = heading.exec(text);
	if (!match) return null;
	const rest = text.slice(match.index);
	// The next `## [` heading ends the section; +1 because the search runs on a
	// sliced string, so its index is relative to rest[1].
	const nextHeading = rest.slice(1).search(/^##\s*\[/m);
	const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1);
	return section
		.replace(/^\[[^\]]+]:\s+\S+\s*$/gm, "")
		.replace(/\s+$/, "")
		.replace(/^\n+/, "");
}

/**
 * Decide whether a release may start, from a collected snapshot of repo state.
 * Pure so the rules can be tested without a repository.
 * @param {{branch: string, clean: boolean, ahead: number, behind: number, openReleasePrs: number|null, lastTag: string|null, lastTagReachable: boolean, functionalCommits: number}} state
 * @returns {{ok: boolean, failures: string[]}}
 */
export function evaluatePreconditions(state) {
	const failures = [];
	if (state.branch !== MAIN_BRANCH) {
		failures.push(`must run on ${MAIN_BRANCH} (currently on "${state.branch || "detached HEAD"}")`);
	}
	if (!state.clean) failures.push("working tree is dirty — commit or stash first");
	if (state.behind > 0) failures.push(`local ${MAIN_BRANCH} is behind origin/${MAIN_BRANCH} by ${state.behind} commit(s) — pull first`);
	if (state.ahead > 0) failures.push(`local ${MAIN_BRANCH} is ahead of origin/${MAIN_BRANCH} by ${state.ahead} commit(s)`);
	if ((state.openReleasePrs ?? 0) > 0) failures.push(`${state.openReleasePrs} open release/* PR(s) — finish or close them first`);
	if (state.lastTag && !state.lastTagReachable) {
		failures.push(`tag ${state.lastTag} is not an ancestor of origin/${MAIN_BRANCH} (orphan tag) — re-point it before releasing`);
	}
	if (state.functionalCommits === 0) failures.push("no functional commits since the last tag — nothing to release");
	return { ok: failures.length === 0, failures };
}

/**
 * Parse the CLI argv into a command, its positional argument, and flags.
 * @param {string[]} argv
 * @returns {{command: string, arg: string|undefined, dryRun: boolean, syncMain: boolean}}
 */
export function parseArgs(argv) {
	const flags = [];
	const positional = [];
	for (const raw of argv) {
		if (raw.startsWith("--")) flags.push(raw);
		else positional.push(raw);
	}
	const [command, arg] = positional;
	if (!COMMANDS.has(command ?? "")) {
		throw new Error(`unknown command "${command ?? ""}" — expected one of ${[...COMMANDS].join(", ")}`);
	}
	for (const flag of flags) {
		if (!FLAGS.has(flag)) throw new Error(`unknown flag "${flag}" — expected ${[...FLAGS].join(", ")}`);
	}
	return { command, arg, dryRun: flags.includes("--dry-run"), syncMain: flags.includes("--sync-main") };
}

/* ------------------------------------------------------------------ *
 * Repo plumbing
 * ------------------------------------------------------------------ */

/**
 * Run a command, capturing both streams. stderr is folded into the thrown error
 * so a failure names the command and what it said, while a successful run stays
 * quiet (git's "Switched to a new branch" chatter included).
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string} stdout
 */
function run(cmd, args) {
	try {
		return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (err) {
		const stderr = String(err?.stderr ?? "").trim();
		const detail = stderr ? `: ${stderr}` : "";
		throw new Error(`${cmd} ${args.join(" ")} failed${detail}`);
	}
}

/** @param {string[]} args @returns {string} git stdout */
function git(args) {
	return run("git", args);
}

/** @param {string[]} args @returns {boolean} true when the command succeeded */
function gitOk(args) {
	try {
		git(args);
		return true;
	} catch {
		return false;
	}
}

/** @param {string[]} args @returns {string} npm stdout */
function npm(args) {
	return run("npm", args);
}

/** @param {string[]} args @returns {string} gh stdout */
function gh(args) {
	return run("gh", args);
}

/** @returns {string} version from package.json */
function packageVersion() {
	const version = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version;
	if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`package.json has no semver version: ${version}`);
	return version;
}

/** @returns {string|null} newest reachable `v*` tag */
function latestTag() {
	try {
		const tag = git(["describe", "--tags", "--abbrev=0", "--match", "v*"]).trim();
		return tag || null;
	} catch {
		return null;
	}
}

/** @param {string} range @returns {string[]} commit subjects in the range */
function subjects(range) {
	return git(["log", range, "--format=%s"])
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** @returns {boolean} whether the tag exists locally */
function tagExists(tag) {
	return gitOk(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
}

/** @param {string} ref @returns {boolean} whether ref exists locally */
function refExists(ref) {
	return gitOk(["rev-parse", "--verify", "--quiet", ref]);
}

/** @param {string} tag @param {string} ref @returns {boolean} */
function isAncestor(tag, ref) {
	return gitOk(["merge-base", "--is-ancestor", tag, ref]);
}

/**
 * Count open `release/*` PRs. null means the check could not run (no `gh`, no
 * auth, or not a GitHub remote) — reported but never a hard failure, so a
 * missing `gh` cannot block a release that does not need it.
 * @returns {number|null}
 */
function openReleasePrCount() {
	try {
		const json = gh(["pr", "list", "--state", "open", "--limit", "50", "--json", "headRefName"]);
		return JSON.parse(json).filter((pr) => String(pr.headRefName ?? "").startsWith("release/")).length;
	} catch {
		return null;
	}
}

/** @returns {object} the state consumed by evaluatePreconditions */
function collectState() {
	git(["fetch", "origin", "--quiet"]);
	const [behind, ahead] = git(["rev-list", "--left-right", "--count", `origin/${MAIN_BRANCH}...HEAD`])
		.trim()
		.split(/\s+/)
		.map(Number);
	const lastTag = latestTag();
	const functionalCommits = functionalLines(subjects(lastTag ? `${lastTag}..HEAD` : "HEAD")).length;
	return {
		branch: git(["branch", "--show-current"]).trim(),
		clean: git(["status", "--porcelain"]).trim() === "",
		ahead,
		behind,
		openReleasePrs: openReleasePrCount(),
		lastTag,
		lastTagReachable: lastTag ? isAncestor(lastTag, `origin/${MAIN_BRANCH}`) : true,
		functionalCommits,
	};
}

/** Throw unless the release may start; returns the collected state. */
function assertPreconditions() {
	const state = collectState();
	const { ok, failures } = evaluatePreconditions(state);
	if (!ok) throw new Error(`precheck failed:\n- ${failures.join("\n- ")}`);
	return state;
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/** @returns {object} precheck report (never throws on a failed gate) */
function cmdPrecheck() {
	const state = collectState();
	const { ok, failures } = evaluatePreconditions(state);
	return { ok, failures, ...state, prCheck: state.openReleasePrs === null ? "unavailable (gh not authenticated or not a GitHub remote)" : "ok" };
}

/**
 * @param {string|undefined} bump patch|minor|major|X.Y.Z
 * @param {boolean} dryRun
 * @returns {object}
 */
function cmdPrepare(bump, dryRun) {
	const state = assertPreconditions();
	const version = nextVersion(bump ?? "patch", packageVersion());
	const branch = releaseBranchName(version);
	const existing = readFileSync(CHANGELOG_MD, "utf8");
	if (hasSection(existing, version)) {
		throw new Error(`CHANGELOG.md already has a [${version}] section — remove the stale section before re-applying`);
	}
	const range = state.lastTag ? `${state.lastTag}..HEAD` : "HEAD";
	const entries = parseCommitLines(subjects(range));
	const section = generateChangelog({
		version,
		date: new Date().toISOString().slice(0, 10),
		entries,
		prevTag: state.lastTag,
	});
	const plan = [
		`git add CHANGELOG.md && git commit -m "docs(changelog): add ${version} section"`,
		`npm version ${bump ?? "patch"}`,
		`git switch -c ${branch}`,
	];
	const next = `node scripts/release.mjs open-pr ${version}`;
	if (dryRun) {
		return { ok: true, dry_run: true, current_version: packageVersion(), new_version: version, last_tag: state.lastTag, changelog_preview: section, plan, next };
	}
	writeFileSync(CHANGELOG_MD, insertSection(existing, section));
	git(["add", "CHANGELOG.md"]);
	git(["commit", "-m", `docs(changelog): add ${version} section`]);
	npm(["version", bump ?? "patch"]);
	git(["switch", "-c", branch]);
	return { ok: true, version, branch, tag: `v${version}`, next };
}

/**
 * @param {string|undefined} version
 * @param {boolean} dryRun
 * @returns {object}
 */
function cmdOpenPr(version, dryRun) {
	if (!version) throw new Error("open-pr requires a version (node scripts/release.mjs open-pr 0.9.0)");
	const branch = releaseBranchName(version);
	const tag = `v${version}`;
	const current = git(["branch", "--show-current"]).trim();
	if (packageVersion() !== version) throw new Error(`package.json is at ${packageVersion()}, expected ${version}`);
	if (current !== branch) throw new Error(`expected to be on ${branch} (currently on "${current || "detached HEAD"}")`);
	if (!tagExists(tag)) throw new Error(`tag ${tag} does not exist — run prepare first`);
	const notes = extractReleaseSection(readFileSync(CHANGELOG_MD, "utf8"), version);
	if (!notes) throw new Error(`CHANGELOG.md has no [${version}] section`);
	const body = `${notes}\n\n---\n\nMerge with a **merge commit** — squashing would orphan the \`${tag}\` tag and break the changelog range for the next release.`;
	const commands = [
		`git push -u origin ${branch}`,
		`git push origin ${tag}`,
		`gh pr create --base ${MAIN_BRANCH} --head ${branch} --title "chore: release ${version}"`,
	];
	if (dryRun) return { ok: true, dry_run: true, version, branch, tag, commands };
	git(["push", "-u", "origin", branch]);
	git(["push", "origin", tag]);
	const url = gh(["pr", "create", "--base", MAIN_BRANCH, "--head", branch, "--title", `chore: release ${version}`, "--body", body]).trim();
	return { ok: true, version, branch, tag, pr: url, next: `merge with a merge commit, then: node scripts/release.mjs finish ${version} --sync-main` };
}

/**
 * @param {string|undefined} version
 * @param {{dryRun: boolean, syncMain: boolean}} opts
 * @returns {object}
 */
function cmdFinish(version, { dryRun, syncMain }) {
	if (!version) throw new Error("finish requires a version (node scripts/release.mjs finish 0.9.0)");
	const tag = `v${version}`;
	if (packageVersion() !== version) throw new Error(`package.json is at ${packageVersion()}, expected ${version}`);
	git(["fetch", "origin", "--quiet"]);
	if (!tagExists(tag)) throw new Error(`tag ${tag} is missing — push it with open-pr first`);
	if (!isAncestor(tag, `origin/${MAIN_BRANCH}`)) {
		throw new Error(
			`tag ${tag} is not an ancestor of origin/${MAIN_BRANCH} — the release PR was probably squash-merged. ` +
				`Point the tag at the content-equivalent commit on main (git tag -f ${tag} <sha> && git push origin ${tag} --force) and retry`,
		);
	}
	const changelogText = readFileSync(CHANGELOG_MD, "utf8");
	const drift = verifyFrom({ lines: subjects(`${tag}..origin/${MAIN_BRANCH}`), changelogText });
	if (!drift.ok) {
		throw new Error(
			`CHANGELOG is missing functional PR(s) ${drift.missing.join(", ")} merged after the bump — ` +
				`add them to the ${version} section in a docs(changelog) PR, then retry`,
		);
	}
	const notes = extractReleaseSection(changelogText, version);
	if (!notes) throw new Error(`CHANGELOG.md has no [${version}] section`);
	if (dryRun) {
		return { ok: true, dry_run: true, tag, notes, commands: [`gh release create ${tag} --title ${tag} --notes-file <notes>`], syncMain };
	}
	const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
	const notesFile = join(dir, `${tag}.md`);
	try {
		writeFileSync(notesFile, `${notes}\n`);
		gh(["release", "create", tag, "--title", tag, "--notes-file", notesFile]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	let syncedMain = false;
	if (syncMain && git(["status", "--porcelain"]).trim() === "") {
		git(["switch", MAIN_BRANCH]);
		git(["reset", "--hard", `origin/${MAIN_BRANCH}`]);
		syncedMain = true;
	}
	return {
		ok: true,
		version,
		tag,
		release: `https://github.com/zhuxixi/pi-agent-board/releases/tag/${tag}`,
		package: `${PACKAGE_NAME}@${version}`,
		synced_main: syncedMain,
		publish: "CI publishes on release — watch it with: gh run list --workflow=publish.yml --limit 1",
	};
}

/**
 * @param {string|undefined} version
 * @returns {string} the release notes text
 */
function cmdNotes(version) {
	if (!version) throw new Error("notes requires a version (node scripts/release.mjs notes 0.9.0)");
	const notes = extractReleaseSection(readFileSync(CHANGELOG_MD, "utf8"), version);
	if (!notes) throw new Error(`CHANGELOG.md has no [${version}] section`);
	return notes;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function main(argv) {
	try {
		const { command, arg, dryRun, syncMain } = parseArgs(argv);
		if (command === "notes") {
			process.stdout.write(`${cmdNotes(arg)}\n`);
			return;
		}
		const result = command === "precheck" ? cmdPrecheck() : command === "prepare" ? cmdPrepare(arg, dryRun) : command === "open-pr" ? cmdOpenPr(arg, dryRun) : cmdFinish(arg, { dryRun, syncMain });
		console.log(JSON.stringify(result, null, 1));
		if (result.ok === false) process.exitCode = 1;
	} catch (err) {
		console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2));
}
