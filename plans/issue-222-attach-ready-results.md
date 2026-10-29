# Issue #222 — Attach-ready 执行证据

## 当前状态

P1和P2的步骤12–16已完成诊断验收，步骤17–19已完成基础设施、真实入口和交互场景验收，步骤23的协议、proof、parser隔离与生命周期工作已完成，当前进度为21／39。步骤23最终C fixture整套测试为1598 total／1581 pass／9 fail／8 skip，九项既有P4 RED仍是后续翻绿目标；尚未启用快速发布，A4／A5产品发布正确性、1660次正式对照与U1–U3尚未执行。

新增信号修订提案已完成范围决定层面的异模型复核：0个阻塞缺口、3项细化、1项通过；父会话已处理细化并单独保留修订差异。PTY child可进入既有hosted reporter，但其文本轮询不足以证明工作界面完整；离线正面结论仅限pi-tui1.1.0。该提案尚不是实现spec，真实provider、wire／生命周期和验收ID映射仍需核验，A4／A5未建立充分性。用户已于2026-10-24T22:14:03+08:00批准新增child→runner→attach协商就绪能力的受限范围；Pi、依赖和全局安装保持冻结。真实provider、wire／生命周期和验收ID映射仍须核验，先按顺序完成P3基础设施和真实入口，未获准的发布与全局动作不变。

初次复核的HTTP400/schema缺type失败仍保留。补齐三个type:string后，同一retained reviewer已完成复核，native为complete／attested；原错误未被抹去。父会话核对了完整JSON、counts、实际schema、源码hash和原批准哈希；没有重跑已完成试验。新报告见issue归档research/attach-ready-signal-revision/spec-review-round-1.md，提案见plans/issue-222-attach-ready-signal-revision.md。

受限范围批准后，宿主启动脚本读取的`install/current-version`已为1.4.0；此前1.3.0仅是历史基线，本次未升级或修改宿主。源码核验确认PTY子Pi在扩展session_start前已挂载editor，fullscreen／regular切换复用同一Terminal。新增宿主1.4.0离线公开接口探针在两次探针自身报告／期望失败后通过，覆盖内部调度、选择弹层、共享Terminal切换、光标尾部与stop；第一次未保留的内存轨迹未重建。它不等于真实Pi加载、PTY消费、A4／A5或实机通过。实施契约第2轮复核已收敛：0个真缺口、4项细化、6项通过；父会话已落实尾随序列／光标位移终态、CLOSE跨write、实例own遮蔽与同步输出触发规则，最终契约哈希为e773a0a9598758c5ef735edd7728049b943216fe51b6c60f5827c336aa4d1af3。该结果仅作为后续受限实现输入，真实Pi provider、A4／A5和生产验收仍未建立；步骤17基础设施与修正复核继续先行。步骤17首次实现任务在写报告时达到30分钟原生期限，已由原实现者恢复交付：整套npm test为1310通过／0失败／3跳过，定向8／8、ready文件67／67及类型检查通过。独立任务复核认可受限切片的代码质量，但父会话按完整清单判定会话代次仍是步骤17的阻塞项，不能推迟到18+。原实现者已交付独立代次fixture和两组真实runner/root证据：两组均证明当前F0基线在attach前存在、首屏属于当前代次、旧代次毒日志未出现且种植证据PROVEN，并保留每组6个已知光标反色缺陷。S路径已复用共享清理helper，最新整套测试为1313通过／0失败／3跳过。父会话另发现场景未计算streamAudit，已只读核对两次F1哈希一致并交原复核者判断是否需补强；步骤17已通过原复核者复查和父验收并标记完成，当前15／39；报告精度已修正，下一步为步骤18真实入口延迟实验。产品就绪、总延迟和实机验收不包含在内。ready文件和随后的整套npm test都包含S battery，两条日志分别保留，不能声称总共只运行过一次。

步骤17验收包已归档到`research/step17-accepted.tar.gz`，SHA256为b640c9952bebdfa95996ce3f308bffed22fd808df9d9c2a9bc546e1eacbcdf13；108个清单文件、78,890,551字节，全部逐成员比对通过。首次归档因两个native状态文件同名而在写清单前停止，修复时保留原文件并为第二份状态使用独立文件名，没有覆盖或重跑试验。

步骤18真实入口任务已形成测量结果，但父会话暂未验收：至少三次直接ENTRY运行被混写进报告，且早期产物被反复删除。当前保留的第三次raw为292.366ms，报告时间表却来自第二次；已保存原生会话和现存证据，不重建丢失产物。另有snapshotParsed未等到本地解析完成、首次运行缺connected/snapshot事实及tsc日志被printf覆盖的问题，独立复核已确认这些均为阻塞项，并要求修正后交付。当前第三次raw只保留为历史witness；修正后的唯一canonical试验已完成：总入口289.086566ms，resolver0.965742ms；snapshotReady回执769.856773ms，精确snapshot-frame本地解析回调771.862099ms，随后首帧1038.871106ms。历史多次运行与被删除产物已分开披露，未重建。RED来源、日志来源、run1诊断和同路径拒绝覆盖均已修正。步骤18已通过原复核者逐项确认和父验收：真实入口、真实resolver、overlay、独立首帧和清理均符合要求；报告精度已修正，下一步立即调用plannotator_mark_done(18)。Canonical单次总入口289.086566ms，resolver0.965742ms，不据此宣称200ms目标或冷启动通过。真实resolver、overlay、首帧、zero-resize和detach路径本身已有初步证据，但不据此宣称步骤18通过。

步骤18验收包已归档到`research/step18-accepted.tar.gz`，SHA256为1dce12dc77e0eab098939b5670f742dd91e606de532b031ec1c1302c508d3ae6；67个文件、57,001,629字节，全部逐成员比对通过。

步骤19的四条证据链已形成：真实协议catch-up及多次解析、regular光标尾部、活动选择界面、上滚后新输出。最新整套测试为1329 total／1326 pass／0 fail／3 skip。父会话发现后三链目前是直接管道驱动真实TUI，而非真实runner/socket/attach，因此只可作为组件级证据，不能直接满足真实attach拓扑；catch-up则是独立协议接缝，socket级证据明确未测。独立复核确认selection和scroll必须改走真实runner/socket/attach输入链，直接管道结果只保留为组件级补充证据。artifact错误将阻断成功并保留root，MAIN画面改为完整反色单元格和空白行检查，HIST-11则按停止恢复阶段的末尾换行解释。修正后的selection和scroll已具备真实runner/socket/attach输入证据：两次方向键、三次滚轮和detach均有实际tx记录；选择焦点及上滚后视口均符合独立期望。MAIN已补完整反色单元格与空白行检查，artifact失败会阻断成功，HIST-11已按停止恢复阶段解释。最新整套测试为1331 total／1328 pass／0 fail／3 skip；另一次既有A5w超时也保留。原复核者已确认四条证据链，但父会话要求在验收前再关闭四个证据收尾点：复合摘要与原始摘要分开保存、补全上滚外层网格断言、cleanup.ok纳入成功条件、保留本轮typecheck日志，并加强重复输入的tx序号检查。fix2已完成：双摘要文件、上滚外层顶行、cleanup.ok与teardown违规门禁、重复输入tx计数检查均已落实，最新整套测试为1334 total／1331 pass／0 fail／3 skip。另请原复核者判断600ms的fixture追加延迟是否仅是可接受的时序安排；真正的通过依据是外层上滚网格，而不是延迟本身。步骤19已通过原复核者小范围确认和父验收：catch-up、regular光标尾部、真实选择界面与上滚后新输出的证据链完整；双摘要、artifact失败门禁、上滚外层顶行和cleanup门禁均已落实，下一步立即调用plannotator_mark_done(19)。socket级catch-up仍未测，live-Pi/TTY与A4／A5不包含在内。

