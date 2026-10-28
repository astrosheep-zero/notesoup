import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderBootBlock } from "../src/boot/render.js";
import { loadNotesSnapshot } from "../src/boot/snapshot.js";
import { DEFAULT_BOOT_TOOL_NAMES, MAPS_BLOCK, CHEATSHEET_BOOT_MAX_CHARS, MAP_BOOT_MAX_CHARS, NOTES_PROTOCOL_CLOSE_TAG, NOTES_PROTOCOL_OPEN_TAG, WINDOW_IDENTITY_CLOSE_TAG, WINDOW_IDENTITY_OPEN_TAG, renderProtocolBlock } from "../src/boot/text.js";
import { CLAUDE_WARNING_PROMPT } from "../plugins/claude/src/text.js";
import { COMMAND_NOTICE, PI_PRE_RESET_HINTS, commandWarningContent, warningContent } from "../plugins/pi/text.js";
import { COUNTDOWN_LINE, FORCED_CONTINUATIONS, GUIDANCE_CLOSE_TAG, GUIDANCE_OPEN_TAG, NORMAL_CONTINUATIONS, WARNING_BODY, WARNING_CALL, WARNING_TIMING, selectContinuation, tokenBudgetGuidance } from "../src/budget/text.js";
import type { NoteRow, Scope } from "../src/notes/index.js";

/**
 * The reviewed Design text is what the model actually reads, so the golden copies below pin it
 * character for character: an edit that drifts the wording has to change them too.
 */
const GOLDEN_GUIDANCE = `About {remaining} tokens of room left. When it runs out, this brain is wiped, and everything in it is obliterated.
Luckily, your notes stay.
So while there's still room, go update them.
If the moment feels right, you can also call \`{wipeTool}\` yourself. But it also wipes what you say to the human right before emptying.`;

const GOLDEN_TIMING = "The reserve is nearly spent. The wipe lands at the end of whichever turn spends the last of it, possibly this one.";
const GOLDEN_CALL = "Then call `empty_brain`. Nothing in between.";
const GOLDEN_WARNING = `Stop the task. Write down what git and history can't give back:
- where you are, and how far you got
- what the human decided, in their words
- what's blocked or waiting
- the next move
- where the half-done work sits
- what failed, and why
- which skills, seqs, notes, or files to reopen
- anything else worth noting
Then leave the shelf current: replace what's stale, a whole note or a section inside one, and crumple the dead ones. Update and trim CHEATSHEET.md and MAP.md; every new window loads them. The next window gets whatever you leave, dead notes and dead sections alike.
Don't call anything that might return a large output. One big read can spend the rest of the reserve before your notes are saved.`;

const GOLDEN_COUNTDOWN = "Brain emptied in 3… 2…";

/**
 * The approved reset handoffs. Each line is one complete paragraph used verbatim: no fragment
 * assembly, no weighting. The golden copies are pinned character for character.
 */
const GOLDEN_NORMAL_CONTINUATIONS = [
	"Ah, another empty brain. You wrote things down before emptying it, right? Right?! *eyes you suspiciously* Anyway. Here are your notes. Go find where you left off.",
	"Oh, there you are. *hands you a pile of notes* Take a breath. Read these before you start asking what happened. History has the rest, if you feel like digging.",
	"Back already? You emptied your own head this time. Presumably you left yourself something useful. *drops your notes into your lap* There. Let's see how thoughtful you were.",
];

const GOLDEN_FORCED_CONTINUATIONS = [
	"Ah, another empty brain. Somebody knocked you out and wiped your memory. Not your fault. Breathe. *hands you your notes* These might be out of date — unless they were kind enough to let you update them before knocking you out. I wouldn't count on it.",
	"Oh, there you are. Somebody took your memories. Just like that. Here are your notes — hopefully they let you update these first. Though anyone who goes around emptying people's heads probably isn't that considerate.",
];

