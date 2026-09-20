# Plan: Control Command Lifecycle (issue #91 Phase 5, D4)

Spec: `docs/superpowers/specs/2026-09-09-harden-runner-architecture-design.md` (§ D4 command table, §7 协议快照, §9 control-protocol layer, §10 非幂等 input 故障窗口, acceptance A1/A2)
Parent issue: #91 (do NOT close)

## Goal

控制 socket 升级为带生命周期的 ack 协议：命令信封（`commandId`/`clientId`/连接内 `seq`/`viewId`/`instanceId`）、三阶段 ack（`accepted`/`applied`/`observed`，外加终态 `superseded`）、按命令类型的交付语义表、reconcile 基线建立、generation token（顺带结构性修复 Phase 4 账本的 epoch 歧义）。旧客户端（无信封）走现有路径零回归。

## Non-goals

- 删 `childInputLooksEmpty()`（Phase 6）
- legacy attach 路径清理（Phase 6+）
- D6 Windows JSON-runner

## Ground truth (verified)

- ownedMain 已有：`input` + `requestId` → dedup 表（FIFO cap）→ `child.write` → `input_ack`（accepted/applied 合一）；无 requestId 的键盘输入 fire-and-forget（spec 认可，保持）。
- UI 控制命令（resize/interrupt/terminate/detach）无信封无 ack；resize 有 clampInt + model 配对 + cachedResize（child 未就绪时缓存）。
- `hello` 已带 `status: host`（instanceId 在 host 里）；`snapshot_begin` 带 cols/rows/frameVersion；无 generation、无 reconcile。
- service durable follow-up：`sendHostInput(socketPath, data, {requestId: item.id})`，重试幂等靠 runner dedup；host 重启后新实例没见过 requestId（service 注释已述）——但没有 accepted/applied 区分，重启后「已 accepted 结果未知」的命令语义未定义（§10 窗口）。
- coordinator 的 materializedRevision 戳在 state.json（runner 可只读）。

## Architecture (per spec §9 control-protocol layer split)

```
src/core/control-protocol.mjs       # NEW: pure decision layer — envelope validate/encode,
                                    #   ack classification, retryPolicy, resize latest-wins tracker,
                                    #   command-type semantics table
runner/pty-runner.mjs               # envelope handling + staged acks + durable journal +
                                    #   reconcile + generation token (both mains)
src/core/terminal-attach-client.mjs # reconnect order + generation epoch detection (consumer)
src/runtime/service.mjs             # durable follow-up: commandId + staged acks + reconcile-then-retry
```

### Envelope & acks

- Envelope: `{commandId, clientId, seq, viewId, instanceId, type, ...payload}`. Runner accepts commands WITHOUT envelope verbatim (legacy path, zero behavior change).
- `seq`: per-connection monotonic; runner validates and drops out-of-order with a diagnostic (ordering aid, NOT dedup — dedup is `commandId` only, per spec).
- Staged acks as separate messages `{type:"cmd_ack", commandId, stage: "accepted"|"applied"|"observed"|"superseded", ...}`:
  - `accepted`: durable commands only (follow-up input), after journal append.
  - `applied`: action executed; carries actual applied value (resize: real cols/rows post-clamp; terminate: "started"; detach: "accepted"; interrupt/keystroke: no ack needed for fire-and-forget? — spec says transient commands get commandId for ack correlation: emit `applied` for resize/interrupt/terminate/detach).
  - `observed`: structured evidence only — terminate on child exit confirmation. `resize` NEVER observed ("不能伪称 child 已完成渲染").
  - `superseded`: resize latest-wins — a newer resize (same client) supersedes un-applied older ones; carries `byCommandId`.

### Per-type semantics (spec table, binding)

| type | retry/dedup | notes |
|---|---|---|
| input durable (requestId/commandId) | accepted(journaled)→applied(written); re-send same commandId returns cached final stage | journal resolves §10 window |
| input keystroke | never retry after disconnect | fire-and-forget stays |
| resize | same commandId → cached result; newer size supersedes older un-applied | applied returns REAL PTY dims |
| terminate | idempotent; observed on exit | repeats return current lifecycle state |
| detach | idempotent | applied on accept |
| reconcile | never retried blind | returns baseline |

### Durable command journal (runner, per host)

- `control-journal.jsonl` in the host's run dir: append `{commandId, command, acceptedAt}` on accept; append `{commandId, appliedAt}` (or result) on apply; GC keep last 256 records.
- Restart: load journal; entries accepted-without-applied are surfaced by reconcile as `{commandId, status: "accepted_unknown"}` and are NEVER auto-replayed (§10 binding rule). The service decides per its own queue semantics.

### Reconcile message

