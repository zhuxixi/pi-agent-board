# Issue #255 — View State Coordinator endpoint zombie

Status: draft (round 4 revised after cross-review rounds 1–3; cross-review **converged** — no true gaps)
Repo: zhuxixi/pi-agent-board · issue #255 · base `79debb6` (v0.13.0)
Drafted: deepseek-account/deepseek-flash (selected) · deepseek-account/deepseek-flash (physical) @ 2026-10-28T19:36:26+08:00
Revised: deepseek-account/deepseek-flash (selected) · deepseek-account/deepseek-flash (physical) @ 2026-10-28T19:52:00+08:00 — merged recon rounds 2–3
Revised: deepseek-account/deepseek-flash (selected) · deepseek-account/deepseek-flash (physical) @ 2026-10-28T21:12:00+08:00 — round-1 cross-review: accepted R1-G1..G5 + R1-D1..D6 (all)
Revised: deepseek-account/deepseek-flash (selected) · deepseek-account/deepseek-flash (physical) @ 2026-10-28T21:20:00+08:00 — round-2 cross-review: accepted R2-G1/G2 + R2-D1..D4; re-ordered R1/R2 as contract-restoration vs primary self-heal after the R2-D3 physical critique
Revised: deepseek-account/deepseek-flash (selected) · deepseek-account/deepseek-flash (physical) @ 2026-10-28T21:28:00+08:00 — round-3 cross-review: accepted R3-G1 + R3-D1..D7 (all)
Revised: deepseek-account/deepseek-flash (selected) · deepseek-account/deepseek-flash (physical) @ 2026-10-28T21:36:00+08:00 — round-4 convergence: R4-D1 (A6 command pattern) + R4-D2 (status metadata)

## 1. Problem

A live View State Coordinator can end up serving an endpoint that no longer exists on
disk. It keeps the `<_coordinator>` lease and keeps heartbeating, so `ensureCoordinator()`
treats it as healthy-busy, but every client connect fails with ENOENT and the caller
reports `state_command_not_applied … coordinator_unavailable`. Rows freeze at their last
materialized state with no user-visible error. Observed on macOS/APFS; manual recovery
required `kill <pid>`.

## 2. Goals / constraints

- G1 A deposed coordinator must never be able to delete an endpoint it no longer owns
  (restore #70's owner-token half of the cleanup contract).
- G2 A lease holder whose endpoint vanished or was replaced must stop claiming to serve
  and must step down, so the next `ensureCoordinator()` can spawn a replacement. This is
  the **primary** guarantee: it heals socket loss from *any* cause, including causes not
  yet identified (§3.2). POSIX-only (see §4.3).
- G3 No new background timers, no new protocol messages, no diagnostics that can recreate
  a deleted board root beyond the residue #241 already accepts, and no wire change.
- G4 Correct existing behaviour stays: SIGTERM on a healthy owner still unlinks its own
  endpoint (new `#255 A6`), a forced-touch-failure step-down still unlinks (A14), root-gone
  step-down still writes no diagnostic.
- G5 The cleanup fix restores an **existing** repo contract rather than inventing one:
  #70's `cleanupOwnedSocket()` ("dev/ino match **and** owner token match, else no-op",
  `docs/superpowers/specs/2026-09-05-pty-host-stacking-sock-race-design.md:418`).

## 3. Root cause

### 3.1 Confirmed by source (79debb6)

Facts, reconstructed from `runner/state-coordinator.mjs` (`:298-303`, `:344-421`),
`src/core/locks.mjs` (`:302-332`, `:372-419`, `:484-519`), `src/core/host-coordination.mjs`
(`:160-162`) and `src/core/coordinator-client.mjs` (`:488-527`), cross-checked against the
issue's `views/_coordinator/diagnostics.jsonl` timeline:

