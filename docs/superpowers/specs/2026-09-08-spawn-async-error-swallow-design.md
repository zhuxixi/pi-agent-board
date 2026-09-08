# issue #86 spec：spawn 异步 error 兜底（spawnDetached 统一封装）

日期：2026-09-08 · 状态：已授权全自动推进（用户 2026-09-08 决策）

## 背景与问题

`launch.mjs` 4 个启动函数与 `pty-attach.ts openExternalTarget()` 的 spawn 均为 `spawn(...)` + `unref()` 无 `'error'` listener。spawn 启动失败走异步 `'error'` 事件，EventEmitter 无 listener 的 error 直接 throw → uncaughtException → 整个 pi 宿主进程退出。实录：WSL2 上一次 node 二进制瞬时 ENOENT 直接带崩 pi（host.json 已正确落 failed，但进程没活下来走重试）。

## 核心设计

### D1：launch.mjs 新增内部 helper `spawnDetached`

```js
function spawnDetached(command, args, cwd) {
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", env: process.env, windowsHide: true });
    child.on("error", () => {});   // 接住异步启动失败；调用方按 pid==null 记 failed，宿主不崩
    child.unref();
    return child;
}
```

`launchRun` / `launchHost` / `launchTitle` / `launchAutoState` 四处收敛到该 helper。helper 不导出（模块内部实现细节，测试通过公开入口行为验证）。

### D2：openExternalTarget 三分支补 error listener

darwin/win32/其他三分支统一为 `const child = spawn(...); child.on("error", () => {}); child.unref();`。fire-and-forget 语义与返回值不变（打开链接是 best-effort，失败静默）。参照同文件 L847-848 xclip 既有正确模式。

## 非目标

- runner/*.mjs 内的 spawn（跑在分离 runner 进程里，崩了不拖垮 pi，issue 已明确排除）；
- 顶层 `process.on("uncaughtException")` 兜底（会掩盖未知错误，不引入）；
- 改变任何返回值/状态机语义。

## 可测性拆分设计

| 单元 | 性质 | 测法 |
|---|---|---|
| spawnDetached 异步 error 兜底 | 副作用隔离（仅 child_process） | integration：注入不存在 node 路径，断言返回 pid:null 且进程存活（uncaughtException listener 不触发；node:test 进程崩=测试天然失败） |
| 4 个公开入口行为不变 | 公开 API | 复用现有 4 测试 + 新增 ENOENT 用例覆盖 launchRun/launchHost/launchTitle/launchAutoState |
| openExternalTarget | UI 层（c8 阈值外，惯例冒烟保护） | 静态验证 error listener 存在；不单加测试 |

## 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | spawn 失败不带崩进程（4 入口） | 自动化（integration） | `node --test test/launch.test.mjs` | 注入 `/nonexistent/node-ENOENT-test` 后各入口正常返回 pid:null，进程存活 |
| A2 | 既有行为回归 | 自动化（integration） | `node --test test/launch.test.mjs` | 原 4 测试全绿 |
| A3 | openExternalTarget error 兜底 | 自动化（static） | 代码审查 + grep 断言 | 三分支均有 error listener |
| A4 | 全量回归 | 自动化（static/build） | `npm test` + `npm run typecheck` | 568+ 全绿、无类型错误 |
| U1 | issue 复现脚本对照 | 自动化替代（A1 等价） | issue 自带复现脚本逻辑已并入 A1 | 见 A1 |

U1 说明：issue 的复现脚本本质是"注入坏 node 路径 + uncaughtException 监听"，A1 测试完全等价覆盖，故不需要独立用户实测。无 U 类纯人工项。

## 风险

极低：纯增量兜底，不改成功路径任何行为；失败路径从"进程崩"变为"走既有 pid==null 记 failed 重试路径"。
