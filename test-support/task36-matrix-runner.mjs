// Task36 real-PTY matrix runner. Test-only harness; no production imports/mutations.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { createView, claimHost, readHost } from "../src/core/store.mjs";
import { atomicWriteJson } from "../src/core/atomic.mjs";
import * as P from "../src/core/paths.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const ARTIFACT = process.argv[2] ? resolve(process.argv[2]) : null;
if (!ARTIFACT || existsSync(ARTIFACT)) { process.stderr.write("task36 matrix: fresh artifact dir required\n"); process.exit(2); }
mkdirSync(ARTIFACT, { recursive: true });
const CANDIDATE = realpathSync(resolve(REPO, "index.ts"));
const DRIVER = realpathSync(resolve(REPO, "test-support/task36-child-extension.ts"));
const launcher = realpathSync(spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).stdout.trim());
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cells = [];
for (const id of ["B", "Q", "L-normal", "L-alt"]) for (let i = 1; i <= 10; i += 1) cells.push({ cell: id, trial: i, mode: id === "B" ? "busy" : id === "Q" ? "quiet" : id.toLowerCase(), tui: "fullscreen" });
for (const id of ["G1", "G2", "G3"]) for (let i = 1; i <= 5; i += 1) cells.push({ cell: id, trial: i, mode: "geometry", tui: "fullscreen" });
for (let i = 1; i <= 5; i += 1) cells.push({ cell: "C", trial: i, mode: "cold", tui: "fullscreen" });
for (const id of ["R-reconnect", "R-restart"]) for (let i = 1; i <= 5; i += 1) cells.push({ cell: id, trial: i, mode: "busy", tui: "fullscreen" });
for (const id of ["B", "Q"]) for (let i = 1; i <= 5; i += 1) cells.push({ cell: `regular-${id}`, trial: i, mode: id === "B" ? "busy" : "quiet", tui: "regular" });
const G = { G1: { host: [80, 24], target: [80, 22] }, G2: { host: [300, 65], target: [300, 38] }, G3: { host: [160, 22], target: [80, 22] } };
const ONLY = new Set((process.env.TASK36_ONLY ?? "").split(",").filter(Boolean));
const L_EVIDENCE = process.env.TASK36_L_EVIDENCE === "1";
const R_EVIDENCE = process.env.TASK36_R_EVIDENCE === "1";
const LIMIT = Number(process.env.TASK36_TRIAL_LIMIT ?? "0");
let scheduled = ONLY.size === 0 ? cells : cells.filter((entry) => ONLY.has(entry.cell));
if (Number.isInteger(LIMIT) && LIMIT > 0) { const seen = new Map(); scheduled = scheduled.filter((entry) => { const n = (seen.get(entry.cell) ?? 0) + 1; seen.set(entry.cell, n); return n <= LIMIT; }); }
const manifest = { startedAt: new Date().toISOString(), candidate: CANDIDATE, candidateSha256: sha(CANDIDATE), driver: DRIVER, driverSha256: sha(DRIVER), launcher, launcherVersion: spawnSync(launcher, ["--version"], { encoding: "utf8" }).stdout.trim(), planned: scheduled.length, cells: [] };
function childEnv(mode, gen, coldDelay) {
	return {
		TASK36_CHILD_MODE: mode,
		TASK36_GENERATION: gen,
		...(coldDelay ? { TASK36_COLD_DELAY: String(coldDelay) } : {}),
	};
}
async function runCell(spec) {
	const base = join(ARTIFACT, spec.cell, String(spec.trial).padStart(2, "0"));
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(tmpdir(), "task36-matrix-"));
	const agent = join(root, "agent"); const cwd = join(root, "cwd"); mkdirSync(agent, { recursive: true }); mkdirSync(cwd, { recursive: true });
	const viewId = `t36-${spec.cell}-${spec.trial}`.replace(/[^a-zA-Z0-9_-]/g, "-"); const inst = `inst-${viewId}`;
	const meta = createView(root, { id: viewId, name: `task36 ${spec.cell} ${spec.trial}`, cwd });
	let historyBytes = null;
	if (L_EVIDENCE) {
		const lines = [JSON.stringify({ type: "session", version: 3, id: `task36-${spec.cell}-${spec.trial}`, timestamp: new Date(0).toISOString(), cwd })];
		for (let i = 1; i <= 300; i += 1) lines.push(JSON.stringify({ type: "message", id: `m${i}`, parentId: i === 1 ? null : `m${i - 1}`, timestamp: new Date(0).toISOString(), message: { role: "user", content: `HISTORY ${i} 中文最终回答 🎯 ${"x".repeat(220)}` } }));
		writeFileSync(meta.sessionFile, lines.join("\n") + "\n");
		historyBytes = Buffer.byteLength(lines.join("\n") + "\n");
	}
	const socketPath = P.hostEndpointPathFor(process.platform, root, viewId, inst); const configPath = P.hostConfigPathFor(root, viewId, inst);
	const g = G[spec.cell]; const host = g ? { cols: g.host[0], rows: g.host[1] } : { cols: 80, rows: 22 };
	const target = g ? { cols: g.target[0], rows: g.target[1] } : { cols: 80, rows: 22 };
	const outerRows = target.rows + 2; const outerCols = target.cols;
	const childLog = join(base, "child.jsonl"); writeFileSync(childLog, "");
	const effectiveMode = L_EVIDENCE && spec.cell === "L-normal" ? "long-normal" : L_EVIDENCE && spec.cell === "L-alt" ? "long-alt" : (R_EVIDENCE && spec.cell.startsWith("R-") ? "quiet" : spec.mode);
	let generation = "gen-1";
	const childArgs = ["--no-extensions", "--no-mcp", "--extension", CANDIDATE, "--extension", DRIVER, "--tui-mode", L_EVIDENCE && spec.cell === "L-normal" ? "regular" : (L_EVIDENCE ? "fullscreen" : (spec.tui === "regular" ? "regular" : "fullscreen")), "--verbose", "--offline", "-na"];
	claimHost(root, { viewId, instanceId: inst, configPath, socketPath, claimAt: Date.now(), claimPid: process.pid, claimIdentity: null, cols: host.cols, rows: host.rows });
	const writeConfig = () => atomicWriteJson(configPath, { root, viewId, instanceId: inst, socketPath, sessionFile: meta.sessionFile, cwd, initialPrompt: null, piCommand: launcher, piArgsPrefix: childArgs, model: null, tools: null, env: { PI_CODING_AGENT_DIR: agent, TASK36_CHILD_LOG: childLog, ...childEnv(effectiveMode, generation, spec.cell === "C" ? 5000 : undefined), ...(process.env.TASK38 === "1" && spec.cell.startsWith("L-") ? { TASK36_L_DYNAMIC: "1" } : {}), ...(process.env.TASK38 === "1" && (spec.cell === "B" || spec.cell === "regular-B") ? { TASK36_B_INTERVAL: "1000" } : {}) }, cols: host.cols, rows: host.rows });
	writeConfig();
	const spawnRunner = () => spawn(process.execPath, [resolve(REPO, "runner/pty-runner.mjs"), configPath], { stdio: ["ignore", "pipe", "pipe"] });
	let runner = spawnRunner(); runner.stdout.resume(); runner.stderr.resume();
	let hostState = null;
	for (let i = 0; i < 120; i += 1) { hostState = readHost(root, viewId); if (hostState?.state === "alive" && hostState.childPid) break; await sleep(100); }
	const proofWire = join(base, "proof-wire.jsonl"); writeFileSync(proofWire, "");
	const subscriber = createConnection(socketPath); let proofBuffer = "";
	subscriber.on("data", (chunk) => { proofBuffer += chunk.toString(); let index; while ((index = proofBuffer.indexOf("\n")) >= 0) { const line = proofBuffer.slice(0, index); proofBuffer = proofBuffer.slice(index + 1); if (line.trim()) appendFileSync(proofWire, line + "\n"); } });
	await new Promise((resolveConnect) => { subscriber.once("connect", resolveConnect); subscriber.once("error", resolveConnect); });
	subscriber.write(JSON.stringify({ type: "hello", clientId: `task36-sub-${spec.cell}-${spec.trial}`, wantOutput: true }) + "\n");
	subscriber.write(JSON.stringify({ type: "subscribe_terminal", viewProof: 1 }) + "\n");
	await sleep(200);
	const poisonMarker = "TASK36-POISON-OLD-HISTORY";
	let poisonPlanted = false;
	if (process.env.TASK36_C_POISON === "1" && spec.cell === "C") {
		const sp = P.screenLogPath(root, viewId);
		try { writeFileSync(sp, `\n${poisonMarker}\n`); poisonPlanted = true; } catch {}
	}
	const outerPath = join(base, "outer.ansi"); writeFileSync(outerPath, "");
	const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm-256color", LANG: process.env.LANG ?? "C.UTF-8", PI_CODING_AGENT_DIR: agent, AGENT_BOARD_ROOT: root, PI_OFFLINE: "1" };
	const outer = pty.spawn(launcher, ["--no-extensions", "--no-mcp", "--extension", CANDIDATE, "--tui-mode", spec.tui, "--verbose", "--offline", "-na"], { name: "xterm-256color", cols: outerCols, rows: outerRows, cwd, env });
	const events = []; const start = Date.now(); let outerText = ""; let firstMarkerAt = null;
	outer.onData((data) => { outerText += data; appendFileSync(outerPath, data); const marker = /TASK36 (gen-1 )?[BQLGCR]/.test(data); if (marker && firstMarkerAt === null) firstMarkerAt = Date.now() - start; appendFileSync(join(base, "outer-events.jsonl"), `${JSON.stringify({ at: Date.now() - start, bytes: Buffer.byteLength(data), marker })}\n`); });
	await sleep(1800); outer.write("/agent-board\r"); await sleep(1200); const attachAt = Date.now() - start; outer.write("\r");
	let step38 = null;
	const frames = [];
	const snapshot = async (label) => {
		const xterm = await import("@xterm/headless"); const Terminal = xterm.default?.Terminal ?? xterm.Terminal;
		const t = new Terminal({ cols: outerCols, rows: outerRows, allowProposedApi: true });
		await new Promise((resolveWrite) => t.write(outerText, resolveWrite));
		const baseY = t.buffer.active.baseY;
		const rows = []; for (let i = 0; i < outerRows; i += 1) rows.push(t.buffer.active.getLine(baseY + i)?.translateToString(true) ?? "");
		const cursor = { x: t.buffer.active.cursorX, y: t.buffer.active.cursorY };
		t.dispose(); const snap = { label, atMs: Date.now() - start, baseY, rows, cursor }; frames.push(snap); appendFileSync(join(base, "frames.jsonl"), JSON.stringify(snap) + "\n"); return snap;
	};
	if (process.env.TASK38 === "1") {
		await sleep(spec.cell === "B" || spec.cell === "regular-B" ? 2200 : 900);
		const before = await snapshot("first-content");
		const tailNeedle = spec.cell.startsWith("L-") ? "TASK36 L TAIL" : spec.mode === "quiet" ? "TASK36 Q TAIL" : "TASK36 B TAIL";
		const tailIndex = before.rows.findIndex((row) => row.includes(tailNeedle));
		const inputIndex = before.rows.findIndex((row) => row.includes(spec.cell.startsWith("L-") ? "TASK36 L INPUT >" : spec.mode === "quiet" ? "TASK36 Q INPUT >" : "TASK36 B INPUT >"));
		const firstContent = { tailIndex, inputIndex, tail: tailIndex >= 0 ? before.rows[tailIndex] : null, cursor: before.cursor };
		let copy = null;
		if (tailIndex >= 0) {
			const y = tailIndex + 1; const x1 = 1; const displayWidth = [...before.rows[tailIndex].trimEnd()].reduce((sum, ch) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\ud800-\udfff]/.test(ch) ? 2 : 1), 0); const x2 = Math.max(1, displayWidth);
			outer.write(`\u001b[<0;${x1};${y}M`); await sleep(60); outer.write(`\u001b[<32;${x2};${y}M`); await sleep(60); outer.write(`\u001b[<0;${x2};${y}m`); await sleep(250);
			const osc = [...outerText.matchAll(/\u001b\]52;[^;]*;([A-Za-z0-9+/=]+)(?:\u0007|\u001b\\)/g)].map((m) => m[1]);
			let decoded = null; try { decoded = osc.length ? Buffer.from(osc.at(-1), "base64").toString("utf8") : null; } catch {}
			const expectedTail = before.rows[tailIndex].trimEnd();
			copy = { osc52Count: osc.length, decoded, expectedTail, matches: decoded !== null && decoded.trimEnd() === expectedTail };
		}
		outer.write("HELLO38"); await sleep(500);
		const childLogEvents = fs.readFileSync(childLog, "utf8").trim().split("\n").map(JSON.parse);
		const childInput = childLogEvents.filter((entry) => entry.event === "child-input" || (entry.event === "editor-state" && String(entry.text ?? "").includes("HELLO38")));
		let scroll = null;
		if (spec.cell.startsWith("L-")) {
			const preScroll = await snapshot("pre-scroll");
			outer.write("\u001b[5~"); await sleep(500);
			const scrolled = await snapshot("after-pageup");
			await sleep(700);
			const afterOutput = await snapshot("after-output");
			scroll = { beforeTop: preScroll.rows[1], scrolledTop: scrolled.rows[1], afterOutputTop: afterOutput.rows[1], moved: preScroll.rows[1] !== scrolled.rows[1], stableAfterOutput: scrolled.rows[1] === afterOutput.rows[1] };
			outer.write("\u001b[6~"); await sleep(200); outer.write("\u001b[6~"); await sleep(200); outer.write("\u001b[6~"); await sleep(250);
		}
		outer.write("\u001c"); await sleep(1200); outer.write("\r"); await sleep(3200);
		const afterReattach = await snapshot("after-reattach");
		const reattachMarkerAt = outerText.lastIndexOf("TASK36");
		step38 = { firstContent, copy, typedReachedChild: childInput.some((entry) => String(entry.text ?? "").includes("HELLO38")), childInput: childInput.slice(-5), scroll, reattach: { marker: reattachMarkerAt >= 0, markerAtChar: reattachMarkerAt, tail: afterReattach.rows.find((row) => row.includes(tailNeedle)) ?? null }, frames: join(base, "frames.jsonl") };
	}
	let restart = null;
	let reconnect = null;
	if (R_EVIDENCE && spec.cell === "R-reconnect") {
		await sleep(1400);
		const detachAt = Date.now() - start;
		outer.write("\u001c");
		await sleep(1200);
		const reattachAt = Date.now() - start;
		outer.write("\r");
		await sleep(1800);
		const marker2 = outerText.lastIndexOf("TASK36 gen-1");
		reconnect = { detachAt, reattachAt, marker2At: marker2 >= 0 ? Date.now() - start : null, sameGeneration: marker2 >= 0 && !outerText.slice(marker2).includes("gen-2") };
		outer.write("\u001c");
		await sleep(800);
	}
	if (R_EVIDENCE && spec.cell === "R-restart") {
		await sleep(1800); try { if (hostState?.childPid) process.kill(hostState.childPid, "SIGTERM"); } catch {} try { runner.kill("SIGTERM"); } catch {}
		await sleep(500); try { runner.kill("SIGKILL"); } catch {}
		try { rmSync(socketPath, { force: true }); } catch {} claimHost(root, { viewId, instanceId: inst, configPath, socketPath, claimAt: Date.now(), claimPid: process.pid, claimIdentity: null, cols: target.cols, rows: target.rows });
		generation = "gen-2";
		writeConfig();
		const restartAt = Date.now() - start; runner = spawnRunner(); runner.stdout.resume(); runner.stderr.resume();
		for (let i = 0; i < 80; i += 1) { const h = readHost(root, viewId); if (h?.state === "alive" && h.childPid) break; await sleep(100); }
		await sleep(1400);
		const restartDetachAt = Date.now() - start;
		outer.write("\u001c");
		await sleep(1200);
		const restartReattachAt = Date.now() - start;
		outer.write("\r");
		await sleep(2200);
		const gen2At = outerText.indexOf("TASK36 gen-2");
		restart = { startedAt: restartAt, restartDetachAt, restartReattachAt, gen2At: gen2At >= 0 ? Date.now() - start : null, oldGenerationAfterRestart: gen2At >= 0 ? outerText.slice(gen2At).includes("TASK36 gen-1") : null };
	}
	await sleep(3600);
	const finalHost = readHost(root, viewId);
	const screenPath = P.screenLogPath(root, viewId);
	let screenInfo = null;
	if (existsSync(screenPath)) {
		const screenBytes = readFileSync(screenPath);
		try { writeFileSync(join(base, "screen.log"), screenBytes); } catch {}
		screenInfo = { bytes: screenBytes.length, altEnter: (screenBytes.toString("utf8").match(/\x1b\[\?1049h/g) ?? []).length, altExit: (screenBytes.toString("utf8").match(/\x1b\[\?1049l/g) ?? []).length, sha256: createHash("sha256").update(screenBytes).digest("hex") };
	}
	let sessionEntries = null;
	try { sessionEntries = fs.readFileSync(childLog, "utf8").trim().split("\n").map(JSON.parse).find((entry) => entry.event === "session-start")?.sessionEntries ?? null; } catch {}
	const cEvidence = poisonPlanted ? (() => {
		const proofText = fs.readFileSync(proofWire, "utf8");
		const lines = proofText.trim().split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
		const baseline = lines.find((line) => line.type === "snapshot_begin");
		const screenText = screenInfo ? readFileSync(join(base, "screen.log"), "utf8") : "";
		return {
			poisonMarker,
			baselineEmpty: baseline?.empty === true,
			poisonInOuter: outerText.includes(poisonMarker),
			poisonInProofWire: proofText.includes(poisonMarker),
			poisonInScreenArtifact: screenText.includes(poisonMarker),
			completeEditorVisible: outerText.includes("TASK36 C COMPLETE EDITOR"),
			proofFrames: lines.filter((line) => line.type === "view_proof" && line.record?.marker === "F").length,
		};
	})() : null;
	const result = { cell: spec.cell, trial: spec.trial, mode: effectiveMode, tui: spec.tui, hostGeometry: host, targetGeometry: target, outerGeometry: { cols: outerCols, rows: outerRows }, attachAtMs: attachAt, firstMarkerAtMs: firstMarkerAt, observedForMs: Date.now() - start - attachAt, markerVisible: firstMarkerAt !== null, restart, host: finalHost ? { state: finalHost.state, cols: finalHost.cols, rows: finalHost.rows, attachedEver: finalHost.attachedEver, frameWitness: finalHost.frameWitness ?? null } : null, childLog, raw: outerPath, proofWire, historyBytes, sessionEntries, screenInfo, reconnect, cEvidence, step38 };
	writeFileSync(join(base, "summary.json"), JSON.stringify(result, null, 2));
	try { subscriber.destroy(); } catch {}
	try { outer.kill(); } catch {}
	try { if (finalHost?.childPid) process.kill(finalHost.childPid, "SIGKILL"); } catch {}
	try { runner.kill("SIGKILL"); } catch {}
	try { const coord = spawnSync("pgrep", ["-f", `state-coordinator.mjs ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`], { encoding: "utf8" }).stdout.trim(); if (coord) for (const pid of coord.split(/\s+/)) process.kill(Number(pid), "SIGKILL"); } catch {}
	await sleep(200);
	try { rmSync(root, { recursive: true, force: true }); } catch {}
	return result;
}
const results = [];
for (const spec of scheduled) {
	try { const result = await runCell(spec); results.push(result); manifest.cells.push({ cell: spec.cell, trial: spec.trial, status: result.markerVisible ? "observed" : "pending", markerAt: result.firstMarkerAtMs, hostState: result.host?.state ?? null }); process.stdout.write(`${spec.cell}/${spec.trial} ${result.markerVisible ? "observed" : "pending"}\n`); }
	catch (err) { results.push({ cell: spec.cell, trial: spec.trial, error: String(err.stack ?? err) }); manifest.cells.push({ cell: spec.cell, trial: spec.trial, status: "failed", error: String(err) }); process.stderr.write(`${spec.cell}/${spec.trial} failed ${String(err)}\n`); }
}
writeFileSync(join(ARTIFACT, "matrix-summary.json"), JSON.stringify(results, null, 2));
manifest.finishedAt = new Date().toISOString(); writeFileSync(join(ARTIFACT, "manifest.json"), JSON.stringify(manifest, null, 2));
const counts = {}; for (const c of manifest.cells) { counts[c.cell] ??= { observed: 0, pending: 0, failed: 0 }; counts[c.cell][c.status] += 1; }
writeFileSync(join(ARTIFACT, "counts.json"), JSON.stringify({ planned: scheduled.length, executed: results.length, counts }, null, 2));
process.stdout.write(JSON.stringify({ planned: scheduled.length, executed: results.length, counts }) + "\n");