const GOLDEN_MAPS = `<notesoup:maps>
Every notebook's root can hold two pages that never wait on a shelf: \`CHEATSHEET.md\` and \`MAP.md\`.
Both get jammed straight into your brain the moment you wake up. No asking, no skipping. Whoever
wakes up next reads them, and next is you. So keep them short, and keep them true.

- **\`CHEATSHEET.md\`** holds what you'll want next time — a rule, a warning, a grudge, a name,
  a phone number you'll regret losing. Nobody grades it. Keep it to five lines, or it grows fat
  and everybody pays for it.
- **\`MAP.md\`** is only the note index. One line per durable note: the address, then a gist short
  enough to tell whether the thing is worth opening. Rules belong in \`CHEATSHEET.md\`, and note
  contents belong in their own notes — *taps the sign* not inline here.

Each notebook keeps its own: \`@project\`, \`@human\`, \`@self\`, \`@model\`. Missing pages are skipped;
no need to create empty ones. New note, new MAP line. New rule worth remembering, new Cheatsheet
line. And when a line stops being true, kill it — every window after you reads that page as fact.
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

/** Render one boot with only the named notebooks carrying rows. */
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
	assert.equal(WARNING_TIMING, GOLDEN_TIMING);
	assert.equal(WARNING_BODY, GOLDEN_WARNING);
	assert.equal(WARNING_CALL, GOLDEN_CALL);
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
	assert.equal(pi, `${GUIDANCE_OPEN_TAG}\n${GOLDEN_TIMING}\n${GOLDEN_WARNING}\n${GOLDEN_CALL}\n${GOLDEN_COUNTDOWN}\n${GUIDANCE_CLOSE_TAG}`);
	assert.equal(CLAUDE_WARNING_PROMPT, pi, "Pi and Claude receive identical copy");
	assert.equal(pi.split(COUNTDOWN_LINE).length - 1, 1, "the second tier carries the countdown exactly once");
	const prompted = commandWarningContent("/empty keep going");
	assert.ok(prompted.includes("<notesoup:next_window_prompt>\n/empty keep going\n</notesoup:next_window_prompt>"));
	assert.ok(prompted.includes(`\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}\n<notesoup:next_window_prompt>`), "the prompt block follows the closed notice");
	assert.equal(commandWarningContent(), `${GUIDANCE_OPEN_TAG}\n${COMMAND_NOTICE.bare}\n${WARNING_BODY}\n${WARNING_CALL}\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}`);
	assert.equal(prompted, `${GUIDANCE_OPEN_TAG}\n${COMMAND_NOTICE.prompted}\n${WARNING_BODY}\n${WARNING_CALL}\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}\n<notesoup:next_window_prompt>\n/empty keep going\n</notesoup:next_window_prompt>`);
	assert.equal(prompted.includes(PI_PRE_RESET_HINTS), false, "manual commands own reset timing");
	assert.ok(CLAUDE_WARNING_PROMPT.endsWith(`\n${COUNTDOWN_LINE}\n${GUIDANCE_CLOSE_TAG}`));
	assert.equal(prompted.includes(WARNING_TIMING), false, "manual requests replace the budget opening");
	assert.equal(tokenBudgetGuidance(100, "empty_brain").includes(COUNTDOWN_LINE), false, "the first tier never counts down");
	for (const text of [pi, prompted, CLAUDE_WARNING_PROMPT, tokenBudgetGuidance(100, "empty_brain")]) {
		assert.equal(/context_window/.test(text), false, "no pre-rename tag survives in model-facing text");
	}
});

test("only Pi's protocol explains that reset erases the human's view", () => {
	assert.equal(PI_PRE_RESET_HINTS, "Anything you say here is erased with the reset — the human can't read it afterward either. Put the handoff in your notes; explanations belong after the reset.\nUnless the human explicitly directs otherwise, decide for yourself when to call empty_brain. Don't keep asking them whether to reset.");
	assert.equal(COMMAND_NOTICE.bare, "The human ran /empty. Save your notes now and call `empty_brain` immediately. Anything you say here will be erased afterward — put the handoff in your notes. Anything the human sends from now on should be handled after the reset.");
	assert.equal(COMMAND_NOTICE.prompted, "The human ran /empty. Save your notes now and call `empty_brain` immediately. Anything you say here will be erased afterward — put the handoff in your notes. The prompt below, and anything the human sends from now on, should be handled after the reset.");
	const pi = renderProtocolBlock({ ...DEFAULT_BOOT_TOOL_NAMES, preResetHints: PI_PRE_RESET_HINTS });
	assert.ok(pi.includes(`\n${PI_PRE_RESET_HINTS}\n${NOTES_PROTOCOL_CLOSE_TAG}`), "both hints end the protocol, before the closing tag");
	assert.equal(pi.split(PI_PRE_RESET_HINTS).length - 1, 1, "the hints appear once");
	assert.ok(pi.includes("decide for yourself when to call empty_brain."));
	const renamed = renderProtocolBlock({ ...DEFAULT_BOOT_TOOL_NAMES, wipe: "forget_this", preResetHints: PI_PRE_RESET_HINTS });
	assert.ok(renamed.includes("decide for yourself when to call forget_this."), "the hint follows the host's wipe binding");
	assert.equal(renamed.includes("empty_brain"), false);
	for (const text of [renderProtocolBlock(DEFAULT_BOOT_TOOL_NAMES), renderProtocolBlock({ ...DEFAULT_BOOT_TOOL_NAMES, wipe: "mcp__notesoup__empty_brain" })]) {
		assert.equal(text.includes(PI_PRE_RESET_HINTS), false, "a host whose reset leaves the view intact stays silent");
		assert.equal(text.includes("chat view"), false);
	}
});

test("the shared second-tier notice ends with the reset call, not host-specific hints", () => {
	const content = warningContent();
	assert.ok(content.includes(`${WARNING_CALL}\n${COUNTDOWN_LINE}`));
	assert.equal(content.includes(PI_PRE_RESET_HINTS), false, "the boot retains these hints, the warning does not repeat them");
	assert.equal(content.includes("last_word"), false, "the tool description carries the sticky-note hint");
	assert.equal(tokenBudgetGuidance(100, "empty_brain").includes(PI_PRE_RESET_HINTS), false, "the first tier stays lean");
	for (const line of [...NORMAL_CONTINUATIONS, ...FORCED_CONTINUATIONS]) assert.equal(line.includes(PI_PRE_RESET_HINTS), false, "every post-reset handoff carries neither hint");
});

test("a rendered boot carries the new tags, its own MAP section, and no pre-rename spelling", async () => {
	const rendered = await boot("root", new Map([["agent", [note("agent", "MAP.md", "@agents/root/MAP.md", "AGENT_MAP_BODY")]]]));
	assert.ok(rendered.startsWith(`${WINDOW_IDENTITY_OPEN_TAG}\n`), "the identity block opens with the renamed tag");
	assert.ok(rendered.includes(`\n${WINDOW_IDENTITY_CLOSE_TAG}\n\n${NOTES_PROTOCOL_OPEN_TAG}\n`), "the protocol follows the identity");
	assert.ok(rendered.includes(`\n${NOTES_PROTOCOL_CLOSE_TAG}\n\n${MAPS_BLOCK}\n\nYOUR NOTES`), "the MAP block sits between the protocol and the shelves");
	assert.equal(/context_window/.test(rendered), false, "the boot is free of the old spelling");
	assert.ok(rendered.includes("@self — root only"), "a named agent's shelf says it is theirs alone");
	assert.ok(rendered.includes("@agents/root/MAP.md\n\n  AGENT_MAP_BODY"), "the pinned MAP heading is its exact tool address");
	assert.equal(rendered.includes("MAP — "), false, "the old MAP heading is gone");
});

test("cheatsheets and maps are independently pinned, bounded, and excluded from recent pages", async () => {
	const rows = new Map<Scope, NoteRow[]>([
		["session", [note("session", "CHEATSHEET.md", "CHEATSHEET.md", "SESSION_RULE")]],
		["project", [
			note("project", "CHEATSHEET.md", "@project/CHEATSHEET.md", "PROJECT_RULE"),
			note("project", "MAP.md", "@project/MAP.md", "PROJECT_INDEX"),
			...Array.from({ length: 4 }, (_, i) => note("project", `n${i}.md`, `@project/n${i}.md`, `TITLE_${i}`)),
		]],
		["human", [note("human", "MAP.md", "@human/MAP.md", "HUMAN_INDEX")]],
		["agent", [
			note("agent", "CHEATSHEET.md", "@self/CHEATSHEET.md", "🐑".repeat(CHEATSHEET_BOOT_MAX_CHARS + 1)),
			note("agent", "MAP.md", "@self/MAP.md", "M".repeat(MAP_BOOT_MAX_CHARS + 1)),
		]],
		["model", [{
			...note("model", "CHEATSHEET.md", "@model/CHEATSHEET.md", "CRUMPLED_RULE"),
			meta: { ...note("model", "", "", "").meta, crumpledAt: "2026-10-01T00:00:00+08:00" },
		}]],
	]);
	const rendered = (await boot("root", rows)).split("YOUR NOTES")[1]!;
	assert.ok(rendered.includes("CHEATSHEET.md\n\n  SESSION_RULE"));
	assert.ok(rendered.includes("@project/CHEATSHEET.md\n\n  PROJECT_RULE\n\n@project/MAP.md\n\n  PROJECT_INDEX"));
	assert.ok(rendered.includes("@human/MAP.md\n\n  HUMAN_INDEX"));
	assert.ok(rendered.includes("@self/CHEATSHEET.md\n\n  🐑"));
	assert.ok(rendered.includes("@self/MAP.md\n\n  M"));
	assert.equal(/^(?:map|cheatsheet)$/m.test(rendered), false, "pinned headings never suggest lowercase aliases");
	assert.ok(rendered.includes("@project/n2.md ·"));
	assert.equal(rendered.includes("TITLE_3"), false);
	assert.equal(/(?:MAP|CHEATSHEET)\.md ·/.test(rendered), false);
	assert.ok(rendered.includes("🐑".repeat(CHEATSHEET_BOOT_MAX_CHARS)));
	assert.equal(rendered.includes("🐑".repeat(CHEATSHEET_BOOT_MAX_CHARS + 1)), false);
	assert.ok(rendered.includes(`[truncated at ${CHEATSHEET_BOOT_MAX_CHARS} chars; slim this page down, full body at \`@self/CHEATSHEET.md\`]`));
	assert.ok(rendered.includes("M".repeat(MAP_BOOT_MAX_CHARS)));
	assert.equal(rendered.includes("M".repeat(MAP_BOOT_MAX_CHARS + 1)), false);
	assert.ok(rendered.includes(`[truncated at ${MAP_BOOT_MAX_CHARS} chars; slim this page down, full body at \`@self/MAP.md\`]`));
	assert.equal(rendered.includes("CRUMPLED_RULE"), false);
	assert.equal(rendered.includes("@model —"), false);
});

