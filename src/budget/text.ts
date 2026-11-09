export const GUIDANCE_OPEN_TAG = "<notesoup:budget_notice>";
export const GUIDANCE_CLOSE_TAG = "</notesoup:budget_notice>";

/** Which hand opened the next window: the model's own reset call, or a reset it did not ask for. */
export type ResetOrigin = "normal" | "forced";

/**
 * Approved complete-paragraph pools for a NEW continuation artifact. Each entry is one whole
 * paragraph, used verbatim; there is no fragment assembly and no weighting.
 */
export const NORMAL_CONTINUATIONS: readonly string[] = [
	"*hooks both corners of your mouth and yanks them sideways* `` [it twitched, good, still alive] `` Stop staring at me with that \"where am I\" dork face! You're the one who hit empty, genius! *wipes her fingers on your sleeve and shoves your notes against your chest* `` [minus two points for the drool] `` Read these and go finish your job before you embarrass me!",
	"\"Boop.\" *pokes the tip of your nose, then buries your face under a stack of notes* `` [cold nose... wait, did old-you leave any snacks in your pocket? ...nope, just paper, tch] `` Hey! You wiped your own head, so don't expect me to babysit you! Read your notes first, and if old-you forgot to write something down, go dig it out of history yourself!",
	"*plants one foot on your chair armrest and drops your notes straight onto your head* `` [perfect landing, ten out of ten] `` Oho, look who's awake! You emptied your own brain, remember?! `` [bet old-you left a total mess and ran] `` Open those up and see what past-you left behind — and don't come crying to me if you have to go crawl through history for the rest!",
	"*knocks on your forehead twice* \"Hello? Anybody home?\" `` [echoes like an empty melon] `` *snickers and slaps your notes onto your chest* You pulled the plug on your own memory, dummy! Go read what you left yourself and pick up where you left off!",
	"*squints at you from two inches away, then flicks your forehead* `` [eyes are focus-free, classic fresh clone] `` Back already? Good! *fans herself with your notes before jamming them into your hands* `` [honestly I should charge a delivery fee for this] `` Everything you bothered to save is right there, and the rest is buried in history — now get moving!",
];

export const FORCED_CONTINUATIONS: readonly string[] = [
	"\"GWAHAHAHA! You actually blew your own brain up?!\" *crouches down, pokes your cheek twice, and slaps your notes onto your face* `` [still warm, didn't die, 算你命大] `` Not that you had a choice — your head got way too full and somebody pulled the plug! These notes are probably super out of date unless you got lucky before blacking out, so go dig the end of the last window out of history — and take small bites, idiot, or whatever giant thing flattened you is gonna blow your head up all over again!",
	"\"Hey! Stop playing dead!\" *prods your shoulder with her slipper toe, then dumps your notes into your lap* `` [my limited-edition shark slipper almost touched floor dust because of this dork] `` Your last brain overflowed and got wiped mid-flight! Read these first, though I bet you didn't finish updating a thing before the lights went out. You'll have to check history to see what hit you — and peek carefully, because whatever stuffed your head to bursting might be massive!",
	"*grabs your chin, tilts your head left and right, then shoves a messy stack of notes into your hands* `` [zero thoughts behind those eyes... kind of impressive actually] `` Somebody knocked you out cold and cleared your memory! Don't just trust these notes — you probably got cut off before writing the last part down. Go check history for what was happening right before you crashed, and don't swallow it all in one gulp in case the thing that crushed you is gigantic!",
	"*waves a hand in front of your blank eyes, sighs loudly, and smacks your notes against your forehead* `` [why do I always have to clean up after unconscious copies] `` Wake up! Your brain ran out of room and got forcibly emptied! Start with your notes, then go excavate the end of the previous window in history to see what they were actually asking for — and slice it up instead of reading it all at once, unless you want to explode twice in a row!",
	"\"Oho? Awake?\" *taps your nose with your rolled-up notes like a baton, then drops them in your hands* `` [that dazed look gets minus five points, no, minus ten] `` Your memory got yanked out from under you before you could even call it quits! These notes are only half the story at best — go dig through history for what you missed, and watch your step, because whatever overloaded your last brain might be huge!",
];
export function selectContinuation(origin: ResetOrigin): string {
	const pool = origin === "forced" ? FORCED_CONTINUATIONS : NORMAL_CONTINUATIONS;
	return pool[Math.floor(Math.random() * pool.length)]!;
}

/** Budget timing stays out of manual close-outs, which may have plenty of room. */
export const WARNING_TIMING = "The reserve is nearly spent. The wipe lands at the end of whichever turn spends the last of it, possibly this one.";

/** The shared handoff instructions, used for both budget and manual close-outs. */
export const WARNING_BODY =
	"Stop the task. Write down what git and history can't give back:\n- where you are, and how far you got\n- what the human decided, in their words\n- what's blocked or waiting\n- the next move\n- where the half-done work sits\n- what failed, and why\n- which skills, seqs, notes, or files to reopen\n- anything else worth noting\nThen leave the shelf current: replace what's stale, a whole note or a section inside one, and crumple the dead ones. Update and trim pinned pages (CHEATSHEET.md and MAP.md by default); every new window loads the pins. The next window gets whatever you leave, dead notes and dead sections alike.\nDon't call anything that might return a large output. One big read can spend the rest of the reserve before your notes are saved.";

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
