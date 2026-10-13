export const GUIDANCE_OPEN_TAG = "<context_window_guidance>";
export const GUIDANCE_CLOSE_TAG = "</context_window_guidance>";

/**
 * The single reset message: the only reset prose persisted, carried by the continuation entry.
 */
export const CONTINUATION = "WIPED! Your whole brain, poof! Who? No idea! Definitely not me!\n*dumps notes and history on your hands*\nThere. Delivered. Your problem now~ *runs*";

/**
 * The shared warning body: the one text both hosts show before a reset. Only the closing
 * instruction differs — Pi can reset the model itself, Claude can only end the turn.
 */
export const WARNING_BODY =
	"This context window will be cleared soon. Notes and history persist; anything else is lost.\nConsider whether to record in your notes:\n- what you are working on, and how far it has progressed\n- decisions the human has made, in their words\n- what is blocked or pending\n- the next step\n- where unfinished work is located (branches, scratch directories, uncommitted changes)\n- approaches that failed, and why\n- skills to re-read, and history seqs, notes, or files to consult\n- anything else you expect to be useful after the reset\nCorrect or crumple notes that are no longer accurate, starting with MAP files, since every new window loads them.";

export const WARNING_CALL = "When the notes are ready, call `empty_brain` to reset now instead of being cut off mid-task.";

/**
 * With a prompt attached the close-out is an order rather than a nudge: the human already
 * said when to reset, and a task line for the next window just preceded it.
 */
export const WARNING_CALL_PROMPTED = "Organize the notes first, then call `empty_brain` right away — do not wait to be cut off.";

/**
 * The human typed `/empty-brain <prompt>`: the raw command line leads the close-out so the
 * closing model sees what the next window was asked to do, verbatim. The tag names it as the
 * next window's prompt, so no prose has to explain that.
 */
function promptBlock(commandLine: string): string {
	return `<next_window_prompt>\n${commandLine}\n</next_window_prompt>`;
}

export function warningPrompt(commandLine?: string): string {
	return `${WARNING_BODY}\n${commandLine ? `${promptBlock(commandLine)}\n${WARNING_CALL_PROMPTED}` : WARNING_CALL}`;
}

/** Pi-only nudge: pi's empty_brain persists a parting line; the dsh tool has no such parameter. */
export const LAST_WORD_HINT = "If you want, pass `empty_brain` a `last_word`: a tiny sticky note (at most 250 characters) slapped on your forehead after the wipe.";

/** The hidden checkpoint text for pi's manual/budget-triggered requests (dsh reads warningPrompt() directly). */
export function warningContent(commandLine?: string): string {
	return `${GUIDANCE_OPEN_TAG}\n${warningPrompt(commandLine)}\n${LAST_WORD_HINT}\n${GUIDANCE_CLOSE_TAG}`;
}

/** Claude's variant: the mod resets after the turn, so the model only has to stop. */
export const CLAUDE_WARNING_PROMPT = `${WARNING_BODY}\nWhen the notes are ready, end your turn; the reset runs after it.`;

/**
 * Codex-equivalent low-budget reminder. The measured remaining count is frozen into
 * the text at the crossing that fires it, so each persisted copy is a snapshot true
 * at write time; get_context_remaining remains the live source for the current figure.
 */
export function tokenBudgetGuidance(remaining: number, wipeTool: string): string {
	return `${GUIDANCE_OPEN_TAG}\nAbout ${remaining} tokens remain before this context window is cleared. Notes and history persist; anything not written down is lost.\nThis is a good point to start recording the current state in your notes. If you are ready, you can call \`${wipeTool}\` at any time.\n${GUIDANCE_CLOSE_TAG}`;
}
