# Issue #2 Spec：attach 双光标 — jiggle 重试直到见到清屏

## 日期
2026-08-16

## 问题
attach 后出现双光标（PTY 光标块与编辑器假光标失同步），因为 resize jiggle 在冷启动/streaming 场景下失效，重放脏帧未被清屏自愈。

## 根因（已在 issue 中确认）
1. `forceChildRedraw()` 发 jiggle 后无确认/重试机制
2. `forceChildRedrawAfterLiveOutput()` 是 one-shot 补偿，触发后不再触发
3. 冷启动时 SIGWINCH 被丢弃 / streaming 时 jiggle 被渲染节流合并

## 修复方案：jiggle 重试直到见到清屏

### 设计原则：可测性优先
把重试逻辑抽成**纯状态机**（不依赖 socket/xterm/timer），`pty-attach.ts` 只做胶水。这样核心逻辑 100% 可单测，验收标准 = 单测全通过。

### 模块拆分

#### 1. 纯逻辑层：`src/core/pty-attach-jiggle-retry.mjs`

**`createJiggleRetryState()`** — 创建重试状态机，返回一个不可变状态对象 + 操作函数集。

状态机接口（纯函数，无副作用）：
```typescript
interface JiggleRetryState {
  /** 当前重试到第几轮（0 = 未开始） */
  retryIndex: number;
  /** 是否已检测到清屏 */
  clearDetected: boolean;
  /** 是否已停止（见过清屏/超限/手动停止） */
  stopped: boolean;
}

/** 退避间隔表 */
const BACKOFF_MS: readonly number[]; // [120, 500, 1500, 3000]

/** 创建初始状态 */
function createJiggleRetryState(): JiggleRetryState;

/** 处理一段 output 数据，返回新状态 + 是否检测到清屏 */
function feedOutput(state: JiggleRetryState, data: string, carry: string): {
  state: JiggleRetryState;
  carry: string;       // 更新后的跨 chunk carry
  clearFound: boolean;
};

/** 获取下一次重试的延迟（ms），返回 null 表示不再重试 */
function nextRetryDelay(state: JiggleRetryState): number | null;

/** 推进到下一轮重试 */
function advanceRetry(state: JiggleRetryState): JiggleRetryState;

/** 手动停止（attach 安定/close） */
function stopRetry(state: JiggleRetryState): JiggleRetryState;

/** 检测数据中是否包含全清序列 \x1b[2J（处理跨 chunk） */
function hasFullClearSequence(data: string): boolean;
```

#### 2. 胶水层：`src/ui/pty-attach.ts` 变更

新增私有字段：
```typescript
private jiggleRetryState: JiggleRetryState | null = null;
private jiggleRetryTimer: ReturnType<typeof setTimeout> | null = null;
private clearCarry = "";
```

新增私有方法：
```typescript
/** 启动 jiggle 重试链（connect 成功后调用） */
private startJiggleRetry(): void;

/** 处理 socket output 时检测清屏，命中则取消重试 */
private checkClearSequence(data: string): void;

/** 安排下一次重试 */
private scheduleNextJiggle(): void;

/** 取消重试（close 时调用；settle 时故意不取消，见生命周期） */
private cancelJiggleRetry(): void;
```

修改点：
- `connect()` 成功后 → 调 `startJiggleRetry()`
- `onSocketData()` 处理 output 时 → 调 `checkClearSequence(data)`
- `close()` → 调 `cancelJiggleRetry()`
- **移除** `forceChildRedrawAfterLiveOutput()` 和 `forcedRedrawAfterLiveOutput` 字段（被重试链取代）

**设计变更（final review 后，commit 806bf3e）**：`finishAttachTransition()` **不再取消**重试链——settle 取消会让静默冷启动场景下只剩 retry 1 可达（链 ~410ms 就死），正是本 feature 要修的场景。链的自然终止条件：检测到清屏 / 达到 4 次上限 / close()。settle 后的残余 jiggle 只在子端吞掉所有此前 jiggle 时发生（此时画面本就脏），用一次全屏重绘闪烁换自愈是值得的；健康 session 下首个 jiggle 的清屏就会被检测到，链在 settle 前已停。

### 数据流
```
connect() → forceChildRedraw() → 发 jiggle → startJiggleRetry()
                                                    ↓
onSocketData(output) → checkClearSequence(data)     ↓
  ↓                        ↓                        ↓
  ↓                   clearFound? → YES → cancelJiggleRetry()
  ↓                        ↓ NO                     ↓
  ↓                   scheduleNextJiggle() ←────────┘
  ↓                        ↓
  ↓                   setTimeout(BACKOFF_MS[i]) → forceChildRedraw() → advanceRetry()
  ↓                        ↓
  ↓                   (循环直到 clearFound / 超限 / 手动停止)
  ↓
finishAttachTransition() / close() → cancelJiggleRetry()
```

### 测试策略（验收标准）

**文件：`test/pty-attach-jiggle-retry.test.mjs`**

| 测试场景 | 验证点 |
|----------|--------|
| 初始状态 | retryIndex=0, clearDetected=false, stopped=false |
| 输入含完整 `\x1b[2J` | clearFound=true, clearDetected=true |
| 输入含 `\x1b[2J` + 其他数据 | clearFound=true |
| 输入无 `\x1b[2J` | clearFound=false, clearDetected=false |
| 跨 chunk：`\x1b[` + `2J` | 第二次 feed 时 clearFound=true |
| 跨 chunk：`\x1b` + `[2J` | 第二次 feed 时 clearFound=true |
| 部分匹配 `\x1b[3J` | clearFound=false |
| 退避间隔 | nextRetryDelay 依次返回 120/500/1500/3000 |
| 达到上限 | 第 5 次 nextRetryDelay 返回 null |
| 见到清屏后 nextRetryDelay | 返回 null（不再重试） |
| 手动停止后 nextRetryDelay | 返回 null |
| advanceRetry 推进 | retryIndex 递增 |
| stopRetry 后置位 | stopped=true |

### 非目标
- 不改 pi-tui 渲染逻辑
- 不改 screen.log 重放策略
- 不做光标失同步检测加固（issue 优先级 2，后续 follow-up）
- 不改 attach 安定/loading banner 逻辑

### 文件变更
| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/core/pty-attach-jiggle-retry.mjs` | 新增 | 纯逻辑状态机 |
| `src/ui/pty-attach.ts` | 修改 | 集成重试链，移除 one-shot 补偿 |
| `test/pty-attach-jiggle-retry.test.mjs` | 新增 | 状态机全场景测试 |
