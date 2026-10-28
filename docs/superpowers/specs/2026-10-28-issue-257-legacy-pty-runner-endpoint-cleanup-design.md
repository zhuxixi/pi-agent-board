# Issue #257 — legacy pty-runner endpoint cleanup

Status: draft (round 2 revised after cross-review round 1)
Repo: zhuxixi/pi-agent-board · issue #257 · base `f885944` (#255 merged)
Drafted: deepseek-account/deepseek-flash (selected) · deepseek-account/deepseek-flash (physical) @ 2026-10-28T23:12:00+08:00
Revised: deepseek-account/deepseek-flash (selected) · deepseek-account/deepseek-flash (physical) @ 2026-10-28T23:35:00+08:00 — round-1 cross-review: accepted R1-G1/G2 + R1-D1..D8 (all)

## 1. Problem

The legacy PTY-host runner (`legacyMain`, taken when a host config has no `instanceId`) can
delete an endpoint that a successor owns. Its `shutdown()` has two independent deletion
sources: `server.close()` (libuv unlinks the bind path — `nodejs/node#19729`, the #255 root
cause) and an unconditional `unlinkSync(socketPath)` with no dev/ino or ownership check.
Symptom if hit: a live host whose `control.sock` path is gone — attach/probe see ENOENT while
`lsof` shows the listener — the host-level analogue of #255.

Reachability: current service code always writes instance-scoped configs
(`service.mjs:357,1332,1434`), but the legacy path is (a) still deliberately test-covered
(`test/pty-runner.integration.test.mjs:1440,1542`) and (b) reachable in the upgrade window —
an old service process keeps spawning the on-disk runner script, which is NEW code while the
config keeps the legacy shape.

## 2. Goals / constraints

