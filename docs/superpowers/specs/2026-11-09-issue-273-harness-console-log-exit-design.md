# spec — issue #273：六个 harness 用 `console.log` 打 JSON 结果后立刻 `process.exit`

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-09T08:51:35+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-09T08:58:04+08:00 — cross-review R1（真缺口 1 / 细化 2）：R1-G1 接受（A3 拆成「driver 成功/失败退出码」与「孤儿 harness smoke 两条退出码」，不再把无消费方夹具计入「消费方已验证」）；R1-D1 接受（whitespace-only 也视为 unset，A5 样本补齐）；R1-D2 接受（D5 改为只同步 helper 的注释，不改运行时代码）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-09T09:04:38+08:00 — cross-review R2（真缺口 0 / 细化 3，收敛）：R2-D1 接受（A4 命令写死 `test/scenario-stdout-flush.test.mjs`，注明 `--experimental-transform-types` 启动与 5 秒 spawn 超时）；R2-D2 接受（A3/A4/A5 补「原始 stdout 以换行结尾」断言，六类调用点各覆盖一次）；R2-D3 接受（「纯函数」表述收窄为「不直接读 `process.env`/`process.cwd`，非空相对值沿用 `path.resolve` 的 cwd 语义」，A7 增加相对值样本）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-09T10:27:00+08:00 — Zima CR round-1 advisory accepted（advisory，低）：settled 运行钉住 4 秒 harness 预算 `HARNESS_TIMEOUT_MS: "4000"`，使 harness 自身超时总是先于 5 秒 spawn kill 触发（kill 层级：4 秒 < 5 秒 < harness 默认 8 秒），避免高负载 CI 下正常收尾的默认运行被 spawn 超时拆掉进程、`status` 变 `null` 令断言读起来误导；§3.5 与 A4 同步

基线：`origin/main @ 608a22a`。调研：`research/01-reproduction-and-inventory.md`、
`research/02-predicate-boundary-and-scope.md`。本 issue 走 bug 路由，第 1 节即根因报告。

## 1. 现象与根因

六个 `test-support` 夹具把结果 JSON 打到 stdout 后，下一行立即 `process.exit`：

```ts
console.log(JSON.stringify(result));
process.exit(result.settledMs !== null && result.showsContent ? 0 : 1);
```

`console.log` 与 `process.stdout.write` 是同一个 `process.stdout`：参数被拼成一个字符串、
追加 `\n`、再调用一次 `stream.write`。stdout 接管道时写入是异步的，超过内核管道缓冲
（Linux 64 KiB）的部分留在用户态队列，`process.exit` 在队列排空前拆掉进程，读端只能拿到
前 64 KiB，而退出码仍是 0。父进程随后 `JSON.parse` 抛 `Unterminated string`。

确定性复现与三组对照（research/01 §1）：200 KB 的 `console.log` + `exit` 在慢读端下输出
65536 字节；1 KB 输出 1025 字节（完整）；`exitAfterStdout` 输出 200001 字节（完整）。

当前六个 payload 都远小于 64 KiB，所以是**潜伏缺陷**而非现行故障；payload 长大或 runner
变慢即复现，与 #270 的 s15 battery 完全同构。

#270 的修复（`test-support/stdout-flush.mjs` 的 `exitAfterStdout`）已在 22 个文件落地，
本 issue 处理同形态的最后六个漏网点，并把守卫的检测谓词从「只认 `process.stdout.write`」
放宽到「也认 `console.log` / `console.info`」——#270 的 spec §3.4 与守卫自测至今把这六处
当作合法样本，是门禁缺口的一半。

## 2. 设计决策表

