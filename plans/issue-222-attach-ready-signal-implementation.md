# Issue #222：流内画面证明的实施契约草案

- 状态：第2轮复核0个真缺口、4项细化已按建议收尾；可作为后续受限实现输入，仍非实际provider／A4／A5验收。
- 日期：2026-10-24。
- Drafted: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-10-24T14:42:13.284820+00:00
- Revised: kimi-coding/k3.1-pro (selected) · kimi-coding/k3.1-pro (physical) @ 2026-10-24T15:26:36.292240+00:00
- 上游约束：已批准计划／spec、`issue-222-attach-ready-signal-revision.md`及用户批准的受限协议扩展。
- 本文只细化获准的仓内child→runner→attach能力，不改变Pi／依赖／全局安装冻结、1660次对照、verify、实机验收及不发布边界。

## 1. 当前证据与仍待证明的事项

仓内Pi／pi-tui开发依赖为1.1.0；宿主启动脚本当前读取到1.4.0，先前1.3.0只保留为历史记录。宿主版本变化不是本任务执行的升级。实际候选加载时仍须重新记录解析路径／版本，不用目录名代替运行时证据。

宿主1.4.0源码确认：编辑器容器在`ui.start()`前挂载，`session_start`稍后从扩展绑定路径触发；`setWidget`工厂可取得稳定TuiRef；fullscreen与regular切换时`previousUi.terminal`传给新renderer；调度器可直接调用内部`doRender()`，所以只包装`renderNow()`不充分。`Terminal`公开实例的getter和方法可观察，但不能把任意write／sync-close直接当成就绪。

新增`task-17-signal-host-probe1`仅使用宿主公开接口、内存终端和镜像组件树。第三次修正后退出0，观察到：内部调度器产生的fullscreen帧、带实际焦点身份的选择弹层、共享终端的fullscreen→regular切换、regular光标尾部后的完成事件，以及stop不新增完成事件。无sentinel的初始帧不产生完成事件。前两次是探针自身报告／epoch期望错误，均保留；第一次没有留下内存原始轨迹，不能重建。第三次末尾仍有PipeWrap记录，不声称活动资源数组为空；进程退出0、终端input／resize释放。

**这仍不是实际InteractiveMode／扩展加载／PTY／runner证据，也不是真实像素或性能证明。** 下文生产契约需先复核，随后在隔离真实Pi子进程中证明接入和清理，才可启用对应生产快速路径。

## 2. 生产者职责与公开接口边界

拟新增仓内child adapter（正式文件名在任务23a冻结）由现有`src/index.ts`的hosted-child `session_start`接入。它必须只依赖公开扩展／TUI／Terminal／Component接口：

1. 用`ctx.ui.setWidget`注册唯一、零高度、belowEditor组件。组件不改变焦点、输入、可见行或editor内容；其`render(width)`只记录本次候选的语义事实。
2. 对当前共享Terminal实例以own访问器／方法遮蔽原型实现，不替换editor、renderer、parser或调度器，不读写私有字段、不修改原型。遮蔽前记录原型描述符；卸载只在own遮蔽仍属于本adapter时删除之，不触碰原型或第三方后来的改动。保留原调用的`this`、参数、返回与异常；若own遮蔽已被替换，不覆盖新实现并报告恢复受限。
3. 通过稳定TuiRef读取当前`mode`、`hasOverlay()`，并以运行时能力探测读取公开实例上的`getFocusedComponent()`。仓内及宿主的公开`TUI`类型都不声明该方法，虽然`TuiBase`公开实例方法可经proxy到达；因此必须用带类型回退的feature detection，探测不到即unsupported，不能把仓内tsc失败误当宿主缺能力。不包装或替换component.render；选择弹层由真实renderer的overlay合成路径完成。
4. 在现有hosted control socket之外建立明确能力握手，或使用同一resident socket的独立消息域；不得复用颜色997、editor_empty文本状态或`childInputReady`充当画面证明。

