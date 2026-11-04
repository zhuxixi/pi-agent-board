# spec — issue #270：场景在 stdout 排空前 `process.exit`，把 JSON 结果截断在 64 KiB

Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-04T00:19:30+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-04T00:31:14+08:00 — cross-review R1（真缺口 1 / 细化 5）：R1-G1 接受（补 `fake-slow-start-pi.mjs` 的第三条替换配方：write 保持无条件，只把 `if` 内的 `exit` 换成 flush-guarded 退出）；R1-D1 接受（9 → 10 个 scenario）；R1-D2 接受（A6 去掉不存在的 PR #272）；R1-D3 接受（A2 断言改 payload 长度 + 合法 JSON，不写裸字节数）；R1-D4 接受（守卫谓词钉死 `process.stdout.write`，`console.log` 不计，自测加一条样本）；R1-D5 接受（§4 声明范围超出 issue 字面验收，PR 描述同步声明）
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-11-04T00:37:59+08:00 — cross-review R2（真缺口 0，收敛）：R2-D1 接受（§3.3 机械替换清单里移除 3 处专用配方站点，使清单恰好 15 处、与标题计数不再矛盾）

基线：`origin/main @ 936f46e`。复现证据、AST 清点与既有正确写法见
`research/01-reproduction-and-inventory.md`。本 issue 走 bug 路由，第 1 节即根因报告。

## 1. 现象与根因

`Test (Node 22)` / `Test (Node 24)` 两个必需 job 在 `test/pty-attach-ready.test.mjs:1286` 报
`Unterminated string in JSON at position 142957`，且与 PR 内容无关 —— 主分支自己的 `936f46e`
也是红的，因此**任何 PR 都合不了**。

根因是一行退出时序，不是数据生成：

- `test-support/pty-attach-ready-scenario.ts:4452-4453` 写 `JSON.stringify(result)`（约 143 KB）
  后立刻 `process.exit(0)`。
- 测试侧 `spawnSync` 通过管道读 stdout，管道容量 64 KiB。payload 超限时 `write()` 返回 false，
  余量在异步队列里等待 drain，而下一行的 `exit` 直接把进程拆掉。
- 结果：读端只拿到管道缓冲里的前 64 KiB。**退出码仍是 0**，截断静默发生，只有 `JSON.parse` 撞破。
- 本地绿的原因：读端是同一台机器上的快进程，写队列在 `exit` 之前排空；CI runner 更忙，输掉这场竞争。

确定性复现（慢读端，`| (sleep 3; cat)`）：输出**正好 65536 字节**，
`JSON.parse` 报 `Unterminated string at position 63702`。见 research §1。

同形写法在 `test-support/**` 有 **18 处 / 17 个文件**（research §3）。s15 只是 payload 最大的那个，
其余是「payload 长大或 runner 变慢就会复现」的同类定时炸弹。

## 2. 设计决策表

| # | 决策 | 依据 / 取舍 |
|---|---|---|
| D1 | 新增 `test-support/stdout-flush.mjs`，分两层：`writeThenExit(stream, text, code, exit)`（注入流与退出函数）+ `exitAfterStdout(text, code = 0)`（绑定 `process.stdout` / `process.exit` 的薄壳） | 排空行为只能在子进程里观察，但「何时该退出」的判定可以纯化：注入 `stream` 与 `exit` 后，三条分支（正常回调 / `error` 事件 / 同步抛错）都能在单进程里单测 |
| D2 | 退出条件 = `write` 的**完成回调**触发；同时挂 `stream.once("error")` 并在写调用外 `try/catch` | 只挂回调会在管道被对端关闭时永远不触发（EPIPE 变未捕获异常）。三条路径都收敛到「按调用方给的 code 退出一次」，用一次性标志位保证不重复退出 |
| D3 | 全量替换 `test-support/**` 的 18 处，而不是只修 s15 那一处 | 形态完全同构、改法完全同构；只修一处等于把 17 个同类隐患留在原地，下一个 payload 长大的场景还要重演一次 CI 红灯 |
| D4 | 不修 `fake-pty-pi.mjs` / `fake-pty-generation-pi.mjs` | 它们已经是正确写法（回调形式），且 sha256 被测试钉死：`S15_ACCEPTED_HASHES.fakePtyChild`、`ENTRY_ACCEPTED_HASHES.generationFixture`。改动会让 harness 契约测试红 |
| D5 | 新增静态守卫测试 `test/scenario-stdout-flush.test.mjs`：用 TypeScript 编译器 API 解析 `test-support/**`，禁止「写 stdout 的语句紧邻 `process.exit` 语句」 | 正则会把 `.then` 里的写与 `.catch` 里的 `exit(1)` 误判成相邻，也会漏掉 `if (x) write(...)` 这种包裹；AST 判定给出精确口径，守卫才敢当门禁 |
| D6 | 守卫的判定函数是纯函数，配**正负样本自测**（含 `.then`/`.catch` 反例） | 守卫若自身写错会「永远通过」，等于没写。自测保证它能同时识别真违例与放过合法写法 |
| D7 | 不用 `process.exitCode = n` 的自然排空替代 | 多个 fixture 持有 `setInterval`、子进程或 socket，事件循环不会自己空转结束；改成自然退出会换来挂死风险 |
| D8 | 不改 `process.stderr.write(...)` + `exit` 的报错分支 | 写的是 stderr 且量级是几百字节报错信息；纳入范围只会扩大 diff，不解决本 issue |