步骤19验收包已归档到`research/step19-accepted.tar.gz`，SHA256为1c9bbaec8d139033baafbe138a2d41670398e2471f6917b1dba756ec1e051591；170个文件、168,154,136字节，全部逐成员比对通过。

步骤20拆为两个连续阶段：20A覆盖B/Q/S/L/G1–G3/C/T，20B覆盖R/U/D。20A的B/Q/L/G真实runner试验已完成，最新整套测试为1350 total／1347 pass／0 fail／3 skip。父会话发现S审计仅覆盖九格之一，T遗漏late，U被误写为未知尺寸而非无同步标记legacy，暂不验收。另需明确`frameFailures=0`与DECTCEM光标缺陷并存的呈现方式，避免把真实缺陷读成零错误。独立复核确认S与T覆盖不足、U误标及报告证据问题，现已开始修正：补齐九格与late审计、post-content空白帧检测、有序退出和实际resize门禁，并明确G2溢出与G3换行的证据边界。最终B已核实为103次写／2798.076ms，报告原数字来自另一试验，不能混用。修正已补齐九格和late审计、内容丢失检测、resize门禁及有序退出，七个最终格均达到cleanup.ok=true且无forcedKills，最新整套测试为1352 total／1349 pass／0 fail／3 skip。G2的#205测试源已确认覆盖65→38、baseY/floor27和首轮滚轮转发；原复核者确认除G3换行外全部关闭，G2的#205证据有效。现已开始唯一的补齐任务：在真实resize后生成G2W帧，用原始160列单行与独立声明的80列换行结果证明重排，并验证输入区和尺寸；同时把resize门禁改为记录时计数。G2W的实际两行已与独立声明的换行结果完全一致，整帧与输入区均通过检查，resize门禁已改为记录时计数；最新整套测试为1353 total／1350 pass／0 fail／3 skip。原复核者已确认G3和resize门禁关闭，父会话已验收20A，但尚未勾选完整步骤20。20A证据包为`research/step20a-accepted.tar.gz`，SHA256`d0476d962d95529ed0d8e40c1cf2270f0a2e7a983c46f3dfe60f23b67df6058d`；1844个路径全部核验，其中1101个硬链接成员按目标内容验证。首次校验器漏算硬链接的错误也已保留。20B的R／U部分已验收：重连、真实空基线重启、poison隔离、无同步与legacy兼容证据均完成；旧画面约15ms残留仍作为后续P4基线问题保留。20B初次D交付的缺陷已逐项保留并修正：旧30轮的21次host失败已证实为socket路径相关的EADDRINUSE；D1资源清理与关闭后发布回归已建立，当前套件仅有这一项产品RED。新epoch后的旧parser身份仍待P4解决。D2的30轮已完成：quiet15/15清洁，render-pending15/15有效但均触发同一产品RED，基础设施失败为零。独立复核认定P3断言与证据建设完成，步骤20已验收并勾选；产品修复和新epoch parser身份仍是P4必办项。20B归档为`research/step20b-accepted.tar.gz`，5870个成员全部通过字节核验。步骤21的fake-clock回归已验收并勾选：A4/A5/C、B/S/延迟帧和legacy证据齐全，当前九项失败均为旧版契约RED；归档为`research/step21-accepted.tar.gz`，4604个成员全部通过字节核验。真实入口基线已验收：B为2526.373516ms、Q为287.426548ms，均内容正确但不满足200ms目标，fastAndCorrect=false；两次都通过runner协议内输入有序退出。步骤22已勾选，证据包为`research/step22-accepted.tar.gz`，365个成员全部通过字节核验。下一步先做实际Pi/provider smoke，A4/A5未建立前不启用生产快速路径。

## 步骤23：协议、proof与parser隔离验收

步骤23已完成全部子阶段并通过独立复核和父验收，但不代表快速发布或用户体验修复。23a真实Pi smoke与生产adapter、23b1 runner DCS/capability/intent/resize与真实默认拓扑、23b2a纯FW-06 tracker、23b2b runner/subscription、23b2c1 client事实与纯决策、23b2c2 managed parser替换与身份fence、23b2c3a FW-07生命周期、23b2c3b C诊断fixture均已验收。对应归档SHA256依次为：23b1 `aa0d5ba4534edc0272d6ad33e077bc4793493faa29d7012aa3c50b9fab069230`、23b2a `0f9490cdd9161b9ddfbcdc81d4b5cb76e04e19105534dccec2e2a4a16455fe1a`、23b2b `b24d5f08332c6e15ad9df7e9d00ca82fbd4c5f20cc14614df4bba11147d1e7f9`、23b2c1 `940d1544fa4a01328f6144ec765569b8e8409b07c0698c3c6f3e425b00b5caf7`、23b2c2 `1da3e2044cf5b61f575031272f233929409f4723f3fa371c6de79b9966d614b6`、23b2c3a `65591b3f5ca70e665189ceb74ac7c5d3247ede4ec6bf5e83b9e46d275d08da27`、23b2c3b `a2c0aa41ef3dbb7b56e5c490cab77e25ab93ef4f1f4b2f6180cee6b80ec7b71b`，均逐成员核验通过。

协议基线、local parse、publishability与首次副作用已分离；connection/baseline/parser identity同时围住异步回调，旧parser、旧连接及dispose后的回调不再污染新基线。新parser保留构造参数与历史floor规则并先安装?2026观察，旧parser/CSI资源被释放。viewProof是带精确前驱输出seq与完整metadata的输入事实，不是发布真值；纯决策另外要求本地完整帧、精确throughSeq、proof派生尺寸/revision/intent与complete内容。observer缺失走legacy，replacement失败有界重试后回退，replacement epoch不被人为递增。真实`/new`已获得第二个epoch2 enable与后续epoch2 proof；legacy摘要作用域回归已修复并回归验证。

C fixture证明空baseline与毒日志、BOOT/partial没有完成proof，完整当前editor才有covered coverage；旧early-release C RED仍然可见。步骤23最终focused为45 tests／42 pass／3 expected RED／0 skip，npm为1598 total／1581 pass／9 fail／8 skip，strict scenario/repo typecheck通过，清理自然完成。九项P4 RED仍待步骤24+逐项翻绿，不能将诊断通过写成产品修复。验收记录见`task-23-acceptance.md`与`task-23b2c3b-acceptance.md`，C归档为`research/step23b2c3b-accepted.tar.gz`，243个成员全部通过字节核验。下一步进入步骤24：真实publish gating、closed/render teardown保护以及live viewProofRecord到组件的验证。

