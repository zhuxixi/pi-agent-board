/** Child-Pi editor-state reporter (issue #68): polls the child Pi's editor text
 * and pushes `{type:"editor_state", empty}` over the control socket whenever the
 * text changes, so the attach surface can gate ← on the authoritative state
 * instead of render heuristics. Dependency-injected for unit testing. */

/** @typedef {{ write(jsonLine: string): void; on?(event: "close" | "error", fn: () => void): void }} SocketLike */

const defaultScheduler = {
	interval(fn, ms) { return setInterval(fn, ms); },
	timeout(fn, ms) { return setTimeout(fn, ms); },
	clear(handle) { clearInterval(handle); clearTimeout(handle); },
};

export function createEditorStateReporter({ getEditorText, connect, intervalMs = 100, scheduler = defaultScheduler }) {
	let started = false;
	let stopped = false;
	let socket = null;
	let pollTimer = null;
	let reconnectTimer = null;
	let backoffMs = 1000;
	let lastText = null;

	function send(json) {
		if (!socket) return;
		try {
			socket.write(JSON.stringify(json) + "\n");
		} catch {
			teardownSocket();
			scheduleReconnect();
		}
	}

	function teardownSocket() {
		if (pollTimer !== null) { scheduler.clear(pollTimer); pollTimer = null; }
		const s = socket;
		socket = null;
		if (s?.on) { try { s.on("close", () => {}); s.on("error", () => {}); } catch { /* already torn down */ } }
	}

	function poll() {
		if (stopped || !socket) return;
		const text = getEditorText();
		if (text !== lastText) {
			lastText = text;
			send({ type: "editor_state", empty: text.length === 0 });
		}
	}

	function startPolling() {
		if (pollTimer !== null) return;
		lastText = null; // force a first report after (re)connect
		pollTimer = scheduler.interval(poll, intervalMs);
	}

	function scheduleReconnect() {
		if (stopped) return;
		teardownSocket();
		reconnectTimer = scheduler.timeout(tryConnect, backoffMs);
		backoffMs = Math.min(backoffMs * 2, 5000);
	}

	function tryConnect() {
		reconnectTimer = null;
		if (stopped) return;
		let s;
		try {
			s = connect();
		} catch {
			scheduleReconnect();
			return;
		}
		socket = s;
		backoffMs = 1000;
		s?.on?.("close", () => { if (socket === s) scheduleReconnect(); });
		s?.on?.("error", () => { if (socket === s) scheduleReconnect(); });
		startPolling();
	}

	function start() {
		if (started) return;
		started = true;
		stopped = false;
		tryConnect();
	}

	function stop() {
		stopped = true;
		if (reconnectTimer !== null) { scheduler.clear(reconnectTimer); reconnectTimer = null; }
		teardownSocket();
	}

	return { start, stop };
}
