import { DEFAULT_REMINDER_MARGIN_TOKENS, WARNING_RUNWAY_TOKENS } from "./constants.js";
import { positiveInteger } from "./parse.js";
import { NOTESOUP_SETTINGS_KEY, type NotesoupSettings } from "../settings.js";

export type ResolvedThresholds = { reminder: number; reserve: number; warning: number };

/**
 * Pure derivation of the thresholds from Pi's reserve: the reminder fires at reserve
 * plus the notesoup margin, the warning steer at reserve plus WARNING_RUNWAY_TOKENS.
 * An invalid margin degrades to the default and reports one warning. Automatic
 * threshold/overflow handling is represented by reset lifecycle boundary drafts;
 * no compaction summary is generated.
 */
export function deriveThresholds(reserveTokens: number, margins: NotesoupSettings): { thresholds: ResolvedThresholds; warnings: string[] } {
	const warnings: string[] = [];
	const reminderKey = `${NOTESOUP_SETTINGS_KEY}.reminderMarginTokens`;
	let reminderMargin: number;
	if (margins.reminderMarginTokens === undefined) reminderMargin = DEFAULT_REMINDER_MARGIN_TOKENS;
	else {
		const parsed = positiveInteger(margins.reminderMarginTokens);
		if (parsed === undefined) {
			warnings.push(`🥣 ${reminderKey} must be a positive integer · using the default`);
			reminderMargin = DEFAULT_REMINDER_MARGIN_TOKENS;
		} else reminderMargin = parsed;
	}
	return { thresholds: { reminder: reserveTokens + reminderMargin, reserve: reserveTokens, warning: reserveTokens + WARNING_RUNWAY_TOKENS }, warnings };
}

/** Room before the hard-reserve wipe; unknown usage stays unknown. */
export function remainingBudget(remaining: number | null, reserve: number): number | null {
	return remaining === null ? null : Math.max(0, remaining - reserve);
}
