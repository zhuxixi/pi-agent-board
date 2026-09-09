# Spec — Issue #91: harden runner architecture (control/data split, acked protocol, single-writer state)

> 状态：DRAFT 待用户确认
> 认领：zhuxixi（2026-09-09）
> 调研：同目录 `research/`

## 1. 问题陈述

pi-agent-board 的 runner 架构在过去两个月里打了一系列看似独立的 bug：#25（jiggle 净零塌陷）、#42（attach 残影 + detach 困死）、#46（auto-state 覆盖手动完成）、#48（EPERM rename 竞态）、#59（detach/teardown 加固）、外加 Windows 控制台家族 #44/#45/#49。issue #42 的根因分析（见 issue 正文）已经证明：这些 bug 不是独立缺陷，而是同一批**架构反模式**的不同症状。

这组问题的共同根因不是单一的「屏幕字节流误用」，而是 runner 缺少四个架构不变量：**状态所有权不唯一、控制命令没有完整生命周期、终端画面没有唯一可重建真相、控制决策仍可能从渲染结果推测**。显示字节流被当作控制真相，只是其中最容易暴露的一类。

本 spec 的目标不是再修一轮 bug，而是把架构从「隐式语义」（从字节流猜状态、从文件时间戳猜顺序、从进程存活猜健康）升级为「显式语义」（结构化消息、唯一 owner、版本/命令 ID、ack、canonical terminal snapshot），并为每个不变量建立自动化验证。只有当同类故障在设计上失去发生前提，才称为根治；降低触发概率或增加一次重试不算根治。

## 1.5 为什么现在做：基于最新代码的诚实收益评估

**先说结论：那些 bug 确实都修了，当前版本是稳定的。但修复方式决定了未来的成本结构——这个加固是战略投资，不是紧急修复。** 是否做，取决于你对 pi-agent-board 未来方向的判断。本节把收益论证讲清楚，供你决策。

### 当前修复的模式：加守卫，不是消除反模式

查证了每个 bug 的修复 commit，修复方式有一个共同模式——**在现有架构内加守卫**，让 bug 的触发概率降低、触发后能自愈，但架构反模式本身一个都没被消除：

| Bug | 修复 commit | 修复方式 | 没有改变的架构反模式 |
|---|---|---|---|
| #25 净零塌陷 | 85cf119 | shrink-and-hold 协议（缩住不放直到看到 clear） | 仍然是「发 resize 命令然后观察字节流猜结果」——发射后不管 |
| #42 残影+困死 | da42aed（PR #59），后续还有 #68/#89 | G6 守卫、`editor_state` 侧信道、显式 Ctrl+Left 逃生键、socket 身份守卫 | 当前版本已经显著降低风险，但 attach 仍有本地终端影子 buffer，`←` 在 `editorEmpty === null` 时仍会回退到 `childInputLooksEmpty()` |
| #46 状态覆盖 | 916d784 | `persistUnlessManual()` 守卫 + `isManualCompletion()` 检查 + 调整写入顺序 | job-runner/state-runner/service 仍可直接写 state/status；迟到结果只能靠每个写入点继续检查 |
| #48 host 竞态与 EPERM | ab5fcfd（PR #50）及 issue #70 / PR #84 | crash finalization、rename 重试、instanceId fencing、owner-fenced host 写入 | host 生命周期已经有 owner 协议；但 view state/status 尚未统一由一个逻辑 owner 管理，Windows 的文件共享限制也不会因单写者自动消失 |

### 守卫的累积复杂度（代码实证）

这些修复的代价是复杂度累积，每个守卫都是一段特殊场景的处理逻辑：

- **jiggle 控制器**已有 G1–G6 六个守卫（`pty-attach-jiggle-controller.mjs` 279 行），注释里详细记录了每个守卫对抗的具体失败模式。如果未来出现第 7 种失败模式（新终端模拟器、pi-tui 改版渲染行为），就需要加 G7。这是「打地鼠」模式。
- **`childInputLooksEmpty()`**（`pty-attach.ts:355`）已经历 #66/#69 两轮补丁：先用光标行猜测（#42 发现不可靠），改为 fake-cursor 反色单元格锚定（#66），再加 fallback 扫描空 prompt-glyph 行（#69）。函数注释自己承认「The terminal cursor is not a reliable anchor for the editor line」。这个函数的本质是**在猜一个它物理上无法知道的事实**，每一轮补丁都在增加猜测规则。
- **`isManualCompletion()`** 在 job-runner.mjs 里被检查 8 次——每次写状态前都要检查「这是不是手动完成」。如果未来出现新的写者（新插件、新 dashboard 功能），就需要在新的写入点再加同样的检查。

### 收益是什么：三个未来场景

如果 pi-agent-board 不再加新功能、不做多机模式、团队稳定，当前修复确实够用，这个加固的必要性不高。收益体现在以下三个未来场景：