初始adapter安装时终端已经start，observer-local rendererEpoch从1开始。后续原始终端`stop()`使命中候选失效，下一次成功`start()`递增epoch。模式切换共享同一Terminal，因此无需替换TuiRef或迁移私有renderer状态。停止后的afterTerminalStop输出不属于可发布工作帧。

### 2.1 语义证据

一个候选只允许由renderer入口的`columns`＋`rows`读取建立本地、尚未发射的候选；鼠标／hover／scrollbar等零散尺寸读取不得单独向runner发射S。第一次读取的值是本次采样尺寸，候选内后续读取不能覆盖它。只有sentinel已经确认工作区参与渲染、焦点有效且即将出现该帧的首个真实同步帧输出操作（regular为携带sync OPEN的write，fullscreen为含完整同步帧与光标的write）时，才在输出前发射S；没有任何输出的候选不发射S，也不会阻塞snapshot。

本地候选不得跨一次同步renderer调用残留。建立候选时安排身份绑定的`process.nextTick`失效检查；正常同步S／F在其之前完成并取消该检查，未决候选则失效，已发射S时才补A。回调必须核对候选对象／frameId，不能取消新候选。预先排队的其他回调若产生新采样，会使旧候选先失效；旧回调仍不得影响新候选。这是同步生命周期fence，不是等待常数。公开API无法证明同步调用边界的操作序列一律unsupported，不能由后续无关操作追认。

零高度组件在真实布局中位于editor slot之后。它观察到本次候选且焦点非空，只表示“editor slot（普通editor或其中的选择界面）已经参与本次渲染”；fullscreen的overlay仍须由本次真实`compositeOverlays()`和后续输出完成。候选结束时再次读取焦点，必须与sentinel时相同；焦点缺失／改变或renderer-mode改变则abort。焦点身份的普通名称、选择标题、文本不得进入协议或作为生产启发式。

该契约不声称通用Terminal调用轨迹能识别任意第三方组件语义。支持范围限于已经核验的实际Pi interactive布局及公开renderer操作文法；意外序列／异常／未知版本只给UNKNOWN／unsupported，不自动成功。候选区间内允许的普通Terminal操作仅为`write`、`hideCursor`、`showCursor`及各自的getter；`start/stop`是使候选失效的生命周期操作。`moveBy/clear*/setTitle/setProgress/setProgramStatus`等其他方法在候选内出现即A／UNKNOWN，区间外则按普通输出及§5的无网格控制分类处理。单线程意味着doRender内不能插入外部调用，组件render副作用仍是必须测试的例外。

regular的F必须有本候选有序的sync OPEN→CLOSE以及其后的光标停车／最终hide/show；宿主总是先append OPEN，但CLOSE可能被BoundedTerminalWriter切到两个write中，验证器必须保留跨write顺序状态，不能用逐write整块正则代替。没有同步块的cursor-only操作只能更新既有完整view的光标元数据，不能建立首次或当前完整view证明。fullscreen no-change仍有真实同步块，可与regular区分。不得以force重置制造证明或增加额外清屏。

直接stdout若发生在S／F之间，它在流上有明确区间；它不能跨进程偷用别的frameId，但是否构成不受支持的输出必须在真实Pi与异常fixture中验证，不能宣称装饰器能证明任意库的全部副作用。

## 3. 流内边界，而非带外时间相关

建议采用新的私有DCS标记族，最终字面格式在23a测试前冻结。以下为语义格式，不冒充现有协议：

```text
DCS > agent-board-frame/1 ; token ; S ; frameId ; intentId ; sampledCols ST
DCS > agent-board-frame/1 ; token ; F ; frameId ; base64url(metadata) ST
DCS > agent-board-frame/1 ; token ; A ; frameId ; reason ST
```

