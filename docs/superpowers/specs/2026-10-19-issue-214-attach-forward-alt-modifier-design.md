Drafted: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-19T13:58:00+08:00
Revised: deepseek/deepseek-flash (selected) · deepseek/deepseek-flash (physical) @ 2026-10-19T14:10:00+08:00 — 第 1 轮复核处置（收敛轮，R1-D1..D4 细化）

# issue #214 根因报告与修复设计：attach 转发丢 Alt 修饰位，Alt+滚轮退化为 1 行

仓库：zhuxixi/pi-agent-board · 基线：`origin/main` @ `64bca89`

## 1. 症状

pi fullscreen 1.3.0 + WezTerm，在 attach 一个 fullscreen 子会话时：

| 手势 | 正常 fullscreen | attach 内 |
| --- | --- | --- |
| 滚轮 | 1 notch = 加速后的行数 | 相同（转发给子会话） |
| **Alt + 滚轮** | **5×**（`ALT_WHEEL_SCROLL_MULTIPLIER = 5`） | **1×** —— Alt 被静默丢弃 |

其余滚轮行为（普通滚轮、PageUp/PageDown、本地 scrollback）都正常。

## 2. 根因

fullscreen 子会话的滚轮走**转发**路径（alternate buffer 无 scrollback，见 #185/#198/#199/#205）。该路径**从零重建** SGR 报告，只保留方向：

`src/ui/pty-attach.ts:1477`：

```ts
private forwardWheelToChild(linesUp: number, event: TuiMouseEvent): void {
    this.send({
        type: "input",
        data: encodeWheelReport(linesUp > 0 ? "up" : "down", {
            col: clampInt(event.x + 1, 1, this.cols),
            row: clampInt(event.y, 1, Math.max(1, this.bodyHeight())),
            // ← event.alt 没有传
        }),
    });
}
```

`src/core/pty-scroll.mjs:370`：

```js
export function encodeWheelReport(direction, { col, row } = {}) {
    const button = direction === "up" ? 64 : 65;   // 永远不置 SGR bit 3 (值 8 = Alt)
    ...
}
```

真实终端用 SGR **bit 3（值 8）** 表示 Alt：Alt+wheel-up = `72 = 64 + 8`，Alt+wheel-down = `73 = 65 + 8`。
子会话的 pi-tui 正是读这一位来决定 5× 加速
（`@earendil-works/pi-tui/dist/tui-alt-screen.js` `handleViewportInput`）：

```js
const wheelDelta = wheelEvent.direction * ((wheelEvent.button & 8) !== 0 ? lines * ALT_WHEEL_SCROLL_MULTIPLIER : lines);
```

attach 覆盖层**本来就拿到了** Alt：pi-tui 的 `TuiMouseEvent` 带 `alt: boolean`（`createMouseEvent` 里 `alt: (button & 8) !== 0`）。它只是没被传下去。

## 3. 证据（对仓库当前代码实测）

```
encodeWheelReport("up",   {col:5,row:3})            → "\x1b[<64;5;3M"
encodeWheelReport("up",   {col:5,row:3,alt:true})   → "\x1b[<64;5;3M"   ❌ alt 被忽略（应为 72）
encodeWheelReport("down", {col:5,row:3,alt:true})   → "\x1b[<65;5;3M"   ❌（应为 73）
```

子会话侧对照：

| 子会话收到的报告 | 结果 |
| --- | --- |
| `\x1b[<64;5;3M`（plain） | 1× |
| `\x1b[<72;5;3M`（Alt+up，**当前永远收不到**） | 5× |
| `\x1b[<65;5;3M`（plain） | 1× |
| `\x1b[<73;5;3M`（Alt+down，**当前永远收不到**） | 5× |

## 4. 修复

把覆盖层的 `alt` 透传进编码器，置 SGR bit 3：

`src/core/pty-scroll.mjs`：