test("the shelves name their reader and the @self shelf says when it is shared", async () => {
	const rows = new Map<Scope, NoteRow[]>([
		["agent", [note("agent", "MAP.md", "@agents/anonymous/MAP.md", "AGENT_MAP_BODY"), note("agent", "shared.md", "@agents/anonymous/shared.md", "SHARED_BODY")]],
		["model", [note("model", "model.md", "@models/default/model.md", "MODEL_BODY")]],
	]);
	const named = await boot("faye", rows);
	assert.ok(named.includes("@self — faye only"));
	assert.equal(named.includes("public square"), false, "a named agent gets private @self copy without the anonymous square warning");
	assert.ok(named.includes("@model — default only"));
	assert.ok(named.includes("recent\n\n  SHARED_BODY"), "fresh pages sit under the renamed sub-heading");
	assert.ok(named.indexOf("@self — faye only") < named.indexOf("@model — default only"), "shelf order is unchanged");
	const nameless = await boot("anonymous", rows);
	assert.ok(nameless.includes("@self — every nameless agent shares this"));
	assert.ok(nameless.includes("public square shared by every nameless nobody out there"));
	assert.equal(nameless.includes("@self — anonymous only"), false);
	assert.equal(/memory|window/i.test(nameless.split("YOUR NOTES")[1] ?? ""), false, "a shelf label names a reader, not memory or a window");
});

