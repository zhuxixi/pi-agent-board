import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	hasSection,
	changelogTopPrs,
	functionalLines,
	generateChangelog,
	insertSection,
	nextVersion,
	parseCommitLines,
	verifyFrom,
} from "../scripts/release_helper.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/release_helper.mjs", import.meta.url));

/**
 * Self-contained git fixture: tag v0.5.1, then a fix (#78) and a version
 * squash (skipped), plus a CHANGELOG stub. CLI tests run against this —
 * never against the host repo, whose tags/history differ between local
 * checkouts and CI shallow clones (the round-1 CI failure).
 * @param {string} changelogBody
 */
function makeFixtureRepo(changelogBody = "# Changelog\n") {
	const dir = mkdtempSync(join(tmpdir(), "relhelper-"));
	const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	git(["init", "-q"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "test"]);
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "0.5.2" }, null, "\t") + "\n");
	writeFileSync(join(dir, "a.txt"), "tagged base\n");
	git(["add", "."]);
	git(["commit", "-q", "-m", "feat: base (#70)"]);
	git(["tag", "v0.5.1"]);
	writeFileSync(join(dir, "b.txt"), "fix\n");
	git(["add", "."]);
	git(["commit", "-q", "-m", "fix: second (#78)"]);
	writeFileSync(join(dir, "c.txt"), "squash\n");
	git(["add", "."]);
	git(["commit", "-q", "-m", "0.5.2 (#74)"]);
	writeFileSync(join(dir, "CHANGELOG.md"), changelogBody);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	copyFileSync(scriptPath, join(dir, "scripts", "release_helper.mjs"));
	return dir;
}

/** Run the CLI in a fixture dir; returns {code, json}. */
function runCli(dir, args) {
	let caught = null;
	let stdout = "";
	try {
		stdout = execFileSync(process.execPath, [join(dir, "scripts", "release_helper.mjs"), ...args], { cwd: dir, encoding: "utf8" });
	} catch (err) {
		caught = err;
		stdout = err.stdout ?? "";
	}
	return { code: caught ? caught.status ?? 1 : 0, stdout, json: (() => { try { return JSON.parse(stdout); } catch { return null; } })() };
}

test("parseCommitLines parses conventional subjects with scope, bang, and PR", () => {
	const entries = parseCommitLines([
		"feat(core): add launch options picker (#52)",
		"fix!: breaking fix without pr",
		"docs: windows ime note (#38)",
		"some plain subject (#9)",
	]);
	assert.deepEqual(entries[0], { type: "feat", scope: "core", message: "add launch options picker", pr: 52 });
	assert.deepEqual(entries[1], { type: "fix", scope: "", message: "breaking fix without pr", pr: null });
	assert.deepEqual(entries[2], { type: "docs", scope: "", message: "windows ime note", pr: 38 });
	assert.deepEqual(entries[3], { type: "other", scope: "", message: "some plain subject (#9)", pr: 9 });
});

test("parseCommitLines skips version squashes, bump subjects, and merges; dedupes", () => {
	const entries = parseCommitLines([
		"0.5.2 (#74)",
		"chore: bump version to 0.6.0",
		"Merge pull request #67 from zhuxixi/some-branch",
		"fix: same message (#12)",
		"fix: same message (#12)",
	]);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].pr, 12);
});

test("generateChangelog groups features/fixes/perf/changes and links compare", () => {
	const section = generateChangelog({
		version: "0.6.0",
		date: "2026-09-06",
		prevTag: "v0.5.2",
		entries: [
			{ type: "fix", scope: "", message: "a fix", pr: 78 },
			{ type: "feat", scope: "ui", message: "a feature", pr: 79 },
			{ type: "perf", scope: "", message: "faster", pr: null },
			{ type: "docs", scope: "", message: "note", pr: 80 },
		],
	});
	const lines = section.split("\n");
	assert.equal(lines[0], "## [0.6.0] - 2026-09-06");
	assert.ok(lines.indexOf("### Features") < lines.indexOf("### Fixes"));
	assert.ok(section.includes("- **ui**: a feature (#79)"));
	assert.ok(section.includes("- a fix (#78)"));
	assert.ok(section.includes("### Performance"));
	assert.ok(section.includes("### Changes"));
	assert.ok(section.endsWith("[0.6.0]: https://github.com/zhuxixi/pi-agent-board/compare/v0.5.2...v0.6.0"));
});

test("changelogTopPrs reads only the first section", () => {
	const text = [
		"# Changelog",
		"",
		"## [0.6.0] - 2026-09-06",
		"",
		"- a (#78)",
		"- b (#79)",
		"",
		"## [0.5.2] - 2026-08-30",
		"",
		"- old (#70)",
	].join("\n");
	assert.deepEqual([...changelogTopPrs(text)].sort(), [78, 79]);
	assert.deepEqual([...changelogTopPrs("no sections yet")], []);
});

