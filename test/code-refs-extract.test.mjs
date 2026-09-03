import assert from "node:assert/strict";
import { test } from "node:test";
import {
	builtinProviders,
	extractCodeRefs,
	genericFallbackProvider,
	parseRemoteHost,
	parseRemotePath,
} from "../src/core/code-refs.mjs";

const github = () => builtinProviders()[0];

test("assign claim beats a later plain issue view of another number", () => {
	const result = extractCodeRefs(
		{
			commands: [
				{ command: "gh issue edit 40 --add-assignee alice" },
				{ command: "gh issue view 99" },
			],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: null,
			host: null,
		},
		github()
	);
	assert.equal(result.provider, "github");
	assert.equal(result.issue.number, 40);
	assert.equal(result.issue.strength, "claim");
	assert.equal(result.issue.confidence, "high");
	assert.equal(result.issue.lastIndex, 0);
	assert.equal(result.pr, null);
});

test("worktree path yields issue 40 claim with zero commands", () => {
	const result = extractCodeRefs(
		{
			commands: [],
			assistantTexts: [],
			worktreePath: "/home/user/issue-40-code-refs-badges",
			branch: null,
			repoUrl: null,
			host: null,
		},
		github()
	);
	assert.equal(result.issue.number, 40);
	assert.equal(result.issue.strength, "claim");
	assert.equal(result.issue.source, "worktree");
	assert.equal(result.pr, null);
});

test("gh pr create resolves pr from a later URL and back-links issue 40", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: 'gh pr create --body "issue #40"' }],
			assistantTexts: ["created https://github.com/owner/repo/pull/45"],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.pr.number, 45);
	assert.equal(result.pr.strength, "action");
	assert.equal(result.pr.source, "create-url");
	assert.equal(result.pr.confidence, "high");
	assert.equal(result.issue.number, 40);
	assert.equal(result.issue.strength, "claim");
	assert.equal(result.issue.source, "pr-body");
	assert.equal(result.pr.url, "https://github.com/owner/repo/pull/45");
	assert.equal(result.issue.url, "https://github.com/owner/repo/issues/40");
});

test("pr-body back-link is case-insensitive (Closes #40)", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: 'gh pr create --body "Closes #40"' }],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.issue.number, 40);
	assert.equal(result.issue.strength, "claim");
	assert.equal(result.issue.source, "pr-body");
});

test("pr create body back-link word boundaries and number guard (issue #65)", () => {
	const run = (body) =>
		extractCodeRefs(
			{
				commands: [{ command: `gh pr create --title t --body "${body}"` }],
				assistantTexts: [],
				worktreePath: null,
				branch: null,
				repoUrl: "owner/repo",
				host: "github.com",
			},
			github()
		);
	// Embedded-keyword prose must not match.
	assert.equal(run("prefix #1 disclose #2 unresolved #3").issue, null);
	// 8-digit numbers are rejected wholesale, not truncated to 7 digits.
	assert.equal(run("closes #12345678").issue, null);
	// Canonical and legacy forms keep working.
	assert.equal(run("fixes issue #40").issue?.number, 40);
	assert.equal(run("fixes issue #40").issue?.source, "pr-body");
});

test("follow-up evidence rejects bare issue mentions (issue #65)", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh pr create --title t" }],
			assistantTexts: ["review report flags issue #40 and fixes issue #41"],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	// The follow-up matcher accepts canonical closing syntax only: a bare
	// `issue #40` mention and the non-canonical `fixes issue #41` form must
	// never become a pr-backlink claim. (Each bare number appears exactly
	// once, so the mention fallback stays silent too.)
	assert.equal(result.issue, null);
	assert.ok(!result.allRefs.some((r) => r.source === "pr-backlink"));
});

test("null host with a host-templated provider yields no url (no malformed link)", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh issue comment 40 --body hi" }],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: null,
		},
		github()
	);
	assert.equal(result.issue.number, 40);
	assert.equal(result.issue.url, null);
});

