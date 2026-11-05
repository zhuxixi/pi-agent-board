# Issue #222：Attach 首屏就绪与防闪屏验证 Implementation Plan

> **For agentic workers:** Follow `github-issue-driven`. This is a pre-existing implementation-plan draft, not the Step 4 spec or an implementation approval. Complete spec cross-review and the design gate first; after approval, create an isolated worktree and materialize the Step 6 plan there. Read-only `spec-reviewer` delegation is authorized by the user's explicit workflow request. Do not commit, push, merge, or publish without the applicable authorization.

**Goal:** 让已运行的后台会话在 attach 后快速显示最新内容与输入框，并用逐帧证据和重复实验验证没有残影、跳屏或双光标，而不是仅缩短 loading。

**Architecture:** 先建立从用户操作到实际呈现的分层观测，区分“数据已到”“完整画面已解析”“正确底部画面已呈现”。在证据充分的前提下，只为新协议改用明确的画面就绪条件；旧兼容模式保持原保护机制。

**Tech Stack:** TypeScript、Node.js `node:test`、`@xterm/headless`、node-pty、现有 Pi TUI 渲染链路。

**Spec:** [issue-222-attach-ready-spec.md](../specs/2026-10-23-issue-222-attach-ready-design.md) 为独立设计文档；[GitHub issue #222](https://github.com/zhuxixi/pi-agent-board/issues/222) 与本次用户需求为输入。用户已确认对标 Claude Code 的会话恢复／子代理切换体验；只对标快速到达当前工作区域，不假设或复制其内部实现。

## Issue-driven 流程状态

- [x] 步 1：核对 #222 为 open bug，并复用原调查；补读 PR #122 的 CR 与 JFox 永久笔记。
- [ ] 步 2：认领及开始处理评论；当前规划模式下暂不写 GitHub，不能把未认领写为已认领。
- [ ] 步 3：按主题留存调研与 issue 评论；已有证据接入本轮草稿，不重做已有实验。
- [x] 步 4 设计产物：完成独立 spec／根因报告、验收矩阵与可测性拆分；两轮异模型 `spec-cross-review` 收敛，第 2 轮唯一细化已吸收。
- [ ] 步 4 设计 gate：提交本计划及所链接 spec，等待用户确认；设计复核完成不是实施授权。
- [ ] 步 5–6：设计批准且解除规划后，使用 `git_worktree` 建 `issue-222-attach-ready` 隔离工作区，归档 spec，并在 worktree 形成正式实施计划。当前 `plans/` 草稿与复核留痕只因规划模式的写入边界临时放在此处；不要提交到 main。
- [ ] 步 7–8：按 `subagent-driven-development` 在 worktree 实现，保留验收边界，完成本地代码审查。
- [ ] 步 9–10：按实际授权处理 PR、Zima CR、验收对账、合并与清理。本机只用 `gh pr edit <N> --add-label zima:needs-review` 触发 CR，结果只读 GitHub；不运行本机 zima PJob。

当前无本 issue 的授权归档，按 `stepwise`；用户本轮已明确授权按 issue-driven 补设计与只读交叉复核。规划模式不允许仓外写入，因此当前不创建外部授权文件、不提前创建 worktree；不将工作流请求解释为自动提交、push 或合并许可。

**当前进度：** 两轮异模型设计复核已收敛：第 1 轮 1 个真缺口／4 项细化均修订，第 2 轮无真缺口，唯一的 timer 细化已吸收；报告计数勘误保留原始版。逐条裁定与版本哈希见 [spec-cross-review-state.md](/home/elling/.github-issue-driven/zhuxixi/pi-agent-board/issue-222/research/spec-cross-review-state.md) 和 [第 2 轮报告](/home/elling/.github-issue-driven/zhuxixi/pi-agent-board/issue-222/research/spec-review-round-2.md)。现在等待设计审批，不能进入 worktree 或实现。

本计划的 spec A1–A12／U1–U3 均属于 issue #222，结果中须写 `#222-A11` 等全称；与仓内 #121／#91 的既有 A11 perf-gate 分别验收，不能用 `npm run test:perf` 代替本计划重复试验。
## Global Constraints

- 当前仅规划；P1–P6 是技术实施草稿。先完成 issue-driven 步 4 的 spec 交叉复核与设计审批，解除规划后才进入隔离 worktree 和正式计划；实现按 `subagent-driven-development`，主会话保留裁定和集成责任。
- 保留新协议的序号校验、恢复、匹配尺寸零 resize／不匹配只调真实尺寸一次的契约；保留 legacy 的 settle 与 jiggle 保护。
- 不新增依赖、不升级 Pi、不改协议版本、不手改 CHANGELOG。若实验表明必须变更协议，先带证据修订本计划。
- 运行时源码用 tabs、英文注释；测试通过临时目录、独立端点和自己创建的子进程隔离，不使用真实会话作破坏性测试。
- 完成前必须运行 `npm run verify`；源码和实机验收的证据分别报告。

## Review Focus

- 快照截在同步更新块内，或同一 chunk 中先关上一帧再开下一帧：所有渲染入口都只能呈现完整画面（P2/P3/P4）。
- 高／宽不匹配：旧尺寸快照和 resize ack 均不能冒充新尺寸完成画面（P3/P4，G1–G3）。
- 空快照、epoch 更换、过期解析回调：旧日志与旧子进程内容不能成为新首屏（P3/P4，C/R）。
- 长对话、alternate buffer、中文宽字符与光标：首个会话画面包含正确工作区域；手动上滚后不被新输出抢回（P3/P4，L/U）。
- 首屏后的主题报告、状态刷新、退出和 dispose：不泄露半帧，不重复注册桥接或触发已关闭组件（P3/P4，T/D）。

## Context

- 用户要求：先定位反复修复仍有闪屏的根因，再验证能否像 Claude Code 会话恢复／子代理切换那样快速进入会话底部，避免约 2 秒等待。
- 体验契约：“底部”指正常编辑场景下最新回复尾部与输入区域；已有提问／选择弹层则保留当前活动界面，不强制跳走。用户主动向上滚动后不抢回底部。
- 本轮处于规划阶段：只允许读取和在工作目录内编辑 Markdown；不改源码、测试、运行配置，不启动生产探针、不安装依赖、不提交。
- 原调查／既有测量基线：main `9a197f4`，工作区在最初写本文件前干净。2026-10-22 回收复核时实际 HEAD 为 `d41a16bbd3e55c6df1d1cdd60c43a7c2e2492482`，差异仅为 #221 的 events 源码／测试与文档，引用的 attach 文件未变；旧测量不能冒充新 HEAD 的结果。P1 以实际检出重新记录并核对依赖变化。
- 前轮单次实验记录：真实 socket 在约 5ms 接收完快照；持续输出测试首屏 2512ms，安静测试 268ms。这证明了延迟现象，不构成新方案成功率。

## Findings：已确认事实与待验证根因

1. **已确认的额外等待：** `pushOutput()` 每次解析输出后都会 `deferAttachSettle()`；250ms 安静期会被转圈动画持续重置，最终触发 2500ms 上限。
2. **已确认的历史保护需求：** `1594daf` 的 loading 保持期用来遮挡日志回放和 resize-jiggle 重绘；旧路径仍然需要保护。
3. **已确认的快照入口：** `snapshotReady` 把权威快照送入 `pushOutput(..., {authoritative:true})`，但完成回调仍复用安静期逻辑。
4. **已确认已有底部逻辑：** `viewportTop` 初始为 `null`；`project()` 走 `bottomViewportTop()`。需要验证其结果是否是用户期望的“最新回复＋输入框”，而不是重新写一套滚动逻辑。
5. **尚未证明没有闪屏：** 本地解析一个输出 chunk 不等于子进程完成一帧；40ms 合并重绘也不是帧边界保证。尺寸不匹配时快照仍可能属于旧尺寸。
6. **现有测试缺口：** `pty-attach-protocol-e2e` 主要验证最终内容出现、订阅成功、resize 次数，不能单独证明过渡期没有错误可见帧，也没有成功率统计。
7. **协议完整不等于子 TUI 一帧完整：** `finishCollecting()` 校验快照和补发输出的序号连续性后才发 `snapshotReady`；这证明没有丢包／乱序，但不是子进程完成整帧重绘的证明。`whenIdle(model)` 只等已收到的 chunk 解析完，不会等待尚未到达的帧尾。
8. **尺寸确认有边界：** `sendControl("resize")` 已有命令确认；`resizeChildAndModel()` 同步调整 PTY 和本地模型。命令 applied 不等于子 Pi 已重绘完毕，不能把 resize ack 当画面就绪信号。
9. **底部投影可以复用：** `bottomViewportTop()` 用 `baseY + rows` 选择当前屏幕底部；必须另测 alternate buffer 和快照水合溢出，不能仅验证 `viewportTop === null`。
10. **新发现的半帧风险（需先复现，不能直接宣称现场根因）：** `@xterm/headless` 提供 `modes.synchronizedOutputMode`；`terminal-snapshot.test.mjs` 已明确允许捕获并还原该模式为 true 的快照，即快照可能处于子 TUI 的 `?2026h … ?2026l` 同步更新块中间。attach 当前按 chunk 解析完成就请求渲染，没有使用该模式作为呈现边界。仅在快照 write 回调立刻撤 loading，可能把旧 2.5s 遮罩藏住的半帧暴露出来。
11. **真实渲染基础可复用：** `pty-attach-frame-overflow-scenario.ts` 已使用 `TuiAltScreen` 和可替换终端；可以扩展为实际 ANSI 输出采集，不必用手动调用 `component.render()` 假装真实终端已经呈现。Pi 文档提供 `PI_TUI_WRITE_LOG` 作为真实进程诊断入口。
12. **不能只拦输出定时器：** `hello`、`status` 等控制消息也会请求渲染，而 `render()` 直接投影当前可变的 xterm buffer。仅延迟 `outputRenderScheduler` 无法建立所有入口一致的完整帧契约；对有同步标记的现代路径，无条件在投影入口门控并保留最小完整视图，不以是否复现现场闪屏作为开关。现场根因归因仍待 P2 的独立证据。
13. **依赖与实机版本需分开验证：** 仓库开发依赖是 Pi TUI 1.1.0，当前宿主 Pi 安装目录是 1.3.0；两版 fullscreen 渲染器都有同步更新标记，1.1.0 的 regular 渲染器也使用同步更新块。必须记录实际加载路径与版本，不能把安装目录版本当成已证明的运行时解析结果；本 issue 不升级依赖掩盖差异。
14. **就绪转换还有主题副作用：** `finishAttachTransition()` 同时清理 loading 定时器、强制替换画面、启动健康检查、注册主题桥和探测真实终端颜色。现有 `childInputReady` 还会把颜色报告延后到子进程进入 raw mode。加速必须保留这些行为并观测后续主题重绘，不能把它们删掉制造漂亮首屏数据。
15. **帧边界有可验证的现成入口：** 已检查 `@xterm/headless` 的公开 `parser.registerCsiHandler()` 和 `modes.synchronizedOutputMode`。观察型 CSI handler 返回 `false` 可继续交给默认解析器；若需要捕获同步更新关闭瞬间，应走此入口而非另写 ANSI 正则解析器。仍须测试“同一 chunk 内先关帧、再开下一帧”，不能只在 write 回调读取一次模式值。
16. **测试端点应复用跨平台工具：** 现有 frame-overflow fixture 写死 Windows named pipe，不能原样当本机通用观测器；新的隔离 fixture 应用 `controlSocketPath()`／`hostEndpointPathFor()`，避免把测试设施故障误算为产品闪屏。
17. **校验后的水合仍有补发队列：** `finishCollecting()` 先同步 emit `snapshotReady`，随后按序 emit `partial.flush` 中的输出。必须观察这些异步 write 的顺序，不能把快照自己的解析回调等同于全部已验证补发都已完成；关闭／开启下一帧和过期队列都要覆盖。
18. **点击计时不能从组件构造假冒：** `agent-board.ts` 实际 attach 路径先 await `resolveAttachTarget()`，再创建 overlay；`attach-flow.ts` 还有相似公共 helper。总延迟测试应沿用 `attach-delete-flow-probe.ts` 的命令挂载方式驱动实际 dashboard 路径，保留真实 resolver。直接 `new PtyAttachComponent()` 的样本只能报告 overlay 起的延迟。

## Approach

### 推荐方向

先记录基线与逐帧错误，再做最小修复：新协议以“快照序号校验完成、本地解析完成、子 TUI 已完成可呈现的一帧、尺寸与当前连接代次正确”为就绪条件，不再以输出安静判定。优先验证正常的新协议、同尺寸、非空快照；尺寸不同、冷启动空快照、重连分别建立规则。继续复用底部投影、输出合并与清屏机制；任何尚无证据的快速路径都不得直接放行。

### 范围边界

- 本计划不承诺从零启动 Pi 也能瞬间进入；分别记录启动耗时和画面就绪后的附加等待。
- 不通过提前显示 `screen.log`、旧快照或空白屏来假装更快。
- 不因本 issue 改变用户正在浏览历史时的滚动行为，不注入 End 键到真实用户会话。
- loading 延迟显示、输入拦截不作为首个修复的一部分；只有观测证明有必要时再单独设计。
- 不将“快照收到很快”直接等同于“实际终端无闪屏”。

## Files to modify（计划，尚未实施）

- `src/ui/pty-attach.ts`：新协议的画面就绪、当前订阅代次、权威基线替换时的 parser 隔离、异步解析回调和投影入口；保留 `finishAttachTransition()` 的单次副作用。
- `src/core/pty-attach-render.mjs`、`test/pty-attach-render.test.mjs`：就绪纯判定／完整画面发布规则和假时钟测试；继续使用现有 40ms 输出合并。
- 新建 `test-support/attach-presentation-fixture.ts`：可替换 `Terminal`、实际 TUI 输出记录器、独立外层 xterm 和帧断言；复用现有真实 TUI 挂载方式。
- 新建 `test-support/pty-attach-ready-scenario.ts`、`test/pty-attach-ready.test.mjs`：隔离 runner、可控子进程和逐帧回归；`--repeat` 模式负责本地对照测量，常规测试只跑确定性场景。
- 新建 `test/attach-ready-report.test.mjs`：直接测试 scenario 导出的纯统计函数（分位数、超时、成功率与区间），命令入口用 main guard 隔离，不因 import 启动测量。
- `test-support/fake-pty-pi.mjs`：增加显式选择的可控同步帧／resize／冷启动模式；现有默认、steady、alt 等模式保持原行为。
- `test-support/pty-attach-protocol-scenario.ts`、`test/pty-attach-protocol-e2e.test.mjs`：复用真实 runner 计时与 resize 契约，不删除已有断言。
- `test-support/pty-attach-restart-scenario.ts`：在现有恢复场景补逐帧来源断言；`test/pty-attach-scheme-readiness.test.mjs`、`test/pty-attach-settle-scheme.test.mjs` 及对应 smoke fixture：补自动就绪触发副作用的检查。
- `test/terminal-snapshot.integration.test.mjs`：若 P2 在真实捕获链复现半帧，补捕获中途的回归证据；不为假设重写快照模块。
- `plans/issue-222-attach-ready-check.md`：维护执行进度；批准后在 `plans/issue-222-attach-ready-results.md` 记录实验结果和证据位置。

`src/core/terminal-model.mjs`、`terminal-snapshot.mjs`、`terminal-attach-protocol.mjs`、`terminal-attach-client.mjs` 目前是调查与复用入口。若发现必须修改这些模块才能满足画面契约，先定位具体失败和最小接口变化，修订同一计划再扩大范围。

## Reuse

- `createTerminalAttachClient()` — `src/core/terminal-attach-client.mjs`：沿用快照校验、序号检查、恢复和 generation 事件；不另写订阅客户端。
- `pushOutput()` / `finishAttachTransition()` — `src/ui/pty-attach.ts`：解析回调和初次转换副作用。恢复期的画面门控与这个单次转换分开，避免重启主题桥和健康探针。
- `bottomViewportTop()` / `project()` / `historyFloorAfterHydrate()` — `src/ui/pty-attach.ts`、`src/core/pty-scroll.mjs`：底部投影、光标和伪历史保护；不注入 End 键。
- `createAttachOutputRenderScheduler()` / `nextAttachRender()` — `src/core/pty-attach-render.mjs`：输出合并与首屏清理；时钟测试验证时序，集成测试验证真正写出的内容。
- `createTerminalModel()` / `feedOutput()` / `whenIdle()` / `captureTerminalSnapshot()` / `synthesizeFullRedrawFrame()`：真实解析、捕获和水合；不把 `whenIdle()` 当作未收到帧尾的等待器。
- `parser.registerCsiHandler()` / `modes.synchronizedOutputMode` — 已检查 xterm 的公开 API：观察同步更新边界，handler 返回 `false`，保留默认解析；必须先验证边界上的网格和光标读数。
- `controlSocketPath()` / `hostEndpointPathFor()` — `src/core/paths.mjs`：临时 root 下的跨平台 socket／pipe。
- `test-support/pty-attach-frame-overflow-scenario.ts`：真实 TUI＋overlay 的挂载方式；不照抄写死 Windows pipe 的地址。
- `test-support/attach-output-fixture.ts`：受控私有成员访问、生产输出入口和解析 drain；新观察器避免替换真实解析／渲染逻辑。
- `pty-attach-protocol-scenario.ts`、`pty-attach-restart-scenario.ts`、现有 scheme readiness 与 legacy desync 套件：沿用 runner 拓扑、恢复来源和兼容性断言。
- `test-support/attach-delete-flow-probe.ts`：真实命令入口与 dashboard／attach 之间的 UI fixture，用于总延迟计时；`attach-flow.ts`、`agent-board.ts`、`runtime/service.mjs` 仅作观测入口，不因计时修改其业务逻辑。

## Steps

### Task 1: P1：固定体验与观察边界

**验收归属：** spec A11、A12、U1–U3（环境与体验前置）；P1 不产生产品行为变更。

- [x] 已确认对标 Claude Code 会话恢复／子代理切换，正常编辑首屏为“最新回复尾部＋输入区域”，活动选择界面保持原状。
- [x] 已定位额外等待，列出完整帧、尺寸、冷启动和恢复证据缺口；这些缺口不能靠缩短常数解决。
- [ ] 实施开始先记录基线 commit、Node／xterm／Pi 实际加载路径与版本、终端模式和尺寸。检查 `git status --short`；如基线已变化，先核对相关差异再测量。

### Task 2: P2：建立能发现错误帧的观测器

**验收归属：** spec A2–A5、A10；A4/A5 是进入 P4 前必须完成的诊断 gate。

**Files:** 新建 `test-support/attach-presentation-fixture.ts`；复用 Terminal 接口、真实 `TuiAltScreen`／`TuiMainScreen` 和独立外层 xterm。

- [ ] 实现可替换 Terminal，把真实 TUI 的 `write()` 原样按顺序送入独立外层 xterm，记录单调时间戳、字节、网格单元格属性及软／硬光标。不改 `requestRender()` 为同步调用 `component.render()`。
- [ ] 以外层同步更新关闭为一次提交边界；跨多个 write 的同步块必须组装，同一 write 内多个完整块必须逐个保留。没有同步块的普通写入也记录为潜在可见状态，不默认为原子帧。
- [ ] 先验证观察器：手工给出 loading→完整目标帧，必须通过；插入一帧旧日志、上下半屏帧号不同、空屏或第二个光标，必须逐一报错；错误后再给正确帧不能把之前的错误抹掉。帧边界处的网格复制不得延后到下一个 chunk 已改变 buffer 之后。
- [ ] 复现半帧假设：可控子进程先发 `?2026h` 与上半屏，暂停超过 40ms；此时 capture、status 和 loading ticker 分别触发真实渲染；再发下半屏与 `?2026l`。补“关上一帧＋开下一帧在同一 chunk”和分片 delimiter 用例。记录是否真有错误帧、是哪条入口使它呈现。
- [ ] 分别记录尺寸变更后的命令 applied、子进程完整重绘、解析完成与实际写出时间；记录主题 probe 的及时／延迟回复是否引起第二次重绘。将证据与根因写入结果文档，再进入 P3/P4。

**交付门槛：** 观察器能检出人为插入的单帧错误；延迟根因有旧版重现；半帧等其他风险有“复现／本实验未复现”的明确结论。未复现的风险不能宣称为现场根因。A3 的帧边界发布、投影入口门控与最小完整视图是无条件机制，保护性用例必须通过；P2 的结果只决定额外缓存／接缝扩张是否必要，不是免除该机制的开关。

### Task 3: P3：固定旧版失败用例与基线

**验收归属：** spec A1–A10；每项按 spec §6 保留纯决策、真实解析、投影与 I/O 的测试边界。

**Files:** 新建 `test-support/pty-attach-ready-scenario.ts`、`test/pty-attach-ready.test.mjs`；扩展显式选择的 fake child 模式和现有 protocol／restart／theme fixture。

**拟新增测试接口：** scenario 接受 `--case <ID>`、`--repeat <N>`、`--clock virtual|real`、`--artifact-dir <path>`；每次试验输出一条 JSON。字段固定为 `caseId`、`error`、`times`、`readyBeforeLegacySettle`、`firstContentHasTailAndInput`、`frameFailures`、`resizeSizes`。`frameFailures` 每项包含帧序号、错误类别、期望和实际值；活动选择界面的对应断言使用其明确期望画面。计时字段见 Verification。虚拟时钟只用于确定性组件回归，显式执行解析／零延迟渲染任务而不推进旧 settle；真实 resolver／runner 的重复测量必须选 `real`，不得把虚拟时钟产出的时间混入分布。

- [ ] 建立独立临时 root、跨平台 socket 与真实 runner；可控 child 使用帧号、会话代次、`HISTORY`／`TAIL`／`INPUT` 标记，输出位置和光标坐标由 fixture 明确定义。保留 poisoned `screen.log`，证明首次显示来自当前基线。
- [ ] 总延迟实验通过命令／dashboard fixture 触发实际 attach，保留真实 `resolveAttachTarget()`，只替换终端和使用隔离会话。组件级实验单列 overlay 延迟，不能把其起点命名成 select；无法驱动真实入口时总延迟标为未测，不据此判 200ms 目标通过。
- [ ] 用例明确包含 snapshotReady 后的 catch-up flush、多次解析排队、帧尾后的光标停车写入、活动选择界面，以及用户上滚后新输出。frameComplete 与目标画面由独立 child fixture 事件和网格期望定义，不能使用候选的 ready 标志作测试真值。
- [ ] 对 B/Q/S/L/G1–G3/C/R/T/U/D 建立逐帧断言：底部内容与来源正确、上下半屏同一帧、无额外光标、无错误尺寸、没有过期回调发布、关闭后不再渲染。不能只断言私有 ready 标志或最终画面。
- [ ] 新协议明确就绪事件＋解析 drain 后，在 fake clock 尚未达到旧 250ms settle、2500ms 上限时检查是否能够提交。另将完整帧推迟到 >250ms 且 <2500ms，覆盖 undecided／protocol、S／A4／A5／C：未就绪前仍 loading、首次 hooks 为 0；合格 publish 后恰为 1；迟到或旧身份 timer 不再触发。legacy fallback 按既有期限与 probe 契约另测。这个回归先在旧版失败；延迟分布只放入本地重复实验，避免给 CI 加脆弱墙钟阈值。
- [ ] 用同一观测器先采基线；旧版不能通过“快速且正确”的试验也照实保留，不能因为最终会出现内容而记成功。

以下为拟新增测试中的关键断言；`scenario` 是本任务新建的脚本路径，返回字段由上面的接口定义：

```js
const scenario = fileURLToPath(new URL("../test-support/pty-attach-ready-scenario.ts", import.meta.url));
function runCase(caseId) {
	const out = execFileSync(process.execPath,
		["--experimental-transform-types", scenario, "--case", caseId, "--clock", "virtual"],
		{ encoding: "utf8", timeout: 60_000 });
	return JSON.parse(out.trim().split("\n").filter(Boolean).at(-1));
}
test("busy protocol attach publishes the correct screen before legacy settle", () => {
	const result = runCase("B");
	assert.equal(result.error, null);
	assert.equal(result.readyBeforeLegacySettle, true);
	assert.equal(result.firstContentHasTailAndInput, true);
	assert.deepEqual(result.frameFailures, []);
	assert.deepEqual(result.resizeSizes, []);
});
```

**交付门槛：** B 在旧版因等待 settle 失败；每个实际发现的错误都有可稳定复现的独立断言，观察器自测全过。源码暂不改变。

### Task 4: P4：按证据实现最小就绪改动

**验收归属：** spec A1–A9；仅在 A4/A5 诊断通过、spec 交叉复核收敛并获准后进入。

**Files:** `src/ui/pty-attach.ts`、必要的 `src/core/pty-attach-render.mjs` 和 P3 对应测试。

- [ ] 把“协议基线已校验”“本地解析完成”“可发布画面”“初次 attach 副作用已执行”分开，使用 spec §4 的纯决策与来源比较接缝。每次连接／基线有本地代次 token；在 `snapshotReady` 后为新权威基线替换本地 parser，使旧 write 队列无法写入新 buffer。回调同时验证 token 与 parser 身份，旧回调或 dispose 后回调不得发布。保留构造选项及历史 floor 规则，并释放旧 parser、CSI handler、timer 与缓存。
- [ ] 同尺寸、非空基线在当前完整画面解析后调用既有 `finishAttachTransition()`，不再延期等待输出安静。确认 protocol 时解除 connect 阶段已武装的 250ms settle，将 hard timeout 收编为保护状态；迟到回调验证模式／身份／closed。undecided 的 timer 不得先消费首次转换，legacy 则按既有期限恢复原路径，不重置原等待起点或 probe 期限。只有合格 publish 能触发现代首次 hooks；水合仍 open 时等真正帧尾，空基线等当前 child 的完整 live 画面，boot 文本或 raw-mode 单独出现均不算编辑器就绪。
- [ ] 对有同步标记的现代路径无条件实现投影入口门控和最小完整视图：同步块内 status、ticker、鼠标和主题等绘制只看同来源／同尺寸的上一张完整画面；不存在时显示 loading。在经验证的 CSI 关闭边界复制完成的投影／光标，覆盖“关闭后立即开启下一帧”；不能只在 write 回调检查一次模式值。最小视图含当前可见行、光标、来源和可见范围交互所需元数据；滚动、选择、复制与链接命中必须对应同一完整状态。不逐 chunk 复制整个历史、不反复序列化，继续复用 40ms 输出合并并用既有 perf gate 检查代价；额外历史缓存或接缝扩张须由 P2 证据支持并先修订设计，不以未复现现场现象免除 A3。
- [ ] 尺寸不符时遮住旧尺寸快照，维持一次真实 resize；只有归属于本次尺寸变更的完整重绘可以发布。不得以 applied、下一任意 chunk 或任意一次同步块关闭冒充尺寸就绪。若现有信号无法判明，按下方阻塞条件带证据修订协议方案，不能把该场景跳过后称 issue 已修复。
- [ ] 恢复期使用独立的画面门控，不重复初次 attach 的副作用。同 generation 短断线可保留完整旧画面并标明重连；epoch 更换或新空基线必须使旧画面失效，随后只发布新代次内容。
- [ ] 保留 timer cleanup、首屏强制替换、desync probe、主题桥、颜色探测及 `childInputReady` 队列语义。初次转换至多一次；延迟主题回复仍纳入逐帧检查。组件适配器把保护定时器到期写成当前等待身份的 `deadlineState=expired`，纯决策不读时钟，旧身份／dispose 后到期无效。协议保护超时不得强制展示未完成画面：保留可 detach 的等待／恢复状态并记录未就绪原因，计为失败；legacy 超时行为不变。
- [ ] 无同步标记的旧输出沿用既有保守路径，不伪称具备整帧保证。若缺少帧尾、解析器 API 不支持或首帧无法证明完整，不启用快速路径。
- [ ] 逐项运行失败用例变绿，再检查 U/D 与现有 legacy、resize、scheme 套件；不同时改多个未经证明的根因。

**交付门槛：** 已确认根因的回归变绿，首屏与后续渲染都通过内容断言；候选路径没有再依赖 250ms／2500ms 等待正常忙碌会话。

### Task 5: P5：分场景重复对照

**验收归属：** spec A10、A11；统计函数用已知输入单测，真实时间实验与确定性回归分开。

- [ ] 在独立 baseline／candidate checkout 使用同一套 P2/P3 测量脚本、相同依赖和负载。每格按“候选半批→基线半批→基线半批→候选半批”交错；100 次的半批为 50，30 次的半批为 15，使两版最终各达规定次数。每次使用独立 fixture child／root，创建成本不计入热 attach 的 select 起点；除产品变更外不加候选专属环境开关。
- [ ] 主矩阵在记录好实际模块版本的 fullscreen 环境执行；regular 和实机不同版本另做确定性回归及 P6 实测，不默认将全矩阵与所有版本做笛卡尔积。每格先跑 5 次预热，预热固定排除且单列；B/Q/S/L 各 100 次正式试验，G1/G2/G3/C/R/T/U 各 30 次，baseline 与 candidate 次数相同。D 作为确定性生命周期用例，另跑 30 次泄露检查。按模式／版本分格，禁止混合出总成功率。
- [ ] 首个真实内容之后持续观察至少 3 秒，且直到该次试验安排的主题回复／恢复事件结束；B 必须保持 25ms 连续更新覆盖整个观察窗。性能测量串行执行，不并发争用 CPU。
- [ ] 输出逐次 JSONL、延迟分布、通过次数与 95% 区间；保留所有失败原始输出和事件序列。候选失败先定位同一反例，再测修正后的整格，之前结果不覆盖。主矩阵两版共 1660 次正式试验，仅 3 秒观察窗累计约 83 分钟；另需预热、启动与旧版等待时间，作为批准后执行的工作量说明。

### Task 6: P6：实机验证与交付

**验收归属：** spec A12、U1–U3；实测步骤、候选加载证明和 pending 规则见 spec §7–8。

- [ ] 运行下方定向检查和 `npm run verify`，确认类型、perf gate、测试、coverage 与打包全部通过。
- [ ] 在实际终端、实际加载的 Pi 版本下，用隔离测试会话录制切换过程。fullscreen 下 B/Q/L 各 10 次、尺寸变更／冷启动／恢复各 5 次；regular 模式 B/Q 各 5 次，并确认其差分清理与光标行为。
- [ ] 按 spec §8 的隔离启动契约预检全局开发 symlink（只读，不改指向），核对候选 `index.ts` 的 realpath／commit／哈希；以临时 `PI_CODING_AGENT_DIR`、`--no-extensions` 和显式 `--extension` 绝对路径启动全新试验进程。记录终端／Pi／子进程与依赖的实际解析路径和版本，回读实际资源加载证据；不执行 `pi install`、不更新全局设置。认证／CLI／候选加载证据不足时 U 项 pending，不改用全局安装绕过。
- [ ] 逐帧核对首屏为当前工作区域，无历史位置再跳底、残影或双光标；手动向上滚动后新输出不抢回底部。回到输入框能继续输入，detach／再次 attach 正常。
- [ ] 更新结果文档，分别报告自动化、重复实验和实机证据。实机缺失就标为未验收，不用单测代替，也不宣称整个体验已修复。

## Verification

### 一次成功的定义与计时

一次成功必须同时满足该场景的延迟上限、首屏来源／位置正确、整个观察窗没有错误内容帧、后续输出和输入／detach 正常。撤 loading、`requestRender()` 或首次解析回调均不是成功终点。

使用同一进程的 `performance.now()` 记录下列相对时刻；跨 runner 的事件通过父进程收取后标记，不能直接相减不同进程的起点：

- `select`：用户选择 attach／测试触发相同入口；`overlay`：构造 overlay。两者之差单列，用来识别 `resolveAttachTarget()` 等前置等待。
- `connected`、`snapshotValidated`、`snapshotParsed`：连接、客户端序号校验结束、本地水合解析结束。
- `childFrameComplete`：当前正确代次、目标尺寸的完整画面条件成立；不得从“终于显示了”反推该时刻。无边界信息时记 unknown，不从性能统计里静默删除。
- `renderRequested`、`terminalCommitted`：请求绘制、外层 TUI 完整更新写入 Terminal。后者证明提交给终端的内容，不证明操作系统已把像素显示出来。

报告 `select→terminalCommitted` 的总延迟、`overlay→terminalCommitted` 的呈现延迟、`childFrameComplete→terminalCommitted` 的额外等待。实机录屏独立评估实际呈现；60fps 录屏也不能证明不存在短于一帧的像素闪烁。

### 场景矩阵与目标

下列数字是本计划的工程验收目标，尚未测得。热 attach 的关键目标是总延迟 P95 ≤200ms；尺寸变更和冷启动单列，不能稀释热路径结果。P95 指 95% 样本不超过该延迟；每格还必须满足最大值与零错误帧要求。

| ID | 输入条件／断言 | baseline 与 candidate 每格正式次数 | candidate 延迟目标 |
| --- | --- | --- | --- |
| B | 同尺寸、非空、25ms 持续更新／spinner；首屏为 TAIL＋INPUT，零 resize | 100 | 总延迟 P95 ≤200ms，最大 ≤500ms |
| Q | 同尺寸、非空、之后安静；无下一次输出也能完成首屏 | 100 | 同 B |
| S | 同尺寸同步帧分片；快照截在块内，status/ticker 干扰；同 chunk 关开帧 | 100，分片位置均匀轮换并记录 | 完整帧成立后 P95 ≤100ms、最大 ≤200ms；暂停期间绝不露半帧 |
| L | 超过 60KB 长日志、真实 scrollback／alternate 两个独立子格，中文／emoji，输入区位于底部 | 每个子格 100 | 同 B；首次内容已在正确区域 |
| G1 | host 80×24，overlay body 80×22；一次 resize 到 80×22 | 30 | 总延迟 P95 ≤500ms、最大 ≤1000ms；完整目标帧后 P95 ≤100ms、最大 ≤200ms |
| G2 | host 300×65，body 300×38；复用 #205 溢出判据 | 30 | 同 G1，不能靠展示被截掉的旧屏通过 |
| G3 | 宽度缩小 160→80、高度匹配；验证换行及输入区 | 30 | 同 G1 |
| C | empty baseline＋旧日志毒标记＋先 boot 再完整编辑界面 | 30 | 启动耗时单列；当前完整编辑帧后 P95 ≤100ms、最大 ≤200ms |
| R | 同 generation 断连／新 generation 重启两个独立子格 | 每个子格 30 | 连接和协调耗时单列；有效恢复画面后同 C，旧代次不回流 |
| T | 主题及时回复／延迟不同颜色回复两个独立子格；后续重绘完整 | 每个子格 30 | 初次同 B；延迟回复不重置 loading、不制造错误帧 |
| U | 无同步标记兼容输出；强制 legacy 为独立子格 | 每个子格 30 | 保留原 settle／jiggle；延迟分布单列，不宣称现代协议速度目标适用 |
| D | 解析未完成即 dispose、重复完成事件、旧 token 回调 | 30＋确定性测试 | 关闭后零发布；完成副作用至多一次，无残留 timer/listener |

对 baseline 的错误和超时不设豁免。对 candidate，B/Q/S/L/G/C/R/T 每格必须零产品画面错误并满足对应分布与最大值；U 要求兼容性不退化，D 要求生命周期断言全过。没有已知完整帧时不得以超时强制显示来凑成功。逐次延迟是否通过用表中最大值判断；P95 是整格的额外门槛。P50/P95 使用排序后第 `ceil(p × n)` 项；产品未就绪或试验上限超时在分布中按 `+∞` 计并单列，不能只统计成功样本。每次试验上限 10 秒，baseline 的 2500ms 等待仍须完整观测。

### 自动化与重复实验命令

以下命令只在计划批准、对应文件完成并审阅后执行。重复实验命令是本计划拟新增 scenario 的 CLI，不是当前仓库已有能力；输出目录由执行时创建的临时目录提供。

```bash
node --test test/pty-attach-render.test.mjs test/pty-attach-ready.test.mjs test/attach-ready-report.test.mjs
node --test test/pty-attach-protocol-e2e.test.mjs test/terminal-snapshot.integration.test.mjs
node --test test/pty-attach-scheme-readiness.test.mjs test/pty-attach-settle-scheme.test.mjs test/pty-attach-startup-color.test.mjs
node --test test/pty-attach-desync-health-e2e.test.mjs test/pty-attach-desync-heal.test.mjs
node --experimental-transform-types test-support/pty-attach-ready-scenario.ts --case B --repeat 100 --clock real --artifact-dir "$ATTACH_222_ARTIFACT_DIR"
npm run verify
```

新 scenario 的 `--case` 要支持表内 ID 与子格明确名称，如 `L-normal`／`L-alt`、`R-reconnect`／`R-restart`、`T-on-time`／`T-late`、`U-unframed`／`U-legacy`。依矩阵逐格执行，不能把一个 B 命令当成全矩阵完成。帧断言使用事件和解析 drain；只有 opt-in 重复测量使用真实时间。

### 成功率、失败证据与完成标准

- 每格报告“通过次数／有效试验次数”、P50/P95/最大值、95% Wilson 置信区间；全部尝试数和基础设施失败另列。`100/100` 的 95% 区间下界约 96.3%，`30/30` 约 88.6%，不得据此宣称 99.9% 稳定。该区间基于独立同分布近似；同机时序相关、分片分层和有限环境限制必须注明，不能外推其他环境。
- 全部产品失败保留并分类为延迟、旧内容、半帧、尺寸、底部、光标、主题或生命周期问题。基础设施失败须给独立证据；超过该格尝试数 5% 时整格测量无效，修复设施后重测并保留原批次。
- 失败记录包含 case／trial／版本／模式／尺寸／分片位置、原始 ANSI、单调时间事件、首个错误帧及前后两帧、期望网格和 resize／订阅序列。不记录真实会话隐私内容。
- 自动化观察器证明写给终端的画面；实际终端录屏补充宿主清屏、终端支持与像素闪烁证据。两层均通过才能把“快且不闪”列为已验收；所有数字仅代表已测环境和样本。

## 阻塞与停止条件

若现有协议不能区分完整帧／本次 resize 的完成画面，或重复实验仍出现无法归因的错误，停在证据与失败用例上，说明需要补充的最小信号，修订本计划后重新审阅。不得连续叠加新的等待常数；连续三次基于同一架构的修复假设失败时，转为架构复盘，不进行第四次盲调。实机环境不可用时保留明确的未验收项，不编造成功率。

## 用户确认记录

- 2026-10-21：用户明确要求按 issue-driven 处理，并补独立 spec／design；因此当前回到步 4 补齐设计与交叉复核，已有技术调查和计划保留复用。
- 2026-10-21：用户确认对标对象为 Claude Code 的会话恢复／子代理切换。
- 以“最新回复尾部＋输入区域”作为正常编辑首屏；活动提问界面保持原状。性能目标在最终验收矩阵中明确，不把第三方体感当作已测量的基准。


## Execution Record — 2026-10-23

The user explicitly approved the exact plan above at 2026-10-23T08:20:19+08:00 and ended planning restrictions. Historical statements saying planning is active or design approval is pending no longer apply. All implementation is scoped to `/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-222-attach-ready`; the controller session remains in the main checkout, so every edit uses an explicit worktree path. The approved source remains byte-identical in the issue archive; only task headings and document links are normalized here for the SDD helper. No behavior, acceptance target, trial count, diagnostic gate or publication permission changes.

- Authorization: `/home/elling/.github-issue-driven/zhuxixi/pi-agent-board/issue-222/authorization.md`, Gate: stepwise. Issue claim/comments and execution are approved; commit/push/PR/merge/publish are not.
- Binding constraints: no dependency install/upgrade, no protocol-version change, no global-settings change, no live-session experiment, no manual CHANGELOG edit. Reuse the existing dependency tree.
- P4 is blocked unless P2 establishes sufficient production conditions for #222-A4 and #222-A5. If it cannot, preserve minimal indistinguishable traces and request a reviewed scope revision rather than guessing.
- SDD adaptation: do not commit. Reviews cover tracked diffs plus newly created untracked task files; commit-based packaging helpers cannot alone represent these changes. Parent records exact file lists and hashes.
