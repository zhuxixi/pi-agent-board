# Code-Refs Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each board row's associated issue number and submitted PR number as inline badges, extracted locally from session evidence via a platform-agnostic regex-rule engine.

**Architecture:** Pure extraction engine (`src/core/code-refs.mjs`, zero I/O) driven by per-platform regex rule bundles ("providers": builtin GitHub/GitLab + user `providers.json`, append-merged); artifact persistence in `src/core/code-refs-store.mjs` (per-view `github.json`, atomic writes); write-through hooks at all five `writeEvidence` call sites; rendering via existing RowView badge + peek detail patterns. Spec: `docs/superpowers/specs/2026-08-29-code-refs-badges-design.md` (decisions D1–D5 govern).

**Tech Stack:** Node 20+ ESM `.mjs` (JSDoc types, no TS in core), `node --test`, pi-agent-board store layout.

## Global Constraints

- **Work only in this worktree**: `/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-40-code-refs-badges`. Never touch the main checkout.
- Core modules are `.mjs` with JSDoc typedefs; **indent with tabs** (match existing files); `node:assert/strict` + `node:test` for tests; tmp dirs via `mkdtempSync(join(tmpdir(), ...))` with `rmSync(..., {recursive:true, force:true})` cleanup.
- All artifact writes go through `atomicWriteJson` from `src/core/atomic.mjs`; reads through `readJson`.
- Commit per task, conventional commits (`feat:`/`test:`/`fix:`), stage files explicitly (`git add <file>`), never `git add -A`.
- Coverage gate (CI-enforced): lines 85% / functions 80% / branches 70% (`npm run test:coverage`); new core modules must be thoroughly covered.
- No network calls anywhere in v1. `gh`/`glab` are only ever *parsed as text*, never executed. Only `git` may be shelled out to (repo.mjs pattern: `execFileSync` with `stdio:["ignore","pipe","ignore"]`, try/catch → null).
- Kill switch: env `AGENT_BOARD_CODE_REFS=off` disables extraction (checked in the hook helper).
- English code comments and commit messages.

---

### Task 1: `gitRemoteHost` in repo.mjs

**Files:**
- Modify: `src/core/repo.mjs`
- Test: `test/repo.test.mjs`

**Interfaces:**
- Produces: `gitRemoteHost(repoRoot: string) → string|null` — host of `origin` remote, lowercase, no port. Supports `https://host/owner/repo(.git)` and `git@host:owner/repo(.git)`. Module-level `Map` cache keyed by repoRoot (failures cached as null). Also `clearRemoteHostCacheForTests() → void`.
- Consumed by: Task 4 (store) / Task 5 (hook helper).

- [ ] **Step 1: failing tests** in `test/repo.test.mjs` (follow existing temp-repo style, `skip: !gitAvailable()`):
  - https remote `https://github.com/zhuxixi/pi-agent-board.git` → `"github.com"`
  - ssh remote `git@gitlab.example.com:team/demo.git` → `"gitlab.example.com"`
  - no remote → `null`; not a repo → `null`
  - cache: second call returns same value; after `git remote set-url` + no cache clear, still old value; after `clearRemoteHostCacheForTests()`, new value
- [ ] **Step 2: run tests, see them fail** (`node --test test/repo.test.mjs`)
- [ ] **Step 3: implement** in `src/core/repo.mjs` (same `execFileSync("git", ["-C", root, "remote", "get-url", "origin"], …)` pattern as `gitRepoRoot`; parse with two regexes; cache both hits and misses)
- [ ] **Step 4: tests pass**
- [ ] **Step 5: commit** `feat(repo): gitRemoteHost with per-root cache`

---

### Task 2: provider layer in code-refs.mjs (schema, builtins, merge, host match)

**Files:**
- Create: `src/core/code-refs.mjs`
- Test: `test/code-refs-providers.test.mjs`

