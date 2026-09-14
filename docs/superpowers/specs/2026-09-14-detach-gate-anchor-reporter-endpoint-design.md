# Issue #103 Spec — `←` detach 间歇失效（tier-1 锚点劫持 + reporter 断连）

日期：2026-09-14
仓库：`zhuxixi/pi-agent-board`，调研时 HEAD `4f3aef8`
关联：issue #103；Round 1/2 调研见 `research/01-root-cause-verification.md`、`research/02-fix-design-evidence.md`（对应 issue 区两条评论）

---

## 1. 根因（已验证，非推测）

**两条根因叠加：门禁的权威通道断线（B），兜底的启发式又会在聊天区内容上锚错行（A）。**

### A. tier-1 反色锚点被聊天区内容劫持

`src/ui/pty-attach.ts:371 childInputLooksEmpty()` 用 `findLastInverseCellLine()`（L356）取「自底向上第一个含反色 cell 的行」，**无条件**当作编辑器行（L380）。两条事实使该假设不成立：

1. pi 在聊天区也渲染反色：diff 行内变更片段（`theme.inverse`）、整条通知栏（`\x1b[7m msg \x1b[27m`）。活体 screen.log 统计：275 处反色行中 12 处是聊天区 diff 内容行。
2. 差分帧常常不重绘编辑器行（#69 已实证），此时 buffer 里没有假光标 → 自底向上第一个反色行落到聊天区 → 有文本 → 判「有草稿」→ `←` 被吞。

pi-tui 源码（`pi-tui/dist/components/editor.js` render()）给出编辑器行的真实形状：无 prompt 字形；空编辑器 = 一个反色空格 + 填充空白；draft = 文本 + 恰好一个反色 cell（光标所在字符或行尾空格）；编辑器块被两条整行 `─` 边框夹住；聚焦时硬件光标定位到假光标 cell。

### B. editor-state reporter 自 #70 起永久断连

`src/index.ts:118` 让 reporter 连 `controlSocketPathFor()`（per-view `control.sock`），而 `runner/pty-runner.mjs` `ownedMain()` 绑的是 `hostEndpointPathFor()`（per-instance `control.<instanceId>.sock`，`paths.mjs:83`）。per-instance 宿主下 `control.sock` 无人创建 → ENOENT → 无限退避重连 → 宿主 `editorEmpty` 恒 null → 门禁永远落回 A。

证据：活体 `view_e81b4d8d10` 目录内无 `control.sock`，子 pi 进程 35 个 fd 中 socket fd = 0。

---

## 2. 设计

### 2.1 修复 B：恢复权威通道（主路径）

**B1 端点发现 —— runner 直接把自绑端点交给子进程。** 在 `pty-runner.mjs` 两条路径构造子进程 env 处（`legacyMain` L220 附近、`ownedMain` L739 附近）各加一个键 `AGENT_BOARD_CONTROL_SOCKET: socketPath`（各自作用域内已存在该变量）。子进程侧用纯函数解析：

```js
// src/core/paths.mjs（新增，纯函数）
export function resolveControlEndpointFor({ envSocketPath, platform, root, viewId }) {
	if (typeof envSocketPath === "string" && envSocketPath.length > 0) return envSocketPath;
	return controlSocketPathFor(platform, root, viewId); // legacy / 旧 runner 回落
}
```

`src/index.ts` 的 reporter `connect` 改为调用它。理由与替代方案对比见 Round 2 调研（host.json 有陈旧竞态；glob 在多残留时选错；稳定别名与 #70 设计意图冲突）。

**B2 reporter 不得计入 attach 计数（阻塞级约束）。** 修好 B 后 reporter 成为常驻连接，而 runner 用 `clients.size` 写 `attachedClients`（`pty-runner.mjs:470`），该字段是 warm-host 回收（`warm-host-sweeper.mjs:53`，issue #75）与 revoke 保护（`service.mjs:807`）的判据——不处理会导致宿主永不被回收、进程泄漏。设计：

- reporter 建立连接后**先发一帧标识 hello**：`{type:"hello", clientId:"editor-reporter"}`，然后才开始推 `editor_state`。
- runner 侧引入 `clients` 之外的 `reporters` 集合（与既有 `probeSockets` 同构）：`hello.clientId === "editor-reporter"` 的连接加入其中，**不翻转 `attachedEver`、不计入 `attachedClients`**（计数改为 `clients.size - reporters.size`）；连接关闭/出错时从两个集合一并移除。
- legacy 路径同样的分类逻辑（其 connect 时无条件 `attachedEver: true` 保持不动——`attachedEver` 当前无消费方，属既有行为，不在本次范围）。

