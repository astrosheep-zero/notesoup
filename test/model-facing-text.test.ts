import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderBootBlock } from "../src/boot/render.js";
import { loadNotesSnapshot } from "../src/boot/snapshot.js";
import { DEFAULT_BOOT_TOOL_NAMES, MAPS_BLOCK, NOTES_PROTOCOL_CLOSE_TAG, NOTES_PROTOCOL_OPEN_TAG, WINDOW_IDENTITY_CLOSE_TAG, WINDOW_IDENTITY_OPEN_TAG } from "../src/boot/text.js";
import { CLAUDE_WARNING_PROMPT, COUNTDOWN_LINE, GUIDANCE_CLOSE_TAG, GUIDANCE_OPEN_TAG, LAST_WORD_HINT, WARNING_BODY, tokenBudgetGuidance, warningContent } from "../src/budget/text.js";
import type { NoteRow, Scope } from "../src/notes/index.js";

/**
 * The reviewed Design text is what the model actually reads, so the golden copies below pin it
 * character for character: an edit that drifts the wording has to change them too.
 */
const GOLDEN_GUIDANCE = `About {remaining} tokens left. Then this brain is emptied.
Your notes don't go anywhere — no wipe reaches the shelves. History has it too, already written down, though digging it back out is on you.
What lives only in this brain leaves with it.
A decent moment to put down where you are, while you still remember why.
Ready when you are: \`{wipeTool}\`.`;

const GOLDEN_WARNING = `This brain is about to be emptied. The notes stay where they are; history has the rest written down, though digging it back out is on you. Whatever lives only in this brain goes with it.
Before that, put down what the next window can't get back:
- what you're in the middle of, and how far it has progressed
- decisions the human has made, in their words
- what is blocked or pending
- the next step
- where the unfinished work sits (branches, scratch directories, uncommitted changes)
- what failed, and why
- skills to re-read, and history seqs, notes, or files to consult
- anything else you expect to be useful after the reset
Correct or crumple notes that are no longer accurate, starting with MAP files, since every new window loads them.`;

const GOLDEN_COUNTDOWN = "Brain emptied in 3… 2…";

