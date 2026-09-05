# Issue #70 Implementation Plan — pty 宿主堆叠与 control.sock 互删修复

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除同一 view 上多个 PTY host 并发启动/互删 control.sock/并发写 session 的竞态，attach 永久失败变为可恢复的 pending。

**Architecture:** 每个 host instance 使用独立 socket/config 路径（新协议不再复用固定 `control.sock`）；per-view `host-start` lease 串行化启动决策；`instanceId` fencing 保护 host.json 写入与 cleanup；runner 先 bind 后 spawn child；attach 改为 async `resolveAttachTarget()`（真实 connect+hello probe）；恢复走 revoke→等待退出→替换。

**Spec:** `docs/superpowers/specs/2026-09-05-pty-host-stacking-sock-race-design.md`（同 worktree，已提交）

**Tech Stack:** Node.js (>=20) ESM `.mjs`，node:test + node:assert/strict，node-pty，@xterm/headless；扩展侧 TypeScript 仅类型检查（`allowJs` 消费 .mjs）。

## Global Constraints

- **Worktree 作业**：所有改动在 `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-70-pty-host-stacking-sock-race`，git 操作用 `git -C $WT`，禁止碰主 checkout。
- **TDD**：每个行为先写失败测试，跑确认失败，再实现，再跑确认通过，最后 commit。
- **测试命令**：单文件 `node --test test/<file>.test.mjs`；全量 `npm test`；最终 `npm run verify`。
- **commit message**：conventional commits（`feat/fix/refactor/test/docs`），message 带 `(issue #70)` 后缀；`git add <file>` 按文件 stage，禁止 `git add -A`。
- **常量在代码中集中声明**（值与 spec 一致）：`HOST_START_GRACE_MS = 10_000`、`HOST_PROBE_TIMEOUT_MS = 250`、`HOST_PROBE_RETRY_MS = 150`、`HOST_RECOVERY_GRACE_MS = 5_000`、`HOST_START_LOCK_WAIT_MS = 500`、`HOST_RUNNER_LOCK_WAIT_MS = 5_000`、`LOCK_ORPHAN_GRACE_MS = 5_000`。
- **legacy 兼容 seam**：runner 在 `config.instanceId` 缺失时保持现有行为不变（固定 `control.sock`、无条件 unlink），保证现有 `test/pty-runner.integration.test.mjs` 等不回归；有 `instanceId` 时走新协议。生产 service 永远写 instanceId。
- **UI 进程内禁止阻塞式锁等待**：`resolveAttachTarget()`/dashboard 路径只用 `tryAcquireOwnedViewLock` + setTimeout 重试循环；带 `Atomics.wait` 的 `acquireOwnedViewLock(waitMs)` 只允许 runner/detached 进程或 waitMs≤50 的场景。
- **禁止项（spec §十）**：生产路径不得直接 `writeHost()` 覆盖 host 快照；新协议不得 unlink 共享/固定 socket 路径；不得只凭 PID 发终止信号；不得 SIGTERM 后立即 relaunch。
- **现有 `killProcess(pid, graceMs)` 签名不改**；恢复路径用新注入的 `signalOwnedProcess(identity, signal)`。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/core/paths.mjs` | instance-specific endpoint/config 路径 | Modify |
| `src/core/types.mjs` | HostState/HostStatus/Row 新字段 | Modify |
| `src/core/host-coordination.mjs` | 纯决策函数（无 I/O） | Create |
| `src/core/locks.mjs` | owner-safe lease API | Modify |
| `src/core/launch.mjs` | host launch 支持独立 config path | Modify |
| `src/core/store.mjs` | claimHost/updateOwnedHost、hostActive/hostReady、host-pid fallback | Modify |
| `src/core/host-probe.mjs` | 真实 socket/pipe connect+hello probe | Create |
| `src/core/host-crash.mjs` | expected-instance owner-aware finalize | Modify |
| `src/runtime/service.mjs` | 两阶段 launch、ensure/revoke/recover/resolver/sendHostInput | Modify |
| `runner/pty-runner.mjs` | 新协议分支：lease、bind-before-child、starting 协议、ack、finishHost | Modify |
| `src/commands/attach-flow.ts` | 只调 resolver | Modify |
| `src/commands/agent-board.ts` | 只调 resolver、attach 前置判断更新 | Modify |
| `src/ui/dashboard.ts` | prewarm 幂等、hostActive 语义 | Modify |
| `test/host-coordination.test.mjs` | A1 | Create |
| `test/locks.test.mjs` | A2（扩展现有） | Modify |
| `test/launch.test.mjs` | A3（扩展） | Modify |
| `test/host-probe.test.mjs` | A5 | Create |
| `test/host-owner-store.test.mjs` | claimHost/updateOwnedHost 契约 | Create |
| `test/pty-runner.integration.test.mjs` | A6/A7/A11（扩展） | Modify |
| `test/host-crash.test.mjs` | A9 迟到写（扩展） | Modify |
| `test/service.test.mjs` | A4（扩展） | Modify |
| `test/host-recovery.test.mjs` | A10 unit 层 | Create |
| `test/host-resolver.test.mjs` | A12/A15 | Create |
| `test/host-input.test.mjs` | A13 | Create |
| `test/host-concurrency.integration.test.mjs` | A8/A9/A10 多进程 | Create |
| `test/dashboard-prewarm.test.mjs` | A14 | Create |
| `test/attach-flow.test.mjs` | A12 调用契约 | Create |

---

### Task 1: instance-specific 路径 + 类型字段（A3 部分 / A16 类型基座）

**Files:**
- Modify: `src/core/paths.mjs`
- Modify: `src/core/types.mjs`
- Test: `test/socket-path.test.mjs`

**Interfaces:**
- Produces:
  - `hostConfigPathFor(root, viewId, instanceId) -> string`（`views/<viewId>/host-config.<instanceId>.json`）
  - `hostEndpointPathFor(platform, root, viewId, instanceId) -> string`：POSIX → `views/<viewId>/control.<instanceId>.sock`；win32 → `\\.\pipe\pi-agent-board-<viewId>-<hash8(instanceId)>`（hash 用 sha256 前 8 hex，pipe 名 ≤256 字符）
  - `HostState` 新增 `"stopping"`；`HostStatus` 新增 `instanceId/configPath/claimAt/claimPid/claimIdentity/runnerIdentity/runnerSpawnedAt/childIdentity/childSpawnedAt/readyAt/stopRequestedAt/revokeToken/stopReason`；`Row` typedef 新增 `hostActive/hostReady`
- 现有 `controlSocketPathFor(platform, root, viewId)`、`hostConfigPath` 保持不动（legacy 路径）

- [ ] **Step 1: 写失败测试**

在 `test/socket-path.test.mjs` 追加：

```js
import { hostConfigPathFor, hostEndpointPathFor } from "../src/core/paths.mjs";