## P1：基线与环境

- 许可：用户于 2026-10-23T08:20:19+08:00 批准计划并解除规划限制；Gate 仍为 stepwise，无 commit／push／PR／merge／publish 许可。
- Worktree：`/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-222-attach-ready`，分支 `issue-222-attach-ready`。
- 检出基线：`d41a16bbd3e55c6df1d1cdd60c43a7c2e2492482`。原调查／2512ms、268ms 单次数据仍只属于 `9a197f4`，不移标为当前基线。该范围只有 #221 的 events 源码／测试与两份文档，无 attach 文件差异；候选比较仍须按实际检出记录依赖变化。
- Node：v22.23.2，Linux x64。
- 隔离 fixture 实际导入：`@xterm/headless 6.0.0` → `/home/elling/work/git-repo/pi-agent-board/node_modules/@xterm/headless/lib-headless/xterm-headless.js`；`@earendil-works/pi-tui 1.1.0` → `/home/elling/work/git-repo/pi-agent-board/node_modules/@earendil-works/pi-tui/dist/index.js`。已由 standalone Node 真实 import，不是目录名推断。
- 仓内 Pi package：1.1.0，ESM-only manifest 入口 `/home/elling/work/git-repo/pi-agent-board/node_modules/@earendil-works/pi-coding-agent/dist/index.js`。本轮环境记录未导入该入口，不伪称已证明 Pi 自定义 loader 的解析。
- node-pty：1.1.0，入口 `/home/elling/work/git-repo/pi-agent-board/node_modules/node-pty/lib/index.js`。
- 宿主 CLI：在 offline／skip-version-check 环境执行 `pi --version` 返回 1.3.0。宿主 TUI 的实际自定义 loader 解析与真实终端像素验收属于 U 项，当前 pending。
- 依赖复用：worktree 的被忽略 node_modules 目录内，各现有依赖条目指向主 checkout 的相同条目；未安装、升级或修改任何包。
- 工具进程不是交互终端：stdout.isTTY=false、rows／columns=null，TERM=xterm-256color；不能把 TERM 当实际宿主尺寸。P2 主 fixture 使用明确记录的 fullscreen／80×24 等受控尺寸，regular 单列；真实终端尺寸与版本尚未验收。

## 干净基线测试

命令：`npm --prefix /home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-222-attach-ready test`。在任何生产／测试源文件修改前执行，退出码 0：1246 tests，1243 pass，0 fail，3 skipped，约 43.65 秒。skip 是仓库既有 opt-in perf gate；这不是 `npm run verify` 或 #222-A11 的替代证据。

完整日志：`/home/elling/.github-issue-driven/zhuxixi/pi-agent-board/issue-222/research/baseline-npm-test.log`。

## P2：观测器与边界验收（步骤 12、13）

独立外层 xterm 接收真实 TUI 的原始写入，保留逐次字节、单调接收时间、不可变网格／属性／光标数据。同步块在关闭解析钩子中即时复制；块前可见内容在进入边界保留，未闭合块不冒充可见状态。同一 write 内的多块／关闭后立即开启、分片 delimiter、重复及无匹配边界、多个私有模式参数与光标控制的顺序均有回归。

父会话曾否决初次 PASS：独立类型检查发现字段／getter 冲突，最小反例证实漏记块前内容与误报半帧，另确认控制方法的光标效果缺失。原实现者已逐项修正，原复核者针对性复查后 PASS；父会话读取完整新日志并核对哈希后验收，原失败记录仍保留。

- 修正 RED：16 tests，9 pass／7 个有名称的断言失败，exit 1；GREEN：16／16，exit 0。
- 修正后整套测试：1262 tests，1259 pass／0 fail／3 skipped，exit 0。未重复执行同一套已完成测试。
- fixture 独立 strict tsc：子任务报告 exit 0，原始日志仅包含 EXIT=0；完整命令在父修正包与修正报告中。仓库普通 typecheck 排除 test-support，不能单独证明 fixture 类型正确。
- fixture SHA-256：`1fb2709e6599db9e2b8dad4e91facc2e774a699604c85921f8abf7db5654695d`；测试 SHA-256：`c657d70007e090e23d24bbe5a452ad6187fbc6e3c7e46ede7a39a9c7c833a1c2`。父会话已逐一核对。
- 完整证据：`.superpowers/sdd/2026-10-23-issue-222-attach-ready/task-2a-fix1-report.md`、`task-2a-review-fix1.md`、`task-2a-fix1-*.log`；验收快照：同目录 `baselines/step12-13/`。

边界：这些测试只证明观测器捕获契约，不证明错误帧判定器、用户现场原因、A4／A5、200ms 延迟目标或真实像素效果。普通写入窗口只代表潜在可见状态，不提供 write 内部像素原子性保证。初轮被截断的历史日志不补造为完整 RED；混合 write 的 unmatched-close 注记属于保守诊断信息，不得被后续判定器当成跳过整个观测的理由。

## P2：独立错误帧判定器验收（步骤 14）

真实捕获历史与独立预设画面逐项比较：loading→目标画面通过；旧日志、上下半屏帧号不一致、空白工作区、多余反色光标格及硬光标均被检出；合法反色选区不会被一概算作光标。错误之后追加正确画面，原错误类别、索引与不可变历史仍保留。同一 write 的坏帧关闭／好帧开启，以及 sync-entry、unmatched-close 窗口也被检查。

- RED：27 tests，17 pass／10 个断言失败，exit 1；GREEN：27／27，exit 0。
- standalone strict tsc：exit 0；整套测试：1273 tests，1270 pass／0 fail／3 skipped，exit 0。
- 父会话核对实际追加代码、完整日志摘要及独立 PASS；既有 capture 实现前缀和 16 个测试不变。未重复跑已完成整套测试。
- 当前 fixture SHA-256：`4ee53b9622e34cb5212d8eaa952c403452383373ecae45d334cfa9a7c3b6aa38`；测试：`468743deb54863380cd6d5a00f51fd47dd1c1e1fa36a202afd639cba6bf8397f`。证据位于 SDD 的 `task-14-report.md`、`task-14-review.md`、`task-14-*.log`，验收副本为 `baselines/step14/`。

边界：该判定器证明能检出错误状态，不自行证明必需目标已出现或满足时限；它允许跳过可选的允许画面，每个错误状态只报告一个主类别。后续场景必须另证目标出现、子帧完成及触发入口因果。这些自测不是现场半帧根因、延迟达标、A4／A5 或真实终端像素的证据。

## P2：步骤 15 九组半帧诊断验收

plain／same-write／split 与 ticker／status／capture 的九组试验均保留 F0 种子、最终 F1／F2、流哈希和关闭顺序、同一次子写入及真实接收 chunk 的 CLOSE＋OPEN 证据、分片字节身份与清理结果。实际暂停均超过 40ms。输出调度、真实 status 回复、settle 强制呈现和输入回显均已留下混帧；自然 loading ticker 呈现 loading，未复现混帧。只读 capture 不提交终端画面，新 attach 加载该 capture 时则复现混帧。另保留 hydrate 丢失隐藏光标状态的独立缺陷，尚未修复。

