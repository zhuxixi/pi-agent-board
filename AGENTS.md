# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

`@zhuxixi/pi-agent-board` — a Pi extension that adds a dashboard for
dispatching, monitoring, peeking at, replying to, and attaching to background Pi
sessions. Runtime source is TypeScript under `src/` and `runner/`; the extension
entry point is `index.ts`.

## Commands

```bash
npm run typecheck      # tsc --noEmit
npm test               # node --test test/*.test.mjs
npm run test:coverage  # c8 + the same tests; thresholds lines 85 / funcs 80 / branches 70
npm run test:perf      # A11 perf gate — opt-in, skipped under plain `npm test`
npm run pack:dry       # what would ship in the tarball
npm run verify         # typecheck + perf gate + tests + coverage + pack:dry
```

Run `npm run verify` before claiming a change is done. `npm test` alone does not
run the perf gate or the coverage thresholds.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | runtime: coordinator, attach protocol, dashboard, persistence |
| `runner/` | detached runner entry points |
| `test/*.test.mjs` | unit and integration tests; `test-support/` holds shared fixtures |
| `scripts/` | build, perf-gate, changelog, and release tooling |
| `docs/` | design notes and the [release process](docs/RELEASE.md) |
| `plans/`, `implementation-plans/` | in-flight work plans |

## Conventions

- Tabs for indentation, English comments and commit messages.
- Prefer pure functions with a thin I/O shell, as in `scripts/release_helper.mjs`
  (pure rendering/parsing is exported and unit-tested; the CLI layer owns git and
  filesystem access). New tooling should follow that split.
- Tests use `node:test` with `assert/strict`. Anything touching git or the
  filesystem gets a self-contained fixture under a temp dir — never the host
  repository, whose tags and remotes differ between checkouts and CI.
- Conventional commit subjects: `feat`/`fix`/`perf`/`refactor`/`docs`/`test`/
  `chore`, with the PR number appended as `(#N)`. The release changelog is
  generated from these subjects, so the type matters.
- Keep `CHANGELOG.md` machine-generated: entries come from
  `scripts/release_helper.mjs`, not from hand editing (except when `verify`
  reports a missing PR after a late merge).

## Releases

Follow [docs/RELEASE.md](docs/RELEASE.md). The parts that are easy to get wrong:

- Every change lands through a PR; `main` is protected and requires CI to pass.
- Never publish by hand as the normal path — creating a GitHub Release triggers
  CI to publish with provenance.
- A release PR is merged with a **merge commit**. Squashing orphans the
  `npm version` tag and corrupts the next changelog range.
- The CHANGELOG section is generated **before** `npm version`, because
  `npm version` moves the tag that defines the generation range.
