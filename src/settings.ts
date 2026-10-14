/** The one settings key every host reads its own fields from. */
export const NOTESOUP_SETTINGS_KEY = "notesoup";

/** A plain settings object; arrays and null are not one. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the raw "notesoup" object from one parsed settings scope. */
function notesoupSettings(settings: unknown): Record<string, unknown> {
	if (!isPlainObject(settings)) return {};
	const value = settings[NOTESOUP_SETTINGS_KEY];
	return isPlainObject(value) ? value : {};
}

/**
 * Merge the global and project "notesoup" objects per key; project wins, mirroring Pi's deep
 * merge. The record is exactly what the scopes contain: this core module owns the key and the
 * merge, while each host names, reads and validates the fields it consumes.
 */
export function mergeNotesoupSettings(globalSettings: unknown, projectSettings: unknown): Record<string, unknown> {
	return { ...notesoupSettings(globalSettings), ...notesoupSettings(projectSettings) };
}
