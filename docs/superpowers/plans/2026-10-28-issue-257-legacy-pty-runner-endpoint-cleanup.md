# Issue #257 — Legacy pty-runner endpoint cleanup: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A legacy PTY runner never deletes an endpoint it no longer owns, while still cleaning up its own on a normal shutdown.

**Architecture:** Inside `legacyMain` only: record `{dev,ino}` at listen, stop calling `server.close()` (libuv unlinks the bind path on handle close — `nodejs/node#19729`), and gate the explicit unlink on the existing pure `ownsEndpoint`. No new pure functions, no protocol change.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `assert/strict`, existing `pty-runner.integration.test.mjs` fixtures.

**Spec:** `docs/superpowers/specs/2026-10-28-issue-257-legacy-pty-runner-endpoint-cleanup-design.md` (converged after 2 cross-review rounds; findings trail in `~/.github-issue-driven/zhuxixi/pi-agent-board/issue-257/research/`)

## Global Constraints

- POSIX-only behaviour; all new assertions guarded by `process.platform === "win32"` → `t.skip("POSIX AF_UNIX only")`.
- New test titles MUST be exactly `#257 A<n>: <summary>`; A1's selector anchors on `#257 A1:` because `#257 A1` is a prefix of `#257 A1b`.
- Do not touch `ownedMain` (out of scope) or the legacy boot-time unlink at `:140-142`.
- Tabs for indentation; English comments; conventional commit subjects with `(issue #257)`.
- Local Windows has no WSL/Docker: A1/A1b/A2 show as `skip` locally and execute on Linux CI only. `node --test --test-name-pattern="zzz"` exits 0 — always read the summary line, never the exit code alone.

## Review Focus

- A legacy shutdown after the path was replaced must leave the replacement intact (the bug).
- A legacy normal shutdown must still remove its own socket (no stale-socket regression).
- The identity must be captured before `state: "alive"` is published, or `hostReady` is not a barrier.
- Removing `server.close()` must not change shutdown timing/child handling.
- win32: no identity is captured; the cleanup degrades to a no-op (named pipes never unlink).

---

### Task 1: legacyMain identity + no-close + gated unlink, with the three integration cases

**Files:**
- Modify: `runner/pty-runner.mjs` (`legacyMain`: identity holder, listen callback at `:409`, `shutdown` at `:503-531`)
- Test: `test/pty-runner.integration.test.mjs` (append three tests; file already imports `statSync`, `createServer`, `spawn`, `P`, `createView`, `readHost`, `atomicWriteJson`, and has `freshRoot`/`waitFor`/`hostReady`)

**Interfaces:**
- Consumes: `ownsEndpoint(bound, current)` (already imported at `runner/pty-runner.mjs:20`), `P.controlSocketPath(root, viewId)`, `P.hostConfigPath(root, viewId)`.
- Produces: nothing exported; `boundSocketIdentity` becomes a `legacyMain`-local variable; diagnostic `coordinator_endpoint_lost` is NOT used here (that is the coordinator path).

- [ ] **Step 1: Write the three failing tests**

Append to `test/pty-runner.integration.test.mjs` (use the exact helper names already in the file):

```js
/** Shared fixture: boot a legacy runner (host-config WITHOUT instanceId). */
async function bootLegacyRunner(t, viewId = "v1") {
	const root = freshRoot();
	const meta = createView(root, { id: viewId, name: "legacy-endpoint", cwd: process.cwd() });
	const configPath = P.hostConfigPath(root, viewId);
	atomicWriteJson(configPath, {
		root,
		viewId,
		sessionFile: meta.sessionFile,
		cwd: process.cwd(),
		initialPrompt: null,
		piCommand: process.execPath,
		piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
		model: null,
		tools: null,
		env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1" },
		cols: 80,
		rows: 24,
	});
	const runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	runner.stdout.resume();
	runner.stderr.resume();
	await waitFor(() => hostReady(root, viewId));
	return { root, runner, socketPath: P.controlSocketPath(root, viewId) };
}

function waitExit(child, timeoutMs = 5000) {
	return new Promise((done) => {
		if (child.exitCode !== null) return done(child.exitCode);
		const timer = setTimeout(() => done(null), timeoutMs);
		child.once("exit", (code) => { clearTimeout(timer); done(code); });
	});
}

test("#257 A1: a legacy runner cleans up its own endpoint on SIGTERM", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX AF_UNIX only");
	const { root, runner, socketPath } = await bootLegacyRunner(t);
	try {
		assert.ok(existsSync(socketPath), "precondition: endpoint exists before SIGTERM");
		runner.kill("SIGTERM");
		const code = await waitExit(runner);
		assert.equal(code, 0, "clean SIGTERM exit");
		assert.equal(existsSync(socketPath), false, "normal shutdown removes its own endpoint");
	} finally {
		if (runner.exitCode === null) runner.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
});

test("#257 A1b: a legacy runner exits cleanly when the endpoint is already gone", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX AF_UNIX only");
	const { root, runner, socketPath } = await bootLegacyRunner(t);
	try {
		assert.ok(existsSync(socketPath), "precondition: endpoint exists");
		unlinkSync(socketPath);
		runner.kill("SIGTERM");
		const code = await waitExit(runner);
		assert.equal(code, 0, "ENOENT at cleanup must not crash the shutdown");
	} finally {
		if (runner.exitCode === null) runner.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
});

test("#257 A2: a legacy runner does not unlink a replaced endpoint", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX AF_UNIX only");
	const { root, runner, socketPath } = await bootLegacyRunner(t);
	const standinPath = join(root, `.standin-${process.pid}.sock`);
	let standin = null;
	try {
		assert.ok(existsSync(socketPath), "precondition: endpoint exists");
		const before = statSync(socketPath).ino;
		standin = createServer(() => {});
		await new Promise((ok, fail) => {
			standin.once("error", fail);
			standin.listen(standinPath, ok);
		});
		renameSync(standinPath, socketPath); // atomic, same filesystem
		assert.notEqual(statSync(socketPath).ino, before, "stand-in really replaced the inode");
		runner.kill("SIGTERM");
		const code = await waitExit(runner);
		assert.equal(code, 0, "clean SIGTERM exit");
		assert.ok(existsSync(socketPath), "a legacy runner must not unlink an endpoint it no longer owns");
	} finally {
		if (runner.exitCode === null) runner.kill("SIGKILL");
		if (standin) await new Promise((done) => standin.close(done));
		rmSync(root, { recursive: true, force: true });
	}
});
```