## 3. 代码落点

### 3.1 新文件 `test-support/stdout-flush.mjs`

```js
/**
 * Write `text` to `stream` and call `exit(code)` only after every byte has
 * been accepted. A bare `stream.write(text); exit(code)` tears the process
 * down while the kernel pipe still holds a partial payload: anything past the
 * 64 KiB pipe buffer is lost with a silent exit 0 (issue #270).
 *
 * `stream` and `exit` are injected so the three paths — flushed, broken pipe,
 * synchronous throw — are unit-testable without spawning a child.
 */
export function writeThenExit(stream, text, code, exit) {
	let settled = false;
	const finish = () => {
		if (settled) return;
		settled = true;
		exit(code);
	};
	stream.once("error", finish);
	try {
		stream.write(text, finish);
	} catch {
		finish();
	}
}

export function exitAfterStdout(text, code = 0) {
	writeThenExit(process.stdout, text, code, (status) => process.exit(status));
}
```

### 3.2 新文件 `test-support/stdout-flush-probe.mjs`

集成验证用的可执行夹具：`--bytes N`（默认 262144）→ 写出 `{"payload":"x"*N}` 后经
`exitAfterStdout` 退出。payload 必须明显大于 64 KiB，才能覆盖「`write()` 返回 false」的分支。

### 3.3 替换点（18 处：15 处机械替换 + 3 处专用配方）

机械替换的每一处语义保持逐字不变（写什么、退出码表达式都不改），只把「写 → 退出」换成一次
`exitAfterStdout(<同 text>, <同 code>)`：

- 10 个 `*-scenario.ts`：`pty-attach-ready`(4452)、`attach-entry-22`(1382)、`attach-ready-catchup`(368)、
  `attach-ready-entry`(1070)、`attach-ready-interactions`(656)、`pty-attach-20b`(4010)、
  `pty-attach-21b`(1389)、`pty-attach-matrix`(1222)、`pty-attach-timing`(1653)、
  `pty-attach-parser-replacement`(808)
- `ensure-host-helper.mjs`(44)、`pi23a-smoke-runner.mjs`(452)、`pi23a-production-smoke-runner.mjs`(317)、
  `formal-measurement/formal-runner.mjs`(24)、`formal-measurement/preflight.mjs`(135)

两处**非平凡形态**需要专用配方，不能套用上面的「合并成一次调用」规则：

- `fake-pty-frame-wrapper.mjs:137/143` 原本是 `if (cond) write(carry); exit(code)`，替换为
  `exitAfterStdout(cond ? carry : "", code)`（`cond` 为假时写空串，行为等价）。
