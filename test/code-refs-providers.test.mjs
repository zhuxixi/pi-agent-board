import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	builtinProviders,
	clearProvidersCacheForTests,
	genericFallbackProvider,
	loadProviders,
	matchProvider,
	mergeProviders,
	validateProvider,
} from "../src/core/code-refs.mjs";

const VALID_KINDS = ["issue", "pr"];
const VALID_STRENGTHS = ["claim", "action", "view"];
const VALID_NUMBER_FROM = ["capture", "outputUrl"];

/** First rule whose regex matches `text`, plus the captured number. */
function capture(provider, text) {
	for (const rule of provider.rules) {
		const m = rule.regex.exec(text);
		if (m) return { kind: rule.kind, strength: rule.strength, number: m[1] };
	}
	return null;
}

test("builtinProviders returns github and gitlab bundles with valid rule shapes", () => {
	const providers = builtinProviders();
	assert.deepEqual(
		providers.map((p) => p.name),
		["github", "gitlab"]
	);
	for (const p of providers) {
		assert.ok(Array.isArray(p.hosts));
		assert.equal(typeof p.issuePrefix, "string");
		assert.equal(typeof p.prPrefix, "string");
		assert.ok(p.urlTemplates && typeof p.urlTemplates === "object");
		assert.ok(p.rules.length > 0);
		for (const r of p.rules) {
			assert.ok(r.regex instanceof RegExp, `regex for ${r.pattern} did not compile`);
			assert.equal(typeof r.pattern, "string");
			assert.ok(VALID_KINDS.includes(r.kind), `bad kind ${r.kind}`);
			assert.ok(VALID_STRENGTHS.includes(r.strength), `bad strength ${r.strength}`);
			assert.ok(VALID_NUMBER_FROM.includes(r.numberFrom), `bad numberFrom ${r.numberFrom}`);
		}
	}
	const gh = providers[0];
	const gl = providers[1];
	assert.deepEqual(gh.hosts, ["github.com"]);
	assert.deepEqual(gl.hosts, ["gitlab.com"]);
	assert.equal(gh.issuePrefix, "#");
	assert.equal(gh.prPrefix, "▸#");
	assert.equal(gl.issuePrefix, "#");
	assert.equal(gl.prPrefix, "!");
	assert.equal(gh.rules.length, 9);
	assert.equal(gl.rules.length, 8);
	assert.equal(gh.urlTemplates.issue, "https://{host}/{owner}/{repo}/issues/{number}");
	assert.equal(gh.urlTemplates.pr, "https://{host}/{owner}/{repo}/pull/{number}");
	assert.equal(gl.urlTemplates.issue, "https://{host}/{owner}/{repo}/-/issues/{number}");
	assert.equal(gl.urlTemplates.pr, "https://{host}/{owner}/{repo}/-/merge_requests/{number}");
});

test("builtin github rules match the documented command shapes", () => {
	const gh = builtinProviders()[0];
	const cases = [
		["gh issue edit 40 --add-assignee alice", "issue", "claim", "40"],
		["gh issue edit 40 --title x", "issue", "action", "40"],
		["gh issue comment 40", "issue", "action", "40"],
		["gh issue close 40", "issue", "action", "40"],
		["gh issue create --title t", "issue", "action", undefined],
		["gh pr checkout 45", "pr", "action", "45"],
		["gh pr merge 45", "pr", "action", "45"],
		["gh pr create --fill", "pr", "action", undefined],
		["https://github.com/zhuxixi/pi-agent-board/pull/45", "pr", "action", "45"],
		["gh issue view 40", "issue", "view", "40"],
		["gh pr view 45", "pr", "view", "45"],
		["gh pr checks 45", "pr", "view", "45"],
		["https://github.com/zhuxixi/pi-agent-board/issues/40", "issue", "view", "40"],
	];
	for (const [text, kind, strength, number] of cases) {
		const hit = capture(gh, text);
		assert.ok(hit, `no rule matched: ${text}`);
		assert.equal(hit.kind, kind, text);
		assert.equal(hit.strength, strength, text);
		assert.equal(hit.number, number, text);
	}
});