**场景一：多机 fleet 模式（issue #91 的战略注记，也是最大的收益）。** 跨网络 attach 的抖动、延迟、断连比本地 PTY 严酷得多。当前的「fire-and-forget + 守卫」模式在本地 PTY 上已经需要 6 个守卫来对抗合并窗口；在跨网络环境下，守卫数量会爆炸。生命周期化 ack + canonical terminal snapshot 是多机模式的**前提条件**，不是可选优化。如果不做这个加固，多机模式启动时会撞到同一批问题，且严重程度高一个数量级。

**场景二：新功能的开发成本。** 每次新增控制命令（比如未来的「暂停/恢复」按钮）、新增状态展示（比如「当前 token 用量」「当前模型」），在现有架构下都要回答「怎么从字节流猜出这个状态」「会不会和现有守卫冲突」。在显式协议下，新功能是「加一个消息类型 + 加一个状态字段」，不需要猜。开发成本从「小心地在守卫迷宫里找位置」变成「在协议上直接实现」。

**场景三：认知负担与新人上手。** G1–G6 守卫、`childInputLooksEmpty()` 的两轮补丁、`isManualCompletion()` 的 8 处检查——这些是新贡献者（和半年后的自己）要理解的特殊场景。架构加固把「6 个特殊守卫 + N 处竞争检查」变成「1 个统一协议 + 0 处竞争检查」，认知负担大幅降低。

### 诚实的反面

如果以上三个场景都不发生——不做多机模式、不再加新功能、维护者稳定——那这个加固的必要性确实不高。它不改用户体验（bug 已修），只改内部结构。**这是一个「还技术债 + 为未来铺路」的决策，不是「现在不修就出事」的决策。** 合理的做法可以是：暂时搁置，等多机模式启动或新功能开发受阻时再回来做——届时这个 spec 可以直接用。

## 2. 四个反模式与「为什么能根治」论证

本节是核心：对每一个反模式，论证对应原则为什么能**根治**而非**缓解**。

### 2.1 反模式一：屏幕语义启发式当控制真相（#42）

**现状**：`src/ui/pty-attach.ts:355` 的 `childInputLooksEmpty()` 通过解析终端字节流、猜测光标所在行来判断「子进程输入框是否为空」，进而决定 `←` 是 detach 还是转发给子进程；当前 `Ctrl+Left` 已经提供了无条件逃生路径，但普通 `←` 仍把这个猜测作为门禁条件。

**为什么启发式必然不可靠**：终端字节流是渲染输出，不含「输入缓冲区是否为空」的语义。光标行只是视觉位置，与子进程编辑器的输入缓冲区状态之间**没有因果绑定**——子进程完全可以在光标位于底部时持有非空输入（例如流式输出把编辑框顶上去）。启发式是在「猜」一个它物理上无法知道的事实。

**原则 1（控制面/数据面分离）为什么根治**：控制决策改由子进程通过**结构化侧信道**显式上报状态（例如 `{"inputBufferEmpty": true, "busyThinking": false}`），决策源从「猜」变成「读」。字节流回归纯渲染用途。根治的机理是**删除猜测环节**——不是改进启发式让它猜得更准，而是让猜测在架构上不再必要。`childInputLooksEmpty()`、光标行启发式、Working-row 检测这一类函数被**删除**，不是被改良。

### 2.2 反模式二：双写者状态竞争（#46/#48）

**现状**：`store.mjs` 的 `writeState()`/`writeStatus()` 用原子写（temp 文件 + rename）保证单文件不损坏，但被多个进程调用：`job-runner.mjs`、`state-runner.mjs`、`pty-runner.mjs`、dashboard 进程都 import 了这对函数。多写者之间是 last-write-wins。

**为什么原子写不够**：原子写解决的是「写一半」的物理损坏，不解决「写错值」的逻辑覆盖。#46 的实例：用户手动标记完成后，auto-state 的模型结果迟到，把 `semanticState` 从 `completed` 覆盖回 `in_progress`——文件没坏，但值错了。

**原则 3（每个 artifact 一个逻辑 owner）为什么根治**：不能只写成「runner 是唯一写者」，而要明确每类持久化状态的唯一权威：`state.json/status.json` 由每个 board root 的 detached **View State Coordinator** 管理；`host.json` 由当前 `instanceId` 对应的 PTY runner 管理，恢复写入继续使用已有 owner fencing；终端 snapshot/output 由 PTY runner 管理。dashboard、job-runner、state-runner 和 CLI 只能提交带 `commandId`、`runId`、`expectedRevision` 的命令或事件，不能直接调用 `writeState()` / `writeStatus()`。

Coordinator 串行消费命令，先把命令以可重放的 journal 记录下来，再物化 state/status。人工完成会建立 manual-decision fence；旧 `runId`、旧 `expectedRevision` 或低优先级的 auto-state 结果被拒绝。根治的机理不只是把并发写入排成队列，而是同时消除**多进程直接写入**和**迟到命令覆盖新状态**两个前提。

### 2.3 反模式三：发射后不管的控制（#25/#42/#59）

**现状**：resize/hold/restore 命令发到 control socket 后无应答。发送方不知道命令是否被应用、应用成了什么样。#42 根因：shrink-and-hold 的 frameStart 快速通道一看到任何 TUI 帧就 restore，restore 与 shrink 在子进程侧被 pi-tui 的 16ms 渲染节流合并成**净零尺寸变化**，子进程渲染时看不到宽度差、不触发 fullRender，发送方却以为兜底已经生效。

