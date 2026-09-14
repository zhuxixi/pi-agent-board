# host-meta 租约孤锁回收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 host-meta 租约锁在持有者暴毙后可被回收（存量 identity-less 孤锁走超龄兜底、新锁走完整身份判死），并在锁阻塞时留下 diagnostics（issue #112）。

**Architecture:** 三处改动——(1) `pid.mjs` 提供共享的进程身份函数；(2) `locks.mjs` 把「锁可回收性」抽成纯函数 `classifyLeaseOwner`，新增 identity-less 超龄兜底；(3) `store.mjs` 的两个 host-meta 获取点带上 identity，失败路径写节流 diagnostics。

**Tech Stack:** Node.js ESM、`node:test`、无第三方依赖。

## Global Constraints

- **Work from:** `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-112-host-meta-orphan-lock` —— 所有路径均相对该目录；禁止回主 checkout（`/home/elling/git-repo/github/pi-agent-board`）作业。
- 全部命令以 `cd /home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-112-host-meta-orphan-lock && …` 开头。
- 提交粒度：每 task 一个 commit，conventional commits，英文。
- `git add` 按文件 stage，禁止 `git add -A`。
- 阈值常量：`ORPHAN_LEASE_AGE_MS = 5 * 60_000`（5 分钟），仅经 `opts.orphanAgeMs` 注入覆盖（测试用）。
- 诊断 code（精确字符串）：`host_meta_lease_contended`（updateOwnedHost 重试耗尽）、`host_meta_claim_contended`（claimHost 仅 reason==="blocked"）。
- 平台契约：`captureStartToken` 非 Linux 返回 `null`——`startToken:null` 视为 identity 不完整，走超龄兜底（spec §2.1 平台差异）。
- 测试文件 import 风格：`pid.test.mjs` / `locks.test.mjs` 用 `import test from "node:test"`；`host-owner-store.test.mjs` 用 `import { test } from "node:test"`。
- 完整设计见 `docs/superpowers/specs/2026-09-14-host-meta-orphan-lock-design.md`。

---

### Task 1: pid.mjs 共享进程身份函数

**验收归属:** F3（A3 前置）· spec §2.2

**Files:**
- Modify: `src/core/pid.mjs`
- Test: `test/pid.test.mjs`

**Interfaces:**
- Consumes: 无（实现取自 pty-runner.mjs:1011 `captureStartToken` 与 service.mjs:2258 `readProcStartToken`，二者实现一致）。
- Produces: `captureStartToken(pid: number|null|undefined): string|null`、`currentProcessIdentity(): {pid: number, startToken: string|null}` —— Task 3 依赖。

- [ ] **Step 1: Write the failing test**

在 `test/pid.test.mjs` 顶部把 import 改为：
```js
import { captureStartToken, currentProcessIdentity, isAlive, killProcess } from "../src/core/pid.mjs";
```
文件末尾追加：
```js
test("captureStartToken is stable for a live pid and null otherwise", () => {
	if (process.platform === "linux") {
		const token = captureStartToken(process.pid);
		assert.equal(typeof token, "string");
		assert.ok(token.length > 0, "starttime token must be non-empty on Linux");
		assert.equal(captureStartToken(process.pid), token, "stable across calls");
		assert.equal(captureStartToken(99999999), null, "dead pid has no token");
	} else {
		assert.equal(captureStartToken(process.pid), null, "non-Linux platforms cannot capture a start token");
	}
	assert.equal(captureStartToken(0), null);
	assert.equal(captureStartToken(null), null);
	assert.equal(captureStartToken(undefined), null);
});

test("currentProcessIdentity stamps this process", () => {
	const identity = currentProcessIdentity();
	assert.equal(identity.pid, process.pid);
	assert.equal(identity.startToken, captureStartToken(process.pid));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pid.test.mjs`
Expected: FAIL —— `captureStartToken is not a function`（SyntaxError/TypeError）。

- [ ] **Step 3: Write minimal implementation**