test("functionalLines whitelists types, skips changelog maintenance and merges", () => {
	const out = functionalLines([
		"feat: x (#1)",
		"chore: noise (#2)",
		"docs(changelog): fix entry (#3)",
		"docs: real doc (#4)",
		"Merge pull request #5",
		"0.6.0 (#6)",
		"refactor(api)!: rename (#7)",
	]);
	assert.deepEqual(out, ["feat: x (#1)", "docs: real doc (#4)", "refactor(api)!: rename (#7)"]);
});

test("verifyFrom reports missing functional PRs and ok when covered", () => {
	const covered = verifyFrom({
		lines: ["feat: x (#78)", "fix: y (#79)", "chore: z (#80)"],
		changelogText: "## [0.6.0] - d\n\n- x (#78)\n- y (#79)\n",
	});
	assert.equal(covered.ok, true);
	assert.deepEqual(covered.missing, []);
	const drifted = verifyFrom({
		lines: ["feat: x (#78)", "fix: late merge (#82)"],
		changelogText: "## [0.6.0] - d\n\n- x (#78)\n",
	});
	assert.equal(drifted.ok, false);
	assert.deepEqual(drifted.missing, [82]);
	assert.deepEqual(drifted.extra, []);
});

test("insertSection prepends above existing sections and after a bare header", () => {
	const existing = "# Changelog\n\n## [0.5.2] - 2026-08-30\n\n- old (#70)\n";
	const withSection = insertSection(existing, "## [0.6.0] - d\n\n- new (#78)");
	assert.ok(withSection.indexOf("## [0.6.0]") < withSection.indexOf("## [0.5.2]"));
	const stub = insertSection("# Changelog\n", "## [0.6.0] - d\n\n- new (#78)");
	assert.ok(stub.startsWith("# Changelog\n"));
	assert.ok(stub.includes("## [0.6.0]"));
});

test("nextVersion compares component-wise and rejects non-increasing versions", () => {
	assert.equal(nextVersion("0.10.0", "0.5.2"), "0.10.0");
	assert.equal(nextVersion("10.0.0", "9.9.9"), "10.0.0");
	assert.equal(nextVersion("0.5.3", "0.5.2"), "0.5.3");
	assert.throws(() => nextVersion("0.5.2", "0.5.2"), /not greater/);
	assert.throws(() => nextVersion("0.5.1", "0.5.2"), /not greater/);
	assert.throws(() => nextVersion("bogus", "0.5.2"), /invalid version/);
});

test("hasSection detects an existing version section (apply idempotency guard, CR round 1)", () => {
	const existing = "# Changelog\n\n## [0.5.3] - 2026-09-06\n\n- x (#78)\n";
	assert.equal(hasSection(existing, "0.5.3"), true);
	assert.equal(hasSection(existing, "0.5.4"), false);
	assert.equal(hasSection("# Changelog\n", "0.5.3"), false);
	assert.equal(hasSection("## [0.5.30]", "0.5.3"), false, "prefix must not match a longer version");
});

test("CLI dry-run previews the next section from the tag range without writing (issue #64 A1)", () => {
	const dir = makeFixtureRepo();
	try {
		const { code, json } = runCli(dir, ["--dry-run", "patch"]);
		assert.equal(code, 0);
		assert.equal(json.current_version, "0.5.2");
		assert.equal(json.new_version, "0.5.3");
		assert.match(json.changelog_preview, /^## \[0\.5\.3\] - \d{4}-\d{2}-\d{2}/);
		assert.match(json.changelog_preview, /### Fixes/);
		assert.match(json.changelog_preview, /- second \(#78\)/);
		assert.ok(!json.changelog_preview.includes("(#70)"), "range starts at the tag, not full history");
		assert.ok(!json.changelog_preview.includes("0.5.2 (#74)"), "version squash skipped");
		assert.ok(json.changelog_preview.includes("v0.5.1...v0.5.3"), "compare link");
		assert.ok(!readFileSync(join(dir, "CHANGELOG.md"), "utf8").includes("[0.5.3]"), "dry-run must not write");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI verify + apply + re-verify lifecycle on the fixture (issue #64 A2/A4)", () => {
	const dir = makeFixtureRepo();
	try {
		// Stub changelog: the fix PR is missing → exit 1 with the missing list.
		const stub = runCli(dir, ["verify"]);
		assert.equal(stub.code, 1);
		assert.equal(stub.json.ok, false);
		assert.deepEqual(stub.json.missing, [78]);
		// Apply inserts the section (idempotency guard not triggered first time).
		const apply = runCli(dir, ["patch"]);
		assert.equal(apply.code, 0);
		const written = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
		assert.ok(written.includes("## [0.5.3]"));
		assert.ok(written.includes("- second (#78)"));
		// Now verify passes.
		const verified = runCli(dir, ["verify"]);
		assert.equal(verified.code, 0);
		assert.equal(verified.json.ok, true);
		// Re-apply the same version is refused (duplicate-section guard).
		const reapply = runCli(dir, ["patch"]);
		assert.equal(reapply.code, 1);
		assert.match(reapply.json.error, /already has a \[0\.5\.3\] section/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
