export const NOTESOUP_SETTINGS_KEY = "notesoup";
/** Nested under "notesoup": the default dreamer model pattern, overridden by CLI --dreamer. */
export const NOTESOUP_DREAMER_KEY = "dreamer";

/**
 * The one notesoup settings shape both hosts read. `reminderMarginTokens` is Pi's early
 * reminder margin; `resetMarginTokens` and `warningRunwayTokens` are the Claude mod's
 * margins against Claude's own auto-compact point (see src/claude/thresholds.ts). A host
 * ignores the keys it does not use; every value is validated where it is consumed.
 */
export type NotesoupSettings = {
	reminderMarginTokens?: unknown;
	resetMarginTokens?: unknown;
	warningRunwayTokens?: unknown;
	dreamer?: unknown;
};

function isSettingsObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the raw "notesoup" object from one parsed settings scope. */
function notesoupSettings(settings: unknown): Record<string, unknown> {
	if (!isSettingsObject(settings)) return {};
	const value = settings[NOTESOUP_SETTINGS_KEY];
	return isSettingsObject(value) ? value : {};
}

/** Merge the global and project "notesoup" objects per key; project wins, mirroring Pi's deep merge. */
export function mergeNotesoupSettings(globalSettings: unknown, projectSettings: unknown): NotesoupSettings {
	const merged = { ...notesoupSettings(globalSettings), ...notesoupSettings(projectSettings) };
	return {
		reminderMarginTokens: merged.reminderMarginTokens,
		resetMarginTokens: merged.resetMarginTokens,
		warningRunwayTokens: merged.warningRunwayTokens,
		dreamer: merged.dreamer,
	};
}
