import { DEFAULT_REMINDER_MARGIN_TOKENS, WARNING_RUNWAY_TOKENS } from "./constants.js";
import { NOTESOUP_SETTINGS_KEY, type NotesoupSettings } from "../settings.js";

export type ResolvedThresholds = { reminder: number; reserve: number; warning: number };
/** A margin is usable only as a positive integer; anything else is ignored. */
function validMargin(raw: unknown): number | undefined {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) return undefined;
	return raw;
}

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
		const parsed = validMargin(margins.reminderMarginTokens);
		if (parsed === undefined) {
			warnings.push(`🥣 ${reminderKey} must be a positive integer · using the default`);
			reminderMargin = DEFAULT_REMINDER_MARGIN_TOKENS;
		} else reminderMargin = parsed;
	}
	return { thresholds: { reminder: reserveTokens + reminderMargin, reserve: reserveTokens, warning: reserveTokens + WARNING_RUNWAY_TOKENS }, warnings };
}

/** Countdown excludes the hidden warning runway; unknown usage stays unknown. */
export function remainingBudget(remaining: number | null, warning: number): number | null {
	return remaining === null ? null : Math.max(0, remaining - warning);
}
