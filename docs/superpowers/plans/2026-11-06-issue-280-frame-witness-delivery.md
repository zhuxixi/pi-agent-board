# Issue #280 — frame-witness 终止交付修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 frame-witness 候选终止消息交付缺陷，消除协议失步根因。

**Architecture:** evaluator 暴露带绝对单调序号的决定日志；reporter 统一 drain F/A，S 保留 write 内联发出但立即 markEmitted。新增共享宿主连接 helper 处理 onUnavailable → socket.destroy。

**Tech Stack:** Node.js ESM, node:test, 现有 pi-agent-board 测试框架。

**Spec:** `/home/elling/.github-issue-driven/zhuxixi/pi-agent-board/issue-280/spec.md` (v3, SHA-256 `d1b3afff8f3739d9b9f9e485dcbd9fa021f1183f5f5d6b2896f01383f4ba085a`)

## Global Constraints

- 不改 UI 的 2500ms cap、settle、committed view、重评
- 不新增 250ms 恢复预算
- 不做 renderer/resize/parser 重写
- 所有编辑路径以 `$WT` 开头：`/home/elling/.pi/agent/worktrees/issue-280-frame-witness-delivery`
- Tabs for indentation, English comments and commit messages
- Conventional commit subjects: `feat`/`fix`/`perf`/`refactor`/`docs`/`test`/`chore`

## Review Focus

1. **重复 marker 发出** — S 内联发出后未 markEmitted，drain 再次发出 → A01/A03 的 parser 串联断言
2. **孤立 A** — 未写出 S 的候选被取消时发送 A → A01/A02 的 #writtenFrames 门控断言
3. **时序丢失** — setMode/dispose 的 drain 在 evaluator 替换/state 翻转之后 → A02 的 resample/mode-change/dispose 断言
4. **跨 write 控制序列截断** — A 插入半个 CSI/OSC 中 → A03 的跨 write 撕裂序列断言
5. **能力假存活** — reporter failed 但 runner 仍 enabled:true → A04/A05 的 onUnavailable→socket.destroy→enabled:false 断言

---

## Task 1: evaluator 消费记账机制

**Files:**
- Modify: `$WT/src/core/attach-frame-proof.mjs` (FrameCandidateEvaluator)
- Test: `$WT/test/attach-frame-proof.test.mjs`

**Interfaces:**
- Produces: `collectTerminalDecisions()` → `Array<{seq, kind, frameId, reason?, ...}>`, `markEmitted(seq)` → void
- Consumes: 现有 `decisions` getter、`#push()` 内部方法

- [ ] **Step 1: 写失败测试**

```javascript
test("collectTerminalDecisions returns decisions after lastCollectedSeq", () => {
	const e = new FrameCandidateEvaluator({ mode: "fullscreen" });
	// Trigger a size pair to create a candidate
	e.sizeRead("columns", 80);
	e.sizeRead("rows", 24);
	const decisions = e.collectTerminalDecisions();
	assert(decisions.length > 0);
	assert(decisions.every(d => typeof d.seq === "number"));
	// Second collect returns empty (already collected)
	assert.deepEqual(e.collectTerminalDecisions(), []);
});

test("markEmitted prevents re-collection", () => {
	const e = new FrameCandidateEvaluator({ mode: "fullscreen" });
	e.sizeRead("columns", 80);
	e.sizeRead("rows", 24);
	const decisions = e.collectTerminalDecisions();
	const firstSeq = decisions[0].seq;
	e.markEmitted(firstSeq);
	// Even if we collect again, the marked decision is excluded
	const again = e.collectTerminalDecisions();
	assert(!again.some(d => d.seq === firstSeq));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd $WT && node --test test/attach-frame-proof.test.mjs -v`
Expected: FAIL — `collectTerminalDecisions is not a function`

- [ ] **Step 3: 实现 evaluator 消费记账**