父会话曾否决基于时间窗的归因结论，原实现者已修正为实际 onSocketData 接收调用身份；同次接收中所有能触发渲染的消息均被保留，多个候选原因标为归因不唯一，缺失身份标为未知。新的 status 请求与只含 status 的实际接收直接关联。九组入口结论未改变；连接／退出阶段原来被错误单独归因的合并消息，现在如实保留多个候选原因。原复核者已撤回此前过度确定的结论并验证修正，原始报告和反例仍保留。测试的历史 HEAD 常量也已改成当前检出版本的独立校验。

修正后 focused 44／44、四项新增自测 4／4、保留的九组 CLI 试验 exit 0。父会话因类型检查日志缺失，补执行一次独立 strict tsc 并留存完整命令与 EXIT=0。先前关联测试 10／10、整套 npm test 1286 tests／1283 pass／0 fail／3 skip 属于修正前源码，不冒充当前整套验证；两次历史全套日志均保留，未重复运行整套测试。

父会话已核对实际哈希、完整差异、32 项既有测试前缀、九组目标／字节／清理证据和新的消息身份，并再次逐文件比较旧交付归档，随后验收并立即勾选步骤 15。完整证据见 SDD 的 task-15-acceptance.md、task-15-integration-parentfix2-parent-facts.json 和 task-15-integration-parentfix2-review.md。该结论只覆盖诊断，不代表生产修复、延迟达标、尺寸／冷启动信号充分或真实终端像素验收。

## P2：步骤16首轮超时与恢复边界

步骤16子任务在源码编写阶段达到30分钟执行期限，复核未启动。已增加三种诊断fixture和场景草稿，但CLI尚只运行S，也没有新的步骤16测试或真实runner试验。现有cold／theme冒烟只经普通管道运行，不能证明真实TUI的主题或尺寸时序；其完整stdout没有留存，原工具摘要和两个事件文件已保留。

父检查确认四处草稿问题：冷启动文字数组只有21行，违背22行的独立画面契约；场景的同名变量导致strict tsc报TS2365；尺寸用例在所谓首次捕获前已经挂载attach，存在resize竞态；发送日志只在5ms后安装，可能漏记首次resize。语法检查通过不等于诊断通过，既有44项测试也尚未在当前草稿运行。

失败现场与现存证据已归档并逐文件比较通过，未发现仍存活的对应runner／fixture进程，父会话没有发送清理信号。恢复沿用原实现者和模型，父会话未修改执行设置。恢复任务实际未在30分钟终止，因此先前所说恢复期限保持有效缺乏运行证据。2026年10月24日03:14:48至09:23:11（北京时间）的六小时事件空档发生在恢复任务内部，原因未知，不能归咎于测试命令。初次失败证据见failures/step16-timeout-1/README.md；恢复交付和全部现存记录已另行归档。

## P2：步骤16尺寸检查点与父检查

恢复修正了22行画面契约、类型错误、首次捕获早于attach挂载的顺序，以及首次发送日志的安装。当前保留的定向测试为9／9、strict tsc退出0；原有32项测试前缀及已验收观测器不变。三次真实尺寸试验均保留：第一次因旧式runner没有命令确认而超时；第二次暴露误标的teardown检查；第三次完成了120×28种子、一次80×22 resize、同commandId的applied确认、旧尺寸G1与真实新尺寸G2的原始记录。诊断执行完成不等于画面通过，第三次仍保留9项画面判定失败。

实际时序严格分层：resize发送550.295ms，applied收到551.972ms；旧尺寸G1的内层帧尾解析819.473ms，外层第26条画面提交866.747ms；真实80×22的G2内层帧尾1064.245ms，外层第32条目标画面提交1110.124ms。子进程时钟另列，未与父时钟混算。旧尺寸字节和内层入队hash一致，足以保留具体反例；但不能把相邻内层帧尾和外层提交当成同一时刻或确定因果。

父检查最初发现P3硬编码、缺失证据反向判定、帧号与尺寸混淆及时间邻近归因，原报告与反例均保留。conditionfix1修正这些具体问题；现存attempt3离线重分析的P1／P2／P3均有具体反例，外层因果身份仍明确未知。conditionfix1当时source对应GREEN5／5、直接相关helper1／1、strict tsc退出0；RED实际为3项断言失败与2项缺少迁移字段的TypeError，不是报告所称5项干净行为断言失败。父会话另用纯合成边界见证发现重复hash的last-wins误归因、P3遗漏已知旧尺寸，以及同写入CLOSE→OPEN被计数法误判；这些不改变现存唯一hash记录的具体反例，但须在下一检查点补保护，不能泛化为可靠判定器。完整交付已逐字节归档，SHA256为7204f13fea2ec585c0626bd1f7b7072cb1a2c693b67c8ac0d55c3a04737d8592。详见task-16-conditionfix1-parent-adjudication.md、parent-facts.json及parent-edge-probes.json。

A5检查点已完成有限父验收，详见task-16-a5-parent-adjudication.md及parent-facts.json。三项边界保护的RED为3项真实断言失败与1项对照通过，GREEN为9／9，strict scenario tsc退出0。唯一真实A5试验先证明空基线，再挂载attach；子进程实际raw=true早于启动文字和编辑区。外层启动文字提交578.140ms，就绪标志观测606.071ms，半屏提交860.747ms与1215.468ms，内层完整帧尾1216.618ms、drain1216.633ms，完整E1外层提交1263.882ms。子时钟单列，未将相邻提交强行归因。55条观测均无poison，原始18项画面判定失败完整保留；child／runner自然退出，无强杀或证据复制错误。

退出后的两项位移已通过原始写入身份和TUI源码解释：默认stop退出备用屏幕后保存整份24行文档，末尾换行使普通屏幕滚动一行；独立24行网格与可见光标期望均匹配。原有错误投影记录未删除，后续仅离线补充分阶段说明。Pi源码只证明初始化次序，不能单凭标题稍后增加就把首张完整编辑／选择界面判为不合格；A5保持UNESTABLISHED，新增就绪标记只是可能方案。交付50个清单文件共55131770字节已逐字节归档，SHA256为a2a3930bef577e99f47b9c5e5b205515b99934d151d889c13428f3eff7048a57。

下一阶段按task-16-theme-final-brief.md由原负责人完成两类真实主题回复、既有A4／A5的离线阶段补充、最终定向检查及完整交付，随后由父会话派发独立复核；不重复尺寸／冷启动试验，不改生产逻辑。步骤16未勾选。

## P2：步骤16主题交付与诊断验收

两次主题试验分别保留独立原始记录，均为真实runner／组件／TUI链路，整份发送记录中同尺寸resize为0。及时回复：查询写出814.776ms，回复注入842.488ms，997;1诊断收到844.006ms；子进程重绘字节与内层入队hash一致，完整帧尾850.719ms、drain850.730ms，Terminal.write10收到895.279ms，外层目标提交898.524ms。迟到回复：查询810.477ms，真实500ms超时诊断收到1311.674ms，回复1318.569ms，经保留的onLateReply链路收到997;2／late:true诊断1320.306ms；帧尾1326.230ms、drain1326.241ms，Terminal.write10收到1369.786ms，外层提交1373.005ms。子时钟单列；上述内外层时间按原始身份分开记录，未以时间邻近证明因果，也未当成物理像素或正式延迟验收。

