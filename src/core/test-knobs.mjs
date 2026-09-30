/**
 * Test-only wall-clock knob readers (issue #95 F4). Ladder constants gain a
 * dynamic reader so tests can compress production grace periods instead of
 * waiting them out. Unset ⇒ default (production byte-identical). Invalid ⇒
 * default plus a one-shot stderr warning (no diagnostics root at this layer).
 */
const warned = new Set();

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} defaultMs
 * @returns {number}
 */
export function resolveTestMs(env, name, defaultMs) {
	const raw = env[name];
	if (raw == null || raw === "") return defaultMs;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		if (!warned.has(name)) {
			warned.add(name);
			process.stderr.write(`test-knobs: ignoring invalid ${name}=${JSON.stringify(raw)}; using default ${defaultMs}ms\n`);
		}
		return defaultMs;
	}
	return value;
}
