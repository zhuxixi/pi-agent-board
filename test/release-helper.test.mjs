import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	changelogTopPrs,
	functionalLines,
	generateChangelog,
	insertSection,
	nextVersion,
	parseCommitLines,
	verifyFrom,
} from "../scripts/release_helper.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/release_helper.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Current version from package.json, and its next patch — dynamic so these
 * tests survive future releases (review finding: hardcoded 0.5.2/0.5.3
 * would fail on the first release run under this process). */
function currentAndNextPatch() {
	const current = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
	const [a, b, c] = current.split(".").map(Number);
	return { current, next: `${a}.${b}.${c + 1}` };
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

test("CLI --dry-run previews the next section without touching CHANGELOG.md (issue #64 A1)", () => {
	const { current, next } = currentAndNextPatch();
	const out = execFileSync(process.execPath, [scriptPath, "--dry-run", "patch"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	const result = JSON.parse(out);
	assert.equal(result.current_version, current);
	assert.match(result.changelog_preview, new RegExp(`^## \\[${next.replace(/\./g, "\\.")}] - \\d{4}-\\d{2}-\\d{2}`));
	assert.match(result.changelog_preview, /^### (Features|Fixes|Performance|Changes|\[)/m);
	// Dry-run must not write: the next-version section stays absent.
	const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
	assert.ok(!changelog.includes(`[${next}]`), "dry-run must not write CHANGELOG.md");
});

test("CLI verify exits 1 with missing PRs while the changelog is a stub, 0 once populated (issue #64 A4)", () => {
	const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
	const hasTopSection = /^##\s*\[/m.test(changelog);
	let stdout = "";
	let caught = null;
	try {
		stdout = execFileSync(process.execPath, [scriptPath, "verify"], { cwd: repoRoot, encoding: "utf8" });
	} catch (err) {
		caught = err;
		stdout = err.stdout ?? "";
	}
	const result = JSON.parse(stdout);
	if (!hasTopSection) {
		assert.ok(caught, "verify must exit nonzero while the changelog is a stub");
		assert.equal(result.ok, false);
		assert.ok(result.missing.length >= 1, "missing list covers PRs since the last tag");
	} else {
		// Once populated, verify's ok depends on process state (mid-cycle merges
		// legitimately report drift) — assert the CLI invariant instead: the exit
		// code always agrees with result.ok.
		assert.equal(Boolean(caught), !result.ok, "verify exit code must agree with result.ok");
	}
});