在 `FrameCandidateEvaluator` 中新增：
```javascript
#lastCollectedSeq = 0;
#nextSeq = 0;

#push(decision) {
  // 现有逻辑 + 分配绝对单调序号
  decision.seq = ++this.#nextSeq;
  this.#decisions.push(decision);
  // ... existing MAX_DECISION_LOG splice ...
}

collectTerminalDecisions() {
  const result = this.#decisions.filter(d => d.seq > this.#lastCollectedSeq);
  if (result.length > 0) {
    this.#lastCollectedSeq = Math.max(...result.map(d => d.seq));
  }
  return result;
}

markEmitted(seq) {
  // 标记为已消费：从 decisions 中移除或标记为已发出
  const idx = this.#decisions.findIndex(d => d.seq === seq);
  if (idx >= 0) this.#decisions[idx].emitted = true;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd $WT && node --test test/attach-frame-proof.test.mjs -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd $WT && git add src/core/attach-frame-proof.mjs test/attach-frame-proof.test.mjs
git commit -m "feat: add collectTerminalDecisions and markEmitted to evaluator (#280)"
```

---

## Task 2: reporter 统一 drain 路径

**Files:**
- Modify: `$WT/src/core/attach-frame-reporter.mjs` (AttachFrameReporter)
- Test: `$WT/test/attach-frame-reporter.test.mjs`

**Interfaces:**
- Consumes: `evaluator.collectTerminalDecisions()`, `evaluator.markEmitted(seq)`
- Produces: `#drainTerminalDecisions()`, `#writtenFrames` Set

- [ ] **Step 1: 写失败测试**

```javascript
test("drainTerminalDecisions emits A for written frames only", () => {
	const { reporter, terminal, written, renderPass } = enabledReporter();
	renderPass(); // opens candidate
	terminal.write(FULL); // writes S + F inline, S is marked emitted
	// Now trigger an abort via applyIntent
	reporter.applyIntent({ type: "frame_witness_intent", instanceId: "test", requestId: "fw-1", geometryRevision: 1, cols: 80, rows: 24 });
	// The old candidate should be aborted and A emitted via drain
	const markers = written.map(decodeFrameMarker).filter(Boolean);
	assert(markers.some(m => m.kind === "A"));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd $WT && node --test test/attach-frame-reporter.test.mjs -v`
Expected: FAIL — A not emitted after applyIntent

- [ ] **Step 3: 实现 reporter drain**

在 `AttachFrameReporter` 中新增：
```javascript
#writtenFrames = new Set(); // frameId where S was successfully written

#drainTerminalDecisions() {
  const decisions = this.#evaluator.collectTerminalDecisions();
  for (const decision of decisions) {
    if (decision.kind === "S") {
      throw new Error("S decision in drain: programming error");
    } else if (decision.kind === "F") {
      this.#emitF(decision);
    } else if (decision.kind === "A") {
      if (this.#writtenFrames.has(decision.frameId)) {
        this.#emitA(decision.frameId, decision.reason);
      }
    }
  }
}
```

修改 `#emitS`：成功写出后调用 `this.#evaluator.markEmitted(decision.seq)` 并 `this.#writtenFrames.add(frameId)`。

修改 `write-failed` 路径：不再内联 `#emitA`，改为只记录决定，由 drain 发出。

修改 `finishWrite` 路径：不再内联 `#emitF`/`#emitA`，改为只记录决定，由 drain 发出。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd $WT && node --test test/attach-frame-reporter.test.mjs -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd $WT && git add src/core/attach-frame-reporter.mjs test/attach-frame-reporter.test.mjs
git commit -m "feat: unify F/A delivery through drainTerminalDecisions (#280)"
```

---

## Task 3: 覆盖所有取消路径

**Files:**
- Modify: `$WT/src/core/attach-frame-reporter.mjs` (applyIntent, sizeRead, setMode, terminal-start/stop, sentinel dispose, dispose)
- Test: `$WT/test/attach-frame-reporter.test.mjs`

**Interfaces:**
- Consumes: `#drainTerminalDecisions()`
- Produces: 所有取消路径都调用 drain

