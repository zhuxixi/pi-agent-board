# Issue #64 CHANGELOG Release Helper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the jfox conventional-commit CHANGELOG helper to `scripts/release_helper.mjs` with preview/apply/verify modes, a CHANGELOG.md stub (forward-only), an npm `changelog` script, and Publishing docs.

**Architecture:** Pure exported functions (parse/generate/topPrs/verify/insert — unit tested on plain strings) + thin git-backed CLI (integration-checked against the real repo via subprocess in tests). See spec for the full contract.

**Tech Stack:** Node ESM, node --test.

## Global Constraints

- Forward-only: no backfill of ≤0.5.2 (spec).
- Tag format `vX.Y.Z`; repo URL `https://github.com/zhuxixi/pi-agent-board/compare/...`.
- No changes to the existing `verify` npm script; one new script line `changelog`.
- Scope (spec A7): scripts/release_helper.mjs, test/release-helper.test.mjs, package.json, CHANGELOG.md, README.md (+ process docs).

**Execution mode:** inline (executing-plans).

---

### Task 1: scripts/release_helper.mjs

Pure exports: `parseCommitLines(lines)`, `generateChangelog({version,date,entries,prevTag})`,
`changelogTopPrs(text)`, `functionalLines(lines)`, `verifyFrom({lines,changelogText})`,
`insertSection(existing, section)`. CLI: `[--dry-run] [patch|minor|major|X.Y.Z]` (default
patch, version from package.json, `last v* tag` via `git describe --tags --abbrev=0 --match v*`)
and `verify` (exit 1 + JSON missing list). Skip version-squash subjects (`0.5.2 (#74)`),
merge subjects, `docs(changelog)` in functional whitelist.

### Task 2: test/release-helper.test.mjs

Unit: parse fixtures (scoped feat with PR, `!`, merge skip, version-squash skip, fallback,
dedupe), generate grouping/order/compare-link, topPrs first-section-only, verifyFrom
ok/missing/extra/fail-closed, insertSection stub + existing. Integration (subprocess on the
real worktree repo): `--dry-run` exits 0 with `changelog_preview` containing the next version
heading and does not modify CHANGELOG.md; `verify` exits 1 with missing PRs from
v0.5.2..HEAD (functional PRs since v0.5.2 present in git but absent from the stub).

### Task 3: package.json script + CHANGELOG.md stub + README Publishing

`"changelog": "node scripts/release_helper.mjs"`; stub header (no entries, forward-only
note); Publishing section documents: npm version → npm run changelog (preview, review) →
commit → PR → tag + GitHub Release with notes from top section.

### Task 4: verify acceptance

npm test green (A5); `npm run changelog -- --dry-run` (A1); `node scripts/release_helper.mjs
verify` exit 1 with missing list (A4); grep README (A6); diff stat scope (A7). Commit.

## Self-Review

Spec A1-A7 map to Tasks 2-4; no placeholders; types consistent with spec signatures.