| # | 决策 | 依据 / 取舍 |
|---|---|---|
| D1 | 六处统一改为 `exitAfterStdout(<同 text>, <同 code>)`，text 为 `JSON.stringify(result) + "\n"` | `console.log` 自带换行，转换必须补 `\n`；写什么、退出码表达式逐字不变 |
| D2 | 守卫谓词扩展为 `process.stdout.write(...)` **或** `console.log/info(...)` 的表达式语句 | 两者写同一个 `process.stdout`，语义等价而非近似（research/02 §1） |
| D3 | 守卫的配对规则（相邻语句、`if`/block 递归、兄弟 `if` 跳过）一字不改 | 放宽的只是「什么算写 stdout」，不是「什么算排空后退出」；新增分支会引入新的误报面 |
| D4 | 守卫自测把 `console.log` 紧邻 `exit` 从 `accepted` 移到 `violations`，并补 `console.info`（违例）与 `console.error`（合法）两条样本 | 自测是谓词的唯一规格；不同步迁移会让放宽后的守卫「永远通过」，等于没写 |
| D5 | 不修改 `test-support/stdout-flush.mjs` 的运行时代码；只同步它第 10-15 行的守卫范围注释 | 注释现写「只有 `process.stdout.write` 被守卫」，D2 之后必然过时；运行语义不变由 A6 的 256 KiB probe 继续证明 |
| D6 | 纳入 `FORMAL_BASELINE_REPO` 空串/纯空白防御，做成 `resolveBaselineRepo(envValue, repo)`：不直接读 `process.env`/`process.cwd`，非空相对值沿用 `path.resolve` 的 cwd 语义 | 承接 #270 收尾评论，并覆盖 PR #274 round-1 review 原话「empty (or whitespace-only)」；`resolve("")` 静默指向 cwd 会把候选仓自身当 baseline 算哈希 |
| D7 | `console.debug`、stderr 的 `console.error`、别名写法（`const log = console.log`）不覆盖 | issue 指定范围只有 `log`/`info`；stderr 是 #270 D8 的同类取舍；别名与 `const out = process.stdout` 同族，属守卫固有盲区 |
| D8 | 不为 `attach-idle-candidate-open-harness.mjs` 新增语义消费方；只在守卫测试里加一条成功/超时两路的退出码 smoke | 它是手工 A/B 夹具，孤儿归属 #211；但「无消费方」不能成为「退出码语义不验收」的理由（R1-G1） |
| D9 | 测试落点复用现有 `test/scenario-stdout-flush.test.mjs` 与 `test/formal-runner-plan.test.mjs`，不新建测试文件 | 守卫与纯函数同族，新建文件只会多一份 import 与 CI 时间 |

## 3. 代码落点

### 3.1 六个调用点

每个文件在现有相对导入区加入 `import { exitAfterStdout } from "./stdout-flush.mjs";`
（`.mjs` 夹具用同一行；`moduleResolution: NodeNext` 下已有多处先例，如
`pty-attach-external-editor-scenario.ts:7`）。

| 文件 | 现状 | 替换后 |
|---|---|---|
| `pty-attach-frame-overflow-scenario.ts:378-379` | `console.log(...); process.exit(0);` | `exitAfterStdout(JSON.stringify(result) + "\n", 0);` |
| `pty-attach-mouse-mode-scenario.ts:94-95` | 同上 | 同上 |
| `pty-attach-wheel-scenario.ts:187-188` | 同上 | 同上 |
| `pty-attach-selection-mirror-scenario.ts:260-261` | 同上 | 同上 |
| `attach-idle-socket-driver.ts:221-222` | 退出码含判定表达式 | `exitAfterStdout(JSON.stringify(result) + "\n", result.settledMs !== null && result.showsContent ? 0 : 1);` |
| `attach-idle-candidate-open-harness.mjs:75-76` | 同上 | 同上 |

语义保持：写的内容（`JSON.stringify(result)` 加一个换行）、退出码表达式、进程退出时机
（排空后）都与原实现一致，唯一变化是 `exit` 等写回调。

两个带条件退出码的夹具（`attach-idle-socket-driver.ts`、`attach-idle-candidate-open-harness.mjs`）
额外补退出码验收，因为它们正是「换成常量 0 也能全绿」的盲区（R1-G1）：前者在
`test/attach-frame-witness.integration.test.mjs` 的成功用例（`spawnSync` 的 `status`）与
hard-invalid 用例（`driver.exitCode`）各加一条断言；后者在守卫测试里加成功/超时两路 smoke。

### 3.2 守卫谓词（`test/scenario-stdout-flush.test.mjs`）

```ts
const CONSOLE_STDOUT_METHODS = new Set(["log", "info"]);
const isConsoleIdentifier = (node) => ts.isIdentifier(node) && node.text === "console";
const writesConsole = (statement) =>
	ts.isExpressionStatement(statement) &&
	ts.isCallExpression(statement.expression) &&
	ts.isPropertyAccessExpression(statement.expression.expression) &&
	CONSOLE_STDOUT_METHODS.has(statement.expression.expression.name.text) &&
	isConsoleIdentifier(statement.expression.expression.expression);
const writesStdout = (statement) =>
	isCallStatement(statement, "write", isStdoutReceiver) || writesConsole(statement);
```

`containsStatement`、相邻配对、兄弟 `if` 跳过的实现不动。函数文档注释改为：谓词覆盖
`process.stdout.write` 与 `console.log`/`console.info`（同一 stdout 通道）；`console.error`
（stderr）与别名写法仍不覆盖，并列出 §6 的其余盲区。

