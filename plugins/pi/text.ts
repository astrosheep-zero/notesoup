import { COUNTDOWN_LINE, GUIDANCE_CLOSE_TAG, GUIDANCE_OPEN_TAG, WARNING_BODY, WARNING_CALL } from "../../src/budget/text.js";

/**
 * Pi-only closing hints. Pi's TUI drops the human's visible transcript when a window resets, and
 * the model, not the human, owns when that reset happens. A host whose reset leaves the human's
 * view intact must not carry these — the claim would be false there. The bare `empty_brain` token
 * is interpolated by renderProtocolBlock; the prose itself stays plain English.
 */
export const PI_PRE_RESET_HINTS = `Anything you say here is erased with the reset — the human can't read it afterward either. Put the handoff in your notes; explanations belong after the reset.
Unless the human explicitly directs otherwise, decide for yourself when to call empty_brain. Don't keep asking them whether to reset.`;

export { warningNotice as warningContent } from "../../src/budget/text.js";

/** Odometer breadcrumb: the marker names its own seq, so history paging reads the landscape directly. */
export function markerContent(seq: number): string {
	return `<notesoup:marker seq="${seq}" />`;
}

/** The closing model sees deferred input as a bare next-window prompt block. */
export function promptBlock(commandLine: string): string {
	return `<notesoup:next_window_prompt>\n${commandLine}\n</notesoup:next_window_prompt>`;
}

/** Approved manual close-out notices; both variants live here. */
export const COMMAND_NOTICE = {
	prompted: "The human ran /empty. Save your notes now and call `empty_brain` immediately. Anything you say here will be erased afterward — put the handoff in your notes. The prompt below, and anything the human sends from now on, should be handled after the reset.",
	bare: "The human ran /empty. Save your notes now and call `empty_brain` immediately. Anything you say here will be erased afterward — put the handoff in your notes. Anything the human sends from now on should be handled after the reset.",
};

/** Manual orders omit budget timing hints; deferred work sits outside the notice. */
export function commandWarningContent(commandLine?: string): string {
	const notice = commandLine ? COMMAND_NOTICE.prompted : COMMAND_NOTICE.bare;
	return `${GUIDANCE_OPEN_TAG}\n${notice}\n${WARNING_BODY}\n${WARNING_CALL}\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}${commandLine ? `\n${promptBlock(commandLine)}` : ""}`;
}
