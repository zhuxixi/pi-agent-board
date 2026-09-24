# probe 不得计入 attachedClients（issue #130）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 probe 连接在握手后立刻退出 `clients`（`attachedClients` 的唯一来源），并把这个记账策略收拢成一个纯函数，使两条 runner 路径不再漂移。

**Architecture:** 新增纯函数 `helloBookkeeping(kind)` 到 `src/core/host-protocol.mjs`，把「哪些 socket 计入 `attachedClients`」「要不要写 host.json」变成一张显式决策表；`runner/pty-runner.mjs` 的 legacy / owned 两条 hello 分支改为只消费该描述符、只做副作用。probe 在 hello 时移出 `clients` 与 `terminalSubscriptions`，并且**不**写 host.json（解析期每 150ms 一轮 probe，写一次就是写放大）；内存计数在 hello 后立刻正确，下一次心跳（≤1s）落盘。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test`、`node:assert/strict`。无编译步骤；`npm run typecheck` 是 `tsc --noEmit` 对 `.ts`/JSDoc 的检查。

## Global Constraints

- **工作根**：`WT=/home/elling/git-repo/github/pi-agent-board/.pi/worktrees/issue-130-probe-attached-clients`。所有读写用 `$WT/...` 绝对路径；git 用 `git -C "$WT"`。**不要在会话 cwd（主 checkout）里改任何文件**。
- **不变量**：`attachedClients` 的来源永远是 `clients.size`（legacy `:256`、owned `:611`），不得新增第二个计数来源。
- **判定逻辑收口**：`if (kind === "probe")` 这类判定只允许出现在 `helloBookkeeping` 内；两条 hello 分支不得再出现身份字符串比较（只消费描述符字段）。
- **非目标（不得顺手改）**：owned close/error 的 probe 写抑制（`probeSockets`/`markProbe`）、legacy close 的无条件 `update()`、`attachedEver` 语义、`clients` 的广播角色、warm-host 回收阈值。
- **注释即契约**：本 issue 的根因之一是注释声称 probe 不计数而实现计数。任何被改动的分支，其注释必须与实现一致。
- **提交**：英文 conventional commits；`git add <file>` 逐文件 stage，**禁止 `git add -A`**。
- **测试基线**：`main@3dad7f9` 的 `npm test` = **1047 tests / 1044 pass / 0 fail / 3 skipped**（30s，exit 0）。最终验收必须对比「无新增失败」。
- **平台**：本改动不引入 OS 分支；测试走既有跨平台基建（`P.hostEndpointPathFor` / `P.controlSocketPath`）。

## 验收 ID 追溯总表

| 验收 ID（spec §3） | 落点任务 |
|---|---|
| A1 hello 记账策略纯函数（unit） | Task 1 |
| A3 legacy：probe 在连时不计入（integration） | Task 2 |
| A4 判别性：probe + 真实 client 并存计数恰为 1 | Task 2、Task 3 |
| A5 错值在一个心跳内自愈 | Task 2、Task 3 |
| A6 probe 应答零回归（真实 `probeHost` 判 ready） | Task 2、Task 3 |
| A7 既有 probe/reporter 语义零回归 | Task 2、Task 3、Task 4 |
| A2 owned：probe 在连时不计入（integration） | Task 3 |
| A8 静态 + 全量对比基线 | Task 4 |

端到端组合证据（spec §3）：A2/A3 + `test/warm-host-sweeper.test.mjs` A2 + `test/warm-host-sweep.integration.test.mjs` A6 ⇒ probe 不再延迟 warm-host 回收。

---

### Task 1: `helloBookkeeping` 纯函数 + 决策表单测（A1）

**Files:**
- Modify: `src/core/host-protocol.mjs`（新增导出函数 + 模块头注释对齐）
- Test: `test/host-protocol.test.mjs`（新增 4 个用例）

**Interfaces:**
- Consumes: 无（本任务是最底层，只有既有 `classifyClientHello`）
- Produces: `helloBookkeeping(kind: "probe" | "editor-reporter" | "client") → { keepInClients: boolean, registerReporter: boolean, flipAttachedEver: boolean, persist: boolean, suppressCloseWrite: boolean }`。Task 2 / Task 3 按这些字段名消费，**不得改名**。

- [ ] **Step 1: 写失败测试**

在 `$WT/test/host-protocol.test.mjs` 末尾追加（该文件已 `import { CLIENT_ID_EDITOR_REPORTER, CLIENT_ID_PROBE, classifyClientHello }`，需把 `helloBookkeeping` 加入同一 import）：

```js
test("helloBookkeeping keeps a probe out of clients and out of host.json (issue #130)", () => {
	assert.deepEqual(helloBookkeeping("probe"), {
		keepInClients: false,
		registerReporter: false,
		flipAttachedEver: false,
		persist: false,
		suppressCloseWrite: true,
	});
});