### 3.3 守卫自测

- `violations` 新增：`["console.log then exit", \`console.log("x");\nprocess.exit(0);\`]`（从
  `accepted` 移入）、`["console.info then exit", \`console.info("x");\nprocess.exit(0);\`]`。
- `accepted` 保留 `["console.error then exit", \`console.error("x");\nprocess.exit(0);\`]`
  作为 stderr 边界的钉死样本。
- 现有的 `if (ready) console.log(x)` 形态由 `containsStatement` 递归自然覆盖，补一条违例
  样本 `["conditional console.log then exit", ...]` 以证明它与 `process.stdout.write`
  同口径。

### 3.4 `FORMAL_BASELINE_REPO` 空串/纯空白防御

`test-support/formal-measurement/formal-plan.mjs` 新增导出（不直接读 `process.env` / `process.cwd`）：

```js
// An empty or whitespace-only FORMAL_BASELINE_REPO is an unset variable, not
// the process cwd: resolve("") would silently re-root baseline hashing at the
// candidate repo.
export function resolveBaselineRepo(envValue, repo) {
	return typeof envValue === "string" && envValue.trim() !== ""
		? resolve(envValue)
		: resolve(repo, "../issue-222-attach-baseline");
}
```

`formal-plan.mjs` 需从 `node:path` 补 `resolve` 导入。`formal-runner.mjs:20-22` 替换为：

```js
const baselineRepo = resolveBaselineRepo(process.env.FORMAL_BASELINE_REPO, repo);
```

`repo` 已是绝对路径（`resolve(dirname(...), "../..")`），默认分支结果与现状逐字相同。
函数本身不直接读取 `process.env` 或 `process.cwd`；非空值与现状一致：相对路径仍由
`path.resolve` 相对进程 cwd 解析（A7 用一条相对值样本钉住该语义）。

### 3.5 孤儿 harness 的两路 smoke（A4）

在 `test/scenario-stdout-flush.test.mjs` 末尾新增一条用例，以
`spawnSync(process.execPath, ["--experimental-transform-types", HARNESS], { env, encoding: "utf8", timeout: 5000 })`
启动夹具（`HARNESS` 用 `fileURLToPath(new URL("../test-support/attach-idle-candidate-open-harness.mjs", import.meta.url))`）；
两路显式 env：① `{ ...process.env, HARNESS_TIMEOUT_MS: "4000" }`（settled 运行钉住 4 秒预算，不用
harness 默认 8 秒）→ 断言 `status === 0`、stdout 末行可 `JSON.parse`、
`settledMs !== null`、原始 stdout 以 `"\n"` 结尾；② `{ ...process.env, HARNESS_TIMEOUT_MS: "0" }` →
断言 `status === 1`、stdout 末行可 `JSON.parse`、`settledMs === null`、原始 stdout 以 `"\n"` 结尾。
kill 层级：harness 预算 4 秒 < spawn 杀 5 秒 < harness 默认 8 秒，harness 总是在 spawn 超时
拆掉进程（`status` 变 `null`、断言读起来误导）之前自己排空退出。

