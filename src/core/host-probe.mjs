/**
 * Real control-endpoint probe (issue #70).
 *
 * Connects to a PTY host control socket/pipe, performs the JSONL hello
 * handshake, and classifies the outcome via `classifyProbeResult`. This is
 * the ONLY "is this endpoint actually usable" authority — path existence and
 * host.json state are hints, never proof (spec §7.1).
 *
 * Side-effectful by design (net + fs); all pure decisions live in
 * host-coordination.mjs.
 */
import { createConnection } from "node:net";
import { lstatSync } from "node:fs";
import { classifyProbeResult } from "./host-coordination.mjs";

/** Default probe timeout. */
export const HOST_PROBE_TIMEOUT_MS = 250;

/**
 * @typedef {object} ProbeResult
 * @property {"ready"|"starting"|"stale"|"occupied"|"missing"|"unknown"} classification
 * @property {boolean} connected
 * @property {boolean} protocolValid
 * @property {boolean} ready
 * @property {string|null} viewId
 * @property {string|null} instanceId
 * @property {string|null} state
 * @property {string|null} errorCode
 */

/**
 * Probe a host control endpoint via a real connection + JSONL hello.
 *
 * `connect` is injectable for tests; the default accepts anything
 * `net.createConnection` accepts (a socket path / pipe name, or a
 * `{ host, port }` address object) and must return a socket-like object with
 * the usual `'connect' | 'data' | 'error'` events and a `.destroy()`.
 *
 * The probe socket is ALWAYS destroyed before the promise resolves.
 *
 * @param {string|{host:string,port:number}} socketPath
 * @param {{ timeoutMs?: number, expectedViewId?: string|null, expectedInstanceId?: string|null, connect?: (target: any) => any }} [opts]
 * @returns {Promise<ProbeResult>}
 */
export function probeHost(socketPath, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? HOST_PROBE_TIMEOUT_MS;
	const expectedViewId = opts.expectedViewId ?? null;
	const expectedInstanceId = opts.expectedInstanceId ?? null;
	const connect = opts.connect ?? createConnection;

	return new Promise((resolve) => {
		/** @type {any} */ let socket;
		/** @type {NodeJS.Timeout|null} */ let timer = null;
		let settled = false;
		let buffer = "";
		/** @type {ProbeResult} */ let result;

		const finish = () => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			try { socket?.destroy(); } catch { /* best effort */ }
			resolve(result);
		};

		/** @param {string} errorCode */ const finishError = (errorCode) => {
			const snapshot = {
				connected: false,
				protocolValid: false,
				errorCode,
				isSocket: false,
			};
			// Only a refused Unix-domain socket path can be considered stale, and
			// even then only when the path really is a socket file (a plain file
			// or directory at the same path must stay "unknown" — never unlink it).
			if (errorCode === "ECONNREFUSED" && process.platform !== "win32" && typeof socketPath === "string") {
				try {
					snapshot.isSocket = lstatSync(socketPath).isSocket() === true;
				} catch {
					snapshot.isSocket = false;
				}
			}
			result = buildResult(snapshot, null);
			finish();
		};

		try {
			socket = connect(socketPath);
		} catch (err) {
			result = buildResult({ connected: false, protocolValid: false, errorCode: errCode(err), isSocket: false }, null);
			finish();
			return;
		}

		timer = setTimeout(() => finishError("TIMEOUT"), timeoutMs);

		socket.on("error", (err) => {
			finishError(errCode(err));
		});

		socket.on("connect", () => {
			try {
				socket.write(JSON.stringify({ type: "hello", clientId: "probe", wantOutput: false }) + "\n");
			} catch (err) {
				finishError(errCode(err));
			}
		});

		socket.on("data", (chunk) => {
			if (settled) return;
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline).trim();
			const parsed = parseReply(line);
			result = buildResultFromReply(parsed, expectedViewId, expectedInstanceId);
			finish();
		});

		// A close before any data settles the probe as an error-path unknown.
		socket.on("close", () => {
			if (!settled) finishError("CLOSED");
		});
	});
}

/**
 * @param {string} line
 * @returns {{ ok: boolean, status: any }}
 */
function parseReply(line) {
	if (!line) return { ok: false, status: null };
	try {
		const msg = JSON.parse(line);
		if (!msg || typeof msg !== "object") return { ok: false, status: null };
		if (msg.type !== "hello" && msg.type !== "status") return { ok: false, status: null };
		if (!msg.status || typeof msg.status !== "object") return { ok: false, status: null };
		return { ok: true, status: msg.status };
	} catch {
		return { ok: false, status: null };
	}
}

/**
 * Assemble the classify snapshot from a parsed reply.
 * @param {{ ok: boolean, status: any }} parsed
 * @param {string|null} expectedViewId
 * @param {string|null} expectedInstanceId
 */
function buildResultFromReply(parsed, expectedViewId, expectedInstanceId) {
	const status = parsed.ok ? parsed.status : null;
	const viewMatch = expectedViewId == null ? true : status?.viewId === expectedViewId;
	const instanceMatch = expectedInstanceId == null ? true : status?.instanceId === expectedInstanceId;
	// Legacy hosts (pre-instanceId protocol) report alive without a readyAt
	// field; a legacy probe (no expectedInstanceId) must still classify them
	// ready so upgrade-window attach keeps working (spec §10.1 / Task 2 ruling).
	const readyAt = status?.readyAt ?? (expectedInstanceId == null && status?.state === "alive" ? 1 : null);
	return buildResult(
		{
			connected: true,
			protocolValid: parsed.ok,
			viewMatch,
			instanceMatch,
			state: status?.state ?? null,
			readyAt,
		},
		status,
	);
}

/**
 * @param {{ connected: boolean, protocolValid: boolean, viewMatch?: boolean, instanceMatch?: boolean, state?: string|null, readyAt?: number|null, errorCode?: string|null, isSocket?: boolean }} snapshot
 * @param {any} status
 * @returns {ProbeResult}
 */
function buildResult(snapshot, status) {
	const classification = classifyProbeResult(snapshot);
	return {
		classification,
		connected: snapshot.connected === true,
		protocolValid: snapshot.protocolValid === true,
		ready: classification === "ready",
		viewId: status?.viewId ?? null,
		instanceId: status?.instanceId ?? null,
		state: snapshot.state ?? null,
		errorCode: snapshot.errorCode ?? null,
	};
}

/** @param {unknown} err */
function errCode(err) {
	if (err && typeof err === "object" && typeof /** @type {any} */ (err).code === "string") return /** @type {any} */ (err).code;
	return "UNKNOWN";
}