- `fake-slow-start-pi.mjs:34-35` 原本是**无条件** write 后跟 `if (text.includes("exit")) exit(0)`，
  且进程靠 `setInterval(() => {}, 1000)` 保活。**不能**把 write 挪进 `if`：`test/pty-runner.integration.test.mjs`
  的 resize-before-ready 用例先等 `echo:still-alive` 再发 `exit\r`，合并会让夹具在收到任意 stdin 块后
  就退出、丢掉非 exit 输入的 echo。配方是：write 原位保留，只把 `if` 内的 `process.exit(0)` 换成
  `if (text.includes("exit")) exitAfterStdout("", 0)`（空串写入的回调等价于「等已有输出排空」）。
  替换后该点的语句相邻关系不再命中守卫（`if` 里是 `exitAfterStdout` 而非 `process.exit`），这是预期结果。

### 3.4 新测试 `test/scenario-stdout-flush.test.mjs`

- 纯函数 `findUnguardedStdoutExits(text, fileName)` 定义在本文件内（唯一使用方是守卫测试，
  不额外引入模块）：AST 解析 → 遍历所有语句列表 → 相邻语句对里「前句写 stdout、后句 `exit`」
  记为违例；`if` / block 递归展开。
- **兄弟条件分支不配对**：前後两句都是 `if` 时直接跳过 —— 两个并列条件分支是相互独立的路径，
  不是同一条「先 drain 再退出」序列（否则 `formal-runner.mjs` 的 `if (dryRun) { write; exit }`
  会与后面那个 `if (FORMAL_APPROVED…) { … exit(2) }` 误配）；块内部的真实相邻由递归单独发现。
- **谓词钉死**：只匹配 `process.stdout.write(...)` 的表达式语句；`console.log` / `console.info` /
  `console.error` **不**计入（§6 显式非目标，`test-support/**` 里有 11 处 `console.log(x); process.exit(n)`，
  计进来会让守卫与自己的非目标打架）。
- 守卫：扫描 `test-support/**/*.{ts,mjs,js}`，断言违例数 0，失败时打印 `file:line` 清单。
- 自测：合成样本表（违例 3 条、合法 6 条）断言判定口径，防止守卫空转。违例样本为
  「直接写后 `exit`」「`if (x) write(...)` 后跟 `exit`」「`if (x) { write }` 后跟 `exit`」；
  合法样本为「`write` 带回调」「`exitAfterStdout`」**「`console.log` 紧邻 `exit`」**
  「`.then` 里写 / `.catch` 里 exit」「写后接条件式 helper 退出」「兄弟条件分支」。

## 4. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | `writeThenExit` 三条分支都只退出一次 | 自动化验证（unit） | `node --test test/scenario-stdout-flush.test.mjs` | 正常回调 / `error` 事件 / `write` 同步抛错各触发 `exit` 恰好一次，且携带调用方给的 code |
| A2 | 超大 payload 在慢读端下不再截断 | 自动化验证（integration） | 同上：spawn `stdout-flush-probe.mjs --bytes 262144`，stdout 接管道且**延迟 250 ms 才开始读** | stdout 为合法 JSON、`payload.length === 262144`、退出码 0（不断言裸字节总数：JSON 包装让它等于 262157） |
| A3 | `test-support/**` 不再有「写 stdout 紧邻 `exit`」形态 | 自动化验证（static） | 同上：守卫用例 + 检测器自测 | 违例 0；自测样本判定与预期逐条一致（含 `.then`/`.catch` 与 `console.log` 反例不误报） |
| A4 | s15 battery 场景输出可解析 | 自动化验证（integration） | `node --test test/pty-attach-ready.test.mjs` | 88/88 通过（含 `case S real-runner battery`），无 `Unterminated string` |
| A5 | 全仓套件、类型、性能门禁、覆盖率、打包均绿 | 自动化验证（build） | `npm run verify` | typecheck + perf gate + tests + coverage（lines 85 / funcs 80 / branches 70）+ `pack:dry` 全部通过 |
| A6 | 两个必需 CI job 转绿 | 自动化验证（automated E2E） | 承载本修复的 PR（编号以创建时为准）上的 GitHub Actions | `Test (Node 22)` 与 `Test (Node 24)` 均 success |

**无用户实测项（无 U 项）**：本 issue 只改测试夹具的退出时序，产品行为零变化，用户侧没有可观测差异；
A6 用 PR 上的真实 CI 运行代替人工验证。这是分类结论，不是「想不出怎么测」的兜底。