`src/core/pid.mjs` 顶部加 import，文件末尾追加两个函数：
```js
import { readFileSync } from "node:fs";
```
```js
/**
 * POSIX process start token — /proc/<pid>/stat field 22 (starttime), stable
 * across exec(2). Distinguishes an owned-live pid from a reused one; null on
 * failure or non-Linux platforms. Mirrors the runner's captureStartToken
 * (issue #70); shared here for host-meta lease identity (issue #112).
 * @param {number|null|undefined} pid
 * @returns {string|null}
 */
export function captureStartToken(pid) {
	if (process.platform !== "linux" || !pid) return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm (field 2) may contain spaces and parens — fields resume AFTER the
		// last ')'. fields[0] is state (field 3) → starttime (field 22) is [19].
		const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trimStart();
		return afterComm.split(/\s+/)[19] ?? null;
	} catch {
		return null;
	}
}

/**
 * Launch-time identity for the current process, as stamped on host-meta
 * acquisitions (issue #112).
 * @returns {{pid: number, startToken: string|null}}
 */
export function currentProcessIdentity() {
	return { pid: process.pid, startToken: captureStartToken(process.pid) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pid.test.mjs`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit**

```bash
git add src/core/pid.mjs test/pid.test.mjs
git commit -m "feat(core): shared process start-token identity helpers (issue #112)"
```

---

### Task 2: classifyLeaseOwner 纯函数 + identity-less 超龄兜底

**验收归属:** A1（F1+F2）· spec §2.1

**Files:**
- Modify: `src/core/locks.mjs`（新增常量与纯函数；`reclaimOrBlock` 改为委托）
- Test: `test/locks.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces: `classifyLeaseOwner(owner: any, now: number, isProcessDead: (pid: number) => boolean, opts?: {orphanAgeMs?: number}): "reclaim" | "busy" | "blocked"` —— Task 5 的端到端测试间接依赖。

- [ ] **Step 1: Write the failing tests**

`test/locks.test.mjs` 的 import 中加入 `classifyLeaseOwner`：
```js
import { acquireOwnedViewLock, classifyLeaseOwner, defaultLocksFs, releaseWithToken, tryAcquireOwnedViewLock, withFileLockSync, withViewLockSync } from "../src/core/locks.mjs";
```
文件末尾追加（纯函数契约表 + 集成）：
```js
// ---- identity-less orphan reclaim (issue #112) ------------------------------

const DEAD_PID = 99999999;
const FIXED_NOW = 1_800_000_000_000;
const livePid = () => false;
const deadPid = () => true;

test("classifyLeaseOwner: a full identity reclaims exactly when its pid is dead", () => {
	const owner = { token: "t", pid: 1, identity: { pid: 1, startToken: "s" }, startedAt: FIXED_NOW };
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, livePid), "busy");
	assert.equal(classifyLeaseOwner(owner, FIXED_NOW, deadPid), "reclaim");
});

test("classifyLeaseOwner: identity-less owners need age AND a dead pid", () => {
	const fresh = { token: "t", pid: DEAD_PID, identity: null, startedAt: FIXED_NOW - 60_000 };
	assert.equal(classifyLeaseOwner(fresh, FIXED_NOW, deadPid), "blocked", "fresh identity-less lock stays blocked");
	const stale = { token: "t", pid: DEAD_PID, identity: null, startedAt: FIXED_NOW - 10 * 60_000 };
	assert.equal(classifyLeaseOwner(stale, FIXED_NOW, deadPid), "reclaim");
	assert.equal(classifyLeaseOwner(stale, FIXED_NOW, livePid), "busy");
});

test("classifyLeaseOwner: the age threshold is inclusive and injectable", () => {
	const atThreshold = { token: "t", pid: DEAD_PID, identity: null, startedAt: FIXED_NOW - 1000 };
	assert.equal(classifyLeaseOwner(atThreshold, FIXED_NOW, deadPid, { orphanAgeMs: 1000 }), "reclaim");
	assert.equal(classifyLeaseOwner(atThreshold, FIXED_NOW, deadPid, { orphanAgeMs: 1001 }), "blocked");
});

