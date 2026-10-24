// Parse Kitty graphics commands in order with the PTY grid,
// then render uploads/placements as image lines, never at the host's parked cursor.
const PREFIX = "\x1b_G";
const ST = "\x1b\\";
const OSC = 99173;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_IMAGES = 32;
const command = (controls, payload = "") => `${PREFIX}${controls};${payload}${ST}`;
const controlsString = (controls) => Object.entries(controls).map(([k, v]) => `${k}=${v}`).join(",");

function sourceImageHeight(controls, data) {
	if (controls.f === "100") {
		// Only decode the PNG header, not the entire cached image on every frame.
		const header = Buffer.from(data.slice(0, 44), "base64");
		if (header.length >= 24 && header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && header.toString("ascii", 12, 16) === "IHDR") {
			return header.readUInt32BE(20);
		}
	} else if (["24", "32"].includes(controls.f)) {
		return Number(controls.v) || undefined;
	}
	return undefined;
}

/**
 * Track Pi's direct Kitty uploads and placements alongside an xterm parser.
 * No Kitty APCs means no graphical state or scroll-history side effects;
 * non-Kitty terminal protocols are passed through to the parser unchanged.
 */
export function createPtyKittyImages(term, onClearScrollback = () => {}) {
	let carry = "";
	let nextToken = 0;
	let transmission = null;
	let usedKittyImages = false;
	const pending = new Map();
	const images = new Map();
	const placements = new Map();

	function removePlacement(key) {
		placements.get(key)?.marker?.dispose();
		placements.delete(key);
	}
	function removeImage(id) {
		images.delete(id);
		for (const [key, p] of placements) if (p.id === id) removePlacement(key);
	}
	function clearPlacements() {
		for (const key of placements.keys()) removePlacement(key);
	}
	function place(controls) {
		const id = controls.i;
		const image = images.get(id);
		if (!image) return;
		const c = { ...image.controls, ...controls, a: "p", C: "1", q: "2" };
		// Pi emits explicit cell dimensions; reject unknown extents rather than
		// risking an image over the attach header/footer. Only placement keys survive.
		if (!(Number(c.r) > 0 && Number(c.c) > 0) || c.U === "1") return;
		const allowed = new Set(["a", "i", "p", "x", "y", "w", "h", "X", "Y", "c", "r", "C", "q", "z"]);
		for (const key of Object.keys(c)) if (!allowed.has(key)) delete c[key];
		const key = `${id}:${c.p ?? 0}`;
		removePlacement(key);
		const buf = term.buffer.active;
		placements.set(key, {
			id, controls: c, buffer: buf.type,
			row: buf.baseY + buf.cursorY, col: buf.cursorX,
			marker: term.registerMarker?.(0),
		});
	}
	function accept(sequence) {
		const body = sequence.slice(PREFIX.length, -ST.length);
		const semi = body.indexOf(";");
		const header = semi < 0 ? body : body.slice(0, semi);
		const payload = semi < 0 ? "" : body.slice(semi + 1);
		const c = Object.fromEntries(header.split(",").filter(Boolean).map((part) => part.split("=")));
		if (c.a === "d") {
			const mode = c.d ?? "a";
			if (mode.toLowerCase() === "a") {
				clearPlacements();
				if (mode === "A") images.clear();
			} else if (mode.toLowerCase() === "i") {
				for (const [key, p] of placements) if (p.id === c.i && (!c.p || p.controls.p === c.p)) removePlacement(key);
				if (mode === "I") images.delete(c.i);
			}
			return;
		}
		if (c.a === "p") return place(c);
		// Pi's direct transfers can span hundreds of APCs and arbitrary PTY reads.
		if (!transmission) {
			if (!["t", "T"].includes(c.a ?? "T") || (c.t && c.t !== "d") || !c.i) return;
			transmission = { controls: c, chunks: [], bytes: 0 };
		}
		transmission.bytes += payload.length;
		if (transmission.bytes <= MAX_BYTES) transmission.chunks.push(payload);
		if (c.m === "1") return;
		const complete = transmission;
		transmission = null;
		if (complete.bytes > MAX_BYTES) return;
		usedKittyImages = true;
		const original = complete.controls;
		const upload = { ...original, a: "t", q: "2" };
		delete upload.m;
		// Re-chunk the cached upload so replay remains valid for Kitty's 4KiB limit.
		const data = complete.chunks.join("");
		const parts = [];
		for (let i = 0; i < data.length || i === 0; i += 4096) {
			const first = i === 0;
			const more = i + 4096 < data.length;
			parts.push(command(controlsString(first ? { ...upload, m: more ? "1" : "0" } : { m: more ? "1" : "0" }), data.slice(i, i + 4096)));
		}
		removeImage(original.i);
		images.set(original.i, {
			controls: original, sequence: parts.join(""), bytes: data.length,
			uploadControls: { ...upload, m: data.length > 4096 ? "1" : "0" },
			heightPx: sourceImageHeight(original, data),
		});
		let total = [...images.values()].reduce((n, image) => n + image.bytes, 0);
		while (images.size > MAX_IMAGES || total > MAX_BYTES) {
			const id = images.keys().next().value;
			total -= images.get(id).bytes;
			removeImage(id);
		}
		if ((original.a ?? "T") === "T") place(original);
	}

	// A live child redraw can clear hydration overflow/history. Notify the UI
	// at parser order so its old snapshot floor cannot disable real scrollback.
	const clearHandler = term.parser.registerCsiHandler({ final: "J" }, (params) => {
		if (params[0] === 3 && usedKittyImages) onClearScrollback();
		return false;
	});

	// xterm does not expose APC handlers. Replace each complete APC with a tiny
	// private OSC token. Its handler runs after ALL preceding cursor movements,
	// including movements earlier in the same async xterm.write call.
	const handler = term.parser.registerOscHandler(OSC, (token) => {
		if (token === "reset") { clearPlacements(); return true; }
		const sequence = pending.get(token);
		pending.delete(token);
		if (sequence) accept(sequence);
		return true;
	});
	return {
		transform(data, reset = false) {
			if (reset) carry = "";
			const input = carry + data;
			carry = "";
			let out = reset ? `\x1b]${OSC};reset\x07` : "";
			let from = 0;
			while (from < input.length) {
				const start = input.indexOf(PREFIX, from);
				if (start < 0) {
					const tail = input.slice(from);
					const suffix = tail.endsWith("\x1b_") ? 2 : tail.endsWith("\x1b") ? 1 : 0;
					carry = suffix ? tail.slice(-suffix) : "";
					out += suffix ? tail.slice(0, -suffix) : tail;
					break;
				}
				out += input.slice(from, start);
				const end = input.indexOf(ST, start + PREFIX.length);
				if (end < 0) {
					carry = input.slice(start);
					// Large unterminated APCs stay APCs in xterm, not visible payload text.
					if (carry.length > MAX_BYTES) { out += carry; carry = ""; }
					break;
				}
				const token = String(++nextToken);
				pending.set(token, input.slice(start, end + ST.length));
				out += `\x1b]${OSC};${token}\x07`;
				from = end + ST.length;
			}
			return out;
		},
		project(lines, start, height) {
			const out = [...lines];
			for (const [key, p] of placements) {
				if (p.marker?.isDisposed) { removePlacement(key); continue; }
				const row = (p.marker?.line ?? p.row) - start;
				const rows = Number(p.controls.r);
				const limit = Math.min(height, out.length);
				if (p.buffer !== term.buffer.active.type || row >= limit || row + rows <= 0) continue;
				const image = images.get(p.id);
				if (!image) continue;
				const targetRow = Math.max(0, row);
				const visibleRows = Math.min(row + rows, limit) - targetRow;
				const controls = { ...p.controls };
				if (visibleRows !== rows) {
					const sourceY = Number(controls.y ?? 0);
					const sourceHeight = Number(controls.h ?? (image.heightPx - sourceY));
					if (!(sourceHeight > 0)) continue; // Unknown geometry: retain the safe fallback.
					const hiddenRows = targetRow - row;
					const cropTop = Math.floor(sourceHeight * hiddenRows / rows);
					const cropEnd = Math.min(sourceHeight, Math.ceil(sourceHeight * (hiddenRows + visibleRows) / rows));
					controls.y = String(sourceY + cropTop);
					controls.h = String(cropEnd - cropTop);
					controls.r = String(visibleRows);
				}
				// Keep the FIRST APC's row count consistent with the actual placement:
				// Pi uses it to reserve/pre-clear rows before drawing a Kitty image.
				const uploadHeader = { ...image.uploadControls, c: controls.c, r: controls.r };
				const upload = `${PREFIX}${controlsString(uploadHeader)}${image.sequence.slice(image.sequence.indexOf(";"))}`;
				// The outer TUI supplies the screen row; only the column is adjusted.
				out[targetRow] = `\x1b7\x1b[${p.col + 1}G${upload}${command(controlsString(controls))}\x1b8${out[targetRow]}`;
			}
			return out;
		},
		clearPlacements,
		dispose() {
			handler.dispose();
			clearHandler.dispose();
			clearPlacements();
			images.clear();
			pending.clear();
			carry = "";
			transmission = null;
		},
	};
}