- `token`由runner为child-reporter实例分配，至少128位随机、base64url编码；旧runner不协商就不产生标记。不得让frameId跨实例独立承担身份。
- `S`只在sentinel和焦点已经确认、且该帧的首个真实同步帧输出操作即将发生时，先于该输出发射；不在getter或鼠标尺寸读取时发射。regular的无同步cursor-only不发射S，fullscreen则在其完整同步write前发射。`F`在确认完成的原始Terminal操作返回后写入。regular必须有本候选同步CLOSE，并位于其后的光标停车write及最终hide／show之后；fullscreen必须位于包含完整同步帧及光标的write之后。S仍先于所证明的帧内容字节，而不是追赶任意后续close。
- marker必须通过同一有序stdout的直接写出或原始未包装引用发送，并有reentrancy guard；不得经候选包装方法递归记账，不得触发S／F／A判定或污染writes计数。marker失败按§7关闭能力，不能继续假装完整。
- `A`表示中止，不是可等待后补成功的完成事件。新采样、同步调用边界的失效检查、stop、异常、未知操作、嵌套候选及不闭合同步块均使旧身份无效。未发射S的本地候选静默失效；已发射S的候选必须A。下一个候选不得沿用旧的frameId或intent，迟到失效回调不得取消新候选。
- `frameId`在同一token内严格递增；`S/F`必须精确配对。start与finish的intent、采样尺寸和rendererEpoch须一致。重复、回退、错token、只F没S、只S没F、畸形／超长payload均为UNKNOWN／协议错误，不能发布。
- metadata至少含`protocol=1`、`cols/rows`、`mode`、`rendererEpoch`、`sessionEpoch`、`focusPresent`、`overlayPresent`、`intentId/geometryRevision`。不携带editor文字、选择标题、用户内容或任意就近时间戳。完成标记本身不提供像素保证。

单条marker上限4096字节；解析器必须跨PTY分片与合并保持状态，并显式处理DCS/ST字节，而非正则扫整个历史。只有匹配协商token的完整marker才剥离。已知prefix但畸形／超限的记录为invalid并不进入现代快速路径；原始诊断有界保存，不能无限缓存。任何marker不得进入canonical xterm、外层Terminal、用户输入或legacy重放输出。

为何不再犯SF2：身份直接处在PTY有序字节流内，runner按实际流顺序在F边界捕获，不依赖socket收到报告的早晚、outputSeq与child frameId天然对应、最近时间或某个后续close。PTY只可分片／合并这些字节，不能重排它们。

## 4. 请求与尺寸归属

现有`resize`命令仍只执行一次真实PTY／model resize，原accepted／applied／superseded语义不变。applied之后，runner经resident reporter socket发送新的`frame_witness_intent`，至少含当前runner实例、`requestId`、`geometryRevision`和实际目标cols／rows。不同尺寸才增加geometryRevision；同尺寸请求不得制造resize。

adapter在当前候选开始前已持有的最新intent才可进入S／F。收到新intent时使用公开`tui.requestRender()`请求一次正常调度，不调用私有doRender、不同步伪造render、不force重置或新增resize／jiggle。同步渲染期间另一消息不可能在同一JS线程插入；因此“render结束后才到的nonce”不能追认旧帧。

目标尺寸必须与候选第一次采样的cols／rows相符。runner还必须验证当前实例、rendererEpoch、geometryRevision和requestId；旧nonce、重复nonce、superseded请求或旧epoch一律拒绝。首个合格匹配帧消费该intent，后续同nonce不重复完成首次hooks。

没有新intent的普通完整帧仍可更新当前canonical完整视图；它不能完成另一个尺寸／基线请求。adapter安装和能力启用时请求一次普通render以建立当前视图，不强制全屏清屏。

## 5. runner的精确消费与最小缓存

在`child.onData`进入现有`feedOutput`之前增加流式marker转换：

1. 将原始数据按marker边界切段。剥离marker；普通段依次进入既有bounded `screenLog`、canonical model和订阅输出。旧无marker路径保持原chunk行为。
2. S记录当前producer候选；A使其无效；F前先把之前普通段喂到精确边界，再验证完整身份并记录`viewProof`。F之后的普通段（包括下一帧OPEN）只能在证明快照之后处理。
3. 每个普通段沿用现有outputSeq分配方式；marker没有伪造PTY outputSeq。marker路径的seq可能因此比原始PTY read更细，必须更新测试预期，但不能改变旧路径序号语义。报告明确它是有序输出段序号，不是child frameId。
4. 在F边界只保存有界metadata与当前consumer所需的最小完整视图。不得每个marker复制整个scrollback或反复序列化全历史。首版若只需当前snapshot／catch-up的证明，可不发送额外整份视图缓存；attach本地仍需在证明边界保存可见区、光标与交互元数据。

