# Issue #301 — root cause report & fix design

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-23T22:52:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-23T23:07:00+08:00 (round 1: R1-G1, R1-G2, R1-D1..D6)
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-23T23:16:00+08:00 (round 2: R2-D1..D6)
Issue: https://github.com/zhuxixi/pi-agent-board/issues/301
Baseline: `pi-agent-board` 0.13.1 @ `b003dd1`
Research: issue workspace `~/.github-issue-driven/zhuxixi/pi-agent-board/issue-301/research/repro-and-code-path.md`
(issue workspace, not in the repo; the deterministic repro is reproduced by A3 and quoted in the issue thread)

## 1. Summary

A terminal (`exited` / `failed`) host record keeps `runnerPid`. Once the kernel recycles that pid to an
unrelated process, `canReplaceHost()` can never return `true` again: the observation collapses to
`unknown`, `ensureHost()` returns `pending` forever, and `resolveAttachTarget()` burns its whole budget
to report the generic `host start timed out`. Attach and prewarm for that view are permanently broken,
silently, and no restart heals it.

**The defect is one call site, not the contract.** The pure decision layer already models pid reuse as
`foreign` (releasable, `test/host-coordination.test.mjs:105`), but the production observation
(`conservativeObservation()`) can only emit `dead` or `unknown`, so `foreign` is unreachable. The
identity-aware observation the recovery paths already use was never wired into this gate
(`src/runtime/service.mjs:2881-2883` says so: *"Task 11 replaces this with identity-aware observation"*).

Reproduced on current main: `ensureHost` → `{ok:true, pending:true, socketPath:<stale>, instanceId:"old-instance"}`,
`launches: 0`; `resolveAttachTarget(400ms)` → `{kind:"pending", reason:"host start timed out"}`; record unchanged.

## 2. Goals / non-goals

**Goals**

1. A terminal record whose recorded pids provably belong to someone else (`foreign`) or are gone
   (`dead` / `not_started`) is releasable — on every platform, through one decision path.
2. A refusal is visible: one `host_replace_blocked` diagnostic naming role, pid and observation, and a
   pending reason that names the blocking pid instead of the generic timeout.
3. New terminal records stop carrying pids at all, so the wedge cannot be re-created going forward,
   even on platforms where the identity probe is unavailable.
4. No behaviour change for a record that names a genuinely live host (`owned`): never release, never signal.

**Non-goals**

- `canReplaceHost()` semantics stay as-is; no new observation state.
- The replace gate never signals or kills a process — that remains `recoverHost()`'s job.
- No migration of existing `host.json` files: the fix heals them lazily on the next ensure/attach.
- Not touching the `stopping`-state recovery path, the warm-host sweeper, or the **eligibility rule** for
  legacy finalization (`canFinalizeLegacyHost` stays as-is). The *payload* written when that rule fires is
  in scope (§4.3 / A9), because a finalized legacy record is exactly the kind of stale-pid record this
  issue is about.

## 3. Decision: identity-aware, asynchronous replace gate