test("helloBookkeeping keeps the resident reporter bookkeeping-only (issue #103)", () => {
	assert.deepEqual(helloBookkeeping("editor-reporter"), {
		keepInClients: false,
		registerReporter: true,
		flipAttachedEver: false,
		persist: true,
		suppressCloseWrite: false,
	});
});

test("helloBookkeeping counts a real client as a full attachment", () => {
	assert.deepEqual(helloBookkeeping("client"), {
		keepInClients: true,
		registerReporter: false,
		flipAttachedEver: true,
		persist: true,
		suppressCloseWrite: false,
	});
});

test("helloBookkeeping is total over classifyClientHello and defaults to the conservative client row", () => {
	// Every kind the handshake can produce must have a row — and an unknown kind
	// must fall back to counting the socket, never to silently dropping it.
	const produced = [
		classifyClientHello({ type: "hello", clientId: CLIENT_ID_PROBE }),
		classifyClientHello({ type: "hello", clientId: CLIENT_ID_EDITOR_REPORTER }),
		classifyClientHello({ type: "hello" }),
	];
	for (const kind of produced) {
		const book = helloBookkeeping(kind);
		assert.equal(typeof book.keepInClients, "boolean", `missing policy row for ${kind}`);
	}
	assert.equal(helloBookkeeping("probe").keepInClients, false, "the probe row is the one that must not count");
	assert.deepEqual(helloBookkeeping(undefined), helloBookkeeping("client"), "unknown kinds count as clients (conservative)");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "$WT" && node --test test/host-protocol.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../src/core/host-protocol.mjs' does not provide an export named 'helloBookkeeping'`

- [ ] **Step 3: 最小实现**

在 `$WT/src/core/host-protocol.mjs` 的 `classifyClientHello` 之后追加：

```js
/**
 * Socket bookkeeping implied by a hello classification (issue #103 §C / #130).
 *
 * `probe` and `editor-reporter` are bookkeeping-only: neither may keep
 * `attachedClients` — whose sole source is the runner's `clients` set —
 * non-zero, or warm-host reclaim never fires and hosts leak (issue #75). Both
 * therefore leave `clients` at hello time, while their socket stays writable so
 * probe replies and editor_state keep flowing.
 *
 * `persist: false` for probes is deliberate: the attach resolver probes every
 * HOST_PROBE_RETRY_MS (see host-probe.mjs), so one host.json write per probe
 * would amplify fenced writes — the exact cost the runner's probe-socket write
 * suppression exists to avoid. Dropping the socket from `clients` already makes
 * the in-memory count right, and the next heartbeat (<=1s) persists it.
 *
 * `suppressCloseWrite: true` is the other half of that suppression: close is the
 * wrong moment to flush a record a probe never changed.
 *
 * An unrecognized kind falls back to the real-client row on purpose — counting
 * an unknown connection is the conservative direction (it can only delay
 * reclaim, never risk killing a host with a live client).
 *
 * @param {"probe" | "editor-reporter" | "client"} kind
 * @returns {{ keepInClients: boolean, registerReporter: boolean,
 *             flipAttachedEver: boolean, persist: boolean, suppressCloseWrite: boolean }}
 */
export function helloBookkeeping(kind) {
	switch (kind) {
		case "probe":
			return { keepInClients: false, registerReporter: false, flipAttachedEver: false, persist: false, suppressCloseWrite: true };
		case "editor-reporter":
			return { keepInClients: false, registerReporter: true, flipAttachedEver: false, persist: true, suppressCloseWrite: false };
		default:
			return { keepInClients: true, registerReporter: false, flipAttachedEver: true, persist: true, suppressCloseWrite: false };
	}
}
```

同时把该文件模块头注释的第 3-6 行从「keep bookkeeping-only connections out of `attachedClients` / `attachedEver`」扩写为指向 `helloBookkeeping` 的显式契约（避免再次出现「注释声称、实现不做」）：

```js
 * Client ids travel in the `hello` handshake. `helloBookkeeping` turns the
 * classification into the explicit socket policy: probes and the resident
 * editor-state reporter stay out of `attachedClients` / `attachedEver`, and
 * probes additionally never trigger a host.json write — counting or writing
 * either would pin every host against warm-host reclaim (issue #75 / #103 §C /
 * #130).
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "$WT" && node --test test/host-protocol.test.mjs`
Expected: PASS — 7 tests（既有 3 + 新增 4），0 fail

- [ ] **Step 5: 提交**

```bash
git -C "$WT" add src/core/host-protocol.mjs test/host-protocol.test.mjs
git -C "$WT" commit -m "feat(core): explicit hello socket policy, probes leave attachedClients (issue #130)"
```

---

### Task 2: legacy 路径接线 + integration 覆盖（A3 / A4 / A5 / A6 / A7）

**Files:**
- Modify: `runner/pty-runner.mjs:422-437`（legacy `handleClientLine` 的 `case "hello"`）+ `:40` import
- Test: `test/pty-runner.integration.test.mjs`（在 `:1389` 之后新增一个用例）

**Interfaces:**
- Consumes: `helloBookkeeping(kind)`（Task 1 的精确签名与字段名）
- Produces: legacy hello 分支的记账行为——probe 在 hello 后不在 `clients` 内、不写 host.json；reporter 行为不变

- [ ] **Step 1: 写失败测试**

在 `$WT/test/pty-runner.integration.test.mjs` 第 1389 行（`test("legacy runner keeps the editor reporter and probes out of attachedClients/attachedEver (issue #103)")` 的收尾 `});`）之后、`// ---- child-exit error attribution (issue #90) ----` 之前插入。该用例复用文件内既有 helper（`freshRoot` / `waitFor` / `hostReady` / `readHost` / `send` / `waitForExit` / `stopRunner` / `reapChild`）。

先在文件头部 import 区加入真实探针：

```js
import { probeHost } from "../src/core/host-probe.mjs";
```

再加用例：

```js
test("legacy runner: a connected probe never inflates attachedClients (issue #130)", async () => {
	const root = freshRoot();
	let runner;
	let childPid;
	try {
		// Legacy host: host-config WITHOUT `instanceId`, so `main()` dispatches
		// `legacyMain()` and binds the stable control.sock endpoint.
		const meta = createView(root, { id: "v1", name: "legacy-probe-count", cwd: process.cwd() });
		const configPath = P.hostConfigPath(root, "v1");
		atomicWriteJson(configPath, {
			root,
			viewId: "v1",
			sessionFile: meta.sessionFile,
			cwd: process.cwd(),
			initialPrompt: null,
			piCommand: process.execPath,
			piArgsPrefix: [resolve("test-support/fake-pty-pi.mjs")],
			model: null,
			tools: null,
			env: { AGENT_BOARD_ALLOW_PIPE_FALLBACK: "1" },
			cols: 80,
			rows: 24,
		});
		runner = spawn(process.execPath, [resolve("runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
		await waitFor(() => hostReady(root, "v1"));
		childPid = readHost(root, "v1")?.childPid ?? null;
		const socketPath = P.controlSocketPath(root, "v1");
		const revBefore = readHost(root, "v1").revision;

		// A probe that STAYS connected: the resolver's real pattern is
		// connect → probe hello → destroy, but the count must already be clean
		// after the hello — before the close is observed.
		const probe = createConnection(socketPath);
		probe.on("error", () => {});
		await once(probe, "connect");
		const probeMessages = [];
		let probeBuf = "";
		probe.on("data", (chunk) => {
			probeBuf += chunk.toString();
			const lines = probeBuf.split("\n");
			probeBuf = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) probeMessages.push(JSON.parse(line));
		});
		probe.write(JSON.stringify({ type: "hello", clientId: "probe", wantOutput: false }) + "\n");
		// Two hellos = the unsolicited one sent on connect + the reply to ours,
		// which is sent AFTER classification ran — so the count is settled here.
		await waitFor(() => probeMessages.filter((m) => m.type === "hello").length >= 2, 5000);

		// A5/A3: cross at least one heartbeat write while the probe stays
		// connected. That is exactly the write that used to persist 1.
		const afterHeartbeat = await waitFor(() => {
			const h = readHost(root, "v1");
			return h && h.revision > revBefore ? h : false;
		}, 5000);
		assert.equal(afterHeartbeat.attachedClients, 0, "a connected probe must not be counted as attached");
		assert.notEqual(afterHeartbeat.attachedEver, true, "a probe must never mark the host attached");

		// A4: a real client alongside the probe must count exactly 1 — a probe
		// still sitting in `clients` would make this 2.
		const client = createConnection(socketPath);
		client.on("error", () => {});
		await once(client, "connect");
		client.write(JSON.stringify({ type: "hello", clientId: "ui-test" }) + "\n");
		const counted = await waitFor(() => {
			const h = readHost(root, "v1");
			return h && h.attachedClients === 1 ? h : false;
		}, 3000);
		assert.equal(counted.attachedClients, 1, "exactly one attached client — a counted probe would make this 2");
		assert.equal(counted.attachedEver, true, "a real client still flips attachedEver");
		client.destroy();
		const released = await waitFor(() => {
			const h = readHost(root, "v1");
			return h && h.attachedClients === 0 ? h : false;
		}, 3000);
		assert.equal(released.attachedClients, 0, "probe-only host must read as detached for warm-host reclaim");

		// A5 again, driven by the probe's own close: the persisted record must
		// still read 0 after the probe goes away and a heartbeat lands.
		const revAfterClient = readHost(root, "v1").revision;
		probe.destroy();
		const settled = await waitFor(() => {
			const h = readHost(root, "v1");
			return h && h.revision > revAfterClient ? h : false;
		}, 5000);
		assert.equal(settled.attachedClients, 0, "the record must stay at 0 once the probe is gone");

		// A6: the real resolver probe still classifies this legacy host as ready
		// (no expectedInstanceId → the legacy ready fallback).
		const probeResult = await probeHost(socketPath, { expectedViewId: "v1", expectedInstanceId: null });
		assert.equal(probeResult.classification, "ready", "the real resolver probe must still classify the host ready");

		// Cleanup stays on the tested path: natural child exit.
		const exitClient = createConnection(socketPath);
		exitClient.on("error", () => {});
		await once(exitClient, "connect");
		send(exitClient, { type: "input", data: "exit\r" });
		await waitForExit(runner, 5000);
		exitClient.destroy();
	} finally {
		await stopRunner(runner);
		reapChild(root, "v1");
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "$WT" && node --test --test-name-pattern="a connected probe never inflates attachedClients" test/pty-runner.integration.test.mjs`
Expected: FAIL — `AssertionError: a connected probe must not be counted as attached: 1 !== 0`（修复前的真实失败模式，与 spec §1.3 的实测一致）

- [ ] **Step 3: 改 runner 的 legacy hello 分支**

把 `$WT/runner/pty-runner.mjs:40` 的 import 改为：

```js
import { classifyClientHello, helloBookkeeping } from "../src/core/host-protocol.mjs";
```

把 `:422-437` 整段替换为：

```js
			case "hello": {
				// Bookkeeping-only clients must never pin the host against warm-host
				// reclaim (issue #103 §C / #130): probes are read-only and transient,
				// the editor reporter is resident. Both leave `clients` — the sole
				// source of `attachedClients` — while their socket stays writable so
				// probe replies and editor_state keep flowing. The policy lives in
				// `helloBookkeeping`, so this path and the owned one cannot drift.
				const book = helloBookkeeping(classifyClientHello(msg));
				if (!book.keepInClients) {
					clients.delete(socket);
					terminalSubscriptions.delete(socket);
				}
				if (book.registerReporter) editorReporters.add(socket);
				// Legacy has no probe-socket close suppression, so this is a no-op
				// here; it is kept so the shared policy stays readable in both paths.
				if (book.suppressCloseWrite) socket.markProbe?.();
				if (book.flipAttachedEver) update({ attachedEver: true });
				else if (book.persist) update();
				send(socket, { type: "hello", status: host, editorEmpty, generation: GENERATION });
				break;
			}
```

> 注意：legacy reporter 分支原来无条件 `update()`，现在由 `book.persist === true` 驱动，行为等价；probe 分支原来什么都不做，现在**只**移出集合、不 `update()` —— 这正是本任务的行为修复。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "$WT" && node --test --test-name-pattern="a connected probe never inflates attachedClients" test/pty-runner.integration.test.mjs`
Expected: PASS

Run（A7 同文件回归）: `cd "$WT" && node --test test/pty-runner.integration.test.mjs`
Expected: PASS，0 fail（含既有 `:1159` / `:1206` / `:1289` 三条 probe/reporter 用例）

- [ ] **Step 5: 提交**

```bash
git -C "$WT" add runner/pty-runner.mjs test/pty-runner.integration.test.mjs
git -C "$WT" commit -m "fix(runner): legacy probes leave attachedClients at hello (issue #130)"
```

---

### Task 3: owned 路径接线 + integration 覆盖（A2 / A4 / A5 / A6 / A7）

**Files:**
- Modify: `runner/pty-runner.mjs:1091-1108`（owned `handleClientLine` 的 `case "hello"`）+ `:864-867` 注释
- Test: `test/pty-runner.integration.test.mjs`（在 Task 2 新增用例之后再加一个，即 `:1204` 之后、原 `:1206` 之前的位置）

**Interfaces:**
- Consumes: `helloBookkeeping(kind)`（Task 1）；owned 侧的 `ownedUpdate` / `socket.markProbe`（既有，不改语义）
- Produces: owned hello 分支的记账行为——probe 在 hello 后不在 `clients` 内、不写 host.json，且 close/error 仍不写

- [ ] **Step 1: 写失败测试**

把下面这个用例插入到 `$WT/test/pty-runner.integration.test.mjs` 中**紧接**原 `test("probe connections leave host.json untouched; real clients flip attachedEver (CR r1 f3)")` 的收尾 `});` 之后（该收尾原为 `:1204`），即插在 `test("editor reporter connections leave attachedClients/attachedEver untouched (issue #103)")` 之前：

```js
test("owned runner: a connected probe never inflates attachedClients (issue #130)", async () => {
	const root = freshRoot();
	let runner;
	let childPid;
	try {
		const { runner: r, socketPath } = await launchOwnedRunner(root, "v1", "i130");
		runner = r;
		const host = await waitFor(() => {
			const h = readHost(root, "v1");
			return h?.state === "alive" && h?.readyAt != null && h?.childPid ? h : false;
		});
		childPid = host.childPid;
		const revBefore = readHost(root, "v1").revision;

		// A probe that STAYS connected. The owned path suppresses the probe's
		// close-time write on purpose (the resolver probes every 150ms), so the
		// count has to be right at hello time — waiting for close is not enough.
		const probe = createConnection(socketPath);
		probe.on("error", () => {});
		await once(probe, "connect");
		const probeMessages = [];
		let probeBuf = "";
		probe.on("data", (chunk) => {
			probeBuf += chunk.toString();
			const lines = probeBuf.split("\n");
			probeBuf = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) probeMessages.push(JSON.parse(line));
		});
		probe.write(JSON.stringify({ type: "hello", clientId: "probe", wantOutput: false }) + "\n");
		// Two hellos = the unsolicited one sent on connect + the reply to ours,
		// which is sent AFTER classification ran — so the count is settled here.
		await waitFor(() => probeMessages.filter((m) => m.type === "hello").length >= 2, 5000);

		// A2: cross at least one heartbeat write while the probe stays connected.
		// That is exactly the write that used to persist attachedClients=1 and
		// then keep it wrong for a full heartbeat period (measured: ~975ms).
		const afterHeartbeat = await waitFor(() => {
			const h = readHost(root, "v1");
			return h && h.revision > revBefore ? h : false;
		}, 5000);
		assert.equal(afterHeartbeat.attachedClients, 0, "a connected probe must not be counted as attached");
		assert.notEqual(afterHeartbeat.attachedEver, true, "a probe must never mark the host attached");

		// A4: a real client alongside the probe must count exactly 1 — a probe
		// still sitting in `clients` would make this 2.
		const client = createConnection(socketPath);
		client.on("error", () => {});
		await once(client, "connect");
		client.write(JSON.stringify({ type: "hello", clientId: "ui-test" }) + "\n");
		const counted = await waitFor(() => {
			const h = readHost(root, "v1");
			return h && h.attachedClients === 1 ? h : false;
		}, 3000);
		assert.equal(counted.attachedClients, 1, "exactly one attached client — a counted probe would make this 2");
		assert.equal(counted.attachedEver, true, "a real client still flips attachedEver");
		client.destroy();
		const released = await waitFor(() => {
			const h = readHost(root, "v1");
			return h && h.attachedClients === 0 ? h : false;
		}, 3000);
		assert.equal(released.attachedClients, 0, "probe-only host must read as detached for warm-host reclaim");

		// A5: the probe's own close is write-suppressed on this path, so the
		// record must already be 0 and stay 0 across the next heartbeat.
		const revAfterClient = readHost(root, "v1").revision;
		probe.destroy();
		const settled = await waitFor(() => {
			const h = readHost(root, "v1");
			return h && h.revision > revAfterClient ? h : false;
		}, 5000);
		assert.equal(settled.attachedClients, 0, "the record must stay at 0 once the probe is gone");

		// A6: the real resolver probe still classifies this host as ready, and
		// leaves no residue behind.
		const probeResult = await probeHost(socketPath, { expectedViewId: "v1", expectedInstanceId: "i130" });
		assert.equal(probeResult.classification, "ready", "the real resolver probe must still classify the host ready");
		assert.equal(readHost(root, "v1").attachedEver, true, "probeHost must not disturb the record's attachment history");

		// Cleanup stays on the tested path: natural child exit.
		const exitClient = createConnection(socketPath);
		exitClient.on("error", () => {});
		await once(exitClient, "connect");
		send(exitClient, { type: "input", data: "exit\r" });
		await waitForExit(runner, 5000);
		exitClient.destroy();
	} finally {
		try { runner?.kill("SIGKILL"); } catch {}
		if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "$WT" && node --test --test-name-pattern="owned runner: a connected probe never inflates" test/pty-runner.integration.test.mjs`
Expected: FAIL — `AssertionError: a connected probe must not be counted as attached: 1 !== 0`

- [ ] **Step 3: 改 runner 的 owned hello 分支**

把 `$WT/runner/pty-runner.mjs:1091-1108` 整段替换为：

```js
			case "hello": {
				// Same bookkeeping contract as the legacy path (issue #103 §C /
				// #130): probes and the resident editor reporter are
				// bookkeeping-only — neither may flip attachedEver nor keep
				// attachedClients non-zero, or warm-host reclaim never fires and
				// hosts leak. The policy lives in `helloBookkeeping`.
				const book = helloBookkeeping(classifyClientHello(msg));
				if (!book.keepInClients) {
					clients.delete(socket);
					terminalSubscriptions.delete(socket);
				}
				if (book.registerReporter) editorReporters.add(socket);
				// The probe's close-time host.json refresh stays suppressed: the
				// resolver probes every HOST_PROBE_RETRY_MS, so flushing there
				// would amplify fenced writes (see the probeSockets comment at the
				// listen block). Being out of `clients` is what keeps the count
				// right — this only avoids a pointless write.
				if (book.suppressCloseWrite) socket.markProbe?.();
				if (book.flipAttachedEver) ownedUpdate((cur) => ({ ...cur, attachedEver: true }));
				else if (book.persist) ownedUpdate((cur) => ({ ...cur }));
				send(socket, { type: "hello", status: host, editorEmpty, generation: GENERATION });
				break;
			}
```

同时把 `:864-867` 的注释从

```js
		// Probe connections (clientId:"probe" hello) must not write host.json: the
		// attach resolver's 150ms probe loop would amplify fenced writes and flip
		// attachedEver with no client ever attached (CR round-1 finding 3).
```

改为

```js
		// Probe connections (clientId:"probe" hello) must not write host.json: the
		// attach resolver's 150ms probe loop would amplify fenced writes and flip
		// attachedEver with no client ever attached (CR round-1 finding 3). The
		// "not counted" half is handled at hello time instead (#130): the socket
		// leaves `clients` there, so this WeakSet only suppresses the write.
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "$WT" && node --test --test-name-pattern="owned runner: a connected probe never inflates" test/pty-runner.integration.test.mjs`
Expected: PASS

Run（A7 全文件回归，含任务 2 的 legacy 用例）: `cd "$WT" && node --test test/pty-runner.integration.test.mjs`
Expected: PASS，0 fail

- [ ] **Step 5: 提交**

```bash
git -C "$WT" add runner/pty-runner.mjs test/pty-runner.integration.test.mjs
git -C "$WT" commit -m "fix(runner): owned probes leave attachedClients at hello (issue #130)"
```

---

### Task 4: 全量验证 + 基线对比 + 组合证据（A7 / A8）

**Files:**
- 不改代码（只跑验证；若发现回归则回到对应任务修）

**Interfaces:**
- Consumes: Task 1–3 的全部产出
- Produces: 用于 PR 描述的验收证据（每条 A 的实际命令与结果）

- [ ] **Step 1: 静态检查**

Run: `cd "$WT" && npm run typecheck`
Expected: 0 error

- [ ] **Step 2: 全量测试对比基线**

Run: `cd "$WT" && npm test`
Expected: `# tests >= 1049`（基线 1047 + 新增 6 个用例）、`# fail 0`、`# pass = tests - 3 skipped`。任何 fail 都必须定位到 Task 1–3 的某个改动并修掉，不得以「基线也有」为由放过——基线是 **0 fail**。

- [ ] **Step 3: 端到端组合证据（不新建测试，逐条实跑并记录输出）**

Run: `cd "$WT" && node --test test/warm-host-sweeper.test.mjs`
Expected: PASS，含 `A2: attachedClients>0 永不淘汰`

Run: `cd "$WT" && node --test test/warm-host-sweep.integration.test.mjs`
Expected: PASS，含 `A6: 手动 sweep 后 idle host 收到 terminate`

组合结论（写进 PR 描述）：A2/A3 证明「probe 在连时 `attachedClients` 落盘为 0」；warm-host-sweeper A2 证明「`attachedClients>0` 不淘汰」；warm-host-sweep A6 证明「`attachedClients=0` 的 idle host 收到 terminate」。三者相接即「probe 不再延迟 warm-host 回收」。

- [ ] **Step 4: 确认工作区无残留**

Run: `cd "$WT" && git status --short`
Expected: 空（除 `docs/superpowers/plans/` 下的本计划文件若尚未提交）

- [ ] **Step 5: 提交**

```bash
git -C "$WT" add docs/superpowers/plans/2026-09-24-probe-attached-clients.md
git -C "$WT" commit -m "docs(plan): issue #130 probe accounting implementation plan"
```

---

## Self-Review

**1. Spec coverage（逐节对照）**

| spec 节 | 覆盖任务 |
|---|---|
| §2.1 决策 D1（移出 `clients`、不写 host.json） | Task 1（`persist:false`）+ Task 2/3（分支只 delete、不 update） |
| §2.2 决策 D2（抽 `helloBookkeeping`） | Task 1 |
| §2.3 改动点清单 | Task 2 Step 3、Task 3 Step 3（含 `:423-426` / `:1092-1094` / `:864-867` 三处注释对齐与 `host-protocol.mjs` 模块注释） |
| §3 A1–A8 | A1→Task 1；A3/A4/A5/A6(legacy)→Task 2；A2/A4/A5/A6(owned)→Task 3；A7→Task 2/3/4；A8→Task 4 |
| §4 可测性拆分（判定只存在于纯函数） | Global Constraints「判定逻辑收口」+ Task 2/3 的分支代码只消费字段 |
| §5 非目标 | Global Constraints「非目标」 |
| §6 风险（hello 一次且权威） | Task 1 的 `default` 行注释 + Task 2/3 Step 1 的 A4 断言（probe 在连时真实 client 计 1） |

**2. Placeholder scan**：无 TBD / TODO /「类似 Task N」；每个代码步骤都给了完整代码块。

**3. Type consistency**：`helloBookkeeping` 的五个字段名（`keepInClients` / `registerReporter` / `flipAttachedEver` / `persist` / `suppressCloseWrite`）在 Task 1 定义、Task 2 与 Task 3 消费，逐字一致；测试辅助函数名（`launchOwnedRunner` / `hostReady` / `stopRunner` / `reapChild` / `waitFor` / `waitForExit` / `send` / `freshRoot`）均取自 `test/pty-runner.integration.test.mjs` 既有定义。

**4. 已知实现注意点（给 implementer）**

- Task 3 的新用例插在「原 `:1204` 之后、原 `:1206` 之前」；Task 2 的新用例插在「原 `:1389` 之后」。两个任务都改同一个测试文件，**必须按 Task 2 → Task 3 顺序执行**，否则行号锚点失效（按 `test(...)` 标题定位而非纯行号更稳）。
- `probeHost` 的 import 只在 Task 2 加一次，Task 3 复用。
- 测量脚本 `/tmp/repro-130.mjs` 与 `/tmp/measure-130.mjs` 是 issue 评论里的证据来源，**不进仓库**。