**为什么会塌陷**：控制命令的语义是「请把 PTY 改成 X」，但发送方无法确认「PTY 现在确实是 X」。事件循环合并是接收方的内部实现细节，发送方无从观察。失败是**静默**的——没有任何信号告诉发送方「你的 shrink+restore 被合并成了净零」。

**原则 4（带明确生命周期的控制协议）为什么根治**：每个命令携带 `clientId`、稳定的 `commandId` 和连接内递增的 `seq`，但 ack 不再笼统地声称「已经完成」。协议区分 `accepted`（runner 收到并验证）、`applied`（底层动作已调用）和 `observed`（有结构化证据证明目标状态已被观察到）。`resize` 至少确认实际 PTY 尺寸；`input` 只确认写入已接受，不能伪称子 pi 已处理；`terminate` 和 `detach` 明确定义幂等完成条件。

超时、重连和重复命令按命令类型执行明确的 retry/dedup 策略。根治的机理是**消除静默失败和含义不清的成功**，但不把 ack 冒充成渲染完成证明。attach 画面不再依赖 resize/clear/jiggle 来获得正确状态，而由 canonical terminal snapshot 提供；issue #70/PR #84 已经落地的 instanceId fencing 和 input ack 是本原则的已有地基。

### 2.4 反模式四：影子终端状态没有唯一、可重建的真相（#25/#42/#59）

**现状**：PTY runner 收到 child 的输出并写入 `screen.log`，dashboard attach 后再从尾部字节硬切，写入自己的 `@xterm/headless` surface buffer。这个 buffer 是第二副本，但没有 snapshot cursor、输出 sequence 或完整的恢复协议；jiggle 只是用 resize 逼迫 child 重新输出，不能证明本地 buffer 已经正确。

**为什么现有重放必然存在边界漏洞**：`screen.log` 是 append-only 字节流，从 60KB 中间切入可能落在 CSI/OSC/相对光标帧中间；即使切点恰好完整，也存在读取 `screen.log` 与订阅 socket 之间的 gap/重复竞态。因此「重放最后一次 `\x1b[2J`」也不能作为严格恢复协议：full clear 是输出序列，不是可版本化的终端快照。

**原则 2（canonical terminal state + snapshot/subscribe）为什么根治**：PTY runner 使用成熟终端状态机持续消费 child output，并作为该 view 的唯一终端状态 owner；每个输出片段分配单调递增 `outputSeq`，按一致性规则生成可传输的 `TerminalSnapshot`。attach 请求得到 snapshot 及其 `snapshotSeq`，随后只消费 `snapshotSeq` 之后的输出；runner 必须保证 snapshot 与订阅之间无 gap、无重复。断线恢复时丢弃 dashboard 本地 buffer，重新请求 snapshot，不再依赖 `screen.log` 的硬切或 jiggle 的偶然 clear。

影子 buffer 仍可存在，但只作为可丢弃的渲染缓存；损坏时从 canonical snapshot 重建，因而「残影是否能被某次 resize 治愈」不再是系统正确性的前提。`screen.log` 保留为调试和兼容产物，不再是 attach 正确性的唯一数据源。

### 2.5 组合逻辑：为什么这套组合（而非单个原则）能根治

四个原则各自消除一类 bug 的物理前提：

| 原则 | 消除的物理前提 | 对应 bug 类 |
|---|---|---|
| 1 控制/数据分离 | 「从字节流猜状态」这个环节 | #42 的 detach 困死、Working-row 误判 |
| 2 canonical terminal state | 「影子副本成为唯一画面真相、重放与实时流出现 gap/重复」 | #25/#42/#59 的塌陷和残影 |
| 3 每个 artifact 一个 owner | 「多进程直接写同一份逻辑状态、迟到结果覆盖新状态」 | #46/#48 的状态覆盖和生命周期竞态 |
| 4 生命周期化 ack | 「控制命令的 accepted/applied/observed 含义不清、失败静默」 | resize/terminate/reconnect 类问题 |

组合起来的深层逻辑是：把**隐式语义**全部变成**显式语义**——状态由结构化侧信道上报；画面由唯一 terminal owner 维护；状态 mutation 通过带版本的 command journal 串行应用；控制命令按生命周期确认。根治的本质是：**同类 bug 的发生前提被移除，而不是只为已知时序增加新的守卫**。

D5（成熟终端状态机）是 D2 的实现约束；D6（Windows 默认 JSON-runner）是独立的平台策略，不属于 #91 核心根治闭环。

## 3. 设计决策

### D1: 控制面走结构化侧信道，数据面只用于渲染

- 沿用当前已经存在的 `editor_state` reporter/socket 消息，不再把 status RPC 作为本 issue 的前置条件。
- `←` 的决策只读取 `editorEmpty`：`true` 才 detach，`false` 转发给 child，`null` 不得回退到终端 buffer 启发式，而是按明确的保守策略转发。
- `Ctrl+Left` 是不依赖 child 状态的显式逃生键，始终请求 detach；socket 已断开时 `←` 和 `Ctrl+Left` 都直接结束 attach surface。
- `busyThinking`、`editorMode` 等字段只有在真实 producer 已定义并经过版本协商后才能加入，不能为了填充结构化侧信道而制造未经验证的状态字段。
- `childInputLooksEmpty()`、光标行扫描和 Working-row 检测从 detach 控制调用链删除；字节流只服务于渲染和诊断。