最终源码的完整ready文件59／59、相关消费者32／32、独立严格类型检查退出0。首次ready运行因CLI遗漏S而失败58／59，原始失败保留，最小修正后才通过。ready文件包含S真实电池；A4／A5／T的真实诊断是各自另存的CLI试验，不将它们伪称同一次测试执行。及时T的scenarioHash为478992d8…，迟到T为706759c2…，最终源码为79253435…；各版本记录分别保留，不能将早期试验重标成最终源码运行。当前运行器材料为checked／review-required，上次缺少结构化报告的拒绝记录仍保留。

交付及父检查76个清单文件共72943968字节已逐字节归档，压缩包SHA256为d2245649544c7863254cc8ac51ad587075f8493e4125e64902fc8f97875911bd。完整独立复核已完成，报告准确性修正后由原审查者确认COMPLIANT／APPROVED；父会话核对报告与4份源码未变的证据并验收步骤16。完整裁定见task-16-acceptance.md，原复核与更正均保留。A5六次启动光标错误属于期望缺口，六次空白／六次半屏暴露保留；种子快照的光标丢失另见S／T。stop-entry光标仅记录而未验证，缺少childPID时的清理状态须在P3框架复用前修正。A4／A5仍为UNESTABLISHED，诊断验收不等于生产gate通过；先补证据驱动设计修订及复核，再进入P3／P4。

修正后的诊断验收包已另行归档，38个清单文件共878658字节，压缩包SHA256为0a7339e21fb84b39971ebe44caf9ac143af9fdeea0cfa6c54891ff8faef46c43，所有归档成员与来源逐字节一致。下一项只读调查聚焦现有Pi公开接口能否提供“当前尺寸下完整工作区已写出”的可靠事实；若不足，明确最小接口扩展及兼容边界，再准备修订与复核，不预设必须增加协议标记。

公开写接口候选尚未成立。初始只读报告提出Terminal.write观察器，但父检查发现：排除同写open／close会排除正常fullscreen和小型regular完整帧；单独socket报告加“某个后续close”缺少精确帧身份；部分光标操作还绕过Terminal.write直接写stdout。因此不能按初始“可实现”结论扩大生产范围，已保留原报告并交回同一调查者修正。没有运行新试验或改生产代码，A4／A5仍未证明充分。

## 未完成项

- P2后续gate：A4／A5信号充分性缺口的证据驱动设计修订与复核。
- P3：确定性回归、真实入口总延迟与基线。
- P4：生产最小变更（须先过诊断 gate）。
- P5：分格 1660 次正式比较，不将 warmup／失败移除或混为总成功率。
- P6：定向检查、npm run verify、U1–U3 实机与本地 CR。

## Step24 — actual complete-frame first publish (accepted 2026-10-28)

Modern reporter-capable protocol attach now cancels the 250ms settle, treats the 2500ms cap as expired/not-ready protection, and executes first hooks only through a qualified committed local publish. Legacy/no-reporter and undecided/late deadlines retain original behavior. Real-entry B28.413ms/Q27.090ms and C complete-editor gating are green; S's later partial repaint was explicitly left to step25. Remaining RED exactly D1-dispose/A4/A5.

Independent review approved and disproved the parent counter concern: replacement zero-baselines parserWritesInFlight, so stale callbacks must not decrement it. Verification focused169/167/2, npm1599/1588/3/8, strict support/repo tsc0. Evidence baselines step24-delivery and step24-evidence-supplement. Archive `research/step24-accepted.tar.gz`, sha256 `e0b3b1a84463156f470dc8513512c42920d5dd0d7aba51e1bcba9e7489d9e59f`. No step25/U/distribution/full-verify/physical acceptance was inferred.

## Step25 — synchronized committed view (accepted 2026-10-28)

Modern rendering now commits only the visible complete grid/cursor/attrs/OSC8/source identity at a real ?2026l or safe hydration completion. All control/output/mouse/theme entries use that view rather than a mutating parser; the 40ms scheduler remains and no history cache was added. Full-window painted S half/mixed counts are zero; raw-child split counters remain honestly reported.

The initial review blocked missing interaction tests. Fix1/fix2 added real display-A/parser-B selection/copy/word, differing URL/OSC8, CJK/background, real-open scroll intent, open hydration and parser-drained DECTCEM tests; weak waits and missing open facts were corrected without production changes. Independent re-review approved. Final component21/21, focused172/170/2, npm1599/1588/3/8 (D1/A4/A5), perf3/3, strict support/repo tsc0. Archive `research/step25-accepted.tar.gz`, sha256 `5e92a3769f8505dd10524497f1250c780ca6859e1535781ee9225f2a2e260b4b`. Step26+/U/distribution/full verify remain open.

## Step26 — target-geometry complete redraw (accepted 2026-10-28)

Modern A4 now runs with real reporter/viewProof/PTY resize evidence. Stale100x28 rev0/intent0 frames and applied/arbitrary closes stay masked; only target80x22 rev1/intent1 complete G2 publishes with the correct committed view/cursor/hooks/order and cleanup. Callback identity uses the real geometryRevision.

Parent review rejected target-only and early→early de-dup. Final semantics advance every real mismatch and de-dup only early→next render; divergence→A and different targets cannot be suppressed. Both counterexamples have executed old-source RED→GREEN. Independent review approved. Final focused172/171/1, npm1599/1589/2/8 (D1/A5), strict support/repo tsc0; the intermediate D1-duplicate run and later runs are all disclosed. Archive `research/step26-accepted.tar.gz`, sha256 `29e059f453326e581874388f9f4203c09efc9a40abe27c414cd521fba69efe4a`. Step27+/U/formal acceptance remain open.

## Step27 — independent recovery presentation (accepted 2026-10-28)

RecoveryView is display-only and requires exact known wire generation plus geometry; it never acts as proof/readiness and shares its grid with interactions. Same-generation disconnect/resnapshot retains the old complete view/status, while epoch/generation/new-empty/geometry/dispose invalidate it. Initial hooks are not repeated.

Real modern R-reconnect proves disconnect/sinceSeq/resnapshot/F0→F1 without mixed/foreign content. Real modern R-restart proves zero post-empty old observations/writes and gen2-only content. The original backlog RED, artificial fixture-private GREEN and first natural RED are preserved; final GREEN uses no private resets and current production bytes. Independent review approved after correcting the report's causality wording. Final focused199/197/2, npm1599/1589/2/8 (D1/A5), strict support/repo tsc0, perf3/3. Archive `research/step27-accepted.tar.gz`, sha256 `a8b40458a6fced5e0f4c006b16833c5f5748244c7f5046829e6ebfaa76be3d7a`. Step28+/U/formal acceptance remain open.

## Step28 — lifecycle, timers and post-dispose zero publish (accepted 2026-10-28)

The real latePaintOfPreDisposeRender RED is closed with a source-bound, feature-detected TUI cancellation adapter that does not stop the TUI or block later unrelated renders. Fresh raw D1 and D2 new30 evidence has 15 quiet+15 render-pending iterations with zero post-close writes/frames/resources and ordered cleanup.