New imports needed at the top of the file: `unlinkSync`, `renameSync` (add to the `node:fs` import at `:2`).

- [ ] **Step 2: Run them (local: expect skip; Linux CI: expect A2 red)**

Run: `node --test --test-name-pattern="#257 A" test/pty-runner.integration.test.mjs`
Local Windows: `tests 3 / skipped 3` (documented channel limit). Linux: A1/A1b pass, **A2 fails**
(`a legacy runner must not unlink an endpoint it no longer owns`) because the old shutdown's
`server.close()` and unconditional unlink both delete the stand-in. Record the observed
summary in the ledger either way.

- [ ] **Step 3: Implement the three changes in `legacyMain`**

In `runner/pty-runner.mjs`, inside `legacyMain` (after `let shutdownExitCode = null;`):

```js
	/** {dev,ino} recorded at bind time; cleanup unlinks only this exact inode. */
	let boundSocketIdentity = null;
```

Replace the `server.listen(...)` call at `:409` with:

```js
	server.listen(socketPath, () => {
		// Capture the identity BEFORE publishing readiness: "host ready" must imply
		// "identity recorded", or a shutdown could run with a stale/null identity.
		if (process.platform !== "win32") {
			try {
				const st = statSync(socketPath);
				boundSocketIdentity = { dev: st.dev, ino: st.ino };
			} catch { /* without the identity, cleanup degrades to a no-op */ }
		}
		update({ socketPath, state: "alive" });
	});
```

In `shutdown()`, replace:

```js
		try { server?.close(); } catch {}
		try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch {}
```

with:

```js
		// Do NOT call server.close() (issue #257, nodejs/node#19729): libuv unlinks the
		// unix-socket bind path when the listening handle closes, so a shutdown after a
		// successor bound would delete the successor's endpoint. There is no close here,
		// so the implicit unlink never runs. Cleanup is explicit and identity-gated below
		// (the legacy path has no lease, so dev+ino is its only ownership proof).
		if (process.platform !== "win32" && boundSocketIdentity) {
			try {
				const st = statSync(socketPath);
				if (ownsEndpoint(boundSocketIdentity, { dev: st.dev, ino: st.ino })) {
					try { unlinkSync(socketPath); } catch { /* best effort */ }
				}
			} catch { /* path gone — nothing to clean */ }
		}
```

- [ ] **Step 4: Run the cases again**

Run: `node --test --test-name-pattern="#257 A" test/pty-runner.integration.test.mjs`
Local Windows: `tests 3 / skipped 3` and exit 0 — read the summary, confirm 3 skipped (not 0 tests).
Linux CI: `tests 3 / pass 3`.

- [ ] **Step 5: Run the existing pty-runner suite for regressions**

Run: `node --test test/pty-runner.integration.test.mjs`
Local expectation: everything that ran before still passes (the legacy/owned cases that are
platform-independent). Linux CI: full pass. Any new failure must be understood before commit.

- [ ] **Step 6: Commit**

```bash
git add runner/pty-runner.mjs test/pty-runner.integration.test.mjs
git commit -m "fix(runner): stop legacy pty-runner from unlinking a replaced endpoint (issue #257)"
```

---

### Task 2: Full verification and local code review

**Files:** none (verification + review); modify only if a gate fails.

**Interfaces:** consumes Task 1.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck` — exit 0.

- [ ] **Step 2: Targeted suites**

Run: `node --test test/pty-runner.integration.test.mjs test/host-coordination.test.mjs test/locks.test.mjs`
Local Windows: pass (POSIX cases skip). Linux CI: full pass.

- [ ] **Step 3: Pre-PR gate**

Run: `npm run test:coverage` (Linux CI authoritative; local Windows baseline is not the gate for
POSIX cases), then `npm run test:perf && npm run pack:dry`, then `npm run verify`. Record actual
results; a local failure caused by the known Windows platform gap must be named explicitly.

- [ ] **Step 4: Fresh-context local code review**

Dispatch a reviewer over `git diff main...HEAD` with the spec + this plan + the Review Focus
list; disposition findings (Critical/Important → one fix pass with a failing test first; Minor →
ledger). Commit only if files change.

---

## Task ↔ acceptance traceability

| Spec acceptance ID | Task |
|---|---|
| A1, A1b, A2 | Task 1 (Steps 1-6) |
| A3 | Task 1 Step 5 + Task 2 Step 2 |
| A4 | Task 2 Step 1 |
| A5, A6 | Task 2 Step 3 (Linux CI authoritative) |