| Option | Shape | Verdict |
| --- | --- | --- |
| **A (chosen)** | Make `observeHostForReplace()` identity-aware via the existing `observeHostRole()` and therefore async; propagate `async` to `startHostUnderLease` → `ensureHostImpl` → `ensureHost` / `prewarmHost`. | One decision path, full platform coverage (linux token, win32 `ct:` token, probe fallback on all), heals persisted wedges on first attach/prewarm. |
| B | Keep the gate sync and classify with `captureStartToken()` (sync `/proc` read) only. | Rejected: macOS/Windows keep the permanent wedge — `readProcessStartToken` has no sync path there; also duplicates the identity rule in a second implementation. |
| C | Keep the sync gate and add an async repair step inside `resolveAttachTargetInner` before `ensureHost`. | Rejected: `ensureHost` / `prewarmHost` callers stay wedged, and the same rule would exist in two places with different fidelity. |
| D | Only stop writing pids on the terminal update. | Rejected alone: does not heal the records already on disk (137 terminal records on the reporter's board, 1 already wedged) and does nothing on platforms where an old record's probe is unavailable. Kept as defence in depth (§4.3). |

Why async is acceptable: `ensureHost` / `prewarmHost` are internal service methods (`createService` consumers
are the dashboard, the command layer via `resolveAttachTarget`, and tests). All production callers are either
already async (resolver, `launchForView`) or fire-and-forget (dashboard prewarm). The 3 s win32 probe bound
applies only to terminal records that carry a recorded token, and the leases involved are non-blocking
(`tryAcquireOwnedViewLock` returns `busy` instead of waiting).

## 4. Component contracts

### 4.1 Observation (I/O shell, inside `createService`)

```js
/**
 * #301: identity-aware replacement observation for a terminal host record.
 * Same seam as the recovery paths (observeHostRole): recorded start token is
 * compared against the live process, and an `unknown` token path is refined by
 * the command-line / creation-time probe (#217). Injected observers make every
 * branch unit-testable without real processes.
 * @param {HostStatus} host
 * @param {string} sessionFile  child command-line fragment
 * @returns {Promise<{host, runnerObservation, childObservation, launchLeaseActive:boolean}>}
 */
async function observeHostForReplace(host, sessionFile)
```

- `runnerObservation` / `childObservation` ∈ `not_started | dead | owned | foreign | unknown`.
- Both roles observed with a fresh `probeMemo` / `tokenMemo` per ensure call (each pid read at most once
  per call, never across calls — a cached `owned` would be a stale verdict).
- `launchLeaseActive` stays `false`: the caller (service) is the one holding the lease, and the pure gate
  already refuses a non-terminal host.
- `conservativeObservation()` is deleted (no other caller).

### 4.2 Gate + refusal surface

```js
// startHostUnderLease (now async)
const observation = existing ? await observeHostForReplace(existing, meta.sessionFile) : null;
if (observation && !canReplaceHost(observation)) return blockedLaunchResult(existing, observation);
if (observation) appendDiagnosticOnce(root, meta.id, { code: "host_replace_released", level: "info",
	details: { oldInstanceId, runnerPid, childPid, runnerObservation, childObservation } },
	{ match: ["oldInstanceId"] });
```

`blockedLaunchResult(host, observation)` (new helper, alongside `pendingLaunchResult` at
`src/runtime/service.mjs:309`):

- writes `host_replace_blocked` (level `warn`) with
  `details: { instanceId, runnerPid, childPid, runnerObservation, childObservation }`,
  deduped by `appendDiagnosticOnce(..., { match: ["instanceId", "runnerPid", "childPid"] })`;
- returns `{ ok: true, status: "blocked", pid: null, socketPath: null, instanceId: null,
  blocked: { instanceId, runnerPid, childPid, runnerObservation, childObservation, reason } }`
  — **no stale `socketPath` / `instanceId`**, unlike `pendingLaunchResult()`;
- `reason` comes from the new pure formatter (§4.4).

`ensureHost` / `prewarmHost` return the same shape (`started:false, pending:true` and `blocked` present).
The resolver keeps the structured `blocked` payload for its final reason (§4.5).

### 4.3 Terminal write hygiene (defence in depth)

- `runner/pty-runner.mjs` `finishHost()` terminal update clears **all six** role fields, mirroring
  `recoverHost()` (`src/runtime/service.mjs:1358-1364`): `runnerPid`, `runnerIdentity`,
  `runnerSpawnedAt`, `childPid`, `childIdentity`, `childSpawnedAt` → `null` (today only `childPid`
  is cleared; `childIdentity` / `childSpawnedAt` written at `runner/pty-runner.mjs:1484-1485` survive
  into the terminal record, so a recycled child pid would still be observed through the identity
  path). `runner/pty-runner.mjs:1082-1098`.
  Ordering note: the terminal write runs after `killChild` + `waitForChildExit` (`runner/pty-runner.mjs:1073-1077`),
  so no live role exists by construction; it does **not** depend on the start lease being released first —
  the post-ready path releases it at `:1516`, while boot-failure paths (`finishHost("endpoint_busy")`,
  `"child_spawn_failed"`) still hold it and release at `:1114`. Safety comes from the child being dead
  plus the owner-fenced write, not from lease ordering.
- `finalizeDeadLegacyHost()` (`src/runtime/service.mjs:2850`, write at `:2865`) adds `runnerPid: null` to the finalized
  write **and** explicitly calls `writeHostPid(root, viewId, null)` (`src/core/store.mjs:131`):
  `writeHost()` (`store.mjs:121`) only writes `host.json` — the `host-pid.json` mirror is written by
  `claimHost` / `updateOwnedHost` (`store.mjs:242`, `:313-318`), and legacy records have no
  `instanceId`, so `updateOwnedHost` can never reach this record.
- Consequence for `store.loadRow()`: `Object.hasOwn(host, "runnerPid")` stays `true` (the property is
  present, just `null`), so the legacy mirror fallback still applies to old records and never to new ones.
  Terminal records are inactive for `hostAlive` / `hostActive` and for `screen-log-gc` regardless of pid.
- No other consumer reads a terminal record's `runnerPid` (verified: `store.mjs` liveness projection,
  `screen-log-gc.mjs:162`, `warm-host-sweeper.mjs`); the launch pid stays in the `launch_host` diagnostic.