test("classifyLeaseOwner: unparseable, token-less, and pid-less owners never reclaim", () => {
	assert.equal(classifyLeaseOwner(null, FIXED_NOW, deadPid), "blocked");
	assert.equal(classifyLeaseOwner("nope", FIXED_NOW, deadPid), "blocked");
	assert.equal(classifyLeaseOwner({ pid: DEAD_PID, identity: null, startedAt: 0 }, FIXED_NOW, deadPid), "blocked", "no token → no reclaim");
	assert.equal(classifyLeaseOwner({ token: "t", identity: null, startedAt: 0 }, FIXED_NOW, deadPid), "blocked", "no pid → nothing to judge");
	assert.equal(classifyLeaseOwner({ token: "t", identity: { pid: 1, startToken: "s" }, startedAt: 0 }, FIXED_NOW, deadPid), "blocked", "live-holder path keeps busy, dead pid without token must not reclaim");
});

test("classifyLeaseOwner: null startToken (non-Linux) uses the identity-less fallback", () => {
	const stale = { token: "t", pid: DEAD_PID, identity: { pid: DEAD_PID, startToken: null }, startedAt: FIXED_NOW - 10 * 60_000 };
	assert.equal(classifyLeaseOwner(stale, FIXED_NOW, deadPid), "reclaim");
	assert.equal(classifyLeaseOwner({ ...stale, startedAt: FIXED_NOW }, FIXED_NOW, deadPid), "blocked");
});

test("stale identity-less lock (issue #112 residue) is reclaimed via quarantine", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "host-meta");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "orphan", pid: 99999999, identity: null, startedAt: Date.now() - 10 * 60_000 }));
		const got = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: { pid: process.pid, startToken: "me" } });
		assert.equal(got.acquired, true, "stale identity-less lock must be recoverable");
		got.lease.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fresh identity-less lock is still blocked (short-hold contract preserved)", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "host-meta");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "unk", pid: process.pid, identity: null, startedAt: Date.now() }));
		const blocked = tryAcquireOwnedViewLock(root, "v1", "host-meta", { identity: { pid: process.pid, startToken: "me" } });
		assert.equal(blocked.acquired, false);
		assert.equal(blocked.reason, "blocked");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/locks.test.mjs`
Expected: FAIL —— `classifyLeaseOwner is not a function`；两条集成用例的 `acquired`/`reason` 断言不成立（超龄 identity-less 仍 blocked）。

- [ ] **Step 3: Write minimal implementation**

`src/core/locks.mjs`：在 `MAX_LEASE_RECLAIM_ATTEMPTS` 之后加常量，在 `reclaimOrBlock` 之前加纯函数：
```js
/**
 * Age past which an identity-less lock is treated as an orphan candidate.
 * Host-meta holds are millisecond-scale critical sections, so no legitimate
 * holder reaches this (issue #112).
 */
const ORPHAN_LEASE_AGE_MS = 5 * 60_000;

/**
 * Decide what to do with an inspected lease owner. Pure: the caller supplies
 * `now` and a pid-liveness probe.
 *
 * A full identity (pid + startToken) reclaims exactly when its pid is dead.
 * An identity-less owner — legacy short-hold locks, or platforms where
 * startToken cannot be captured — is only reclaimable past `orphanAgeMs`
 * with a provably dead top-level pid: fresh identity-less locks stay blocked,
 * preserving the short-critical-section contract (issue #112).
 * @param {any} owner parsed owner.json
 * @param {number} now
 * @param {(pid: number) => boolean} isProcessDead
 * @param {{ orphanAgeMs?: number }} [opts]
 * @returns {"reclaim" | "busy" | "blocked"}
 */
