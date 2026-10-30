/**
 * Public-API child adapter for the attach frame witness (issue #222, step 23a).
 *
 * The adapter is inert until a runner explicitly enables it: it sends a `hello`
 * carrying `clientId:"frame-reporter"` and `frameWitness:{protocol:1}`, and only a
 * `{type:"frame_witness_enable", protocol:1, token}` reply turns the capability on.
 * Old or silent runners therefore see byte-identical behaviour: no widget, no
 * wrappers, no markers. The current runner does not implement the handshake — that is
 * FW-04/23b — so nothing in the default extension path ever enables this.
 *
 * ## Interface discipline (converged contract §2.1)
 *
 * - One zero-height belowEditor sentinel registered with the public `ctx.ui.setWidget`.
 *   It never changes focus, input, visible rows or editor content.
 * - INSTANCE-OWN shadows only: `columns`/`rows` accessors, `write`/`hideCursor`/
 *   `showCursor` methods and the `start`/`stop` lifecycle. Prototype descriptors are
 *   recorded before shadowing, descriptor kinds are preserved, original `this`, args,
 *   return values and exceptions are passed through unchanged, and restore removes an
 *   own shadow ONLY while it is still this adapter's own function.
 * - Focus comes from a runtime feature-detected `getFocusedComponent()`; when it is
 *   absent the capability reports `unsupported` instead of guessing from pixels.
 * - Markers are written through the ORIGINAL (pre-shadow) terminal write, in order,
 *   with a reentrancy guard, and never enter candidate accounting. A marker failure
 *   turns the capability off and reports UNKNOWN; it never blocks or alters the
 *   original child output, and no later `F` is written as if the frame completed.
 *
 * No production wiring lives here: `src/index.ts` is untouched, no runner code reads
 * these markers, and there is no default fast path.
 */
import {
	FRAME_REPORTER_CLIENT_ID,
	FRAME_WITNESS_PROTOCOL,
	FrameCandidateEvaluator,
	MAX_FRAME_MARKER_BYTES,
	encodeFrameMarkerA,
	encodeFrameMarkerF,
	encodeFrameMarkerS,
	isValidFrameWitnessToken,
} from "./attach-frame-proof.mjs";

export const ATTACH_FRAME_WIDGET_KEY = "agent-board-frame-witness";

const SENTINEL_KEYS = ["columns", "rows", "write", "hideCursor", "showCursor", "start", "stop"];
const MODES = new Set(["fullscreen", "regular"]);

function ownDescriptor(target, key) {
	return Object.getOwnPropertyDescriptor(target, key);
}

function protoDescriptorOf(target, key) {
	const proto = Object.getPrototypeOf(target);
	return proto === null ? undefined : Object.getOwnPropertyDescriptor(proto, key);
}

/**
 * Restore an adapter-owned shadow. If the adapter's shadow is still current, the
 * PRE-EXISTING own descriptor is reinstalled when there was one (never erased), and the
 * property is deleted only when no own property existed before. A third party's later
 * replacement is left untouched.
 */
function restoreOwnShadow(terminal, entry) {
	const current = ownDescriptor(terminal, entry.key);
	const installed = entry.installed;
	const stillOurs = current !== undefined && (typeof installed === "function" ? current.get === installed || current.value === installed : current.value === installed);
	if (!stillOurs) return current === undefined ? "already-absent" : "shadow-replaced-not-restored";
	if (entry.ownBefore === undefined) delete terminal[entry.key];
	else Object.defineProperty(terminal, entry.key, entry.ownBefore);
	return "restored";
}

/**
 * Capability negotiation. Returns `{status, reason}`; only an exact well-formed enable
 * message with a valid token turns the reporter on.
 */
export function negotiateFrameWitness(message) {
	if (message === null || typeof message !== "object") return { status: "ignored", reason: "not-an-object" };
	if (message.type !== "frame_witness_enable") return { status: "ignored", reason: "not-enable" };
	if (message.protocol !== FRAME_WITNESS_PROTOCOL) return { status: "unsupported", reason: "protocol" };
	if (!isValidFrameWitnessToken(message.token)) return { status: "unsupported", reason: "token" };
	return { status: "enabled", reason: "ok", token: message.token };
}

/**
 * The reporter. All I/O is injected so unit tests can drive it with public-shaped
 * doubles while the real extension passes the live `ctx.ui` and reporters socket.
 */