## 4. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 守卫谓词能识别 `console.log`/`console.info` 紧邻 `exit`，且不误报 `console.error` | 自动化验证（unit） | `node --test test/scenario-stdout-flush.test.mjs` | 四条新样本（log / info / 条件式 log / error）判定与预期逐条一致 |
| A2 | `test-support/**` 不再有六种形态的违例 | 自动化验证（static） | 同上：全目录扫描用例 | `offenders` 为空；扫描前先临时还原一处可复现红 |
| A3 | `attach-idle-socket-driver.ts` 的成功/失败退出码与 JSON 输出 | 自动化验证（integration） | `node --test test/attach-frame-witness.integration.test.mjs` | 既有成功用例新增 `driver.status === 0` 断言；hard-invalid 用例新增 `driver.exitCode === 1` 断言；两条路径的 stdout 末行都能 `JSON.parse`，且原始 stdout 以 `"\n"` 结尾 |
| A4 | 孤儿 `attach-idle-candidate-open-harness.mjs` 的退出码与 JSON 输出 | 自动化验证（integration） | `node --test test/scenario-stdout-flush.test.mjs`（含两路 smoke，以 `--experimental-transform-types` 启动，5 秒 spawn 超时） | settled 运行（显式 `HARNESS_TIMEOUT_MS: "4000"`）在 5 秒内退出 0，stdout 为合法 JSON、`settledMs !== null`、原始 stdout 以 `"\n"` 结尾；`HARNESS_TIMEOUT_MS=0` 时退出 1，stdout 为合法 JSON、`settledMs === null`、原始 stdout 以 `"\n"` 结尾；kill 层级：harness 预算 4 秒 < spawn 杀 5 秒 < harness 默认 8 秒 |
| A5 | 另外四个场景夹具的输出仍可被消费方解析 | 自动化验证（integration） | `node --test test/pty-attach-frame-overflow.test.mjs test/pty-attach-mouse-mode.test.mjs test/pty-attach-wheel.test.mjs test/pty-attach-selection-mirror.test.mjs` | 全部通过，无 `Unterminated string`；每个消费方新增一条断言：原始 stdout 以 `"\n"` 结尾（与 A3/A4 一起覆盖六个调用点） |
| A6 | 排空助手在大 payload + 慢读端下不截断（回归保护） | 自动化验证（integration） | `node --test test/scenario-stdout-flush.test.mjs` 的 256 KiB probe 用例 | 通过，payload 长度 262144 |
| A7 | `FORMAL_BASELINE_REPO` 为空串/纯空白时回落默认路径，相对值沿用 cwd 语义 | 自动化验证（unit） | `node --test test/formal-runner-plan.test.mjs` | `undefined`、`""`、`"   "` 都返回 `<repo>/../issue-222-attach-baseline`；绝对非空值返回其 `resolve` 结果（两侧空白保留）；相对值 `"sibling"` 返回 `resolve("sibling")`（与现状一致） |
| A8 | 全仓门禁 | 自动化验证（build） | `npm run verify` | typecheck + perf gate + tests + coverage + `pack:dry` 全绿 |
| A9 | 两个必需 CI job | 自动化验证（automated E2E） | 承载本修复的 PR 上的 GitHub Actions | `Test (Node 22)` 与 `Test (Node 24)` 均 success |

**无用户实测项（无 U 项）**：本 issue 只改测试夹具的退出时序与静态守卫，产品行为零变化，
用户侧没有可观测差异；A7 用 PR 上的真实 CI 运行代替人工验证。这是分类结论，不是兜底。

## 5. 可测性拆分设计（实现阶段硬约束）

| 关注点 | 拆分后单元 | 测试边界 |
|---|---|---|
| 「什么算写 stdout」判定 | `writesConsole(statement)` / `writesStdout(statement)` 谓词 | 合成源码样本单测（A1），不读磁盘、不 spawn |
| 形态门禁 | `findUnguardedStdoutExits(text, fileName)`（纯函数） | 样本单测（A1）+ 目录扫描（A2），输入是源码文本 |
| env → baseline 路径 | `resolveBaselineRepo(envValue, repo)`（不直接读 `process.env`/`process.cwd`；非空相对值经 `path.resolve` 使用 cwd） | 四输入单测（A7），不 spawn、不依赖兄弟 checkout |
| 六个真实调用点 | 不改结构，只换退出写法 | 四个场景由现有消费方覆盖（A5）；driver 由 witness 的成功/失败用例加断言（A3）；孤儿夹具由两路 smoke 覆盖（A4） |
| 排空语义 | `writeThenExit(stream, text, code, exit)`（既有） | 现有三分支单测 + 256 KiB probe（A6），本 issue 不改 |

实现不得把这些判定重新耦合：不得让 `resolveBaselineRepo` 直接读 `process.env` 或 `process.cwd`
（相对值的 cwd 语义只由 `path.resolve` 承担，与现状一致），不得把 `console.*` 识别写成对
全文件文本的正则扫描（AST 谓词是唯一入口）。

## 6. 边界与非目标

- **不覆盖 stderr**：`console.error` + `exit` 存在于 `ui-smoke.ts`、`attach-frame-failure-child.mjs`，
  量级是几百字节报错信息，#270 D8 的同类取舍。
- **不覆盖 `console.debug`**：Node 里同样写 stdout，但 issue 指定范围只有 `log`/`info`，
  且当前零处；在守卫注释中明示，避免被误当成「已验证」。若 CR 要求，可无成本纳入。
- **别名盲区**：`const log = console.log; log(x); process.exit(0)` 与
  `const out = process.stdout; out.write(x); process.exit(0)` 同属守卫看不见的形态。
- **非相邻语句 / try-finally / `.then` 写 + `.catch` 退**：现有配对规则不覆盖，保持原状。
- **不清理孤儿夹具**：`attach-idle-candidate-open-harness.mjs` 仍无语义消费方（归属 #211），本 issue 只给它加一条退出码 smoke。
- **不改产品代码**：`src/**`、`runner/**` 零改动（`formal-plan.mjs` 属测试支撑）。
