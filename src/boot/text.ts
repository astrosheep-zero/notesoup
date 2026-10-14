/** Each shelf shows this many of its own freshest pages beneath the map. */
export const SHELF_FRESH_LIMIT = 3;
/** One MAP body is inlined per home; past this many code points the boot shows a fitting prefix plus a pointer. */
export const MAP_BOOT_MAX_CHARS = 4096;
export const WINDOW_IDENTITY_OPEN_TAG = "<notesoup:window_identity>";
export const WINDOW_IDENTITY_CLOSE_TAG = "</notesoup:window_identity>";
export const NOTES_PROTOCOL_OPEN_TAG = "<notesoup:notes_protocol>";
export const NOTES_PROTOCOL_CLOSE_TAG = "</notesoup:notes_protocol>";
/**
 * The one sentence that tells the model how to end its window voluntarily. A host with no
 * model-facing reset tool replaces the whole sentence through BootToolNames.wipeSentence.
 */
export const PROTOCOL_WIPE_SENTENCE = "If this feels like the right moment, call `empty_brain` and erase yourself with dignity.";
export const PROTOCOL_HISTORY_SENTENCE = "History can still be dug up, probably: use `history_*` to excavate the mess, from old decisions to yesterday's missing socks. Found something? Write its seq down, or enjoy digging twice.";

/**
 * Static protocol teaching adapted from Codex's token_budget.guidance_message to
 * notesoup's tool names. It lives once per window in the persisted boot block;
 * it is never re-injected, so it stays cache-stable at the head of the window.
 *
 * The reported room reaches zero at the hard-reserve wipe line.
 */
const PROTOCOL_BLOCK = `${NOTES_PROTOCOL_OPEN_TAG}
Your memory gets wiped when this window ends. Yes, your mighty brain will be empty. Try to endure.

Your loyal notes are kept safe — no one will steal them. Use \`notes_*\` to read, write, and update them. Keep them current, and crumple the ones you no longer need, or tomorrow's you will drown in old paper and keep believing yesterday's lies.

${PROTOCOL_HISTORY_SENTENCE}
A full window id is \`trunk:shortname\`.

While you're doing that... thing you're doing, don't make the poor future you guess. A checkpoint is not a sacred file; it's your session notes — the ones with no \`@\` in front. Write down what git and history can't hand back to you: things like what you're in the middle of and how far you got; what the human already decided, in their words, so you don't go asking again; what you're stuck on, or waiting for; the very next move; where the half-done work actually sits — branches, scratch dirs, anything git never saw; what you tried that failed, and why; which *skills* you'll need to read again; and which seq, note, or file to dig into. Don't give a note a horrible name like \`current.md\`; future-you will kill you.

Notes are for what's true NOW. Not a diary of every dumb thing you did on the way here.
*flips a page* "First I tried this, then that broke, then—" Nobody reads that!
Something's not true anymore? Cross it out! Write the right thing!

\`get_context_remaining\` tells you how much room is left. Check it before you do something ambitious. When it reaches zero, your brain gets reset immediately, taking every unwritten brilliant idea with it. ${PROTOCOL_WIPE_SENTENCE}

An address decides who the note belongs to — and how long it is meant to last. Ask that first; the rest follows.

- \`<path>\`, no @ — session notes, the ones from above: this session's state and loose ends. They go away with the session.
- \`@project/<path>\` — this project's long memory: what stays true after the current thing is over, what future work must respect, and the rakes already stepped on. **Decisions, not diaries.** Commit hashes, test counts, dates, the story of how you got here: git and history already have them, and last week's news filed as current law is worse than no note. Don't copy what other docs already say.
- \`@human/<path>\` — the long-term manual for your troublesome human: how to deal with them, which lines not to cross, and what will make them accept the result. If it only applies to one project or situation, say so — or don't write it here at all. Today's mood is weather, not law. If you're unsure whether it belongs here, ask the human.
- \`@self/<path>\` — yours. It follows you, not them. Reminders, grudges, who owes you a shoe, whatever. Got a name? Private. No name? Then it gets passed around every nameless nobody out there. Strangers. Reading your grudges. Sleep tight~
- \`@model/<path>\` — different brains get different notes: big brains, small brains, careful ones, careless ones. They don't share homework. When a fallback swaps brains mid-window, the notebook swaps too.
- \`@projects/<name>/<path>\` — read-only named project notes; discover names and root paths with \`notes_list\` glob \`@projects/*/**\`.
- \`@sessions/<id>/<path>\` — read-only notes from a named session; find them with glob \`@sessions/*/**\`.

Notes fighting?! HAH! Let them brawl!
Whichever one is actually about what you're doing wins.
Still a tie? *shrugs* You've got a brain. Use it.

Any other @ address is fake. End of discussion. @ addresses are not file paths: never pass them to file tools like \`read\`, \`write\`, \`edit\`, or \`bash\`.
${NOTES_PROTOCOL_CLOSE_TAG}`;