- Client → runner `{type:"reconcile", ...envelope}`. Response `{type:"reconcile_result", generation, hostRevision, terminalCursor: {lastSeq}, stateMaterializedRevision, unresolved: [{commandId, status}]}`.
- `generation` = runner boot UUID (also in hello/status/snapshot_begin). Client-side epoch rule: generation changed ⇒ discard cursor & local buffer assumptions ⇒ fresh snapshot (fixes Phase 4's epoch ambiguity: ring replay can never be mistaken across runner generations).
- `hostRevision` = host `lastSeenAt`/update counter — use an incrementing `revision` field added to host updates (cheap); `stateMaterializedRevision` read from state.json stamp (read-only; absent ⇒ null).
- Reconnect order becomes binding in client: `hello → reconcile → subscribe_terminal → resume retryable commands`.

### Retry discipline (client)

- Timeout on any durable command ⇒ reconcile/query by commandId BEFORE retry (never blind retry).
- UI resize: pending tracker drops on `superseded`; user-initiated resizes always send new commandId (latest-wins).
- Service follow-up: ambiguous on timeout ⇒ reconcile ⇒ if `applied` → done; if `accepted_unknown` (runner restarted) → per queue semantics mark ambiguous, no re-send to new child without explicit policy; if unknown commandId → safe retry (dedup protects).

## Tasks (bite-sized, commit per task)

### Task 1 — control-protocol pure layer (`src/core/control-protocol.mjs` + `test/control-protocol.test.mjs`)
Envelope validate/encode (legacy passthrough detection), ack classification per type table, `retryPolicy`, resize latest-wins tracker (supersede with byCommandId; cached result for same commandId), dedup key rules (commandId only, never seq), journal record shapes + GC policy as pure functions. Unit matrix per spec A1 (test/control-protocol.test.mjs per spec naming).

### Task 2 — runner integration (both mains)
Envelope handling for input/resize/interrupt/terminate/detach (+subscribe_terminal passthrough untouched); staged acks per table; durable journal (accept/applied/GC/restart-load); resize latest-wins + applied-with-real-dims; terminate observed-on-exit; `generation` boot UUID on hello/status/snapshot_begin; `reconcile` message + result. Legacy (no-envelope) path byte-identical. Unit + integration tests (fake socket, journal restart scenarios).

### Task 3 — UI/client integration
Reconnect order hello → reconcile → subscribe (client module); generation epoch rule (discard cursor on change ⇒ fresh snapshot — component e2e: restart with generation change beats ring-replay ambiguity); UI control commands carry envelope (commandId/clientId/seq); resize superseded tracking; terminate observed wiring (exit handling unchanged behaviorally).

### Task 4 — durable follow-up staged flow (service side)
`sendHostInput` → commandId + expect accepted→applied; timeout ⇒ reconcile-query ⇒ policy (applied/accepted_unknown/unknown); runner-restart fault-window e2e: accepted-then-kill ⇒ new runner reconcile shows accepted_unknown ⇒ service does NOT re-send to new child (assert no double-write; item marked ambiguous per existing queue handling). Existing requestId flow stays as the legacy envelope-less mode.

### Task 5 — A2 integration + acceptance sweep
`test/control-reconcile.integration.test.mjs` (spec A2): disconnect → hello → reconcile → snapshot/subscribe → resume retryable; 对账结果/host instance(generation)/terminal cursor 与 runner 一致. Full regression + acceptance table (A1/A2 CLOSED) + residual ledger (journal size bounds, keystroke no-ack rationale, legacy envelope-less coexistence).

## Verification per task

Targeted tests → FULL suite → typecheck → conventional commit (explicit git add). SDD task reviews; whole-branch final review before PR.

## Risks

- **Journal write on the accept hot path**: follow-up inputs are rare (queued prompts), not keystrokes — fs append per durable command is fine; keystrokes NEVER touch the journal.
- **Envelope on keystrokes adds per-key bytes**: tiny (commandId+seq ≈ 60B); keystrokes get NO ack (fire-and-forget preserved) — envelope is correlation-only.
- **Backward compatibility surface**: no-envelope messages must behave byte-identically (old UIs during upgrade window) — pin with compat tests in every task that touches the runner.
- **`instanceId` fencing interplay**: envelope's instanceId must not fight the existing host-ownership fencing — read the #70 fencing code before wiring (Task 2 first step).

## Residual ledger (Phase 5)

Acceptance: A1 CLOSED (test/control-protocol.test.mjs unit matrix — 33 tests); A2 CLOSED (test/control-reconcile.integration.test.mjs — wire-order reconnect, epoch discard, §10 never-rewrite e2e; 3 tests).

- Journal: ≤512 records between rewrites; rare durable commands only; keystrokes never journaled.
- Legacy envelope-less coexistence: byte-pinned compat tests; old runners serve legacy paths only (envelopes fenced with instance_mismatch).
- host_starting retry budget: 5×300ms client-side vs legacy unbounded cachedResize hold (documented parity choice).
- Failed follow-ups (§10 accepted_unknown) surface via error diagnostic + queue item text; no dedicated dashboard affordance (product note).
- envelope_invalid (non-retryable) still re-attempts in the queue loop — legacy shape, diagnostic-only signal.
- TERMINAL_ERROR_CODES includes journal_unavailable for the resize chain — unreachable for resize (never journaled), harmless.
- Boot-banner accept race (banner broadcast before socket accept, no replay): protocol property documented in 2026-08-27 spec; echo-probe test pattern adopted in terminal-snapshot + pty-runner integration files.
- Stray high-water subscribe cursor: the reconcile-gate legacy broadcast overlap is closed client-side; a sub-ms residual window (between subscribe write and runner processing) remains, covered by the client's stray-discard semantics.