`snapshot_begin`／catch-up／live输出需按客户端声明的可选能力携带`viewProof`；旧客户端不得收到不认识的新消息。proof的`seq`必须等于其前驱输出段序号，允许同seq多个无字节变化的完成事件，并保持产生顺序。通常proof必须精确对应当前`snapshotSeq`且没有已知未决producer候选／同步块；只有其后所有普通段都经独立分类为明确的无网格／无布局控制操作时，才允许`proof.seq < snapshotSeq`。允许项是穷尽、逐序列识别而非“等”：当前宿主实际使用的`CSI ?2004h/l`（bracketed paste）、`CSI ?2031h/l`（颜色方案通知）、`CSI 16 t`（cell-size查询）、`CSI c`（DA查询）、`CSI >7u`、`CSI ?u`、`CSI >4;0m`、`CSI >4;2m`、`CSI <u`（当前键盘协议控制）、`CSI ?25h/l`（DECTCEM）、OSC0 title、OSC9;4 progress、OSC7501 program status，以及OSC10/11/4调色板查询。允许项只表示不改变当前网格／布局，不抹去相应的输入、主题或查询元数据；DECTCEM仅更新该完整view的光标可见性。分类器必须基于实际CSI／OSC语法和完整终止符，不以可打印字符或前缀猜类别。其他键盘／鼠标模式、OSC52、OSC8、文本、擦除、光标位移（A/B/G等）、alternate-screen／同步模式变化、未知序列及未分类散字节一律使最新证明失效。

特别是：F后仅DECTCEM可允许`proof.seq < snapshotSeq`并更新可见性；F后cursor-only渲染若含光标位移，proof失效且不得误发布。此后等待下一真实合格帧；若仍未到达，现代保护超时只记录未就绪原因并保留可detach等待／恢复状态，计为失败，不转成强制展示或篡改legacy期限。catch-up／replay必须按seq交错proof，ring淘汰造成缺口时UNKNOWN／resnapshot，不能补猜。

协议协商是可选能力，不提升现有TERMINAL_FRAME_VERSION或snapshot DTO版本。旧runner不启用marker，旧client沿用原路径；已协商但证明无效的现代路径不得借legacy名义宣称整帧保证。原legacy settle/jiggle/probe期限保持不变。

## 6. attach消费边界（23b以后）

`viewProof`是独立输入事实，不是测试真值，也不是单独可发布条件。客户端仍须验证：当前连接／baseline／generation、当前parser、目标尺寸、baseline校验、精确seq、无未完成同步块、组件未关闭。parser drain只能证明已收到字节的解析完成。

snapshotReady后为新权威基线替换parser并以token＋parser双重fence。正常非空同尺寸且proof精确覆盖当前snapshot／catch-up，或仅相差上述已验证的无网格控制段时，可尽快发布；proof不足、未分类散字节、open水合、空baseline、尺寸变化、epoch更换均等待相应新证明。protection timeout不能强制展示BOOT／半帧／旧尺寸。

同步OPEN期间，所有render入口只看同来源／同尺寸的上一完整view或loading；在经验证的同步CLOSE和必要cursor边界保存完整投影。scroll、selection、copy、link和cursor都对应同一view。已存在的40ms输出合并、首屏替换、主题桥、颜色探测、desync probe、childInputReady队列、一次首次hooks和detach语义继续复用。

## 7. 生命周期、错误与限制

