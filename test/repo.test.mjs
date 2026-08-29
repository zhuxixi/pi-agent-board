import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	clearRemoteHostCacheForTests,
	gitRemoteHost,
	gitRepoRoot,
	isDirty,
	sameRepo,
} from "../src/core/repo.mjs";

function gitAvailable() {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function realpath(p) {
	return execFileSync("node", ["-e", `process.stdout.write(require('fs').realpathSync(${JSON.stringify(p)}))`], {
		encoding: "utf8",
	});
}

test("gitRepoRoot returns null outside a repo", () => {
	const dir = mkdtempSync(join(tmpdir(), "agentview-norepo-"));
	try {
		assert.equal(gitRepoRoot(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gitRepoRoot + isDirty inside a temp repo", { skip: !gitAvailable() }, () => {
	const dir = mkdtempSync(join(tmpdir(), "agentview-repo-"));
	try {
		execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
		execFileSync("git", ["-C", dir, "config", "user.email", "t@t.dev"], { stdio: "ignore" });
		execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
		const root = gitRepoRoot(dir);
		assert.equal(root, realpath(dir));
		assert.equal(isDirty(root), false);
		writeFileSync(join(dir, "a.txt"), "hi");
		assert.equal(isDirty(root), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sameRepo compares roots", () => {
	assert.equal(sameRepo("/a", "/a"), true);
	assert.equal(sameRepo("/a", "/b"), false);
	assert.equal(sameRepo(null, null), false);
});

test("gitRemoteHost returns null outside a repo", () => {
	const dir = mkdtempSync(join(tmpdir(), "agentview-norepo-"));
	try {
		assert.equal(gitRemoteHost(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gitRemoteHost returns null without an origin remote", { skip: !gitAvailable() }, () => {
	const dir = mkdtempSync(join(tmpdir(), "agentview-noremote-"));
	try {
		execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
		const root = gitRepoRoot(dir);
		assert.equal(root, realpath(dir));
		assert.equal(gitRemoteHost(root), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gitRemoteHost parses https and ssh origin remotes", { skip: !gitAvailable() }, () => {
	const dir = mkdtempSync(join(tmpdir(), "agentview-remote-"));
	try {
		execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
		execFileSync("git", ["-C", dir, "config", "user.email", "t@t.dev"], { stdio: "ignore" });
		execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
		const root = gitRepoRoot(dir);
		assert.equal(root, realpath(dir));

		execFileSync(
			"git",
			["-C", dir, "remote", "add", "origin", "https://github.com/zhuxixi/pi-agent-board.git"],
			{ stdio: "ignore" }
		);
		clearRemoteHostCacheForTests();
		assert.equal(gitRemoteHost(root), "github.com");

		execFileSync(
			"git",
			["-C", dir, "remote", "set-url", "origin", "git@gitlab.example.com:team/demo.git"],
			{ stdio: "ignore" }
		);
		clearRemoteHostCacheForTests();
		assert.equal(gitRemoteHost(root), "gitlab.example.com");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("gitRemoteHost caches per repoRoot until cleared", { skip: !gitAvailable() }, () => {
	const dir = mkdtempSync(join(tmpdir(), "agentview-cache-"));
	try {
		execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
		execFileSync("git", ["-C", dir, "config", "user.email", "t@t.dev"], { stdio: "ignore" });
		execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
		const root = gitRepoRoot(dir);
		assert.equal(root, realpath(dir));

		execFileSync(
			"git",
			["-C", dir, "remote", "add", "origin", "https://github.com/zhuxixi/pi-agent-board.git"],
			{ stdio: "ignore" }
		);
		assert.equal(gitRemoteHost(root), "github.com");
		// second call returns the same cached value without re-reading the remote
		assert.equal(gitRemoteHost(root), "github.com");

		execFileSync(
			"git",
			["-C", dir, "remote", "set-url", "origin", "git@gitlab.example.com:team/demo.git"],
			{ stdio: "ignore" }
		);
		// stale cache: set-url alone must not invalidate the cached host
		assert.equal(gitRemoteHost(root), "github.com");

		clearRemoteHostCacheForTests();
		assert.equal(gitRemoteHost(root), "gitlab.example.com");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