### D2: attach 使用 canonical terminal snapshot + sequence subscribe

- PTY runner 内部使用 `@xterm/headless` 或等价成熟终端状态机消费 child output，维护该 view 的 canonical terminal state。
- canonical state 是 **runner 生命周期内的内存状态**，不做跨重启持久化。依据（已验证代码）：runner 的所有退出路径（正常 shutdown、terminate、uncaughtException handler）都会杀 child；service 的 recoverHost 按进程身份清理孤儿 child 后 spawn 全新 runner + 全新 child，pi TUI 全新渲染——「runner 重启后恢复旧终端画面」的场景不存在。若未来支持 runner 滚动升级且 child 保活，再引入持久化（DTO 已版本化，可兼容扩展）。
- 每个 output chunk 分配严格递增的 `outputSeq`；runner 维护有限的内存 sequence ring buffer，并按请求从当前 parser 状态生成 `TerminalSnapshot`（snapshot 即时生成，不需要定期物化）。
- `TerminalSnapshot` 至少包含：协议版本、view/host instance、cols/rows、snapshotSeq、屏幕网格（字符与属性）、cursor、必要的终端 modes/scrollback 边界。格式必须是独立于 xterm.js 私有对象的可版本化数据结构。
- canonical state 崩溃即随 runner 销毁，不需要 journal 重放：child 与 runner 同生死，崩溃后的画面恢复由新 child 的全新渲染负责。
- attach 请求使用原子 capture-and-subscribe 流程：runner 先登记待发送客户端、捕获 `snapshotSeq`，再发送 snapshot 和该 cursor 之后的增量，最后切换到 live。capture 与 subscribe 之间到达的 output 必须暂存在 ring 中，不能丢失；协议要定义 snapshot begin/end 或等价边界，客户端只在完整 snapshot 校验通过后替换本地 buffer。
- 若所需增量已经超出 ring buffer，runner 返回新 snapshot；若 sequence 不连续、snapshot 版本不支持或 parser 状态不可恢复，客户端必须重新 snapshot，而不是自行拼接。
- UI 的本地 terminal buffer 只是缓存。断线恢复、sequence gap 或 parser error 都丢弃本地 buffer，重新获取 snapshot。
- runner 重启后的 attach 语义：新 child 渲染前 canonical state 为空（显示「host starting」占位）；新 child 的首次输出建立新 snapshot 基线。不要求恢复旧画面。
- snapshot 投递的两条实现路线作为**开放决策**留到 plan 阶段原型对比：（A）版本化 DTO + UI 侧显式 hydrate 适配器；（B）runner 从 canonical state 合成一条全量重绘字节帧（类似 child fullRender，但由 runner 生成），UI 原样喂给现有 xterm。路线 B 代码量小、完全复用现有 UI 管线，但 scrollback/modes 保真度弱于 DTO。
- `screen.log` 保留为调试/历史产物（跨重启可见历史）；它不是 attach 正确性的来源，attach 协议中的 `snapshot` 请求不读取 `screen.log`。

### D3: 每个持久化 artifact 只有一个逻辑 owner

