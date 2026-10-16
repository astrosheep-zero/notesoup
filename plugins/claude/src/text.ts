import { warningNotice } from "../../../src/budget/text.js";

/** Claude's boot says history is missing rather than naming tools it cannot serve. */
export const CLAUDE_HISTORY_UNAVAILABLE_SENTENCE = "History isn't available in this Claude session: no main transcript_path was supplied. Keep essential state in notes; don't pretend those notes are the missing transcript.";

/** The same notice as Pi; empty_brain's result explains Claude's deferred reset. */
export const CLAUDE_WARNING_PROMPT = warningNotice();
