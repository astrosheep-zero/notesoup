import { COUNTDOWN_LINE, WARNING_BODY } from "../../../src/budget/text.js";

/** Claude has no model-facing reset tool: the model ends its turn and the human runs the command. */
export const CLAUDE_WIPE_SENTENCE = "If this feels like the right moment, end your turn and ask the human to run `/fresh-window`.";

/** Claude's boot says history is missing rather than naming tools it cannot serve. */
export const CLAUDE_HISTORY_UNAVAILABLE_SENTENCE = "History isn't available in this Claude session: no main transcript_path was supplied. Keep essential state in notes; don't pretend those notes are the missing transcript.";

/** Claude's variant: the mod resets after the turn, so the model only has to stop. */
export const CLAUDE_WARNING_PROMPT = `${WARNING_BODY}\nWhen the notes are ready, end your turn; the reset runs after it.\n${COUNTDOWN_LINE}`;
