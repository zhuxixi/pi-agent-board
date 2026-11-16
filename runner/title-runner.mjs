#!/usr/bin/env node
/**
 * Detached title-runner shim (issue #295): non-greeting prompts generate a
 * title immediately (previous behavior); greeting prompts poll the session
 * file for the first substantive user message. Best-effort only — the manual
 * rename always wins. All orchestration lives in src/core/title-flow.mjs.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readJson } from "../src/core/atomic.mjs";
import { readMeta, writeMeta } from "../src/core/store.mjs";
import { runTitleFlow } from "../src/core/title-flow.mjs";
import { resolveTitleSettings, titlePrompt } from "../src/core/title.mjs";

function main() {
	const configPath = process.argv[2];
	if (!configPath) process.exit(2);
	/** @type {import("../src/core/types.mjs").TitleConfig|null} */
	const config = readJson(configPath, null);
	if (!config?.viewId || !config.prompt) process.exit(2);

	const settings = resolveTitleSettings(process.env, config.model);
	if (!settings.enabled) return;

	runTitleFlow(config, realDeps(config, settings))
		.catch(() => {})
		.finally(() => process.exit(0));
}

/**
 * @param {import("../src/core/types.mjs").TitleConfig} config
 * @param {{ enabled: boolean, model: string, thinking: string }} settings
 */
function realDeps(config, settings) {
	return {
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		readMeta: (root, viewId) => readMeta(root, viewId),
		commitMeta: (meta) => writeMeta(config.root, meta),
		readSessionText: () => {
			const meta = readMeta(config.root, config.viewId);
			if (!meta?.sessionFile) return null;
			return existsSync(meta.sessionFile) ? readFileSync(meta.sessionFile, "utf8") : null;
		},
		runOneShot: (prompt) => {
			const args = [...(config.piArgsPrefix ?? []), "--mode", "json", "-p", "--no-session", "--model", settings.model];
			if (settings.thinking && settings.thinking !== "off") args.push("--thinking", settings.thinking);
			args.push(titlePrompt(prompt));
			return runOneShot(config.piCommand, args, 15000);
		},
	};
}

function runOneShot(command, args, timeoutMs = 20000) {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: { ...process.env, AGENT_BOARD_NO_SWEEP: "1" } });
		let buf = "";
		child.stdout.on("data", (c) => {
			buf += c.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const e = JSON.parse(line);
					if (e?.type === "message_end" && e.message?.role === "assistant") {
						for (const b of e.message.content ?? []) {
							if (b.type === "text") out += b.text;
						}
					}
				} catch {
					/* ignore */
				}
			}
		});
		child.on("close", () => resolve(out));
		child.on("error", () => resolve(""));
		setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			resolve(out);
		}, timeoutMs).unref?.();
	});
}

main();
