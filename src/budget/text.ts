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

export const WARNING_PROMPT = `${WARNING_BODY}\nWhen the notes are ready, call \`clear_memory\` to reset now instead of being cut off mid-task.`;

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
