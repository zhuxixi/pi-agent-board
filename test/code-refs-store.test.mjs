import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as P from "../src/core/paths.mjs";
import { readDiagnostics } from "../src/core/diagnostics.mjs";
import {
	emptyCodeRefsSnapshot,
	normalizeCodeRefsSnapshot,
	readCodeRefs,
	summarizeCodeRefs,
	updateCodeRefsFromEvidence,
	writeCodeRefs,
} from "../src/core/code-refs-store.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "agentview-coderefs-"));
}

function gitAvailable() {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function makeRepo(url = "https://github.com/zhuxixi/pi-agent-board.git") {
	const dir = mkdtempSync(join(tmpdir(), "agentview-coderefs-repo-"));
	execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.email", "t@t.dev"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "remote", "add", "origin", url], { stdio: "ignore" });
	return dir;
}

/** Fabricated evidence whose commands view issue 40 twice (view signals need count >= 2). */
function githubEvidence() {
	return {
		viewId: "v1",
		runId: "r1",
		commands: [
			{ id: "c1", command: "gh issue view 40" },
			{ id: "c2", command: "gh issue view 40" },
		],
		assistantEvidence: [],
	};
}

test("paths: providersPath and codeRefsPath shapes", () => {
	assert.equal(P.providersPath("/root"), join("/root", "providers.json"));
	assert.equal(P.codeRefsPath("/root", "v1"), join("/root", "views", "v1", "github.json"));
});

test("emptyCodeRefsSnapshot and normalizeCodeRefsSnapshot apply safe defaults", () => {
	const empty = emptyCodeRefsSnapshot({ viewId: "v1" });
	assert.equal(empty.version, 1);
	assert.equal(empty.viewId, "v1");
	assert.equal(empty.provider, null);
	assert.equal(empty.issue, null);
	assert.equal(empty.pr, null);
	assert.deepEqual(empty.allRefs, []);

	const fromNull = normalizeCodeRefsSnapshot(null, { viewId: "v2" });
	assert.equal(fromNull.viewId, "v2");
	assert.equal(fromNull.provider, null);
	assert.deepEqual(fromNull.allRefs, []);

	const junk = normalizeCodeRefsSnapshot(
		{ viewId: 7, provider: 42, issue: "nope", pr: [], allRefs: "x" },
		{ viewId: "v3" }
	);
	assert.equal(junk.viewId, "v3");
	assert.equal(junk.provider, null);
	assert.equal(junk.issue, null);
	assert.equal(junk.pr, null);
	assert.deepEqual(junk.allRefs, []);

	const ref = {
		kind: "issue",
		number: 40,
		strength: "view",
		confidence: "medium",
		source: "command",
		url: null,
		lastIndex: 1,
	};
	const valid = normalizeCodeRefsSnapshot(
		{ viewId: "v4", provider: "github", issue: ref, pr: null, allRefs: [ref] },
		{ viewId: "x" }
	);
	assert.equal(valid.viewId, "v4");
	assert.equal(valid.provider, "github");
	assert.deepEqual(valid.issue, ref);
	assert.deepEqual(valid.allRefs, [ref]);
});

test("writeCodeRefs round-trips through the artifact file", () => {
	const root = freshRoot();
	try {
		const ref = {
			kind: "pr",
			number: 45,
			strength: "action",
			confidence: "high",
			source: "command",
			url: "https://github.com/zhuxixi/pi-agent-board/pull/45",
			lastIndex: 0,
		};
		const snap = { version: 1, viewId: "v1", updatedAt: 1, provider: "github", issue: null, pr: ref, allRefs: [ref] };
		const written = writeCodeRefs(root, snap);
		assert.equal(written.viewId, "v1");
		assert.ok(written.updatedAt >= 1);
		assert.ok(existsSync(P.codeRefsPath(root, "v1")));
		assert.deepEqual(readCodeRefs(root, "v1"), written);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readCodeRefs tolerates missing and corrupt artifact files", () => {
	const root = freshRoot();
	try {
		const missing = readCodeRefs(root, "missing");
		assert.equal(missing.viewId, "missing");
		assert.equal(missing.provider, null);
		assert.deepEqual(missing.allRefs, []);

		mkdirSync(P.viewDir(root, "v1"), { recursive: true });
		writeFileSync(P.codeRefsPath(root, "v1"), "{ nope");
		const corrupt = readCodeRefs(root, "v1");
		assert.equal(corrupt.viewId, "v1");
		assert.equal(corrupt.provider, null);
		assert.deepEqual(corrupt.allRefs, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("summarizeCodeRefs picks the summary fields defensively", () => {
	const ref = {
		kind: "issue",
		number: 40,
		strength: "view",
		confidence: "medium",
		source: "command",
		url: null,
		lastIndex: 1,
	};
	const summary = summarizeCodeRefs({ viewId: "v1", provider: "github", issue: ref, pr: null, allRefs: [ref] });
	assert.deepEqual(summary, { provider: "github", issue: ref, pr: null, allRefs: [ref] });
	assert.deepEqual(summarizeCodeRefs(null), { provider: null, issue: null, pr: null, allRefs: [] });
});

test("updateCodeRefsFromEvidence writes issue 40 medium confidence from gh issue view x2", { skip: !gitAvailable() }, () => {
	const root = freshRoot();
	const repo = makeRepo();
	try {
		const ok = updateCodeRefsFromEvidence(root, "v1", githubEvidence(), { cwd: repo });
		assert.equal(ok, true);
		const snap = readCodeRefs(root, "v1");
		assert.equal(snap.provider, "github");
		assert.equal(snap.issue.kind, "issue");
		assert.equal(snap.issue.number, 40);
		assert.equal(snap.issue.strength, "view");
		assert.equal(snap.issue.confidence, "medium");
		assert.equal(snap.issue.url, "https://github.com/zhuxixi/pi-agent-board/issues/40");
		assert.equal(snap.pr, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("AGENT_BOARD_CODE_REFS=off skips extraction without writing", () => {
	const root = freshRoot();
	try {
		process.env.AGENT_BOARD_CODE_REFS = "off";
		const ok = updateCodeRefsFromEvidence(root, "v1", githubEvidence(), { cwd: "/tmp" });
		assert.equal(ok, false);
		assert.equal(existsSync(P.codeRefsPath(root, "v1")), false);
	} finally {
		delete process.env.AGENT_BOARD_CODE_REFS;
		rmSync(root, { recursive: true, force: true });
	}
});

test("broken providers.json still extracts via builtin rules", { skip: !gitAvailable() }, () => {
	const root = freshRoot();
	const repo = makeRepo();
	try {
		writeFileSync(join(root, "providers.json"), "{ not valid json !!");
		const ok = updateCodeRefsFromEvidence(root, "v1", githubEvidence(), { cwd: repo });
		assert.equal(ok, true);
		const snap = readCodeRefs(root, "v1");
		assert.equal(snap.provider, "github");
		assert.equal(snap.issue.number, 40);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("unchanged evidence does not rewrite the artifact", { skip: !gitAvailable() }, async () => {
	const root = freshRoot();
	const repo = makeRepo();
	try {
		assert.equal(updateCodeRefsFromEvidence(root, "v1", githubEvidence(), { cwd: repo }), true);
		const before = readCodeRefs(root, "v1");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(updateCodeRefsFromEvidence(root, "v1", githubEvidence(), { cwd: repo }), true);
		const after = readCodeRefs(root, "v1");
		assert.equal(after.updatedAt, before.updatedAt); // no second write
		assert.deepEqual(after.issue, before.issue);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("extraction failure never throws and records code_refs_extract_failed", { skip: !gitAvailable() }, () => {
	const root = freshRoot();
	try {
		const evil = {
			get commands() {
				throw new Error("boom");
			},
		};
		let threw = false;
		let ok;
		try {
			ok = updateCodeRefsFromEvidence(root, "v1", evil, { cwd: "/tmp" });
		} catch {
			threw = true;
		}
		assert.equal(threw, false);
		assert.equal(ok, false);
		const diags = readDiagnostics(root, "v1");
		assert.equal(diags.at(-1).code, "code_refs_extract_failed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("no-repo cwd still extracts generic URL refs via the fallback provider", () => {
	const root = freshRoot();
	const cwd = mkdtempSync(join(tmpdir(), "agentview-coderefs-norepo-"));
	try {
		const evidence = {
			commands: [
				{ id: "c1", command: "curl https://example.com/issues/7" },
				{ id: "c2", command: "curl https://example.com/issues/7" },
				{ id: "c3", command: "open https://example.com/pull/5" },
			],
			assistantEvidence: [],
		};
		assert.equal(updateCodeRefsFromEvidence(root, "v1", evidence, { cwd }), true);
		const snap = readCodeRefs(root, "v1");
		assert.equal(snap.provider, "generic");
		assert.equal(snap.issue.number, 7);
		assert.equal(snap.issue.confidence, "medium");
		assert.equal(snap.pr.number, 5);
		assert.equal(snap.pr.confidence, "high");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("worktree path and git branch naming contribute issue claims", { skip: !gitAvailable() }, () => {
	const root = freshRoot();
	const repo = makeRepo();
	try {
		execFileSync("git", ["-C", repo, "checkout", "-b", "issue-43-foo"], { stdio: "ignore" });
		const ok = updateCodeRefsFromEvidence(root, "v1", { commands: [], assistantEvidence: [] }, {
			cwd: repo,
			repoRoot: repo,
			worktreePath: "issue-42-code-refs",
		});
		assert.equal(ok, true);
		const snap = readCodeRefs(root, "v1");
		assert.equal(snap.provider, "github");
		assert.equal(snap.issue.number, 42); // worktree is the first claim signal → wins the tie
		assert.equal(snap.issue.strength, "claim");
		assert.deepEqual(snap.allRefs.map((r) => r.number).sort((a, b) => a - b), [42, 43]);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});
