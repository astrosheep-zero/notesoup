import { DEFAULT_REMINDER_MARGIN_TOKENS, WARNING_RUNWAY_TOKENS } from "./constants.js";
import { positiveInteger } from "./parse.js";
import { NOTESOUP_SETTINGS_KEY } from "../settings.js";

export type ResolvedThresholds = { reminder: number; reserve: number; warning: number };

/**
 * Derive notesoup thresholds from the host reserve and optional notesoup overrides.
 * Invalid settings fall back independently and report one warning per offending key.
 * No host compaction settings are changed and no compaction summary is generated.
 */
export function deriveThresholds(reserveTokens: number, settings: Record<string, unknown>): { thresholds: ResolvedThresholds; warnings: string[] } {
	const warnings: string[] = [];
	const resolve = (key: string, fallback: number): number => {
		if (settings[key] === undefined) return fallback;
		const parsed = positiveInteger(settings[key]);
		if (parsed !== undefined) return parsed;
		warnings.push(`🥣 ${NOTESOUP_SETTINGS_KEY}.${key} must be a positive integer · using the default`);
		return fallback;
	};
	const reserve = resolve("reserveTokens", reserveTokens);
	const reminderMargin = resolve("reminderMarginTokens", DEFAULT_REMINDER_MARGIN_TOKENS);
	const warningRunway = resolve("warningRunwayTokens", WARNING_RUNWAY_TOKENS);
	return { thresholds: { reminder: reserve + reminderMargin, reserve, warning: reserve + warningRunway }, warnings };
}

/** Room before the hard-reserve wipe; unknown usage stays unknown. */
export function remainingBudget(remaining: number | null, reserve: number): number | null {
	return remaining === null ? null : Math.max(0, remaining - reserve);
}
