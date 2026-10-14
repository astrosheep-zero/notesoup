import type { NotesHome, NotesSnapshot } from "./snapshot.js";
import { WINDOW_IDENTITY_OPEN_TAG, WINDOW_IDENTITY_CLOSE_TAG, MAPS_BLOCK, MAP_BOOT_MAX_CHARS, SHELF_FRESH_LIMIT, renderProtocolBlock, type BootToolNames } from "./text.js";

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

/** Pi's default agent slug: an unnamed agent shares its `@self` shelf with every other nameless one. */
const NAMELESS_AGENT = "anonymous";

/** One closed boot snapshot: five tabbed shelves, current hands first, durable last; each shelf keeps its map and its own freshest pages. */
function notesIndex(snapshot: NotesSnapshot, tools: BootToolNames, agentName: string, modelName: string): string {
	const homes: ReadonlyArray<{ scope: NotesHome["scope"]; label: string }> = [
		{ scope: "session", label: "no @ — this session" },
		{ scope: "project", label: "@project — this project" },
		{ scope: "agent", label: agentName === NAMELESS_AGENT ? "@self — every nameless agent shares this" : `@self — ${agentName} only` },
		{ scope: "model", label: `@model — ${modelName} only` },
		{ scope: "human", label: "@human — the human" },
	];

	const shelves: string[] = [];
	for (const home of homes) {
		if (snapshot.unavailable.some((failed) => failed.scope === home.scope)) {
			shelves.push(section(home.label, indent(`This drawer wouldn't open. Try \`${tools.notesList}\` again.`)));
			continue;
		}
		const rows = (snapshot.homes.get(home.scope) ?? []).filter((row) => row.meta.crumpledAt === undefined);
		const map = rows.find((row) => row.path === "MAP.md");
		const fresh = rows
			.filter((row) => row.path !== "MAP.md")
			.slice(0, SHELF_FRESH_LIMIT)
			.map((row) => {
				const locator = `${row.address} · ${relativeTime(row.meta.updatedAt, snapshot.openedAt)}`;
				const title = feedTitle(row.body);
				return title === undefined ? `  ${locator}` : `  ${title}\n  ${locator}`;
			});
		if (!map?.body && fresh.length === 0) continue;
		const parts: string[] = [];
		if (map?.body) parts.push(`map\n\n${indent(mapBodyForBoot(map.address, map.body))}`);
		if (fresh.length > 0) parts.push(`recent\n\n${fresh.join("\n\n")}`);
		shelves.push(section(home.label, parts.join("\n\n")));
	}

	return shelves.length > 0
		? ["YOUR NOTES\n──────────", ...shelves].join("\n\n\n")
		: "YOUR NOTES\n──────────\n\nNone yet. A blank slate is a fine place to start — just don't finish there.";
}

/** One unbounded MAP body fits the boot only up to the cap; the cut names where the rest lives. */
function mapBodyForBoot(address: string, body: string): string {
	const chars = Array.from(body);
	if (chars.length <= MAP_BOOT_MAX_CHARS) return body;
	return `${chars.slice(0, MAP_BOOT_MAX_CHARS).join("")}\n[truncated at ${MAP_BOOT_MAX_CHARS} chars; slim this MAP down, full body at \`${address}\`]`;
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

/**
 * Render a static, once-per-window boot block from explicit data. This function does not read
 * notes or call runtime UI APIs; acquisition belongs to loadNotesSnapshot and its caller.
 */
export function renderBootBlock(data: BootRenderData): string {
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
	const identity = `${WINDOW_IDENTITY_OPEN_TAG}\n${lines.join("\n")}\n${WINDOW_IDENTITY_CLOSE_TAG}`;
	return [identity, renderProtocolBlock(data.tools), MAPS_BLOCK, notesIndex(data.notes, data.tools, data.agentName, data.modelName)].join("\n\n");
}
