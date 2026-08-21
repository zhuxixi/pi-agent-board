# Issue #9 Spec — dashboard 方向键卡顿修复

状态:待用户确认
类型:bug/perf(根因已完成,见 issue #9 正文与调研评论)

## 目标

1. 按方向键的选中移动延迟降到感知阈值内(<16ms):按键处理本身不做磁盘 IO、不 spawn 进程
2. 轮询周期内主线程同步 IO 阻塞显著下降(目标:单周期 <60ms,当前 ~400ms)
3. 不改变 attach 预热的行为收益(选中后仍会预热,只是延后)

## 非目标

- store 全面异步化(fs/promises 重写)——不做,风险大收益边际
- mtime 缓存层——归档短路后若实测仍慢再立项
- screen.log 体积治理——issue #1 已完成
- 渲染器/GPU 相关改动——已证实无关

## 设计

### Fix A:按键先响应,prewarm 延迟 + 防抖(src/ui/dashboard.ts)

- `moveSelection()`:只改 `selectedId` 并立刻触发渲染(现有 invalidate 链),移除同步 `prewarmSelected()` 调用
- `prewarmSelected()` 改为防抖调度:单例 timer,~200ms 无新移动才执行;新按键重置 timer(连续移动只预热最终落点,顺带消除连环 spawn/terminate host)
- 清理点:`dispose()`、模式切换、组件卸载时 clearTimeout

### Fix B:listRows 归档短路(src/core/store.mjs)

- `listRows(root, opts)`:循环内先 `readMeta()`,若 `meta.archived && !opts.includeArchived` 则 `continue`,不再进入 `loadRow()` 的完整 artifact 加载(state/evidence/host/diagnostics/queue/steering)
- `loadRow()` 本身不动(单行加载语义保持,service 内部按 id 操作仍走它)
- 效果预估:artifact 读取从 168 行降到 11 行(本机),单次 listRows ~204ms → ~20-30ms
- `pruneWarmHosts`、`reconcile()` 内的 listRows 自动受益,无需改动

### Fix C:ensureHost 探测降级为 TTL(src/runtime/service.mjs)

- `ensureHost` 的 `ptySupport({ refresh: true })` 改为默认参数(失败态 2s TTL,成功态进程生命周期缓存)
- 依据:#37 已确立"成功探测必须缓存、失败探测短 TTL"纪律;refresh:true 在 PTY 故障环境下会造成按键路径每键 spawn

## 决策表

| 决策 | 选择 | 理由 |
|---|---|---|
| prewarm 延迟方式 | setTimeout 防抖 200ms | setImmediate 会在同帧渲染前抢跑;200ms 让连续导航只预热落点 |
| 归档过滤位置 | listRows 内、readMeta 后 | 最小改动点;roster 不存 archived 标志,meta 是唯一权威来源 |
| 防抖期间用户已 attach | timer 触发时再查模式,非 list/已切换则跳过 | 防止陈旧预热 |
| evidence 按需加载 | 本期不做 | 归档短路后 11 行 evidence 读取 ~9ms,不构成瓶颈 |

## 测试计划

- 单测(store):临时目录构造 N 个 view,归档行**缺失** state/evidence/host 文件 → `listRows()` 不抛错、只返回非归档行(证明短路生效);`includeArchived: true` 行为不变
- 单测(dashboard):模拟连续 moveSelection,断言 prewarm 仅在静默 200ms 后触发一次(注入 fake service 计数)
- 存量测试全绿(`npm test`)
- 性能验证(文档化,非 CI 断言):本机真实 store 上 listRows 前后耗时对比 + 按键-渲染延迟对比,数据回贴 issue

## 降级/风险

- 防抖延迟 prewarm 200ms:attach 预热收益不受影响(用户从选中到按 enter 远大于 200ms)
- 归档短路只影响 `listRows`;service 单行路径(`loadRow`)不变,无行为回归面
- Fix C 唯一语义变化:手动修复 PTY 权限后最多 2s 才重试(原为立即)——可接受