**Interfaces:**
- Produces (all pure, zero I/O except `loadProviders` reading one JSON file path passed in):
  - `builtinProviders() → Provider[]` — GitHub + GitLab bundles (rules below)
  - `genericFallbackProvider() → Provider` — name `"generic"`, hosts `[]`, URL-only rules: `/issues/(\d+)` (issue/view), `/pull/(\d+)` (pr/action), `/-/issues/(\d+)` (issue/view), `/-/merge_requests/(\d+)` (pr/action); prefixes `#` / `▸#`; no urlTemplates
  - `validateProvider(raw: any) → { provider: Provider|null, errors: string[] }` — each rule compiled with `new RegExp(pattern)`; invalid regex → skipped with error message; missing required fields → error
  - `mergeProviders(builtins: Provider[], user: Provider[]) → Provider[]` — same `name` → user rules **prepended** to builtin rules, user scalar fields (hosts/prefixes/urlTemplates) override; unknown names appended as-is
  - `loadProviders(root: string) → Provider[]` — reads `<root>/providers.json` if present (via `readJson` from atomic.mjs), validates + merges with builtins; on any error returns builtins alone (never throws). Result cached by file mtime in a module Map.
  - `matchProvider(providers: Provider[], host: string|null) → Provider` — exact host match (lowercase); null host or no match → `genericFallbackProvider()`
  - Provider typedef: `{ name, hosts: string[], issuePrefix: string, prPrefix: string, urlTemplates: { issue?: string, pr?: string }|null, rules: Rule[] }`; Rule typedef: `{ regex: RegExp, pattern: string, kind: "issue"|"pr", strength: "claim"|"action"|"view", numberFrom: "capture"|"outputUrl" }`
- Consumed by: Task 3 (engine), Task 5 (hook helper calls `loadProviders`).

Builtin GitHub rules (patterns are matched **unanchored** against full command strings and assistant texts):
```
claim:  gh\s+issue\s+edit\s+#?(\d+)(?=[\s\S]*--add-assignee)            kind: issue
action: gh\s+issue\s+(?:comment|edit|close|reopen)\s+#?(\d+)            kind: issue
action: gh\s+issue\s+create\b                                            kind: issue, numberFrom: outputUrl
action: gh\s+pr\s+(?:checkout|merge|comment|review|close)\s+#?(\d+)      kind: pr
action: gh\s+pr\s+create\b                                               kind: pr, numberFrom: outputUrl
action: github\.com/[\w.-]+/[\w.-]+/pull/(\d+)                           kind: pr
view:   gh\s+issue\s+view\s+#?(\d+)                                      kind: issue
view:   gh\s+pr\s+(?:view|diff|checks)\s+#?(\d+)                         kind: pr
view:   github\.com/[\w.-]+/[\w.-]+/issues/(\d+)                         kind: issue
urlTemplates: issue "https://{host}/{owner}/{repo}/issues/{number}", pr "https://{host}/{owner}/{repo}/pull/{number}"
```
Builtin GitLab rules:
```
claim:  glab\s+issue\s+(?:edit|update)\s+#?(\d+)(?=[\s\S]*--assignee)    kind: issue
action: glab\s+issue\s+(?:note|comment|close|reopen)\s+#?(\d+)           kind: issue
action: glab\s+mr\s+(?:checkout|merge)\s+!?(\d+)                         kind: pr
action: glab\s+mr\s+create\b                                             kind: pr, numberFrom: outputUrl
action: /-/merge_requests/(\d+)                                          kind: pr
view:   glab\s+(?:issue|mr)\s+view\s+!?#?(\d+)                           kind: issue-or-pr by matched subcommand — implement as two rules: glab\s+issue\s+view\s+#?(\d+) (issue) and glab\s+mr\s+view\s+!?(\d+) (pr)
view:   /-/issues/(\d+)                                                  kind: issue
prefixes: issue "#", pr "!"
urlTemplates: issue "https://{host}/{owner}/{repo}/-/issues/{number}", pr "https://{host}/{owner}/{repo}/-/merge_requests/{number}"
```

- [ ] **Step 1: failing tests**: builtin shape sanity (every rule regex compiles, kinds/strengths in enum); validateProvider rejects bad regex / missing kind; mergeProviders prepends user rules and overrides prefixes; loadProviders with missing file → builtins; with broken JSON → builtins; with valid user file → merged; matchProvider exact/lowercase/fallback
- [ ] **Step 2: run, fail**
- [ ] **Step 3: implement**
- [ ] **Step 4: tests pass**
- [ ] **Step 5: commit** `feat(code-refs): provider schema, builtin github/gitlab rules, append-merge loading`

