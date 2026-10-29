// Step31 measurement-only topology selector. Unset preserves every existing
// scenario default; "candidate" requests the real reporter/proof path and
// "baseline" requests the real legacy no-reporter path.
export function formalMeasurementVersion() {
	const value = process.env.FORMAL_MEASURE_VERSION;
	return value === "candidate" || value === "baseline" ? value : null;
}