export class AttachFrameReporter {
	#ui;
	#send;
	#mode;
	#rendererEpoch;
	#sessionEpoch;
	#now;
	#state = "idle"; // idle | announced | enabled | unsupported | failed | disposed
	#token = null;
	#frameIdCounter = { value: 0 };
	#evaluator;
	#terminal = null;
	#terminalWrite = null;
	#shadows = [];
	#sentinelTui = null;
	#focusApi = "unknown";
	#renderPasses = 0;
	#markerCount = 0;
	#markerFailure = null;
	#unknown = [];
	#inMarker = false;
	#lastMetadata = null;
	#suspensions = 0;
	#latestFact = null;
	#pendingAfterDispose = [];
	#superseding = false;
	#instanceId = null;
	#intentRequestId = null;
	#geometryRevision = -1;
	#intentsRejected = 0;
	#intentsApplied = 0;
	#seenRequestIds = new Set();
	#consumedRequestIds = new Set();
	#intentId = 0;

	constructor({ ui, send = (_message) => {}, mode = "fullscreen", rendererEpoch = 1, sessionEpoch = 0, now = () => Date.now() }) {
		if (!ui || typeof ui.setWidget !== "function") throw new Error("AttachFrameReporter requires ctx.ui.setWidget");
		if (!MODES.has(mode)) throw new Error(`unknown renderer mode: ${mode}`);
		this.#ui = ui;
		this.#send = send;
		this.#mode = mode;
		this.#rendererEpoch = rendererEpoch;
		this.#sessionEpoch = sessionEpoch;
		this.#now = now;
		this.#evaluator = new FrameCandidateEvaluator({ mode, rendererEpoch, sessionEpoch, frameIdCounter: this.#frameIdCounter });
	}

	get state() {
		return this.#state;
	}

	get capabilityEnabled() {
		return this.#state === "enabled";
	}

	get markerCount() {
		return this.#markerCount;
	}

	get markerFailure() {
		return this.#markerFailure;
	}

	get instanceId() {
		return this.#instanceId;
	}

	get geometryRevision() {
		return this.#geometryRevision;
	}

