# Changelog

All notable changes to this project are documented here, generated from
conventional commits by `scripts/release_helper.mjs`. Entries are
forward-only: they begin with the first release after this file landed —
for earlier history, see the git log and the pull-request list.

## [0.6.0] - 2026-09-07

### Features

- conventional-commit driven CHANGELOG via release_helper.mjs (issue #64) (#83)

### Fixes

- pty host stacking and control.sock cross-deletion via per-instance ownership protocol (issue #70) (#84)
- guard mention fallback against placeholders, code spans, and pr-context (issue #61) (#82)
- truncate never splits surrogate pairs or emits lone surrogates (issue #39) (#81)
- extract evidence outputPreview from AgentToolResult content (issue #41) (#77)
- reclaim idle warm PTY hosts via periodic sweep + lifecycle cleanup (issue #75) (#76)
- narrow code-refs PR back-link extraction by evidence context (issue #65) (#73)

### Performance

- use cached PTY probe on the reconcile drain path (issue #13) (#79)

### Changes

- Windows WezTerm IME needs a visible hardware cursor (issue #38) (#80)
- poll markCompleted to success instead of racing the persist window (issue #63) (#78)

[0.6.0]: https://github.com/zhuxixi/pi-agent-board/compare/v0.5.2...v0.6.0
