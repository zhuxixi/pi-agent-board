[auth] gate=auto · 依据 /home/elling/.github-issue-driven/zhuxixi/pi-agent-board/issue-280/authorization.md

## 修复内容

修复 frame-witness 候选终止消息交付缺陷（协议层）：

### D1：统一终止交付

- evaluator 新增 `collectTerminalDecisions()` 和 `markEmitted(seq)`，用绝对单调序号做消费记账
- reporter 统一 `#drainTerminalDecisions()` 发出 F/A；S 保留 write 内联发出但立即 markEmitted
- 覆盖所有 10 个取消路径：applyIntent、sizeRead、setMode（旧实例）、terminal-start/stop、sentinel dispose、dispose（state 翻转前）、write-failed、finishWrite、#proveOnOperation

### D2：失效撤销

- reporter 新增 `onUnavailable` 回调，marker 失败时触发
- 新增共享 helper `src/core/hosted-frame-witness.mjs`：socket/reporter 所有权、协商、幂等清理、onUnavailable → socket.destroy
- `src/index.ts:startHostedFrameWitness()` 使用共享 helper

### 验收

- A01–A03：单元测试（30/30 通过），含 parser 串联断言
- A04–A05：集成测试（19/19 通过，双 main）
- `npm run verify`：1862 tests, 0 fail

### 实施边界

不改 UI 的 2500ms cap、settle、committed view、重评。不做 renderer/resize/parser 重写。

Closes #280
Parent: #267 路径 A