test("builtin gitlab rules match the documented command shapes", () => {
	const gl = builtinProviders()[1];
	const cases = [
		["glab issue update 40 --assignee alice", "issue", "claim", "40"],
		["glab issue edit 40 --assignee alice", "issue", "claim", "40"],
		["glab issue note 40", "issue", "action", "40"],
		["glab issue comment 40", "issue", "action", "40"],
		["glab mr checkout 12", "pr", "action", "12"],
		["glab mr merge 12", "pr", "action", "12"],
		["glab mr create --title t", "pr", "action", undefined],
		["https://gitlab.com/group/app/-/merge_requests/12", "pr", "action", "12"],
		["glab issue view 40", "issue", "view", "40"],
		["glab mr view 12", "pr", "view", "12"],
		["https://gitlab.com/group/app/-/issues/40", "issue", "view", "40"],
	];
	for (const [text, kind, strength, number] of cases) {
		const hit = capture(gl, text);
		assert.ok(hit, `no rule matched: ${text}`);
		assert.equal(hit.kind, kind, text);
		assert.equal(hit.strength, strength, text);
		assert.equal(hit.number, number, text);
	}
});

test("genericFallbackProvider is host-agnostic with URL-only rules", () => {
	const g = genericFallbackProvider();
	assert.equal(g.name, "generic");
	assert.deepEqual(g.hosts, []);
	assert.equal(g.issuePrefix, "#");
	assert.equal(g.prPrefix, "▸#");
	assert.equal(g.urlTemplates, null);
	assert.equal(g.rules.length, 4);
	assert.deepEqual(
		g.rules.map((r) => `${r.kind}/${r.strength}`),
		["issue/view", "pr/action", "issue/view", "pr/action"]
	);
	for (const r of g.rules) assert.ok(r.regex instanceof RegExp);
	const cases = [
		["https://example.com/team/app/issues/40", "issue", "view", "40"],
		["https://example.com/team/app/pull/45", "pr", "action", "45"],
		["https://gitlab.example.com/team/app/-/issues/40", "issue", "view", "40"],
		["https://gitlab.example.com/team/app/-/merge_requests/12", "pr", "action", "12"],
	];
	for (const [text, kind, strength, number] of cases) {
		const hit = capture(g, text);
		assert.ok(hit, `no rule matched: ${text}`);
		assert.equal(hit.kind, kind, text);
		assert.equal(hit.strength, strength, text);
		assert.equal(hit.number, number, text);
	}
});

test("validateProvider compiles a valid provider", () => {
	const { provider, errors } = validateProvider({
		name: "internal",
		hosts: ["git.internal.example.com"],
		issuePrefix: "#",
		prPrefix: "!",
		urlTemplates: { issue: "https://{host}/issues/{number}", pr: "https://{host}/pr/{number}" },
		rules: [
			{ pattern: "ig\\s+issue\\s+view\\s+#?(\\d+)", kind: "issue", strength: "view" },
			{ pattern: "ig\\s+pr\\s+create\\b", kind: "pr", strength: "action", numberFrom: "outputUrl" },
		],
	});
	assert.deepEqual(errors, []);
	assert.equal(provider.name, "internal");
	assert.deepEqual(provider.hosts, ["git.internal.example.com"]);
	assert.equal(provider.issuePrefix, "#");
	assert.equal(provider.prPrefix, "!");
	assert.deepEqual(provider.urlTemplates, {
		issue: "https://{host}/issues/{number}",
		pr: "https://{host}/pr/{number}",
	});
	assert.equal(provider.rules.length, 2);
	assert.equal(provider.rules[0].numberFrom, "capture");
	assert.equal(provider.rules[1].numberFrom, "outputUrl");
	assert.ok(provider.rules[0].regex instanceof RegExp);
	assert.equal(provider.rules[0].regex.exec("ig issue view 99")[1], "99");
});

test("validateProvider skips rules with invalid regex", () => {
	const { provider, errors } = validateProvider({
		name: "internal",
		rules: [
			{ pattern: "(", kind: "issue", strength: "action" },
			{ pattern: "ig\\s+issue\\s+view\\s+#?(\\d+)", kind: "issue", strength: "view" },
		],
	});
	assert.equal(errors.length, 1);
	assert.match(errors[0], /rule 0/);
	assert.match(errors[0], /invalid regex/);
	assert.equal(provider.rules.length, 1);
	assert.equal(provider.rules[0].pattern, "ig\\s+issue\\s+view\\s+#?(\\d+)");
});