- reporter disconnect只撤销相应能力／intent；不得自动重启真实会话。重连需明确token／epoch规则，旧socket和旧intent不能恢复首次副作用。
- `session_start`的sessionEpoch变化使旧候选失效；session_shutdown／进程退出清理socket、timer、组件和实例包装。实际支持的事件名须按当前扩展类型核对，不虚构。
- marker写失败不能阻断child原始输出；关闭能力并报告UNKNOWN，之后不得再发F。原始Terminal异常仍按原样抛出，不吞掉原故障。marker直写必须有reentrancy guard，既不递归包装也不改变原方法的返回与异常。
- 不支持的操作序列、未知renderer版本、proto污染、重复id、错尺寸、open sync、stop、dispose和迟到回调必须保持未发布。
- 本adapter不提供终端像素保证、任意第三方私有renderer保证、跨机器安全认证或真实总延迟证明。现有host认证／socket所有权约束不变。

## 8. 验收ID、owner与执行顺序（尚未执行）

下表是范围细化后的映射，不表示测试已存在或通过。23a／23b是checklist23内部的顺序接缝，不勾选23直到其attach状态隔离也验收；24–30仍按原顺序执行。17／18／19先完成基础设施、真实入口和独立fixture场景，不能用此设计替代。

| ID | Owner／验证层级 | 与原子任务／验收的关系 |
| --- | --- | --- |
| FW-01 getter／操作文法、首对尺寸、分块CLOSE、光标尾部、无同步cursor-only限制、缺失focus API→unsupported、marker不递归 | 23a child adapter unit＋公开renderer integration | 19帧尾、20 B/Q/S、A3/A4 |
| FW-02 belowEditor／选择／焦点／stop／模式切换／非渲染尺寸读取不发S | 23a公开组件＋真实Pi provider smoke | 19选择、20 C/D/Q、A5/A8/A9 |
| FW-03 DCS分片／合并／错序／剥离／close-open／非渲染读取不阻塞proof | 23b parser unit＋真实runner | 19–21、A2/A3 |
| FW-04 intent／nonce／geometryRevision／一次resize | 23b runner control integration | 20、26、A4 |
| FW-05 空baseline BOOT与完整editor区分、regular无同步首帧不得伪造证明 | 23a真实Pi provider smoke＋23b C fixture | 20、24、A5 |
| FW-06 snapshot精确proof／逐项安全尾随控制（含DECTCEM）／光标位移与未分类散字节拒绝／catch-up／同seq／ring gap | 23b subscription/client integration | 19、21、23、A1/A2/A6/A7 |
| FW-07 restore／reconnect／epoch／dispose／候选失效fence／marker-write-failure→capability-off+UNKNOWN；卸载仅删adapter own遮蔽且同原型其他实例未受影响 | 23a+b生命周期测试 | 20、27–30、A9 |
| FW-08 实际Pi加载路径与版本 | 23a隔离provider smoke；不是U像素 | 23前置证据、36–39版本复核 |
| FW-09 marker不进入canonical／screenLog／外层；legacy不变 | 23b runner＋回归 | 20、22、29、35、A2/A7 |
| FW-10 有界metadata／无逐帧全历史复制 | 23b实现review＋perf／formal matrix | 31–35、A10/A11 |

23a与23b需要各自独立diff、RED→GREEN和review；父会话做集成验收。真实Pi provider smoke使用隔离临时配置与自有PTY／socket，不需要模型请求，不读／复制凭据，不改全局配置。若实际扩展不能提供上述公开接口或操作文法不成立，停止对应快速路径并带反例修订；不得靠固定等待放行。

## 9. 当前复核问题

1. S／F的流内位置、regular／fullscreen完成规则和异常abort是否足以消除前次SF1–SF4的具体反例？
2. belowEditor＋焦点事实是否在不替换组件的前提下覆盖正常编辑、editor-slot选择与overlay，还是仍有具体假阳性？
3. snapshot／catch-up的proof精确seq及仅限明确无网格控制的尾随规则是否可在现有协议接缝实现，且不会把旧view、open buffer、光标位移或BOOT当成当前完整基线？
4. 是否有任何隐含依赖升级、全局变更、额外真实resize、额外全历史缓存、违反旧兼容或把fixture真值当生产条件的要求？

本草案通过复核后，仍需真实provider与逐项实现验收。它本身不解除17／18／19的顺序，不表示A4/A5已建立，也不允许跳过20–39。