- [ ] **Step 1: 写失败测试**

```javascript
test("sizeRead resample aborts previous candidate via drain", () => {
	const { reporter, terminal, written, renderPass } = enabledReporter();
	renderPass();
	terminal.write(FULL);
	// Trigger resample via size read
	terminal.columns; // triggers sizeRead
	terminal.rows;    // triggers sizeRead -> resample abort
	// New candidate opens
	renderPass();
	terminal.write(FULL);
	const markers = written.map(decodeFrameMarker).filter(Boolean);
	// Should have S(1), A(1), S(2), F(2) in order
	const kinds = markers.map(m => m.kind);
	assert.deepEqual(kinds, ["S", "F", "A", "S", "F"]);
});

test("setMode mode-changed aborts via drain before evaluator replacement", () => {
	const { reporter, terminal, written, renderPass, tui } = enabledReporter();
	renderPass();
	terminal.write(FULL);
	// Change mode via sentinel
	tui.mode = "regular";
	renderPass(); // triggers setMode
	const markers = written.map(decodeFrameMarker).filter(Boolean);
	assert(markers.some(m => m.kind === "A" && m.reason === "mode-changed"));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd $WT && node --test test/attach-frame-reporter.test.mjs -v`
Expected: FAIL — A not emitted for resample/mode-change

- [ ] **Step 3: 在所有取消路径调用 drain**

修改以下方法，在适当位置调用 `#drainTerminalDecisions()`：

1. `applyIntent()` — 在 `setIntent()` 后调用
2. `sizeRead()` — 在 size pair 完成后调用（通过 getter 或显式调用）
3. `setMode()` — 在替换 evaluator **之前**对旧实例调用 drain
4. `terminal-start`/`terminal-stop` wrapper — 在 `abort()` 后、恢复原方法前调用
5. `sentinel dispose()` — 在 `abort()` 后、恢复 shadows 前调用
6. `dispose()` — 在 `stop()` 后、state 翻为 disposed **之前**调用

- [ ] **Step 4: 运行测试确认通过**

Run: `cd $WT && node --test test/attach-frame-reporter.test.mjs -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd $WT && git add src/core/attach-frame-reporter.mjs test/attach-frame-reporter.test.mjs
git commit -m "fix: cover all cancellation paths with drainTerminalDecisions (#280)"
```

---

## Task 4: onUnavailable 失效撤销