test("validateProvider rejects rules with missing or invalid fields", () => {
	const { provider, errors } = validateProvider({
		name: "internal",
		rules: [
			{ pattern: "a(\\d+)", strength: "view" },
			{ kind: "issue", strength: "view" },
			null,
			{ pattern: "b(\\d+)", kind: "issue", strength: "super" },
			{ pattern: "c(\\d+)", kind: "pr", strength: "action", numberFrom: "magic" },
		],
	});
	assert.equal(errors.length, 5);
	assert.equal(provider.rules.length, 0);
});

test("validateProvider returns null for non-object input or missing required fields", () => {
	assert.equal(validateProvider(null).provider, null);
	assert.equal(validateProvider("github").provider, null);
	assert.equal(validateProvider([]).provider, null);
	const noName = validateProvider({ rules: [] });
	assert.equal(noName.provider, null);
	assert.match(noName.errors[0], /name/);
	const noRules = validateProvider({ name: "x" });
	assert.equal(noRules.provider, null);
	assert.match(noRules.errors[0], /rules/);
	assert.equal(validateProvider({ name: "  " }).provider, null);
});

test("validateProvider records errors for malformed hosts and urlTemplates", () => {
	const { provider, errors } = validateProvider({
		name: "internal",
		hosts: ["ok.example.com", 5],
		urlTemplates: "https://{host}/i/{number}",
		rules: [{ pattern: "a(\\d+)", kind: "issue", strength: "view" }],
	});
	assert.deepEqual(provider.hosts, ["ok.example.com"]);
	assert.equal(provider.urlTemplates, undefined);
	assert.ok(errors.length >= 2);
	assert.match(errors[0], /hosts\[1\]/);

	const r2 = validateProvider({
		name: "internal",
		urlTemplates: { pr: 7 },
		rules: [{ pattern: "a(\\d+)", kind: "issue", strength: "view" }],
	});
	assert.deepEqual(r2.provider.urlTemplates, {});
	assert.ok(r2.errors.length >= 1);
	assert.match(r2.errors[0], /urlTemplates\.pr/);
});

test("validateProvider tolerates malformed optional fields", () => {
	const { provider, errors } = validateProvider({
		name: "internal",
		hosts: "github.com",
		issuePrefix: 42,
		prPrefix: {},
		urlTemplates: { issue: 7 },
		rules: [{ pattern: "a(\\d+)", kind: "issue", strength: "view" }],
	});
	assert.equal(provider.hosts, undefined);
	assert.equal(provider.issuePrefix, undefined);
	assert.equal(provider.prPrefix, undefined);
	assert.deepEqual(provider.urlTemplates, {});
	assert.ok(errors.length >= 4);
});

test("mergeProviders prepends user rules and overrides scalar fields", () => {
	const builtins = builtinProviders();
	const githubBuiltin = builtins.find((p) => p.name === "github");
	const userRule = { pattern: "gh\\s+ship\\s+#?(\\d+)", kind: "issue", strength: "action" };
	const { provider: user } = validateProvider({
		name: "github",
		hosts: ["github.com", "enterprise.github.com"],
		issuePrefix: "@",
		prPrefix: "▸@",
		urlTemplates: { issue: "https://{host}/custom/{number}" },
		rules: [userRule],
	});
	const merged = mergeProviders(builtins, [user]);
	assert.equal(merged.length, 2);
	const gh = merged.find((p) => p.name === "github");
	assert.equal(gh.issuePrefix, "@");
	assert.equal(gh.prPrefix, "▸@");
	assert.deepEqual(gh.hosts, ["github.com", "enterprise.github.com"]);
	assert.deepEqual(gh.urlTemplates, { issue: "https://{host}/custom/{number}" });
	assert.equal(gh.rules.length, githubBuiltin.rules.length + 1);
	assert.equal(gh.rules[0].pattern, userRule.pattern);
	assert.deepEqual(
		gh.rules.slice(1).map((r) => r.pattern),
		githubBuiltin.rules.map((r) => r.pattern)
	);
});