1. **A stale reclaim can happen while the old owner is still alive.** `reclaimOrBlock` can
   return `reclaim` for a declared lease whose heartbeat file reads as missing:
   `classifyLeaseOwner` falls back to `heartbeatAgeMs ?? lockAgeMs` and reclaims at
   `>= max(60 s, 3×heartbeatMs)` (locks.mjs:318-320, issue #224 D3). The old owner's lock
   directory is renamed to quarantine, so its `touch()` immediately fails
   (`stillOwns()` can no longer read its `owner.json`, locks.mjs:487-508).
2. **The old owner stays up for 3 more seconds.** `heartbeatFailureAction` only steps down
   after `MAX_CONSECUTIVE_TOUCH_FAILURES = 3` supervised failures at 1 s cadence
   (locks.mjs:155, 472). Deterministic: the observed 3.001 s is D4's designed behaviour.
3. **The successor boots and binds its own socket at the same path** (state-coordinator.mjs:298-303
   unlinks the leftover first; libuv's `uv_pipe_bind` additionally pre-unlinks an existing path).
4. **The deposed owner's `shutdown()` deletes the successor's socket through libuv.** The old
   code calls `server.close()` on exit; libuv unlinks the unix-socket path captured at
   `bind()` time, unconditionally (`nodejs/node#19729`: "if your old process calls
   `server.close()` afterwards, it will unlink your *new* socket"). The deposed owner's dev+ino
   comparison never enters into it — the deletion happens inside libuv. **This is the root
   cause**, and it explains the evidence that looked like inode reuse: `lsof` shows the
   successor listening on an inode that `ls` no longer shows.
5. **Nothing heals it.** `ensureCoordinator` probes the missing path (null) → spawns one
   replacement → the replacement loses the lease race to the zombie (fresh heartbeat ⇒
   `busy`) → writes `coordinator_lease_unavailable` → exits 0 → the ~10 s poll window
   expires → `coordinator_unavailable`. `launchCoordinator` never re-spawns, and the
   client has no "endpoint unreachable while the lease looks healthy" shape detector.

Two structural gaps (confirmed): inside `shutdown()`, `lease.release()` is token-fenced but
the endpoint cleanup is not; and the cleanup leans on `server.close()`, whose libuv side
effect deletes whatever occupies the bind path. One guarded resource, one unguarded, one
implicit and unobservable from the project code.

### 3.2 Inferred vs unknown

- **Root cause: libuv's close-time unlink (`nodejs/node#19729`).** A coordinator that closes
  its listener deletes whatever currently occupies its bind path — including a successor's
  endpoint. No inode reuse is needed, and the earlier inode-reuse hypothesis is superseded: it
  is physically implausible (round-2 review: the deposed owner's listener fd keeps the old
  inode alive, so the successor's `bind()` cannot reuse it). The Linux CI run of the new A3/A5
  cases confirmed the libuv mechanism — both failed with the endpoint gone while the code
  under test had already gated its own explicit unlink.
- **The two reclaims in the issue timeline have different (and partly mundane) readings:**
  - `11:10:22, heartbeatAgeMs: 338, lockAgeMs: 346, eligibility: "declared"` — the declared
    heartbeat branch cannot fire at 338 ms (`>= 60_000` required), but `eligibility` only
    records the *record shape*, not which branch fired. The most mundane reading is the
    **normal D1 crash reclaim**: the previous holder stopped touching ~8 ms before its lock
    was inspected and `isProcessDead(pid)` was true (locks.mjs:325-327), which reclaims
    regardless of heartbeat age. Treat "a healthy holder was reclaimed" as open until the
    raw JSONL + pid-liveness evidence is available.
  - `11:20:40, heartbeatAgeMs: null, eligibility: "declared", lockAge >= 60 s` — fully
    explained by D3's declared fallback to lock age (a live holder whose heartbeat read
    failed). Candidate mechanism (unproven, untested): `makeLease.touch()` overwrites the
    heartbeat with a plain in-place `fs.writeFileSync` (locks.mjs:503, no temp+rename), so a
    concurrent POSIX reader can observe a truncated file → `JSON.parse` throws →
    `readLeaseHeartbeat` → null. Reclaim-audit input (R4), not a claimed trigger.
- #104 introduced the coordinator socket cleanup in one commit (`b022a7b`, 2026-09-09), never
  touched since (`git blame` all `b022a7b`); #224 never considered endpoint self-checks (not
  rejected — out of scope); #241 only added another reason to enter `shutdown()` (it guards
  the root directory inode, which an inner-file unlink never changes); #239 proved the
  client cannot infer liveness from a failed probe.

## 4. Fix design

### 4.1 Decision table

| # | Candidate | Verdict | Why |
| --- | --- | --- | --- |
| R2 | Supervise the bound endpoint in the existing 1 s heartbeat tick; step down when missing/replaced | **Do — primary self-heal** | Heals socket loss from any cause; reuses the #241 tick, no new timer; POSIX-only (§4.3) |
| R1 | Stop the implicit libuv unlink (never call `server.close()`) **and** restore the #70 cleanup contract (unlink only when the lease is still ours **and** the path still carries the inode we bound) | **Do — root-cause fix** | Removes the deletion path that actually created the zombie (§3.1 step 4); restores an existing spec'd invariant |
| R3 | Client kills a zombie lease owner before respawn | **No (non-goal)** | R2 caps the zombie window at one tick; #239 established `probe null ≠ dead`, so a client kill needs a boot-grace heuristic that would race the normal 1-3 s boot |
| R4 | Audit reclaim eligibility (declared fallback, torn heartbeat read) | **No (follow-up issue)** | Needs the reporter's raw JSONL + pid liveness; changing #224 D3 is a separate contract decision |
| R5 | Same guard in `runner/pty-runner.mjs` (ownedMain finishHost `:736-743` has dev+ino only; legacy `shutdown()` `:512` is unconditional; both close their listener → same libuv issue) | **No (follow-up issue)** | Different ownership model (per-view host record); own design + tests |
| R6 | Re-derive dropped `agent_end` projections at reconcile | **No (follow-up issue)** | Orthogonal recovery gap |

### 4.2 R1 — stop the implicit unlink, restore the cleanup contract

Two changes in `shutdown()`:

1. **Do not call `server.close()`.** libuv unlinks the bind path when the listening handle
   closes (`nodejs/node#19729`). The process exits immediately afterwards, and
   `process.exit()` skips the uv handle cleanup, so the implicit unlink never runs. Cleanup
   becomes explicit.
2. **Gate the explicit unlink** with `shouldUnlinkEndpoint`.

Pure function, added next to `ownsEndpoint` in `src/core/host-coordination.mjs`:

```js
/**
 * Whether this instance may unlink the endpoint path now.
 * Restores the #70 cleanup contract: the path must still be the inode this
 * instance bound AND this instance must still own the lease. `compromised`
 * lets the supervised tick veto its own cleanup after detecting that the
 * endpoint is gone/replaced (issue #255).
 */
export function shouldUnlinkEndpoint({ stillOwner, compromised, bound, current }) {
    if (!stillOwner || compromised) return false;
    return ownsEndpoint(bound, current);
}
```

`state-coordinator.mjs` shell changes:

- add `let endpointCompromised = false;` next to `boundSocketIdentity`;
- **remove `try { server.close(); } catch {}`** from `shutdown()` (with the nodejs/node#19729
  comment), so no implicit libuv unlink can run;
- before the explicit unlink:
  ```js
  const stillOwner = safeIsOwner();        // lease.isOwner(); false on any throw
  if (process.platform !== "win32" && stillOwner && !endpointCompromised && boundSocketIdentity) {
      try {
          const st = statSync(socketPath);
          if (shouldUnlinkEndpoint({ stillOwner, compromised: endpointCompromised,
              bound: boundSocketIdentity, current: { dev: st.dev, ino: st.ino } })) {
              try { unlinkSync(socketPath); } catch { /* best effort */ }
          }
      } catch { /* path gone — nothing to clean */ }
  }
  ```
  then `lease.release()` as today. `safeIsOwner` reads `lease.isOwner()` and returns false
  on any throw (fail-closed: skip the unlink; the next boot's *boot-time site* unlink cleans
  a leftover file).

Behaviour matrix:

| Scenario | stillOwner | compromised | unlink? |
| --- | --- | --- | --- |
| SIGTERM/SIGINT on healthy owner | true | false | yes (shutdown-time site) — new `#255 A6` pins it |
| Forced-touch-failure step-down, no reclaim (A14) | true | false | yes — regression, **no test change needed** |
| Step-down after the lease moved to a successor | false | n/a | no — R1 contract restoration (§4.2); not the reported trigger (§3.2) |
| Tick detected missing/replaced endpoint (R2) | true or false | true | no — the primary self-heal path |
| Root-gone step-down | true | false | stat ENOENT → no-op |
| owner.json unreadable during shutdown | unknown → false | — | no (fail-closed) |

### 4.3 R2 — supervised endpoint health

Two pure functions in `host-coordination.mjs`, with an explicit three-state observation
(`R1-G1`: a bare string sentinel would make `ownsEndpoint` treat the sentinel as
`"replaced"`), plus an exported classifier for the shell's stat→observation mapping
(`R2-D2`: the "transient error never kills a healthy coordinator" guarantee needs a unit
test, so the mapping must live in the pure module, not in an unexported shell function):

```js
/**
 * Map one stat attempt to the supervised observation discriminator.
 * `errorCode === null` means the stat succeeded.
 * @param {{dev:number,ino:number}|null} stat
 * @param {string|null} errorCode
 * @returns {{kind:"ok",dev:number,ino:number}|{kind:"missing"}|{kind:"unknown"}}
 */
export function socketIdentityObservation(stat, errorCode) {
    if (stat) return { kind: "ok", dev: stat.dev, ino: stat.ino };
    return errorCode === "ENOENT" ? { kind: "missing" } : { kind: "unknown" };
}

/**
 * Classify the supervised endpoint against the identity bound at boot.
 * @param {{dev:number,ino:number}|null} bound
 * @param {{kind:"ok",dev:number,ino:number}|{kind:"missing"}|{kind:"unknown"}|null} observed
 * @returns {"ok"|"missing"|"replaced"|"unknown"}
 */
export function classifyEndpointHealth(bound, observed) {
    if (!bound || !observed || observed.kind === "unknown") return "unknown";
    if (observed.kind === "missing") return "missing";
    return ownsEndpoint(bound, observed) ? "ok" : "replaced";
}
```

Shell: in the existing `heartbeatTimer` tick (state-coordinator.mjs:344), **after**
`rootVanishedOrReplaced` and **before** `lease.touch()`:

```js
const observation = statSocketObservation(socketPath);   // shell: statSync + error code
const endpointState = classifyEndpointHealth(boundSocketIdentity, observation);
if (endpointState === "missing" || endpointState === "replaced") {
    endpointCompromised = true;                  // veto cleanup in shutdown (R1)
    try {
        appendCoordinatorDiagnostic("coordinator_endpoint_lost",
            { state: endpointState }, "warn");
    } catch { /* a failing diagnostic must not block the step-down (#224 D4) */ }
    process.stderr.write(`state-coordinator: endpoint ${endpointState} (${socketPath}); stepping down\n`);
    shutdown(0);
    return;
}
```

with the shell helper `statSocketObservation(socketPath)` doing the single `statSync` and
delegating the classification to `socketIdentityObservation(statOrNull, errCodeOrNull)`.

Details that matter:

- `unknown` never steps down (degrades to today's behaviour).
- **The diagnostic is safe only to the same degree #241 accepts**: the root guard ran first
  with the boot identity, but `captureRootIdentity()` degrades to existence-only when ino is
  0/unavailable, and a delete landing between the guard and the append can leave a directory
  skeleton (exactly the #241-accepted residue: data, not a process).
- **R2 is POSIX-only.** `boundSocketIdentity` is captured only when
  `process.platform !== "win32"` (state-coordinator.mjs:333-339), so on win32 the classifier
  returns `unknown` forever. Deliberate degrade: Windows endpoints are named pipes with no
  unlink/inode semantics; equivalent pipe liveness belongs to #104/#70, not this issue.
- **`boundSocketIdentity == null` also degrades R2 to a no-op on POSIX** (the existing
  listen-callback `statSync` failed; the code already says "cleanup degrades to no-op"). The
  tick then never steps down. To keep that from being silent, the same catch emits one
  stderr line (`state-coordinator: endpoint identity unavailable (…); self-supervision
  disabled`); A2 pins the pure-function behaviour (`null bound ⇒ unknown ⇒ never step down`).
- Step-down, not rebind: keeps the path a pure shutdown; a successor binds on the next
  `ensureCoordinator()` call. Rebinding inside the tick would reopen the "who owns the path"
  ambiguity (§9 Q4).

### 4.4 End-to-end effect and its boundaries

1. Old owner A is stale-reclaimed while alive → its `touch()` fails deterministically.
2. Successor B boots: unlinks A's leftover socket (*boot-time site*) and binds. A still
   listens on the orphaned inode but every new client reaches B.
3. A's 3rd failed touch → `shutdown(0)`: `lease.isOwner()` is false → R1 suppresses the
   unlink. This closes one unguarded path; whether it is the path that produced the report
   is unknown (§3.2).
4. If the endpoint disappears or is replaced for **any** reason, B's next tick sees
   `missing`/`replaced` → R2 steps down with `coordinator_endpoint_lost` → the next
   `ensureCoordinator()` acquires the released lease → fresh coordinator binds. **The
   process vacates within ≤1 tick. The state_command that raced this window can still fail**
   (the replacement spawned by that call loses the lease race and exits 0;
   `launchCoordinator` never retries, so the caller waits out `ENSURE_WINDOW_MS` ≈ 10 s and
   reports `coordinator_unavailable`). Recovery lands on the next command (§7-2).

**The fix does not retroactively heal.** A coordinator already in the zombie state at
upgrade time still holds a fresh lease; the client probes ENOENT, spawns, loses the lease
race, and the new R2 never gets a chance to run because the old (old-code) process is never
asked. Such an install must `kill` the old coordinator once; from then on R2 self-heals.

## 5. Testability split (可测性拆分设计)

| Unit under test | Layer | Why pure |
| --- | --- | --- |
| `shouldUnlinkEndpoint({stillOwner, compromised, bound, current})` | `src/core/host-coordination.mjs` (pure export) | plain data only, no fs |
| `socketIdentityObservation(stat, errorCode)` | `src/core/host-coordination.mjs` (pure export) | maps one stat attempt; covers the EACCES/unknown branch that R2-D2 requires |
| `classifyEndpointHealth(bound, observed)` | `src/core/host-coordination.mjs` (pure export) | plain data only |
| `statSocketObservation(socketPath)` | `runner/state-coordinator.mjs` I/O shell (not exported) | one stat call; classification delegated to the pure mapper |
| `safeIsOwner()` | `runner/state-coordinator.mjs` I/O shell | one lease read; fenced |

Testing boundaries:
- Pure functions: `test/host-coordination.test.mjs` — exhaustive truth tables, no spawn,
  every platform.
- Tick + shutdown wiring: `test/state-coordinator.integration.test.mjs` — real spawned
  coordinator, temp root, POSIX-only assertions guarded by `process.platform !== "win32"`
  (same style as A14 at :1274). New case titles MUST be prefixed `#255 A<n>: …` so
  `--test-name-pattern` can select them.
- **A3's discriminating fixture (the one that can falsify R1):** start A, wait ready, assert
  the endpoint file exists (guard against the #70 vacuous assertion), pin
  `AGENT_BOARD_TEST_COORDINATOR_HEARTBEAT_MS` explicitly (default 1000), then **delete A's
  lease directory** (simulating "the lease moved elsewhere / was quarantined") while leaving
  A's socket untouched. A's next three touches fail (`stillOwns()` false) and it exits 0
  after ~3 heartbeats. Two decidable assertions: (1) immediately after deleting the lease
  directory, assert the endpoint file still exists (anti-vacuous precondition); (2) after
  `waitForExit`, assert **it still exists**:
  - old code: no `stillOwner` gate, `ownsEndpoint(bound, current)` is true (A's own inode
    never changed) → unlinks → assertion fails ⇒ **red test**;
  - fixed code: `stillOwner` false → keeps the file ⇒ green.
  No inode reuse, no successor. A14 asserts the mirror case (socket gone when the lease was
  not revoked); together they pin the token condition.
- **A5's replaced fixture must be atomic** (R2-G2): bind the stand-in on a temp path first,
  then `renameSync(tmp, socketPath)` — the deposed owner's old inode is still held by its own
  listener fd, so the replacement inode is guaranteed different and the tick can never
  observe an intermediate `missing`. **The temp path MUST live inside `<root>`** (same
  filesystem: `rename(2)` throws EXDEV across mounts), e.g. `<root>/.standin-<pid>.sock`.
  Pin the heartbeat knob and, before asserting, read `statSync(socketPath).ino` to prove the
  inode really changed.
- **No CI-constructible test can exercise the hypothesised inode-reuse trigger itself**
  (APFS-only physics, and §3.2 doubts it). R2's missing/replaced paths are tested with a
  deleted endpoint and an atomically replaced stand-in; the trigger-cause investigation is
  U1 + R4.
- Dual-owner handoff (optional smoke, not a gate): spawn A, delete A's lease, spawn B, assert
  B binds and answers a ping while A exits. Kept out of the acceptance gate because it
  cannot falsify R1 without inode reuse.

## 6. Acceptance matrix

| ID | Functional point | Verification | Command / steps | Pass criteria |
| --- | --- | --- | --- | --- |
| A1 | `shouldUnlinkEndpoint` truth table | 自动化验证（unit） | `npm test` (host-coordination suite) / `node --test test/host-coordination.test.mjs` | 8 combinations (`stillOwner` × `compromised` × match) + 2 null-degenerate rows: only owner=true, compromised=false, match=true ⇒ true |
| A2 | `socketIdentityObservation` + `classifyEndpointHealth` truth tables | 自动化验证（unit） | `node --test test/host-coordination.test.mjs` | observation: success ⇒ ok+dev/ino; ENOENT ⇒ missing; EACCES/ELOOP/anything else ⇒ unknown. classify: null bound ⇒ unknown; `{kind:"unknown"}` ⇒ unknown; `{kind:"missing"}` ⇒ missing; different dev/ino ⇒ replaced; equal ⇒ ok |
| A3 | Deposed owner (lease gone, endpoint unchanged) keeps its own socket | 自动化验证（integration, POSIX） | `node --test --test-name-pattern="#255 A3" test/state-coordinator.integration.test.mjs` | pin heartbeat; delete A's lease dir; A exits 0; **A's socket file still exists** (assert present before exit; old code fails this) |
| A4 | Missing endpoint ⇒ supervised step-down | 自动化验证（integration, POSIX） | `node --test --test-name-pattern="#255 A4" test/state-coordinator.integration.test.mjs` | unlink the endpoint under a ready A (heartbeat pinned); A exits 0 within bounded ticks; `coordinator_endpoint_lost` with `state:"missing"`; lease released |
| A4b | A failing diagnostic write must not block the step-down | 自动化验证（integration, POSIX） | `node --test --test-name-pattern="#255 A4b" test/state-coordinator.integration.test.mjs` | `AGENT_BOARD_TEST_FAIL_DIAGNOSTIC=1` + unlink endpoint ⇒ still exits 0, lease released |
| A5 | Replaced endpoint ⇒ step-down, replacement not unlinked | 自动化验证（integration, POSIX） | `node --test --test-name-pattern="#255 A5" test/state-coordinator.integration.test.mjs` | atomic rename of a stand-in bound **inside `<root>`** (same filesystem; heartbeat pinned); assert `statSync` ino changed; A exits 0; `state:"replaced"`; stand-in file still present; old code fails this. Note: the `compromised` veto checked by this case is defence in depth — a genuinely different inode is already refused by the dev+ino comparison, so this case pins R2's step-down + endpoint survival; the veto's own truth table is pinned by A1 |
| A6 | Healthy SIGTERM still unlinks its own endpoint (regression) | 自动化验证（integration, POSIX） | `node --test --test-name-pattern="#224 A14|#255 A6" test/state-coordinator.integration.test.mjs` | A14/A14b unchanged and green; new `#255 A6`: SIGTERM ⇒ exit 0, endpoint absent after exit |
| A7 | Root-gone step-down still writes no diagnostic/state | 自动化验证（integration, POSIX） | `node --test --test-name-pattern="A3|A4" test/coordinator-lifecycle.test.mjs` | existing #241 assertions unchanged, including A3's "root stays deleted after the self-exit" (:374) — the assertion that proves no diagnostic/state write; A3/A3b/A3c/A4 all match and run |
| A8 | Dual-owner handoff smoke (B serves after A vacates) | 自动化验证（integration, POSIX, non-gating smoke） | `node --test --test-name-pattern="#255 A8" test/state-coordinator.integration.test.mjs` | B answers a ping after A exits; not a PR gate (cannot falsify R1 without inode reuse) |
| A9 | Type contract | 自动化验证（static） | `npm run typecheck` | exit 0 |
| A10 | No collateral breakage | 自动化验证（unit+integration） | `npm run test:coverage` | all pass; thresholds lines 85 / funcs 80 / branches 70 |
| A11 | Perf gate unaffected | 自动化验证（build/perf） | `npm run test:perf` | passes |
| A12 | Full pre-PR gate | 自动化验证（static+build+test） | `npm run verify` | exit 0 |
| U1 | Socket-loss observation on the reporter's macOS box | 用户实测 | **前置**：merge 后 `git pull` 到含 fix 的 commit；`pkill -f runner/state-coordinator.mjs`（旧 detached 进程不随 Pi 重启退出）；触发一次 ensure 让新代码 coordinator 成为租约主；确认 `lsof -p <新 pid>` 路径与 `ls` 一致。**执行**：24 h 观察；记录 `views/_coordinator/diagnostics.jsonl`；每次 endpoint 丢失时采集**谁 unlink 了它**的证据（`lsof`/`fs_usage`/外部清理脚本排查）。inode 复用不可按需制造。 | 24 h 内 `coordinator_unavailable` 次数 ≤ 基线（先记录基线）；有 coordinator 时 `ls` 与 `lsof` 一致；**条件判据**：若 24 h 内发生 endpoint 丢失，须附至少一次归因证据；若未发生丢失，本条记 N/A，以前两条为准；若出现 `coordinator_endpoint_lost`，其后下一次操作应恢复 |
| U2 | Zombie recovery without manual kill | 用户实测 | **前置**：同 U1（必须先 kill 旧 coordinator，否则测的是旧代码）。**执行**：对一个运行中的新代码 coordinator `rm <root>/coordinator.sock`；立即触发一次 dashboard 操作并等待其返回（允许一次 `coordinator_unavailable`）；再触发第二次 | 第二次操作在本次 `ENSURE_WINDOW_MS`（10 s）内成功应用；`coordinator_endpoint_lost` 出现一次；全程无需 `kill` |

## 7. Non-goals (tracked separately)

1. **Identify the actual unlink cause / reclaim-eligibility audit** — declared fallback
   (#224 D3), torn heartbeat write, external unlink. Needs raw JSONL + pid liveness + FS
   evidence (§3.2).
2. **Accepted residual: the command that races the step-down can still fail once** (the
   single-shot spawn loses the lease race; §4.4). Recovery lands on the next command.
3. **Dual-writer window during stale reclaim** (≤3 s) — accepted residual.
4. **`pty-runner.mjs` endpoint cleanup** (ownedMain finishHost is dev+ino-only; the legacy
   shutdown path is unconditional) — different ownership model, own issue.
5. **Client-side zombie killer / boot-grace heuristic** — superseded by R2 here.
6. **Re-projection of `agent_end` events dropped during an outage.**
7. **R2 on win32** — no inode identity exists; named-pipe liveness is #104/#70 territory.

## 8. Risks / rollback

| Risk | Mitigation |
| --- | --- |
| `lease.isOwner()` throws during shutdown | `safeIsOwner()` → false (fail-closed; next boot's *boot-time site* unlink cleans a leftover) |
| Classifier reads a transient stat error as replaced | exported `socketIdentityObservation` maps only ENOENT → missing; A2 pins EACCES/ELOOP |
| Diagnostic write throws in the tick | fenced `try/catch` (same shape as :390-392); A4b pins it |
| Delete-window skeleton on the diagnostic append | same residue #241 already accepted (skeleton directory, never a process) |
| A14 regression | run A14/A14b by name before the full suite; A14's lease is not revoked so `stillOwner` stays true |
| Step-down loop | each step-down releases the lease; the successor binds before the next tick; `coordinator_endpoint_lost` makes a loop visible |
| Rollback | revert two source files (`src/core/host-coordination.mjs`, `runner/state-coordinator.mjs`) + two test files (`test/host-coordination.test.mjs`, `test/state-coordinator.integration.test.mjs`); no persisted state or wire-format change |

## 9. Open questions for cross-review

1. Does A3 + A1 adequately pin R1 in CI given the §3.2 physical objection? (Current answer:
   they pin the *gate logic*; the trigger itself needs U1/R4.)
2. Diagnostic name `coordinator_endpoint_lost` — consistent with
   `coordinator_heartbeat_lost` / `coordinator_lease_unavailable`? Naming only.
3. Should A8 (handoff smoke) be kept, or is it noise without inode reuse?
4. Step-down vs rebind on endpoint loss — decision recorded in §4.3.
5. Is "delete the lease directory" the right fixture for A3, or should a second case go
   through the real reclaim path (#224 A10 pattern: fabricated stale `startedAt`)? The
   delete fixture is deterministic and tests R1's gate; the A10 pattern also exercises
   `lease_reclaimed`.
6. Given §3.2, is the issue's title/root-cause framing ("live lease holder serves an
   unlinked socket") still the right scope, or should this PR be split into "self-heal
   (R2)" + "contract restoration (R1)" + "cause investigation (R4)" as separate issues?
   Current plan keeps one PR because both changes are small and the acceptance matrix
   covers both; R4 is tracked as a follow-up.