**范围声明**：issue #270 的字面验收是「`test-support/*-scenario.ts` 清理干净或加注释豁免」，
本 spec 扩到 `test-support/**` 的 18 处（含 `.mjs` runner 与 `formal-measurement/`）。这是 D3 明确给出的
有意扩张（同一形态、同一改法，只修一处等于留 17 个同类隐患），PR 描述里会同步声明，便于评审对照。

## 5. 可测性拆分设计（实现阶段硬约束）

| 关注点 | 拆分后单元 | 测试边界 |
|---|---|---|
| 「何时退出」判定 | `writeThenExit(stream, text, code, exit)` —— 不碰全局 | 单进程内用假 stream（`EventEmitter` + `write(text, cb)`）覆盖三条分支；不需要 spawn |
| 与真实进程的绑定 | `exitAfterStdout(text, code)` —— 只有两行，不承载逻辑 | 由 A2 的子进程集成测试覆盖，不与判定逻辑混测 |
| 形态守卫 | `findUnguardedStdoutExits(text, fileName)` —— 纯函数，输入源码文本 | 合成样本自测（A3）+ 目录扫描（A3）；两者都不依赖任何真实进程 |
| 真实截断机制 | `stdout-flush-probe.mjs` —— 可执行夹具 | 由父测试 spawn 并控制读取时机（A2） |

实现时不得把上述拆分重新耦合（例如把 AST 扫描写进产品代码、或让 `writeThenExit` 直接读 `process`）。

## 6. 非目标与保证边界

- **不覆盖** `console.log(x); process.exit(n)`（`test-support/**` 共 11 处）：这是本 issue 的范围取舍，
  不是因为这些站点安全。其中至少 6 处 —— `pty-attach-frame-overflow-scenario.ts:378`、
  `pty-attach-mouse-mode-scenario.ts:94`、`pty-attach-wheel-scenario.ts:187`、
  `pty-attach-selection-mirror-scenario.ts:260`、`attach-idle-socket-driver.ts:49`、
  `attach-idle-candidate-open-harness.mjs:75` —— 都是 `console.log(JSON.stringify(result)); process.exit(...)`，
  测试侧用 `JSON.parse(...)` 消费，与本 issue 修的是同一种失效模式，只是 payload 还小才没有暴露。
  把其中机器解析的站点改成 flush 后退出由后续 issue #273 跟踪；在那之前它们同属定时炸弹。
- **不覆盖** `process.stderr.write(...)` + `exit` 的报错分支（stderr，量级为几百字节）。
- **不覆盖** 产品代码（`src/`、`runner/`）里的 `process.exit`：那里是命令行的正常退出路径，不在测试夹具范畴。
- **不修** #211（场景未消费的 stdout 管道）与 #95（real-process 测试的普遍 flake）：本 issue 是确定性截断，
  与「负载相关的预算问题」不是同一回事。
- **不做 lint 插件 / 独立 CI 步骤**：守卫以 `node:test` 用例形式存在，随套件跑，不新增 CI 配置面。
- 保证边界：本改动能让「同一进程内 write 后立刻 exit」不再丢字节；**不能**修复「父进程在子进程写完前
  就杀掉子进程」这类外部 kill 造成的丢失。

## 7. 风险

| 风险 | 处置 |
|---|---|
| 17 个文件机械改动引入行为差异 | 每处的文本与退出码表达式逐字保留；这些文件全部被现有测试引用（`test-support/formal-measurement/preflight.mjs` 与 `fake-pty-frame-wrapper.mjs` 无直接测试，但后者被 6 个 scenario 间接使用），由 A4/A5 兜底 |
| EPIPE 时行为变化（原本 `exit(0)` 抢先，现在可能先收到 `error`） | D2 的 `once("error")` 让退出码与调用方一致，不会变成未捕获异常 |
| A2 的 250 ms 延迟被误读成时序断言 | 延迟只用来「先让 64 KiB 缓冲写满」，payload 256 KiB 是确定超限；延迟越长越必然，不构成 flake 来源 |
| `formal-plan.mjs` 的 `measurementScripts` 记录里 10 个文件哈希会变 | 那是身份记录（写进 artifacts），不是钉死常量；`test/formal-runner-plan.test.mjs:59` 的 `mirrored` 断言比较的是本 checkout 与同级 baseline 目录，在本仓解析为同一目录，不会因本次改动变红（已核实） |
