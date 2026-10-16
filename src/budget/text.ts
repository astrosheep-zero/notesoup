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
	"This brain is already spent. Whatever lives only in this brain goes with it — but the notes stay where they are, and history has the rest written down, though digging it back out is on you.\nUse the last of this brain to put down what the next window can't get back:\n- what you're in the middle of, and how far it has progressed\n- decisions the human has made, in their words\n- what is blocked or pending\n- the next step\n- where the unfinished work sits (branches, scratch directories, uncommitted changes)\n- what failed, and why\n- skills to re-read, and history seqs, notes, or files to consult\n- anything else you expect to be useful after the reset\n- and refresh the stale notes with what has changed since you last wrote them — the notes the next window gets are the old ones, unless you fix them now\nCorrect or crumple notes that are no longer accurate, starting with MAP files, since every new window loads them.";

export const WARNING_CALL = "The moment the notes are saved, call `empty_brain`. Not one more probe, not one more test — the next thing you do after saving is reset.";

export function warningPrompt(): string {
	return `${WARNING_BODY}\n${WARNING_CALL}`;
}

/**
 * The last line of the second-tier notice: it stops at 2 because the wipe lands at the end of the
 * turn, not on a timer. The first-tier guidance never carries it.
 */
export const COUNTDOWN_LINE = "Brain emptied in 3… 2…";

/**
 * Codex-equivalent low-budget reminder. The measured remaining count is frozen into
 * the text at the crossing that fires it, so each persisted copy is a snapshot true
 * at write time; get_context_remaining remains the live source for the current figure.
 */
export function tokenBudgetGuidance(remaining: number, wipeTool: string): string {
	return `${GUIDANCE_OPEN_TAG}\nAbout ${remaining} tokens of room left in your brain.\nYour notes don't go anywhere — no wipe reaches the shelves. History has it too, already written down, though digging it back out is on you.\nWhat lives only in this brain leaves with it.\nA decent moment to put down where you are, while you still remember why.\nReady when you are: \`${wipeTool}\`.\n${GUIDANCE_CLOSE_TAG}`;
}