### 4.4 Pure formatter (new, `src/core/host-coordination.mjs`)

```js
/**
 * Human-readable reason for a refused replacement (#301). Null when the
 * observation is releasable, so callers never format a non-block.
 * Format: `host replace refused: runner pid 4189 (unknown) · child pid 1610 (foreign)`
 * Role order is fixed (runner, child); missing pids render `pid ?`.
 */
export function describeHostReplaceBlock({ instanceId, runnerPid, childPid, runnerObservation, childObservation })
```

- Consumes the same five fields the diagnostic carries; no I/O, no state.
- Message stays short enough for the attach notify line (~120 cols target);
  the pid + observation + role is what makes it actionable.

### 4.5 Resolver (attach)

In `resolveAttachTargetInner`, the terminal-record branch:

1. `const res = await ensureHostImpl(viewId)`;
2. if `res.blocked`, remember `lastBlock = res.blocked`, `lastBlockedAt = nowImpl()`;
3. while blocked and inside the deadline, retry `ensureHostImpl` at most `HOST_REPLACE_RETRY_LIMIT` (2)
   further times, spaced by `HOST_REPLACE_RETRY_MS` (1000 ms), then return
   `pending(sessionFile, lastBlock.reason)` immediately instead of sleeping to the deadline;
4. if no ensure ever blocked and the deadline hits, the existing `host start timed out` reason is kept.

`HOST_REPLACE_RETRY_MS` / limit are module constants (not env knobs) so the blocked path stays bounded:
at most 3 observations, and on win32 at most 6 probe calls of ≤3 s each, all inside the resolver budget.
The retry exists for the *transient* case (old runner still finishing its own teardown: `owned` for a few
hundred ms); `unknown` blocks are not expected to self-heal but cost only ~2 s extra before an actionable
message.

### 4.6 API propagation (async)

`startHostUnderLease`, `ensureHostImpl`, `ensureHost`, `prewarmHost` become `async`. Touch points are
enumerated exhaustively (grep `ensureHost(` / `prewarmHost` at implementation time; the counts below are
the verified inventory at `b003dd1`):

Production

- `launchForView` — already `async`, already awaits (`service.mjs:302`).
- `resolveAttachTargetInner` — two call sites (`:1579`, `:1645`, both inside the async loop) gain `await`.
- `src/ui/dashboard.ts` `prewarmSelected()` — see the in-flight guard below.
- `service.reply()` / follow-up drain call `launchHost`, not `ensureHost`; no change there.

Tests and scaffolding (runtime failure, **not** caught by `tsc` — `tsconfig.json` excludes `test/` and
`test-support/`, and `checkJs` is false, so `npm run typecheck` only covers `index.ts` + `src/**` +
`runner/**`):

- `test/service.test.mjs` (7 call sites), `test/host-resolver.test.mjs` (8), `test/host-recovery.test.mjs` (1)
  → `await svc.ensureHost(...)` plus `async` test callbacks where needed.
- `test-support/ensure-host-helper.mjs`, `test-support/attach-entry-22-scenario.ts`,
  `test-support/attach-ready-entry-scenario.ts` → await inside their async mains.
- `test-support/dashboard-prewarm-smoke.ts` and the `prewarmHost` stubs in `dashboard-scroll.ts`,
  `dashboard-fold.ts`, `dashboard-tui-modes.ts`, `dashboard-selection-settle-scenario.ts` → return a
  promise (`async () => ({ ok: false })`).

The runtime safety net for those files is `npm test`, not `typecheck`.

