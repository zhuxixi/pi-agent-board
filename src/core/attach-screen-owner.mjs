// Issue #278: Ctrl+G opens an external editor that temporarily exits Pi's
// alt screen. This module tracks synchronized-output ownership (?2026) around
// alt-screen exits (?1049l) so the attach view can tell Pi-owned frames from
// external editor output. The reducer is pure; the adapter only registers
// xterm CSI handlers and always returns false so normal parsing continues.

function hasParam(params, wanted) {
	return params.some((value) => value === wanted || (Array.isArray(value) && value.includes(wanted)));
}

export function createAttachScreenOwnerState(externalOutputActive = false) {
	return { syncOpen: false, externalOutputActive };
}

export function transitionAttachScreenOwner(state, event) {
	if (event.type === "reset") return createAttachScreenOwnerState();
	if (event.type === "adopt") return { ...state, externalOutputActive: event.active };
	if (event.type !== "csi") return state;
	const has2026 = hasParam(event.params, 2026);
	const has1049 = hasParam(event.params, 1049);
	if (event.final === "h" && has2026) return { syncOpen: true, externalOutputActive: false };
	if (event.final === "l") {
		return {
			syncOpen: has2026 ? false : state.syncOpen,
			externalOutputActive: has1049 && state.syncOpen ? true : state.externalOutputActive,
		};
	}
	return state;
}

export function installAttachScreenOwnerObservers(term, { initialState = createAttachScreenOwnerState(), onTransition = () => {} } = {}) {
	if (!term?.parser || typeof term.parser.registerCsiHandler !== "function") return [];
	let state = initialState;
	const observers = [];
	try {
		for (const final of ["h", "l"]) {
			observers.push(term.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
				const previous = state;
				const event = { type: "csi", final, params };
				const current = transitionAttachScreenOwner(state, event);
				state = current;
				onTransition({
					previous, current, event,
					syncOpenMarker: final === "h" && hasParam(params, 2026),
					syncCloseMarker: final === "l" && hasParam(params, 2026),
				});
				return false;
			}));
		}
		return observers;
	} catch (error) {
		for (const observer of observers) observer.dispose();
		throw error;
	}
}