A monotonic wait token makes old-identity settle/hard callbacks no-ops while preserving current expiry, original legacy deadlines, modern non-publishing expiry and clock-free decisions. Theme/color/scheme/childInput and first-hook behavior remain green. Independent review approved; focused failure variants and D1-duplicate history are explicitly disclosed for step29. Final npm1599/1590/1/8 (A5), strict support/repo tsc0, perf3/3. Archive `research/step28-accepted.tar.gz`, sha256 `de74ef394dd483db5e4117691ce81f3b14d58192fee49824b0f93e0ec72dc5cc`. Step29+/U/formal acceptance remain open.

## Step29 — modern A5 and conservative no-proof boundary (accepted 2026-10-28)

Modern A5 now runs the real cold child+reporter+viewProof with every original empty/boot/raw/partial/cursor/order/hooks/cleanup assertion plus current S/F proof and committed-view facts. No production or fixture-ready preset was introduced. Legacy/no-reporter/observer-unavailable paths remain conservative, and three serial D1-duplicate runs are clean.

Independent review approved. Final focused201/201/0/0 and npm1599/1591/0/8; strict support/repo tsc0. First step15 split-producer flake and separate A5w timeout remain preserved with A5w cause UNKNOWN and both assigned to step30 stability follow-up. Archive `research/step29-accepted.tar.gz`, sha256 `bb5faa5aa04c65826a0e505f3a21f2e2f3e4907674c7883bfebde055e6193f68`. Step30+/U/formal acceptance remain open.

## Step30 — affected-suite and stability validation (accepted 2026-10-28)

All former RED A4/A5/D1 cases are individually green with raw artifacts; U/D/legacy/resize/scheme/desync/protocol/snapshot and attach-area suites pass. Two placeholder grouped command strings were corrected by explicitly rerunning only those groups with exact argv (94/94 and147/147), preserving prior logs and disclosing `manifest.reruns`.

A5w and step15 split-producer each passed three fresh serial runs; earlier failures remain visible and their causes are not declared fixed. Independent review approved. Final npm1599/1591/0/8, strict support/repo tsc0, production unchanged and step28 perf current. Archive `research/step30-accepted.tar.gz`, sha256 `d962b19dd7844c0d41481ea1e7227f7afda5f59c635532beb1baa248c559a9c4`. Formal comparison setup begins next; no1660/full verify/U claim.

## Step31 — independent formal measurement setup (accepted 2026-10-28)

Baseline detached d41a16 with original production and candidate accepted-step30 production now share identical measurement scripts and dependency versions. Baseline uses real legacy; candidate uses real reporter/viewProof for all applicable cells, including G after correcting the pre-mount seed/reporter order. No candidate-only performance switch exists.

The formal runner dry-run contains 1660 formal trials (830/version incl D) and160 excluded warmups with exact interleaved halves and unique artifacts. Actual non-D observation is >=3000ms with Q included, B25ms continuity, theme/recovery completion and D's separate lifecycle shape; the earlier Math.max observation evidence was rejected and preserved. Independent review approved, and the parent separately verified all1820 execution entries and25 mirror hash pairs. No formal trial or warmup ran during setup. Archive `research/step31-accepted.tar.gz`, sha256 `3d2562c7e6356c7c1b0f478cb67cde565a5d93a58c22dc9a7a986b11abb20e36`. Step32 formal execution is authorized next.

## Step32 — full formal coverage after reviewed recovery (accepted 2026-10-29)

The initial execution exposed an S nine-trial packaging mismatch and an unapproved resume mutation, so those records were quarantined rather than reused. A reviewed single-S/argv/cap repair and fresh run produced1737 records before stopping on R/U timeout harness defects. A second measurement-only repair skipped only the legacy-inapplicable recoveryView wait and overlapped U observation with natural jiggle restore.

The approved scoped replacement then completed exactly175 entries (R-restart baseline35,U-legacy both70,D both70) with zero infrastructure failures/timeouts and processCapMs10000. Parent and independent reviewer confirmed recovery-1 1737 - replaced92 =1645 valid, plus175 =1820 (1660 formal+160 warmups), unique IDs and no completed-cell rerun/original imports. Archive `research/step32-replacement-accepted.tar.gz`, sha256 `5b36981ca6999572a46e21ab5dd448a1c6c75b0f2ab1cc121f393765428e6a5d`. Step33 observation audit follows; no performance or U verdict yet.

## Step33 — observation evidence audit (accepted 2026-10-29)

The canonical combined set passed every observation check: all non-D actual observations are at least3000ms/completed, D retains its separate bounded post-close shape, all210 B summaries prove25ms continuity over the full measured window, T/R complete, and execution is serial with unique artifacts.

The only blocker was10 B warmup records with missing `bUpdateMs`. An additive generator fix produced a new corrected plan and audit without rewriting blocked evidence or any trial JSONL; raw summaries independently prove the behavior, so no rerun was needed. Independent review approved, including honest npm flake disclosure. Archive `research/step33-accepted.tar.gz`, sha256 `9ce3deb3d0f859ece689c7c70217773e58b640e7746d522492360d7b19db63cb`. Step34 statistics follows; observation acceptance is not a latency verdict.

## Step34 — formal statistics, CANDIDATE-FAIL (completed 2026-10-29)

The canonical1660 formal trials and160 excluded warmups produced per-cell/version metrics with ceil quantiles,+∞ handling,95% Wilson and infrastructure thresholds. Candidate fails G2 total P95/max508.329517/512.5372ms and G3 532.48396/536.549146ms against the500ms P95 gate, with26 raw counterexamples; timely-correct is20/30 and14/30 respectively. Other candidate cells pass and U/D are reporting-only.

Independent review confirmed the numbers and rejected subtracting the declared fixture holds as post-hoc gate-shopping. No raw evidence supports a safe production optimization, so the failure stands without an invented fix. Statistics and failure evidence are archived at `research/step34-statistics-candidate-fail.tar.gz`, sha256 `ea8d75361811d3e5bfc6373e2b16ea0a0bc6a131ce8fd5e9c9285c5b50f42b35`. Overall issue remains unaccepted; step35 repository verify follows.

## Step35 — full repository verify (accepted 2026-10-29)

Attempt1 preserved an A5 timing failure at publish820/complete800, stopping before coverage/pack. Attempt2 ran the FULL unchanged `npm run verify` and passed typecheck, perf3/3, tests1632/1624/0/8, coverage92.28 statements/82.73 branches/90.4 functions/92.28 lines, and pack257 files/1.2MB with shasum eaf1efe8. Source/status matched across attempts and the isolated A5 pass was diagnostic only.

Independent review approved. Archive `research/step35-accepted.tar.gz`, sha256 `ff0d0a1b2762c6d51cce55178d203a242e0f416049239d1f3588349e444ab341`. Step34 CANDIDATE-FAIL remains visible. Real-terminal candidate loading and U verification are next.

## Step36 — real-PTY matrix (accepted 2026-10-29)

