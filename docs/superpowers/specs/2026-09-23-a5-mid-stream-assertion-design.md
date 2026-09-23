# Spec: A5 mid-stream 断言窗口修正（issue #132）

## 根因（issue + 调研双确认，非猜测）

`runner/pty-runner.mjs:342-345`：未处理完 `subscribe_terminal` 的 socket 仍收 legacy 广播行（同形 `{type:"output", seq, data}`）。`test/terminal-snapshot.integration.test.mjs` A5 mid-stream 测试（:241）把 socket B 收到的全部 output（含订阅前 legacy 行）当协议序列统计 → 头部混入一条订阅前行（seq 4）；尾部追平（:227）只等 clientA 进度没等 socket B → 尾部少一条。两端叠加 → 负载敏感 CI 偶红。**不是协议违约**（A 路真实 client 全部断言通过）。

## 设计（单点修正，两处断言加固）

### D1 统计窗口限定（修法一，issue 首选）

`:241` 改为只统计 `snapshot_begin` 之后到达的 output：`messagesB.filter(m => m.type === "output" && m.seq >= endB.nextSeq)`——窗口从 `endB.nextSeq`（快照后第一条协议输出）起，订阅前 legacy 行天然排除（legacy 行 seq 也来自同一条轴，但快照判定前的行 seq ≤ snapshotSeq < nextSeq，全部被过滤掉；注意 issue 样本里那条 seq=4 行 snapshotSeq=4，4 < nextSeq=5 ✓）。

### D2 尾部追平显式化（修法二）

`:227` 的 `waitFor(clientA.getLastSeq() >= readyA.nextSeq + ticks)` 之后，加显式 `waitFor(seqsB_now.length >= ticks)`（socket B 自己收满 ticks 条协议 output），再断言连续。这样尾部缺口消失，不再借 clientA 进度推断 socket B 的追平状态。

### 不变式保留

- 连续性断言形态不变（`seqsB === [nextSeq, nextSeq+1, ...]`——窗口限定后就是纯协议流，严格连续依然正确）
- 至少 ticks 条断言保留（D2 等待保证）
- A 路断言不动（本来全绿）
- 30s 上限（A5 两个用例的 waitFor 天花板）不动——那是 #95 的负载层问题，本 issue 只修断言语义

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 统计窗口限定 | 自动化验证（integration） | `node --test test/terminal-snapshot.integration.test.mjs` | A5 mid-stream 绿；断言语义变更为从 nextSeq 起（代码审查可证） |
| A2 | 尾部显式追平 | 自动化验证（integration） | 同上 | waitFor 显式等 socket B 收满协议条数（代码审查可证） |
| A3 | 负载下不再复现 | 自动化验证（stress） | 并行全量跑 3 轮 `node --test test/*.test.mjs`（高争用条件） | A5 mid-stream 不再出现 "subscriber seqs strictly contiguous, no dup" 失败 |
| A4 | 既有断言语义保留 | 自动化验证（integration） | 全量 | 其余断言不变绿 |

A3 的「3 轮并行全量」是概率验证而非根除证明（flake 本质如此），如实记录。若 3 轮里 A5 mid-stream 仍挂，说明窗口修正漏了路径，须回炉。

## 可测性拆分设计

本工单是测试自身的语义修正，没有新生产代码。可测性 = 断言本身即是测试。改动局限在单个 test case 体内，不动 helper/wireClient/runner。

## 非目标

- 不动 runner 广播逻辑（协议 attach 判定后停写 legacy 行是另一设计决策，可能破坏 legacy 客户端在订阅判定期间看到输出的既有行为——#130 面板提案里相关，不在本 issue）
- 不动 A5 burst 的 30s 上限、不动 subscribe_terminal 15s waitFor（#95 范畴）
- 不动 subscribe/dedup 协议语义
