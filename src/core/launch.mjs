/**
 * Launch a detached job-runner process for one run.
 *
 * The runner is a plain `.mjs` spawned with `node`, fully detached (its own process
 * group, stdio ignored) so it survives the parent Pi reloading or exiting. The parent
 * records the runner pid in `pid.json` and watches the store files the runner writes.
 */
import { spawn } from "node:child_process";
import { atomicWriteJson } from "./atomic.mjs";
import { resolveNode } from "./invocation.mjs";
import * as P from "./paths.mjs";
import { writePid } from "./store.mjs";

/** @typedef {import("./types.mjs").RunConfig} RunConfig */
/** @typedef {import("./types.mjs").HostConfig} HostConfig */
/** @typedef {import("./types.mjs").TitleConfig} TitleConfig */
/** @typedef {import("./types.mjs").AutoStateConfig} AutoStateConfig */

/**
 * Spawn a fully detached runner child with async spawn failures made harmless.
 *
 * A spawn that fails to start (e.g. a transient ENOENT on the node binary,
 * issue #86) reports asynchronously via the 'error' event; without a listener
 * the EventEmitter rethrows it as an uncaughtException and takes down the
 * whole host Pi process. Callers already handle the failure gracefully via
 * the pid == null branch (state "failed").
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {import("node:child_process").ChildProcess}
 */
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
	child.on("error", () => {});
	child.unref();
	return child;
}

/**
 * @param {string} root
 * @param {RunConfig} config
 * @param {{ runnerScript: string, node?: string }} opts
 * @returns {{ pid: number|null, configPath: string }}
 */
export function launchRun(root, config, opts) {
	const runDir = P.runDir(root, config.viewId, config.runId);
	const configPath = `${runDir}/config.json`;
	atomicWriteJson(configPath, config);

	const node = opts.node ?? resolveNode();
	const child = spawnDetached(node, [opts.runnerScript, configPath], config.cwd);

	const pid = child.pid ?? null;
	// Record the *runner/monitor* pid for liveness polling (the worker pid is tracked
	// inside status.json by the runner itself).
	writePid(root, config.viewId, config.runId, pid);
	return { pid, configPath };
}

/**
 * Launch a detached PTY host for a view. The host owns a long-lived child Pi and
 * exposes a JSONL control socket for attach/input/resize/terminate.
 * @param {string} root
 * @param {HostConfig} config
 * @param {{ runnerScript: string, node?: string }} opts
 * @returns {{ pid: number|null, configPath: string }}
 */
export function launchHost(root, config, opts) {
	// Instance-specific config path wins when present (issue #70: concurrent
	// launches must not share the fixed host-config.json); legacy callers keep it.
	const configPath = config.configPath ?? P.hostConfigPath(root, config.viewId);
	atomicWriteJson(configPath, config);

	const node = opts.node ?? resolveNode();
	const child = spawnDetached(node, [opts.runnerScript, configPath], config.cwd);

	return { pid: child.pid ?? null, configPath };
}

/**
 * Launch a detached title runner for a view. Best-effort only: it may update `meta.json`
 * later with a short GPT-generated name derived from the initial task prompt.
 * @param {string} root
 * @param {TitleConfig} config
 * @param {{ runnerScript: string, node?: string }} opts
 * @returns {{ pid: number|null, configPath: string }}
 */
export function launchTitle(root, config, opts) {
	const configPath = P.titleConfigPath(root, config.viewId);
	atomicWriteJson(configPath, config);

	const node = opts.node ?? resolveNode();
	const child = spawnDetached(node, [opts.runnerScript, configPath], config.cwd);

	return { pid: child.pid ?? null, configPath };
}

/**
 * Launch a detached auto-state classifier for a view. Best-effort: it may update
 * state.json later with a model-refined terminal bucket.
 * @param {string} root
 * @param {AutoStateConfig} config
 * @param {{ runnerScript: string, node?: string }} opts
 * @returns {{ pid: number|null, configPath: string }}
 */
export function launchAutoState(root, config, opts) {
	const configPath = P.autoStateConfigPath(root, config.viewId);
	atomicWriteJson(configPath, config);

	const node = opts.node ?? resolveNode();
	const child = spawnDetached(node, [opts.runnerScript, configPath], config.cwd);

	return { pid: child.pid ?? null, configPath };
}

/**
 * Launch the detached view-state coordinator for a board root (issue #91, spec
 * D3). No config file: the coordinator takes the root as its only argument.
 * Idempotent by lease — a second instance loses the coordinator lease and
 * exits silently, so callers may spawn freely on probe failure.
 * @param {string} root
 * @param {{ runnerScript: string, node?: string }} opts
 * @returns {{ pid: number|null }}
 */
export function launchCoordinator(root, opts) {
	const node = opts.node ?? resolveNode();
	const child = spawnDetached(node, [opts.runnerScript, root], root);
	return { pid: child.pid ?? null };
}
