/**
 * Shared tracked-coordinator fixture for tests that exercise the real View
 * State Coordinator (issue #91).
 *
 * `sendStateCommand`'s own ensure path spawns the coordinator DETACHED, so a
 * test that lets it lazily start one leaks an untracked process that survives
 * the test's `rmSync` (the socket server keeps the event loop alive forever).
 * Start a TRACKED coordinator instead: the client probe finds this one, and
 * the test kills it in `finally` BEFORE deleting the root.
 *
 * Usage (in-process import, not a standalone entry — the test owns teardown):
 *
 *   import { startCoordinator } from "../test-support/ensure-coordinator-helper.mjs";
 *   const coord = startCoordinator(root);
 *   try { ... } finally { await coord.kill(); rmSync(root, ...); }
 *
 * `kill()` follows the repo's SIGTERM → poll → SIGKILL ladder (cf.
 * `killDetached` in test/runner.integration.test.mjs).
 */
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { coordinatorEndpointPathFor } from "../src/core/paths.mjs";

export const COORDINATOR_SCRIPT = fileURLToPath(
	new URL("../runner/state-coordinator.mjs", import.meta.url),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the coordinator socket accepts a connection (lease won + bound). */
async function waitUntilReady(root, deadlineMs = 10_000) {
	const socketPath = coordinatorEndpointPathFor(process.platform, root);
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			await new Promise((resolve, reject) => {
				const s = createConnection(socketPath);
				s.once("connect", () => {
					s.destroy();
					resolve();
				});
				s.once("error", (err) => {
					s.destroy();
					reject(err);
				});
			});
			return;
		} catch {
			await sleep(50);
		}
	}
	throw new Error(`coordinator at ${socketPath} did not become ready in ${deadlineMs}ms`);
}

/** Spawn a tracked coordinator for `root` and WAIT until it is live (socket
 *  accepting). The readiness wait is load-bearing: without it the client's
 *  ensure path can race the boot and spawn a detached twin that may win the
 *  lease, leaving an orphan when the tracked loser exits. The caller MUST
 *  `await coord.kill()` in finally. */
export async function startCoordinator(root) {
	const child = spawn(process.execPath, [COORDINATOR_SCRIPT, root], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, AGENT_BOARD_ROOT: root, PI_CODING_AGENT_DIR: root },
	});
	const exited = () => child.exitCode !== null || child.signalCode !== null;
	await waitUntilReady(root);
	return {
		child,
		/** SIGTERM → poll exit (1s) → SIGKILL. Idempotent. */
		async kill() {
			if (exited()) return;
			try {
				child.kill("SIGTERM");
			} catch {
				return; // already exited
			}
			const deadline = Date.now() + 1000;
			while (Date.now() < deadline) {
				await sleep(50);
				if (exited()) return;
			}
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		},
	};
}