	get intentStats() {
		return {
			applied: this.#intentsApplied,
			rejected: this.#intentsRejected,
			geometryRevision: this.#geometryRevision,
			requestId: this.#intentRequestId,
			intentId: this.#intentId,
			consumedRequestIds: [...this.#consumedRequestIds],
		};
	}

	/**
	 * First matching complete F consumes the current intent: later frames with the same
	 * nonce may update the view but never consume it again (and duplicate requestIds stay
	 * rejected). Applied is never completion.
	 */
	consumeIntentOnce() {
		if (this.#intentRequestId === null || this.#consumedRequestIds.has(this.#intentRequestId)) return false;
		this.#consumedRequestIds.add(this.#intentRequestId);
		return true;
	}

	get unknown() {
		return this.#unknown.slice();
	}

	get decisions() {
		return this.#evaluator.decisions;
	}

	get frameIdCounter() {
		return this.#frameIdCounter;
	}

	get installedKeys() {
		return this.#shadows.map((entry) => entry.key);
	}

	/** Renderer-stops observed (a mode switch suspends and then re-arms the adapter). */
	get suspensions() {
		return this.#suspensions;
	}

	/** Resident-socket greeting. Sent once; never retried automatically. */
	announce() {
		if (this.#state !== "idle") return this.#state;
		this.#state = "announced";
		this.#send({
			type: "hello",
			clientId: FRAME_REPORTER_CLIENT_ID,
			frameWitness: { protocol: FRAME_WITNESS_PROTOCOL, sessionEpoch: this.#sessionEpoch },
		});
		return this.#state;
	}

	/**
	 * Handle one reporter message. Disabled/old runners leave the adapter in
	 * `unsupported` with NO widget, NO wrappers and NO markers.
	 */
	handleMessage(message) {
		const negotiation = negotiateFrameWitness(message);
		if (negotiation.status !== "enabled") {
			if (this.#state !== "enabled") this.#state = negotiation.status === "unsupported" ? "unsupported" : this.#state;
			return negotiation;
		}
		// P2: the enable must carry the reporter's ACTUAL session epoch; a missing,
		// invalid or mismatched epoch is unsupported rather than silently accepted.
		const epoch = message.sessionEpoch;
		if (!Number.isInteger(epoch) || epoch < 0 || epoch !== this.#sessionEpoch) {
			if (this.#state !== "enabled") this.#state = "unsupported";
			return { status: "unsupported", reason: "sessionEpoch" };
		}
		this.#token = negotiation.token;
		if (typeof message.instanceId === "string" && message.instanceId.length > 0) this.#instanceId = message.instanceId;
		this.#state = "enabled";
		return negotiation;
	}

	/** Register the belowEditor sentinel; the terminal is attached from its TuiRef. */
	install() {
		if (this.#state !== "enabled") return false;
		if (this.#sentinelTui !== null) return false;
		// Re-registration disposes the previous component synchronously; mark that window
		// so a superseded sentinel does not tear the whole reporter down.
		this.#superseding = true;
		try {
			this.#ui.setWidget(ATTACH_FRAME_WIDGET_KEY, (tui) => this.#createSentinel(tui), { placement: "belowEditor" });
		} finally {
			this.#superseding = false;
		}
		return this.#terminal !== null;
	}

	/**
	 * Runner frame-witness intent (FW-04). Validated strictly: a wrong instance, a
	 * non-string requestId, a non-monotonic geometryRevision or non-positive dims are
	 * rejected without touching the renderer. A valid intent is stored and a NORMAL
	 * public `tui.requestRender()` is requested — never a private doRender, force reset
	 * or extra resize. `applied` from the runner is NOT completion; only the complete
	 * target-geometry frame can prove.
	 */
	applyIntent(message) {
		if (this.#state !== "enabled") return { ok: false, reason: "capability-off" };
		if (message === null || typeof message !== "object" || message.type !== "frame_witness_intent") return { ok: false, reason: "not-intent" };
		if (this.#instanceId !== null && message.instanceId !== this.#instanceId) {
			this.#intentsRejected += 1;
			return { ok: false, reason: "instance" };
		}
		if (typeof message.requestId !== "string" || message.requestId.length === 0) {
			this.#intentsRejected += 1;
			return { ok: false, reason: "requestId" };
		}
		if (this.#seenRequestIds.has(message.requestId)) {
			this.#intentsRejected += 1;
			return { ok: false, reason: "duplicate-requestId" };
		}
		const match = /^fw-(\d+)$/.exec(message.requestId);
		if (match === null || Number(match[1]) < 1) {
			this.#intentsRejected += 1;
			return { ok: false, reason: "requestId-format" };
		}
		if (!Number.isInteger(message.geometryRevision) || message.geometryRevision <= this.#geometryRevision) {
			this.#intentsRejected += 1;
			return { ok: false, reason: "geometryRevision" };
		}
		if (!Number.isInteger(message.cols) || message.cols < 1 || !Number.isInteger(message.rows) || message.rows < 1) {
			this.#intentsRejected += 1;
			return { ok: false, reason: "dims" };
		}
		this.#geometryRevision = message.geometryRevision;
		this.#intentRequestId = message.requestId;
		this.#intentId = Number(match[1]);
		this.#seenRequestIds.add(message.requestId);
		this.#intentsApplied += 1;
		this.#evaluator.setIntent({ intentId: this.#intentId, geometryRevision: message.geometryRevision, cols: message.cols, rows: message.rows });
		const requested = this.#requestRender();
		return { ok: true, requested, geometryRevision: this.#geometryRevision };
	}

	#requestRender() {
		const tui = this.#sentinelTui;
		if (tui !== null && typeof tui.requestRender === "function") {
			try {
				tui.requestRender();
				return true;
			} catch {
				return false;
			}
		}
		return false;
	}

	/** Renderer mode change: carry the frameId counter, rebind the grammar. */
	setMode(mode, { rendererEpoch = this.#rendererEpoch + 1 } = {}) {
		if (!MODES.has(mode)) throw new Error(`unknown renderer mode: ${mode}`);
		const produced = this.#evaluator.abort("mode-changed");
		this.#mode = mode;
		this.#rendererEpoch = rendererEpoch;
		this.#evaluator = new FrameCandidateEvaluator({
			mode,
			rendererEpoch,
			sessionEpoch: this.#sessionEpoch,
			frameIdCounter: this.#frameIdCounter,
		});
		this.#sentinelTui = null;
		this.#focusApi = "unknown";
		return produced;
	}

	/** Session-scoped teardown: stop proving and restore every own shadow. */
	dispose(reason = "dispose") {
		const produced = this.#evaluator.stop();
		const restores = this.#restoreShadows(reason);
		this.#state = "disposed";
		return { decisions: produced, restores };
	}

	#createSentinel(tui) {
		// F6: the renderer mode comes from the ACTUAL public `tui.mode`, never a hardcoded
		// default. A mode change rebinds the grammar (carried frameId, same terminal); an
		// unavailable/unknown mode is `unsupported`, not a fabricated value.
		const observedMode = typeof tui?.mode === "string" ? tui.mode : null;
		if (observedMode === null || !MODES.has(observedMode)) {
			this.#unknown.push({ what: "mode", reason: "public tui.mode is unavailable or unknown; mode evidence unsupported" });
			this.#state = "unsupported";
			this.#sentinelTui = tui;
			return { render: () => [], dispose: () => {} };
		}
		if (observedMode !== this.#mode) this.setMode(observedMode);
		this.#sentinelTui = tui;
		const maybe = tui?.getFocusedComponent;
		this.#focusApi = typeof maybe === "function" ? "present" : "absent";
		if (this.#focusApi === "absent") {
			this.#unknown.push({ what: "focus", reason: "public TUI instance has no getFocusedComponent; focus evidence unsupported" });
			if (this.#state === "enabled") this.#state = "unsupported";
		}
		this.#attachTerminal(tui);
		return {
			render: () => {
				this.#renderPasses += 1;
				if (this.#state !== "enabled") return [];
				// Host 1.4.0 `switchTuiMode()` REUSES the existing widget component and never
				// calls the factory again. A renderer stop suspends the binding, so the SAME
				// component's next render is where the adapter must re-arm — no install() or
				// setWidget() refresh, no test-only path.
				if (this.#sentinelTui === null) this.#reactivate(tui);
				if (this.#sentinelTui !== tui) return [];
				const focus = this.#focusApi === "present" ? tui.getFocusedComponent?.() : undefined;
				const overlayPresent = typeof tui?.hasOverlay === "function" ? Boolean(tui.hasOverlay()) : false;
				this.#latestFact = { focusPresent: focus !== null && focus !== undefined, focusIdentity: focus, mode: this.#mode, overlayPresent };
				this.#evaluator.sentinel(this.#latestFact);
				return [];
			},
			dispose: () => {
				if (this.#state !== "enabled") return;
				// A disposed sentinel always aborts the open candidate. Only a REAL teardown
				// (not the disposal that a re-registration triggers synchronously) stops
				// proving and restores the wrappers.
				this.#pendingAfterDispose.push(...this.#evaluator.abort("sentinel-dispose"));
				if (this.#superseding) return;
				this.#restoreShadows("sentinel-dispose");
				this.#terminal = null;
				this.#terminalWrite = null;
				this.#sentinelTui = null;
				this.#state = "disposed";
			},
		};
	}

	/**
	 * Post-stop reactivation from the EXISTING sentinel component: rebind from the actual
	 * current public `tui.mode`, advance rendererEpoch EXACTLY once (same-mode stop/start
	 * included), rebuild the grammar on the carried frameId counter and reinstall the own
	 * shadows on the same shared terminal. Never used by disposed/unsupported/failed states.
	 */
	#reactivate(tui) {
		if (this.#state !== "enabled") return;
		const observed = typeof tui?.mode === "string" ? tui.mode : null;
		if (observed === null || !MODES.has(observed)) {
			this.#unknown.push({ what: "mode", reason: "public tui.mode unavailable on reactivation" });
			this.#state = "unsupported";
			return;
		}
		this.#rendererEpoch += 1;
		this.#mode = observed;
		this.#evaluator = new FrameCandidateEvaluator({
			mode: observed,
			rendererEpoch: this.#rendererEpoch,
			sessionEpoch: this.#sessionEpoch,
			frameIdCounter: this.#frameIdCounter,
		});
		this.#sentinelTui = tui;
		this.#attachTerminal(tui);
	}

	#attachTerminal(tui) {
		if (this.#terminal !== null) {
			// Re-registration after a mode switch must keep the SAME shared terminal.
			const same = tui?.terminal === this.#terminal;
			if (!same) this.#unknown.push({ what: "terminal", reason: "re-registration reported a different terminal instance" });
			return;
		}
		const terminal = tui?.terminal;
		if (terminal === undefined || terminal === null) {
			this.#unknown.push({ what: "terminal", reason: "public TUI instance does not expose the shared terminal" });
			if (this.#state === "enabled") this.#state = "unsupported";
			return;
		}
		this.#terminal = terminal;
		const proto = Object.getPrototypeOf(terminal);
		// The raw, pre-shadow write is how markers reach the same ordered stream.
		const protoWrite = proto === null ? undefined : protoDescriptorOf(terminal, "write")?.value;
		this.#terminalWrite = typeof protoWrite === "function" ? protoWrite : null;
		for (const key of ["columns", "rows"]) {
			const descriptor = protoDescriptorOf(terminal, key);
			const ownBefore = ownDescriptor(terminal, key);
			if (ownBefore !== undefined && typeof ownBefore.get !== "function") {
				// A pre-existing data property on the instance cannot be shadowed faithfully
				// without erasing it on restore; refuse instead.
				this.#unknown.push({ what: "shadow", reason: `pre-existing own data property ${key}` });
				continue;
			}
			const getter = () => {
				const value = ownBefore !== undefined ? ownBefore.get.call(terminal) : typeof descriptor?.get === "function" ? descriptor.get.call(terminal) : undefined;
				this.#evaluator.sizeRead(key, value);
				return value;
			};
			try {
				Object.defineProperty(terminal, key, { configurable: true, enumerable: ownBefore?.enumerable ?? false, get: getter });
				this.#shadows.push({ key, installed: getter, ownBefore });
			} catch {
				this.#unknown.push({ what: "shadow", reason: `cannot shadow ${key}` });
			}
		}
		for (const key of ["write", "hideCursor", "showCursor"]) {
			const original = protoDescriptorOf(terminal, key)?.value;
			if (typeof original !== "function") continue;
			const ownBefore = ownDescriptor(terminal, key);
			const wrapper = (...args) => {
				const text = typeof args[0] === "string" ? args[0] : "";
				if (this.#state !== "enabled") return original.apply(terminal, args);
				const { pending, insertions } = this.#proveOnOperation(key, text);
				let failed = false;
				try {
					if (insertions.length === 0) return original.apply(terminal, args);
					// Split the write exactly at this frame's OPEN token: the prefix is written
					// first, then S, then the remainder — so S never precedes a previous
					// frame's CLOSE that shares the write.
					let cursor = 0;
					let lastResult;
					for (const insertion of insertions) {
						if (insertion.offset > cursor) lastResult = original.call(terminal, text.slice(cursor, insertion.offset));
						this.#emitS(insertion);
						cursor = insertion.offset;
					}
					if (cursor < text.length) lastResult = original.call(terminal, text.slice(cursor));
					return lastResult;
				} catch (error) {
					// A failed original write means the frame bytes were not delivered: abort
					// instead of claiming completion (S, if any, must be closed by A), then
					// rethrow the ORIGINAL error unchanged.
					failed = true;
					for (const decision of this.#evaluator.abort("write-failed")) {
						if (decision.kind === "A") this.#emitA(decision.frameId, decision.reason);
					}
					throw error;
				} finally {
					// NB: no `return` here — a return inside `finally` would swallow the
					// original write error rethrown above.
					if (!failed) {
						// Completion rechecks the LATEST focus identity/mode/overlay before any F.
						const finished = this.#evaluator.finishWrite(this.#latestFact);
						for (const decision of finished) {
							if (decision.kind === "F") this.#emitF(decision);
							else if (decision.kind === "A") this.#emitA(decision.frameId, decision.reason);
						}
						for (const decision of pending) {
							if (decision.kind === "A") this.#emitA(decision.frameId, decision.reason);
						}
					}
				}
			};
			try {
				Object.defineProperty(terminal, key, { configurable: true, enumerable: false, value: wrapper, writable: true });
				this.#shadows.push({ key, installed: wrapper, ownBefore });
			} catch {
				this.#unknown.push({ what: "shadow", reason: `cannot shadow ${key}` });
			}
		}
		for (const key of ["start", "stop"]) {
			const original = protoDescriptorOf(terminal, key)?.value;
			if (typeof original !== "function") continue;
			const ownBefore = ownDescriptor(terminal, key);
			const wrapper = (...args) => {
				if (this.#state === "enabled") {
					this.#evaluator.abort(`terminal-${key}`);
					if (key === "stop") {
						// A renderer stop (mode switch / teardown) aborts the candidate and
						// detaches the adapter, but the capability stays armed: the next
						// registration on the new renderer re-installs on the SAME terminal.
						this.#restoreShadows("terminal-stop");
						this.#terminal = null;
						this.#terminalWrite = null;
						this.#sentinelTui = null;
						this.#suspensions += 1;
					}
				}
				const result = original.apply(terminal, args);
				// Epoch advances only AFTER a successful start (a throw preserves both the
				// old epoch and the original exception).
				if (key === "start" && this.#state === "enabled") {
					this.#rendererEpoch += 1;
					this.#evaluator.setEpoch({ rendererEpoch: this.#rendererEpoch });
				}
				return result;
			};
			try {
				Object.defineProperty(terminal, key, { configurable: true, enumerable: false, value: wrapper, writable: true });
				this.#shadows.push({ key, installed: wrapper, ownBefore });
			} catch {
				this.#unknown.push({ what: "shadow", reason: `cannot shadow ${key}` });
			}
		}
	}

	#restoreShadows(reason) {
		const restores = [];
		for (const entry of this.#shadows) {
			if (this.#terminal === null) break;
			restores.push({ key: entry.key, result: restoreOwnShadow(this.#terminal, entry), restoredOwnBefore: entry.ownBefore !== undefined });
		}
		if (restores.length > 0) this.#shadows = [];
		this.#lastMetadata = this.#lastMetadata === null ? null : { ...this.#lastMetadata, restoreReason: reason };
		return restores;
	}

	#proveOnOperation(kind, text) {
		const { decisions, insertions } = this.#evaluator.op({ kind, text });
		const pending = decisions.filter((decision) => decision.kind === "A");
		return { pending, insertions };
	}

	#writeMarker(text) {
		if (this.#inMarker) {
			this.#failCapability("marker-recursion");
			return false;
		}
		if (this.#state !== "enabled") return false;
		if (Buffer.byteLength(text, "utf8") > MAX_FRAME_MARKER_BYTES) {
			this.#failCapability("marker-oversize");
			return false;
		}
		if (this.#terminalWrite === null || this.#terminal === null) {
			this.#failCapability("marker-no-raw-write");
			return false;
		}
		this.#inMarker = true;
		try {
			// Raw, pre-shadow reference: never re-enters candidate accounting.
			this.#terminalWrite.call(this.#terminal, text);
			this.#markerCount += 1;
			return true;
		} catch (error) {
			this.#failCapability(`marker-write-failed:${error instanceof Error ? error.message : String(error)}`);
			return false;
		} finally {
			this.#inMarker = false;
		}
	}

	#emitS(insertion) {
		if (this.#token === null) return;
		const frameId = insertion.frameId;
		const decision = this.#evaluator.decisions.filter((entry) => entry.kind === "S" && entry.frameId === frameId).at(-1) ?? null;
		try {
			this.#writeMarker(encodeFrameMarkerS({ token: this.#token, frameId, intentId: decision?.intentId ?? 0, sampledCols: decision?.cols }));
		} catch (error) {
			this.#failCapability(`marker-encode-failed:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#emitF(decision) {
		// Never write an F as if the frame completed once the capability failed.
		if (this.#token === null || this.#state !== "enabled") return;
		const frameId = decision.frameId;
		const metadata = this.#evaluator.metadataFor(decision);
		this.#lastMetadata = metadata;
		try {
			if (this.#writeMarker(encodeFrameMarkerF({ token: this.#token, frameId, metadata }))) {
				// P2: consume only after the first matching F was actually written; later
				// frames fall back to the ordinary intent 0 so they cannot masquerade as the
				// completing frame. A failed write never consumes.
				if (this.consumeIntentOnce()) this.#evaluator.setIntent(null);
			}
		} catch (error) {
			this.#failCapability(`marker-encode-failed:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#emitA(frameId, reason) {
		if (this.#token === null || this.#state !== "enabled") return;
		try {
			this.#writeMarker(encodeFrameMarkerA({ token: this.#token, frameId, reason }));
		} catch (error) {
			this.#failCapability(`marker-encode-failed:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Marker failure => capability OFF + UNKNOWN; original output keeps flowing. */
	#failCapability(reason) {
		if (this.#markerFailure === null) this.#markerFailure = { at: this.#now(), reason };
		this.#unknown.push({ what: "marker", reason });
		this.#state = "failed";
	}
}