```js
export function encodeWheelReport(direction, { col, row, alt = false } = {}) {
	const base = direction === "up" ? 64 : 65;
	const button = alt === true ? base + 8 : base;
	const cell = (v) => (Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1);
	return `\x1b[<${button};${cell(col)};${cell(row)}M`;
}
```

`src/ui/pty-attach.ts` `forwardWheelToChild`：在参数对象里补 `alt: event.alt === true`。

## 5. 边界与风险

| 风险 | 说明 / 缓解 |
| --- | --- |
| 影响本地滚动 | 不影响：本地路径用 `wheelDelta`（外层 pi 已加速的值），不经 `encodeWheelReport` |
| 影响 legacy regular-mode 路径 | 不影响：该路径（`handleMouseInputChunk`，`src/ui/pty-attach.ts:1110`）把原始 SGR `raw` **原样**转发，从不重建报告，因此天然保留 alt 位，本次不动它 |
| `event.alt` 缺失（老 pi-tui） | `alt = false` 默认值兜底；`=== true` 显式比较，`undefined` 不会误开位 |
| Alt 被终端吞掉 | 不在本次范围：终端若不发 Alt 位，覆盖层也拿不到；本次只保证"拿到就转发" |
| shift / ctrl 修饰位 | **非目标**：pi-tui 只消费 Alt 位做加速，转发其他位不会改变行为却扩大改动面；若将来需要，同一参数可扩展 |
| 与 #170 reply guard 的交互 | 无关：本次只改出站编码，入站分类不动 |
| 与 #213 的交互 | 无关：`\x1b[<` 开头是 SGR mouse，不命中 `CSI_KEY_SEQUENCE` 也不命中任何 reply head |

## 6. 验收矩阵

| ID | 功能点 | 验收方式 | 具体验证 | 通过标准 |
| --- | --- | --- | --- | --- |
| A1 | Alt+wheel-up 编码为 72 | 自动化（unit） | `test/pty-scroll.test.mjs`：`encodeWheelReport("up", { col: 5, row: 3, alt: true })` | `"\x1b[<72;5;3M"` |
| A2 | Alt+wheel-down 编码为 73 | 自动化（unit） | 同上 | `"\x1b[<73;5;3M"` |
| A3 | 无 Alt 时行为不变，且严格比较（`=== true`） | 自动化（unit） | 同上：`alt: false` / 缺省 / `alt: undefined` / **`alt: 1`** / **`alt: "yes"`**（truthy 非布尔） | 全部为 64 / 65，无一置 bit 3 —— 锁死 `event.alt === true` 的严格比较契约 |
| A4 | 转发链路真的把 `event.alt` 传下去 | 自动化（integration） | `test-support/pty-attach-wheel-fallback-scenario.ts` 增加 `alt: true` 的 wheel 事件，断言 runner 收到 `\x1b[<72;…M` | 收到的报告含 `72`（up）/ `73`（down） |
| A5 | 本地滚动路径不受影响 | 自动化（integration） | 既有 `pty-attach-wheel` / `pty-attach-frame-overflow` / `pty-attach-alt-wheel` 套件 | 全绿 |
| A6 | 静态检查 | 自动化（static） | `npm run typecheck` + `npm run pack:dry` | 通过 |
| U1 | 真实终端 Alt+滚轮 | 用户实测 | 部署前置见 §6.1；attach 一个 fullscreen 子会话，按住 Alt 滚一格 | 子会话滚动 5 行（与 attach 外一致） |

### 6.1 U1 执行时机与部署前置

1. 用 `pi install "$(pwd)"`（`README.md:54`）或 symlink 到 `~/.pi/agent/extensions/agent-board` 加载**当前 checkout**，而不是 `~/.pi/agent/git/...` 缓存
2. 完整重启 pi，新开一个 attach 会话
3. 时机：目标套件全绿之后、合并之前

## 7. 可测性拆分设计

- **编码逻辑是纯函数**（`encodeWheelReport`），签名扩展一个可选参数即可单测；无 I/O。
- **接线在 `forwardWheelToChild`**（薄壳），只多传一个字段；集成测试落在既有的 `pty-attach-wheel-fallback-scenario.ts`（真实 `Socket.prototype.write` 拦截），与 #198/#205 的断言模式一致。
- **测试边界**：A1–A3 在 `test/pty-scroll.test.mjs`（纯函数）；A4 在 `test/pty-attach-wheel-fallback.test.mjs` + 对应 scenario；A5 复用既有套件；不新增测试文件。

## 8. 非目标

- 不转发 shift / ctrl 修饰位（见 §5）
- 不改本地滚动路径的任何行为
- 不改 reply guard / 输入分类