**B3 不改的部分：** `editorEmpty` 的 hello/重置语义（`runner` L269/L776 子进程退出置 null 并广播；attach 侧 L1055-1057 处理）保持原样。

### 2.2 修复 A：tier-1 候选行加形态校验（兜底硬化）

**A1 规则（采用 issue 正文方案）：只有「整行空白且反色 cell 恰好一个」或「形似 prompt 字形行」的行才配当编辑器锚点；否则继续向上扫；全程扫不到可信行 → 落既有 tier-2/tier-3 逃生。**

```js
// src/core/pty-input.mjs（新增，纯函数）
/** 该行是否可被采信为 pi 编辑器行（issue #103）。 */
export function isEditorAnchorLine({ text, inverseCellCount }) {
	if (!(inverseCellCount > 0)) return false;
	// 真 pi：空编辑器 = 整行空白 + 恰好一个假光标 cell
	if (inverseCellCount === 1 && isProbablyEmptyPiInputLine(text)) return true;
	// 旧版/变体：带 prompt 字形的编辑器行（既有 tier-1 语义，pinned 场景 B 依赖它）
	return isProbablyPiInputLine(text);
}
```

组件侧改为：自底向上遍历，跳过不含反色 cell 的行；对含反色 cell 的行调 `isEditorAnchorLine({ text, inverseCellCount })`；通过则 `return isProbablyEmptyPiInputLine(text)`，不通过则继续向上；扫完落既有 tier-2（空字形行）与 tier-3（逃生 true）。tier-2 / tier-3 / `resolveEditorEmpty` / `shouldEscapeAttach` 全部不动。

**取舍（必须显式钉住）**：A1 之后，真实 pi 的 draft 行（无字形、文本 + 单反色 cell）不再被 tier-1 采信 → 当 reporter 不在线时按 `←` 会 detach。这与 #69/#72 的「兜底恒放行」方向一致，草稿不丢（子会话继续跑，重新 attach 即回）；**draft 保护改由权威通道（B）承担**。不采用 A2（结构锚点）/A3（光标 cell 锚点）——两者能保留更多兜底能力，但需要额外的版式契约与回放 fixture，作为后续增强而非本次范围。

### 2.3 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | `isEditorAnchorLine` 纯函数语义 | 自动化验证（unit） | `npm test`（`test/pty-input.test.mjs` 新增用例） | 空+单反色→true；字形行→true；有文本+单反色（无字形）→false；无反色→false；空白+多反色→false |
| A2 | `resolveControlEndpointFor` 端点解析 | 自动化验证（unit） | `npm test`（`test/socket-path.test.mjs` 新增用例） | env 有值→原样返回（含 win32 管道名）；env 空/未设→等于 `controlSocketPathFor()` 结果 |
| A3 | reporter 首帧发标识 hello | 自动化验证（unit） | `npm test`（`test/editor-state-reporter.test.mjs`） | 收到 `{type:"hello", clientId:"editor-reporter"}` 为第一条写入；之后 editor_state 仅在文本变化时发送 |
| A4 | runner 不把 reporter 计入 attach | 自动化验证（integration） | `npm test`（`test/pty-runner.integration.test.mjs` 新增用例） | reporter hello 后 host.json `attachedClients` 仍为 0、`attachedEver` 不为 true；普通 client hello 后 `attachedClients=1`、`attachedEver=true`；reporter 断开后仍为 0 |
| A5 | runner 向子进程注入端点 env | 自动化验证（integration） | `npm test`（`test/pty-runner.integration.test.mjs`，stub 子进程回显 env） | 子进程 env 的 `AGENT_BOARD_CONTROL_SOCKET` == 该实例实际绑定的 socketPath（owned 与 legacy 两条路径各一次） |
| A6 | 端到端：reporter → runner → attach | 自动化验证（integration） | `npm test`（新增用例，复用 pty-runner 集成 harness） | 连接真实绑定端点并推送 `editor_state{empty:true|false}` 后，新 attach 客户端收到的 `hello.editorEmpty` 与之相等；子进程退出后回落 null |
| A7 | detach 门禁行为（含新场景与既有场景不回归） | 自动化验证（automated harness） | `node --experimental-transform-types test-support/detach-gate-smoke.ts`（由 `test/pty-attach-detach-gate.test.mjs` 断言） | 既有 A…N 全部 key 为 true；新增：聊天区 diff 反色行+无假光标空编辑器行→detach；反色通知条+同前→detach；无字形 draft+假光标→detach（**有意取舍，注释标明**）；对照（同布局无反色）→detach |
| A8 | 类型 / 全量回归 / 打包 | 自动化验证（static + build） | `npm run verify`（typecheck + test + coverage + pack:dry） | 全绿 |
| U1 | 实机 attach 反复 `←`（issue 现象本身） | 用户实测 | attach 进一个 Running 的 pi 会话，确认编辑器为空，反复按 `←` 十余次（含流式输出期间） | 每次都 detach，不再出现「按键被转发、用户被困」 |
| U2 | 实机 draft 保护与已知取舍 | 用户实测 | ① reporter 在线（新版子进程）时在编辑器输入草稿，按 `←`；② 观察 reporter 不在线的情形（如旧版子进程） | ① 光标左移、不 detach；② 会 detach，确认此取舍可接受（草稿未丢，重新 attach 即回） |