---

### Task 3: extraction + scoring engine in code-refs.mjs

**Files:**
- Modify: `src/core/code-refs.mjs`
- Test: `test/code-refs-extract.test.mjs`

**Interfaces:**
- Consumes: Provider/Rule from Task 2.
- Produces:
  - `extractCodeRefs(input, provider) → CodeRefsResult`
    - `input: { commands: Array<{ command: string }>, assistantTexts: string[], worktreePath: string|null, branch: string|null, repoUrl: string|null }` (`repoUrl` = `owner/repo` path part of the remote, used for urlTemplates; may be null)
    - `CodeRefsResult: { provider: string, issue: Ref|null, pr: Ref|null, allRefs: Ref[] }`
    - `Ref: { kind: "issue"|"pr", number: number, strength: "claim"|"action"|"view"|"mention", confidence: "high"|"medium"|"low", source: string, url: string|null, lastIndex: number }`
  - `parseRepoPath(repoRoot) → string|null` — **move-free helper**: parse `owner/repo` from remote URL. NOTE: Task 1 didn't produce this; add `gitRemoteUrl(repoRoot)` to repo.mjs here (same pattern, also cached) returning the raw URL, and keep URL→host and URL→path parsing pure in code-refs.mjs (`parseRemoteHost(url)`, `parseRemotePath(url)`). Refactor Task 1's `gitRemoteHost` to use `gitRemoteUrl` + `parseRemoteHost` internally. Update repo tests accordingly.

Engine rules (implement exactly):
1. Scan `commands` in array order; each rule regex applied to `command`; capture group 1 = number (rules with `numberFrom:"outputUrl"` yield no number here — record a *pending create* marker with kind+index).
2. Scan `assistantTexts` (treat as ordered sequence after commands, indexes continue) with only the URL rules (patterns containing `/` path segments — select rules whose pattern contains `issues/|pull/|merge_requests/`).
3. Pending-create resolution: for each `pr create`/`issue create`/`mr create` marker, search **subsequent** texts/commands for the provider's URL rule of the same kind; first hit assigns the number at strength `action`, `source:"create-url"`. Unresolved markers contribute nothing (outputPreview bug #41 means bash output is unreadable — do **not** read outputPreview).
4. PR back-link: within a `pr create` command string, `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|issue)\s+#(\d{1,7})` → issue ref at `claim` strength, `source:"pr-body"`.
5. Worktree naming (engine-builtin, not configurable): `(?:^|[/\\])issue-(\d{1,7})(?:-|$)` against `worktreePath` and `branch` → issue ref at `claim`, `source:"worktree"`.
6. Mention fallback (only if no issue candidate of strength ≥ view exists): count `#(\d{1,7})` over the **last 20** assistantTexts; winner needs count ≥3 **and** ≥ 2× runner-up; strength `mention`, confidence `low`, kind issue, no url.
7. Aggregation per kind: candidate with highest strength wins; tie → highest `lastIndex`; `view` candidates with total count < 2 are discarded first. Confidence: claim/action → `high`, view → `medium`, mention → `low`. `allRefs`: distinct (kind,number) sorted by strength desc then lastIndex desc, max 10. `url`: fill from provider.urlTemplates when repoUrl + template exist (`{host}` needs host — pass host in via provider match context: extend input with `host: string|null`; substitute `{host}/{owner}/{repo}` — owner/repo split from repoUrl path, repo name minus trailing `.git`).
8. Empty input → `{ provider: provider.name, issue: null, pr: null, allRefs: [] }`.

Test cases must include (synthetic but modeled on real observed sessions):
- assign claim beats later plain `issue view` of another number
- worktree path `issue-40-code-refs-badges` yields issue 40 claim with zero commands
- `gh pr create --body "…issue #40…"` sets both pr (pending → resolved by later assistant URL text) and issue 40 (pr-body claim)
- ambiguity case: commands viewing 439/440/441 each once, commenting 453 twice → issue = none from view (count<2), pr… construct exact expectation per rules (453 is a pr comment → pr=453 action)
- mention fallback: `#40` ×5, `#7` ×2 → issue 40 low confidence; `#40` ×3, `#41` ×3 → no winner (not 2×)
- unresolved `gh pr create` (no later URL) → pr null
- empty input; null host with generic fallback provider still extracts from URLs