- G1 A legacy runner that no longer owns the path must not delete it (mirror of #255).
- G2 A legacy runner cleans up its own endpoint on a normal shutdown **when the bind-time
  identity was captured**; if the capture failed, cleanup degrades to a no-op and the next
  boot's unconditional unlink (`:140-142`) is the backstop.
- G3 `ownedMain` is **not** in scope. It is not "already safe": `finishHost` does a bounded
  (1 s) `server.close()` at `:692-707` and only afterwards applies the dev+ino cleanup gate
  (`:736-743`), so libuv can still unlink its bind path. Its endpoint is per-instance
  (`control.<instanceId>.sock`, `paths.mjs:102-107`), which bounds the blast radius — but it
  remains a real follow-up: the #255 design doc's R5 tracks the pty-runner endpoint cleanup,
  and the close-before-gate mechanism is this issue's finding.
- G4 No wire/protocol change; POSIX-only semantics as in the existing code.
- G5 No new timers, no new modules; the fix stays inside `legacyMain` + tests.

## 3. Root cause (confirmed from source)

`runner/pty-runner.mjs`:

- `:140-142` boot — unconditional `unlinkSync(socketPath)` of a leftover path (**not changed**
  by this issue, see §7).
- `:409` — `server.listen(socketPath, ...)`; **no bind identity recorded** (the owned path
  records it at `:930-936`).
- `:503-531` shutdown:
  ```js
  try { server?.close(); } catch {}
  try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch {}
  ```

Two ways the successor's socket dies:
1. `server.close()` → libuv unlinks `socketPath` (the path bound at listen time), regardless
   of who owns it now (`nodejs/node#19729`);
2. the explicit unconditional unlink — no `ownsEndpoint` gate at all.

## 4. Fix design (legacyMain only)

### 4.1 Changes

1. **Declare the identity holder** in `legacyMain` (it does not exist there today — it is
   declared only in `ownedMain` at `:575`):
   ```js
   /** {dev,ino} recorded at bind time; cleanup unlinks only this exact inode. */
   let boundSocketIdentity = null;
   ```
2. **Record the identity before publishing readiness** — capture first, then `update(alive)`,
   so "host ready" implies "identity recorded" for the integration fixture:
   ```js
   server.listen(socketPath, () => {
       if (process.platform !== "win32") {
           try {
               const st = statSync(socketPath);
               boundSocketIdentity = { dev: st.dev, ino: st.ino };
           } catch { /* without the identity, cleanup degrades to a no-op */ }
       }
       update({ socketPath, state: "alive" });
   });
   ```
3. **Do not call `server.close()`** in `shutdown()` — with no close there is no libuv
   close-time unlink. (`shutdown` still awaits child exit up to ~5 s afterwards; that is
   unrelated — the deletion vector is the close itself.) Add the nodejs/node#19729 comment.
4. **Gate the explicit unlink** exactly like the owned path's `:736-743`:
   ```js
   if (process.platform !== "win32" && boundSocketIdentity) {
       try {
           const st = statSync(socketPath);
           if (ownsEndpoint(boundSocketIdentity, { dev: st.dev, ino: st.ino })) {
               try { unlinkSync(socketPath); } catch {}
           }
       } catch { /* path gone — nothing to clean */ }
   }
   ```

`ownsEndpoint` is already imported (`:20`). No new exports needed.

Behaviour matrix:

| Scenario | identity matches? | unlink? |
| --- | --- | --- |
| SIGTERM/SIGINT on a normal legacy host with captured identity | yes | yes → G2 |
| Shutdown after the path was replaced by a successor | no | no → G1 |
| Path already gone at shutdown | stat ENOENT | no-op |
| win32 (named pipe) | n/a (no identity) | no unlink, no close |
| identity capture failed at boot | null | no unlink (degrade, §7-1 backstop) |

### 4.2 What this does NOT cover (boundaries)

- **Not retroactive.** A legacy runner already running old code keeps the bug until it exits;
  the fix only lives in the new `legacyMain`. And after a normal restart the current service
  no longer spawns legacy runners at all (`service.mjs:356-378`, `paths.mjs:102-107`), so the
  fixed path is only reachable inside the in-place-upgrade window. There is therefore no
  stable user-facing reproduction after updating — see §6 (no U-item).
- **Boot-time unlink is unchanged** (§7-1): a new legacy owner still clears a leftover path
  unconditionally, matching the accepted #255 boot-site semantics.
- **`ownedMain` is untouched** (§2 G3): it still closes its listener; its per-instance path
  bounds the risk, and it is tracked as the #255-R5 follow-up.

## 5. Testability split (可测性拆分设计)

| Unit under test | Layer | Why |
| --- | --- | --- |
| `ownsEndpoint(bound, current)` | `src/core/host-coordination.mjs` (already pure, already unit-tested) | reused as-is; no new pure logic |
| legacy bind-identity capture + gated unlink | `runner/pty-runner.mjs` `legacyMain` I/O shell | one stat at listen, one stat at shutdown |
| Integration fixture | `test/pty-runner.integration.test.mjs` (existing legacy fixtures at :1440/:1542 build a no-instanceId host config and wait for `hostReady`) | drives the real runner process |

Testing boundary: no new pure function is needed; the decision is the existing `ownsEndpoint`.
New integration tests are POSIX-guarded (`process.platform === "win32"` → `t.skip("POSIX
AF_UNIX only")`, the precedent used by the #255 coordinator cases) because Windows endpoints
are named pipes with no file to unlink. **Title convention: every new case is titled
`#257 A<n>: <summary>`**; because `#257 A1` is a prefix of `#257 A1b`, A1's selector anchors on
`#257 A1:`.

**A2 (the discriminating regression test)**: spawn a legacy runner from a no-instanceId host
config; wait `hostReady` (which now also implies the identity was captured); bind a stand-in
server on a temp path **inside the board root** and `renameSync` it onto
`P.controlSocketPath(root, viewId)` (atomic; the runner's old inode stays alive in its listener
fd, so the replacement inode is guaranteed different); assert `statSync(...).ino` changed; send
SIGTERM; assert exit 0 and **the stand-in socket file still exists**.
- old code: `server.close()` (libuv unlink) and/or the unconditional unlink delete the
  stand-in ⇒ red;
- fixed code: no close, dev/ino mismatch ⇒ keeps it ⇒ green.

**A1 (regression)**: the same legacy fixture without the replacement: assert the socket exists
**before** SIGTERM (anti-vacuous, per the #70 lesson), SIGTERM ⇒ exit 0 and the control socket
is gone (normal cleanup preserved).

**A1b (ENOENT branch)**: legacy fixture, unlink the socket before SIGTERM ⇒ exit 0, no crash.

## 6. Acceptance matrix

| ID | Functional point | Verification | Command / steps | Pass criteria |
| --- | --- | --- | --- | --- |
| A1 | Legacy normal shutdown still cleans its own endpoint | 自动化验证（integration, POSIX, Linux CI） | `node --test --test-name-pattern="#257 A1:" test/pty-runner.integration.test.mjs` | precondition: socket exists before SIGTERM; exit 0; socket absent after exit; summary shows exactly 1 matching test (the `:` anchor excludes A1b) |
| A1b | Socket already gone at shutdown ⇒ clean exit | 自动化验证（integration, POSIX, Linux CI） | `node --test --test-name-pattern="#257 A1b" test/pty-runner.integration.test.mjs` | exit 0, no crash |
| A2 | Legacy shutdown does not delete a replaced endpoint | 自动化验证（integration, POSIX, Linux CI） | `node --test --test-name-pattern="#257 A2" test/pty-runner.integration.test.mjs` | inode changed before SIGTERM; exit 0; stand-in file still present (red on old code); summary shows 1 matching test |
| A3 | Owned path unaffected | 自动化验证（integration） | `node --test --test-name-pattern="owned" test/pty-runner.integration.test.mjs` (plus the existing legacy :1440/:1542 cases, unchanged) | all pass unchanged |
| A4 | Type contract | 自动化验证（static） | `npm run typecheck` | exit 0 |
| A5 | No collateral breakage | 自动化验证（unit+integration, Linux CI authoritative） | `npm run test:coverage` on ubuntu-latest (CI runs Node 22/24) | all tests pass, including the three new POSIX cases actually executing (not skipped); thresholds 85/80/70 |
| A6 | Perf + package + full gate | 自动化验证（build/test, Linux CI authoritative） | `npm run test:perf && npm run pack:dry && npm run verify` | exit 0 |

**Verification channel note (D8).** A1/A1b/A2 are POSIX-only and this dev box is Windows with no
WSL/Docker, so they show as `skip` locally; **Linux CI is the only place they execute**, and the
PR must show the three `#257` cases passing there. There is no listed "known Windows failures"
baseline — the local Windows suite is simply not the gate for these cases (same position as
#255's A3/A5). No U-item exists for this issue: §4.2 explains why no stable user-facing
reproduction remains after the fix, so a manual check could only ever pass vacuously.

## 7. Non-goals

1. The **boot-time** unconditional unlink (`:140-142`) — matches the accepted #255 boot-site
   semantics; hardening it needs an ownership proof the legacy path does not have.
2. Deprecating/removing the legacy path — separate decision (compat + tests exist).
3. `ownedMain` — still closes its listener (§2 G3); per-instance endpoint bounds the risk; the
   real fix belongs to the #255-R5 follow-up (this issue does not claim it is safe).
4. The #255 reclaim-audit / agent_end re-projection follow-ups.

## 8. Risks / rollback

| Risk | Mitigation |
| --- | --- |
| Leaving a stale socket when the identity capture failed | next legacy boot unlinks it (`:140-142`); probes treat it as stale and respawn |
| The close removal changes shutdown timing? | no: `shutdown` never waited on the close callback (it has no callback argument today); child-exit awaits are unchanged |
| A1/A2 fixture flake | wait `hostReady` (identity captured before ready by design), atomic rename inside the root, assert inode change first; no heartbeat knobs involved |
| Rollback | revert one runner file + one test file |

## 9. Open questions for cross-review

1. Is the A2 stand-in enough to pin the fix, given the explicit unconditional unlink would also
   fail the test? (Yes: it fails on old code for either deletion source; the fix addresses both.)
2. Should `ownedMain`'s bounded close be fixed here too? (Proposal: no — §2 G3/§7-3; separate
   issue tracking the #255-R5 follow-up.)
3. Anything needed on win32? (No: named pipes never unlink; the legacy shutdown's
   `existsSync`/`unlinkSync` on a pipe name is already a no-op.)
