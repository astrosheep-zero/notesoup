/** Stable-anchor paging, folding and literal matching. The operation supplies the full-response budget check. */
import { Type, type Static } from "typebox";
import { success, type Outcome } from "../result.js";
import { earliestMatchOffsetChars, prefixFit } from "../text-match.js";
import { eventDocument, filteredItems, matchesFilter, visibleItem, HistoryFoldedRowSchema, HistoryPageItemSchema, MAX_FOLD_TOOL_NAMES, MAX_FOLD_TOOL_NAME_CHARS, type HistoryEvent, type HistoryFilter, type HistoryFoldedRow, type HistoryPageItem, type HistoryProjection } from "./history.js";

type Candidate = { event: HistoryEvent; session?: string; matchOffset?: number; preview?: HistoryPageItem; before?: HistoryFoldedRow; neighbors?: { events: HistoryEvent[]; index: number } };
type PreparedSelection = { candidates: Candidate[]; tail?: HistoryFoldedRow; multi?: boolean; discarded?: boolean; forward?: boolean };
const multiPages = new WeakSet<HistoryPage>();
export function isMultiPage(page: HistoryPage): boolean { return multiPages.has(page); }
export function markMultiPage(page: HistoryPage): HistoryPage {
	multiPages.add(page);
	return page;
}

export type HistorySelection = HistoryFilter & { session?: string; limit?: number; query?: string[]; context?: number };

export const HistoryPageSchema = Type.Object({
	notice: Type.Optional(Type.String()),
	items: Type.Array(HistoryPageItemSchema),
	folded_after: Type.Optional(HistoryFoldedRowSchema),
	has_older: Type.Boolean(),
	has_newer: Type.Boolean(),
}, { additionalProperties: false });

/** One whole page payload, before it becomes an outcome. */
export type HistoryPage = Static<typeof HistoryPageSchema>;
/** A caller's budget rejected even the shortest page; tool limits and refusal copy belong to the caller. */
export type HistoryPageResult = Outcome<HistoryPage> | { ok: false; pageTooLarge: { count: number; multi: boolean } };

/** Shorten preview text first; omit an oversized tool name rather than invent a partial name. */
function truncateHistoryItem(item: HistoryPageItem, fits: (candidate: HistoryPageItem) => boolean): HistoryPageItem {
	if (fits(item)) return item;
	const shrinkContent = (base: HistoryPageItem): HistoryPageItem => ({
		...base,
		truncated: true,
		content: prefixFit(base.content, (candidate) => fits({ ...base, truncated: true, content: candidate })),
	});
	const withContent = shrinkContent(item);
	if (fits(withContent)) return withContent;
	if (item.tool === undefined) return withContent;
	const { tool: _dropped, ...withoutName } = item;
	return fits(withoutName) ? withoutName : shrinkContent(withoutName);
}

