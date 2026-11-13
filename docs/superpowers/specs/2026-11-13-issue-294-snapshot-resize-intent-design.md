# Spec: #294 — snapshot-carried target F must satisfy the resize intent

Status: DRAFT (rev 4, post round-3 cross-review; no authorization.md → gate=stepwise: after convergence, PAUSE for user design confirmation before step 5)
Issue: https://github.com/zhuxixi/pi-agent-board/issues/294
Repo baseline: local main `3815dea` at drafting; `750b854` (post-#293 merge) at round-1 review — the delta touches only dashboard selection code, not the attach paths cited here. Implementation re-pins `origin/main` before the worktree and records the SHA. Pi 1.5.1 runtime.
Research artifacts: `~/.github-issue-driven/zhuxixi/pi-agent-board/issue-294/research/` (repro programs + outputs + research-summary.md).

Drafted: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-12T08:57:00+08:00
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-12T09:20:00+08:00 — R1-G1 (ordinary-F0-in-capture shape: intent evidence + gate bypass), R1-G2 (U1 diagnostics criterion rewritten to real event shapes), R1-D1 (repro seq fix + new repro variants), R1-D2 (dropped the false subset claim), R1-D3 (A4 scope + real-Pi skip semantics)
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-12T09:52:00+08:00 — R2-G1 (sticky intent evidence; `invalidateViewProof` stops clearing it; real S0→F0 frame sequences in A2c/repro), R2-G2 (bypass head restricted to ordinary 0/0 + wrong-nonzero negatives), R2-D1 (live aggregation wording = actual lifecycle), R2-D2 (stale-evidence negative moved to A1b unit level), R2-D3 (harness protocolError readout + observable assertions)
Revised: zai-coding-cn/glm-5.3 (selected) · zai-coding-cn/glm-5.3 (physical) @ 2026-11-12T10:18:00+08:00 — R3-G1 (live match reuses the same pure predicate: full validation incl. target dims; live wrong-dims mixed negative added to A3), R3-D1 (harness coverageHead readout summary + protocolError via handleAttachEvent wrapper; A2c head assertions)

## Problem (root cause, verified against source)

A differing-size attach can stay on the loading surface past the 2500 ms cap even when the client already holds a complete committed view at the target geometry, `covered` proof, and a matching target-geometry F **inside `snapshotReady.viewProofRecords`**. Root cause chain, verified on `3815dea` (line numbers from that SHA):

1. A differing resize arms the intent: `noteGeometryIntent` (`src/ui/pty-attach.ts:2523-2553`) sets `resizeIntentRequired = true`, `resizeIntentId = geometryRevision`, `resizeIntentSatisfied = false`.
2. While the attach client is `collecting`, `view_proof` records are buffered into `partial.viewProofRecords` instead of emitted live (`src/core/terminal-attach-client.mjs:708-713`); the runner interleaves queued S/F/A records into the snapshot stream around catch-up chunks (`src/core/terminal-attach-protocol.mjs:163-208`, `flushCaptureViewProofRecords`) — so a target F **does** reach the client inside the snapshot.
3. `snapshotReady` stores those records but unconditionally resets `this.resizeIntentSatisfied = false` (`src/ui/pty-attach.ts:2918`) — it never derives satisfaction from the validated snapshot-carried records.
4. Only the later live-record path updates the flag (`src/ui/pty-attach.ts:2987-2990`) — and `invalidateViewProof` (`:1520-1525`) clears it again on every transient coverage invalidation: a live **S** record (the mandatory start of every real ordinary frame, `noteViewProofRecord(S)` → `invalidateViewProof("candidate-open")`, `:1553`), aborts, trailing-unsafe output, replay gaps. So even a live-delivered target F's satisfaction does not survive the next frame's S marker (R2-G1).
5. The reporter consumes the intent after writing its first matching F and later frames fall back to `intentId=0` (`src/core/attach-frame-reporter.mjs` `#emitF`, `consumeIntentOnce()` → `setIntent(null)`; ordinary post-intent metadata is `intentId: decision.intentId ?? 0, geometryRevision: decision.geometryRevision ?? 0` via `metadataFor`, `src/core/attach-frame-proof.mjs:643-656`).
6. The runner's snapshot coverage head is the *newest* completed proof at or before the snapshot seq (`findNewestProofAtOrBefore`, `src/core/attach-view-proof.mjs:470-476`; `coverageFor` `:599-648`) — a capture window containing the target F **and** a later ordinary frame yields `covered` coverage whose head is the ordinary F0 (`intentId=0, geometryRevision=0`). The full chain then waits `geometry-revision`/`resize-intent` on the head's metadata (`requiredGeometryRevision` mismatch fires first, `src/core/pty-attach-render.mjs:252-257`), and the degraded chain refuses any armed intent. After the cap only the reason prefix changes.

Deterministic component reproductions (virtual clock, real `PtyAttachComponent` + real client messages, no production changes; all three STUCK on main, outputs in `research/`):

- `repro-bug.json` — resnapshot carrying `records=[F(intentId=1, geometryRevision=1, 100x30)]` + `covered/exact-proof` head = that F + committed 100x30 view → waits `resize-intent` → cap expires; legal `output seq=3` + live F0 afterwards does not rescue (coverage becomes `covered/safe-trailing` head F0, still locked).
- `repro-f0-head.json` — records `[F1, F0]` at the same seq (protocol-legal double proof per chunk; the harness's single-frame snapshot model requires `nextSeq = beginSeq + 1` and no flush, per `finishCollecting`, `terminal-attach-client.mjs:556-596`), end coverage head = F0 → same lock (the capture-window shape, step 6).
- `repro-live-f0-after.json` — resnapshot with F1 in records, then the **real ordinary frame sequence** `output seq=3` → live `S0` → live `F0` → coverage `covered/safe-trailing` head F0, satisfaction cleared by the S0 (step 4) → same lock.

Control (live-delivered target F, no subsequent frame before evaluation) settles at once: `readyReason=complete, settledAt=0` (`repro-control.json`).

Archaeology: the unconditional reset was introduced by `936f46e` (PR #265), before the #284 recovery-budget redesign that added the live-only derivation; PR #285 discussion and issues #284/#288 contain no decision that snapshot-carried records must not satisfy the intent — an oversight, not a safeguard.

## Fix design

Three coordinated changes: (1) derive intent satisfaction — and a separately carried **intent-proof seq** — from validated snapshot records; (2) make that evidence **sticky** (immune to transient coverage invalidations, cleared only by a superseding intent or baseline recompute); (3) let the untouched full-view gate accept an *ordinary* later coverage head when the intent evidence is fresh enough. No runner or protocol changes; the reporter is untouched; the degraded chain is untouched.

### 1. Pure predicate (new): `resizeIntentEvidenceFromRecords(intent, records)`

Location: `src/core/pty-attach-render.mjs` (the attach presentation-policy module that already hosts `decideAttachPresentation` and imports `validateFrameMetadata`). Serves **both** evidence sources: the `snapshotReady` recompute (whole records array) and the live-record branch (single-record array) — one matcher, no divergent semantics.

Returns `{ satisfied: boolean, proofSeq: number | null }`:

- `intent.required !== true` → `{ satisfied: true, proofSeq: null }` (vacuous, mirroring the live path's `!this.resizeIntentRequired || …`; no evidence needed).
- Otherwise scan `records` (only when it is an array) and keep the **highest-seq** element satisfying ALL of:
  - non-null object with `marker === "F"`;
  - `Number.isInteger(seq) && seq >= 1`;
  - `validateFrameMetadata(metadata).ok === true` (strict 10-field whitelist, `protocol === 1`);
  - `metadata.value.geometryRevision === intent.geometryRevision`;
  - `metadata.value.intentId === intent.intentId` (component `intentId ≥ 1` by construction, so intent-0 records can never match);
  - `metadata.value.cols === intent.cols && metadata.value.rows === intent.rows` (target-dimension match).
- Any element failing any condition is simply not evidence; empty/absent/malformed records yield `{ satisfied: false, proofSeq: null }` (fail-closed). Highest-seq choice maximizes freshness against the coverage `throughSeq` used below.

The predicate re-validates metadata even though the client already sanitized the records: pure testability without the sanitizer, defense in depth, and no reliance on the caller's slice/cap behavior. Ring-cap drops (`viewProofRecordsDropped`) need no special case: a dropped target F is simply absent.

### 2. Component state: sticky `resizeIntentSatisfied` + `resizeIntentProofSeq`

The pair represents one validated fact — "the armed intent's target frame was proven at seq k" — and its lifecycle is explicit:

| Event | `resizeIntentSatisfied` / `resizeIntentProofSeq` |
| --- | --- |
| `noteGeometryIntent` (differing resize; `:2523-2553`) | cleared to `false` / `null` (a superseding intent invalidates the old fact) |
| `snapshotReady` (`:2918`) | **recomputed** from the accepted baseline's `records` via the predicate (supersedes any prior value — an empty/record-less baseline yields `false`/`null`, fail-closed) |
| live `viewProofRecord` F (`:2987-2990`) | **re-evaluated through the same pure predicate** with the single record — matching means full validation (marker F, integer seq ≥ 1, `validateFrameMetadata`, `geometryRevision`, `intentId`, **and target cols/rows**; single-source matching semantics, no revision/intent-only shortcut). Match → set `true` / that record's `seq` (upgrade); no match → untouched |
| live non-matching F, live S, live A | **untouched** |
| `invalidateViewProof` (`:1520-1525`) | **no longer touches the pair** — its `this.resizeIntentSatisfied = false` line is removed (production behavior change; S/A/trailing-unsafe/replay-gap/`generation-change`/`new-empty-baseline` invalidations are transient coverage facts, not intent facts). Safety: none of those paths can publish anyway — publishing requires `covered` coverage re-established in the current baseline, whose `snapshotReady` recompute or live match re-derives the evidence; `frameState`/`sync-open`/identity gates are untouched |
| capability loss / reporter-replaced | untouched (coverage goes UNKNOWN; the full chain cannot publish without `covered` coverage) |

Snapshot-carried records never pass through `noteViewProofRecord` (they are stored, not processed), so an S inside `records` is inert by construction — the S0 hazard exists only on the live path, which the table above handles.

Wiring changes in `src/ui/pty-attach.ts`: the `snapshotReady` reset line becomes the predicate call (sited exactly at the old reset, **after** the `records-without-coverage` resync guard, whose semantics are unchanged); the live-record branch calls the predicate with `[record]` and sets both fields only on a match (no reassignment on a non-match — a wrong-size live F is not evidence, exactly like a wrong-size snapshot record); `noteGeometryIntent` clears both; `invalidateViewProof` drops its reset line; the publication-facts assembly (≈ `:1680-1684`) passes `resizeIntentProofSeq` alongside `resizeIntentSatisfied`.

### 3. Full-view gate bypass: intent evidence vs an **ordinary** coverage head (R2-G2)

In `fullViewDecision` (`src/core/pty-attach-render.mjs`), the checks that compare the **coverage head's metadata** against the armed intent —

- `metadata.value.geometryRevision !== state.requiredGeometryRevision → wait("geometry-revision")`, and
- (under `resizeIntentRequired`) `metadata.value.intentId !== state.intentId || intentId === 0 → wait("resize-intent")`

— gain one shared alternative, evaluated only when **all** of the following hold (anything else fails closed to the existing waits):

1. `state.resizeIntentRequired === true && state.resizeIntentSatisfied === true`;
2. `Number.isInteger(state.resizeIntentProofSeq)`;
3. `state.resizeIntentProofSeq <= coverage.throughSeq` (the intent proof is inside the covered window — freshness);
4. the coverage head is an **ordinary** frame: structurally valid F with `metadata.value.intentId === 0 && metadata.value.geometryRevision === 0` — the exact metadata shape every post-intent ordinary frame carries (`metadataFor` defaults). A head with **wrong non-zero** revision/intent (e.g. from another intent generation) is NOT ordinary and keeps waiting under the existing checks;
5. the head's frame geometry matches the target: `metadata.value.cols === state.targetCols && metadata.value.rows === state.targetRows` (redundant with the chain's earlier `proof-geometry-mismatch` check, restated so the bypass is self-contained).

Semantics: the armed intent was provably completed by the validated target F (evidence ≤ head); an ordinary later frame at the same target size can only depict the same-or-fresher target-geometry view, and its 0/0 metadata is exactly the post-consumption shape. The wrong-size, stale (`proofSeq > throughSeq`), wrong-non-zero-revision/intent, missing-evidence cases all keep waiting with the existing reasons (gate order: `proof-geometry-mismatch` → `geometry-revision` → `resize-intent`).

Untouched: `degradedViewDecision` (an armed intent still blocks the degraded chain — existing #284 semantics; the full path with evidence covers this issue's shapes), the resync guard, the reporter's intent consumption, the runner protocol, and `noteGeometryIntent`'s arming.

This design covers all three lock shapes above, including the live `S0 → F0` frame sequence after the snapshot (A2c) — the S0 no longer erases the snapshot-derived evidence, and the F0 head is ordinary at target dims.

## Testability split design

| Unit | Kind | Boundary |
| --- | --- | --- |
| `resizeIntentEvidenceFromRecords` | pure function, `src/core/pty-attach-render.mjs` | Unit-tested directly (`test/pty-attach-render.test.mjs`) with literal intents/records — no component, no client, no clock. |
| `fullViewDecision` bypass | pure decision chain, same module | Unit-tested via decision states (`test/pty-attach-render-decision.test.mjs`) — no component. |
| Component lifecycle + wiring | small changes in `PtyAttachComponent` | Driven through the existing real-path harness `test-support/attach-recovery-scenario.ts` (real `onSocketData` protocol lines, real client state machine, virtual clock) in `test/attach-recovery-component.test.mjs`. The harness gains one observability field (see below). |
| Runner / protocol | untouched | Existing suites keep pinning them; `npm run verify` runs the full set (real-Pi suite enumerated but skipped unless `PI23B1_REAL_PI=1` — see A4). |

Harness changes (R2-D3 + R3-D1): `test-support/attach-recovery-scenario.ts` collects attach-client `protocolError` events (via a wrapper on the component's `handleAttachEvent` channel — the same channel the component itself uses, `installSpy`-style; the client exposes no public `on()` seam to rely on) and exposes `protocolErrorCount` + codes in the step readout; the readout additionally gains a bounded `coverageHead` summary (`latestViewProof.proof` → `{ seq, frameId, intentId, geometryRevision, cols, rows }` or `null`), so "the coverage head became that F0" is assertable directly. Both listed in the test impact inventory.

## Acceptance matrix

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1a | 纯谓词判定语义 | 自动化验证（unit） | `node --test test/pty-attach-render.test.mjs` 新增用例：satisfied+proofSeq=最大匹配 seq（匹配 F / required=false / 混合记录含匹配 F）；false+null（仅 S/A、revision 错、intentId 错（0 或异值）、cols/rows 错、metadata 非法（多余字段/protocol≠1/非整数）、seq 非法、空数组、非数组、null 元素） | 全部断言通过 |
| A1b | full 链 bypass 语义 | 自动化验证（unit） | `node --test test/pty-attach-render-decision.test.mjs` 新增 decision-state 用例：放行（satisfied+proofSeq≤throughSeq+头 0/0 目标尺寸）；不放行（无 evidence/未 satisfied → 原 reason；proofSeq>throughSeq → 原头检查 reason；头尺寸错 → proof-geometry-mismatch；**头 wrong-non-zero revision → geometry-revision**；**头 wrong-non-zero intent → resize-intent**——后两条前置有效 F1 证据，钉 R2-G2）；头即目标 F（intent metadata 匹配）走原路径 | 全部断言通过 |
| A2a | 快照携带目标 F、coverage 头即目标 F | 自动化验证（integration，component + 真实 client 消息 + 虚拟时钟） | `node --test test/attach-recovery-component.test.mjs`（= repro-bug 前半形状）：resnapshot 携带匹配 F 记录 + covered/exact-proof(目标 F) + committed 100x30 complete | resnapshot 步后 `attaching=false`、`readyReason=complete`、`settledAt=0`；`advance 2500` 后仍 settled |
| A2b | 快照窗口含目标 F + 普通 F0，coverage 头=F0 | 同上 | records=[F1, F0]（同 seq 双 proof，= repro-f0-head），end coverage=covered 头 F0 | 同 A2a 通过标准（settle complete） |
| A2c | 快照后真实普通帧序列 `output → live S0 → live F0` 覆盖 coverage | 同上 | = repro-live-f0-after：resnapshot(F1 in records) → `output seq=3` → live `S0(seq=3)` → live `F0(seq=3)`；readout 断言 `protocolErrorCount===0` 且 `viewProofRecordCount` 递增；S0 后 `latestViewProof=unknown/candidate-open`，F0 后 `coverageHead={seq:3, intentId:0, geometryRevision:0, cols:100, rows:30}`（R2-D3/R3-D1） | settle complete；protocolErrorCount=0 |
| A3 | 负面语义不放松（集成层） | 同上 | ①records 携带 wrong-dims F / wrong-revision F / wrong-intent F（其余同 A2a）→ 仍锁；②无 evidence 时 live S0→F0 序列 → 仍锁（现行为）；③二次 differing resize 后旧 evidence 失效（noteGeometryIntent 清除）→ 等待新 target F；④**live 混合序列（R3-G1）**：空 records resnapshot → live wrong-dims F1（revision/intent 匹配、cols 错，T8 已证可经真实 client 形成 covered proof）→ output → S0 → 目标尺寸 ordinary F0 → 不发布；⑤随后 live 匹配 F 仍可救活（正对照） | 各自在 250ms 与 2500ms 处仍 `attaching=true`、`notReadyReason` 按门序（resize-intent / geometry-revision / proof-geometry-mismatch → `deadline-expired:*`）；正对照 settle complete |
| A4 | 全量回归门 | 自动化验证（build） | `npm run verify` = typecheck + perf gate + tests + coverage + pack:dry（package.json `verify` 脚本） | exit 0。real-Pi 套件（`test/attach-frame-witness.real.test.mjs`）默认 `test.skip`，不计为证据；如需真实拓扑证据另跑 `PI23B1_REAL_PI=1 node --test test/attach-frame-witness.real.test.mjs` 并记录。已知例外：共享 runner 上 `attach-entry-22` 200ms 墙钟断言慢性 flaky（#95 在案）——本地 verify 必须过；CI 失败仅允许重跑对拍，不得削弱断言 |
| U1 | 真实 differing-size attach 不再卡死 | 用户实测 | 部署前置（合并后）：`git -C ~/.pi/agent/git/github.com/zhuxixi/pi-agent-board restore package-lock.json`（该 checkout 有在案 package-lock 脏改动）→ `git -C … pull --ff-only` → 完全退出并重启 pi → 对一个有输出的后台会话，以与创建时不同的终端尺寸 attach，必要时制造 capture 窗口内连续输出（如让会话正在流式输出时 attach）。回填时记录所检查的 view、budgetDeadline 与部署 SHA（R2-P1） | 内容在 2500ms 内（通常即时）展示。诊断判据（读 `~/.pi/agent/agent-board/views/<view>/diagnostics.jsonl`，按同一 attach 的 budgetDeadline 关联事件）：① 该 attach 存在 `attach_settle_ready` 且 `details.readyReason="complete"`；② 该 attach 无 `attach_wait_expired` `details.phase="cap"` 事件（注意：cap 事件的 `notReadyReason` 恒为 `deadline-expired:waiting-for-complete-frame`，在发送前固定（`pty-attach.ts` `handleAttachHardTimeout`），`resize-intent` 只出现在 `phase="budget"` 事件——**不得**用 cap+resize-intent 筛选，那匹配不到任何事件）；③ `phase="budget"` 且 proof facts 为 covered 的等待必须有同 attach 的后续 settle，否则记失败；④ 同尺寸 re-attach 即时（既有 workaround 路径不回归） |

A1a/A1b/A2/A3 均有直接先例（`pty-attach-render.test.mjs` / `pty-attach-render-decision.test.mjs` 的既有纯用例、T8 geometry-gate 场景），无预期障碍；U1 依赖合并后的部署前置，PR 期间以 A1–A4 为门，U1 在合并后执行并回填结果。

## Non-goals / out of scope

- **No gate weakening for bad proofs**: wrong-size / wrong-revision / wrong-intent evidence, stale evidence (`proofSeq > throughSeq`), wrong-**non-zero**-revision/intent coverage heads even when valid evidence exists, empty baselines, unfinished frames keep waiting exactly as today (A1b/A3 pin these). The bypass admits exactly one new fact: validated intent evidence *inside the covered window* plus an **ordinary (0/0)** coverage head at target dims.
- No changes to the degraded chain (armed intent still blocks it), the reporter's intent consumption, the resync guard, the runner protocol, or `noteGeometryIntent`'s arming.
- The sticky-evidence lifecycle deliberately does NOT cover: evidence surviving across `epochReset` semantics beyond what the current baseline recompute provides (an epoch reset nulls the committed view and the next accepted snapshot recomputes the evidence — no extra handling).
- Main-branch CI flakiness (#95, `attach-entry-22` wall-clock budget on shared runners) is tracked separately and explicitly not addressed here.

## Risks / guarantees

- **Guarantee (single-source matcher)**: both evidence sources — snapshot records and live records — go through the **same pure predicate** with identical per-record validation (marker, seq, strict metadata whitelist, revision, intent, target dims); no revision/intent-only shortcut exists anywhere. **Aggregation semantics (actual, R2-D1)**: snapshot derivation is per-baseline existential (highest-seq match, recomputed at each accepted `snapshotReady`); live derivation is set-on-match / untouched-otherwise; both share the sticky lifecycle table above. No subset/equivalence relation between paths is claimed — publication safety rests on the untouched coverage/identity/seq/frameState gates plus the bypass's own conditions (evidence freshness `proofSeq ≤ throughSeq`, ordinary 0/0 head, target dims). No missing, stale, wrong-size, wrong-non-zero-revision or wrong-intent proof can publish (A3④ pins the live wrong-size mixed sequence).
- Behavior change surface: `invalidateViewProof` no longer clears `resizeIntentSatisfied` (sticky evidence). This is intentional and pinned by A2c (S0 must not erase snapshot-derived evidence) and A3② (without evidence, S0/F0 still waits as today). The existing suites that pin `invalidateViewProof`'s coverage effects are untouched.
- This area has a revert history (#263): the production diff stays minimal — one pure predicate, gate-bypass logic in the pure decision module, four small component touches (reset line, live-record branch, `invalidateViewProof` reset removal, facts assembly), one harness observability field, tests.
- Coverage thresholds (`npm run verify`) apply unchanged.

## Test impact inventory

- `src/core/pty-attach-render.mjs` — add `resizeIntentEvidenceFromRecords`; extend `fullViewDecision` with the shared intent-evidence alternative (ordinary-head restricted).
- `src/ui/pty-attach.ts` — replace the `snapshotReady` reset line with the predicate call; the live-record branch calls the predicate with `[record]`; clear both in `noteGeometryIntent`; remove the reset line from `invalidateViewProof`; pass the field in the facts assembly.
- `test-support/attach-recovery-scenario.ts` — collect attach-client `protocolError` events (handleAttachEvent wrapper) into the readout (`protocolErrorCount`); add the bounded `coverageHead` summary to the readout.
- `test/pty-attach-render.test.mjs` — A1a.
- `test/pty-attach-render-decision.test.mjs` — A1b (incl. wrong-non-zero head negatives).
- `test/attach-recovery-component.test.mjs` — A2a/A2b/A2c/A3.
