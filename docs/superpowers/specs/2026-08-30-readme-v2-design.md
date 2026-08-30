# Design: User-first README v2 for Pi Agent Board

**Issue:** #51
**Date:** 2026-08-30
**Status:** Approved
**Language:** English

## Outcome

Rewrite `README.md` into a user-first English guide that accurately describes the currently shipped Pi Agent Board package, verified by current source, package metadata, tests, and manual verification notes.

The README will take a new user from installation to a first background session, then serve as a practical reference for dashboard actions, attach mode, filters, configuration, limitations, troubleshooting, and maintainer entry points.

This is documentation-only. No product behavior changes are part of the work.

## Source of truth

- `package.json` is authoritative for package identity, version, Node engine, repository, scripts, and Pi package metadata.
- `src/index.ts`, `src/commands/*`, `src/ui/dashboard.ts`, `src/ui/pty-attach.ts`, `src/runtime/service.mjs`, and `src/core/*` are authoritative for shipped behavior.
- `PRD.md`, `PROGRESS.md`, `REMAINING_WORK.md`, and dated design/plan documents are historical or planning material; they must not advertise disabled or planned behavior.
- Every command, shortcut, environment variable, default, and limitation must be checked against an exact source location or a verified command.
- Clearly distinguish shipped behavior, fallback behavior, disabled behavior, and planned/internal behavior.
- Avoid hard-coded test counts; state that CI and `npm run verify` are authoritative.
- Use `AGENT_BOARD_*` names for new configuration. Mention selected `AGENT_VIEW_*` names only as migration aliases.

## Information architecture

Use this task-oriented structure:

1. Title, package links, value proposition
2. What it does / when to use it
3. Requirements
4. Installation
5. Quick start
6. Entry points
7. Dashboard workflow
8. Views and actions
9. States, grouping, and filters
10. Attach mode
11. Persistence, safety, and limitations
12. Configuration
13. Troubleshooting
14. Development
15. Publishing
16. Further reading

The first half should be readable without knowing Pi internals. Advanced QA and implementation details should be linked rather than expanded inline.

## Content requirements

### Positioning

State that Agent Board is a full-screen TUI dashboard for dispatching, monitoring, inspecting, replying to, attaching to, and managing multiple durable background Pi sessions. Emphasize global cross-project visibility, resumability, dashboard triage, inline reply/evidence, and PTY/JSON fallback. Do not imply cloud execution, multi-user sharing, automatic worktree isolation, or full Claude parity.

### Requirements and installation

Include Pi, Node.js 20+, working Pi provider authentication, and PTY support for live attach/start-and-attach. Use `pi install npm:@zhuxixi/pi-agent-board` everywhere. Keep local path installation and symlink discovery as separate alternatives. Include a short one-shot auth sanity check and link detailed checks to `VERIFY.md`.

### Quick start and entry points

Use a concrete five-step first-task flow: `i` INSERT mode → type task → `Enter` → Start session dialog → review cwd/model/thinking/action → `Enter` to launch. Explain Space Peek, `r` in Peek, `v`, `e`, attach with Enter/Right/`>`, and PTY detach with Left/Ctrl+` ]`.

Document `/agent-board`, `pi /agent-board`, `pi --agent-board`, and `/bg [prompt]`, including that `--agent-board` startup cannot attach and normal `/agent-board` is required for attach.

### Dashboard and actions

Explain Normal vs INSERT mode, draft-vs-empty `Enter`, Ctrl+N prefilled launch, cwd favorites/path completion, model/thinking/action fields, persisted launch preferences, and PTY-dependent start-and-attach fallback.

Document exact destructive semantics: `d` confirms inactive Done; manual completion is default; Ctrl+X twice quickly archives; archive preserves the session file; X deletes inactive rows in the selected state; `m` batch selection supports Space/a/u/d/Ctrl+X.

