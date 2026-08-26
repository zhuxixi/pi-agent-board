# Issue #34 — CI flaky: pty-runner integration test times out waiting for pre-connect output

## Root cause

`test/pty-runner.integration.test.mjs` (test "pty-runner creates host socket, broadcasts output, forwards input, finalizes") waits for the boot banner `fake pi ready` **over the control socket**. But the socket only carries *live* output: `broadcast()` iterates `clients`, which is empty until a client connects. If the child emits `fake pi ready` before the test's socket connects (CI runners start the child fast), the output is broadcast to zero clients and lost — the 3s `waitFor` times out.

History output is intentionally NOT replayed over the socket; the UI attach path replays it from the screen log file (`src/ui/pty-attach.ts` `replayScreenLog`). The test's assumption contradicts the protocol design.

### Evidence

- CI run 32554867604 (main, #32): `not ok 181 ... error: 'timed out waiting'` at `test/pty-runner.integration.test.mjs:65`, both Node 22 and Node 24.
- PR branch run 32554619699 failed on a *different* test (`runner.integration.test.mjs:195`, auto-done idle), passed on rerun — separate timing-sensitive spot, out of scope.
- Reproduced deterministically locally with a forced "output before connect" script: 3/3 timeouts. Same test passes 5/5 under normal timing.
- Local runs after fix: 6/6 pass; late-connect scenario: 3/3 pass; full suite: 313/313 pass.

## Fix design

Only the test changes; no product code change (socket protocol behavior is by design).

| Step | File | Change |
|------|------|--------|
| 1 | `test/pty-runner.integration.test.mjs` | Replace the socket wait for `fake pi ready` with a screen-log read wait (`P.screenLogPath(root, "v1")` contains `fake pi ready`) — mirrors UI attach replay semantics |

Assertions that remain on the socket (post-connect realtime events, timing-safe):
- `echo:hello` output (live broadcast + input forwarding)
- resize → `readHost().cols === 100`
- `exit` → `endedAt` set, state `exited`

Screen-log assertions (file-based, timing-safe):
- boot banner `fake pi ready` present (already asserted at test end via `assert.match`)

## Non-goals

- No change to `runner/pty-runner.mjs` socket protocol.
- No change to `runner.integration.test.mjs` flaky spot (tracked separately if it recurs).