- `state.json` 和 `status.json` 的唯一逻辑 owner 是每个 board root 的 **detached View State Coordinator**。它是独立于 dashboard/service 生命周期的常驻进程；service 只能负责发现、启动、连接和提交命令，不能复用自身进程直接物化状态。dashboard、job-runner、state-runner 和 CLI 都不能直接写。
- `host.json` 的唯一 owner 是当前 `instanceId` 对应的 PTY runner；现有 instance fencing、owner-fenced update 和 legacy recovery 继续保留。服务层不得绕过 owner 直接 `writeHost()`。
- terminal snapshot/output 由 PTY runner owner 管理；每个 job 的 `events.jsonl` 可以由该 job-runner 追加，但语义 state 的物化必须通过 coordinator。
- 所有**语义状态 mutation**通过控制 socket/可靠本地队列提交，命令至少带 `commandId`、`viewId`、`runId`（适用时）、`source`、`expectedRevision` 和 `payload`。非 owner 进程不得 import 生产代码中的 `writeState()` / `writeStatus()` / 无 fencing 的 `writeHost()`。瞬时 PTY 控制（例如高频 resize）不必进入 View State journal，但必须返回明确的 `applied` 结果和实际尺寸。
- 对需要跨进程重放的状态命令和 durable follow-up，`accepted` 只能在命令追加到 durable journal 并完成所需的 flush 后返回；若只进入内存队列，必须使用不同的 `queued` 状态，不能伪称 accepted。
- Coordinator 是 board root 级别的 detached 单例进程，必须使用 instance/lease 防止两个 coordinator 同时成为 owner，并能在旧 coordinator 退出后安全接管。`state.json/status.json` 的生产写入只能发生在 coordinator 进程内；dashboard/service 退出或 reload 不影响它继续处理已接受的命令。
- Coordinator 串行应用命令，并按「先追加 durable journal 并完成 flush、再更新 materialized state、最后记录结果」的顺序处理；`state.json` 与 `status.json` 写入共同携带同一个 `materializedRevision`/`journalId`。**revision 一致性的适用范围**：只比较 state.json 与 `currentRunId` 对应的 status.json；无 currentRunId 时 state.json 单独成立。读取方发现这对 revision 不一致时，必须丢弃这次组合并请求 coordinator reconciliation，不能把两份文件拼成一个状态。**legacy 迁移**：改造前创建的行没有 revision 字段，coordinator 首次接管该 view 时 bump 并写入初始 revision。coordinator 重启时修复不完整的物化对。已处理的 `commandId` 返回原结果而不重复执行副作用。journal 需要 checkpoint/GC，但 GC 只能在 materialized state 和 checkpoint 成功后进行。
- 人工完成建立 manual-decision fence；旧 run、旧 revision 和低优先级 auto-state 命令被拒绝并记录 diagnostic。job-runner/state-runner 可以继续生成 evidence 或分类结果，但不能直接物化语义 state/status。
- 原子写和 Windows rename retry 保留：它们解决文件物理完整性和共享冲突，不被误称为解决逻辑 ownership。
- **已知例外**：`meta.json` 的 title-runner 条件写（仅当 name==fallbackName）与 dashboard 手动改名/归档仍是多写者；冲突窗口极小、影响限于标题被覆盖，列为本 issue 的已知可接受残留，后续可纳入 coordinator。架构边界测试需把它显式列为豁免项并附此理由。

### D4: 控制 socket 使用带生命周期的 ack 协议

可靠控制命令包括 `input`（仅 durable follow-up）、`terminate` 和 `reconcile`；瞬时控制包括 `resize`、普通键盘 `input`、`interrupt` 和 `detach`。attach 的 shrink-and-hold 不再作为新协议的独立控制命令。需要可靠交付的命令使用稳定的 `commandId`，瞬时控制也携带 commandId 以便关联 ack；所有命令携带 `clientId`、连接内递增 `seq`、`viewId` 和当前 `instanceId`。`seq` 只负责连接内排序，重试和重连去重必须依赖稳定的 `commandId`，不能只依赖 `seq`。

ack 明确区分三个阶段，不能用一个 `ack` 同时表示三种含义：

- `accepted`：对需要 durable 交付的命令，runner 已验证协议、owner 和参数，并已把命令写入 durable command journal；瞬时命令不发送这个阶段；
- `applied`：runner 已执行底层动作，返回实际应用值（例如 PTY 当前 cols/rows）；
- `observed`：只有存在结构化观察证据时才发送，例如 snapshot 已包含目标 `outputSeq`。普通 `resize` 不能因为调用了 `child.resize()` 就伪称 child 已完成渲染。

命令类型必须声明各自的交付语义：

| 命令 | 完成语义 | 重试/去重规则 |
|---|---|---|
| `input` / durable follow-up | `accepted` 表示 owner 已记录并接受命令；`applied` 才表示已调用 child write；任何阶段都不宣称 child 已处理 | durable follow-up 用 request/command ID 去重；普通键盘输入不在断线后盲目重放 |
| `resize` | `applied` 返回 runner 记录的实际 PTY 尺寸；不宣称 child 已完成渲染 | 同一 `commandId` 重复请求返回已有结果；同一客户端的新尺寸可按 latest-wins 处理，被取代的命令收到终态 `superseded`（含 `byCommandId`） |
| `terminate` | `applied` 表示终止流程已启动；`observed`/最终结果在 child exit 或 runner 生命周期状态确认后发送 | 幂等；重复请求返回当前生命周期状态 |
| `detach` | attach client 已接受 detach，或 socket 已关闭；不改变 child 生命周期 | 幂等；不把 socket write 成功当成 child 状态变化 |
| `reconcile` | 返回 host revision、命令结果、state materialized revision 和 terminal snapshot cursor | 不改变 child 状态，只建立客户端基线 |

客户端超时不能自行假设失败：它必须先用 `commandId` 查询结果或执行 reconciliation，再决定是否重试。重连顺序固定为 `hello → reconcile → 建立 snapshot/subscribe → 恢复可重试命令`。issue #70/PR #84 已有的 instanceId fencing 和 input ack 是这个协议的已有地基。

### D5: 用成熟终端状态机维护 canonical terminal state

- 复用 package.json 已有的 `@xterm/headless`（或经过明确评估的等价 vt100 库），由 PTY runner 消费完整、按顺序到达的 child output；不在 UI 侧重复实现一套终端解析器。
- snapshot 序列化必须使用项目自有的版本化 DTO，不得直接持久化 xterm.js 私有对象；必须测试分片 CSI/OSC、相对光标、滚屏、属性、cursor 和 snapshot hydrate。
- 删除手写光标行猜测、screen.log 帧边界猜测等控制/恢复启发式；终端 parser 只负责渲染状态，不负责决定 detach 或语义状态。