test("instance-specific host config and endpoint paths are unique per instance", () => {
	const a = hostConfigPathFor("/root", "view_1", "aaa");
	const b = hostConfigPathFor("/root", "view_1", "bbb");
	assert.notEqual(a, b);
	assert.match(a, /views\/view_1\/host-config\.aaa\.json$/);
	const s1 = hostEndpointPathFor("linux", "/root", "view_1", "aaa");
	const s2 = hostEndpointPathFor("linux", "/root", "view_1", "bbb");
	assert.notEqual(s1, s2);
	assert.match(s1, /views\/view_1\/control\.aaa\.sock$/);
	const p1 = hostEndpointPathFor("win32", "C:\\root", "view_1", "aaa");
	assert.match(p1, /^\\\\\.\\pipe\\pi-agent-board-view_1-[0-9a-f]{8}$/);
	assert.ok(p1.length <= 256);
	assert.notEqual(hostEndpointPathFor("win32", "C:\\root", "view_1", "aaa"), hostEndpointPathFor("win32", "C:\\root", "view_1", "bbb"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd $WT && node --test test/socket-path.test.mjs`
Expected: FAIL（`hostConfigPathFor is not a function`）

- [ ] **Step 3: 实现**

`src/core/paths.mjs` 顶部加 `import { createHash } from "node:crypto";`，追加：

```js
/** @param {string} root @param {string} viewId @param {string} instanceId */
export const hostConfigPathFor = (root, viewId, instanceId) =>
	path.join(viewDir(root, viewId), `host-config.${instanceId}.json`);

/**
 * Per-instance control endpoint. Each new host instance binds its own socket/pipe,
 * so a superseded runner can never unlink the current owner's endpoint (issue #70).
 * win32 pipe names embed an 8-hex hash of the instanceId to stay under the 256-char limit.
 * @param {"win32"|"linux"|"darwin"} platform
 */
export function hostEndpointPathFor(platform, root, viewId, instanceId) {
	if (platform === "win32") {
		const hash = createHash("sha256").update(String(instanceId)).digest("hex").slice(0, 8);
		return `\\\\.\\pipe\\pi-agent-board-${viewId}-${hash}`;
	}
	return path.join(viewDir(root, viewId), `control.${instanceId}.sock`);
}
```

`src/core/types.mjs`：`HostState` typedef 改 `"starting"|"alive"|"stopping"|"exited"|"failed"`；`HostStatus` typedef 增加 spec §4.1 列出的全部字段（每个带 `@property` 行）；`Row` typedef 增加 `@property {boolean} hostActive` 与 `@property {boolean} hostReady`（在 `src/core/store.mjs` 的 Row typedef 块，它才是权威定义处——types.mjs 里若只有 HostStatus 则只改 HostStatus；Row typedef 在 store.mjs L179 附近）。

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `cd $WT && node --test test/socket-path.test.mjs && npx tsc --noEmit`
Expected: PASS；tsc 无新增错误

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/core/paths.mjs src/core/types.mjs test/socket-path.test.mjs
git -C $WT commit -m "feat(paths): per-instance host config and control endpoint paths (issue #70)"
```

---

### Task 2: host-coordination 纯决策函数（A1）

**Files:**
- Create: `src/core/host-coordination.mjs`
- Test: `test/host-coordination.test.mjs`

**Interfaces:**
- Produces（全部纯函数，零 I/O，全部 export）：
  - `sameHostOwner(host, expectedInstanceId) -> boolean`
  - `isStartingWithinGrace(host, now, graceMs) -> boolean`（`host.state==="starting" && host.claimAt != null && now - host.claimAt < graceMs`；runnerPid/socket 缺失不影响）
  - `processIdentityState(identity, observed, spawnedAt) -> "not_started"|"dead"|"owned"|"foreign"|"unknown"`：
    - `spawnedAt == null` → `"not_started"`
    - `observed.alive === false` → `"dead"`
    - `identity?.startToken == null || observed?.startToken == null` → `"unknown"`
    - startToken 相等 → `"owned"`；不等 → `"foreign"`
  - `canReplaceHost({ host, runnerObservation, childObservation, claimObservation, launchLeaseActive }) -> boolean`：仅当 host 为 exited/failed 且 runner/child/claim 均 ∈ {not_started, dead, foreign} 且 `!launchLeaseActive`
  - `ownsEndpoint(bound, current) -> boolean`：`bound && current && bound.dev === current.dev && bound.ino === current.ino`
  - `classifyProbeResult(result) -> "ready"|"starting"|"stale"|"occupied"|"missing"|"unknown"`（输入 probe 快照对象，规则见 spec §7.1）
  - `shouldYieldRunner({ host, instanceId }) -> boolean`：host 存在且 `host.instanceId !== instanceId` 且 state ∈ starting/alive/stopping
  - `shouldAcceptInput(host) -> boolean`：`state === "alive" && readyAt != null && !stopRequestedAt`
  - `shouldRetryBind(errorCode, attempt) -> boolean`：`errorCode === "EADDRINUSE" && attempt < 1`

- [ ] **Step 1: 写失败测试** `test/host-coordination.test.mjs`（覆盖：starting 且 runnerPid:null 在 grace 内 true / 超 grace false；processIdentityState 五态各一例；canReplaceHost 对 unknown 返回 false；ownsEndpoint dev/ino；classifyProbeResult 六类；shouldYieldRunner/shouldAcceptInput/shouldRetryBind 边界）

```js
import test from "node:test";
import assert from "node:assert/strict";
import { canReplaceHost, classifyProbeResult, isStartingWithinGrace, ownsEndpoint, processIdentityState } from "../src/core/host-coordination.mjs";

test("starting claim without runnerPid is protected inside grace", () => {
	const host = { state: "starting", claimAt: 1000, runnerPid: null, childPid: null };
	assert.equal(isStartingWithinGrace(host, 5000, 10_000), true);
	assert.equal(isStartingWithinGrace(host, 12_000, 10_000), false);
});

test("process identity states", () => {
	assert.equal(processIdentityState(null, null, null), "not_started");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: false }, 1), "dead");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: true, startToken: "t" }, 1), "owned");
	assert.equal(processIdentityState({ pid: 1, startToken: "t" }, { alive: true, startToken: "u" }, 1), "foreign");
	assert.equal(processIdentityState({ pid: 1, startToken: null }, { alive: true }, 1), "unknown");
});

test("canReplaceHost refuses unknown observations", () => {
	const host = { state: "failed" };
	assert.equal(canReplaceHost({ host, runnerObservation: "unknown", childObservation: "dead", claimObservation: "dead", launchLeaseActive: false }), false);
	assert.equal(canReplaceHost({ host, runnerObservation: "dead", childObservation: "not_started", claimObservation: "dead", launchLeaseActive: false }), true);
	assert.equal(canReplaceHost({ host, runnerObservation: "dead", childObservation: "dead", claimObservation: "dead", launchLeaseActive: true }), false);
});

test("ownsEndpoint compares dev+ino", () => {
	assert.equal(ownsEndpoint({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }), true);
	assert.equal(ownsEndpoint({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }), false);
});

test("classifyProbeResult maps probe snapshots", () => {
	assert.equal(classifyProbeResult({ connected: true, protocolValid: true, viewMatch: true, instanceMatch: true, state: "alive", readyAt: 1 }), "ready");
	assert.equal(classifyProbeResult({ connected: true, protocolValid: true, state: "starting" }), "starting");
	assert.equal(classifyProbeResult({ connected: true, protocolValid: true, viewMatch: false }), "occupied");
	assert.equal(classifyProbeResult({ connected: false, errorCode: "ENOENT" }), "missing");
	assert.equal(classifyProbeResult({ connected: false, errorCode: "ECONNREFUSED", isSocket: true }), "stale");
	assert.equal(classifyProbeResult({ connected: false, errorCode: "EACCES" }), "unknown");
});
```

- [ ] **Step 2: 跑确认失败** — `node --test test/host-coordination.test.mjs` → module not found

- [ ] **Step 3: 实现** `src/core/host-coordination.mjs`（按上面接口逐一实现，JSDoc 标注参数/返回；不 import 任何 fs/net/process）

- [ ] **Step 4: 跑确认通过** — 同命令 PASS

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/core/host-coordination.mjs test/host-coordination.test.mjs
git -C $WT commit -m "feat(host): pure host lifecycle decision functions (issue #70)"
```

---

### Task 3: owner-safe lease API（A2）

**Files:**
- Modify: `src/core/locks.mjs`
- Test: `test/locks.test.mjs`

**Interfaces:**
- Produces（新增 export，不动 `withFileLockSync/withViewLockSync` 既有签名与行为）：
  - `acquireOwnedViewLock(root, viewId, name, opts?) -> Lease`，`opts = { waitMs?: number, identity?: object, fs?: defaultLocksFs, clock?: () => number }`
  - `tryAcquireOwnedViewLock(root, viewId, name, opts?) -> { acquired: true, lease: Lease } | { acquired: false, reason: "busy"|"blocked" }`
  - `Lease = { token: string, touch(): boolean, isOwner(): boolean, release(): boolean }`
- 锁目录：`P.viewLockPath(root, viewId, name)`；发布方式：先建 `<name>.candidate.<token>` 目录写好 `owner.json`，再 `renameSync(candidate, lockPath)`；rename 遇 EEXIST/ENOTEMPTY 走 stale 判定。
- `owner.json` = `{ token, pid, identity, startedAt }`；heartbeat 写 `<lock>/heartbeat.<token>`（含 `at`）。
- `release()`：读回 `owner.json`，token 匹配才 `rmSync(lockPath, {recursive:true, force:true})`；不匹配 return false。
- stale reclaim：`isLockDead(lockPath)` 读 owner.identity → `identity.startToken` 缺失 → blocked（不回收）；用注入 `isProcessDead(pid)`（默认 `!isAlive(pid)`，来自 `src/core/pid.mjs`）判定 dead 后 `renameSync(lockPath, lockPath + ".reclaim." + token)` → `rmSync` quarantine → 重试 mkdir/rename。
- 默认 `waitMs = 0`（即 try 语义）；`acquireOwnedViewLock` 在 waitMs>0 时以 20ms tick + `Atomics.wait` 重试直到超时抛 `LOCK_TIMEOUT`。

- [ ] **Step 1: 写失败测试**（追加到 `test/locks.test.mjs`）

```js
import { acquireOwnedViewLock, tryAcquireOwnedViewLock } from "../src/core/locks.mjs";

test("owned lease publishes complete owner record and old token cannot release new lock", () => {
	const root = freshRoot();
	try {
		const a = acquireOwnedViewLock(root, "v1", "host-start", { identity: { pid: process.pid, startToken: "a" } });
		assert.equal(a.isOwner(), true);
		const b = tryAcquireOwnedViewLock(root, "v1", "host-start", { identity: { pid: process.pid, startToken: "b" } });
		assert.equal(b.acquired, false);
		assert.equal(b.reason, "busy");
		const stale = { token: a.token, release: () => {} };
		a.release();
		const c = acquireOwnedViewLock(root, "v1", "host-start", { identity: { pid: process.pid, startToken: "c" } });
		// simulate late release from the old token by forging a release with a's token
		assert.equal(releaseWithToken(root, "v1", "host-start", a.token), false, "old token must not delete the new lock");
		assert.equal(c.isOwner(), true);
		c.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dead-owner lock is reclaimed via quarantine, unknown identity is blocked", () => {
	const root = freshRoot();
	try {
		const lockPath = P.viewLockPath(root, "v1", "host-start");
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "old", pid: 99999999, identity: { pid: 99999999, startToken: "x" }, startedAt: Date.now() }));
		const got = tryAcquireOwnedViewLock(root, "v1", "host-start", { identity: { pid: process.pid, startToken: "me" } });
		assert.equal(got.acquired, true);
		got.lease.release();
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "unk", pid: process.pid, identity: null, startedAt: Date.now() }));
		const blocked = tryAcquireOwnedViewLock(root, "v1", "host-start", { identity: { pid: process.pid, startToken: "me" } });
		assert.equal(blocked.acquired, false);
		assert.equal(blocked.reason, "blocked");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

（注：`releaseWithToken` 是 locks.mjs 导出的内部测试钩子；若不想暴露，改为在测试中直接构造同 token 的旧 lease 对象再调用其 release——实现时选其一并在代码注释说明。）

- [ ] **Step 2: 跑确认失败** — `node --test test/locks.test.mjs` → not a function

- [ ] **Step 3: 实现** locks.mjs 新增 API（用现有 `defaultLocksFs` 注入风格；`isAlive` 从 `./pid.mjs` import；候选目录名 `name + ".candidate." + token` 放同目录）

- [ ] **Step 4: 跑确认通过 + 旧锁测试不回归** — `node --test test/locks.test.mjs` 全 PASS

- [ ] **Step 5: Commit**

```bash
git -C $WT add src/core/locks.mjs test/locks.test.mjs
git -C $WT commit -m "feat(locks): token-fenced owned view lease with quarantined reclaim (issue #70)"
```

---

### Task 4: launch.mjs 支持 instance config path（A3）

**Files:**
- Modify: `src/core/launch.mjs`
- Test: `test/launch.test.mjs`

**Interfaces:**
- Modifies: `launchHost(root, config, opts)` — config 路径改为 `config.configPath ?? P.hostConfigPath(root, config.viewId)`（有 configPath 用独立路径，否则 legacy 固定路径）；返回不变 `{ pid, configPath }`。
- Consumes: Task 1 的 `hostConfigPathFor`（由 service 侧在 Task 10 调用；launch.mjs 本身只需尊重 `config.configPath`）。

- [ ] **Step 1: 写失败测试**（`test/launch.test.mjs` 追加）

```js
test("launchHost writes to the instance-specific config path when provided", () => {
	const root = freshRoot();
	try {
		createView(root, { id: "view_a", name: "a", cwd: "/r" });
		const cfgPath = hostConfigPathFor(root, "view_a", "inst-1");
		const res = launchHost(root, { root, viewId: "view_a", sessionFile: "/s.jsonl", cwd: "/r", initialPrompt: "hello", piCommand: "pi", piArgsPrefix: [], model: null, thinkingLevel: null, tools: null, env: {}, cols: 80, rows: 24, configPath: cfgPath }, { runnerScript: "/no/runner.mjs", node: process.execPath });
		assert.equal(res.configPath, cfgPath);
		assert.ok(existsSync(cfgPath));
		const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
		assert.equal(parsed.initialPrompt, "hello");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
```

注意：现有 `launchHost` 会真实 spawn。测试用 `node: process.execPath` + 不存在的 runnerScript 会 spawn 一个立即失败的进程——现有 `test/launch.test.mjs` 已用类似模式（看现有测试怎么写，保持一致；若现有测试用 stub，则沿用其 stub 风格）。

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**（launch.mjs `launchHost` 内 `const configPath = config.configPath ?? P.hostConfigPath(root, config.viewId);`）
- [ ] **Step 4: 跑确认通过 + 旧 launch 测试回归**
- [ ] **Step 5: Commit** — `feat(launch): per-instance host config path (issue #70)`

---

### Task 5: store owner-aware 写入 + 派生状态（A1/A9 基座）

**Files:**
- Modify: `src/core/store.mjs`
- Test: `test/host-owner-store.test.mjs`（新建）、`test/store.test.mjs`（fallback 修正回归）

**Interfaces:**
- Consumes: Task 3 `acquireOwnedViewLock`；Task 2 `sameHostOwner`
- Produces:
  - `claimHost(root, provisionalHost, { heldStartLease }) -> { claimed: boolean, host: HostStatus|null }`：内部取 `host-meta` lease（短 tryAcquire，争用返回 claimed:false）；锁内重读 host，若存在 active（starting/alive/stopping）或 claimed 由他人持有 → claimed:false；否则原子写完整 provisional record（清空旧 runner/child/ready/stop 字段），best-effort 更新 host-pid 镜像。
  - `updateOwnedHost(root, expectedInstanceId, mutate, opts?) -> { updated: boolean, ownerChanged: boolean, host: HostStatus|null }`：锁内重读；`host.instanceId !== expectedInstanceId` → `{updated:false, ownerChanged:true}`；否则 `host = mutate(host)`（mutate 返回新对象）→ 原子写回 + 镜像。
  - `loadRow()` 增加 `hostActive`/`hostReady`：`hostActive = host && ["starting","alive","stopping"].includes(host.state)`；`hostReady = hostActive && host.state === "alive" && host.readyAt != null`。
  - `loadRow()` hostPid fallback 修正：`const hostPid = host && Object.hasOwn(host, "runnerPid") ? host.runnerPid : readHostPid(root, viewId)`（属性存在即使为 null 也不回退）。

- [ ] **Step 1: 写失败测试** `test/host-owner-store.test.mjs`：

```js
test("claimHost refuses when an active claim exists", () => {
	// 写入 starting host（instanceId a）→ claimHost(b) 返回 claimed:false
});

test("updateOwnedHost fences late writes from a superseded instance", () => {
	// host instanceId=b（alive）；updateOwnedHost(root, "a", h => ({...h, state:"exited"})) → updated:false, ownerChanged:true，磁盘 host 仍是 b/alive
});

test("updateOwnedHost applies mutate for the current owner and mirrors host-pid", () => {
	// instanceId=b → mutate 设 readyAt → 读回 readyAt 非空；host-pid.json 的 instanceId === "b"
});

test("loadRow does not let legacy host-pid mirror override an explicit null runnerPid", () => {
	// host.json runnerPid:null + host-pid.json pid=123 → row.host.runnerPid === null, row.hostAlive === false
});
```

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**（store.mjs 追加 claimHost/updateOwnedHost；loadRow 三处改动：hostPid fallback、hostActive、hostReady；Row typedef 已在 Task 1 更新字段名）
- [ ] **Step 4: 跑确认通过 + `node --test test/store.test.mjs` 回归**
- [ ] **Step 5: Commit** — `feat(store): owner-fenced host writes and hostActive/hostReady rows (issue #70)`

---

### Task 6: host-probe 真实探测（A5）

**Files:**
- Create: `src/core/host-probe.mjs`
- Test: `test/host-probe.test.mjs`

**Interfaces:**
- Consumes: Task 2 `classifyProbeResult`
- Produces:
  - `probeHost(socketPath, opts) -> Promise<ProbeResult>`，`opts = { timeoutMs = HOST_PROBE_TIMEOUT_MS, expectedViewId?, expectedInstanceId?, connect? }`
  - `ProbeResult = { classification, connected, protocolValid, ready, viewId, instanceId, state, errorCode }`
  - 流程：`connect(socketPath)`（默认 `createConnection`）→ `connect` 事件或 error/timeout → 成功后发送 `{"type":"hello","clientId":"probe","wantOutput":false}\n` → 读取首条完整 JSONL（hello 或 status）→ 解析 → 关闭 socket → 组装快照喂 `classifyProbeResult`。
  - POSIX `ECONNREFUSED` 时附带 `lstatSync(socketPath).isSocket()` 到快照的 `isSocket` 字段；ENOENT → missing；其他错误 → unknown。win32 不做 lstat。

- [ ] **Step 1: 写失败测试**（用 `node:net` 在 tmp 目录起真实 server 模拟 hello；再用注入 `connect` 返回各类 error）

```js
test("probeHost classifies a ready host from a real unix socket", async () => {
	// mkdtemp；createServer 写一个 {"type":"hello","status":{"state":"alive","readyAt":1,"viewId":"v1","instanceId":"i1"}} 后保持
	// probeHost(sock, {expectedViewId:"v1", expectedInstanceId:"i1"}) → classification "ready", ready true
});
test("probeHost maps ENOENT to missing and refused socket file to stale", async () => {
	// 不存在路径 → missing；writeFileSync 一个普通文件 → ECONNREFUSED → unknown（isSocket false）；真实 stale socket 由 integration 覆盖
});
```

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑确认通过**
- [ ] **Step 5: Commit** — `feat(host-probe): real connect+hello probe with result classification (issue #70)`

---

### Task 7: runner 新协议——独立 endpoint + bind-before-child + 统一 finish（A6/A7/A11）

**Files:**
- Modify: `runner/pty-runner.mjs`（核心重构）
- Test: `test/pty-runner.integration.test.mjs`（扩展）

**Interfaces:**
- Consumes: Task 1 `hostEndpointPathFor`（service 写入 config.socketPath，runner 直接用 config.socketPath）；Task 3 lease API；Task 5 `updateOwnedHost`；Task 2 `shouldYieldRunner/ownsEndpoint`
- Produces（行为契约）：
  - `config.instanceId` 存在 → 新协议；缺失 → 现有 legacy 行为逐字节保留。
  - 新协议启动顺序：读 config → `acquireOwnedViewLock(root, viewId, "host-start", {waitMs: HOST_RUNNER_LOCK_WAIT_MS})` → 锁内读 host.json → `shouldYieldRunner` true / 终态 / 缺失 → 记 diagnostic 退出 0（不写 host）→ 否则 `server.listen(config.socketPath)`（**不 unlink**；EADDRINUSE → 记 diagnostic `host_endpoint_busy` 退出 1）→ listen 成功后 `updateOwnedHost` 写 runnerIdentity + `state:"starting"` → 安装 handlers → spawn child → `updateOwnedHost` 写 childPid/childIdentity/childSpawnedAt/`state:"alive"`/`readyAt` → release lease → heartbeat。
  - heartbeat 每秒：读 host.json；`instanceId !== 自己` → `finishHost("owner_lost")`（不写 host、不删 endpoint 以外的资源，endpoint 清理见下）；`stopRequestedAt` 且同 instance → `finishHost("revoked")`；否则 update heartbeat。
  - `finishHost(reason, exitCode, activeLease?)`（幂等，`shutdownStarted` 保护）：停止 heartbeat → 结束 clients → `server.close()` 等待（有界 1s）→ 等 child 退出（SIGTERM→4s→SIGKILL→1s，沿用现有 waitForChildExit 逻辑）→ 若 `isCurrentOwner()`：`updateOwnedHost` 写终态（exited/failed + endedAt/exitCode，清 childPid/readyAt）→ POSIX `cleanupOwnedSocket()`（`lstat` 当前 endpoint，与 bind 时记录的 `{dev,ino}` 用 `ownsEndpoint` 比对，匹配才 unlink；win32 跳过）→ 删除 config（best-effort）→ release lease → `process.exit`。
  - `child.onExit` 与 `uncaughtException` 全部改走 `finishHost`（删除现有 50ms 直接 exit 路径）；uncaughtException 仍先 appendDiagnostic + `host-crash`（Task 9 改造后带 instanceId）。
  - server error handler：startup 阶段由 listen 协调器处理；运行期 error → `finishHost("server_error", 1)`。

- [ ] **Step 1: 写失败测试**（`test/pty-runner.integration.test.mjs` 追加；测试构造 config 时带 `instanceId` 与独立 `socketPath`，用 `hostEndpointPathFor(root, "v1", "i1")`）

```js
test("two runners for the same instance: loser exits before spawning a child", async () => {
	// 写同一 config（instanceId i1）→ 同时 spawn runner A/B
	// 断言：最终 readHost(...).state === "alive" 且 childPid 对应唯一进程；
	//       其中一个 runner 退出码为 0/1 且 diagnostics 有 host_start_yielded 或 host_endpoint_busy；
	//       ps 检查只剩一个 child（用 childPid + isAlive 断言）
});

test("new-protocol runner does not unlink a foreign endpoint on exit", async () => {
	// runner A(instance i1, socketPath sA) 起到 alive；手工在 sA 同目录放 instance i2 的 socket 文件 sB（真实 listen 一个 server）
	// SIGTERM A → A 退出后 sB 的 server 仍可 connect（createConnection 成功）
});

test("natural child exit cleans up the instance socket and finalizes host.json", async () => {
	// fake-pty-pi.mjs 输入 exit\r → host.state === "exited" 且 !existsSync(instanceSocketPath)
});
```

- [ ] **Step 2: 跑确认失败**（至少第一条：当前 runner 无条件 unlink 共享路径且没有 instance 概念 → 测试构造即失败/行为不符）
- [ ] **Step 3: 实现**（重构 pty-runner.mjs main()：`if (!config.instanceId) return legacyMain()` 包一层，原逻辑原样移入 legacyMain；新协议路径写在主函数）
- [ ] **Step 4: 跑确认通过 + 既有 integration 全绿**（legacy 分支保证）
- [ ] **Step 5: Commit** — `fix(runner): per-instance endpoint, bind-before-child, unified owner-fenced finish (issue #70)`

---

### Task 8: runner starting 协议 + input ack + revoke（A13 runner 半）

**Files:**
- Modify: `runner/pty-runner.mjs`
- Test: `test/pty-runner.integration.test.mjs`（扩展）、`test/host-input.test.mjs`（runner 侧断言，Task 13 写 service 侧）

**Interfaces:**
- Produces（协议变更，仅新协议分支）：
  - child 为 null 时：`hello` → `{type:"hello", status:{...host, state:"starting", readyAt:null, instanceId}}`；`input`/`interrupt` → `{type:"error", code:"host_starting", requestId}`；`resize` → 缓存最后一次，child ready 后应用。
  - child ready 后：`input` 带 `requestId` → 去重表（Map，上限 1000，FIFO 淘汰）命中 → 直接 `{type:"input_ack", requestId}`；未命中 → `child.write(data)` 成功 → 记录 requestId → `{type:"input_ack", requestId}`。
  - `stopRequestedAt` revoke：heartbeat 检测后 `finishHost("revoked", 0)`。

- [ ] **Step 1: 写失败测试**

```js
test("input before child ready gets host_starting; after ready gets input_ack; duplicate requestId is deduped", async () => {
	// 新协议 runner，用慢启动 child fixture（test-support/fake-coldstart-tui-pi.mjs 或新增 sleep fixture）
	// 1) starting 窗口内 send input {requestId:"r1"} → 收到 error host_starting
	// 2) 等 ready → send input {requestId:"r1", data:"x\r"} → input_ack
	// 3) 再发同 requestId → input_ack 且 child 侧 echo 只出现一次（读 screen.log 计数）
});

test("revoke via host.json stopRequestedAt triggers controlled shutdown", async () => {
	// 新协议 runner alive 后，用 updateOwnedHost 写 stopRequestedAt/revokeToken
	// → runner 在 ~1.5s 内退出、host.json state === "exited"、instance socket 被清理
});
```

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑确认通过**
- [ ] **Step 5: Commit** — `feat(runner): starting protocol, input ack with requestId dedup, revoke shutdown (issue #70)`

---

### Task 9: host-crash owner-aware（A9/A11 crash 路径）

**Files:**
- Modify: `src/core/host-crash.mjs`
- Modify: `runner/pty-runner.mjs`（调用点传 instanceId）
- Test: `test/host-crash.test.mjs`（扩展）

**Interfaces:**
- Modifies: `finalizeHostCrash(root, viewId, host, error, opts?)` — `opts.expectedInstanceId` 存在时改走 `updateOwnedHost(root, expectedInstanceId, ...)`；ownerChanged 时不写、仅记 diagnostic；无 expectedInstanceId 保持旧行为（legacy）。
- runner 新协议分支调用：`finalizeHostCrash(config.root, config.viewId, host, err, { expectedInstanceId: config.instanceId })`。

- [ ] **Step 1: 写失败测试**

```js
test("finalizeHostCrash refuses to overwrite a superseded instance", () => {
	// host.json = instanceId b/alive；调用 expectedInstanceId=a 的 crash finalize
	// → 磁盘 host 仍是 b/alive；diagnostics 有 owner_changed 记录
});
```

- [ ] **Step 2-5:** 标准 TDD 循环；Commit — `fix(host-crash): fence crash finalize by expected instance (issue #70)`

---

### Task 10: service 两阶段 launch + 幂等 ensureHost（A4/A8 单进程层）

**Files:**
- Modify: `src/runtime/service.mjs`
- Test: `test/service.test.mjs`（扩展）

**Interfaces:**
- Consumes: Task 1/3/5 全部接口；Task 2 `isStartingWithinGrace/canReplaceHost`
- Produces（createService 内部/返回对象改动）：
  - 内部 `launchHost(meta, initialPrompt, launchOpts)` 重写为 spec §6.1 流程，返回 `{ok:true, status:"started"|"pending"|"reused", pid, socketPath, instanceId} | {ok:false, error, fallbackReason?}`；socketPath 用 `hostEndpointPathFor(process.platform, root, meta.id, instanceId)`；claim→spawn→updateOwnedHost(runnerPid/identity/runnerSpawnedAt) 全程持 `host-start` lease（`acquireOwnedViewLock`，显式 attach/dispatch 路径 `waitMs: HOST_START_LOCK_WAIT_MS`）。
  - `createService` opts 新增注入点：`randomId?: () => string`（默认 crypto randomBytes）、`now?: () => number`、`acquireLock?: typeof acquireOwnedViewLock`、`tryAcquireLock?: typeof tryAcquireOwnedViewLock`（测试可注入争用）。
  - `ensureHost(viewId)` 按 spec §8.1：hostActive → `{ok:true, pending:true, socketPath, instanceId}`；否则 `tryAcquireLock(host-start)` → 争用 `{ok:true, pending:true}` → 锁内重读 + claim + spawn；返回补 `instanceId`。
  - `dispatch/reply/drainNextFollowUp` 适配三态返回：`pending/reused` 且带 prompt → `enqueueFollowUp(root, viewId, prompt, {kind, delivery:"auto", source:"user"})` 并返回 `{ok:true, queued:true}`；只有 started 才走原 `markQueued` 语义。
  - `pruneWarmHosts`/`archiveView`/`terminateHost` 的 `sendHostMessage({type:"terminate"})` 改为调用 Task 11 的 `requestHostStop`（先占位接口，Task 11 实现后接线；本任务保留 sendHostMessage 调用但加 TODO 注释禁止——不，改为本任务直接串联 Task 11 的顺序：先 Task 11 再改这些调用点，见任务依赖说明）。

**任务依赖说明：** Task 10 与 Task 11 强耦合（停止语义），实现顺序固定 10→11→12；Task 10 的测试只覆盖 launch/ensure/pending 语义，不测 stop。

- [ ] **Step 1: 写失败测试**（`test/service.test.mjs` 追加）

```js
test("ensureHost returns pending for a fresh starting claim with null runnerPid", () => {
	// writeHost({state:"starting", instanceId:"i1", runnerPid:null, childPid:null, claimAt: Date.now(), socketPath: hostEndpointPathFor(...)})
	// svc.ensureHost("v1") → {ok:true, pending:true, instanceId:"i1"}；launchHost stub 调用数 0
});

test("concurrent ensure in-process: second call sees pending and never spawns", () => {
	// 第一次 ensureHost spawn（launchHost stub 返回 pid=process.pid）；立即第二次 → pending，stub 调用数仍 1
});

test("lock contention yields pending without spawn", () => {
	// 注入 tryAcquireLock 返回 {acquired:false, reason:"busy"} → ensureHost → {ok:true, pending:true}，不 spawn
});

test("dispatch with pending host enqueues the prompt instead of dropping it", () => {
	// 构造已有 starting claim 的 view；svc.dispatch?（dispatch 是新 view，改用 reply）
	// svc.reply("v1", "hello") → {ok:true, queued:true}；readFollowUpQueue 有 1 条
});
```

- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**（注意 `launchHost` 现有 4 个调用点 L493/L612/L645/L695 全部适配新返回三态；`attachTarget` 本任务不动）
- [ ] **Step 4: 跑确认通过 + service 既有测试回归**
- [ ] **Step 5: Commit** — `feat(service): two-phase host claim and idempotent ensureHost (issue #70)`

---

### Task 11: requestHostStop + recoverHost（A10 unit 层）

**Files:**
- Modify: `src/runtime/service.mjs`
- Test: `test/host-recovery.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 2 `processIdentityState/canReplaceHost`；Task 5 `updateOwnedHost`；Task 3 lease
- Produces（挂在 service 返回对象）：
  - `requestHostStop(viewId, expectedInstanceId, reason) -> {ok:true, requested:boolean} | {ok:false, error}`：host-meta 锁内确认 instance → 写 `state:"stopping"` + stopRequestedAt/revokeToken/stopReason；不 signal。
  - `recoverHost(viewId, expectedInstanceId) -> Promise<{ok:true, recovered:true} | {ok:false, error:"recovery_pending"|...}>`：按 spec §8.2 七步；进程观测用注入 `observeProcess(identity) -> "not_started"|"dead"|"owned"|"foreign"|"unknown"`（默认实现读 /proc，Linux；其他平台 unknown）；signal 用注入 `signalOwnedProcess(identity, signal)`（默认包装 process.kill，仅 owned 时发送）。
  - `createService` opts 追加 `observeProcess?: fn`、`signalOwnedProcess?: fn`。
  - `pruneWarmHosts`/`archiveView`/`terminateHost` 的 terminate 改走 `requestHostStop`（sendHostMessage terminate 仅作 best-effort 附加，且只在 probe 成功时才发——简单起见：直接删除这三处的 sendHostMessage terminate，统一走 revoke）。
  - `stop(viewId)` 的 host 分支 `sendHostMessage({type:"interrupt"})` 保留（interrupt 语义不是终止 host，是打断当前 turn）；但 `row.hostAlive` 判断改 `row.hostReady`。

- [ ] **Step 1: 写失败测试** `test/host-recovery.test.mjs`：

```js
test("requestHostStop marks stopping with a revoke token and never signals", () => { /* updateOwnedHost 断言 + signalOwnedProcess 调用数 0 */ });
test("recoverHost waits for owned child exit before claiming a replacement", async () => { /* observeProcess 序列：owned→dead；断言 claim 发生在 dead 之后；instanceId 换新 */ });
test("recoverHost refuses to signal unknown identity and stays pending", async () => { /* observeProcess → unknown；断言 signal 0 次，返回 recovery_pending，无新 claim */ });
test("recoverHost does not signal a foreign pid", async () => { /* observeProcess → foreign；signal 0 次；可按 dead 处理继续 */ });
```

- [ ] **Step 2-5:** 标准 TDD；Commit — `feat(service): file-based host revoke and identity-checked recovery (issue #70)`

---

### Task 12: resolveAttachTarget（A12/A15 service 层）

**Files:**
- Modify: `src/runtime/service.mjs`
- Test: `test/host-resolver.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 6 `probeHost`；Task 10 `ensureHost`；Task 11 `recoverHost`；Task 5 hostActive/hostReady
- Produces：
  - `resolveAttachTarget(viewId, opts?) -> Promise<...>`（签名按 spec §7.2 四态返回）
  - `createService` opts 追加 `probeHostFn?: typeof probeHost`、`sleepFn?: (ms)=>Promise<void>`（测试用 fake clock）
  - 同 service 实例并发去重：模块内 `const inflight = new Map()`，key=viewId；resolver 结束时 finally delete。
  - 锁纪律：UI 进程内只用 tryAcquire + sleepFn 重试，不用阻塞 acquire。

- [ ] **Step 1: 写失败测试**：

```js
test("resolver waits out a starting host and returns pty once probe is ready", async () => { /* fake probe: starting→starting→ready；断言 ensureHost 0 次新 spawn、recoverHost 0 次 */ });
test("resolver recovers a stale ready-claimed host then attaches to the replacement", async () => { /* host alive 但 probe 连续 stale/unknown 超 grace → recoverHost 被调 1 次 → 新 instance ready → 返回 pty 且 instanceId 为新的 */ });
test("resolver never downgrades to session while an unknown host may be alive", async () => { /* probe unknown + recovery_pending → 返回 kind:"pending"，session switch 不发生 */ });
test("resolver keeps isAgentBusy guard for live json-runner sessions", async () => { /* 无 host + row.alive queued/working → pending，ensureHost 0 次 spawn（spec §7.2-9） */ });
test("concurrent resolver calls for the same view share one inflight promise", async () => { /* 两次并发调用 → probe 调用次数与单次相同 */ });
```

- [ ] **Step 2-5:** 标准 TDD；Commit — `feat(service): async attach resolver with real probe and bounded recovery (issue #70)`

---

### Task 13: sendHostInput + queue 整合（A13 service 侧）

**Files:**
- Modify: `src/runtime/service.mjs`
- Test: `test/host-input.test.mjs`（新建；runner 侧 ack 断言已在 Task 8）

**Interfaces:**
- Consumes: Task 8 协议（`input_ack`/`host_starting`）
- Produces：
  - `sendHostInput(row, text, { requestId, timeoutMs = 2000, connect? }) -> Promise<{ok:true} | {ok:false, error, retryable:boolean}>`：connect → 发 `{type:"input", requestId, data}` → 等 `input_ack`；收到 `host_starting`/connect error/timeout → `{ok:false, retryable:true}`。
  - `reply()`：host 路径改走「先 enqueueFollowUp 拿 item.id 作 requestId → sendHostInput → 成功 completeFollowUp / 失败 releaseFollowUp」；不再直接 sendHostMessage。
  - `drainNextFollowUp()`：claimed item 走 sendHostInput（requestId=item.id）；失败 releaseFollowUp 保留队列。

- [ ] **Step 1: 写失败测试**：

```js
test("reply over host requires input_ack; host_starting keeps the prompt queued", async () => { /* fake runner 连接先回 host_starting → reply 返回 queued/pending，queue 仍有 item；再 fake ack → complete */ });
test("failed send releases the claimed follow-up exactly once", async () => { /* drainNextFollowUp + connect error → item 回到 queued，completeFollowUp 调用数 0 */ });
```

- [ ] **Step 2-5:** 标准 TDD；Commit — `feat(service): ack-based host input with durable follow-up retention (issue #70)`

---

### Task 14: attach-flow / agent-board 只走 resolver（A12 调用契约）

**Files:**
- Modify: `src/commands/attach-flow.ts`
- Modify: `src/commands/agent-board.ts`
- Test: `test/attach-flow.test.mjs`（新建，service/ctx 用 fake）

**Interfaces:**
- Consumes: Task 12 `resolveAttachTarget`
- Modifies：两个 attach 实现删除「attachTarget → openPtyAttach / ensureHost → openPtyAttach」双路径，改为：

```ts
const resolved = await service.resolveAttachTarget(viewId);
if (resolved.kind === "pty") { /* openPtyAttach(resolved.socketPath) */ }
else if (resolved.kind === "session") { /* 现有 switchSession 路径 */ }
else if (resolved.kind === "pending") { ctx.ui.notify(resolved.reason ?? "Session host is starting…", "info"); return { action: "none" }; }
else { ctx.ui.notify("Session no longer exists.", "warning"); return { action: "none" }; }
```

- 前置 `row.alive && !row.hostAlive` 判断改为：`row.hostActive` → 直接 resolver；否则维持现有 stopFirst/notify 逻辑（用 `isAgentBusy` 语义）。
- `attachTarget()` 本身保留（store hint），但这两个文件不再调用。

- [ ] **Step 1: 写失败测试**（fake service 记录调用序列；断言「只调用 resolveAttachTarget 一次，不调用 attachTarget/ensureHost」；pending → notify + action none；pty → openPtyAttach 拿到 socketPath）

- [ ] **Step 2-5:** 标准 TDD；`npx tsc --noEmit` 必须过（TS 文件）；Commit — `refactor(attach): single async resolver entry, no hint-then-ensure double path (issue #70)`

---

### Task 15: dashboard prewarm 幂等 + 前置判断（A14）

**Files:**
- Modify: `src/ui/dashboard.ts`
- Test: `test/dashboard-prewarm.test.mjs`（新建，fake service）

**Interfaces:**
- Modifies：
  - `prewarmSelected()`：`row.hostActive` → 视为已有 host，置 `prewarmedId = id`（不再依赖 `res?.ok` 才标记；`pending` 也标记）；
  - `requestAttach(row)`：`row.hostActive` → 直接 `done({action:"attach", stopFirst:false})`（resolver 处理 starting/stopping）；`!hostActive && isAgentBusy(row)` → 现有 confirm stopFirst；否则直接 attach；
  - 渲染处 `row.hostAlive` 显示保持不动（glyph 语义不在本期）。

- [ ] **Step 1: 写失败测试**：连续 `moveSelection` 经过 starting view → `prewarmHost` 调用 ≤1 次；hostActive 行 attach 不经 confirm。
- [ ] **Step 2-5:** 标准 TDD；`npx tsc --noEmit`；Commit — `fix(dashboard): idempotent prewarm for pending hosts and hostActive attach prelude (issue #70)`

---

### Task 16: 跨进程并发集成测试（A8/A9/A10 多进程层）

**Files:**
- Create: `test/host-concurrency.integration.test.mjs`
- Create: `test-support/ensure-host-helper.mjs`（独立 Node 进程入口：读 argv 的 root/viewId，createService 真实依赖，调 ensureHost，打印结果 JSON）

**Interfaces:**
- Consumes: Task 3/5/10 全部真实实现（不注入 fake）
- 覆盖：
  - **A8**：两个 `ensure-host-helper.mjs` 子进程并发跑 → 断言：diagnostics.jsonl 里 `launch_host` 恰好 1 条；`ps`（`isAlive`）只有 1 个 runner；host.json 与 host-pid.json instanceId 一致；helper B 输出 `pending:true`。
  - **A9**：实例 A alive 后手工把 host.json 换成实例 B → 用 A 的 runnerPid 发 SIGTERM 模拟迟到退出（或直接调 updateOwnedHost 用旧 token）→ host.json 保持 B。
  - **A10**：实例 A alive，把其 socket 文件删掉模拟 endpoint 失效（或 kill -STOP 模拟挂起）→ 一个 helper 进程跑 resolver（带短 timeout）→ 断言旧 runner/child 退出后才有新 childPid，且期间任意采样点 `isAlive(旧childPid) && isAlive(新childPid)` 不同为 true。

- [ ] **Step 1: 写测试（先跑确认在 Task 10-12 完成前的行为下失败——可在 worktree 用 `git stash` 或注释跳过方式验证；实操上直接在实现完成后跑红→绿不必强求，TDD 顺序以「测试先于 Task 16 的实现性收尾」为准：本任务无生产代码改动，只补测试）**
- [ ] **Step 2: 跑通**；若 flaky 调整 waitFor 窗口（沿用现有 `waitFor(predicate, timeout)` 工具，禁止裸 sleep 断言时序）
- [ ] **Step 3: Commit** — `test(host): cross-process launch/revoke/fencing integration coverage (issue #70)`

---

### Task 17: 全量回归 + 类型 + 打包（A16）

- [ ] **Step 1:** `cd $WT && npm run typecheck && npm test && npm run test:coverage && npm run pack:dry`
- [ ] **Step 2:** 修复所有 legacy 测试回归（重点：固定 `control.sock` 相关测试只在 legacy 分支下跑；新增协议测试读 `readHost().socketPath`）
- [ ] **Step 3:** 静态自查：`rg -n "unlinkSync" runner/ src/` —— 新协议路径不得出现对共享/固定 socket 的无条件 unlink；`rg -n "writeHost\(" src/ runner/` —— 生产路径只剩 store.mjs 内部实现处
- [ ] **Step 4: Commit**（如有修复）— `test: full regression alignment for host ownership protocol (issue #70)`

---

### Task 18: 用户实测 U1 / U2（post-implementation manual verification）

**U1（Linux，必做）：**

- [ ] 隔离 root 复现原始场景：
  1. `export AGENT_BOARD_ROOT=$(mktemp -d)/board`
  2. 终端 A：启动 pi 并 `/agent-board`，dispatch 一个 session；终端 B：再开一个 pi + `/agent-board` 指向同一 root
  3. 两边同时对同一 view 快速移动选中/attach（复现 issue 的并发 prewarm/attach）
  4. 观察：`ps aux | grep pty-runner` 仅 1 个宿主；`ss -xlp | grep control` 仅 1 个 LISTEN；`cat $AGENT_BOARD_ROOT/views/<id>/host.json` state/readyAt 正常
  5. 实际 attach 成功，输入回显正常，detach 后 host 仍健康
- [ ] 记录观察结果到 issue 评论（命令 + 输出摘要）

**U2（Windows）：** 无 Windows/WSL2 实机 → 标记 `pending`，最终报告如实呈现，不宣称完成。

---

## Self-Review 记录

- **Spec 覆盖**：A1→T2/T5；A2→T3；A3→T1/T4；A4→T10；A5→T6；A6/A7/A11→T7；A8→T10+T16；A9→T5/T9/T16；A10→T11+T16；A12→T12/T14；A13→T8/T13；A14→T15；A15→T12/T14；A16→T17；U1/U2→T18。spec §8.4 生命周期停止（prune/archive/terminate 走 revoke）→T11。无遗漏。
- **类型一致性**：`acquireOwnedViewLock/tryAcquireOwnedViewLock`（T3）= T10/T12 注入名 `acquireLock/tryAcquireLock` 的默认值；`claimHost/updateOwnedHost`（T5）签名与 T7/T9/T10/T11 调用一致；`hostEndpointPathFor`（T1）在 T4（间接）、T7、T10 使用一致；`probeHost`（T6）与 T12 `probeHostFn` 一致；`sendHostInput`（T13）依赖 T8 的 `input_ack`。
- **placeholder 扫描**：T3 的 `releaseWithToken` 已在任务内注明二选一实现方式；其余无 TBD/TODO。
