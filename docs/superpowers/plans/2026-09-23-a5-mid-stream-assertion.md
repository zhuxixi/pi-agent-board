# Plan: A5 mid-stream 断言窗口修正（issue #132）

Spec: `docs/superpowers/specs/2026-09-23-a5-mid-stream-assertion-design.md`（commit 5b6ec00）
Base: main 1e832a1

## Task 1: 断言修正 + stress 验证（A1, A2, A3, A4）

**Files:** `test/terminal-snapshot.integration.test.mjs`（唯一，A5 mid-stream test case 体内，不动 helper/其它用例）

**Changes:**
1. **D1（A1）**: `:241` 附近——`seqsB` 构造改为窗口限定：`messagesB.filter((m) => m.type === "output" && m.seq >= endB.nextSeq).map((m) => m.seq)`；断言注释补一句为什么（订阅前 legacy 行 seq ≤ snapshotSeq < nextSeq，被过滤——引用 runner/pty-runner.mjs 广播分支行号）
2. **D2（A2）**: `:227` 的 clientA waitFor 之后，加 `await waitFor(() => messagesB.filter((m) => m.type === "output" && m.seq >= endB.nextSeq).length >= ticks)`——显式等 socket B 追平再断言（30s 天花板沿用文件既有 waitFor 默认）
3. 断言本体不变（严格连续形态保留——窗口限定后就是纯协议流）
4. **A3 stress 验证**：在 worktree 里跑 3 轮并行全量 `node --test test/*.test.mjs`（背靠背，高争用）——记录每轮 A5 mid-stream 结果；**若任何一轮 A5 mid-stream 仍失败且错误为 "strictly contiguous"** → 立即回炉报告，不许带病交付；账本 flake（subscribe_terminal / stop-finalize / A5-burst）照常隔离复跑不算回炉条件
5. **A4**：全量其余断言绿

**Verify:** `node --test test/terminal-snapshot.integration.test.mjs`（定向）+ 3 轮并行全量 + `npm run typecheck`

**Commit:** `test(attach): scope A5 mid-stream seq assertion to post-snapshot window, wait for socket B catch-up explicitly (issue #132)`

## Review 焦点预设

- 窗口下限为什么是 `endB.nextSeq` 而非 `beginB.snapshotSeq + 1`（二者相等，用 nextSeq 更贴近协议游标语义）
- D2 等待的 30s 天花板来源（文件 waitFor 默认），与 A5-burst 的显式 30s 参数区分
- stress 3 轮的统计学诚实度（概率验证非根除证明，报告如实记录）