test("echo back-link command between two pr creates is ignored (issue #65)", () => {
	const result = extractCodeRefs(
		{
			commands: [
				{ command: "gh pr create --title A" },
				{ command: 'echo "closes #40"' },
				{ command: "gh pr create --title B" },
			],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	// Later commands are never scanned as PR back-links, and two PR creates
	// disable the assistant scan — so nothing is extracted here.
	assert.equal(result.issue, null);
});

test("assistant back-link with two pr creates produces no pr-backlink (issue #65)", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh issue comment 40 --body hi" }, { command: "gh pr create --title A" }, { command: "gh pr create --title B" }],
			assistantTexts: ["PR B closes #60"],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	// Ambiguous attribution (two PR creates) → assistant scan skipped; the
	// issue falls back to the plain command action, never a guessed PR link.
	assert.equal(result.issue?.number, 40);
	assert.equal(result.issue?.strength, "action");
	assert.equal(result.issue?.source, "command");
	assert.ok(!result.allRefs.some((r) => r.source === "pr-backlink"));
});

test("pr create back-link found in a later assistant message", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh pr create --title t --body-file /tmp/body.md" }],
			assistantTexts: ["Opened the PR. This PR closes #40."],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.issue.number, 40);
	assert.equal(result.issue.strength, "claim");
	assert.equal(result.issue.source, "pr-backlink");
	assert.equal(result.pr, null); // no URL anywhere — create stays unresolved
});

test("pr create with no back-link anywhere yields no issue ref", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh pr create --title t" }],
			assistantTexts: ["Opened the PR, will link later."],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.issue, null);
	assert.equal(result.pr, null);
});

test("viewing 439/440/441 once each and commenting 453 twice", () => {
	const result = extractCodeRefs(
		{
			commands: [
				{ command: "gh issue view 439" },
				{ command: "gh issue view 440" },
				{ command: "gh issue view 441" },
				{ command: "gh pr comment 453" },
				{ command: "gh pr comment 453" },
			],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: null,
			host: null,
		},
		github()
	);
	assert.equal(result.issue, null);
	assert.equal(result.pr.number, 453);
	assert.equal(result.pr.strength, "action");
	assert.equal(result.pr.confidence, "high");
});

test("mention fallback picks #40 (5x) over #7 (2x)", () => {
	const result = extractCodeRefs(
		{
			commands: [],
			assistantTexts: ["#40", "#40", "#40", "#40", "#40", "#7", "#7"],
			worktreePath: null,
			branch: null,
			repoUrl: null,
			host: null,
		},
		github()
	);
	assert.equal(result.issue.number, 40);
	assert.equal(result.issue.strength, "mention");
	assert.equal(result.issue.confidence, "low");
	assert.equal(result.issue.url, null);
	assert.equal(result.pr, null);
});

test("mention fallback yields no winner when #40 x3 and #41 x3", () => {
	const result = extractCodeRefs(
		{
			commands: [],
			assistantTexts: ["#40", "#40", "#40", "#41", "#41", "#41"],
			worktreePath: null,
			branch: null,
			repoUrl: null,
			host: null,
		},
		github()
	);
	assert.equal(result.issue, null);
	assert.equal(result.pr, null);
});

test("unresolved gh pr create yields pr null", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh pr create --title t" }],
			assistantTexts: ["no url here"],
			worktreePath: null,
			branch: null,
			repoUrl: null,
			host: null,
		},
		github()
	);
	assert.equal(result.pr, null);
	assert.equal(result.issue, null);
});

test("gh pr create resolves from a later command containing the PR URL", () => {
	const result = extractCodeRefs(
		{
			commands: [
				{ command: "gh pr create --title t" },
				{ command: "echo created https://github.com/owner/repo/pull/45" },
			],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: null,
			host: null,
		},
		github()
	);
	assert.equal(result.pr.number, 45);
	assert.equal(result.pr.strength, "action");
	assert.equal(result.pr.source, "create-url");
});

test("two pr actions at different indexes pick the later one", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh pr checkout 10" }, { command: "gh pr comment 20" }],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: null,
			host: null,
		},
		github()
	);
	assert.equal(result.pr.number, 20);
	assert.equal(result.pr.strength, "action");
});

test("empty input yields an empty result", () => {
	const result = extractCodeRefs(
		{
			commands: [],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: null,
			host: null,
		},
		github()
	);
	assert.equal(result.provider, "github");
	assert.equal(result.issue, null);
	assert.equal(result.pr, null);
	assert.deepEqual(result.allRefs, []);
});