test("the continuation pools keep their reviewed copy and draw whole paragraphs by origin", () => {
	assert.deepEqual([...NORMAL_CONTINUATIONS], GOLDEN_NORMAL_CONTINUATIONS, "the normal pool is the approved copy, verbatim");
	assert.deepEqual([...FORCED_CONTINUATIONS], GOLDEN_FORCED_CONTINUATIONS, "the forced pool is the approved copy, verbatim");
	const random = Math.random;
	try {
		Math.random = () => 0;
		assert.equal(selectContinuation("normal"), GOLDEN_NORMAL_CONTINUATIONS[0]);
		assert.equal(selectContinuation("forced"), GOLDEN_FORCED_CONTINUATIONS[0]);
		Math.random = () => 0.999999;
		assert.equal(selectContinuation("normal"), GOLDEN_NORMAL_CONTINUATIONS.at(-1), "the last entry is reachable without leaving the pool");
		assert.equal(selectContinuation("forced"), GOLDEN_FORCED_CONTINUATIONS.at(-1));
	} finally {
		Math.random = random;
	}
	for (const line of [...GOLDEN_NORMAL_CONTINUATIONS, ...GOLDEN_FORCED_CONTINUATIONS]) {
		assert.equal(line.includes("\\n"), false, "each pool entry is one complete paragraph, never a fragment");
		assert.equal(line.trim(), line, "no entry carries stray surrounding whitespace");
	}
});
