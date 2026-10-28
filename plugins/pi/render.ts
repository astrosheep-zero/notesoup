/** Pi TUI renderers for notesoup's own tools: collapsed one-line slips, expandable bodies. */
import { renderDiff, type AgentToolResult, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, TruncatedText, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import type { NotesReadData, NotesUpdateData, NotesWriteData } from "../../src/tools/notes.js";
import { notesReadParameters, notesUpdateParameters, notesWriteParameters } from "../../src/tools/notes.js";

/** Only the render-context members these renderers read; the host's ToolRenderContext satisfies this. */
type CallContext<TArgs> = { args: TArgs };

/** Expanded bodies show this many lines before a "more lines" marker; the full text is in the receipt. */
const EXPANDED_LINE_CAP = 80;

type WireError = { error: string; code: string };

/** structuredContent is wireResult(outcome): the data itself, or {error, code}. Old sessions may lack it. */
function wireOf<T>(result: AgentToolResult<unknown>): { data?: T; error?: WireError } {
	const sc = result.structuredContent;
	if (sc !== null && typeof sc === "object" && !Array.isArray(sc)) {
		const obj = sc as Record<string, unknown>;
		if (typeof obj.error === "string") return { error: { error: obj.error, code: typeof obj.code === "string" ? obj.code : "error" } };
		return { data: obj as T };
	}
	return {};
}

/** Results without a structured payload (resumed old sessions) fall back to the receipt's first line. */
function receiptFallback(result: AgentToolResult<unknown>, theme: Theme): Component {
	const text = result.content.find((c) => c.type === "text")?.text ?? "";
	return new TruncatedText(theme.fg("dim", text.split("\n")[0] ?? ""), 0, 0);
}

function errorComponent(theme: Theme, error: WireError, expanded: boolean): Component {
	if (!expanded) return new TruncatedText(theme.fg("error", `${error.code}: ${error.error.split("\n")[0]}`), 0, 0);
	return new Text(theme.fg("error", `${error.code}: ${error.error}`), 0, 0);
}

function addressText(theme: Theme, address: string): string {
	return theme.fg("accent", address);
}

function callLine(theme: Theme, tool: string, target?: string, suffix = ""): Component {
	let line = theme.fg("toolTitle", theme.bold(tool));
	if (target !== undefined && target !== "") line += " " + addressText(theme, target);
	if (suffix !== "") line += theme.fg("dim", suffix);
	return new TruncatedText(line, 0, 0);
}

/** First `+` line of a generateDiffString diff, without its line-number prefix: the sentence just written down. */
function firstAddedLine(diff: string): string | undefined {
	for (const line of diff.split("\n")) {
		const match = /^\+(\s*\d*)?\s?(.*)$/.exec(line);
		if (match) return match[2];
	}
	return undefined;
}

function boundedLines(text: string, theme: Theme): string {
	const lines = text.split("\n");
	if (lines.length <= EXPANDED_LINE_CAP) return text;
	return `${lines.slice(0, EXPANDED_LINE_CAP).join("\n")}\n${theme.fg("dim", `… ${lines.length - EXPANDED_LINE_CAP} more lines`)}`;
}

export type NotesWriteArgs = Static<typeof notesWriteParameters>;
export const notesWriteRenderers = {
	renderCall: (args: NotesWriteArgs, theme: Theme): Component => callLine(theme, "notes_write", args.address),
	renderResult(result: AgentToolResult<undefined>, options: { expanded: boolean }, theme: Theme, context: CallContext<NotesWriteArgs>): Component {
		const { data, error } = wireOf<NotesWriteData>(result);
		if (error) return errorComponent(theme, error, options.expanded);
		if (!data) return receiptFallback(result, theme);
		const content = typeof context.args?.content === "string" ? context.args.content : "";
		const qualifier = data.outcome === "created" ? "" : theme.fg("dim", ` · ${data.outcome}`);
		const head = `wrote ${addressText(theme, data.address)}${qualifier}${theme.fg("dim", ` · ${Array.from(content).length} chars`)}`;
		if (!options.expanded) return new TruncatedText(head, 0, 0);
		return new Text(`${head}\n\n${boundedLines(content, theme)}`, 0, 0);
	},
};

export type NotesUpdateArgs = Static<typeof notesUpdateParameters>;
export type NotesUpdateDetails = { diff?: string };
export const notesUpdateRenderers = {
	renderCall(args: NotesUpdateArgs, theme: Theme): Component {
		let suffix = "";
		if (args.crumpled === true) suffix = " · crumple";
		else if (args.crumpled === false) suffix = " · restore";
		if (typeof args.rename_to === "string" && args.rename_to !== "") suffix += ` → ${args.rename_to}`;
		return callLine(theme, "notes_update", args.address, suffix);
	},
	renderResult(result: AgentToolResult<NotesUpdateDetails | undefined>, options: { expanded: boolean }, theme: Theme, context: CallContext<NotesUpdateArgs>): Component {
		const { data, error } = wireOf<NotesUpdateData>(result);
		if (error) return errorComponent(theme, error, options.expanded);
		if (!data) return receiptFallback(result, theme);
		const diff = result.details?.diff ?? "";
		let head: string;
		if (context.args?.crumpled === true) {
			head = `✂ crumpled ${theme.strikethrough(theme.fg("dim", data.address))}`;
		} else if (context.args?.crumpled === false) {
			head = `restored ${addressText(theme, data.address)}`;
		} else if (data.change_kind === "moved") {
			head = `renamed ${theme.fg("dim", data.rename_from ?? "?")}${theme.fg("dim", " → ")}${addressText(theme, data.address)}`;
		} else if (data.change_kind === "none") {
			head = theme.fg("dim", "unchanged ") + addressText(theme, data.address);
		} else {
			head = `edited ${addressText(theme, data.address)}`;
			const peek = firstAddedLine(diff);
			if (peek !== undefined && peek !== "") head += theme.fg("dim", " · ") + theme.fg("toolDiffAdded", `+ ${peek}`);
		}
		if (!options.expanded) return new TruncatedText(head, 0, 0);
		return new Text(diff !== "" ? `${head}\n\n${renderDiff(diff)}` : head, 0, 0);
	},
};

export type NotesReadArgs = Static<typeof notesReadParameters>;
export const notesReadRenderers = {
	renderCall: (args: NotesReadArgs, theme: Theme): Component =>
		callLine(theme, "notes_read", args.address, args.offset_chars !== undefined && args.offset_chars !== 0 ? ` · offset ${args.offset_chars}` : ""),
	renderResult(result: AgentToolResult<undefined>, options: { expanded: boolean }, theme: Theme): Component {
		const { data, error } = wireOf<NotesReadData>(result);
		if (error) return errorComponent(theme, error, options.expanded);
		if (!data) return receiptFallback(result, theme);
		const truncated = data.next_offset_chars !== null;
		let head = `read ${addressText(theme, data.address)}${theme.fg("dim", ` · ${data.total_chars} chars${truncated ? " · truncated" : ""}`)}`;
		const peek = data.text.split("\n").find((line) => line.trim() !== "");
		if (peek !== undefined) head += theme.fg("dim", ` — ${peek.trim()}`);
		if (!options.expanded) return new TruncatedText(head, 0, 0);
		const tail = truncated ? `\n${theme.fg("dim", `… continue at offset_chars=${data.next_offset_chars}`)}` : "";
		return new Text(`${head}\n\n${boundedLines(data.text, theme)}${tail}`, 0, 0);
	},
};

export type EmptyBrainArgs = { last_word?: string };

/** The empty_brain result is the JSON receipt text; there is no structured payload. */
function emptyBrainPayload(result: AgentToolResult<unknown>): { status?: string; error?: string } {
	try {
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		const parsed: unknown = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object") return parsed as { status?: string; error?: string };
	} catch { /* a non-JSON receipt renders as a plain line */ }
	return {};
}

export const emptyBrainRenderers = {
	renderCall: (_args: EmptyBrainArgs, theme: Theme): Component => callLine(theme, "empty_brain"),
	renderResult(result: AgentToolResult<unknown>, _options: { expanded: boolean }, theme: Theme, context: CallContext<EmptyBrainArgs>): Component {
		const payload = emptyBrainPayload(result);
		if (result.isError || payload.error !== undefined) {
			return new TruncatedText(theme.fg("error", `✂ brain refused to empty — ${payload.error ?? "unknown error"}`), 0, 0);
		}
		if (payload.status === "rollover_already_pending") return new TruncatedText(theme.fg("dim", "✂ brain already being emptied"), 0, 0);
		const lastWord = typeof context.args?.last_word === "string" && context.args.last_word !== "" ? context.args.last_word : undefined;
		return {
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [];
				const label = "✂ brain emptied";
				const prefix = "── ";
				const fill = Math.max(0, width - visibleWidth(prefix) - visibleWidth(label) - 1);
				const lines = [theme.fg("dim", `${prefix}${label} ${"─".repeat(fill)}`)];
				if (lastWord !== undefined) lines.push(...new Text(theme.fg("warning", theme.italic(`“${lastWord}”`)), 0, 0).render(width));
				// The divider, or a wide glyph in a one-column viewport, may still need clipping.
				return lines.map((line) => truncateToWidth(line, width, ""));
			},
		};
	},
};