export function classifyLeaseOwner(owner, now, isProcessDead, opts = {}) {
	if (!owner || typeof owner !== "object") return "blocked";
	const ownPid = Number(owner?.identity?.pid ?? 0);
	const hasIdentity = Number.isFinite(ownPid) && ownPid > 0 && typeof owner?.identity?.startToken === "string";
	if (hasIdentity) {
		if (!isProcessDead(ownPid)) return "busy";
		// Quarantine-mode reclaim verifies by token that it renamed the lock it
		// inspected — without one nothing may be deleted.
		return typeof owner.token === "string" ? "reclaim" : "blocked";
	}
	const pid = Number(owner?.pid ?? 0);
	if (!Number.isFinite(pid) || pid <= 0) return "blocked";
	const orphanAgeMs = Number(opts.orphanAgeMs ?? ORPHAN_LEASE_AGE_MS);
	if (!(Number(now) - Number(owner?.startedAt ?? 0) >= orphanAgeMs)) return "blocked";
	if (!isProcessDead(pid)) return "busy";
	return typeof owner.token === "string" ? "reclaim" : "blocked";
}
```
`reclaimOrBlock`：签名加 `now`，判定段替换为委托（quarantine 段原样保留）：
```js
function reclaimOrBlock(lockPath, token, fs, isProcessDead, now) {
	let owner;
	try {
		owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
	} catch {
		return "blocked";
	}
	const verdict = classifyLeaseOwner(owner, now(), isProcessDead);
	if (verdict !== "reclaim") return verdict;
	const inspectedToken = owner.token;
	const quarantine = `${lockPath}.reclaim.${token}`;
	// …以下 quarantine 段（rename → token 核对 → restore/rmSync）保持原样不动…
}
```
注意：`classifyLeaseOwner` 返回 `"reclaim"` 时保证 `owner.token` 是 string（函数契约），因此后续 quarantine 段的 `inspectedToken` 可直接取自 `owner.token`。
`attemptAcquireLease` 的调用处改为传入 clock：`const verdict = reclaimOrBlock(lockPath, token, fs, isProcessDead, now);`

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/locks.test.mjs`
Expected: PASS —— 新增用例全绿，且既有用例（含 `dead-owner lock is reclaimed via quarantine, unknown identity is blocked`：新鲜 identity-less 仍 blocked）不回归。

- [ ] **Step 5: Commit**

```bash
git add src/core/locks.mjs test/locks.test.mjs
git commit -m "fix(locks): reclaim stale identity-less lease orphans past an age gate (issue #112)"
```

---

### Task 3: store.mjs 获取点带 identity + claimHost 注入点

**验收归属:** A3（F4+F5a+F5b）· spec §2.2

**Files:**
- Modify: `src/core/store.mjs`（import、`hostMetaIdentity` helper、`claimHost`、`updateOwnedHost`）
- Test: `test/host-owner-store.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `currentProcessIdentity()`。
- Produces: `claimHost(root, provisionalHost, opts?: {heldStartLease?: unknown, lockImpl?: typeof tryAcquireOwnedViewLock})` —— Task 4 的诊断测试复用 `lockImpl`。

- [ ] **Step 1: Write the failing tests**

`test/host-owner-store.test.mjs` 顶部 import 调整：
```js
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```
```js
import { captureStartToken } from "../src/core/pid.mjs";
```
文件末尾追加：
```js
// ---- host-meta lease identity (issue #112) ---------------------------------

test("updateOwnedHost stamps a full identity on the held host-meta lease", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHost(root, hostFixture(root, "v1"));
		let held = null;
		const res = updateOwnedHost(root, "v1", "inst-b", (host) => {
			// mutate runs inside the host-meta critical section: the lock file on
			// disk is the very lease this call holds.
			held = JSON.parse(readFileSync(join(P.viewLockPath(root, "v1", "host-meta"), "owner.json"), "utf8"));
			return { ...host, state: "stopping", stopRequestedAt: Date.now() };
		});
		assert.equal(res.updated, true);
		assert.equal(held?.identity?.pid, process.pid);
		assert.equal(held?.identity?.startToken, captureStartToken(process.pid));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("claimHost acquires host-meta through the injected impl with a full identity", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const seen = [];
		const lockImpl = (r, viewId, name, opts) => {
			seen.push({ name, opts });
			return tryAcquireOwnedViewLock(r, viewId, name, opts);
		};
		const claimed = claimHost(root, provisionalFixture(root, "v1"), { lockImpl });
		assert.equal(claimed.claimed, true);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].name, "host-meta");
		assert.equal(seen[0].opts?.identity?.pid, process.pid);
		assert.equal(seen[0].opts?.identity?.startToken, captureStartToken(process.pid));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```
（`provisionalFixture` 是文件内既有 helper。）

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/host-owner-store.test.mjs`
Expected: FAIL —— 第一条 `held` 为 null（identity 未写入 → `held.identity` 为 null）；第二条 `seen.length` 为 0（claimHost 不识别 lockImpl，走真实获取）。

- [ ] **Step 3: Write minimal implementation**