test("mergeProviders keeps builtin scalar fields when the user omits them", () => {
	const { provider: user } = validateProvider({
		name: "github",
		rules: [{ pattern: "gh\\s+ship\\s+#?(\\d+)", kind: "issue", strength: "action" }],
	});
	const merged = mergeProviders(builtinProviders(), [user]);
	const gh = merged.find((p) => p.name === "github");
	assert.deepEqual(gh.hosts, ["github.com"]);
	assert.equal(gh.issuePrefix, "#");
	assert.equal(gh.prPrefix, "▸#");
	assert.ok(gh.urlTemplates);
	assert.equal(gh.rules.length, 10);
	assert.equal(gh.rules[0].pattern, "gh\\s+ship\\s+#?(\\d+)");
});

test("mergeProviders appends unknown providers with defaults", () => {
	const { provider: user } = validateProvider({
		name: "internal",
		hosts: ["git.internal.example.com"],
		rules: [{ pattern: "ig\\s+issue\\s+view\\s+#?(\\d+)", kind: "issue", strength: "view" }],
	});
	const merged = mergeProviders(builtinProviders(), [user]);
	assert.deepEqual(
		merged.map((p) => p.name),
		["github", "gitlab", "internal"]
	);
	const internal = merged[2];
	assert.deepEqual(internal.hosts, ["git.internal.example.com"]);
	assert.equal(internal.issuePrefix, "#");
	assert.equal(internal.prPrefix, "▸#");
	assert.equal(internal.urlTemplates, null);
	assert.equal(internal.rules.length, 1);
});

test("mergeProviders does not mutate builtins", () => {
	const builtins = builtinProviders();
	const github = builtins.find((p) => p.name === "github");
	const beforeRules = github.rules.length;
	const beforePrefix = github.issuePrefix;
	const { provider: user } = validateProvider({
		name: "github",
		issuePrefix: "@",
		rules: [{ pattern: "gh\\s+ship\\s+#?(\\d+)", kind: "issue", strength: "action" }],
	});
	mergeProviders(builtins, [user]);
	assert.equal(github.rules.length, beforeRules);
	assert.equal(github.issuePrefix, beforePrefix);
});

