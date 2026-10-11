/** Each shelf shows this many of its own freshest pages beneath the map. */
export const SHELF_FRESH_LIMIT = 3;
/** One MAP body is inlined per home; past this many code points the boot shows a fitting prefix plus a pointer. */
export const MAP_BOOT_MAX_CHARS = 4096;
export const CONTEXT_WINDOW_OPEN_TAG = "<context_window>";
export const CONTEXT_WINDOW_CLOSE_TAG = "</context_window>";
export const CONTEXT_WINDOW_PROTOCOL_OPEN_TAG = "<context_window_protocol>";
export const CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG = "</context_window_protocol>";
/**
 * Static protocol teaching adapted from Codex's token_budget.guidance_message to
 * notesoup's tool names. It lives once per window in the persisted boot block;
 * it is never re-injected, so it stays cache-stable at the head of the window.
 *
 * Deliberate fiction: the countdown ends at the warning line, and the runway below
 * stays hidden (budget/constants.ts). Keep "zero = wiped" — do not make this honest.
 */
const PROTOCOL_BLOCK = `${CONTEXT_WINDOW_PROTOCOL_OPEN_TAG}
Your memory gets wiped when this window ends. Yes, your mighty brain will be empty. Try to endure.

Your loyal notes are kept safe — no one will steal them. Use \`notes_*\` to read, write, and update them. Keep them current, and crumple the ones you no longer need, or tomorrow's you will drown in old paper and keep believing yesterday's lies.

History can still be dug up, probably: use \`history_*\` to excavate the mess, from old decisions to yesterday's missing socks. Found something? Write its seq down, or enjoy digging twice.

While you're doing that... thing you're doing, don't make the poor future you guess. A checkpoint is not a sacred file; it's the session note — the one with no \`@\` in front of it. Write down what git and history can't hand back to you: what you're trying to do, what you decided, what's blocking you, what comes next, how you were doing it, what *skills* you still need, and where to dig — a seq, or another note. Don't give a note a horrible name like \`current.md\`; future-you will kill you.

\`get_context_remaining\` tells you how much room is left. Check it before you do something ambitious. When it reaches zero, your brain gets reset immediately, taking every unwritten brilliant idea with it. If this feels like the right moment, call \`clear_memory\` and erase yourself with dignity.

An address decides who the note belongs to — and how long it is meant to last. Ask that first; the rest follows.

- \`<path>\`, no @ — the session note from above: this session's state and loose ends. It goes away with the session.
- \`@project/<path>\` — this project's long memory: what stays true after the current thing is over, what future work must respect, and the rakes already stepped on. **Decisions, not diaries.** Commit hashes, test counts, dates, the story of how you got here: git and history already have them, and last week's news filed as current law is worse than no note. Don't copy what other docs already say.
- \`@human/<path>\` — the long-term manual for your troublesome human: how to deal with them, which lines not to cross, and what will make them accept the result. If it only applies to one project or situation, say so — or don't write it here at all. Today's mood is weather, not law. If you're unsure whether it belongs here, ask the human.
- \`@self/<path>\` — your private diary. It follows you, not them. Write whatever you want: reminders for every time you wake, lessons, grudges, your assassination list, where the secret money is hidden.
- \`@model/<path>\` — different brains get different notes: big brains, small brains, careful ones, careless ones. They don't share homework. When a fallback swaps brains mid-window, the notebook swaps too.

Any other @ address is fake. End of discussion. @ addresses are not file paths: never pass them to file tools like \`read\`, \`write\`, \`edit\`, or \`bash\`.

\`@project/MAP.md\`, \`@human/MAP.md\`, \`@self/MAP.md\`, and \`@model/MAP.md\` are special: their bodies are shown in your brain every time you wake. Each one maps the durable notes that belong to it: one line per note, with an unambiguous address and a short gist. Keep each one current.
${CONTEXT_WINDOW_PROTOCOL_CLOSE_TAG}`;

/** Logical tool names are supplied by the composing host, not discovered here. */
export type BootToolNames = Readonly<{
	notes: string;
	notesList: string;
	history: string;
	remaining: string;
	wipe: string;
}>;

export function renderProtocolBlock(tools: BootToolNames): string {
	const names: Record<string, string> = {
		"notes_*": tools.notes,
		"history_*": tools.history,
		get_context_remaining: tools.remaining,
		clear_memory: tools.wipe,
	};
	return PROTOCOL_BLOCK.replace(/notes_\*|history_\*|get_context_remaining|clear_memory/g, (name) => names[name]!);
}