/** Summarize one already ordered gap; omitted tool names never change its exact count. */
function foldedRun(events: HistoryEvent[], session?: string): HistoryFoldedRow | undefined {
	if (events.length === 0) return undefined;
	const counts = new Map<string, number>();
	for (const event of events) {
		if (event.role !== "tool") continue;
		const name = event.execution?.name ?? "unknown";
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const entries = [...counts].filter(([name]) => name.length <= MAX_FOLD_TOOL_NAME_CHARS).slice(0, MAX_FOLD_TOOL_NAMES);
	// fromEntries preserves __proto__ as an ordinary key without mutating the prototype.
	const tools = Object.fromEntries(entries);
	return { ...(session === undefined ? {} : { session }), first_seq: events[0]!.seq, last_seq: events.at(-1)!.seq, count: events.length, tools };
}

// Tool/thinking-only envelopes are not dialogue, even with explicit roles.
const visible = (event: HistoryEvent) => (event.role !== "user" && event.role !== "assistant") || eventDocument(event) !== "";

function* queryHits(projection: HistoryProjection, params: HistorySelection, session?: string): Generator<Candidate> {
	const { query, context } = params;
	const events = filteredItems(projection, context ? {} : params).filter(visible);
	for (const [index, event] of events.entries()) {
		if (context && !matchesFilter(event, params)) continue;
		const matchOffset = earliestMatchOffsetChars(eventDocument(event), query!);
		if (matchOffset >= 0) yield { event, session, matchOffset, neighbors: context ? { events, index } : undefined };
	}
}

function prepareSelection(projection: HistoryProjection, params: HistorySelection): PreparedSelection {
	const { query, roles, session } = params;
	if (query) return { candidates: [...queryHits(projection, params, session)] };
	const candidates: Candidate[] = [];
	let run: HistoryEvent[] = [];
	for (const event of filteredItems(projection, params).filter(visible)) {
		if (!roles && (event.role === "tool" || event.role === "context")) run.push(event);
		else {
			candidates.push({ event, session, before: foldedRun(run, session) });
			run = [];
		}
	}
	return { candidates, tail: foldedRun(run, session) };
}

/** Assemble only the admitted interval. Edge folds belong only to a page reaching that edge. */
function pageData(prepared: PreparedSelection, start: number, end: number, maxChars: number, preview?: HistoryPageItem): HistoryPage {
	const { candidates, tail } = prepared;
	const items: HistoryPage["items"] = [];
	for (let index = start; index < end; index++) {
		const candidate = candidates[index]!;
		const item = preview ?? (candidate.preview ??= { ...visibleItem(candidate.event, maxChars, candidate.matchOffset), ...(candidate.session === undefined ? {} : { session: candidate.session }) });
		items.push(candidate.before && (index > start || start === 0) ? { ...item, folded_before: candidate.before } : item);
	}
	const page = {
		items,
		...(end === candidates.length && tail ? { folded_after: tail } : {}),
		has_older: (start > 0 && start < end) || (!!prepared.discarded && !prepared.forward),
		has_newer: (end < candidates.length && start < end) || (!!prepared.discarded && !!prepared.forward),
	};
	return prepared.multi ? markMultiPage(page) : page;
}

export function selectPage(projection: HistoryProjection, params: HistorySelection, fits: (page: HistoryPage) => boolean, maxChars: number): HistoryPageResult {
	return selectPrepared(prepareSelection(projection, params), params, fits, maxChars);
}

/** One topic per session, after role/time filtering; empty dialogue envelopes are not visible. */
export function sessionRepresentative(projection: HistoryProjection, scoped: HistorySelection): HistoryEvent | undefined {
	const events = filteredItems(projection, scoped).filter(visible);
	if (scoped.roles) return events.at(-1);
	return events.find((event) => event.role === "user")
		?? events.filter((event) => event.role === "assistant").at(-1)
		?? events.at(-1);
}

function eventTime(timestamp?: string | null): number {
	const at = Date.parse(timestamp ?? "");
	return Number.isNaN(at) ? -Infinity : at;
}
const compareCorpus = (a: Candidate, b: Candidate) => eventTime(a.event.createdAt) - eventTime(b.event.createdAt) || a.session!.localeCompare(b.session!) || a.event.seq - b.event.seq;

/** Fill the remaining budget nearest first. Shared session/seq keys merge overlapping windows. */
function addContext(page: HistoryPage, hits: Candidate[], radius: number, fits: (page: HistoryPage) => boolean, maxChars: number): void {
	const key = (session: string | undefined, seq: number) => `${session ?? ""}\0${seq}`;
	const seen = new Set(page.items.map(item => key(item.session, item.seq)));
	const compare = (a: HistoryPageItem, b: HistoryPageItem) => (isMultiPage(page) ? eventTime(a.created_at) - eventTime(b.created_at) || a.session!.localeCompare(b.session!) : 0) || a.seq - b.seq;
	for (let distance = 1; distance <= radius; distance++) {
		let found = false;
		for (const { neighbors, session } of hits) {
			if (!neighbors) continue;
			for (const index of [neighbors.index - distance, neighbors.index + distance]) {
				const event = neighbors.events[index];
				if (!event) continue;
				found = true;
				const id = key(session, event.seq);
				if (seen.has(id)) continue;
				const item: HistoryPageItem = { ...visibleItem(event, maxChars), ...(session === undefined ? {} : { session }), context: true };
				const previous = page.items;
				page.items = [...previous, item].sort(compare);
				if (!fits(page)) { page.items = previous; return; }
				seen.add(id);
			}
		}
		if (!found) return;
	}
}

/** Keep only the requested end of the globally ordered selection while sessions are released. */
export class CorpusCollector {
	private readonly candidates: Candidate[] = [];
	private readonly limit: number;
	private discarded = false;
	constructor(private readonly scoped: HistorySelection) {
		this.limit = Math.min(500, Math.max(1, scoped.limit ?? 20));
	}

	private admit(candidate: Candidate): void {
		// Upper bound preserves the stable ordering of equal candidates.
		let low = 0, high = this.candidates.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (compareCorpus(this.candidates[mid]!, candidate) <= 0) low = mid + 1;
			else high = mid;
		}
		if (this.candidates.length === this.limit) {
			this.discarded = true;
			if (this.scoped.after) {
				if (low === this.limit) return;
				this.candidates.pop();
			} else {
				if (low === 0) return;
				this.candidates.shift();
				low--;
			}
		}
		this.candidates.splice(low, 0, candidate);
	}

	/** Admit an already selected strict overview event without selecting it a second time. */
	addRepresentative(session: string, event: HistoryEvent | undefined): boolean {
		if (!event) return false;
		this.admit({ session, event });
		return true;
	}

	/** Returns whether this session contributes an overview representative. */
	add(session: string, projection: HistoryProjection): boolean {
		if (this.scoped.query === undefined) return this.addRepresentative(session, sessionRepresentative(projection, this.scoped));
		for (const hit of queryHits(projection, this.scoped, session)) this.admit(hit);
		return true;
	}

	page(fits: (page: HistoryPage) => boolean, maxChars: number, unvisited = false): HistoryPageResult {
		return selectPrepared({ candidates: this.candidates, multi: true, discarded: this.discarded || unvisited, forward: !!this.scoped.after }, this.scoped, fits, maxChars);
	}
}

function selectPrepared(prepared: PreparedSelection, scoped: HistorySelection, fits: (page: HistoryPage) => boolean, maxChars: number): HistoryPageResult {
	const { candidates } = prepared;
	// Grow a contiguous interval from the requested end; even a byte-limited newest page stays ascending.
	const newest = scoped.after === undefined;
	let start = newest ? candidates.length : 0;
	let end = start;
	const limit = Math.max(1, scoped.limit ?? 20);
	for (let count = 0; count < limit && (newest ? start > 0 : end < candidates.length); count++) {
		const nextStart = newest ? start - 1 : start;
		const nextEnd = newest ? end : end + 1;
		if (fits(pageData(prepared, nextStart, nextEnd, maxChars))) {
			start = nextStart;
			end = nextEnd;
			continue;
		}
		if (start === end) {
			start = nextStart;
			end = nextEnd;
			const candidate = candidates[start]!;
			candidate.preview = truncateHistoryItem(candidate.preview!, (preview) => fits(pageData(prepared, start, end, maxChars, preview)));
		}
		break;
	}
	const page = pageData(prepared, start, end, maxChars);
	if (!fits(page)) return { ok: false, pageTooLarge: { count: page.items.length, multi: prepared.multi === true } };
	if (scoped.context) addContext(page, candidates.slice(start, end), scoped.context, fits, maxChars);
	return success(page);
}
