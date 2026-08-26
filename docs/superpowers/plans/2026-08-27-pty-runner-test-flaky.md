# Plan: fix pty-runner integration test flaky timeout (issue #34)

## Goal

Make `pty-runner creates host socket, broadcasts output, forwards input, finalizes` deterministic on CI by not depending on pre-connect socket output. No product code change.

## Tasks

1. **Edit test** — `test/pty-runner.integration.test.mjs`
   - Replace `await waitFor(() => messages.find((m) => m.type === "output" && m.data.includes("fake pi ready")));`
     with a screen-log read wait:
     ```js
     await waitFor(() => {
       try {
         return readFileSync(P.screenLogPath(root, "v1"), "utf8").includes("fake pi ready");
       } catch {
         return false;
       }
     });
     ```
   - Keep all socket-based assertions (echo:hello, resize, exit) unchanged.
2. **Verify** — run the pty-runner integration test repeatedly:
   - `node --test test/pty-runner.integration.test.mjs` × 6, expect 3/3 pass each run.
   - Forced late-connect scenario (output before connect) passes.
   - Full suite `npm test` — 313/313 pass.
3. **Commit** — conventional commit: `fix: make pty-runner integration test timing-independent (issue #34)`
4. **PR** — push `issue-34-pty-runner-test-flaky`, open PR against main, tag `zima:needs-review`, await CR, converge, merge.

## Verification

- Deterministic under the previously-failing timing (output emitted before client connects).
- No regression: full test suite green.
