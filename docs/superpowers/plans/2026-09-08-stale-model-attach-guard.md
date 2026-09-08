# issue #90 plan：defaultModel 失效防护实现

日期：2026-09-08 · spec：docs/superpowers/specs/2026-09-08-stale-model-attach-guard-design.md

## 任务拆解

### T1：core 匹配函数 + service 注入（A1, A4）

1. `src/core/launch-options.mjs` 新增导出（spec D1.1 签名原样）：
```js
export function modelRefAvailable(modelRef, availableModels) {
	const ref = String(modelRef ?? "").trim().toLowerCase();
	if (!ref) return true;                    // no constraint
	if (!availableModels || availableModels.length === 0) return true;  // can't judge → allow
	return availableModels.some((m) => `${m.provider}/${m.id}`.toLowerCase() === ref);
}
```
2. 单测：若已有 `test/launch-options*.test.mjs` 则加入，否则新建。真值表：精确匹配（大小写混合）→ true；不匹配 → false；null/空串 → true；availableModels undefined/[] → true；部分匹配（"glm-5.3" 不配 provider）→ false。
3. `src/ui/dashboard.ts` L1738 `findLaunchModelByRef` 改为内部调用 core 的匹配逻辑（保持返回 LaunchModel 对象：find 复用 `modelRefAvailable` 不可行——它返回 boolean；改为直接复用 core 里新增的共享比较，或最简单：dashboard 本地函数改为 `models.find(m => modelRefAvailable(ref, [m])) ?? null`。选最简单且单一事实源的写法）。
   - 注：若这步让 diff 变脏（import 路径等），可以跳过，dashboard 本地函数保持——在 plan 偏差里说明即可。优先级低。

### T2：service 校验接线（A2, A3, A5）

1. `createService` opts 新增：`availableModels`（`() => Array<{provider:string,id:string}> | undefined`；默认 undefined → 跳过校验）。JSDoc typedef 更新（文件内 createService opts 注释处）。
2. service.mjs 模块内新增 helper：
```js
/** @returns {string|null} error message when the view's defaultModel is provably unavailable. */
function validateViewModelMeta(meta) {
	const model = meta.defaultModel ?? null;
	if (!model || !optsAvailableModels) return null;
	const list = optsAvailableModels() ?? undefined;
	if (modelRefAvailable(model, list)) return null;
	return `Model "${model}" configured for this session is no longer available — update the view's model (or clear defaultModel) and retry attach.`;
}
```
（注意 availableModels() 调用本身 try/catch → undefined。）
3. `startHostUnderLease`（L205）：在 canReplaceHost 检查之后、instanceId 生成之前插入：
```js
const modelError = validateViewModelMeta(meta);
if (modelError) return { ok: false, error: modelError };
```
（校验失败不留 claim、不 spawn。）
4. `adoptClaimedHost`（L775 起）：config 构建前插入校验；失败时：
```js
updateOwnedHost(root, viewId, instanceId, (h) => ({ ...h, state: "failed", endedAt: nowImpl(), exitCode: 1, error: modelError, claimPid: null, claimIdentity: null }));
return { ok: true, pending: true, socketPath: null, instanceId };
```
（对齐该函数既有 spawnError 失败处理模式。）
5. `src/index.ts` serviceFor 与 `src/commands/agent-board.ts` flag 路径注入：
```ts
availableModels: () => { try { return ctx.modelRegistry.getAvailable(); } catch { return undefined; } },
```
（agent-board.ts flag 路径 L115 的 createService 调用同款注入；dashboard 路径 L95 已有 availableModels 变量但那是 UI deps，service 注入仍需单独传。）
6. 集成测试（`test/host-resolver.test.mjs` 或 `test/service.test.mjs`，看 ensure 测试在哪更顺）：
   - A2：view meta defaultModel="glm/glm-5.3"，注入 availableModels: () => [{provider:"zai-coding-cn",id:"glm-5.3"}]，launchHost spy → ensureHost("v1") 断言 ok:false、error 含模型名、spy 零调用、readHost 无 starting 残留；
   - A3 对照：availableModels 含 glm/glm-5.3 → 正常 claim+spawn（断言 started/started pending 路径与现状一致）；
   - A4：不注入 availableModels → 跳过校验正常 launch；
   - A5：废弃 starting claim（adopt 路径，参照现有 adoption 测试 fixture）+ 失效模型 → 断言落 failed、不 spawn。

### T3：runner exit 归因（A6, A7）

1. `src/core/heuristics.mjs` 新增导出：
```js
/**
 * Last non-empty visible line of a raw terminal log chunk (ANSI/OSC stripped,
 * per-line carriage-return resolved). @returns {string|null}
 */
export function lastVisibleLogLine(text, maxLen = 200)
```
实现：strip `/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g`（OSC）→ `/\x1b\[[0-9;?]*[ -/]*[@-~]/g`（CSI）→ 其他 `\x1b.` 单字符转义 → 按 `\n` 切分 → 每行取最后一个 `\r` 之后段 → trim → 过滤空 → 取最后一行 → truncate(maxLen)（复用同文件 truncate）。
2. 单测（heuristics 测试文件）：ANSI 颜色、OSC 链接、`\r` 覆盖行、空行跳过、截断、空输入 → null。
3. `runner/pty-runner.mjs` child exit 回调（L213-223 区域）：
```js
if (!crashed) {
	let exitError = null;
	if (exitCode !== 0) {
		try {
			const tail = readScreenLogTail(screenLog, 8192);  // openSync/readSync seek 尾部
			exitError = lastVisibleLogLine(tail);
		} catch { /* best effort */ }
	}
	update({ state: "exited", endedAt: Date.now(), exitCode, childPid: null, ...(exitError ? { error: exitError } : {}) });
	...
}
```
（screenLog 变量在 L62 作用域内可见；确认该回调能访问到。readScreenLogTail 写成 runner 内私有小函数。）
4. 集成测试（test/pty-runner.integration.test.mjs）：用 test-support/ 下 fake pi 模式（看 fake-slow-start-pi.mjs；若无"立即 exit 1 + 输出错误"的 fake 就新增一个 `fake-failing-pi.mjs`：打印 `Error: Model "glm/glm-5.3" not found.` 后 exit 1）→ spawn runner → 等 exit → 断言 readHost 的 error 含 "Model" / "not found"；对照 exit 0（现有 fake）→ error 字段保持 null。注意 hasNodePty skip 守卫参照现有测试。

### T4：全量回归（A8）

`npm test` + `npm run typecheck`（基线 608）。

## 验收对账

- A1 → T1.2 · A2/A3/A4/A5 → T2.6 · A6 → T3.2 · A7 → T3.4 · A8 → T4
- U1（用户实测，合并后）：view_539a5e9e20 恢复失效 defaultModel → attach 看 notify + diagnostics 不再累积；改回有效模型 attach 成功。