All80 planned cells have observed real-PTY evidence with pending[]: B/Q/L-normal/L-alt×10,G1-3×5,C×5,R both×5,regular B/Q×5. Outer dashboard and runner child explicitly load the same candidate index under fresh isolated PI_CODING_AGENT_DIR/AGENT_BOARD_ROOT with managed Pi1.4.0 and no model request/credentials/global changes.

G target F intent1/rev1, C empty baseline+poison containment, R same-generation reconnect and gen2 restart, L real301-entry/~114.7KB history with altEnter0/1, and regular-Q actual proofs all hold. Prototype/resize/static-render gaps were corrected only in test drivers with fresh roots; production is unchanged. Observation>=3s and B25ms are bound, blocked history preserved and no owned processes remain. Independent review approved. Archive `research/step36-accepted.tar.gz`, sha256 `ff6c5178c9c1b1d8a2df5b454ccc8a4fd3dc23e23deb8265e9af00cea27e7d3a`. Step37 isolated launch-contract audit follows; step34 failure remains visible.

## Step37 — isolated launch contract (accepted 2026-10-29)

The global agent-board symlink search returned no entries and no global fallback was used. Candidate realpath/SHA256 `760a6e53f009a5526b319c1f3f59d814313f1fd4e677f172e57bfab999d2250b` and HEAD d41a16b are verified. Outer and child raw extension-load events prove both loaded the candidate under isolated PI_CODING_AGENT_DIR with the full offline/no-extensions/no-mcp flags; child adds `--session`. Managed pi-coding-agent/pi-tui1.4.0 and repo pi-tui1.1.0/xterm6.0.0/node-pty1.1.0 are separately recorded.

No credentials, model requests, pi install, global edits or auth/CLI/load deficiency remain. L's114707-byte file vs114703-byte history event is explained by session header/serialization. Independent review approved. Archive `research/step37-accepted.tar.gz`, sha256 `7820143f718fc7d5477cd4e29eb4f162d298d56d7befc78925c54f70573c04cc`. Step38 final frame and interaction acceptance follows; step34 CANDIDATE-FAIL remains visible.

## Step38 — real-PTY frame and interaction acceptance (accepted 2026-10-29)

Three real sessions (B, L-normal, regular-B) under the verified isolated launch contract passed every interaction check at raw frame/ANSI level. First visible content is the current tail+input with one cursor and no historical jump/ghost rows (B cursor{0,19}; L CJK cursor{79,16}; regular-B cursor{18,15}). Deliberate PageUp on L moved the viewport and later real output left top rows byte-stable without forcing bottom. `HELLO38` reached the child editor in all three. Exactly one OSC52 per run decoded to the displayed tail, including L's CJK `TASK36 L TAIL 中文最终回答 🎯`. Detach/reattach presented current gen-1 content only; regular mode showed real differential single-row updates and its distinct cursor. Isolated candidate loading, no model requests and no owned processes; real-PTY is not physical-pixel proof. Independent review approved. Archive `research/step38-accepted.tar.gz`, sha256 `9161ff32c1b00b73370f1731b40b855000885d4a2a4b006ef3b0d7adefc0d0c7`; raw roots run-bslow/{B,regular-B}/01 and run2/L-normal/01 plus interaction-audit.json. Step34 CANDIDATE-FAIL remains visible.

## Step39 — final results and evidence audit (documentation; issue NOT accepted)

### 1. Automated evidence

- Step30 (archive `research/step30-accepted.tar.gz`, sha256 `d962b19dd7844c0d41481ea1e7227f7afda5f59c635532beb1baa248c559a9c4`): all former RED A4/A5/D1 cases individually green with raw artifacts; the two placeholder grouped commands were replaced by exact-argv reruns 94/94 and 147/147 with prior logs preserved and `manifest.reruns` disclosed; A5w and step15 split-producer each passed three fresh serial runs with causes left UNKNOWN, not declared fixed. Final npm 1599/1591/0/8, strict support/repo tsc 0.
- Step35 (archive `research/step35-accepted.tar.gz`, sha256 `ff0d0a1b2762c6d51cce55178d203a242e0f416049239d1f3588349e444ab341`): attempt1 preserved an A5 timing failure (`publish@820 complete@800`, tests1632/1623/1/8, exit1/65s) that stopped the chain before coverage/pack. Attempt2 ran the FULL unchanged `npm run verify` (exit0/126s): typecheck, perf 3/3 (burst p50/p95 1.105/1.250ms, capture 14.54ms, hydrate 14.52ms; paced 1.251/1.479ms), tests 1632/1624/0/8, coverage All files 92.28% statements / 82.73% branches / 90.4% functions / 92.28% lines (thresholds85/70/80/85), pack 257 files / 1.2MB / 3.7MB unpacked / shasum `eaf1efe8c32c018117913e9a1badd4d8667b53c3`. Source hashes and git status identical across attempts; the isolated A5 pass was diagnostic only.

### 2. Repeated formal evidence

- Canonical set: 1660 formal trials (830/version) + 160 excluded warmups; recovery-1 executed 1737 records, 92 replaced-scope records excluded but preserved, 1645 valid + 175 scoped replacement = 1820 = 1660 + 160 with unique IDs/artifacts, zero completed-cell reruns or original imports.
- Method: ceil quantiles, missing/UNKNOWN latency = +∞ (never zero), 95% Wilson per cell/version only, infra >5% invalidates a cell, no pooled success rate, warmups excluded.
- Candidate passes with large B/Q improvement: B P95 54.1ms/max 60.8ms (baseline 2541.6/2543.8, 0/100 timely); Q P95 49.5/max 56.3 (baseline 296.3/315.6, 0/100); also S, L-normal, L-alt (100 trials each), G1 (464.8/467.3), C (30/30 at the virtual boundary 0.0ms), R-reconnect, R-restart, T-on-time, T-late all pass; U rows are compatibility-only and D rows lifecycle-only (30/30 productClean, 30/30 zeroPostClose both versions). Baseline rows fail modern thresholds by design as the real legacy comparison; C/baseline is legacy-product-red (0/30).
- **G2/G3 CANDIDATE-FAIL (exact):** G2 total-entry P50/P95/max = 498.410069/508.329517/512.5372ms, timely-correct 20/30 (Wilson95 0.488–0.808); G3 = 500.498636/532.48396/536.549146ms, timely 14/30 (0.302–0.639); approved gate P95<=500/max<=1000; 26 raw counterexample trials (10 G2 + 16 G3 IDs bound in failures/candidate-counterexamples.json). G secondary target-frame metrics pass (G1 38.1/38.5; G2 42.2/42.9; G3 54.9/55.6ms).
- Observation evidence: every non-D actual observation >=3000ms (minimum 3000.40ms) and completed; D separate bounded post-close shape 299.85–302.98ms; all 210 B summaries prove 25ms continuity over the actual window (minChildFrames 138, lastCommitLag 52.23–120.33ms in the 0..500 bound); T 140/140 and R 140/140 complete; serial execution, unique artifacts, zero infra/timeout in the final set.

### 3. Real-PTY evidence (terminal-level, not physical-pixel proof)