const GOLDEN_MAPS = `<notesoup:maps>
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

const openedAt = 1_700_000_000_000;
const identity = { home: join(tmpdir(), "notesoup-model-facing-notes"), sessionId: "model-facing", projectKey: "model-facing", agent: "root", model: "default" };

function note(scope: Scope, path: string, address: string, body: string): NoteRow {
	return {
		address,
		scope,
		path,
		body,
		sizeBytes: Buffer.byteLength(body, "utf8"),
		meta: { scope, origin: "self", createdAt: openedAt, updatedAt: openedAt, lastAccessed: openedAt, accessCount: 0 },
	};
}

/** Render one boot with only the named homes carrying rows. */
async function boot(agentName: string, rows: ReadonlyMap<Scope, NoteRow[]>): Promise<string> {
	const notes = await loadNotesSnapshot({ ...identity, agent: agentName }, openedAt, (scope) => rows.get(scope) ?? []);
	return renderBootBlock({
		agentName,
		modelName: "default",
		tree: { trunk: "pcw:test", windows: [{ shortName: "root", isCurrent: false }, { shortName: "next", isCurrent: true }] },
		notes,
		tools: DEFAULT_BOOT_TOOL_NAMES,
	});
}

test("the notices and the MAP block keep the reviewed copy", () => {
	assert.equal(WARNING_BODY, GOLDEN_WARNING);
	assert.equal(COUNTDOWN_LINE, GOLDEN_COUNTDOWN);
	assert.equal(MAPS_BLOCK, GOLDEN_MAPS);
	assert.equal(
		tokenBudgetGuidance(1234, "empty_brain"),
		`${GUIDANCE_OPEN_TAG}\n${GOLDEN_GUIDANCE.replace("{remaining}", "1234").replace("{wipeTool}", "empty_brain")}\n${GUIDANCE_CLOSE_TAG}`,
	);
});

test("the countdown closes the second-tier notice only, in both hosts", () => {
	const pi = warningContent();
	assert.ok(pi.startsWith(`${GUIDANCE_OPEN_TAG}\n`));
	assert.ok(pi.endsWith(`\n${GUIDANCE_CLOSE_TAG}`));
	assert.ok(pi.includes(`\n${LAST_WORD_HINT}\n${COUNTDOWN_LINE}\n`), "the countdown comes after the Pi-only last-word hint");
	assert.equal(pi.split(COUNTDOWN_LINE).length - 1, 1, "the second tier carries the countdown exactly once");
	const prompted = warningContent("/empty-brain keep going");
	assert.ok(prompted.includes("<notesoup:next_window_prompt>\n/empty-brain keep going\n</notesoup:next_window_prompt>"));
	assert.ok(prompted.endsWith(`\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}`), "the prompt block does not displace the countdown");
	assert.equal(CLAUDE_WARNING_PROMPT.endsWith(`\n${COUNTDOWN_LINE}`), true, "Claude's variant ends the same way");
	assert.equal(tokenBudgetGuidance(100, "empty_brain").includes(COUNTDOWN_LINE), false, "the first tier never counts down");
	for (const text of [pi, prompted, CLAUDE_WARNING_PROMPT, tokenBudgetGuidance(100, "empty_brain")]) {
		assert.equal(/context_window/.test(text), false, "no pre-rename tag survives in model-facing text");
	}
});

test("a rendered boot carries the new tags, its own MAP section, and no pre-rename spelling", async () => {
	const rendered = await boot("root", new Map([["agent", [note("agent", "MAP.md", "@agents/root/MAP.md", "AGENT_MAP_BODY")]]]));
	assert.ok(rendered.startsWith(`${WINDOW_IDENTITY_OPEN_TAG}\n`), "the identity block opens with the renamed tag");
	assert.ok(rendered.includes(`\n${WINDOW_IDENTITY_CLOSE_TAG}\n\n${NOTES_PROTOCOL_OPEN_TAG}\n`), "the protocol follows the identity");
	assert.ok(rendered.includes(`\n${NOTES_PROTOCOL_CLOSE_TAG}\n\n${MAPS_BLOCK}\n\nYOUR NOTES`), "the MAP block sits between the protocol and the shelves");
	assert.equal(/context_window/.test(rendered), false, "the boot is free of the old spelling");
	assert.ok(rendered.includes("@self — root only"), "a named agent's shelf says it is theirs alone");
	assert.ok(rendered.includes("map\n\n  AGENT_MAP_BODY"), "the pinned MAP is headed by its own label");
	assert.equal(rendered.includes("MAP — "), false, "the old MAP heading is gone");
});

test("the shelves name their reader and the @self shelf says when it is shared", async () => {
	const rows = new Map<Scope, NoteRow[]>([
		["agent", [note("agent", "MAP.md", "@agents/anonymous/MAP.md", "AGENT_MAP_BODY"), note("agent", "shared.md", "@agents/anonymous/shared.md", "SHARED_BODY")]],
		["model", [note("model", "model.md", "@models/default/model.md", "MODEL_BODY")]],
	]);
	const named = await boot("faye", rows);
	assert.ok(named.includes("@self — faye only"));
	assert.ok(named.includes("@model — default only"));
	assert.ok(named.includes("recent\n\n  SHARED_BODY"), "fresh pages sit under the renamed sub-heading");
	assert.ok(named.indexOf("@self — faye only") < named.indexOf("@model — default only"), "shelf order is unchanged");
	const nameless = await boot("anonymous", rows);
	assert.ok(nameless.includes("@self — every nameless agent shares this"));
	assert.equal(nameless.includes("@self — anonymous only"), false);
	assert.equal(/memory|window/i.test(nameless.split("YOUR NOTES")[1] ?? ""), false, "a shelf label names a reader, not memory or a window");
});