**Files:**
- Modify: `$WT/src/core/attach-frame-reporter.mjs` (constructor, #failCapability)
- Create: `$WT/src/core/hosted-frame-witness.mjs` (shared helper)
- Modify: `$WT/src/index.ts` (startHostedFrameWitness)
- Test: `$WT/test/attach-frame-reporter.test.mjs`

**Interfaces:**
- Consumes: `#drainTerminalDecisions()`
- Produces: `onUnavailable` 回调、共享 helper

- [ ] **Step 1: 写失败测试**

```javascript
test("onUnavailable is called on marker failure", () => {
	const onUnavailable = mock.fn();
	const { reporter, terminal, written, renderPass } = enabledReporter({ onUnavailable });
	renderPass();
	// Trigger marker failure
	terminal.write(FULL); // this will fail on marker write
	assert.equal(reporter.state, "failed");
	assert.equal(onUnavailable.mock.calls.length, 1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd $WT && node --test test/attach-frame-reporter.test.mjs -v`
Expected: FAIL — onUnavailable not called

- [ ] **Step 3: 实现 onUnavailable**

修改 `AttachFrameReporter` constructor：
```javascript
constructor({ ui, send, mode, sessionEpoch, onUnavailable = () => {}, ... }) {
  // ...
  this.#onUnavailable = onUnavailable;
}
```

修改 `#failCapability`：
```javascript
#failCapability(reason) {
  this.#state = "failed";
  this.#onUnavailable(reason);
}
```

创建 `$WT/src/core/hosted-frame-witness.mjs`：
```javascript
// Shared helper for hosted frame witness socket/reporter management
export function createHostedFrameWitness({ ctx, root, hostedViewId, hostedSessionEpoch, onUnavailable }) {
  // socket/reporter 所有权、协商、幂等清理、onUnavailable → socket.destroy 绑定
  // ...
}
```

修改 `src/index.ts:startHostedFrameWitness()` 使用共享 helper。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd $WT && node --test test/attach-frame-reporter.test.mjs -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd $WT && git add src/core/attach-frame-reporter.mjs src/core/hosted-frame-witness.mjs src/index.ts test/attach-frame-reporter.test.mjs
git commit -m "feat: add onUnavailable callback and shared hosted-frame-witness helper (#280)"
```

---

## Task 5: A04/A05 集成测试

**Files:**
- Create: `$WT/test-support/attach-frame-failure-child.mjs`
- Modify: `$WT/test/attach-frame-witness.integration.test.mjs`

**Interfaces:**
- Consumes: 共享 helper、真实 runner harness
- Produces: A04/A05 验收

- [ ] **Step 1: 写失败测试**

在 `test/attach-frame-witness.integration.test.mjs` 中新增：
```javascript
test("internal marker failure revokes capability via onUnavailable", async (t) => {
  // 使用现有 harness，加载 attach-frame-failure-child.mjs
  // 验证：marker 失败 → onUnavailable → socket.destroy → runner enabled=false
  // 两种 main 都要跑
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd $WT && node --test test/attach-frame-witness.integration.test.mjs -v`
Expected: FAIL — new test fails

- [ ] **Step 3: 创建 child fixture**

创建 `$WT/test-support/attach-frame-failure-child.mjs`：
```javascript
// 真实 child 中使用共享 helper 和 FakeTerminal
// 注入 marker 写入失败，验证 onUnavailable → socket.destroy → runner cleanup
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd $WT && node --test test/attach-frame-witness.integration.test.mjs -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd $WT && git add test-support/attach-frame-failure-child.mjs test/attach-frame-witness.integration.test.mjs
git commit -m "test: add integration tests for internal failure revocation (#280)"
```

---

## Task 6: 全套验收

**Files:**
- 所有修改文件

- [ ] **Step 1: 运行定向测试**

```bash
cd $WT && node --test test/attach-frame-proof.test.mjs test/attach-frame-reporter.test.mjs test/attach-frame-stream.test.mjs
cd $WT && node --test test/attach-frame-witness.integration.test.mjs
```

- [ ] **Step 2: 运行全套验证**

```bash
cd $WT && npm run verify
```

- [ ] **Step 3: 确认全部通过**

Expected: typecheck、perf gate、tests、coverage、pack:dry 全部通过

- [ ] **Step 4: 本地 CR**

使用 `requesting-code-review` 或 `workflow` 的 `code-review` 模式做本地快速 CR。

- [ ] **Step 5: 最终 commit**

```bash
cd $WT && git add -A
git commit -m "fix: frame-witness candidate termination delivery (#280)"
```

---

## 验收追踪

| Spec ID | 实施 Task | 验证方式 |
|---------|----------|----------|
| A01 | Task 1, 2, 3 | 单元测试 + parser 串联 |
| A02 | Task 3 | 单元测试（stop/rearm/dispose/resample/mode-change） |
| A03 | Task 2, 3 | 单元测试（跨 write、重入、原 write throw） |
| A04 | Task 4, 5 | 集成测试（真实 runner + child fixture） |
| A05 | Task 4, 5 | 集成测试（重复清理、split marker） |

## 与 #267 的关系

本计划是 #267 路径 A 的实施。完整设计见 #267 spec v4；本计划只实施 D1/D2（A01–A05），UI 改动留待后续 issue。
