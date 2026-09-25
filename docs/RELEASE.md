# Release process

Releases are driven by `scripts/release.mjs` and published by CI when a GitHub
Release is created. Four commands and one merge:

```
precheck  →  prepare <bump>  →  open-pr <version>  →  merge (merge commit!)
          →  finish <version>  →  .github/workflows/publish.yml publishes to npm
```

`main` is protected, so a release lands as a pull request — but the npm publish
is not tied to that PR: it is tied to the GitHub Release, which is created only
after the PR is merged and the tag is confirmed to be on `main`.

## One-time setup: the npm trusted publisher

`publish.yml` publishes with **trusted publishing** (OIDC), so no `NPM_TOKEN`
secret is stored in the repository. npm has to be told which workflow may
publish the package — this is a one-time, per-package web step:

1. Open <https://www.npmjs.com/package/@zhuxixi/pi-agent-board> and sign in as
   the package owner.
2. Go to **Settings** → **Trusted Publisher** → **GitHub Actions**.
3. Fill in: organization `zhuxixi`, repository `pi-agent-board`, workflow
   filename `publish.yml`, environment left empty.
4. Save.

Until this is configured, the CI publish step fails with an authentication
error. Publishing locally (the pre-2026-09 flow, see "Local publish fallback"
below) still works, because the npm account keeps its normal credentials.

## Commands

### `node scripts/release.mjs precheck`

Read-only gate. Run it before anything else; it fails closed when the tree is
dirty, `main` is not in sync with `origin/main`, a `release/*` PR is still open,
the last tag is not an ancestor of `origin/main` (an orphan tag from a past
squash merge), or there is nothing functional to release.

### `node scripts/release.mjs prepare <patch|minor|major|X.Y.Z> [--dry-run]`

Runs the gate, then:

1. renders the new CHANGELOG section from the conventional commits since the
   last `v*` tag,
2. commits it as `docs(changelog): add <version> section`,
3. runs `npm version <bump>` — one commit plus the annotated `v<version>` tag,
4. switches to `release/v<version>`.

Nothing leaves the machine. `--dry-run` prints the section and the plan without
writing anything; review the preview before running it for real. Pick the bump
the same way as before: features are a `minor`, fixes alone are a `patch`.

### `node scripts/release.mjs open-pr <version> [--dry-run]`

Pushes the release branch and the tag, then opens the PR with the CHANGELOG
section as its body. The tag is pushed separately because tags are not covered
by the branch protection rule.

### Merge the PR with a merge commit

**Do not squash the release PR.** `npm version` created the tag on a commit that
only exists on the release branch; a merge commit brings that commit into
`main`, a squash does not, and the tag becomes unreachable from `main`
(`git describe` then misreads the changelog range of the next release). Use the
**Merge pull request** button, or `gh pr merge --merge`.

### `node scripts/release.mjs finish <version> [--dry-run] [--sync-main]`

Run it after the merge. It fetches, verifies that `v<version>` is an ancestor of
`origin/main`, re-checks the CHANGELOG against any functional PR merged after the
bump, and then creates the GitHub Release with the CHANGELOG section as its
notes. That release is the publish trigger. `--sync-main` also resets a clean
local `main` to `origin/main`, dropping the local copy of the two release
commits (they are content-equal to what the merge brought in).

To publish without the orchestration, the underlying commands are
`gh release create v<version> --title v<version> --notes-file <notes>` where the
notes are `node scripts/release.mjs notes <version>`.

## What CI does

`.github/workflows/publish.yml` runs on `release: published`, checks out the
tag, and:

1. asserts npm is at least 11.5.1 (trusted publishing needs it; Node 24 ships
   a newer one),
2. asserts the tag equals `package.json`'s version,
3. runs `npm run typecheck` and `npm test`,
4. skips the publish when that version is already on npm, and otherwise
5. runs `npm publish --provenance --access public`.

Provenance means npm records which repository, workflow, and commit built the
tarball, and shows it on the package page.

## Recovering from a broken release

**Orphan tag** (`finish` refuses with "not an ancestor of origin/main"). The
release PR was squash-merged. Re-point the tag at the content-equivalent commit
on `main`, then retry:

```bash
git fetch origin
git tag -f v0.9.0 <sha on origin/main with the same content>
git push origin v0.9.0 --force
node scripts/release.mjs finish 0.9.0 --sync-main
```

**CHANGELOG drift** (`finish` refuses with missing PR numbers, or
`node scripts/release_helper.mjs verify` exits 1). A functional PR merged after
the changelog section was generated. Add the missing entries to the top section
in a `docs(changelog)` PR, merge it, then retry — the release notes are read
again at that point, so the fix is picked up.

**The publish failed** (npm outage, trusted publisher not configured yet).
Re-run the same tag without recreating the release: Actions → **Publish to
npm** → **Run workflow** → enter the tag.

**`npm view <package>` returns 404 right after a successful publish.** That is
the registry's view index lagging, not a failed publish. Compare endpoints: the
tarball, `/<package>/latest`, and `/-/package/<package>/dist-tags` answer
immediately while the root document 404s for a few minutes. Wait; re-publishing
the same version is rejected with a 403 and is never the fix.

**Local publish fallback.** When the trusted publisher is not configured and a
release cannot wait:

```bash
npm run verify
npm publish --registry=https://registry.npmjs.org --access public
```

The registry must be passed explicitly: this machine defaults to
`registry.npmmirror.com`. This path skips provenance and the CI checks, so
prefer fixing the CI path.

## CHANGELOG conventions

`scripts/release_helper.mjs` renders the section from conventional commits in
the range `<last v* tag>..HEAD`. `feat`/`fix`/`perf` become Features / Fixes /
Performance, everything else (including `test` and `docs`) lands under Changes,
merges and `npm version` squash subjects are skipped, and `docs(changelog):`
subjects are ignored so changelog fixes do not feed back into the verify check.

Every entry carries the PR number parsed from the trailing `(#N)`. `verify`
fails when a functional commit's PR is missing from the top section — that is
what keeps a late merge from shipping without release notes.
