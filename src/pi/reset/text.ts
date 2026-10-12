import { GUIDANCE_OPEN_TAG, GUIDANCE_CLOSE_TAG } from "../../budget/text.js";

/** The single reset message: the only reset prose persisted, carried by the continuation entry. */
export const CONTINUATION = "WIPED! Your whole brain, poof! Who? No idea! Definitely not me!\n*dumps notes and history on your hands*\nThere. Delivered. Your problem now~ *runs*";

export const WARNING_PROMPT =
	"This context window will be cleared soon. Notes and history persist; anything else is lost.\nConsider whether to record in your notes:\n- what you are working on, and how far it has progressed\n- decisions the human has made, in their words\n- what is blocked or pending\n- the next step\n- where unfinished work is located (branches, scratch directories, uncommitted changes)\n- approaches that failed, and why\n- skills to re-read, and history seqs, notes, or files to consult\n- anything else you expect to be useful after the reset\nCorrect or crumple notes that are no longer accurate, starting with MAP files, since every new window loads them.\nWhen the notes are ready, call `clear_memory` to reset now instead of being cut off mid-task.";

/** Shared hidden checkpoint text for manual and budget-triggered requests. */
export const WARNING_CONTENT = `${GUIDANCE_OPEN_TAG}\n${WARNING_PROMPT}\n${GUIDANCE_CLOSE_TAG}`;
