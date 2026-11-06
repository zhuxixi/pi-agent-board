/**
 * Shared helper for hosted frame-witness socket/reporter management.
 *
 * Owns the lifecycle of a dedicated frame-reporter socket and its AttachFrameReporter:
 * negotiation, idempotent cleanup, and the onUnavailable → socket.destroy binding.
 *
 * Both production (`src/index.ts`) and tests (A04 child fixture) must use this helper;
 * tests must not duplicate the wiring and then hand-destroy the socket.
 */
import { createConnection } from "node:net";
import { AttachFrameReporter } from "./attach-frame-reporter.mjs";

/**
 * Create a hosted frame-witness connection.
 *
 * @param {{
 *   socketPath: string,
 *   sessionEpoch: number,
 *   ui: import("@earendil-works/pi-tui").ComponentContext["ui"],
 *   onUnavailable?: (reason: string) => void,
 * }} opts
 * @returns {{ reporter: AttachFrameReporter, socket: import("node:net").Socket, cleanup: (reason: string) => void }}
 */
export function createHostedFrameWitness({ socketPath, sessionEpoch, ui, onUnavailable = () => {} }) {
	const socket = createConnection(socketPath);
	const reporter = new AttachFrameReporter({
		ui,
		mode: "fullscreen",
		sessionEpoch,
		send: (message) => {
			try {
				socket.write(`${JSON.stringify(message)}\n`);
			} catch {
				/* socket errors surface through the error handler */
			}
		},
		onUnavailable,
	});

	let cleaned = false;
	const cleanup = (reason) => {
		if (cleaned) return;
		cleaned = true;
		try {
			reporter.dispose(reason);
		} catch {
			/* never break the session over the frame witness */
		}
		try {
			socket.destroy();
		} catch {
			/* already closed */
		}
	};

	socket.on("error", () => cleanup("socket-error"));
	socket.on("close", () => cleanup("socket-close"));

	return { reporter, socket, cleanup };
}