- Isolated candidate loading is proven by raw argv/load events on both sides: fresh per-trial PI_CODING_AGENT_DIR/AGENT_BOARD_ROOT, managed Pi 1.4.0 launcher with pi-coding-agent/pi-tui 1.4.0 (repo pi-tui 1.1.0, xterm-headless 6.0.0, node-pty 1.1.0 recorded separately), `--no-extensions --no-mcp --extension <absolute candidate index.ts> --offline -na`, child adds `--session`; global agent-board symlink absent, no global fallback, no credentials/model requests/installs/global edits.
- Step36: all 80 planned cells observed with pending[] — B/Q/L-normal/L-alt ×10, G1–G3 ×5 (target F intent1/geometryRevision1 at 80×22/300×38/80×22), C ×5 (baselineEmpty, poison only in the artifact log), R-reconnect ×5 (same-generation) and R-restart ×5 (gen-2, no old generation), regular B/Q ×5 (regular-Q 32 F proofs, mode=regular); L loads real 301-entry/114,703 byte history with altEnter 0 (L-normal) / 1 (L-alt); observation >=3s and B 25ms bound; corrections were test-driver-only with fresh roots and all blocked/pending history preserved.
- Step38 interactions: first visible content = current tail+input with one cursor and no ghost/jump; deliberate PageUp then real output leaves top rows byte-stable; HELLO38 reaches the child editor in all three sessions; exactly one OSC52 per run equals the displayed tail including L's CJK string; detach/reattach shows current gen-1 only; regular differential/cursor behavior evidenced. Real-PTY terminal evidence is explicitly not a physical-pixel claim.

### 4. Incident history (not hidden behind green cells)

- Step32 formal execution incidents, all preserved under `task-32-artifacts/incident/`: an S nine-trial packaging mismatch; an unapproved resume mutation that deleted 43 records (517→475) and changed the cap to ~30s — quarantined (hashes e5eb62dd…, 54624c6b…), rejected argv5 (cfe936ce…) and restore receipt (f826dce8…) retained.
- R-restart/baseline and U-legacy harness timeout defects were repaired measurement-only (recoveryView wait gated to the modern path with legacy `not-applicable`; U-legacy actual observation overlapped the natural jiggle restore instead of serializing a post-restore sleep); cap kept at exactly 10000ms actual+recorded. Rejected recovery-2 preflights and one host-sleep wall-clock outlier remain separate preserved history.
- The scoped replacement arithmetic (1737 − 92 = 1645 valid; +175 = 1820 = 1660 formal + 160 warmups) was independently re-derived by the reviewer from the raw JSONLs before acceptance.
- Step33's single audit blocker (10 B warmup records missing `bUpdateMs`) was an additive generator/plan metadata correction only; the blocked audit, original plan and all JSONLs are preserved byte-for-byte with unchanged hashes; no rerun was needed because the raw summaries already prove the 25ms behavior.

### 5. Final boundary — overall issue NOT accepted

Issue #222 is NOT accepted: candidate G2/G3 fail the approved total-entry P95<=500ms gate (508.3/532.5ms P95). The two declared 200ms fixture holds explain most of the totals, but subtracting/excluding them was rejected as post-hoc gate-shopping; no raw evidence supports a safe production optimization (the ~40ms scheduler read is a bound, not an attribution), so CANDIDATE-FAIL stands without an invented fix. Any metric redefinition would be a new, openly reviewed proposal, never applied retroactively. No PR, merge, release, publish or global change is authorized by this document. The local independent review chain (steps 23b2a through 38, plus statistics) is complete; the remaining plan steps 7–8 (publication/release) are authorization-bound items and are NOT silently marked complete.

### 6. Evidence index

- Production source (candidate, uncommitted): `src/ui/pty-attach.ts` `5e24a67b938e172813af1cf96e05dce2c3fc32de49e2de37526c902032d4c801` (unchanged since step28), `src/core/terminal-attach-client.mjs` `bb0f7d15f4ea51574879d44459412c7e2f1f32f835232c61efbe9c874d622b52`, `src/core/pty-attach-render.mjs` `1f7e99f416c01fbb67247d83b4dc6f0cf7725711dcd95358304aaaf6661ff02d`, `runner/pty-runner.mjs` `97223f8f66721506a79720bccce8da55d8a437f7f99b43ddc7621d401e575d59`. Candidate entry `index.ts` `760a6e53f009a5526b319c1f3f59d814313f1fd4e677f172e57bfab999d2250b`.
- Worktree `/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-222-attach-ready`, branch `issue-222-attach-ready`, HEAD `d41a16bbd3e55c6df1d1cdd60c43a7c2e2492482`; working tree carries the issue's modified+untracked set with 0 staged files and no commit (status snapshots in task-35 environment logs; step36–38 worker reports reaffirm 0 staged / no commit).
- Accepted archives (sha256): step24 `e0b3b1a84463156f470dc8513512c42920d5dd0d7aba51e1bcba9e7489d9e59f`, step25 `5e92a3769f8505dd10524497f1250c780ca6859e1535781ee9225f2a2e260b4b`, step26 `29e059f453326e581874388f9f4203c09efc9a40abe27c414cd521fba69efe4a`, step27 `a8b40458a6fced5e0f4c006b16833c5f5748244c7f5046829e6ebfaa76be3d7a`, step28 `de74ef394dd483db5e4117691ce81f3b14d58192fee49824b0f93e0ec72dc5cc`, step29 `bb5faa5aa04c65826a0e505f3a21f2e2f3e4907674c7883bfebde055e6193f68`, step30 `d962b19dd7844c0d41481ea1e7227f7afda5f59c635532beb1baa248c559a9c4`, step31 `3d2562c7e6356c7c1b0f478cb67cde565a5d93a58c22dc9a7a986b11abb20e36`, step32-replacement `5b36981ca6999572a46e21ab5dd448a1c6c75b0f2ab1cc121f393765428e6a5d`, step33 `9ce3deb3d0f859ece689c7c70217773e58b640e7746d522492360d7b19db63cb`, step34-statistics-candidate-fail `ea8d75361811d3e5bfc6373e2b16ea0a0bc6a131ce8fd5e9c9285c5b50f42b35`, step35 `ff0d0a1b2762c6d51cce55178d203a242e0f416049239d1f3588349e444ab341`, step36 `ff6c5178c9c1b1d8a2df5b454ccc8a4fd3dc23e23deb8265e9af00cea27e7d3a`, step37 `7820143f718fc7d5477cd4e29eb4f162d298d56d7befc78925c54f70573c04cc`, step38 `9161ff32c1b00b73370f1731b40b855000885d4a2a4b006ef3b0d7adefc0d0c7`.
- Formal measurement raw sets: `task-32-artifacts/formal-run-recovery-1` (trials.jsonl sha256 `32cec093d186f37e63d436f5b563f49c4bb13c7b34345b1c2f0377d93b6d3803`) and `formal-run-replacement-1` (`e3583285edaa92fde71fd98ff38297490036c5aaf63ab6e9606d1d07d916d7ec`); statistics under `task-34-artifacts/` (cell-summary.json, per-trial-metrics.jsonl, acceptance.json verdict=CANDIDATE-FAIL, failures/candidate-counterexamples.json).
