/**
 * Environment for a hosted Pi child process.
 *
 * Both runner paths (legacy and the issue-#70 owned protocol) spawn the same
 * child, so the variable set lives here instead of being duplicated: a single
 * place to add or rename a key, and a pure function that can be unit-tested
 * without spawning anything. `socketPath` is the endpoint THIS host instance
 * bound; exporting it is what lets the child's editor-state reporter reach the
 * live host instead of the pre-#70 per-view path (issue #103).
 *
 * @param {{
 *   root: string,
 *   viewId: string,
 *   socketPath: string,
 *   baseEnv?: Record<string, string|undefined>,
 *   extraEnv?: Record<string, string> | undefined,
 * }} opts
 */
export function hostChildEnv({ root, viewId, socketPath, baseEnv = {}, extraEnv = {} }) {
	return {
		...baseEnv,
		...extraEnv,
		AGENT_BOARD_ROOT: root,
		AGENT_BOARD_VIEW_ID: viewId,
		AGENT_BOARD_CHILD: "1",
		AGENT_BOARD_HOSTED: "pty",
		AGENT_BOARD_CONTROL_SOCKET: socketPath,
		// Legacy names are exported too so older child extension builds still behave.
		AGENT_VIEW_ROOT: root,
		AGENT_VIEW_VIEW_ID: viewId,
		AGENT_VIEW_CHILD: "1",
		AGENT_VIEW_HOSTED: "pty",
	};
}
