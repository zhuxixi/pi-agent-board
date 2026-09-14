/**
 * Control-socket client classification (issue #103).
 *
 * Three kinds of clients talk to a host runner: the attach UI, the read-only
 * liveness probes (issue #70 CR finding 3), and the hosted child's editor-state
 * reporter (issue #68). Only a real attach client may count as "attached":
 * `attachedClients` gates warm-host reclamation (issue #75,
 * warm-host-sweeper.mjs) and the revoke guard (service.mjs), and the reporter
 * holds a permanent connection for the whole life of the session.
 */

export const PROBE_CLIENT_ID = "probe";
export const EDITOR_REPORTER_CLIENT_ID = "editor-reporter";

/**
 * @param {{ type?: string, clientId?: unknown } | null | undefined} msg a decoded client frame
 * @returns {"probe" | "reporter" | "client"}
 */
export function classifyClientHello(msg) {
	if (!msg || msg.type !== "hello") return "client";
	if (msg.clientId === PROBE_CLIENT_ID) return "probe";
	if (msg.clientId === EDITOR_REPORTER_CLIENT_ID) return "reporter";
	return "client";
}
