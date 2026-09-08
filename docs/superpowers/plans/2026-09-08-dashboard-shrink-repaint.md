# issue #88 plan：dashboard 花屏修复实现

日期：2026-09-08 · spec：docs/superpowers/specs/2026-09-08-dashboard-shrink-repaint-design.md

## 任务拆解

### T1：dashboard.ts render 包装（A1, A2, A3）

文件：`src/ui/dashboard.ts`（唯一运行时代码改动文件，.ts 层满足 jiti 可重载约束）

1. 组件新增字段（class 字段区，~L126-147 附近）：
```ts
/** First frame after mount must clear the screen: pi-tui's first render
 *  "assumes clean screen" (fullRender(false)) and overlays never get
 *  clearOnShrink — crash output / dirty bottoms would persist (issue #88). */
private needsFullClear = true;
/** Content line count BEFORE fitToHeight padding (padding always fills the
 *  terminal height, so padded counts never shrink — shrink must be detected
 *  on content lines). */
private lastContentLineCount: number | null = null;
private frameContentLineCount = 0;
```

2. `fitToHeight` 开头记录 pad 前行数：`this.frameContentLineCount = lines.length;`

3. 现有 `render(width: number): string[]`（L1158 起）整体改名为 `private renderLines(width: number): string[]`，新增包装：
```ts
render(width: number): string[] {
	const lines = this.renderLines(width);
	// Self-heal frames (issue #88): pi-tui disables clearOnShrink under overlays,
	// so a content shrink would leave stale rows forever. Force a full clear on
	// the first frame and on any content-line shrink. requestRender(true) is
	// nextTick-async — safe to call from inside render.
	if (this.needsFullClear || (this.lastContentLineCount != null && this.frameContentLineCount < this.lastContentLineCount)) {
		this.needsFullClear = false;
		this.tui.requestRender(true);
	}
	this.lastContentLineCount = this.frameContentLineCount;
	return lines;
}
```

注意点：
- `renderLines` 保持原签名与所有 return 分支不变（仅改名）；
- `this.tui.requestRender` 在 Component 的 TUI 类型上存在（pi-tui 导出类型含它；若类型缺 force 参数签名，用 `(this.tui as any).requestRender(true)` 并在注释说明，或查 TUI 类型定义确认——typecheck 必须过）；
- 不改 `src/core/dashboard-render.mjs`（requestDashboardRender 保持差分语义，现有测试不动）。

### T2：冒烟测试（A1, A2）

1. 新增 `test-support/dashboard-shrink-render.ts`（范式照搬 dashboard-refs-render.ts：真实 root + createView + service + fake tui/theme/keybindings）：
   - fake tui 的 `requestRender` 记录调用参数（spy），`terminal.rows` 固定 40；
   - 造 3 个 view → 第 1 次 render(160)（首帧）；
   - 第 2 次 render(160)（同数据，无变化）；
   - 删掉 1 个 view（service 的删除 API——先看 refs-render 或 service 里 deleteView/removeView 叫什么；若无删除 API，用第三个 view 的 cwd folder 折叠/直接操作 store 删目录亦可，目标是让内容行数减少）；
   - 第 3 次 render(160)（内容行数减少）；
   - 输出 JSON：`{ calls: [...] , ok: true }`（requestRender 的参数序列）。
2. `test/dashboard-render.test.mjs` 新增用例（execFileSync + --experimental-transform-types，照抄 refs 用例）断言：
   - 首帧后 calls 含 `[true]`（D1）；
   - 第二帧（无变化）无新增 `[true]`；
   - 第三帧（收缩）后再次出现 `[true]`（D2）。

### T3：全量回归（A4）

`npm test`（基线 617）+ `npm run typecheck`。

## 验收对账
- A1/A2 → T2 断言 · A3 → diff 审查（运行时改动仅 dashboard.ts）· A4 → T3
- U1（用户实测，合并后）：密集增删 session 观察无残影。
