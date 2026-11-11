import { NoteError } from "./errors.js";

export type NotePolicyFields = { pinned?: boolean; budget?: number; readonly?: boolean };
export type NotePolicy = Required<NotePolicyFields>;
export const DEFAULT_NOTE_BUDGET = 4096;
export const MAX_PINNED_NOTES = 5;
/** Defaults and ordering live here; no other layer assigns behavior by page name. */
const DEFAULT_PINNED_PAGES = ["CHEATSHEET.md", "MAP.md"] as const;

export function validateNotePolicy(fields: NotePolicyFields): void {
	for (const key of ["pinned", "readonly"] as const) {
		if (fields[key] !== undefined && typeof fields[key] !== "boolean") throw new NoteError("invalid_policy", `${key} must be a boolean.`);
	}
	if (fields.budget !== undefined && (!Number.isSafeInteger(fields.budget) || fields.budget <= 0)) {
		throw new NoteError("invalid_policy", "budget must be a positive safe integer of Unicode code points.");
	}
}

/** Only root default pages are pinned implicitly; an explicit false always wins. */
export function effectiveNotePolicy(fields: NotePolicyFields, path: string): NotePolicy {
	validateNotePolicy(fields);
	const defaultPage = DEFAULT_PINNED_PAGES.some(page => page === path);
	return {
		pinned: fields.pinned ?? defaultPage,
		budget: fields.budget ?? (defaultPage ? 2048 : DEFAULT_NOTE_BUDGET),
		readonly: fields.readonly ?? false,
	};
}

export function pinnedPageOrder(path: string): number {
	const index = DEFAULT_PINNED_PAGES.findIndex(page => page === path);
	return index === -1 ? DEFAULT_PINNED_PAGES.length : index;
}

export function noteBudgetWarnings(body: string, policy: NotePolicy): string[] {
	const count = Array.from(body).length;
	return count > policy.budget ? [`Warning: note body is ${count} Unicode code points, over budget ${policy.budget}; the full body is kept.`] : [];
}

export function assertNoteUnlocked(fields: NotePolicyFields, unlock?: boolean): void {
	if (fields.readonly === true && unlock !== false) throw new NoteError("readonly", "This note has a soft readonly lock; explicitly set readonly:false to unlock before changing it (or in the same call).");
}

/** Apply only explicit values, leaving absent on-disk defaults absent across moves. */
export function applyNotePolicy(target: NotePolicyFields, fields: NotePolicyFields): void {
	validateNotePolicy(fields);
	for (const key of ["pinned", "budget", "readonly"] as const) {
		if (fields[key] !== undefined) Object.assign(target, { [key]: fields[key] });
	}
}
