#!/usr/bin/env node
/**
 * Standalone ensureHost entry for cross-process concurrency tests (issue #70 A8/A9/A10).
 *
 * Usage: node test-support/ensure-host-helper.mjs <root> <viewId>
 *
 * Builds a real AgentViewService (real launch paths, real node-pty support probe,
 * repo runner scripts, fake-pty-pi.mjs as the child command) and calls
 * ensureHost(viewId) exactly once, printing one machine-readable result line:
 *
 *   ENSURE_RESULT {"ok":true,"started":true|false,"pending":true|false,...}
 *
 * The process exits immediately after — its service instance is throwaway, so
 * nothing here may keep the event loop alive (createService's startup sweep is
 * unref'd). No cleanup is performed: the test process owns teardown.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createService } from "../src/runtime/service.mjs";

const here = (rel) => resolve(fileURLToPath(new URL(".", import.meta.url)), rel);

const [root, viewId] = process.argv.slice(2);
if (!root || !viewId) {
	process.stderr.write("usage: ensure-host-helper.mjs <root> <viewId>\n");
	process.exit(2);
}

const service = createService({
	root,
	runnerScript: here("../runner/job-runner.mjs"),
	ptyRunnerScript: here("../runner/pty-runner.mjs"),
	piCommand: process.execPath,
	piArgsPrefix: [here("fake-pty-pi.mjs")],
	defaultCwd: process.cwd(),
});

let result;
try {
	result = { ok: true, ...service.ensureHost(viewId) };
} catch (err) {
	result = { ok: false, error: err instanceof Error ? err.message : String(err) };
}
process.stdout.write(`ENSURE_RESULT ${JSON.stringify(result)}\n`);
process.exit(0);