`src/core/store.mjs`：
```js
import { currentProcessIdentity, isAlive } from "./pid.mjs";
```
在 `hostClaimActive` 附近加：
```js
/**
 * Identity stamped on host-meta acquisitions so a holder that dies mid-hold
 * leaves a reclaimable record (issue #112).
 * @returns {{pid: number, startToken: string|null}}
 */
function hostMetaIdentity() {
	return currentProcessIdentity();
}
```
`claimHost`：支持注入 + 传 identity，JSDoc 的 opts 补 `lockImpl`：
```js
export function claimHost(root, provisionalHost, opts = {}) {
	const acquireHostMeta = opts.lockImpl ?? tryAcquireOwnedViewLock;
	const lock = acquireHostMeta(root, provisionalHost.viewId, "host-meta", { identity: hostMetaIdentity() });
```
`updateOwnedHost` 的获取行：
```js
		lock = acquireHostMeta(root, viewId, "host-meta", { identity: hostMetaIdentity() });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/host-owner-store.test.mjs`
Expected: PASS —— 新增两条通过；既有 4 条（claimHost contended / updateOwnedHost busy 重试 / 耗尽 / blocked 重试）不回归。

- [ ] **Step 5: Commit**

```bash
git add src/core/store.mjs test/host-owner-store.test.mjs
git commit -m "fix(store): stamp reclaimable identity on host-meta lease acquisitions (issue #112)"
```

---

### Task 4: 失败路径 diagnostics + 节流

**验收归属:** A4（F6）· spec §2.3

**Files:**
- Modify: `src/core/store.mjs`（import、节流集合、report helper、两个获取点、成功清除）
- Test: `test/host-owner-store.test.mjs`

**Interfaces:**
- Consumes: Task 3 的 `opts.lockImpl` 注入点与 `scriptLock` 测试 helper。
- Produces: `clearHostMetaThrottleForTests(): void` —— Task 5 复用；诊断 code `host_meta_lease_contended` / `host_meta_claim_contended`。

- [ ] **Step 1: Write the failing tests**

`test/host-owner-store.test.mjs` 顶部 import 追加：
```js
import { readDiagnostics } from "../src/core/diagnostics.mjs";
```
store import 块追加 `clearHostMetaThrottleForTests`：
```js
import {
	claimHost,
	clearHostMetaThrottleForTests,
	createView,
	loadRow,
	readHost,
	updateOwnedHost,
	writeHost,
	writeHostPid,
} from "../src/core/store.mjs";
```
`scriptLock` 增强为记录并透传 opts：
```js
function scriptLock(scripted) {
	const calls = [];
	const impl = (root, viewId, name, opts) => {
		calls.push({ root, viewId, name, opts });
		const next = scripted.shift();
		return next ? next(root, viewId, name) : tryAcquireOwnedViewLock(root, viewId, name, opts);
	};
	return { impl, calls };
}
```
文件末尾追加：
```js
test("updateOwnedHost reports sustained host-meta contention once per view", () => {
	clearHostMetaThrottleForTests();
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHost(root, hostFixture(root, "v1"));
		const busy = () => ({ acquired: false, reason: "busy" });

		const first = scriptLock([busy, busy, busy, busy]);
		const res = updateOwnedHost(root, "v1", "inst-b", (h) => h, { lockImpl: first.impl });
		assert.equal(res.updated, false);
		let reports = readDiagnostics(root, "v1").filter((d) => d.code === "host_meta_lease_contended");
		assert.equal(reports.length, 1);
		assert.equal(reports[0].level, "warn");
		assert.equal(reports[0].details?.lastReason, "busy");

		// A second episode without an intervening success stays throttled.
		const second = scriptLock([busy, busy, busy]);
		updateOwnedHost(root, "v1", "inst-b", (h) => h, { lockImpl: second.impl });
		reports = readDiagnostics(root, "v1").filter((d) => d.code === "host_meta_lease_contended");
		assert.equal(reports.length, 1, "one report per contention episode");

		// A successful write clears the throttle: the next episode reports again.
		const third = scriptLock([]);
		const ok = updateOwnedHost(root, "v1", "inst-b", (h) => ({ ...h, state: "stopping" }), { lockImpl: third.impl });
		assert.equal(ok.updated, true);
		const fourth = scriptLock([busy, busy, busy]);
		updateOwnedHost(root, "v1", "inst-b", (h) => h, { lockImpl: fourth.impl });
		reports = readDiagnostics(root, "v1").filter((d) => d.code === "host_meta_lease_contended");
		assert.equal(reports.length, 2, "reports again after recovery");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("claimHost reports blocked host-meta contention but not busy", () => {
	clearHostMetaThrottleForTests();
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		const blockedImpl = () => ({ acquired: false, reason: "blocked" });
		const res = claimHost(root, provisionalFixture(root, "v1"), { lockImpl: blockedImpl });
		assert.equal(res.claimed, false);
		let reports = readDiagnostics(root, "v1").filter((d) => d.code === "host_meta_claim_contended");
		assert.equal(reports.length, 1);
		assert.equal(reports[0].details?.reason, "blocked");

		clearHostMetaThrottleForTests();
		const busyImpl = () => ({ acquired: false, reason: "busy" });
		claimHost(root, provisionalFixture(root, "v1"), { lockImpl: busyImpl });
		reports = readDiagnostics(root, "v1").filter((d) => d.code === "host_meta_claim_contended");
		assert.equal(reports.length, 0, "busy is ordinary contention: no warning");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/host-owner-store.test.mjs`
