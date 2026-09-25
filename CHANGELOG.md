# Changelog

All notable changes to this project are documented here, generated from
conventional commits by `scripts/release_helper.mjs`. Entries are
forward-only: they begin with the first release after this file landed —
for earlier history, see the git log and the pull-request list.

## [0.9.0] - 2026-09-25

### Features

- **attach**: forward terminal queries to the real terminal — automatic theme works in attach sessions (issue #128) (#138)
- **attach**: unconditional Ctrl+\ detach key, terminal-independent (issue #126) (#137)

### Fixes

- **runner**: probes leave attachedClients at hello (issue #130) (#142)
- browse-mode Tab completes and drills down directories in cwd picker (issue #127) (#141)

### Changes

- **release**: orchestrate releases and publish from CI (#144)
- control-reconcile flaky assertions — windowed recorder + invariant realignment (issue #140) (#143)
- **attach**: scope A5 mid-stream seq assertion to post-snapshot window (issue #132) (#139)

[0.9.0]: https://github.com/zhuxixi/pi-agent-board/compare/v0.8.0...v0.9.0

## [0.8.0] - 2026-09-23

### Features

- **attach**: detach gate reads only editor_state — delete buffer heuristics (issue #91 phase 6, D1) (#135)
- control command lifecycle — staged acks, durable journal, reconcile, generation token (issue #91 phase 5, D4) (#134)
- switch attach to snapshot+subscribe with legacy fallback (issue #91 phase 4, D2 closure) (#122)
- canonical terminal model and capture-and-subscribe protocol (issue #91 phase 3, D2+D5) (#117)
- reader-side revision consistency, beat bootstrap, and paired-revision invariant (issue #91, D3 arc closure) (#111)

### Fixes

- **attach**: editor-shaped ← detach anchor + restore the editor-state reporter endpoint (issue #103) (#119)
- **paths**: normalize root before hashing the win32 coordinator pipe name (issue #124) (#125)
- **locks**: reclaim Windows lease orphans on publish-rename EPERM (issue #114) (#123)
- **attach**: stop painting the PTY cursor block when the child hides it (issue #102) (#120)
- **attach**: learn TUI frame cognition in terminal chain states (issue #106) (#118)
- **host**: reclaim orphaned host-meta locks and add contention diagnostics (issue #112) (#116)
- foreground preview read-your-writes cache for coordinator write races (issue #113) (#115)

### Changes

- move the A11 perf gate out of coverage instrumentation (issue #121) (#133)

[0.8.0]: https://github.com/zhuxixi/pi-agent-board/compare/v0.7.0...v0.8.0

## [0.7.0] - 2026-09-10

### Features

- runtime cursor desync detect + rate-limited heal (issue #11) (#105)
- detached View State Coordinator as single writer for state/status (issue #91, phase 1+2a) (#104)

### Fixes

- **coordinator**: protocol version gate replaces stale coordinators on extension updates (issue #108) (#109)

### Changes

- route all remaining state writes through the View State Coordinator (issue #91, phase 2b) (#107)

[0.7.0]: https://github.com/zhuxixi/pi-agent-board/compare/v0.6.2...v0.7.0

## [0.6.2] - 2026-09-09

### Fixes

- **host**: claim role no longer blocks terminal host replacement (#99) (#100)

[0.6.2]: https://github.com/zhuxixi/pi-agent-board/compare/v0.6.1...v0.6.2

## [0.6.1] - 2026-09-08

### Fixes

- add an unconditional Ctrl+Left detach chord to the attach surface (issue #89) (#97)
- force full-clear repaint on dashboard mount and content shrink (issue #88) (#96)
- fail host launch fast on a provably stale defaultModel + exit attribution (issue #90) (#94)
- finalize provably-dead legacy hosts in attach resolver and self-heal (issue #87) (#93)
- swallow async spawn errors in detached runner launches (issue #86) (#92)

[0.6.1]: https://github.com/zhuxixi/pi-agent-board/compare/v0.6.0...v0.6.1

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