**Dashboard prewarm keeps exactly-once semantics.** `prewarmSelected()` gains an in-flight guard
(`prewarmingId: string | null`): a repeat selection of the same id before the promise settles returns
immediately, so same-tick re-entry still calls `prewarmHost` once; `prewarmedId` is marked only after
`res.ok` and the guard is cleared in `finally` (failure path leaves both unset, matching
`planPrewarm`'s "mark only on ok" contract). The smoke script (`dashboard-prewarm-smoke.ts`) must run
its scenarios inside an `async` main and **flush until the pending promise settles** (loop
`await Promise.resolve()` or `await new Promise((r) => setImmediate(r))`) before the final
`process.stdout.write`: one microtask turn is not enough, because the stub resolve → `then` →
`prewarmedId` chain spans at least two turns. `test/dashboard-prewarm.test.mjs:92-93` asserts call counts
and `prewarmedId` after the script exits. Guarantee boundary: a *different* selection resolving late does
not unset `prewarmedId` (same as today); only the in-flight guard is new.

**`status: "blocked"` propagates.** `startHostUnderLease`'s result reaches `launchHost` → `dispatch` /
`reply` (`service.mjs:1804`, `:2092`, `:2188`); all three treat any non-`started` status as "prompt
queued", so behaviour is unchanged, but the `launchHost` JSDoc status enum (`service.mjs:283`) gains
`"blocked"` so the contract is not silently widened.

## 5. Data flow

```
attach → resolveAttachTarget
        └─ row.hostActive === false (terminal record)
             └─ ensureHost (async)
                  └─ host-start lease (non-blocking)
                       └─ startHostUnderLease (async)
                            ├─ observeHostForReplace  (token → probe)
                            │    ├─ canReplaceHost false → host_replace_blocked + blocked payload
                            │    └─ canReplaceHost true  → host_replace_released + claim → spawn
                            └─ pending result (started:false | blocked)
        └─ blocked → retry ≤2× (1 s spacing) → specific pending reason | spawn → probe → pty
```

## 6. Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | 纯决策层不变：`foreign/not_started/dead` 可替换，`unknown` 拒绝 | 自动化验证（unit） | `node --test test/host-coordination.test.mjs`（既有矩阵，不改语义） | 现有断言全绿 |
| A2 | 纯 formatter：blocked 原因含角色/pid/观测，可替换时为 null | 自动化验证（unit） | 新增 `test/host-coordination.test.mjs` 用例（4 种观测组合 × pid 缺失） | 字符串与 `null` 断言通过 |
| A3 | 终态记录 + 回收 pid（`foreign`）⇒ 替换成功并 spawn 一次，并留下 release 诊断 | 自动化验证（integration） | 新增 `test/host-replacement.test.mjs`：注入 `readStartToken`/`probeProcessIdentity` 让 live pid 判为 foreign；`await svc.ensureHost()`；再 `readDiagnostics` | `launches === 1`、`started === true`、新 instanceId ≠ 旧；诊断含一条 `host_replace_released` 且 `details.oldInstanceId` 为旧实例，重复调用不再追加 |
| A4 | 终态记录 + 真存活 `owned` runner ⇒ 拒绝，不 spawn，不 signal | 自动化验证（integration） | 同文件：记录 token 与注入的 live token 相同 | `blocked` 非空、`launches === 0`、`process.kill` 未被调用 |
| A5 | 拒绝时写 `host_replace_blocked` 且返回结构不含陈旧 socketPath/instanceId | 自动化验证（integration） | 同文件：读取 `readDiagnostics`，断言 code/details；断言 `res.socketPath === null && res.instanceId === null` | 诊断存在且 `runnerPid`/`runnerObservation` 正确；重复调用不重复写（`appendDiagnosticOnce`） |
| A6 | resolver 以具体原因收尾（含 pid），不再报通用超时 | 自动化验证（integration） | `test/host-resolver.test.mjs`：blocked 记录 + `sleepFn` 即时 | `kind === "pending"` 且 `reason` 含 pid、不含 `host start timed out` |
| A7 | resolver 对瞬时 block 自愈：第二次观测转 `foreign` 后 spawn | 自动化验证（integration） | 同文件：注入观察序列 `["unknown","foreign"]`，记录 ensure 次数 | `kind === "pty"`、ensure 次数 ≤ 3 |
| A8 | 终态写入不再携带任何角色 pid/identity | 自动化验证（integration） | `test/pty-runner.integration.test.mjs` 既有 exited 用例加断言 | 终态记录 `runnerPid`/`runnerIdentity`/`runnerSpawnedAt`/`childPid`/`childIdentity`/`childSpawnedAt` 六个字段均为 `null` |
| A9 | legacy finalize 同时清 host.json 与 host-pid.json 镜像 | 自动化验证（integration） | `test/host-resolver.test.mjs` 既有 legacy 用例加断言 | `host.json` 的 `runnerPid === null` 且 `readHostPid(...) === null` |
| A10 | 类型与全量测试/覆盖率门槛 | 自动化验证（static + build） | `npm run typecheck && npm run verify` | 退出码 0，覆盖率 ≥ lines 85 / funcs 80 / branches 70 |
| A11 | dashboard prewarm 异步化后的 exactly-once + mark-on-ok + in-flight 守卫 | 自动化验证（integration） | `node --test test/dashboard-prewarm.test.mjs`（smoke 改 async main + flush 后仍应全绿） | `idlePrewarmCalls === 1`、`idleMarked === true`、`idleFailMarked === false`、`startingHostPrewarmCalls === 0` |
| U1 | 真实看板上已卡死的 view 恢复 attach | 用户实测 | 升级本地安装后**重启正在运行的看板/pi 进程**（旧扩展代码不会被热更新），再对 `view_7397295fe2` 按 attach，观察耗时与 `diagnostics.jsonl` | ≤1 s 进入 PTY；诊断出现 `host_replace_released`（或 `launch_host`），不再出现 20 s 空白后 `host start timed out` |

## 7. Testability split design (hard constraint for implementation)

| 逻辑 | 形态 | 边界 | 测试 |
| --- | --- | --- | --- |
| `canReplaceHost` | 已有纯函数 | 输入 5 个标量，无 I/O | A1（既有） |
| `describeHostReplaceBlock` | 新增纯函数，`host-coordination.mjs` | 输入 5 个字段，返回 `string`/`null` | A2 |
| `observeHostForReplace` | 薄 I/O 壳，闭包内 | 唯一副作用是 `observeHostRole` 的观测；全部通过既有注入（`observeProcess` / `readStartToken` / `probeProcessIdentity` / `isAlive`） | A3/A4 通过注入序列驱动，不需要真实进程 |
| `blockedLaunchResult` | 薄 I/O 壳 | 一次 `appendDiagnosticOnce` + 纯结果组装 | A5 |
| 终态写入 | `finishHost` 内联对象更新 | 无新抽象；断言终态字段 | A8 |
| legacy finalize | `finalizeDeadLegacyHost` 内联写 | 无新抽象 | A9 |
| resolver 重试循环 | 已有异步循环 | 通过 `sleepFn`/`nowImpl`/观察注入控制时序，不 sleep | A6/A7 |

Implementation must keep these boundaries: no identity judgment re-inlined into
`startHostUnderLease`, no formatting logic in the I/O shell (formatter is pure), and the observed
states must keep flowing through `canReplaceHost` rather than a second boolean rule.

## 8. Risks / mitigations

| Risk | Mitigation |
| --- | --- |
| Async API ripple reaches a caller that ignores the promise | Production surface is covered by `tsc --noEmit` (`src/ui/dashboard.ts:362` is the only TS consumer); `test/` and `test-support/` are excluded from `tsconfig.json`, so their 19 sync call sites are covered by `npm test` at runtime (A10) |
| Releasing a genuinely live host (`owned`) | Gate refuses every non-`SAFE_TO_RELEASE` observation; `foreign` requires a positive token mismatch or command-line mismatch, never "no data" |
| Win32 probe latency while holding the host-start lease | Bound: ≤2 probes/call, 3 s each, only for terminal records that carry a token; other launchers use non-blocking `tryAcquire` and retry |
| Diagnostic flooding on repeated attach clicks | `appendDiagnosticOnce` keyed by `instanceId` + both pids |
| Behaviour change for legacy terminal records | Unchanged: legacy records have no `runnerPid` property → `not_started` (today `conservativeObservation(null)` → `dead`); both are releasable |
| Blocked retry double-spawns | Retries only run when the previous ensure returned `blocked`, and each attempt re-reads `host.json` under the lease (`claimHost` is the final arbiter) |
| Reviewer/QA can't reproduce the wedge | Repro script and exact output are in the issue workspace (`~/.github-issue-driven/zhuxixi/pi-agent-board/issue-301/research/repro-and-code-path.md`) and quoted in the issue thread; A3 encodes the same scenario as a permanent test |

**Rollback**: revert the PR. No persisted schema change (only which fields a terminal write nulls);
old records remain readable, and reverting restores the conservative gate exactly.

## 9. Definition of done

- A1–A10 green via `npm run verify`.
- U1 executed by the user on the real board, or recorded as `pending` with the exact manual steps.
- Issue #301 gets a closing summary comment with the acceptance table and the executed commands.
