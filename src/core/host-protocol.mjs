/** Control-socket client identity helpers (issue #103).
 *
 * Client ids travel in the `hello` handshake. `helloBookkeeping` turns the
 * classification into the explicit socket policy: probes and the resident
 * editor-state reporter stay out of `attachedClients` / `attachedEver`, and
 * probes additionally never trigger a host.json write — counting or writing
 * either would pin every host against warm-host reclaim (issue #75 / #103 §C /
 * #130).
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

/**
 * Socket bookkeeping implied by a hello classification (issue #103 §C / #130).
 *
 * `probe` and `editor-reporter` are bookkeeping-only: neither may keep
 * `attachedClients` — whose sole source is the runner's `clients` set —
 * non-zero, or warm-host reclaim never fires and hosts leak (issue #75). Both
 * therefore leave `clients` at hello time, while their socket stays writable so
 * probe replies and editor_state keep flowing.
 *
 * `persist: false` for probes is deliberate: the attach resolver probes every
 * HOST_PROBE_RETRY_MS (see host-probe.mjs), so one host.json write per probe
 * would amplify fenced writes — the exact cost the runner's probe-socket write
 * suppression exists to avoid. Dropping the socket from `clients` already makes
 * the in-memory count right, and the next heartbeat (<=1s) persists it.
 *
 * `suppressCloseWrite: true` is the other half of that suppression: close is the
 * wrong moment to flush a record a probe never changed.
 *
 * An unrecognized kind falls back to the real-client row on purpose — counting
 * an unknown connection is the conservative direction (it can only delay
 * reclaim, never risk killing a host with a live client).
 *
 * @param {"probe" | "editor-reporter" | "client"} kind
 * @returns {{ keepInClients: boolean, registerReporter: boolean,
 *             flipAttachedEver: boolean, persist: boolean, suppressCloseWrite: boolean }}
 */
export function helloBookkeeping(kind) {
	switch (kind) {
		case "probe":
			return { keepInClients: false, registerReporter: false, flipAttachedEver: false, persist: false, suppressCloseWrite: true };
		case "editor-reporter":
			return { keepInClients: false, registerReporter: true, flipAttachedEver: false, persist: true, suppressCloseWrite: false };
		default:
			return { keepInClients: true, registerReporter: false, flipAttachedEver: true, persist: true, suppressCloseWrite: false };
	}
}