test("null host with generic fallback still extracts from URLs", () => {
	const result = extractCodeRefs(
		{
			commands: [],
			assistantTexts: [
				"see https://example.com/team/app/pull/45",
				"see https://example.com/team/app/issues/40",
				"again https://example.com/team/app/issues/40",
			],
			worktreePath: null,
			branch: null,
			repoUrl: null,
			host: null,
		},
		genericFallbackProvider()
	);
	assert.equal(result.provider, "generic");
	assert.equal(result.pr.number, 45);
	assert.equal(result.pr.strength, "action");
	assert.equal(result.issue.number, 40);
	assert.equal(result.issue.strength, "view");
	assert.equal(result.issue.confidence, "medium");
	assert.equal(result.issue.url, null);
});

test("parseRemoteHost and parseRemotePath parse https and ssh remotes", () => {
	assert.equal(parseRemoteHost("https://github.com/zhuxixi/pi-agent-board.git"), "github.com");
	assert.equal(parseRemoteHost("git@gitlab.example.com:team/demo.git"), "gitlab.example.com");
	assert.equal(parseRemoteHost("https://host.example.com:8443/group/sub/repo.git"), "host.example.com");
	assert.equal(parseRemotePath("https://github.com/zhuxixi/pi-agent-board.git"), "zhuxixi/pi-agent-board");
	assert.equal(parseRemotePath("git@gitlab.example.com:team/demo.git"), "team/demo");
	assert.equal(parseRemotePath("https://host.example.com/group/sub/repo.git"), "group/sub/repo");
	assert.equal(parseRemoteHost(null), null);
	assert.equal(parseRemoteHost(""), null);
	assert.equal(parseRemotePath(null), null);
	assert.equal(parseRemotePath("not a remote"), null);
});

test("user rule foo(\\d*) matching foo yields no ref (non-positive number guard)", () => {
	const provider = {
		name: "test",
		hosts: [],
		issuePrefix: "#",
		prPrefix: "#",
		urlTemplates: null,
		rules: [{ regex: /foo(\d*)/, pattern: "foo(\\d*)", kind: "issue", strength: "claim", numberFrom: "capture" }],
	};
	const result = extractCodeRefs(
		{
			commands: [{ command: "foo" }],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: null,
			host: null,
		},
		provider
	);
	assert.equal(result.issue, null);
	assert.equal(result.pr, null);
	assert.deepEqual(result.allRefs, []);
});

test("issue 65 regression: CR-report finding numbers never become pr-backlinks", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: 'gh pr create --title fix --body "Closes #19"' }],
			assistantTexts: [
				"CR 报告：本轮仅验证上轮 issue #1（no-pushback）",
				"pushback verdict for issue #1",
			],
			worktreePath: "/repo/.pi/worktrees/issue-19-fix-thing",
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.issue?.number, 19);
	assert.ok(!result.allRefs.some((r) => r.kind === "issue" && r.number === 1));
});

test("later assistant bare issue mentions and non-canonical forms are not pr back-links", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh pr create --title t" }],
			assistantTexts: [
				"Progress note: 上轮 issue #1 已验证",
				"pushback verdict for issue #1, plus prefix #2 disclose #3",
			],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.issue, null);
	assert.ok(!result.allRefs.some((r) => r.source === "pr-backlink"));
});

test("later close/comment/echo commands are not promoted to pr back-links", () => {
	const result = extractCodeRefs(
		{
			commands: [
				{ command: 'gh pr create --title t --body "Closes #19"' },
				{ command: "gh issue close #21" },
				{ command: 'gh pr comment 20 --body "fixes #21"' },
				{ command: 'echo "closes #21"' },
			],
			assistantTexts: [],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.issue?.number, 19);
	assert.ok(!result.allRefs.some((r) => r.source === "pr-backlink"));
	// #21 keeps its own plain command-action semantics (not a PR back-link).
	const ref21 = result.allRefs.find((r) => r.kind === "issue" && r.number === 21);
	assert.equal(ref21?.source, "command");
});

test("follow-up back-link still found in later assistant message with a single pr create", () => {
	const result = extractCodeRefs(
		{
			commands: [{ command: "gh pr create --title t --body-file /tmp/body.md" }],
			assistantTexts: ["Opened the PR. This PR closes #40."],
			worktreePath: null,
			branch: null,
			repoUrl: "owner/repo",
			host: "github.com",
		},
		github()
	);
	assert.equal(result.issue?.number, 40);
	assert.equal(result.issue?.source, "pr-backlink");
});