test("loadProviders returns builtins when providers.json is missing or broken", () => {
	const dir = mkdtempSync(join(tmpdir(), "code-refs-load-"));
	try {
		assert.deepEqual(loadProviders(dir), builtinProviders());
		writeFileSync(join(dir, "providers.json"), "{}");
		assert.deepEqual(loadProviders(dir), builtinProviders());
		writeFileSync(join(dir, "providers.json"), '{"providers": [');
		assert.deepEqual(loadProviders(dir), builtinProviders());
		writeFileSync(join(dir, "providers.json"), '{"providers": []}');
		assert.deepEqual(loadProviders(dir), builtinProviders());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadProviders merges a valid user providers.json", () => {
	const dir = mkdtempSync(join(tmpdir(), "code-refs-merge-"));
	try {
		writeFileSync(
			join(dir, "providers.json"),
			JSON.stringify({
				providers: [
					{
						name: "github",
						prPrefix: "▸@",
						rules: [{ pattern: "gh\\s+ship\\s+#?(\\d+)", kind: "issue", strength: "action" }],
					},
					{
						name: "internal",
						hosts: ["git.internal.example.com"],
						issuePrefix: "☰",
						rules: [{ pattern: "ig\\s+mr\\s+view\\s+!?(\\d+)", kind: "pr", strength: "view" }],
					},
				],
			})
		);
		const providers = loadProviders(dir);
		assert.deepEqual(
			providers.map((p) => p.name),
			["github", "gitlab", "internal"]
		);
		const gh = providers.find((p) => p.name === "github");
		assert.equal(gh.prPrefix, "▸@");
		assert.equal(gh.issuePrefix, "#");
		assert.deepEqual(gh.hosts, ["github.com"]);
		assert.equal(gh.rules[0].pattern, "gh\\s+ship\\s+#?(\\d+)");
		assert.equal(gh.rules.length, 10);
		const gl = providers.find((p) => p.name === "gitlab");
		assert.equal(gl.prPrefix, "!");
		assert.equal(gl.rules.length, 8);
		const internal = providers.find((p) => p.name === "internal");
		assert.equal(internal.hosts[0], "git.internal.example.com");
		assert.equal(internal.issuePrefix, "☰");
		assert.equal(internal.urlTemplates, null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadProviders skips invalid provider entries but keeps valid ones", () => {
	const dir = mkdtempSync(join(tmpdir(), "code-refs-skip-"));
	try {
		writeFileSync(
			join(dir, "providers.json"),
			JSON.stringify({
				providers: [
					{ name: "nameless" },
					{ name: "broken", rules: [{ pattern: "(", kind: "issue", strength: "action" }] },
					{
						name: "github",
						rules: [{ pattern: "gh\\s+ship\\s+#?(\\d+)", kind: "issue", strength: "action" }],
					},
				],
			})
		);
		const providers = loadProviders(dir);
		assert.deepEqual(
			providers.map((p) => p.name),
			["github", "gitlab", "broken"]
		);
		const broken = providers.find((p) => p.name === "broken");
		assert.equal(broken.rules.length, 0);
		const gh = providers.find((p) => p.name === "github");
		assert.equal(gh.rules.length, 10);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadProviders caches by providers.json mtime", () => {
	const dir = mkdtempSync(join(tmpdir(), "code-refs-cache-"));
	try {
		const file = join(dir, "providers.json");
		const a = loadProviders(dir);
		assert.equal(loadProviders(dir), a);

		writeFileSync(
			file,
			JSON.stringify({
				providers: [
					{ name: "github", rules: [{ pattern: "gh\\s+ship\\s+#?(\\d+)", kind: "issue", strength: "action" }] },
				],
			})
		);
		utimesSync(file, new Date(Date.now() + 100000), new Date(Date.now() + 100000));
		const b = loadProviders(dir);
		assert.notEqual(b, a);
		assert.equal(b.find((p) => p.name === "github").rules[0].pattern, "gh\\s+ship\\s+#?(\\d+)");
		assert.equal(loadProviders(dir), b);

		writeFileSync(
			file,
			JSON.stringify({
				providers: [
					{ name: "github", rules: [{ pattern: "gh\\s+other\\s+#?(\\d+)", kind: "pr", strength: "view" }] },
				],
			})
		);
		utimesSync(file, new Date(Date.now() + 200000), new Date(Date.now() + 200000));
		const c = loadProviders(dir);
		assert.notEqual(c, b);
		assert.equal(c.find((p) => p.name === "github").rules[0].pattern, "gh\\s+other\\s+#?(\\d+)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("clearProvidersCacheForTests forces a reload", () => {
	const dir = mkdtempSync(join(tmpdir(), "code-refs-clear-"));
	try {
		const file = join(dir, "providers.json");
		writeFileSync(
			file,
			JSON.stringify({
				providers: [
					{ name: "github", rules: [{ pattern: "a(\\d+)", kind: "issue", strength: "view" }] },
				],
			})
		);
		const a = loadProviders(dir);
		assert.equal(loadProviders(dir), a);
		clearProvidersCacheForTests();
		const b = loadProviders(dir);
		assert.notEqual(b, a);
		assert.equal(b.find((p) => p.name === "github").rules[0].pattern, "a(\\d+)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("matchProvider matches hosts exactly, lowercased, and falls back to generic", () => {
	const providers = builtinProviders();
	assert.equal(matchProvider(providers, "github.com").name, "github");
	assert.equal(matchProvider(providers, "GITHUB.COM").name, "github");
	assert.equal(matchProvider(providers, "gitlab.com").name, "gitlab");
	assert.equal(matchProvider(providers, "unknown.example.com").name, "generic");
	assert.equal(matchProvider(providers, null).name, "generic");
	assert.equal(matchProvider(providers, "").name, "generic");
	assert.equal(matchProvider([], "github.com").name, "generic");
});

test("matchProvider honors user providers with mixed-case hosts", () => {
	const { provider } = validateProvider({
		name: "internal",
		hosts: ["GitHub.Enterprise.example"],
		rules: [{ pattern: "ig\\s+issue\\s+view\\s+#?(\\d+)", kind: "issue", strength: "view" }],
	});
	const providers = [...builtinProviders(), provider];
	assert.equal(matchProvider(providers, "github.enterprise.example").name, "internal");
});
