# Spec: issue #64 — CHANGELOG.md driven by conventional commits (port of jfox release helper)

## Problem

No CHANGELOG exists; releases are bare version squashes (`0.5.2 (#74)`).
npm users and gallery visitors have no "what changed in this version" entry
point. Commits are already highly conventional (QA baseline #32 onward), so
generation is mechanical.

## Decision (jfox approach, Node port)

Port the jfox release helper (`zhuxixi/jfox/.claude/skills/release/release_helper.py`)
to `scripts/release_helper.mjs` (repo stack: Node ESM). Architecture:

- **Pure, exported functions** (unit-testable, no git in unit tests):
  - `parseCommitLines(lines)` — conventional-commit parse: type
    (feat/fix/perf/refactor/docs/chore/test + `!`), scope, message, trailing
    `(#N)` PR number; skip `bump version`-ish and pure merge subjects;
    dedupe.
  - `generateChangelog({ version, date, entries, prevTag })` —
    `## [version] - date` section grouped Features / Fixes / Performance /
    Changes, each entry `- message (#N)`, plus compare link
    `https://github.com/zhuxixi/pi-agent-board/compare/vPREV...vNEXT`.
  - `changelogTopPrs(text)` — PR numbers inside the first `## [...]` section.
  - `verifyFrom({ functionalLines, changelogText })` — functional whitelist
    (feat/fix/refactor/docs/perf, skipping merges / version-bump commits /
    `docs(changelog)` maintenance commits to avoid a verify fix loop), diff
    against top-section PRs → `{ ok, missing, extra, functionalCommits }`,
    fail-closed on bad input.
- **CLI** (git-backed, thin): `node scripts/release_helper.mjs [--dry-run]
  [patch|minor|major|X.Y.Z]` (default patch; version read from
  package.json; `--dry-run` prints JSON preview without touching files;
  apply inserts the section at the top of CHANGELOG.md) and
  `node scripts/release_helper.mjs verify` (exit 1 + missing list when
  `last v* tag..HEAD` functional commits' PR numbers are absent from the
  CHANGELOG top section — guards against a PR merged after the changelog
  was generated).
- **Forward-only**: CHANGELOG.md is created with a header stub only; entries
  start from the next release after this lands. No backfill of ≤0.5.2.
- **npm script**: `"changelog": "node scripts/release_helper.mjs"` so
  `npm run changelog -- --dry-run` works (issue acceptance wording).
- **README Publishing section** updated to the new flow (changelog BEFORE
  `npm version`, because the bump commit+tag would empty the generation
  range): `npm run verify` → `npm run changelog -- --dry-run` (review) →
  `npm run changelog -- <bump>` (insert section) → `verify` must exit 0 →
  commit CHANGELOG → `npm version <bump>` → `npm publish` → GitHub Release
  with notes from the top section.

Tag format: this repo tags `vX.Y.Z` (verified: v0.4.2..v0.5.2), same as
jfox's `--match v*` logic.

## Non-goals

- No GitHub Release automation (manual step, per jfox flow).
- No backfilling historical versions.
- No changes to the existing `verify` npm script.

## Acceptance matrix

| ID | Feature point | Acceptance | Concrete verification | Pass criteria |
|----|---------------|------------|----------------------|---------------|
| A1 | dry-run preview | Automated (integration) | `npm run changelog -- --dry-run` exits 0, prints JSON with `changelog_preview` containing `## [0.6.0]` or next-patch section and grouped entries from v0.5.2..HEAD; CHANGELOG.md unmodified | Command output assertions |
| A2 | apply inserts top section | Automated (unit) | Unit test on a temp file via exported `insertSection`/CLI with fixture dir: header-stub CHANGELOG gains the new `## [...]` section above prior content | Test passes |
| A3 | parse correctness | Automated (unit) | Fixtures: `feat(scope): msg (#12)`, `fix: msg (#13)` with `!`, bare merge, `0.5.2 (#74)` version squash (skipped), non-conventional fallback, dedupe | Test passes |
| A4 | verify missing detection | Automated (unit + integration) | Unit: constructed lines/text → missing/extra/fail-closed paths. Integration: `node scripts/release_helper.mjs verify` on this branch (CHANGELOG stub, v0.5.2..HEAD has functional PRs #77-#82) exits 1 with missing listing those PRs | Both pass |
| A5 | Full regression | Automated (integration) | `npm test` | All green |
| A6 | Publishing docs updated | Automated (static) | README Publishing section mentions the changelog script and flow | grep |
| A7 | Scope | Automated (static) | `git diff main --stat` | Only scripts/release_helper.mjs, test/release-helper.test.mjs, package.json (one script line), CHANGELOG.md (stub), README.md |

## Testability split design

Pure functions take plain inputs (string lines, text, options) and return
plain data — no fs/git in unit tests. The CLI layer (git + fs) is covered by
two integration assertions (A1 dry-run on the real repo, A4 verify on the
real repo) executed as plain commands in the workflow, plus a tmp-dir apply
test via the exported path. This mirrors the repo's existing DI style.
