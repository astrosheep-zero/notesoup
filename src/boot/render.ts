import type { NotesNamespace, NotesSnapshot } from "./snapshot.js";
import { effectiveNotePolicy, MAX_PINNED_NOTES, noteBudgetWarnings, pinnedPageOrder } from "../notes/policy.js";
import { collapseDescription, MAX_DESCRIPTION_CHARS } from "../notes/frontmatter.js";
import type { NoteRow } from "../notes/index.js";
import { WINDOW_IDENTITY_OPEN_TAG, WINDOW_IDENTITY_CLOSE_TAG, MAPS_BLOCK, NAMELESS_AGENT, renderProtocolBlock, type BootToolNames } from "./text.js";

function relativeTime(timestamp: number, now: number): string {
	const seconds = Math.trunc((timestamp - now) / 1000);
	if (seconds === 0) return "just now";
	const [unit, size] = ([["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const)
		.find(([unit, size]) => Math.abs(seconds) >= size || unit === "s")!;
	const amount = `${Math.abs(Math.trunc(seconds / size))}${unit}`;
	return seconds > 0 ? `in ${amount}` : `${amount} ago`;
}

/** The shelf index is bounded: enough to find a page, never the whole drawer. */
export const SHELF_INDEX_MAX_ENTRIES = 25;
export const SHELF_INDEX_MAX_CHARS = 4096;
/** A fallback title is the note's own first heading or line, cut short. */
export const FALLBACK_TITLE_MAX_CHARS = 80;

function truncated(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

function feedTitle(body: string): string | undefined {
	const lines = body.split("\n");
	const heading = lines.find((line) => /^#+\s+\S/.test(line));
	const raw = (heading ? heading.replace(/^#+\s+/, "") : lines.find((line) => line.trim().length > 0) ?? "").trim();
	return raw.length === 0 ? undefined : truncated(raw, FALLBACK_TITLE_MAX_CHARS);
}

/** A stale hand-edited description is cut for display; the authored value was already refused at write time. */
function summaryOf(row: NoteRow): string | undefined {
	if (typeof row.meta.description === "string") {
		const collapsed = collapseDescription(row.meta.description);
		return collapsed === undefined ? undefined : truncated(collapsed, MAX_DESCRIPTION_CHARS);
	}
	return feedTitle(row.body);
}

/** One index entry: where the page sits, how fresh it is, and one line saying whether to open it. */
function indexLine(row: NoteRow, openedAt: number): string {
	const locator = `${row.address} · ${relativeTime(row.meta.updatedAt, openedAt)}`;
	const summary = summaryOf(row);
	return summary === undefined ? `  ${locator}` : `  ${locator} — ${summary}`;
}

/** Two spaces of indent say "shelved content" without any furniture. */
function indent(text: string): string {
	return text.split("\n").map((line) => (line.length > 0 ? `  ${line}` : line)).join("\n");
}

/** An underlined header is the classical plain-text document heading: no renderer required. */
function section(label: string, body: string): string {
	return `${label}\n${"─".repeat(Array.from(label).length)}\n\n${body}`;
}

/** One closed boot snapshot: five tabbed shelves, current hands first, durable last; each shelf keeps its pinned pages and an auto-indexed glimpse of the rest. */
function notesIndex(snapshot: NotesSnapshot, tools: BootToolNames, agentName: string, modelName: string): string {
	const namespaces: ReadonlyArray<{ scope: NotesNamespace["scope"]; label: string }> = [
		{ scope: "session", label: "no @ — this session" },
		{ scope: "project", label: "@project — this project" },
		{ scope: "agent", label: agentName === NAMELESS_AGENT ? "@self — every nameless agent shares this" : `@self — ${agentName} only` },
		{ scope: "model", label: `@model — ${modelName} only` },
		{ scope: "human", label: "@human — the human" },
	];

	const shelves: string[] = [];
	for (const namespace of namespaces) {
		if (snapshot.unavailable.some((failed) => failed.scope === namespace.scope)) {
			shelves.push(section(namespace.label, indent(`This drawer wouldn't open. Try \`${tools.notesList}\` again.`)));
			continue;
		}
		const rows = (snapshot.namespaces.get(namespace.scope) ?? []).filter((row) => row.meta.crumpledAt === undefined);
		const pins = rows.filter(row => effectiveNotePolicy(row.meta, row.path).pinned)
			.sort((a, b) => pinnedPageOrder(a.path) - pinnedPageOrder(b.path) || a.path.localeCompare(b.path));
		const pinned = pins.slice(0, MAX_PINNED_NOTES);
		const unpinned = rows.filter(row => !effectiveNotePolicy(row.meta, row.path).pinned);
		// Both caps count joined lines; the first entry is always admitted, so a huge shelf still
		// shows its freshest page plus an honest count of what was left behind.
		const index: string[] = [];
		let usedChars = 0;
		for (const row of unpinned) {
			if (index.length >= SHELF_INDEX_MAX_ENTRIES) break;
			const line = indexLine(row, snapshot.openedAt);
			const nextChars = usedChars + (index.length > 0 ? 1 : 0) + line.length;
			if (index.length > 0 && nextChars > SHELF_INDEX_MAX_CHARS) break;
			index.push(line);
			usedChars = nextChars;
		}
		const omitted = unpinned.length - index.length;
		if (omitted > 0) index.push(`  … and ${omitted} more (use ${tools.notesList})`);
		if (pinned.length === 0 && index.length === 0) continue;
		const parts = pinned.map(row => {
			const warnings = noteBudgetWarnings(row.body, effectiveNotePolicy(row.meta, row.path));
			return `${row.address}\n\n${indent([...warnings, row.body].join("\n"))}`;
		});
		if (pins.length > MAX_PINNED_NOTES) parts.push(indent(`Warning: only ${MAX_PINNED_NOTES} pinned notes per notebook are injected; omitted pins: ${pins.slice(MAX_PINNED_NOTES).map(row => row.address).join(", ")}. Unpin some notes or read the omitted pages with ${tools.notes}.`));
		if (index.length > 0) parts.push(pinned.length > 0 ? `notes\n\n${index.join("\n")}` : index.join("\n"));
		shelves.push(section(namespace.label, parts.join("\n\n")));
	}

	return shelves.length > 0
		? ["YOUR NOTES\n──────────", ...shelves].join("\n\n\n")
		: "YOUR NOTES\n──────────\n\nNone yet. A blank slate is a fine place to start — just don't finish there.";
}

export type BootWindowTree = {
	readonly trunk: string;
	readonly windows: ReadonlyArray<{
		readonly shortName: string;
		readonly firstSeq?: number;
		readonly lastSeq?: number;
		readonly isCurrent: boolean;
	}>;
};

export type BootRenderData = {
	readonly agentName: string;
	readonly modelName: string;
	readonly tree: BootWindowTree;
	readonly notes: NotesSnapshot;
	readonly tools: BootToolNames;
};

/** Render the window identity without reading notes or consulting the host. */
function renderIdentity(data: BootRenderData): string {
	// Root, the window before this one, and this one: the block is rewritten every window, so an
	// unbounded list would repeat the whole history once per window for no new information.
	const shown = new Set([0, data.tree.windows.length - 2, data.tree.windows.length - 1]);
	const windows = data.tree.windows.filter((_window, index) => shown.has(index));
	const width = Math.max(8, ...windows.map((window) => window.shortName.length));
	const lines = [
		`Agent name: ${data.agentName} (brain: ${data.modelName})`,
		"",
		data.tree.trunk,
		...windows.map((window) => {
			const range = window.firstSeq === undefined ? "" : `    ${window.firstSeq}–${window.isCurrent ? "" : window.lastSeq}`;
			const name = range ? window.shortName.padEnd(width) : window.shortName;
			return `${window.isCurrent ? "└─" : "├─"} ${name}${range}${window.isCurrent ? "    ← you are here" : ""}`;
		}),
	];
	return `${WINDOW_IDENTITY_OPEN_TAG}\n${lines.join("\n")}\n${WINDOW_IDENTITY_CLOSE_TAG}`;
}

/** Window data only: identity and the closed notes snapshot, never protocol teaching. */
export function renderBootContext(data: BootRenderData): string {
	return [renderIdentity(data), notesIndex(data.notes, data.tools, data.agentName, data.modelName)].join("\n\n");
}

/** Full boot for hosts that keep protocol teaching alongside their window data. */
export function renderBootBlock(data: BootRenderData): string {
	return [renderIdentity(data), renderProtocolBlock(data.tools, data.agentName), MAPS_BLOCK, notesIndex(data.notes, data.tools, data.agentName, data.modelName)].join("\n\n");
}
