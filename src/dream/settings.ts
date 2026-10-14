import { NOTESOUP_SETTINGS_KEY } from "../settings.js";

/** Nested under the "notesoup" settings key; the dream CLI is the only reader. */
const NOTESOUP_DREAMER_KEY = "dreamer";

export type DreamerSetting = { pattern?: string; warnings: string[] };

/**
 * `notesoup.dreamer` is a non-empty model pattern. Anything else present is ignored
 * with one warning; absent means no configured pattern, so the automatic model applies.
 */
export function deriveDreamer(settings: Record<string, unknown>): DreamerSetting {
	const raw = settings[NOTESOUP_DREAMER_KEY];
	if (raw === undefined) return { warnings: [] };
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return { warnings: [`notesoup: ${NOTESOUP_SETTINGS_KEY}.${NOTESOUP_DREAMER_KEY} must be a non-empty string; ignoring it.`] };
	}
	return { pattern: raw.trim(), warnings: [] };
}
