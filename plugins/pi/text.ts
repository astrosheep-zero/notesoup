import { COUNTDOWN_LINE, GUIDANCE_CLOSE_TAG, GUIDANCE_OPEN_TAG, WARNING_BODY, WARNING_CALL } from "../../src/budget/text.js";

/**
 * Pi-only closing hints. Pi's TUI drops the human's visible transcript when a window resets, and
 * the model, not the human, owns when that reset happens. A host whose reset leaves the human's
 * view intact must not carry these — the claim would be false there. The bare `empty_brain` token
 * is interpolated by renderProtocolBlock; the prose itself stays plain English.
 */
export const PI_PRE_RESET_HINTS = `Resetting clears the human's chat view too. Don't put a long explanation right before a reset and assume they'll still be able to read it. Save the handoff in notes; give the explanation after the reset.
Unless the human explicitly directs otherwise, decide for yourself when to call empty_brain. Don't keep asking them whether to reset.`;

/** Pi-only nudge: pi's empty_brain persists a parting line; the dsh tool has no such parameter. */
export const LAST_WORD_HINT = "If you want, pass `empty_brain` a `last_word`: a tiny sticky note (at most 250 characters) slapped on your forehead after the wipe.";

/**
 * With a prompt attached the close-out is an order rather than a nudge: the human already
 * said when to reset, and a task line for the next window just preceded it. Only Pi has a
 * reset command that takes a prompt, so this lives with the Pi text.
 */
export const WARNING_CALL_PROMPTED = "Organize the notes first, then call `empty_brain` right away — do not wait to be cut off.";

/**
 * The human typed `/empty <prompt>`: the raw command line leads the close-out so the
 * closing model sees what the next window was asked to do, verbatim. The tag names it as the
 * next window's prompt, so no prose has to explain that.
 */
export function promptBlock(commandLine: string): string {
	return `<notesoup:next_window_prompt>\n${commandLine}\n</notesoup:next_window_prompt>`;
}

/** The hidden checkpoint text for Pi's manual/budget-triggered requests (dsh reads warningPrompt() directly). */
export function warningContent(commandLine?: string): string {
	const closeOut = commandLine ? `${promptBlock(commandLine)}\n${WARNING_CALL_PROMPTED}` : WARNING_CALL;
	return `${GUIDANCE_OPEN_TAG}\n${WARNING_BODY}\n${closeOut}\n${PI_PRE_RESET_HINTS}\n${LAST_WORD_HINT}\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}`;
}
