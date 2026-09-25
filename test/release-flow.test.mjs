import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { evaluatePreconditions, extractReleaseSection, parseArgs, releaseBranchName } from "../scripts/release.mjs";

const releaseScript = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
const helperScript = fileURLToPath(new URL("../scripts/release_helper.mjs", import.meta.url));

/** Two sections + a link reference definition, as the real CHANGELOG renders them. */
const CHANGELOG_STUB = [
	"# Changelog",
	"",
	"## [0.5.1] - 2026-08-30",
	"",
	"### Features",
	"",
	"- base (#70)",
	"",
	"[0.5.1]: https://github.com/zhuxixi/pi-agent-board/compare/v0.5.0...v0.5.1",
	"",
	"## [0.5.0] - 2026-08-20",
	"",
	"### Fixes",
	"",
	"- older (#60)",
	"",
	"[0.5.0]: https://github.com/zhuxixi/pi-agent-board/compare/v0.4.3...v0.5.0",
	"",
].join("\n");

/**
 * Self-contained release fixture: a repo with a bare `origin`, tag v0.5.1, and
 * one functional commit after that tag. CLI tests run against this — never
 * against the host repo, whose tags and remotes differ between checkouts and
 * CI.
 */
function makeFixture({ tag = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "releaseflow-"));
	const origin = mkdtempSync(join(tmpdir(), "releaseflow-origin-"));
	const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	git(["init", "-q", "-b", "main"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "test"]);
	// Host-level signing config must not leak into the fixture's commits/tags.
	git(["config", "commit.gpgsign", "false"]);
	git(["config", "tag.gpgsign", "false"]);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	copyFileSync(releaseScript, join(dir, "scripts", "release.mjs"));
	copyFileSync(helperScript, join(dir, "scripts", "release_helper.mjs"));
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify({ name: "fixture", version: "0.5.1", repository: { type: "git", url: "git+https://github.com/zhuxixi/pi-agent-board.git" } }, null, "\t")}\n`,
	);
	writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG_STUB);
	writeFileSync(join(dir, "a.txt"), "base\n");
	git(["add", "."]);
	git(["commit", "-q", "-m", "feat: base (#70)"]);
	if (tag) git(["tag", "v0.5.1"]);
	execFileSync("git", ["init", "-q", "--bare", origin]);
	git(["remote", "add", "origin", origin]);
	git(["push", "-q", "-u", "origin", "main"]);
	writeFileSync(join(dir, "b.txt"), "fix\n");
	git(["add", "."]);
	git(["commit", "-q", "-m", "fix: later (#78)"]);
	git(["push", "-q", "origin", "main"]);
	return { dir, origin };
}

/** Run the release CLI in a fixture dir; returns {code, stdout, json}. */
function runCli(dir, args) {
	let code = 0;
	let stdout = "";
	try {
		stdout = execFileSync(process.execPath, [join(dir, "scripts", "release.mjs"), ...args], { cwd: dir, encoding: "utf8" });
	} catch (err) {
		code = err.status ?? 1;
		stdout = err.stdout ?? "";
	}
	return {
		code,
		stdout,
		json: (() => {
			try {
				return JSON.parse(stdout);
			} catch {
				return null;
			}
		})(),
	};
}

const greenState = {
	branch: "main",
	clean: true,
	ahead: 0,
	behind: 0,
	openReleasePrs: 0,
	lastTag: "v0.8.0",
	lastTagReachable: true,
	functionalCommits: 4,
};

test("releaseBranchName uses the release/v prefix", () => {
	assert.equal(releaseBranchName("0.9.0"), "release/v0.9.0");
});

test("extractReleaseSection returns one section without the link reference", () => {
	const top = extractReleaseSection(CHANGELOG_STUB, "0.5.1");
	assert.ok(top.startsWith("## [0.5.1] - 2026-08-30"));
	assert.ok(top.includes("- base (#70)"));
	assert.ok(!top.includes("[0.5.1]: http"), "link reference definition is stripped");
	assert.ok(!top.includes("0.5.0"), "the next section is not included");
	const older = extractReleaseSection(CHANGELOG_STUB, "0.5.0");
	assert.ok(older.startsWith("## [0.5.0] - 2026-08-20"));
	assert.ok(older.includes("- older (#60)"));
	assert.ok(!older.includes("[0.5.0]: http"));
});

test("extractReleaseSection is exact about versions and missing sections", () => {
	assert.equal(extractReleaseSection(CHANGELOG_STUB, "0.5.2"), null);
	assert.equal(extractReleaseSection(CHANGELOG_STUB, "0.5.10"), null, "a longer version must not match a shorter section");
	assert.equal(extractReleaseSection(CHANGELOG_STUB, "0.5"), null);
	assert.equal(extractReleaseSection("# Changelog\n", "0.5.1"), null);
});

test("evaluatePreconditions passes a clean, synced, in-flight-free main", () => {
	const verdict = evaluatePreconditions(greenState);
	assert.deepEqual(verdict, { ok: true, failures: [] });
});

test("evaluatePreconditions reports every blocking failure", () => {
	const verdict = evaluatePreconditions({
		branch: "release/v0.8.0",
		clean: false,
		ahead: 2,
		behind: 1,
		openReleasePrs: 1,
		lastTag: "v0.8.0",
		lastTagReachable: false,
		functionalCommits: 0,
	});
	assert.equal(verdict.ok, false);
	assert.equal(verdict.failures.length, 7);
	assert.ok(verdict.failures.some((f) => f.includes("must run on main")));
	assert.ok(verdict.failures.some((f) => f.includes("dirty")));
	assert.ok(verdict.failures.some((f) => f.includes("behind")));
	assert.ok(verdict.failures.some((f) => f.includes("ahead")));
	assert.ok(verdict.failures.some((f) => f.includes("open release/* PR")));
	assert.ok(verdict.failures.some((f) => f.includes("orphan tag")));
	assert.ok(verdict.failures.some((f) => f.includes("nothing to release")));
});

test("evaluatePreconditions tolerates an unavailable release-PR check and a first-ever release", () => {
	const verdict = evaluatePreconditions({ ...greenState, openReleasePrs: null, lastTag: null, lastTagReachable: true });
	assert.deepEqual(verdict, { ok: true, failures: [] });
});

test("parseArgs dispatches commands and rejects unknown commands and flags", () => {
	assert.deepEqual(parseArgs(["precheck"]), { command: "precheck", arg: undefined, dryRun: false, syncMain: false });
	assert.deepEqual(parseArgs(["finish", "0.9.0", "--dry-run", "--sync-main"]), { command: "finish", arg: "0.9.0", dryRun: true, syncMain: true });
	assert.throws(() => parseArgs([]), /unknown command/);
	assert.throws(() => parseArgs(["publish"]), /unknown command "publish"/);
	assert.throws(() => parseArgs(["precheck", "--dryrun"]), /unknown flag "--dryrun"/);
});

test("precheck passes on a clean fixture and fails on a dirty tree", () => {
	const { dir } = makeFixture();
	try {
		const clean = runCli(dir, ["precheck"]);
		assert.equal(clean.code, 0);
		assert.equal(clean.json.ok, true);
		assert.equal(clean.json.lastTag, "v0.5.1");
		assert.equal(clean.json.functionalCommits, 1);
		writeFileSync(join(dir, "scratch.txt"), "wip\n");
		const dirty = runCli(dir, ["precheck"]);
		assert.equal(dirty.code, 1);
		assert.equal(dirty.json.ok, false);
		assert.ok(dirty.json.failures.some((f) => f.includes("dirty")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prepare --dry-run previews the section without touching the repo", () => {
	const { dir } = makeFixture();
	try {
		const before = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
		const { code, json } = runCli(dir, ["prepare", "minor", "--dry-run"]);
		assert.equal(code, 0);
		assert.equal(json.dry_run, true);
		assert.equal(json.current_version, "0.5.1");
		assert.equal(json.new_version, "0.6.0");
		assert.equal(json.last_tag, "v0.5.1");
		assert.match(json.changelog_preview, /^## \[0\.6\.0\] - \d{4}-\d{2}-\d{2}/);
		assert.ok(json.changelog_preview.includes("- later (#78)"));
		assert.ok(json.changelog_preview.includes("v0.5.1...v0.6.0"));
		assert.equal(json.next, "node scripts/release.mjs open-pr 0.6.0");
		assert.equal(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), before, "dry-run must not write the changelog");
		assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim(), "fix: later (#78)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prepare writes the section, bumps, tags, and switches to the release branch", () => {
	const { dir } = makeFixture();
	try {
		const { code, json } = runCli(dir, ["prepare", "minor"]);
		assert.equal(code, 0);
		assert.equal(json.version, "0.6.0");
		assert.equal(json.branch, "release/v0.6.0");
		assert.equal(json.tag, "v0.6.0");
		const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
		assert.ok(changelog.indexOf("## [0.6.0]") < changelog.indexOf("## [0.5.1]"), "new section goes on top");
		assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "0.6.0");
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim(), "release/v0.6.0");
		assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim(), "0.6.0", "npm version created the bump commit");
		assert.equal(execFileSync("git", ["rev-parse", "--verify", "refs/tags/v0.6.0"], { cwd: dir, encoding: "utf8" }).trim().length, 40);
		// The gate is main-only: a second run on the release branch must refuse.
		const again = runCli(dir, ["prepare", "patch"]);
		assert.equal(again.code, 1);
		assert.match(again.json.error, /must run on main/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("notes prints the section body, and open-pr --dry-run lists the push and PR steps", () => {
	const { dir } = makeFixture();
	try {
		runCli(dir, ["prepare", "minor"]);
		const notes = runCli(dir, ["notes", "0.6.0"]);
		assert.equal(notes.code, 0);
		assert.ok(notes.stdout.startsWith("## [0.6.0]"));
		assert.ok(notes.stdout.includes("- later (#78)"));
		assert.ok(!notes.stdout.includes("[0.6.0]: http"));
		const missing = runCli(dir, ["notes", "9.9.9"]);
		assert.equal(missing.code, 1);
		assert.match(missing.json.error, /no \[9\.9\.9\] section/);
		const pr = runCli(dir, ["open-pr", "0.6.0", "--dry-run"]);
		assert.equal(pr.code, 0);
		assert.deepEqual(pr.json.commands, [
			"git push -u origin release/v0.6.0",
			"git push origin v0.6.0",
			'gh pr create --base main --head release/v0.6.0 --title "chore: release 0.6.0"',
		]);
		const wrongVersion = runCli(dir, ["open-pr", "0.6.1", "--dry-run"]);
		assert.equal(wrongVersion.code, 1);
		assert.match(wrongVersion.json.error, /expected 0\.6\.1/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prepare handles a repository with no tags yet (first release)", () => {
	const { dir } = makeFixture({ tag: false });
	try {
		const precheck = runCli(dir, ["precheck"]);
		assert.equal(precheck.code, 0);
		assert.equal(precheck.json.lastTag, null);
		assert.equal(precheck.json.functionalCommits, 2, "every functional commit counts before the first tag");
		const { code, json } = runCli(dir, ["prepare", "patch", "--dry-run"]);
		assert.equal(code, 0);
		assert.equal(json.new_version, "0.5.2");
		assert.equal(json.last_tag, null);
		assert.ok(json.changelog_preview.includes("- base (#70)"));
		assert.ok(json.changelog_preview.includes("- later (#78)"));
		assert.ok(!json.changelog_preview.includes("[0.5.2]: http"), "no compare link without a previous tag");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("finish refuses a squash-merged (orphan) tag and passes once the tag is on main", () => {
	const { dir, origin } = makeFixture();
	try {
		runCli(dir, ["prepare", "minor"]);
		// The tag exists locally but main never got it: the squash-merge shape.
		const orphan = runCli(dir, ["finish", "0.6.0"]);
		assert.equal(orphan.code, 1);
		assert.match(orphan.json.error, /not an ancestor of origin\/main/);
		assert.match(orphan.json.error, /squash-merged/);
		execFileSync("git", ["push", "-q", "origin", "v0.6.0", "HEAD:main"], { cwd: dir, encoding: "utf8" });
		const ok = runCli(dir, ["finish", "0.6.0", "--dry-run"]);
		assert.equal(ok.code, 0);
		assert.equal(ok.json.tag, "v0.6.0");
		assert.ok(ok.json.notes.includes("- later (#78)"));
		assert.equal(ok.json.commands[0], "gh release create v0.6.0 --title v0.6.0 --notes-file <notes>");
		// The remote is the fixture's bare repo, and the release was never created.
		assert.equal(execFileSync("git", ["--git-dir", origin, "tag", "-l", "v0.6.0"], { encoding: "utf8" }).trim(), "v0.6.0");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(origin, { recursive: true, force: true });
	}
});
