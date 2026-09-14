# Spec：coordinator 管道名对 root 字符串形式敏感（issue #124）

日期：2026-09-15 · 状态：approved（用户确认）
调研：issue 评论 R1（根因确认 + 修复可行性 + 向后兼容实测）

## 1. 根因（systematic-debugging 结论）

**根因**：`coordinatorEndpointPathFor`（src/core/paths.mjs:101-107）在 win32 上以 `sha256(String(root))`——root **原始字符串**——作为命名管道名，不做任何归一化；而同一逻辑 root 的**锁路径**经由 `path.join` 归一化。两个键对 root 形式敏感度不一致 → 同一逻辑 root 的两种写法（`C:/x` vs `C:\x`、尾分隔符、`.` 段）= **同一把锁 + 两根不同管道**。

**触发条件**：任何绕过 `defaultRoot()`（`src/index.ts:27`，`path.resolve` 归一化）的 root 传入。`runner/state-coordinator.mjs:88` 直接 `const root = process.argv[2]`（原样使用）—— 手动/外部以不同形式启动 coordinator 即触发。

**症状**：面板按自身形式 probe → ENOENT → 反复 spawn 新实例 → 新实例抢锁失败（锁被占）→ 面板永久 `coordinator_unavailable`；占锁实例永远收不到面板命令。现场误导性强（coordinator 活着、心跳正常、ping 通），易与 #114 混淆。

**证据链**：
1. 实机复现：面板 root = 反斜杠（`AGENT_BOARD_ROOT=C:\...` → `path.resolve`），手动启动用正斜杠 argv → 两根管道（`0af89859…` / `8b9d0e3c…`）+ 同一把锁；
2. 同机实测：两形式 endpoint 不同（issue 正文表格），锁路径相同；
3. 代码静态核对：paths.mjs 三个 endpoint 中**只有** coordinator 以 root 为键（control 用 viewId、host 用 instanceId）；
4. 归一化实测：4 种写法折叠为同一 hash，且**规范形式 hash 不变**。

## 2. 修复设计

### 2.1 归一化 hash 输入（D1）

`src/core/paths.mjs`：

```js
export function coordinatorEndpointPathFor(platform, root) {
	if (platform === "win32") {
		// Normalize before hashing: the pipe name must be invariant to the root's
		// spelling (C:/x vs C:\x, trailing separators, dot segments). The lock path
		// derived from the same root already is (via path.join); a mismatch yields
		// "same lock, two pipes" — panel permanently locked out (issue #124).
		// resolve() is idempotent on canonical roots, so already-deployed
		// coordinators keep their pipe name and need no restart.
		const normalized = path.win32.resolve(root);
		const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
		return `\\\\.\\pipe\\agent-board-coordinator-${hash}`;
	}
	return path.join(root, "coordinator.sock");
}
```

- **win32 语义显式指定**：hash 前用 `path.win32.resolve` 而非宿主 `path.resolve` —— 该分支必须在任何宿主 OS 上产出同一管道名（Linux/macOS 宿主的 `path.resolve` 是 POSIX 语义，会把 `C:\x` 当作相对路径：没有盘符与反斜杠分隔符语义），使 platform 注入式单测与 CI 在任何 OS 上行为一致；Windows 宿主上 `path === path.win32`，输出逐字节不变。
- **可测性拆分**：该函数已是纯函数（platform + root → string，零副作用、无 I/O）→ 直接单测，无需新增抽象；副作用（bind/connect）留在 client/runner。
- **向后兼容（实测）**：`path.resolve(canonical) === canonical` 成立 → 规范形式（生产 `defaultRoot()` 的产物）hash **不变** → 已部署 coordinator 管道名不变、零中断（实测数据见 issue R1 评论）。
- **POSIX 分支不改**：其 endpoint 是文件系统路径，`path.join` 已归一化；改为 `path.resolve` 会让相对 root 语义变化（行为改变而非修复）。

### 2.2 测试（D2）

**unit —— `test/socket-path.test.mjs`**（该函数专属测试文件，platform 参数注入 → 跨平台可跑）：

1. win32：同一逻辑 root 的多种写法（`C:/r`、`C:\\r`、`C:\\r\\`、`C:\\.\\r`）→ **同一**管道名；
2. win32：不同 root → 不同管道名（per-root 隔离保留）；
3. win32：前缀与长度约束（`\\.\pipe\agent-board-coordinator-` + 16 hex，≤256）；
4. linux/darwin：返回 `path.join(root, "coordinator.sock")`，行为与修复前一致；
5. 断言不硬编码本机路径的 hash —— 用"多写法互相相等"+"与 `path.resolve` 语义一致"表达，保证跨机器可移植。

**integration（可选强化）—— `test/coordinator-client.test.mjs`**：以 root 的一种写法 spawn/ensure，用另一种写法的客户端调用 → 成功（Windows 上是本 issue 的端到端复现；POSIX 上两写法本就是同一 socket）。

### 2.3 非目标

- **大小写折叠**（`C:\...` vs `c:\...`）：仍产生不同 hash。`path.resolve` 不改大小写；无条件 case-fold 会改变现有规范形式的 hash（破坏向后兼容），且 POSIX 大小写敏感语义不允许无条件折叠 → 记为已知限制。
- POSIX 分支改动。
- root 入口统一归一化（`defaultRoot()` 已归一化；runner argv 归一化无额外收益 → YAGNI）。
- 不复用/改动 #114 的孤锁回收逻辑。

## 3. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
|----|--------|----------|----------|----------|
| A1 | win32 管道名对 root 写法不变 | 自动化验证（unit） | `node --test test/socket-path.test.mjs` | 4 种写法同一管道名 |
| A2 | per-root 隔离保留 | 自动化验证（unit） | 同上 | 不同 root 管道名不同 |
| A3 | 管道名格式/长度约束 | 自动化验证（unit） | 同上 | 前缀正确、16 hex、≤256 |
| A4 | POSIX 行为不变 | 自动化验证（unit） | 同上 | 等于 `path.join(root, "coordinator.sock")` |
| A5 | 端到端跨写法互通 | 自动化验证（integration，真机） | `node --test test/coordinator-client.test.mjs` | 一种写法启动、另一种写法 ensure 成功 |
| A6 | 无回归 + 类型干净 | 自动化验证（static + unit） | `npm run typecheck`；`npm test` | typecheck 零错误；全量失败集不新增（Windows 既有环境类失败除外，需给出基线对比） |

无必须的用户实测项：A5 已覆盖原始症状的端到端路径（跨写法互通）；如你希望，也可在合并后用正斜杠形式手动启一次 runner 复验。

## 4. 影响文件（预估）

- `src/core/paths.mjs`（+~5 行：归一化 + 注释）
- `test/socket-path.test.mjs`（+~40 行：不变量/隔离/长度/POSIX 断言）
- `test/coordinator-client.test.mjs`（可选 +~30 行：跨写法 e2e）