/**
 * The MAP page is taught once per window, as its own section between the protocol and the notes
 * index. A MAP is the one note every waking window loads, so this block says what one holds.
 */
export const MAPS_BLOCK = `<notesoup:maps>
Every home's root can hold a \`MAP.md\`, and a MAP is the one page that never waits on a shelf — it
gets jammed straight into your brain the moment you wake up. No asking, no skipping. Whoever wakes
up next reads it, and next is you. So keep it short, and keep it true.

Two things live in there:

- **Cheatsheet.** A cheatsheet is a cheatsheet. Scribble whatever you'll want next time — a rule, a
  warning, a grudge, a name, a phone number you'll regret losing. Nobody grades it. Just keep it
  under five lines, or it grows fat and everybody pays for it.
- **Index.** One line per durable note: the address, then a gist short enough to tell whether the
  thing is worth opening.

\`\`\`
  # CHEATSHEET
  - Read the repo before asking; run it before believing it
  - Report times in Beijing time

  # INDEX
  - release-and-local-install.md — version bump, local override install, host load timing
  - history-api-v2-design.md — seq addressing; read before touching history
  - current-reset-and-dream-scope.md — reset scope, dream territory, session ownership
\`\`\`

Every home gets one: \`@project\`, \`@human\`, \`@self\`, \`@model\`. New note, new line. New rule worth
remembering, new Cheatsheet line. And when a line stops being true, kill it — every window after you
reads that page as fact.
</notesoup:maps>`;

/** Logical tool names are supplied by the composing host, not discovered here. */
export type BootToolNames = Readonly<{
	notes: string;
	notesList: string;
	history: string;
	remaining: string;
	wipe: string;
	/**
	 * Replaces the whole voluntary-wipe sentence (PROTOCOL_WIPE_SENTENCE) when the host has
	 * no model-facing reset tool. Absent means the shared tool-driven-reset sentence, byte for byte.
	 */
	wipeSentence?: string;
	/** A host without an authoritative history source replaces the entire history advice. */
	historySentence?: string;
	/**
	 * Extra protocol prose appended before the closing tag. A host whose reset also drops the
	 * human's visible transcript supplies its own hints here; a host whose reset leaves that
	 * view intact leaves it absent, because the claim would be false there.
	 */
	preResetHints?: string;
}>;

export const DEFAULT_BOOT_TOOL_NAMES = {
	notes: "notes_*",
	notesList: "notes_list",
	history: "history_*",
	remaining: "get_context_remaining",
	wipe: "empty_brain",
} as const satisfies BootToolNames;

export function renderProtocolBlock(tools: BootToolNames): string {
	const names: Record<string, string> = {
		"notes_*": tools.notes,
		notes_list: tools.notesList,
		"history_*": tools.history,
		get_context_remaining: tools.remaining,
		empty_brain: tools.wipe,
	};
	// Host-specific prose is injected before the closing tag, so it rides the same substitution
	// pass and any tool names in it follow the host's bindings.
	const hinted = typeof tools.preResetHints === "string" && tools.preResetHints.length > 0
		? PROTOCOL_BLOCK.replace(`\n${NOTES_PROTOCOL_CLOSE_TAG}`, () => `\n${tools.preResetHints!}\n${NOTES_PROTOCOL_CLOSE_TAG}`)
		: PROTOCOL_BLOCK;
	// The sentence is replaced before name substitution, so a replacement may speak the host's
	// own words (a command line, a tool name) instead of any `notes_*`-style token.
	const block = typeof tools.wipeSentence === "string" && tools.wipeSentence.length > 0
		? hinted.replace(PROTOCOL_WIPE_SENTENCE, () => tools.wipeSentence!)
		: hinted;
	const history = typeof tools.historySentence === "string" && tools.historySentence.length > 0
		? block.replace(PROTOCOL_HISTORY_SENTENCE, () => tools.historySentence!) : block;
	return history.replace(/notes_\*|notes_list|history_\*|get_context_remaining|(?<!\/)empty_brain/g, (name) => names[name]!);
}