- [ ] **Step 1: failing tests** (above list, one test each)
- [ ] **Step 2: run, fail**
- [ ] **Step 3: implement** (including the repo.mjs `gitRemoteUrl` refactor)
- [ ] **Step 4: tests pass; re-run task-1 tests**
- [ ] **Step 5: commit** `feat(code-refs): extraction engine with 4-tier signal scoring`

---

### Task 4: github.json artifact + store plumbing

**Files:**
- Create: `src/core/code-refs-store.mjs`
- Modify: `src/core/paths.mjs`, `src/core/types.mjs`, `src/core/store.mjs`
- Test: `test/code-refs-store.test.mjs`, extend `test/store.test.mjs`

**Interfaces:**
- `paths.mjs`: `providersPath(root) → <root>/providers.json`; `codeRefsPath(root, viewId) → <root>/views/<id>/github.json`
- `code-refs-store.mjs`:
  - `emptyCodeRefsSnapshot({viewId}) → snapshot` `{ version:1, viewId, updatedAt, provider:null, issue:null, pr:null, allRefs:[] }`
  - `normalizeCodeRefsSnapshot(raw, {viewId})` (same defensive shape as evidence's normalize)
  - `readCodeRefs(root, viewId) → snapshot` / `writeCodeRefs(root, snapshot) → snapshot` (atomicWriteJson, bumps updatedAt)
  - `summarizeCodeRefs(snapshot) → { provider, issue, pr, allRefs }`
  - `updateCodeRefsFromEvidence(root, viewId, evidence) → boolean` — the hook helper: returns false without writing when `AGENT_BOARD_CODE_REFS=off`; reads meta via `readMeta` (lazy import cycle check — store.mjs must not import code-refs-store.mjs if code-refs-store imports store.mjs: therefore `updateCodeRefsFromEvidence` takes `meta` as a parameter instead; callers pass `row.meta`/config). Resolves repoRoot = `meta.repoRoot ?? meta.cwd`, host via `gitRemoteUrl`+parse, provider via `loadProviders(root)`+`matchProvider`, worktreePath/branch (`branch`: `git -C <cwd> branch --show-current`, best-effort cached 60s in module Map), builds engine input from `evidence.commands` + last 20 `assistantEvidence[].text`, writes snapshot only when serialized content changed. Never throws (catch → appendDiagnostic `code_refs_extract_failed`, return false).
- `types.mjs`: `CodeRefsSummary` typedef; `ViewState` optional `codeRefs`; Row typedef gains `codeRefs`.
- `store.mjs` `readViewArtifactSummaries`: add `codeRefs: summarizeCodeRefs(readCodeRefs(root, viewId))` (mirror evidence lines; archived short-circuit untouched).

- [ ] **Step 1: failing tests**: paths shape; snapshot normalize (garbage in → safe defaults); write→read roundtrip; summarize; updateCodeRefsFromEvidence with a fabricated evidence (commands containing `gh issue view 40` ×2) + fabricated meta (cwd = temp repo with github remote) → github.json contains issue 40 medium confidence; `AGENT_BOARD_CODE_REFS=off` → no file; broken providers.json in root → still extracts via builtins
- [ ] **Step 2: run, fail**
- [ ] **Step 3: implement**
- [ ] **Step 4: tests pass (incl. existing store.test.mjs)**
- [ ] **Step 5: commit** `feat(code-refs): per-view github.json artifact + store plumbing`

---

### Task 5: hook the five writeEvidence sites

**Files:**
- Modify: `runner/job-runner.mjs` (2 sites: initial write ~L66, shared `persist()` ~L105), `src/runtime/service.mjs` (syncRowEvent ~L519 and agent_end ~L550), `runner/state-runner.mjs` (~L57)
- Test: extend `test/service.test.mjs` (or the existing runner integration style) minimally; full coverage arrives in Task 7.

**Interfaces:**
- Consumes: `updateCodeRefsFromEvidence(root, viewId, evidence, meta)` from Task 4.
- Call it immediately after each `writeEvidence(root, evidence)`:
  - job-runner sites have `config` (with cwd) but need meta → use `readMeta(root, viewId)` once at runner start, reuse
  - service.mjs `syncRowEvent(row, event)` → pass `row.meta`
  - state-runner has `config` → `readMeta(config.root, config.viewId)` once
- All call sites wrapped so a throw can never escape (helper already never throws; still call inside existing try blocks where present).

- [ ] **Step 1: failing test**: service-level — feed `syncRowEvent`-equivalent path (see how service.test.mjs fabricates rows) an event stream whose bash command is `gh issue comment 40 --body hi`; assert `<root>/views/<id>/github.json` exists with issue 40
- [ ] **Step 2: run, fail**
- [ ] **Step 3: implement the 5 hook calls**
- [ ] **Step 4: tests pass**
- [ ] **Step 5: commit** `feat(code-refs): extract on every evidence write (job-runner/service/state-runner)`

---

### Task 6: RowView badges + peek Refs section + README

**Files:**
- Modify: `src/core/rows.mjs` (rowView), `src/ui/dashboard.ts` (renderRow badges ~L1364-1365; renderPeek after Auto-state block ~L1400), `README.md` (env var table row)
- Test: `test/rows.test.mjs`, `test/dashboard-render.test.mjs`

**Interfaces:**
- RowView gains: `refsBadge: string` (e.g. `"#40 ▸#45"`, `""` when nothing), `refsLowConfidence: boolean` (true when the winning issue or pr confidence is `low`), `codeRefs: CodeRefsSummary|null` (peek consumes).
  - Badge format: `${issuePrefix}${issue.number}` and `${prPrefix}${pr.number}` joined by space; prefixes from `summary.provider`'s bundle — simplest: store resolved prefixes in the snapshot at write time (add `issuePrefix`/`prPrefix` fields to snapshot in Task 4's normalize with defaults `#`/`▸#`; if you do this, update Task 4 tests — do it as part of this task's implementation and keep Task 4 commit green by amending its tests here).
- renderRow: append `refsBadge` to `statusBadges` string; when `refsLowConfidence` wrap badge in `t.fg("dim", …)` (compose with existing badge assembly; verify width math still clamps via existing `visibleWidth(badge)` path).
- renderPeek: after the Auto-state block add a `Refs` section (mirror that block's structure): provider name; one line per allRefs entry `kind #number · confidence · source · url`; section omitted when `codeRefs` is null/empty.
- README env table: add `AGENT_BOARD_CODE_REFS` row (`off` disables issue/PR badge extraction).

- [ ] **Step 1: failing tests**: rows.mjs rowView maps summary → badge strings (incl. dim flag, empty case); dashboard-render test asserting badge appears in the row line and Refs section renders in peek (follow existing dashboard-render.test.mjs patterns)
- [ ] **Step 2: run, fail**
- [ ] **Step 3: implement**
- [ ] **Step 4: tests pass**
- [ ] **Step 5: commit** `feat(dashboard): inline issue/PR badges + peek Refs section`

---

### Task 7: end-to-end integration + full verify

**Files:**
- Modify: `test-support/fake-pi.mjs` (new `FAKE_PI_MODE=github-refs`: emitted event stream includes a bash tool_execution for `gh issue edit 40 --add-assignee @me`, later an assistant message containing `https://github.com/zhuxixi/pi-agent-board/pull/45`), `test/runner.integration.test.mjs` (new case: run with that mode, assert `github.json` has issue 40 claim + pr 45 action, and row view badge `#40 ▸#45`)
- Test only.

- [ ] **Step 1: write the failing integration test** (mirror existing runner.integration.test.mjs setup: tmp AGENT_BOARD_ROOT etc.)
- [ ] **Step 2: extend fake-pi.mjs mode**, run test, iterate to green
- [ ] **Step 3: full `npm run verify`** (typecheck + tests + coverage + pack:dry) — all green; if coverage dips below gate, add focused unit tests to the new modules (do not weaken thresholds)
- [ ] **Step 4: commit** `test(code-refs): fake-pi github-refs mode + end-to-end badge assertion`

---

## Post-implementation (controller, not a task)

- Dispatch final broad code review, then open PR (`Closes #40`), label `zima:needs-review`, monitor CR per zima-pr-monitor skill.
