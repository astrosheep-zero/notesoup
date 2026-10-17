import { warningNotice } from "../../../src/budget/text.js";

/** Claude's boot says history is missing rather than naming tools it cannot serve. */
export const CLAUDE_HISTORY_UNAVAILABLE_SENTENCE = "History isn't available in this Claude session: no main transcript_path was supplied. Keep essential state in notes; don't pretend those notes are the missing transcript.";

/** The same notice as Pi; empty_brain's result explains Claude's deferred reset. */
export const CLAUDE_WARNING_PROMPT = warningNotice();

export const CLAUDE_HISTORY_UNKNOWN_WINDOW = "Claude history cannot determine the current window ordinal across a missing ancestor; restore the ancestry or use a retained notesoup boot to re-anchor it.";
export const CLAUDE_HISTORY_UNKNOWN_PREVIOUS = 'Cannot resolve "@previous": the immediately preceding window is not confirmed across the ancestry gap. Use an explicit window id from history_windows.';
export function claudeHistoryUnconfirmedSeq(seq: number): string {
	return `Seq ${seq} is outside the confirmed selected history; it may be on another branch or beyond an unresolved ancestry gap.`;
}

/** Bounded host-only evidence, outside event documents/search offsets and shared schemas. */
export function claudeHistoryGapNotice(missing: readonly string[]): string {
	if (missing.length === 0) return "";
	const evidence = missing.slice(0, 5).map((uuid) => JSON.stringify(uuid.length > 160 ? `${uuid.slice(0, 160)}…` : uuid)).join(", ");
	return `Claude history is incomplete: missing ancestor UUID(s): ${evidence}${missing.length > 5 ? `; ${missing.length - 5} more` : ""}. Only confirmed selected ancestry is returned; disconnected prefixes and unrelated branches are excluded. Window IDs containing :unknown: have unconfirmed ordinal/ownership and may span native compactions; they are listed separately after numbered windows, not placed in a chronological order. A later retained boot can re-anchor window numbering, but cannot fill the history gap.\n\n`;
}