Expected: FAIL —— `clearHostMetaThrottleForTests` 未导出；诊断断言为 0 条。

- [ ] **Step 3: Write minimal implementation**

`src/core/store.mjs` import 合并：
```js
import { appendDiagnostic, readDiagnosticSummary } from "./diagnostics.mjs";
```
节流状态与 helper（放在 `hostMetaIdentity` 附近）：
```js
/**
 * Views with an unrecovered host-meta contention report on record. The
 * heartbeat path calls updateOwnedHost once per second, so without this a
 * sustained contention episode would flood diagnostics.jsonl (issue #112).
 */
const hostMetaContentionReported = new Set();

/** Test hook: clear the per-process contention report throttle. */
export function clearHostMetaThrottleForTests() {
	hostMetaContentionReported.clear();
}

/**
 * Best-effort single warn per view per contention episode; diagnostics must
 * never break the caller (appendDiagnostic throws on fs failure).
 */
function reportHostMetaContention(root, viewId, code, message, details) {
	if (hostMetaContentionReported.has(viewId)) return;
	hostMetaContentionReported.add(viewId);
	try {
		appendDiagnostic(root, viewId, { source: "store", level: "warn", code, message, details });
	} catch { /* best effort */ }
}
```
`claimHost` 获取段：
```js
	const lock = acquireHostMeta(root, provisionalHost.viewId, "host-meta", { identity: hostMetaIdentity() });
	if (!lock.acquired) {
		// busy is ordinary millisecond-scale contention; blocked (identity-less
		// holder) is the orphan-lock signature worth a diagnostic (issue #112).
		if (lock.reason === "blocked") {
			reportHostMetaContention(root, provisionalHost.viewId, "host_meta_claim_contended", "host-meta lease blocked; host claim not established", { reason: lock.reason });
		}
		return { claimed: false, host: null };
	}
	hostMetaContentionReported.delete(provisionalHost.viewId);
```
`updateOwnedHost` 重试循环与成功清除：
```js
	let lastReason = null;
	for (let attempt = 0; ; attempt++) {
		lock = acquireHostMeta(root, viewId, "host-meta", { identity: hostMetaIdentity() });
		if (lock.acquired) break;
		lastReason = lock.reason;
		// busy and blocked are both millisecond-scale holds for host-meta;
		// neither is ownership information — only the fenced read below is.
		if (attempt >= UPDATE_LOCK_BUSY_ATTEMPTS - 1) {
			reportHostMetaContention(root, viewId, "host_meta_lease_contended", "host-meta lease contended; fenced write not applied", { attempts: UPDATE_LOCK_BUSY_ATTEMPTS, lastReason });
			return { updated: false, ownerChanged: false, host: null };
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, UPDATE_LOCK_BUSY_SLEEP_MS);
	}
	try {
		hostMetaContentionReported.delete(viewId);
		const host = readHost(root, viewId);
		// …余下逻辑不变…
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/host-owner-store.test.mjs`
Expected: PASS —— 新增两条通过；既有用例不回归。

