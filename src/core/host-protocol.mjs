/** Control-socket client identity helpers (issue #103).
 *
 * Client ids travel in the `hello` handshake. The runner uses them to keep
 * bookkeeping-only connections out of `attachedClients` / `attachedEver`:
 * the attach resolver's probes are read-only, and the hosted child's
 * editor-state reporter is a resident connection — counting either would pin
 * every host against warm-host reclaim (issue #75 / #103 §C).
 */

/** Read-only endpoint probe (attach resolver); never counts as attached. */
export const CLIENT_ID_PROBE = "probe";
/** Resident editor-state reporter inside a hosted child; never counts as attached. */
export const CLIENT_ID_EDITOR_REPORTER = "editor-reporter";

/**
 * @param {{ type?: string, clientId?: string } | null | undefined} msg
 * @returns {"probe" | "editor-reporter" | "client"}
 */
export function classifyClientHello(msg) {
	const clientId = msg && typeof msg.clientId === "string" ? msg.clientId : "";
	if (clientId === CLIENT_ID_PROBE) return "probe";
	if (clientId === CLIENT_ID_EDITOR_REPORTER) return "editor-reporter";
	return "client";
}