### D6: Windows 默认 JSON-runner，PTY 模式为 opt-in 实验特性

- Windows 平台默认使用 job-runner（JSON 模式，结构化、零 PTY 坑）。
- PTY 模式在 Windows 上需显式 opt-in（环境变量或配置）。
- 文档明确平台策略：Linux/macOS 默认 PTY，Windows 默认 JSON。

## 4. 数据流与所有权（改造后）

```text
child PTY output
  → PTY runner 解析并更新 canonical terminal state
  → 分配 outputSeq + 内存增量 ring
  → 写 screen.log（历史/调试产物）

attach dashboard
  → request snapshot
  ← snapshot(snapshotSeq) + 从 snapshotSeq 之后开始的增量订阅
  → gap / parser error / disconnect 时丢弃本地 buffer，重新 hydrate snapshot

job-runner / state-runner / dashboard service / CLI
  → View State Coordinator command socket（语义 state owner）
  ← queued/accepted/applied/rejected ack
  → Coordinator journal（唯一逻辑写者）
  → state.json + status.json（唯一物化写者）

attach dashboard / host service
  → PTY runner control socket（terminal/host owner）
  ← accepted/applied/observed ack

PTY lifecycle / host.json
  → 当前 instanceId 对应的 PTY runner（已有 fencing）
  ← dashboard/service 只能发 host command，不能直接写 host.json

任意控制命令
  → commandId + seq + instanceId
  ← accepted → applied（必要时）→ observed（有证据时）
```

### 根治完成条件

#91 只有在以下不变量全部成立时才算完成，单独新增 ack、snapshot 或测试不能宣称根治：

1. 生产代码中每个持久化 artifact 都只有一个逻辑 owner，非 owner 没有直接写路径。
2. 所有可延迟到达的状态 mutation 都带 `commandId`、适用的 `runId`/`expectedRevision`，manual fence 和 stale rejection 可重放验证。
3. attach 画面可从 runner-owned `TerminalSnapshot` 独立恢复；snapshot/subscribe 在 runner 生命周期内经受 gap、重复、重连测试；runner 重启后 attach 由新 child 的全新渲染建立新基线，不要求恢复旧画面。
4. 控制协议明确每种命令的 accepted/applied/observed 与 retry/dedup 语义，任何 ack 都不夸大成功含义。
5. `state.json` 与 currentRunId 对应 `status.json` 的物化 revision 一致（无 currentRunId 时 state.json 单独成立），coordinator 崩溃后能从 journal 修复不完整物化。
6. detach 控制路径不读取 terminal buffer 启发式，并始终保留明确、可验证的逃生路径。

## 5. 降级与兼容

- **`editor_state` 暂时没有 producer**：`editorEmpty === null` 时不回退到终端 buffer 启发式；`←` 按保守策略转发，`Ctrl+Left` 始终可逃生。非 pi 子进程使用同一策略。
- **snapshot ring buffer 不足**：runner 返回新的完整 snapshot，客户端不得从不完整的字节尾部自行拼接。
- **旧版 dashboard 连接新版 runner**：协议版本协商。旧客户端可以保留兼容的 fire-and-forget 路径，但只能标记为 legacy，不能作为新协议正确性的验收路径；新客户端必须使用 `commandId` 和 reconciliation。
- **旧版 runner 连接新版 dashboard**：dashboard 检测能力缺失，显示降级状态并使用显式逃生键；不能宣称拥有 snapshot/ack 保证。
- **Windows rename/EPERM**：保留现有 retry 和错误诊断；单写者只解决逻辑竞争，不承诺消除文件系统共享限制。

## 6. 非目标与拆分边界

- 不重写整个 runner；但为了建立 canonical terminal state，PTY runner 的输出消费和 attach 协议需要增量改造，不能以保留 jiggle 为代价假装完成。
- 不改动 pi-tui 的渲染管线；本 issue 只负责观察 PTY 输出和维护 runner 侧 canonical state，不要求 child 提供 full-render 回调。
- 不引入外部服务（数据库、消息队列）；command journal、snapshot 和本地 socket 保持在文件系统/本地进程边界内。
- 不把 `events.jsonl` 的 agent 语义事件误称为终端渲染事件；两者可以关联，但 terminal snapshot 必须由 PTY output parser 产生。
- Windows 默认 JSON-runner 是独立的平台策略，不作为本 issue 的核心实施和合并阻塞项；如要改变默认模式，应另开 issue 并单独验收。