### 2.4 可测性拆分设计（实现硬约束）

| 拆分出的单元 | 位置 | 性质 | 测试边界 |
|---|---|---|---|
| `isEditorAnchorLine({text, inverseCellCount})` | `src/core/pty-input.mjs` | 纯函数（无 xterm 依赖） | 单测覆盖规则语义；组件只做「取行 → 数反色 cell → 调用」 |
| `resolveControlEndpointFor({envSocketPath, platform, root, viewId})` | `src/core/paths.mjs` | 纯函数 | 单测覆盖 env 优先与 legacy 回落、win32 管道名 |
| `createEditorStateReporter({...})` 的 hello 帧 | `src/core/editor-state-reporter.mjs` | 注入式（已有 fake socket 测试基建） | 单测断言首帧内容与发送时序 |
| 客户端分类判定 | `runner/pty-runner.mjs`（提取 `classifyClientHello({clientId})` 纯函数 → `"probe" | "reporter" | "client"`） | 纯函数单测 + 集成断言 host.json 计数 |
| 子进程 env 构造 | `runner/pty-runner.mjs`（提取纯 helper `hostChildEnv({root, viewId, socketPath, baseEnv, extraEnv})`） | 纯函数 | 单测断言键值；集成断言真实 spawn 的子进程可见 |
| 门禁扫描循环 | `src/ui/pty-attach.ts childInputLooksEmpty()` | 副作用适配层 | 由 smoke harness（A7）覆盖，不追求单测 |

不可自动化项说明：U1/U2 需要真实终端与真实 pi 子进程交互（按键语义、时序敏感的差分重绘），合成 buffer 无法覆盖「实机按键链路」；因此保留用户实测，并在实现后用 `host.json` / 进程 fd 做旁证（reporter 在线时子进程应出现 socket fd）。

### 2.5 非目标

- 不实现 A2（dock 结构锚点）/ A3（光标 cell 锚点）——记为后续增强。
- 不改 `←` / `Ctrl+←` 的用户语义与 #48 断线逃生、#89 和弦。
- 不重构 legacy 宿主端点命名与 `attachedEver` 的既有粗糙判定（仅保证 reporter 不污染 attach 计数）。
- 不触碰 #106（jiggle controller `feed()`）与 desync heal 逻辑。
- 不引入 host.json 动态发现 / glob 发现 / 稳定别名（理由见 2.1）。

### 2.6 风险与回滚

| 风险 | 缓解 |
|---|---|
| reporter 常驻连接带来额外广播流量 | reporter 已有 `data` 丢弃处理；必要时可从广播集合排除（本 spec 不改广播语义） |
| A1 使兜底失去 draft 保护 | 显式钉进 smoke harness + 写进 issue 注释；权威通道（B）承担保护 |
| env 键在旧子进程/旧 runner 组合下缺失 | 纯函数回落 `controlSocketPathFor()`，行为与今天一致 |
| 计数改动影响回收判据 | A4 用例直接断言 host.json 计数；既有 sweeper 单测（纯函数）不受影响 |

---

## 3. 落地顺序（Step 6 写 plan 用）

1. 纯函数 + 单测：`isEditorAnchorLine`、`resolveControlEndpointFor`、`classifyClientHello`、`hostChildEnv`。
2. B1：runner 注入 env + `src/index.ts` 消费（A5）。
3. B2：reporter 标识 hello + runner 分类计数（A3、A4、A6）。
4. A1：`childInputLooksEmpty()` 扫描改为校验锚点（A1、A7）。
5. 全量 `npm run verify`（A8）+ 用户实测 U1/U2。

---

## 4. 已确认的设计决策（2026-09-14 用户确认）

1. **A 规则采用 A1 严格化**（issue 正文方案）：接受「reporter 不在线时 draft 行不再被兜底保护」这一取舍；A2/A3 记为后续增强。
2. **reporter 发标识 hello**：`{type:"hello", clientId:"editor-reporter"}`，runner 将其排除出 `attachedClients` / `attachedEver`。
3. **端点发现采用 runner 注入 env**：新增 `AGENT_BOARD_CONTROL_SOCKET`，缺失回落 `controlSocketPathFor()`。
