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