## 7. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | 命令生命周期与稳定去重 | 自动化验证（unit） | `node --test test/control-protocol.test.mjs`：验证 `commandId` 跨重连稳定、`seq` 仅负责连接内排序、accepted/applied/observed 语义和各命令 retry policy | 可幂等命令的重复/迟到请求不会产生第二次副作用；非幂等 input 不会被客户端盲目重放；ack 不夸大完成语义 |
| A2 | 控制重连对账 | 自动化验证（integration） | `node --test test/control-reconcile.integration.test.mjs`：断线后执行 `hello → reconcile → snapshot/subscribe`，再恢复可重试命令 | 对账结果、host instance、terminal cursor 与 runner 一致 |
| A3 | editor_state 缺失时不回退屏幕启发式 | 自动化验证（unit + static） | `node --test test/pty-attach-detach-gate.test.mjs` + `rg "childInputLooksEmpty" src/ui/pty-attach.ts` | `editorEmpty=null` 使用明确保守策略；detach 控制调用链无 `childInputLooksEmpty()` |
| A4 | canonical terminal snapshot 可重建 | 自动化验证（unit） | `node --test test/terminal-snapshot.test.mjs`：用分片 CSI/OSC、相对光标、滚屏、属性和 cursor fixture 生成 snapshot，再 hydrate 到独立 parser/model | hydrate 后的版本化屏幕模型与 runner 模型等价 |
| A5 | snapshot/subscribe 无 gap、无重复 | 自动化验证（integration） | `node --test test/terminal-snapshot.integration.test.mjs`：在 snapshot capture 与 subscription 建立之间注入 output，验证 sequence 连续且每个 chunk 只出现一次；ring 溢出要求重新 snapshot | 客户端永不静默丢失或重复输出 |
| A5c | runner 重启后的 attach 基线 | 自动化验证（integration） | `node --test test/terminal-snapshot.integration.test.mjs`：重启 runner（新 child）后 attach | 首个 snapshot 来自新 child 的全新渲染；不尝试恢复旧画面 |
| A5b | snapshot DTO 可独立 hydrate（路线 A 时适用；若 plan 阶段选路线 B，则改为验证合成全量帧渲染等价） | 自动化验证（unit） | `captureTerminalSnapshot()` / `hydrateTerminalSnapshot()`，禁止比较 xterm.js 私有对象引用 | hydrate 后屏幕网格、属性、cursor、modes 和尺寸等价 |
| A6 | dashboard buffer 可丢弃恢复 | 自动化验证（integration） | `node --test test/terminal-reconnect.integration.test.mjs`：污染/丢弃本地 buffer、制造 sequence gap 后重新 hydrate | 恢复结果来自 canonical snapshot，不依赖 screen.log 硬切或 jiggle clear |
| A7 | View State Coordinator 单一逻辑写者 | 自动化验证（static + integration） | `node --test test/view-state-coordinator.integration.test.mjs test/architecture-writer-boundary.test.mjs`：静态边界测试检查生产写入入口 | 除 coordinator 外无 `writeState/writeStatus` 生产调用；所有语义 mutation 带 commandId/revision；state/status 共享 materialized revision |
| A7b | Coordinator 接管与 journal 重放 | 自动化验证（integration） | `node --test test/view-state-coordinator-failover.integration.test.mjs`：旧 coordinator 退出、第二实例接管、重放已处理和未处理命令 | 同一时间只有一个 owner；已处理 commandId 不重复产生副作用；物化状态可恢复 |
| A8 | stale auto-state 不能覆盖人工决定 | 自动化验证（integration） | coordinator 测试：manual completion 后注入旧 runId、旧 revision、迟到 auto-state，重启 coordinator 后重放 journal | `completed` 和 manual fence 保持，拒绝结果有 diagnostic |
| A9 | host fencing 与 Windows rename 边界 | 自动化验证（unit + integration） | 复用 `host-owner-store` / `host-concurrency` 测试，增加 rename retry failure injection | stale instance 不可写；EPERM 只按 retry/显式失败处理，不被宣称已由单写者消除 |
| A11 | 终端模型性能 | 自动化验证（benchmark 型 integration） | `node --test test/terminal-model-perf.test.mjs`：12.5fps 输出流持续 60s，测量 parser lag、snapshot 生成延迟、ring overflow 行为 | parser lag 和 snapshot 延迟有明确上限（阈值在 plan 阶段定），ring overflow 触发新 snapshot 而非丢数据 |
| U1 | attach 热 session 无残影 | 用户实测 | 在流式输出进行中的 session 上反复 attach/detach 10 次 | 未出现编辑器框体错位/杂散字符 |
| U2 | 显式逃生键稳定可用 | 用户实测 | 分别在 `editorEmpty=true/false/null`、socket 断开时按 `←` 和 `Ctrl+Left` | `Ctrl+Left` 10/10 次离开 attach；`←` 按协议处理，不依赖 ↑↓ 治愈 |
| U3 | 断线恢复画面 | 用户实测 | attach 后制造 runner reconnect 或网络断开，再恢复连接 | 画面恢复，无明显缺行、重复或半帧乱码 |

可测性拆分设计见第 9 节。

## 8. 迁移顺序（按架构不变量分阶段）