- [ ] **Step 5: Commit**

```bash
git add src/core/store.mjs test/host-owner-store.test.mjs
git commit -m "feat(store): diagnostic warn on sustained host-meta lease contention (issue #112)"
```

---

### Task 5: 端到端复现（存量孤锁自愈）+ 注释更新

**验收归属:** A2a / A2b / A6 · spec §2.2 文档更新 + §4 矩阵

**Files:**
- Modify: `test/host-owner-store.test.mjs`（新增 3 条端到端用例；更新 line ~313 测试注释）
- Modify: `src/core/store.mjs`（更新 212-219 行注释块）

**Interfaces:**
- Consumes: Task 2（超龄兜底）、Task 3（identity）、Task 4（`clearHostMetaThrottleForTests`）。
- Produces: 无新接口（端到端验收）。

- [ ] **Step 1: Write the failing tests**

`test/host-owner-store.test.mjs` 末尾追加：
```js
// ---- orphan lock self-heal (issue #112 end-to-end) -------------------------

/** Write the exact residue from issue #112 into the view's host-meta lock. */
function writeOrphanLock(root, viewId, owner) {
	const lockPath = P.viewLockPath(root, viewId, "host-meta");
	mkdirSync(lockPath, { recursive: true });
	writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner));
	return lockPath;
}

test("a stale identity-less orphan lock is reclaimed by a real updateOwnedHost (issue #112 repro)", () => {
	clearHostMetaThrottleForTests();
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHost(root, hostFixture(root, "v1"));
		const lockPath = writeOrphanLock(root, "v1", { token: "orphan", pid: 99999999, identity: null, startedAt: Date.now() - 10 * 60_000 });
		const res = updateOwnedHost(root, "v1", "inst-b", (h) => ({ ...h, state: "stopping", stopRequestedAt: Date.now() }));
		assert.equal(res.updated, true, "orphan lock is reclaimed and the fenced write lands");
		assert.equal(res.ownerChanged, false);
		assert.equal(readHost(root, "v1").state, "stopping");
		let leftover = null;
		try { leftover = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")); } catch { leftover = null; }
		assert.notEqual(leftover?.token, "orphan", "the orphan lease is no longer observable");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a stale orphan lock also no longer blocks claimHost (issue #112 repro)", () => {
	clearHostMetaThrottleForTests();
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeOrphanLock(root, "v1", { token: "orphan", pid: 99999999, identity: null, startedAt: Date.now() - 10 * 60_000 });
		const claimed = claimHost(root, provisionalFixture(root, "v1"));
		assert.equal(claimed.claimed, true, "a fresh host can be claimed over the orphan residue");
		assert.equal(claimed.host?.state, "starting");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a dead holder's identity-stamped lock reclaims immediately (new-protocol crash)", () => {
	clearHostMetaThrottleForTests();
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHost(root, hostFixture(root, "v1"));
		writeOrphanLock(root, "v1", { token: "dead-inst", pid: 99999999, identity: { pid: 99999999, startToken: "tok" }, startedAt: Date.now() });
		const res = updateOwnedHost(root, "v1", "inst-b", (h) => ({ ...h, state: "stopping" }));
		assert.equal(res.updated, true, "identity-stamped dead holders reclaim without an age gate");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a fresh identity-less lock still defers to its short-hold window (no behavior regression)", () => {
	clearHostMetaThrottleForTests();
	const root = freshRoot();
	try {
		createView(root, { id: "v1", name: "a", cwd: "/r" });
		writeHost(root, hostFixture(root, "v1"));
		writeOrphanLock(root, "v1", { token: "live-ish", pid: process.pid, identity: null, startedAt: Date.now() });
		const res = updateOwnedHost(root, "v1", "inst-b", (h) => ({ ...h, state: "stopping" }));
		assert.equal(res.updated, false, "fresh identity-less locks must not be force-reclaimed");
		assert.equal(readHost(root, "v1").state, "alive", "disk record untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run tests to verify they pass end-to-end**

Run: `node --test test/host-owner-store.test.mjs`
Expected: 前两条（超龄 identity-less 孤锁的 updateOwnedHost / claimHost 回收）此时应当 PASS——它们验证的是 Task 2 的超龄兜底在 store 集成层确实生效（Task 2 只做了 locks 层单测）。第三条（identity 完整死锁立即回收）依赖 Task 3 的 identity 传递。第四条（新鲜 identity-less 不回收）依赖既有行为。**若前两条 FAIL**，说明 locks 层修复未贯通到 store 集成路径，需先排查而非继续。

- [ ] **Step 3: Update the stale comments**

`src/core/store.mjs` 的注释块（现描述 "identity-less short hold ... surfaces as retryable not-updated"）改为：
```js
 * Bounded contention retry for owner-fenced host writes (issue #70, PR #84 CI
 * wave 2). Heartbeat/client-merge writes hold the host-meta lease for only a
 * few milliseconds, but a one-shot acquire can land inside that window and
 * return busy — a revoke or recovery write that silently no-ops is a real
 * reliability bug, not just a test race. Both `busy` (live owner) and
 * `blocked` (identity-less holder) are transient here: retry a few times with
 * a short synchronous sleep before giving up, and record a warn diagnostic on
 * a sustained episode (issue #112). Acquisitions stamp a full process identity
 * (issue #112), so a holder that dies mid-hold leaves a reclaimable record;
 * legacy identity-less residue is reclaimed past the orphan age gate.
```
`test/host-owner-store.test.mjs` 中 `updateOwnedHost retries blocked contention the same bounded amount (identity-less short holds)` 的注释改为：
```js
		// A concurrent holder without a reclaimable identity (legacy residue or
		// a non-Linux startToken) makes contenders see `blocked`, not `busy`.
		// Acquisitions stamp a full identity as of issue #112; this path remains
		// for legacy holders and is still a millisecond-scale hold: retry it,
		// bounded, like busy.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/host-owner-store.test.mjs`
Expected: PASS（新增 4 条 + 全部既有）。

- [ ] **Step 5: Commit**

```bash
git add src/core/store.mjs test/host-owner-store.test.mjs
git commit -m "test(store): orphan host-meta lock self-heal end-to-end + refreshed comments (issue #112)"
```

---

### Task 6: 全量回归 + 验收对账

**验收归属:** A5 · spec §4 矩阵

**Files:**
- 无代码改动（仅验证与对账记录）。

**Interfaces:**
- Consumes: Task 1-5 全部。
- Produces: 验收对账表（写入 PR 描述，Step 9 使用）。

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: 0 失败（含 `test/host-concurrency.integration.test.mjs`、`test/pty-runner.integration.test.mjs` 等重测试）。

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: 0 错误。

- [ ] **Step 3: Cross-check anchors**

Run: `rg -n "unknown identity is blocked|identity-less short hold" src/ test/`
Expected: 注释已更新（A6）；`unknown identity is blocked` 测试仍通过（新鲜 identity-less 契约保留）。

- [ ] **Step 4: Record the acceptance matrix**

在 PR 描述中逐项记录：A1-A6 各命令与结果；U1 标记 `pending`（需用户实机执行，步骤见 spec §4）。**不得**以自动化通过替代 U1。

- [ ] **Step 5: Commit（若 Step 1-3 有修正）**

仅当修正了代码/测试时才提交；纯验证不产生 commit。

---

## Self-Review 记录（写完 plan 后自查）

1. **Spec 覆盖**：§2.1→Task 2；§2.2→Task 1+3；§2.3→Task 4；§2.4 非目标无任务（正确）；A1→T2、A2a/A2b→T5、A3→T1+T3、A4→T4、A5→T6、A6→T5。无缺口。
2. **占位符扫描**：无 TBD/TODO；每个代码步骤带完整代码。
3. **类型一致性**：`classifyLeaseOwner(owner, now, isProcessDead, opts)` 在 Task 2 定义、Task 5 只经真实路径使用；`clearHostMetaThrottleForTests` 在 Task 4 定义并导出、Task 5 复用；`currentProcessIdentity` Task 1 定义、Task 3 使用；诊断 code 字符串与 Global Constraints 一致。
4. **已知取舍**：Task 5 Step 2 的「失败态验证」在顺序执行时较难演示（Task 2 已使集成路径转绿）——保留该步并在其中写明了复核方式，避免「未验证即通过」。
