# Issue #284 — U1/U2 用户实测试点指南（post-implementation，状态：pending）

自动化验收（A06–A12）已全绿；U1/U2 是**用户实测项**，与自动化绿灯互不替代（spec §5/§6）。执行时机：任何时刻（本 worktree 的 `npm run verify` 已全过；PR 合并非前置）。未执行前，U1/U2 报告状态保持 pending。

## 隔离拓扑（防误用全局安装）

所有路径固定到本 worktree（SHA 以实际执行时 `git -C <worktree> rev-parse HEAD` 打印为准）：

```bash
WT=/home/elling/work/git-repo/pi-agent-board/.pi/worktrees/issue-284-attach-recovery-budget
ENTRY="$WT/index.ts"                      # extensionEntry（绝对路径）
RUNNER="$WT/runner/pty-runner.mjs"        # runner（绝对路径）
export PI_CODING_AGENT_DIR="$WT/.u1-dir"  # 独立 agent dir
# board root、socket 均落在该隔离目录下；操作者的 attach UI 必须由同一 entry 加载：
pi --no-extensions --no-mcp --extension "$ENTRY"
# runner 与受管 child 固定同一 worktree；不复用现有 dashboard、不 reload 在跑会话
```

执行前打印并记录三条路径与 SHA（ENTRY/RUNNER/WT + HEAD SHA）到样本日志。

## U1 — 全新 fullscreen 会话首次 attach（目标：回答「300ms 内能不能做到」）

基线对照：main `6f7b2dc`（#284 之前）与修复分支各跑一轮，相同几何/模式/输出脚本。

1. 在受管 child 里进入真实 fullscreen TUI（vim/nvim 或等价），**新建会话**后第一次 attach；记录首个非 loading 内容的延迟、readyReason、实际来源尺寸。
2. detach 后**同尺寸**再 attach；对比 quiet 与持续输出两种形态。
3. 每形态 ≥10 次首 attach + 10 次 reattach 原始样本；登记 P50/P95、快照可用时间、首次呈现时间、readyReason 分布（complete / committed-degraded / legacy-*）。
4. 每条样本四问：是否正确显示当前会话？是否 <1500ms（受控）/<300ms（产品目标，仅 committed-degraded 形态）？是否满足 D3 七谓词语义（>预算样本注明阻塞门禁）？最终 F 是否恢复（readyReason 翻转 complete）？
5. 成功率按父 spec §4.1 分子/分母报告；不同尺寸与 empty 样本保留在全部尝试中，不混入快速路径分母。

## U2 — 不同尺寸、版本组合与故障恢复

1. attach 期间改变 rows/cols：旧尺寸 view 不得提前 ready；target F 到达后显示正常；capability loss 不伪造 geometry proof。
2. 隔离旧 runner（main `6f7b2dc` 的 pty-runner.mjs）+ 新 UI：可协商组合不无限依赖新私有消息（本设计零 wire 变更）；全旧/无 witness 组合走 legacy 策略不作为 250ms 目标。
3. 锁存序列确认（#284 核心行为变更）：witness 启用后触发 reporter 失效（如杀掉控制 socket）→ UI 停留在 committed 呈现（不闪 loading、不回 legacy）→ resnapshot/新闭合帧到达后画面继续更新；无新闭合帧时旧画面保留（已知限制，预期行为非缺陷）。

## 结果记录

样本与结论评论回 issue #284；若真实 provider 条件不可用，如实登记「U1/U2 未验收 + 已有自动化证据 + 缺失环境 + 下一步」，不得以 A 修复或更快出现内容推断原始 #267 现场已解决。