1. **先锁定现有行为和协议边界**：把 `editor_state`、Ctrl+Left、host fencing、input ack 的当前行为写成回归测试；明确 legacy client/runner 的降级能力。
2. **建立 detached View State Coordinator（D3）**：先实现 root-level lease/接管和 command socket，再迁移 `markCompleted`、auto-state 和 run finalization 三类状态 mutation；引入 `commandId/runId/expectedRevision/manual fence` 和共同 materialized revision，再禁止生产代码绕过 coordinator 写 state/status。此阶段直接根治 #46 类 stale overwrite。
3. **建立 canonical terminal model（D2 + D5）**：PTY runner 消费 child output，维护版本化 TerminalSnapshot、parser-safe cursor 和内存 ring buffer；先完成 snapshot 生成/hydrate 单测，再接入 runner 的 capture-and-subscribe 协议。
4. **切换 attach 为 snapshot + subscribe**：先实现无 gap/无重复的协议测试（含 runner 重启后新基线），再切 UI；切换完成后删除 screen.log tail replay 作为正确性路径和 shrink-and-hold 的强依赖。jiggle 可在兼容期保留为诊断/旧 runner fallback，但不能作为新协议成功条件。
5. **补齐控制生命周期（D4）**：对 transient 和 durable 命令分别定义 accepted/applied/observed 与 retry/dedup；与 snapshot cursor、host instance reconciliation 集成。
6. **最后删除控制启发式（D1）**：去掉 `childInputLooksEmpty()` 及其测试/调用链，保留 `editor_state` 和显式逃生键。
7. **D6 Windows 默认 JSON-runner**：另开平台策略 issue 或作为独立后续阶段，不阻塞 #91 核心治理。

每个阶段必须先通过自身验收矩阵，再进入下一阶段；没有 snapshot/subscribe 和唯一 owner 的阶段，不能宣称 #91 已根治。

## 9. 可测性拆分设计（硬约束）

实现阶段必须保持以下拆分，不得把已拆分的逻辑重新耦合：

- **控制协议层**（纯函数）：`encodeCommand(command)`、`decodeAck(message)`、`classifyCommandCompletion(command, observation)`、`retryPolicy(command, history)` —— 明确 commandId、seq、accepted/applied/observed 和命令类型语义，覆盖 A1。
- **对账层**（纯函数 + 薄副作用）：`buildReconcileRequest(state)`、`mergeReconcileResult(local, remote)`、`resumeRetryableCommands(history, capabilities)` —— 副作用（发 socket）由调用方管，覆盖 A2。
- **侧信道决策层**（纯函数）：`parseEditorState(message)`、`deriveDetachDecision(editorEmpty, connected, key)` —— 输入结构化消息，不读取 terminal buffer，覆盖 A3。
- **终端模型层**（纯函数边界 + 注入 parser）：`feedTerminalOutput(model, chunk)`、`appendOutputRing(seq, chunk)`、`captureTerminalSnapshot(model, cursor)`、`applySnapshotToUi(snapshot)`、`applyOutputAfter(snapshot, chunks)` —— 内存 ring、parser I/O、snapshot 序列化和 UI socket transport 分离，覆盖 A4/A5/A6。
- **snapshot/subscribe 协议层**（注入 transport）：`captureAtCursor()` 必须返回 snapshot cursor 和之后的增量边界；用 fake transport 注入 capture/subscribe 间的 output，覆盖 A5。
- **View State Coordinator**（串行副作用层）：`validateCommand(command, currentState)`、`decideStateTransition(command, currentState)`、`appendJournal(command, result)`、`materializeState()` —— 决策函数不碰文件，journal/materialization 由唯一 owner 执行，覆盖 A7/A8。
- **host owner 层**：复用 `updateOwnedHost` / instance fencing 纯决策边界；Windows rename 的错误注入由 store 层测试，覆盖 A9。

## 10. 风险与开放问题

- **terminal snapshot 的序列化边界**：xterm.js 私有 buffer 不能直接当持久化格式，需要明确 DTO、版本迁移和属性/mode 的最小闭包；否则 parser 换版仍会制造新的恢复 bug。
- **ring buffer 与 snapshot 节奏**：内存 ring 的大小和 snapshot 生成开销需要实测定参；ring 溢出必须触发新 snapshot，不能静默丢数据。screen.log 的磁盘管理沿用现有 screen-log-gc，不新增持久化负担。
- **View State Coordinator 生命周期**：需要复用现有 host/lease/fencing 思路，保证 detached coordinator 崩溃、接管和重复启动不会产生第二个逻辑写者；service reload 不得重新变成状态写者。
- **非幂等 input 的故障窗口**：PTY `child.write()` 是外部副作用，无法仅靠本地 journal 证明 exactly-once。durable follow-up 必须显式区分 accepted/applied/ambiguous；runner 重启后对「已 accepted 但 applied 结果未知」的命令不得自动重放，除非 child/上层提供可验证的 request receipt。
- **协议版本迁移**：ack 和 snapshot 化后旧客户端/旧 runner 需要能力协商；legacy 路径只能是明确的降级模式，不能混入新协议的正确性声明。
- **性能与延迟**：PTY runner 解析和 snapshot 序列化不能阻塞 child output 消费；需要测量 parser lag、snapshot latency 和 ring overflow，而不是只做功能测试。
- **平台策略边界**：D6 Windows 默认 JSON-runner 不属于本 issue 的核心闭环，另行设计和验收。

---

*本 spec 已根据最新代码和架构评审修订，当前仍为 DRAFT。待用户确认后进入 Step 5（建 worktree）与 Step 6（writing-plans）；在此之前不进入实现。*
