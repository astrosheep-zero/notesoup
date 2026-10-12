import { CLAUDE_WARNING_PROMPT, CONTINUATION, GUIDANCE_CLOSE_TAG, GUIDANCE_OPEN_TAG, WARNING_BODY, WARNING_PROMPT } from "../../budget/text.js";

/** Shared hidden checkpoint text for manual and budget-triggered requests. */
export const WARNING_CONTENT = `${GUIDANCE_OPEN_TAG}\n${WARNING_PROMPT}\n${GUIDANCE_CLOSE_TAG}`;

// The reset prose lives beside the guidance text in the host-neutral budget domain, so the
// Claude mod can show the same words without depending on any Pi module. Re-exported here
// for the Pi-side importers that already reach for this module.
export { CLAUDE_WARNING_PROMPT, CONTINUATION, WARNING_BODY, WARNING_PROMPT };
