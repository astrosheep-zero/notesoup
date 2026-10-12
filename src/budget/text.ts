export const GUIDANCE_OPEN_TAG = "<context_window_guidance>";
export const GUIDANCE_CLOSE_TAG = "</context_window_guidance>";

/**
 * Codex-equivalent low-budget reminder. The measured remaining count is frozen into
 * the text at the crossing that fires it, so each persisted copy is a snapshot true
 * at write time; get_context_remaining remains the live source for the current figure.
 */
export function tokenBudgetGuidance(remaining: number, wipeTool: string): string {
	return `${GUIDANCE_OPEN_TAG}\nAbout ${remaining} tokens remain before this context window is cleared. Notes and history persist; anything not written down is lost.\nThis is a good point to start recording the current state in your notes. If you are ready, you can call \`${wipeTool}\` at any time.\n${GUIDANCE_CLOSE_TAG}`;
}
