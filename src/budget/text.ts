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

/** Budget timing stays out of manual close-outs, which may have plenty of room. */
export const WARNING_TIMING = "The reserve is nearly spent. The wipe lands at the end of whichever turn spends the last of it, possibly this one.";

/** The shared handoff instructions, used for both budget and manual close-outs. */
export const WARNING_BODY =
	"Stop the task. Write down what git and history can't give back:\n- where you are, and how far you got\n- what the human decided, in their words\n- what's blocked or waiting\n- the next move\n- where the half-done work sits\n- what failed, and why\n- which skills, seqs, notes, or files to reopen\n- anything else worth noting\nThen leave the shelf current: replace what's stale, a whole note or a section inside one, and crumple the dead ones. Update and trim CHEATSHEET.md and MAP.md; every new window loads them. The next window gets whatever you leave, dead notes and dead sections alike.\nDon't call anything that might return a large output. One big read can spend the rest of the reserve before your notes are saved.";

export const WARNING_CALL = "Then call `empty_brain`. Nothing in between.";

export function warningPrompt(): string {
	return `${WARNING_TIMING}\n${WARNING_BODY}\n${WARNING_CALL}`;
}

/** Pi and Claude deliver exactly the same second-tier notice. */
export function warningNotice(): string {
	return `${GUIDANCE_OPEN_TAG}\n${warningPrompt()}\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}`;
}

/**
 * The last line of the second-tier notice: it stops at 2 because the wipe lands at the end of the
 * turn, not on a timer. The first-tier guidance never carries it.
 */
export const COUNTDOWN_LINE = "Brain emptied in 3… 2…";

/**
 * First-tier low-budget reminder. The measured remaining count is frozen into
 * the text at the crossing that fires it, so each persisted copy is a snapshot true
 * at write time; get_context_remaining remains the live source for the current figure.
 */
export function tokenBudgetGuidance(remaining: number, wipeTool: string): string {
	return `${GUIDANCE_OPEN_TAG}\nAbout ${remaining} tokens of room left. When it runs out, this brain is wiped, and everything in it is obliterated.\nLuckily, your notes stay.\nSo while there's still room, go update them.\nIf the moment feels right, you can also call \`${wipeTool}\` yourself. But it also wipes what you say to the human right before emptying.\n${GUIDANCE_CLOSE_TAG}`;
}