Keep shortcut reference separated by view. State that `r` is available from Peek/Transcript/Evidence, not directly from the main list, and pending Pi questions must be answered via attach rather than inline reply.

### States, views, and filters

Document the seven labels: Queued, Running, Needs answer, Needs instructions, Done, Failed, Stopped. Explain separate process liveness, state grouping, folder grouping, pinned-first stable creation ordering, unread indicators, Peek, read-only transcript, Evidence/Diagnostics, durable FIFO follow-up queue, and `qN`.

Document filter syntax: `s:`, `review:ready`, `diag:stalled`, `evidence:error`, `queued:true|yes|1`, `steer:`, and free-text AND over name/summary/cwd. Explain aliases and case-insensitivity. Caveat that `diag:stalled` can consume persisted diagnostics but there is no general current provider-stall detector.

Explain locally extracted issue/PR badges and optional per-root `providers.json`, without asserting an unverified custom schema.

### Attach and persistence

Describe PTY attach, Left/Ctrl+`]` detach, PageUp/PageDown/Home/End/mouse wheel scrollback, link opening, drag/double-click copy, optional X11 middle-click paste, clipboard/image passthrough, cold-host loading/reconnect, warm host pool, and Windows named-pipe/hidden-console behavior without promising terminal-emulator parity.

Explain PTY vs JSON fallback, adopted external-session PTY requirement, and `!` diagnostics. Document the default store at `~/.pi/agent/agent-board/`, high-level artifacts, persistence across reload/restart/worker exit, and stale-row reconciliation.

Prominently state that worktree isolation is currently disabled and not automatically created; same-repository concurrent writes are unsafe unless the user manually avoids overlap or supplies isolation. Also state no cloud/multi-user coordination, row deletion preserves session files, auth remains required, startup attach limitation, and PTY native-dependency limitation.

### Configuration

List supported user-facing settings with exact defaults/disable values: ROOT, AUTO_STATE, AUTO_STATE_MODEL, AUTO_STATE_NO_DONE, SUMMARY_MODEL, TITLE_MODEL, TITLE_THINKING_LEVEL, CODE_REFS, DISABLE_PTY, FORCE_PTY, ATTACH_MOUSE, ENABLE_MOUSE_SCROLL, WHEEL_LINES, MAX_WARM_HOSTS, WARM_HOST_TTL_MS, ATTACH_NATIVE_PASTE, FORWARD_OSC52, and FORWARD_IMAGES.

Do not list internal child markers. Do not advertise `AGENT_BOARD_ALLOW_PIPE_FALLBACK` as a normal user toggle because current service dispatch does not pass the ambient variable into the injected PTY runner config. Mention selected legacy `AGENT_VIEW_*` aliases only as compatibility paths.

### Troubleshooting and maintainer sections

Troubleshoot stuck Running/auth, `node-pty unavailable`, slow/reconnecting attach, start-and-attach fallback, rejected inline replies, and same-repo conflicts. Link `VERIFY.md`.

Keep Development to `npm install` and `npm run verify`; explain verify briefly. Keep Publishing to verify, version bump, and publish. Link further reading (`VERIFY.md`, `PRD.md`, `PROGRESS.md`, and relevant design docs) without turning README into a historical log.

## Supporting documentation

Correct the old unscoped install command in `VERIFY.md` from `pi install npm:pi-agent-board` to `pi install npm:@zhuxixi/pi-agent-board`, because README links to it. Make no other supporting-doc changes.

## Validation

- Line-by-line compare the final README with source and package metadata.
- Check Markdown link targets and stale package names/status wording.
- Run targeted documentation scans.
- Run verification in the isolated worktree; do not count the main session's untracked PTY tests as evidence.
- Final diff should contain README, this approved spec, the implementation plan, and the one-line VERIFY correction only.

## Non-goals

No runtime behavior, worktree implementation, plan-approval UI, provider-stall detection, docs generator, changelog, or broad PRD/progress rewrite.
