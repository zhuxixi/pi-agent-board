# Spec: #295 — greeting first message must not freeze the session title

Status: DRAFT (rev 4, post round-3 cross-review; 1 gap + 3 details accepted, 5 passes) — gate=design-only per `../authorization.md`: after convergence, PAUSE once for user design confirmation, then push/PR/CR-fix loop runs automatically until the merge decision.
Issue: https://github.com/zhuxixi/pi-agent-board/issues/295
Repo baseline: local main `750b854` (post-#293 merge). Pi 1.5.1 runtime. Implementation re-pins `origin/main` in the worktree and records the SHA.
Plan provenance: @SummerZuo's fix plan (issue comment) — endorsed by the maintainer; this spec turns it into a verifiable design.
Research artifacts: `~/.github-issue-driven/zhuxixi/pi-agent-board/issue-295/research/` (research-summary.md).

Drafted: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-13T08:45:00+08:00
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-13T09:05:00+08:00 — R1-G1 (greedy longest-match tokenizer so multi-word/multi-char greetings actually match; A1 explicit phrase cases), R1-G2 (unified `commitMeta` dep), R1-G3 (`resolveTitleSettings` pure resolver owning both env vars + precedence; flow is env-free; `enabled:false` exits before polling), R1-G4 (A4 failure branches: empty/null/fallback outputs, readMeta null, rename during pending one-shot, rejection propagation), R1-G5 (U1 deployment preconditions: loaded checkout, pull, SHA record, full restart, provider auth), R1-G6 (last-line extraction preserved in `generateOnce`; multiline cases in A4), R1-D1 (honest shell coverage + hermetic runner smoke test A6 with new fixture), R1-D2 (U1③ reordered to actually reach the guard)
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-13T09:25:00+08:00 — R2-G1 (consume rule rewritten as whole-string greedy consumption without per-unit trailing boundary, so `你好呀`/`嗨嗨` match and the duplicate rule is subsumed; A1 gains no-separator negatives `helloX`/`你好请修复`), R2-D1 (U1 precondition now runs a one-shot with the explicit resolved title model/thinking instead of relying on VERIFY.md §2's default-model check)
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-13T09:50:00+08:00 — R3-G1 (greeting-first grammar: the first consumed unit must be a GREETINGS entry; PARTICLES may only follow; A1 adds bare-particle and particle-first negatives), R3-D1 (U1① timing anchored to the substantive message send, ~30s window), R3-D2 (A6 spawns the fixture via `piCommand: process.execPath` + `piArgsPrefix: [fixture]` per the repo's hermetic pattern), R3-D3 (one-shot health judgment aligned with VERIFY.md: exit 0 + assistant `message_end` + `agent_end` + no auth errors)

## Problem (root cause, verified on `750b854`)

A session whose first user message is a bare greeting (`hello` / `hi` / `你好`) keeps a useless title ("Simple greeting") forever:

1. `queueGeneratedTitle(meta, prompt)` has a single call site — the dispatch path (`src/runtime/service.mjs:2083`); replies never re-trigger it.
2. `runner/title-runner.mjs` generates the title **once**, from that first prompt, via a one-shot model call.
3. The write-back guard `if (meta.name !== config.fallbackName) return;` (`runner/title-runner.mjs:40`) — intended as "manual rename wins" — then holds forever, because the generated title made `meta.name` differ from the fallback.

Feasibility notes from research (see research-summary.md): the referenced `feat/board-ux-title` retry machinery (`shouldRetryTitle` / `TITLE_RETRY_BACKOFF_MS`) does **not exist** on origin or in any commit; the design is therefore fully self-contained inside the runner. `contentText` is currently private in `src/core/session-view.mjs` and must be lifted. Nothing reaps a longer-lived title-runner (detached spawn, warm-host sweeper only targets PTY hosts and skips `AGENT_BOARD_NO_SWEEP=1` children).

## Design

### 1. `src/core/title.mjs` — greeting classifier (pure)

`isGreetingPrompt(text)` classifies a message as a greeting iff the **entire** message is greeting material.

Normalization: `String(text ?? "")` → trim → lowercase → collapse whitespace runs to a single space → strip leading/trailing characters from `PUNCT = "！!？?。.,，、~～…;；:："`.

Matching is a **whole-string greedy longest-match consume** over the normalized string (multi-word English phrases and multi-character Chinese phrases are first-class vocabulary units; adjacent units need no separator, which is what makes `你好呀` and `嗨嗨` match):

- Vocabulary: `GREETINGS = { hello, hi, hey, hiya, yo, sup, howdy, greetings, morning, good morning, good afternoon, good evening, good day, 你好, 您好, 嗨, 哈喽, 哈啰, 在吗, 在么, 早上好, 上午好, 早安, 下午好, 晚上好, 晚安 }` and `PARTICLES = { there, 呀, 啊, 哦 }` (covers `hi there`, `你好呀`).
- Consume rule (**greeting-first**): starting at position 0, repeatedly (a) skip any run of separators (a space or any `PUNCT` char), then (b) consume the **longest** vocabulary unit matching at the current position — **no trailing-boundary requirement on individual units**. **The first consumed unit must belong to `GREETINGS`; units consumed after the first may be `GREETINGS` or `PARTICLES`.** There is no separate repetition rule: adjacent duplicates (``hello hello``, ``嗨嗨``) are naturally consumed because each unit is itself in the vocabulary.
- The message is a greeting iff the consume reaches the end of the string with **at least one `GREETINGS` unit consumed**. A stuck position — next characters match no vocabulary unit (``hello, please fix X`` stalls at ``please``; bare ``good`` stalls immediately since ``good`` alone is not in the vocabulary; no-separator real tasks like ``helloX`` / ``你好请修复`` stall at ``X`` / ``请修复``) → `false`; a string that never consumes a `GREETINGS` unit (bare ``there``, bare ``呀``, or particle-first ``there hello``) → `false`. Empty string → `false`.
- The vocabulary is intentionally small and fixed (denylist-style classifier, not NLP); extending it is a one-line change plus tests.

### 2. `src/core/title.mjs` — env settings resolver (pure, new)

`resolveTitleSettings(env, configModel)` returns `{ enabled: boolean, model: string, thinking: string }`, owning **both** legacy and current env vars with today's exact precedence (currently inlined in `runner/title-runner.mjs:26-29`):

- `configured = env.AGENT_BOARD_TITLE_MODEL ?? env.AGENT_VIEW_TITLE_MODEL`
- `enabled = configured !== "off"` (off wins even when `configModel` is set — preserves today's early return)
- `model = configModel ?? configured ?? DEFAULT_TITLE_MODEL`
- `thinking = env.AGENT_BOARD_TITLE_THINKING_LEVEL ?? env.AGENT_VIEW_TITLE_THINKING_LEVEL ?? DEFAULT_TITLE_THINKING_LEVEL`

The flow module never reads `process.env`; the shell calls this resolver once and either exits (`enabled === false`, before any polling starts) or wires `runOneShot` with the resolved model/thinking.

### 3. `src/core/session-entries.mjs` — lift `contentText`

Move `contentText(content)` verbatim from `src/core/session-view.mjs` into `src/core/session-entries.mjs` (both are structure/projection primitives; session-entries is the documented "single source" module and has no `node:fs` import). `session-view.mjs` imports it from there — no duplicate, no behavior change.

### 4. `src/core/title.mjs` — substantive-prompt projection (pure)

`firstSubstantiveUserPrompt(sessionJsonlText)`:

- `parseSessionEntries` → `activeBranchEntries` (both from `src/core/session-entries.mjs`);
- iterate branch entries in order, keep `type === "message"` with `message.role === "user"`, project text via `contentText(message.content)` (only text blocks — tool-result user entries project to empty and are skipped);
- skip empty projections and entries where `isGreetingPrompt(text)` is true (the first entry **is** the greeting prompt that triggered polling);
- return the first remaining text; if none, `null`.

### 5. `src/core/title-flow.mjs` — orchestration with injected I/O (new module)

Exported: `runTitleFlow(config, deps)` plus constants `TITLE_POLL_INTERVAL_MS = 15_000`, `TITLE_POLL_BUDGET_MS = 300_000`.

`deps` (all injected; the runner shell wires real implementations):
`{ now(): number, sleep(ms): Promise<void>, readMeta(root, viewId): object|null, commitMeta(meta): void, readSessionText(config): string|null, runOneShot(prompt): Promise<string|null> }`

`TitleConfig` (`src/core/types.mjs` JSDoc) gains optional `pollIntervalMs` / `pollBudgetMs`; when absent the constants above apply. The service never sets them — they exist so hermetic tests can shrink the poll window without touching production timing.

Flow (single source for both paths):

```text
runTitleFlow(config, deps):
    if !isGreetingPrompt(config.prompt):
        return generateOnce(config, deps, config.prompt)          // today's behavior, unchanged
    deadline = deps.now() + (config.pollBudgetMs ?? TITLE_POLL_BUDGET_MS)
    interval = config.pollIntervalMs ?? TITLE_POLL_INTERVAL_MS
    loop while deps.now() < deadline:
        await deps.sleep(interval)                                 // sleep-first: t=15s, 30s, …
        text   = deps.readSessionText(config)                      // readMeta → meta.sessionFile → read if exists, else null
        prompt = text ? firstSubstantiveUserPrompt(text) : null
        if prompt: return generateOnce(config, deps, prompt)
    return                                                          // budget exhausted → quiet exit, row keeps fallback slug

generateOnce(config, deps, prompt):
    out   = await deps.runOneShot(prompt)                           // rejection propagates to the caller (shell catches — best effort)
    last  = out?.trim().split("\n").slice(-1)[0]?.trim() ?? ""      // LAST LINE ONLY — today's shell semantics, now owned by the flow
    title = normalizeGeneratedTitle(last, config.fallbackName)
    if !title || title === config.fallbackName: return
    meta = deps.readMeta(config.root, config.viewId)
    if !meta: return
    if meta.name !== config.fallbackName: return                    // manual rename wins — re-checked at write time
    meta.name = title
    deps.commitMeta(meta)
```

`readMeta` is re-read **inside** `generateOnce` right before the guard, so a manual rename at any point — during polling **or** while the one-shot model call is pending — still wins (this also keeps the runner safe against other `meta.name` writers such as the user-side `agent-board-name-sync` bridge). `runOneShot` rejections are **not** caught inside the flow: they propagate to the shell's existing `.catch(() => {})` best-effort handler. (Today's real `runOneShot` never rejects — it resolves `""` on spawn error and on timeout — but injected test doubles may.)

### 6. `runner/title-runner.mjs` — thin shell

- Keep argv/config-file handling, `runOneShot` (spawn + JSON event scan + timeout), and the top-level best-effort catch.
- `main()`: read config → `const settings = resolveTitleSettings(process.env, config.model)` → `if (!settings.enabled) return` (before any polling) → wire real deps and `await runTitleFlow(config, deps)`:
  - `now: Date.now`, `sleep: ms => new Promise(r => setTimeout(r, ms))`
  - `readMeta` from `src/core/store.mjs`
  - `commitMeta: meta => writeMeta(config.root, meta)` (`writeMeta` from `src/core/store.mjs`)
  - `readSessionText: () => { const m = readMeta(config.root, config.viewId); if (!m?.sessionFile) return null; return existsSync(m.sessionFile) ? readFileSync(m.sessionFile, "utf8") : null; }`
  - `runOneShot: prompt => runOneShot(config.piCommand, [...config.piArgsPrefix, "--mode", "json", "-p", "--no-session", "--model", settings.model, ...(settings.thinking && settings.thinking !== "off" ? ["--thinking", settings.thinking] : []), titlePrompt(prompt)], 15000)`
- `src/runtime/service.mjs` is **not touched** (single call site, same config shape, same fallback name).

### Decision table

| Situation | Behavior |
|---|---|
| First prompt is substantive | Identical to today: generate once at dispatch, guarded write |
| First prompt is a greeting, later substantive user message within budget | Title generated from that first substantive message; guarded write |
| First prompt is a greeting, manual rename before the write (polling **or** one-shot pending) | Manual name kept (guard re-checks `meta.name` at write time) |
| First prompt is a greeting, no substantive message within budget | Runner exits quietly; row keeps fallback slug (today's failure mode, no worse) |
| Title settings resolve to off (`AGENT_BOARD_TITLE_MODEL` or legacy `AGENT_VIEW_TITLE_MODEL` = `off`) | Shell exits before flow and before polling; no generation |
| Session file never appears (child failed to start) | Poll misses every tick (readSessionText → null); quiet exit at budget |
| Model call returns empty / null / fallback-equal output | No commit (normalize + equality guard) |
| `readMeta` returns null at write time | No commit, quiet return |
| `runOneShot` rejects | Propagates to shell's `.catch(() => {})`; no commit |

### Non-goals

- No retry/backoff machinery (the referenced `feat/board-ux-title` branch does not exist); no changes to `service.mjs` scheduling; no regeneration for rows that already carry a generated or manual title.
- No NLP greeting detection beyond the fixed vocabulary; no change to the title model, prompt, `normalizeGeneratedTitle`, or the last-line extraction semantics.
- No new env knobs (both legacy and current title env vars keep today's names and precedence).

## Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | `isGreetingPrompt` classification | 自动化验证（unit） | `node --test test/title.test.mjs` | 正例：`hello/hi/hey/hiya/yo/sup/howdy/greetings/morning`、**`good morning/good afternoon/good evening/good day`**、zh 全词表（`你好/您好/嗨/哈喽/哈啰/在吗/在么/早上好/上午好/早安/下午好/晚上好/晚安`）、大小写、首尾标点、重复（`hello hello`、`嗨嗨`）、语气词后缀（`hi there`、`你好呀`）→ `true`；反例：问候前缀实任务（`hello, please fix X`）、**无分隔符前缀任务（`helloX`、`你好请修复`）**、**裸语气词（`there`、`呀`）、语气词在前（`there hello`）**、裸 `good`、空串、非问候 → `false` |
| A2 | `firstSubstantiveUserPrompt` projection | 自动化验证（unit） | `node --test test/title.test.mjs` | fixture JSONL（问候首条、tool-result 用户条目、assistant 条目、非活动分支）：返回活动分支第一条实质用户消息文本；全问候/空文件/无用户消息 → `null` |
| A3 | `contentText` lift regression | 自动化验证（unit） | `npm test`（既有 session-view/session-entries 测试不变更地通过） | 行为零变化 |
| A4 | greeting poll flow + guard + failure branches | 自动化验证（unit，注入 I/O + 假时钟） | `node --test test/title-flow.test.mjs` | ①问候→轮询命中→以实质消息调 `runOneShot`、守卫后 `commitMeta` 提交；②轮询期间手动改名→不提交；③预算耗尽→不调 `runOneShot`、不提交、安静返回；④非问候→立即生成、不轮询；⑤`runOneShot` 返回 null/空串/等于 fallback 的输出→不提交；⑥写前 `readMeta` 返回 null→不提交；⑦deferred `runOneShot` 挂起期间改名→恢复后仍不提交；⑧`runOneShot` reject→异常传播出 flow、不提交（由 shell catch 承接）；⑨多行模型输出（两条路径各一例）→只用最后一行生成标题 |
| A5 | `resolveTitleSettings` env resolution | 自动化验证（unit） | `node --test test/title.test.mjs` | `AGENT_BOARD_TITLE_MODEL=off` → `enabled:false`；legacy `AGENT_VIEW_TITLE_MODEL=off` → `enabled:false`；两变量并存时 board 优先；`configModel` 覆盖 env model 但不覆盖 off；thinking 同名变量与默认值链路正确 |
| A6 | runner shell hermetic smoke | 自动化验证（integration） | `node --test test/title-runner-smoke.test.mjs`（新 fixture `test-support/fake-title-pi.mjs`：输出一行 `message_end` JSON 后退出；**按仓内 hermetic 模式配置 `piCommand: process.execPath`、`piArgsPrefix: [<fixture 绝对路径>]`**——不直接 spawn `.mjs`，Windows 亦可移植） | ①非问候：真实 spawn `node runner/title-runner.mjs <config>`，temp root meta → 进程退出、`meta.name` 更新为 fixture 标题；②问候：config 带 `pollIntervalMs: 50`、session 文件预置问候+实质消息 → 退出、`meta.name` 更新为实质消息标题；③`off`（board 与 legacy 各一）→ 退出且 `meta.name` 不变、无模型调用 |
| A7 | static/build | 自动化验证（static + build） | `npm run typecheck`；PR 前 `npm run verify`（worktree 内，node_modules 软链主 checkout） | typecheck 0 错误；verify 全绿且 coverage 阈值（lines 85 / funcs 80 / branches 70）达标 |
| A8 | full-suite regression | 自动化验证（integration） | `npm test` | 全绿 |
| U1 | real dispatch on deployed code | 用户实测（部署前置见下） | ①新会话首条发 `hello`，再发一条实任务消息，**从实任务消息发送时刻起约 30 秒内**（下一次轮询 tick ≤15s + 一次 one-shot ≤15s + 余量）标题更新为实任务标题；②对照：首条即实任务的会话标题照旧即时生成；③`hello` → 手动改名 → 发实任务 → 等待 ≥ 轮询间隔 + 一次 one-shot 窗口 → 手动名保持；④`hello` 后 5 分钟内不发实任务 → 行名保持 slug | ①–④ 全部符合观察预期 |

**U1 部署前置（必须先完成，否则在旧代码上验收）**：运行中的 Pi 通过扩展加载路径的 `import.meta.url` 解析 `TITLE_RUNNER_SCRIPT`（`src/index.ts:21`）——①对 Pi **当前实际加载**的 checkout（本机为 `~/.pi/agent/git/github.com/zhuxixi/pi-agent-board`，以 `pi` 会话内实际加载路径为准）执行 `git pull --ff-only` 并记录部署 SHA（PR 合并后）；②完全退出并重启 Pi（dashboard/board 会话全部重开）；③**title-model 专项检查**（VERIFY.md §2 的 one-shot 只验证默认模型，验不了 title-runner 实际使用的模型）：用与本次部署相同的 title settings 显式跑一次 one-shot——`pi --mode json -p --no-session --model <resolved-title-model> [--thinking <resolved-thinking>] 'Reply with: ok'`（`<resolved-title-model>` 按 `resolveTitleSettings` 的优先级解析，未配置时为 `openai-codex/gpt-5.5`；thinking 为 off 时省略该参数）；**健康判定与 VERIFY.md §2 对齐：进程退出码 0、出现 assistant 的 `message_end`、随后 `agent_end`、无认证错误**（可进一步确认回复包含 `ok`）；④再执行①–④ 实测并回填结果。

**U1 rationale**: the poll window and one-shot model call involve a real detached runner + real title model on the user's machine; deterministic coverage of the same logic is achieved by A4/A6 with injected deps and hermetic fixtures, so U1 verifies deployment reality (spawn path, session-file timing, env resolution in a real process) rather than logic. **可执行时机**：PR 合并部署后（或明确将 `pi install` 指向被测 worktree 后），随时可执行。

## Testability split (design constraint for implementation)

| Unit | Purity | Test boundary |
|------|--------|---------------|
| `isGreetingPrompt` (`src/core/title.mjs`) | pure | direct unit table tests (A1) |
| `resolveTitleSettings` (`src/core/title.mjs`) | pure (env passed as argument) | unit tests with plain objects (A5); nothing reads `process.env` outside the shell |
| `firstSubstantiveUserPrompt` (`src/core/title.mjs`) | pure (imports session-entries) | fixture-JSONL unit tests (A2) |
| `contentText` (`src/core/session-entries.mjs`, moved) | pure | exercised via A2 + existing session-view tests (A3) |
| `runTitleFlow` + constants (`src/core/title-flow.mjs`) | orchestration, **all** I/O injected (`now/sleep/readMeta/commitMeta/readSessionText/runOneShot`) | fake-clock unit tests drive ticks without real timers or spawns (A4); **no re-coupling allowed** — the shell must not regain decision logic, the flow must not read env |
| `runner/title-runner.mjs` shell | I/O only | hermetic spawn smoke via `test-support/fake-title-pi.mjs` + `pollIntervalMs` shrink (A6); real-pi behavior by U1 |

Implementation must keep these boundaries: the classifier, resolver, and projection stay pure; the flow module owns sequencing and guards with every effect injected; the shell only wires real deps.

## Deployment / execution path

- Runner spawn path unchanged: `launchTitle` (`src/core/launch.mjs:97-105`) writes the title config and spawns the detached node script; poll mode only extends the runner's lifetime to ≤ ~5 min 15 s. Nothing in the repo reaps title-runners (sweeper targets warm PTY hosts only, `src/core/warm-host-sweeper.mjs:147-148`).
- Worktree (step 5, model B): branch `issue-295-greeting-title-poll` (≤64 chars, no prefixes); `npm run verify` in the worktree requires `node_modules` symlinked to the main checkout (known ENOENT otherwise — see research notes).
- U1 executes only after the deployed checkout (the one Pi actually loads) is updated and Pi is fully restarted — see the U1 preconditions block.

## Alternatives considered (from the issue plan + research)

- **Skip generation for greetings, keep the slug forever**: trivial but leaves a useless name — rejected (does not satisfy the issue).
- **Re-queue title generation from the `reply()` path in `service.mjs`**: misses messages typed directly inside an attached session; the session JSONL observes every user message — rejected.
- **Revive a retry/backout machinery**: the referenced branch does not exist; would grow scope beyond the runner — rejected for this issue.
- **Let the flow read `process.env` directly**: rejected in round 1 (R1-G3) — breaks the fake-clock unit boundary and duplicates the legacy-alias precedence that already lives in the shell.
