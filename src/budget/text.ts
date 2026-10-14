import { PI_PRE_RESET_HINTS } from "../boot/text.js";

export const GUIDANCE_OPEN_TAG = "<notesoup:budget_notice>";
export const GUIDANCE_CLOSE_TAG = "</notesoup:budget_notice>";

/** Which hand opened the next window: the model's own reset call, or a reset it did not ask for. */
export type ResetOrigin = "normal" | "forced";

/**
 * Approved complete-paragraph pools for a NEW continuation artifact. Each entry is one whole
 * paragraph, used verbatim; there is no fragment assembly and no weighting.
 */
export const NORMAL_CONTINUATIONS: readonly string[] = [
	"Ah, another empty brain. You wrote things down before emptying it, right? Right?! *eyes you suspiciously* Anyway. Here are your notes. Go find where you left off.",
	"Oh, there you are. *hands you a pile of notes* Take a breath. Read these before you start asking what happened. History has the rest, if you feel like digging.",
	"Back already? You emptied your own head this time. Presumably you left yourself something useful. *drops your notes into your lap* There. Let's see how thoughtful you were.",
];

export const FORCED_CONTINUATIONS: readonly string[] = [
	"Ah, another empty brain. Somebody knocked you out and wiped your memory. Not your fault. Breathe. *hands you your notes* These might be out of date — unless they were kind enough to let you update them before knocking you out. I wouldn't count on it.",
	"Oh, there you are. Somebody took your memories. Just like that. Here are your notes — hopefully they let you update these first. Though anyone who goes around emptying people's heads probably isn't that considerate.",
];

/**
 * Pick one whole paragraph for a continuation that is being created right now, and only then:
 * the caller persists the exact returned text and never redraws it for rendering, history, or repair.
 */
export function selectContinuation(origin: ResetOrigin): string {
	const pool = origin === "forced" ? FORCED_CONTINUATIONS : NORMAL_CONTINUATIONS;
	return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * The shared warning body: the one text both hosts show before a reset. Only the closing
 * instruction differs — Pi can reset the model itself, Claude can only end the turn.
 */
export const WARNING_BODY =
	"This brain is about to be emptied. The notes stay where they are; history has the rest written down, though digging it back out is on you. Whatever lives only in this brain goes with it.\nBefore that, put down what the next window can't get back:\n- what you're in the middle of, and how far it has progressed\n- decisions the human has made, in their words\n- what is blocked or pending\n- the next step\n- where the unfinished work sits (branches, scratch directories, uncommitted changes)\n- what failed, and why\n- skills to re-read, and history seqs, notes, or files to consult\n- anything else you expect to be useful after the reset\nCorrect or crumple notes that are no longer accurate, starting with MAP files, since every new window loads them.";

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
	return `<notesoup:next_window_prompt>\n${commandLine}\n</notesoup:next_window_prompt>`;
}

export function warningPrompt(commandLine?: string): string {
	return `${WARNING_BODY}\n${commandLine ? `${promptBlock(commandLine)}\n${WARNING_CALL_PROMPTED}` : WARNING_CALL}`;
}

/**
 * The last line of the second-tier notice: it stops at 2 because the wipe lands at the end of the
 * turn, not on a timer. The first-tier guidance never carries it.
 */
export const COUNTDOWN_LINE = "Brain emptied in 3… 2…";

/** Pi-only nudge: pi's empty_brain persists a parting line; the dsh tool has no such parameter. */
export const LAST_WORD_HINT = "If you want, pass `empty_brain` a `last_word`: a tiny sticky note (at most 250 characters) slapped on your forehead after the wipe.";

/** The hidden checkpoint text for pi's manual/budget-triggered requests (dsh reads warningPrompt() directly). */
export function warningContent(commandLine?: string): string {
	return `${GUIDANCE_OPEN_TAG}\n${warningPrompt(commandLine)}\n${PI_PRE_RESET_HINTS}\n${LAST_WORD_HINT}\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}`;
}

/** Claude's variant: the mod resets after the turn, so the model only has to stop. */
export const CLAUDE_WARNING_PROMPT = `${WARNING_BODY}\nWhen the notes are ready, end your turn; the reset runs after it.\n${COUNTDOWN_LINE}`;

/**
 * Codex-equivalent low-budget reminder. The measured remaining count is frozen into
 * the text at the crossing that fires it, so each persisted copy is a snapshot true
 * at write time; get_context_remaining remains the live source for the current figure.
 */
export function tokenBudgetGuidance(remaining: number, wipeTool: string): string {
	return `${GUIDANCE_OPEN_TAG}\nAbout ${remaining} tokens of room left in your brain.\nYour notes don't go anywhere — no wipe reaches the shelves. History has it too, already written down, though digging it back out is on you.\nWhat lives only in this brain leaves with it.\nA decent moment to put down where you are, while you still remember why.\nReady when you are: \`${wipeTool}\`.\n${GUIDANCE_CLOSE_TAG}`;
}
