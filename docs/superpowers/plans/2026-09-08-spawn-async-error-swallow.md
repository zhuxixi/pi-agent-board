# issue #86 plan：spawn 异步 error 兜底实现

日期：2026-09-08 · spec：docs/superpowers/specs/2026-09-08-spawn-async-error-swallow-design.md

## 任务拆解

### T1：launch.mjs spawnDetached helper + 4 处收敛（A1, A2）

**改动**（`src/core/launch.mjs`）：
1. 文件底部（或 import 后）新增模块内 helper：
```js
function spawnDetached(command, args, cwd) {
	const child = spawn(command, args, {
		cwd,
		detached: true,
		stdio: "ignore",
		env: process.env,
		// Windows: detached children get their own console window unless
		// suppressed (CREATE_NO_WINDOW; no-op on POSIX) — issue #49.
		windowsHide: true,
	});
	// Swallow async spawn failures (e.g. transient ENOENT on the node binary):
	// without an 'error' listener the EventEmitter rethrows as uncaughtException
	// and takes down the whole host Pi process (issue #86). Callers already
	// record state "failed" via the pid == null branch.
	child.on("error", () => {});
	child.unref();
	return child;
}
```
2. `launchRun` / `launchHost` / `launchTitle` / `launchAutoState` 四处的 `spawn(...)` + `child.unref()` 收敛为 `const child = spawnDetached(node, [opts.runnerScript, configPath], config.cwd);`，返回值逻辑（`child.pid ?? null`、writePid 等）不变。

**测试**（`test/launch.test.mjs`，复用现有注入模式）：
- 新增 1 个测试：注入 `node: "/nonexistent/node-ENOENT-test"`，依次调用 4 个入口，断言：各自正常返回 `{ pid: null }`；`process.on("uncaughtException")` spy 不被触发；等待 ~300ms 让异步 error 有机会冒泡（进程崩 = 测试天然失败）。
- 现有 4 个测试不动（A2 回归）。

### T2：pty-attach.ts openExternalTarget error 兜底（A3）

**改动**（`src/ui/pty-attach.ts` L1150-1167）：三分支统一为：
```ts
const child = spawn("xdg-open", [sanitized], { detached: true, stdio: "ignore" });
child.on("error", () => {});
child.unref();
```
（darwin `open`、win32 `cmd /c start` 同理）。参照 L847-848 xclip 既有模式。

### T3：全量回归（A4）

`npm test` + `npm run typecheck`，568+ 全绿。

## 验收对账

- A1 → T1 新测试
- A2 → T1 既有测试回归
- A3 → T2 代码审查 + `rg 'child.on\("error"' src/ui/pty-attach.ts` 断言三分支（A3 static）
- A4 → T3
