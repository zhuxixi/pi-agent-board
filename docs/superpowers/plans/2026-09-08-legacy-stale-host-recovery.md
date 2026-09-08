# issue #87 plan：legacy 死 host 安全回收实现

日期：2026-09-08 · spec：docs/superpowers/specs/2026-09-08-legacy-stale-host-recovery-design.md

## 任务拆解

### T1：纯决策函数 `canFinalizeLegacyHost`（A1）

**文件**：`src/core/host-coordination.mjs`（新增导出，放 `classifyProbeResult` 附近）

```js
/**
 * Whether a legacy (pre-instanceId) host record can be safely finalized as
 * exited: the runner pid is provably dead (a reused pid reads alive →
 * conservative false) AND the endpoint is unreachable. Satisfies spec §10.1's
 * "never recovered" conservatism — recovery only fires when identity is
 * certain (issue #87).
 * @param {{ host: HostStatus|null, hostPid: number|null|undefined, hostPidAlive: boolean, probeClassification: string }} input
 * @returns {boolean}
 */
export function canFinalizeLegacyHost({ host, hostPid, hostPidAlive, probeClassification }) {
	if (!host || host.instanceId != null) return false;
	if (host.state !== "starting" && host.state !== "alive") return false;
	if (hostPid == null || hostPidAlive) return false;
	return probeClassification === "missing" || probeClassification === "stale";
}
```

**测试**：`test/host-coordination.test.mjs` 新增真值表用例（在文件既有风格下）：
- 全条件满足（starting/alive × missing/stale 四组合）→ true
- instanceId 非 null → false
- state ∈ {exited, failed, stopping} → false
- hostPid null / hostPidAlive true → false
- classification ∈ {ready, starting, occupied, unknown} → false
- host null → false

### T2：resolver 两处改造（A2-A5）

**文件**：`src/runtime/service.mjs`

1. **import 更新**：`readHostPid` 加入 store.mjs import 列表；`canFinalizeLegacyHost` 加入 host-coordination.mjs import（L28 现有 `canReplaceHost` 同处）。

2. **新增模块内 helper**（resolver 函数前，模块作用域）：

```js
/**
 * Finalize a provably-dead legacy host as exited so the resolver loop's next
 * iteration sees hostActive=false and claims a fresh new-protocol host
 * (issue #87). Legacy records have no instanceId — no concurrent owner exists,
 * so an unfenced writeHost is safe; the claim path is serialized by the
 * host-start lease.
 * @returns {boolean} true when finalized (caller should `continue` the loop).
 */
function finalizeDeadLegacyHost(root, viewId, host, probeClassification) {
	const hostPid = Object.hasOwn(host, "runnerPid") ? host.runnerPid : readHostPid(root, viewId);
	if (!canFinalizeLegacyHost({ host, hostPid, hostPidAlive: isAlive(hostPid), probeClassification })) return false;
	writeHost(root, { ...host, state: "exited", endedAt: Date.now(), lastSeenAt: Date.now(), error: "legacy host finalized: runner pid dead (issue #87)" });
	try {
		appendDiagnostic(root, viewId, {
			source: "service", level: "info", code: "legacy_host_finalized",
			message: `Finalized stale legacy host (pid ${hostPid} dead, probe ${probeClassification}) — next attach claims a fresh host`,
			details: { hostPid, probeClassification, previousState: host.state },
		});
	} catch { /* best effort */ }
	return true;
}
```

注意：`writeHost` 签名是 `(root, host)`（host 内含 viewId），与 updateOwnedHost 不同。appendDiagnostic 签名参照文件内现有调用（`appendDiagnostic(root, viewId, {...})`，如 recoverHost 附近用法——实现时以现有调用为准）。

3. **resolver legacy alive 分支**（现 L963 附近）：

```js
} else if (legacy) {
	// Legacy host unreachable. spec §10.1 says never recover — unless the
	// runner pid is provably dead, in which case finalize and self-heal
	// (issue #87).
	if (finalizeDeadLegacyHost(root, viewId, host, probe.classification)) {
		await sleepFnImpl(HOST_PROBE_RETRY_MS);
		continue;
	}
	return pending(sessionFile, "legacy host unreachable — manual restart needed");
}
```

4. **resolver starting-legacy 分支**（现 L953-957 附近，`withinGrace || legacy` 等待分支）：

```js
if (withinGrace || legacy) {
	// A legacy starting host whose runner is provably dead would wait out
	// the grace window forever (withinGrace is always true for legacy) —
	// finalize it now instead (issue #87).
	if (legacy && finalizeDeadLegacyHost(root, viewId, host, probe.classification)) {
		await sleepFnImpl(HOST_PROBE_RETRY_MS);
		continue;
	}
	// Normal cold start (or a legacy starting host — legacy is never recovered,
	// spec §10.1): wait out the grace window.
	await sleepFnImpl(HOST_PROBE_RETRY_MS);
	continue;
}
```

（此分支 probe 已在上方 L939 执行，classification 可得。）

**测试**：`test/host-resolver.test.mjs` 新增 4 个测试（fixtures 复用 hostRecord/scriptProbe/instantSleep/resolverService；launchHost override 模仿现有 adoption 测试的成功 spawn 模式）：

- **A2 自愈闭环**：legacy alive host（hostRecord：instanceId:null、state:"alive"、**无 runnerPid 属性**——用 delete 或构造时排除）+ host-pid.json 写死 pid（writeHostPid 或 readHostPid 对应写法，参照 store.mjs 导出；用不可能存活的 pid 如 999999——注意须确认该 pid 在测试机不存在，现有 fixture aliveHost 已用 999999 表达"死 pid"，同法）+ scriptProbe(["missing"]) + launchHost override 成功 spawn → 断言：resolveAttachTarget 最终返回 kind:"pty"（新 host）；readHost 状态变迁——最终 host 是新 instance（launchHost 写入 starting）；diagnostics 含 legacy_host_finalized。
  - 实现细节：claim/launch 后 readHost 读到的是新 host 记录，验证 finalize 发生要靠 diagnostics 断言 + resolve 结果非 pending。
- **A3 保守分支**：同上但 host-pid.json 写 `process.pid`（活 pid）→ 断言返回 pending（reason 含 "legacy host unreachable"）且 host.json 未被改写（state 仍 alive）。
- **A4 starting-legacy 回收**：legacy starting host（claimAt 久远超 grace，pid 死）+ probe missing + launchHost spawn 成功 → 断言不自 deadline timeout、最终 kind:"pty"、diagnostics 含 legacy_host_finalized。
- **A5 unknown 不回收**：pid 死 + scriptProbe(["unknown"]) → 断言 pending 且不写盘。

⚠️ fixture 要点：hostRecord 默认写 `runnerPid: null`——这会让 `Object.hasOwn(host, "runnerPid")` 为 true，fallback 不到 host-pid.json。legacy fixture 必须构造**没有 runnerPid 属性**的记录（hostRecord 加 `legacy: true` 选项删除 instanceId/runnerPid 等字段，或新写 `legacyHostRecord` helper），并配 `writeHostPid(root, viewId, pid)` 写镜像。

### T3：全量回归（A6）

`npm test` + `npm run typecheck`（基线 602）。

## 验收对账

- A1 → T1 真值表单测
- A2/A3/A4/A5 → T2 四个集成测试
- A6 → T3
- U1（用户实测，合并前）：本机 6 个真实卡死 legacy view attach 验证——主 session 合并前提示用户执行，或合并后实测反馈。
