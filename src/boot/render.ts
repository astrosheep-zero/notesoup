import type { NotesNamespace, NotesSnapshot } from "./snapshot.js";
import { effectiveNotePolicy, MAX_PINNED_NOTES, noteBudgetWarnings, pinnedPageOrder } from "../notes/policy.js";
import { WINDOW_IDENTITY_OPEN_TAG, WINDOW_IDENTITY_CLOSE_TAG, MAPS_BLOCK, NAMELESS_AGENT, SHELF_FRESH_LIMIT, renderProtocolBlock, type BootToolNames } from "./text.js";

function relativeTime(timestamp: number, now: number): string {
	const seconds = Math.trunc((timestamp - now) / 1000);
	if (seconds === 0) return "just now";
	const [unit, size] = ([["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const)
		.find(([unit, size]) => Math.abs(seconds) >= size || unit === "s")!;
	const amount = `${Math.abs(Math.trunc(seconds / size))}${unit}`;
	return seconds > 0 ? `in ${amount}` : `${amount} ago`;
}

/** A feed entry is announced in the note's own words: its first heading, else its first line, cut short. */
const FEED_TITLE_MAX_CHARS = 40;

function feedTitle(body: string): string | undefined {
	const lines = body.split("\n");
	const heading = lines.find((line) => /^#+\s+\S/.test(line));
	const raw = (heading ? heading.replace(/^#+\s+/, "") : lines.find((line) => line.trim().length > 0) ?? "").trim();
	if (raw.length === 0) return undefined;
	const chars = Array.from(raw);
	return chars.length > FEED_TITLE_MAX_CHARS ? `${chars.slice(0, FEED_TITLE_MAX_CHARS).join("")}…` : chars.join("");
}

/** Two spaces of indent say "shelved content" without any furniture. */
function indent(text: string): string {
	return text.split("\n").map((line) => (line.length > 0 ? `  ${line}` : line)).join("\n");
}

/** An underlined header is the classical plain-text document heading: no renderer required. */
function section(label: string, body: string): string {
	return `${label}\n${"─".repeat(Array.from(label).length)}\n\n${body}`;
}

/** One closed boot snapshot: five tabbed shelves, current hands first, durable last; each shelf keeps its pinned pages and its own freshest pages. */
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
		const fresh = rows
			.filter(row => !effectiveNotePolicy(row.meta, row.path).pinned)
			.slice(0, SHELF_FRESH_LIMIT)
			.map((row) => {
				const locator = `${row.address} · ${relativeTime(row.meta.updatedAt, snapshot.openedAt)}`;
				const title = feedTitle(row.body);
				return title === undefined ? `  ${locator}` : `  ${title}\n  ${locator}`;
			});
		if (pinned.length === 0 && fresh.length === 0) continue;
		const parts = pinned.map(row => {
			const warnings = noteBudgetWarnings(row.body, effectiveNotePolicy(row.meta, row.path));
			return `${row.address}\n\n${indent([...warnings, row.body].join("\n"))}`;
		});
		if (pins.length > MAX_PINNED_NOTES) parts.push(indent(`Warning: only ${MAX_PINNED_NOTES} pinned notes per notebook are injected; omitted pins: ${pins.slice(MAX_PINNED_NOTES).map(row => row.address).join(", ")}. Unpin some notes or read the omitted pages with ${tools.notes}.`));
		if (fresh.length > 0) parts.push(`recent\n\n${fresh.join("\n\n")}`);
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
