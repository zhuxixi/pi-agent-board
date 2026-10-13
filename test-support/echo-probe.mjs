/**
 * Echo-probe wait helper for the accept-registration race (issue #178).
 *
 * A client's TCP `connect` completes before the server registers it in the
 * broadcast set, so a one-shot boot banner can be broadcast before accept and
 * is never replayed. The fake PTY echoes every input line, so a probe line
 * always produces output on a live host: sending probes until the caller
 * observes the echo is the event-driven replacement for "wait for the banner".
 *
 * Pure logic with injected I/O. The caller owns the transport, the wait loop
 * and the verdict; this helper only sends.
 */

/**
 * @param {{
 * 	send: (line: string) => void,
 * 	intervalMs?: number,
 * 	sleep?: (ms: number) => Promise<void>,
 * }} io
 * @returns {{ line: () => string, start: () => void, stop: () => void }}
 */
export function createEchoProbe({ send, intervalMs = 300, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
	let stopped = false;
	let n = 0;
	let last = "";
	const loop = async () => {
		try {
			while (!stopped) {
				n += 1;
				last = `boot-probe-${n}\r`;
				send(last);
				await sleep(intervalMs);
			}
		} catch {
			// A dead transport must not crash the suite with an unhandled rejection:
			// the caller's wait still fails loudly at its own deadline and carries
			// the postmortem. Stop probing instead of throwing.
			stopped = true;
		}
	};
	return {
		line: () => last,
		start: () => {
			void loop();
		},
		stop: () => {
			stopped = true;
		},
	};
}
