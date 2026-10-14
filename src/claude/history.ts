/** Claude's persisted main transcript -> the shared history projection. No inference-context API. */
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { contentText, projectHistory, type DecodedHistoryItem, type DecodedHistoryWindow, type HistoryProjection } from "../history/history.js";

type Row = Record<string, unknown>;
type Version = { row: Row; ancestorUuid?: string; ancestor?: Version; ordinal?: number };
type Node = { first: Version; latest: Version; items: DecodedHistoryItem[] };
export type ClaudeHistorySource = { sessionId: string; transcriptPath: string; headUuid?: string };
const METADATA = new Set([
	"queue-operation", "last-prompt", "atis-latch", "mode", "permission-mode", "file-history-snapshot", "cost-state",
	"summary", "custom-title", "agent-name", "agent-color", "tag", "session-title", "progress",
]);
const MESSAGE_TYPES = new Set(["user", "assistant", "system", "attachment"]);
const NON_TEXT_BLOCKS = new Set(["thinking", "redacted_thinking", "image", "document", "audio", "video", "server_tool_use", "web_search_tool_result", "tool_reference"]);
function object(value: unknown): value is Row { return typeof value === "object" && value !== null && !Array.isArray(value); }
function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`invalid Claude transcript ${field}`);
	return value;
}
function parent(row: Row): string | undefined {
	if (row.parentUuid === null) return undefined;
	return requiredString(row.parentUuid, "parentUuid");
}
function boundary(row: Row): boolean { return row.type === "system" && row.subtype === "compact_boundary"; }

/** A trailing incomplete write is not a committed line. Valid unterminated JSON is still readable. */
function rowsOf(text: string): Row[] {
	const lines = text.split("\n"), rows: Row[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (line.trim() === "") continue;
		let value: unknown;
		try { value = JSON.parse(line); }
		catch {
			if (index === lines.length - 1 && !text.endsWith("\n")) break;
			throw new Error(`malformed Claude transcript JSON at line ${index + 1}`);
		}
		if (!object(value) || typeof value.type !== "string") throw new Error(`invalid Claude transcript record at line ${index + 1}`);
		rows.push(value);
	}
	return rows;
}

/** Only recorded visible text; never stringify unknown blocks or attachment internals (thinking included). */
function blocksOf(value: unknown): Row[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) throw new Error("invalid Claude transcript message content");
	return value.map((block) => {
		if (!object(block) || typeof block.type !== "string") throw new Error("invalid Claude transcript content block");
		if (block.type === "text") {
			if (typeof block.text !== "string") throw new Error("invalid Claude transcript text block");
		} else if (block.type !== "tool_use" && block.type !== "tool_result" && !NON_TEXT_BLOCKS.has(block.type)) {
			throw new Error(`unsupported Claude transcript content block: ${block.type}`);
		}
		return block;
	});
}
function decode(row: Row, seq: number): DecodedHistoryItem[] {
	// Native duration bookkeeping has a UUID/parent but no message body. Keep its
	// graph edge, not a fabricated empty message or serialized timing payload.
	if (row.type === "system" && row.subtype === "turn_duration") return [];
	const common = { windowId: "", ...(typeof row.timestamp === "string" ? { createdAt: row.timestamp } : {}) };
	let blocks: Row[], role: DecodedHistoryItem["role"];
	if (row.type === "user" || row.type === "assistant") {
		if (!object(row.message) || row.message.role !== row.type) throw new Error("invalid Claude transcript message role");
		blocks = blocksOf(row.message.content);
		role = row.isCompactSummary === true || row.isMeta === true ? "system" : row.type;
	} else if (row.type === "system") {
		blocks = blocksOf(row.content);
		role = "system";
	} else {
		// Old/new attachments are graph nodes even when they put no bytes in the request.
		// `rendered` is a list of native rendered messages, not raw attachment payloads.
		if (row.rendered === undefined) blocks = [];
		else if (Array.isArray(row.rendered)) blocks = row.rendered.flatMap((message) => {
			if (!object(message)) throw new Error("invalid Claude transcript rendered attachment");
			return blocksOf(message.content);
		});
		else throw new Error("invalid Claude transcript rendered attachment");
		role = "system";
	}
	const items: DecodedHistoryItem[] = [{ ...common, seq, role, text: contentText(blocks) }];
	for (const block of blocks) {
		if (block.type === "tool_use") {
			if (!object(block.input)) throw new Error("invalid Claude transcript tool arguments");
			items.push({ ...common, seq: seq + items.length, role: "tool_call", text: "", toolName: requiredString(block.name, "tool name"), toolCallId: requiredString(block.id, "tool id"), arguments: block.input });
		} else if (block.type === "tool_result") {
			if (block.is_error !== undefined && typeof block.is_error !== "boolean") throw new Error("invalid Claude transcript tool error flag");
			const output = block.content === undefined ? "" : contentText(blocksOf(block.content));
			items.push({ ...common, seq: seq + items.length, role: "tool", text: output, toolCallId: requiredString(block.tool_use_id, "tool result id"), toolError: block.is_error === true });
		}
	}
	return items;
}

/** Match the complete retained notesoup boot, not a casually quoted window-id line. */
function bootOrdinal(row: Row, sessionId: string, retained: boolean): number | undefined {
	if (!retained || row.type !== "user" || !object(row.message)) return undefined;
	const text = contentText(row.message.content);
	if (!text.startsWith("<context_window>\nAgent name: claude (") || !text.includes("\n<context_window_protocol>\n") || !text.includes("\n</context_window_protocol>")) return undefined;
	const prefix = `Current context window id: claude:${sessionId}:`;
	const suffix = text.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length);
	if (suffix === undefined || !/^\d+$/.test(suffix)) return undefined;
	const ordinal = Number(suffix);
	return Number.isSafeInteger(ordinal) ? ordinal : undefined;
}

/** All addresses are allocated on the full first-occurrence log, before branch selection. */
export function claudeHistoryFromJsonl(text: string, source: Omit<ClaudeHistorySource, "transcriptPath">): HistoryProjection {
	const nodes = new Map<string, Node>();
	let nextSeq = 1;
	for (const row of rowsOf(text)) {
		if (METADATA.has(row.type as string)) continue;
		if (!MESSAGE_TYPES.has(row.type as string)) throw new Error(`unsupported Claude transcript record type: ${row.type}`);
		const uuid = requiredString(row.uuid, "uuid");
		parent(row);
		if (row.sessionId !== source.sessionId) throw new Error("Claude transcript belongs to a different session");
		if (row.isSidechain === true || row.agentId !== undefined) throw new Error("Claude history supports only the main session transcript");
		// Resolve the window in the graph as it existed at this append, not the final
		// rewritten tree. A preserved old row stays in its original window; a NEW child
		// of its rewritten version belongs to the new window.
		const ancestor = boundary(row) && typeof row.logicalParentUuid === "string" ? row.logicalParentUuid : parent(row);
		const version: Version = { row, ancestorUuid: ancestor, ancestor: ancestor === undefined ? undefined : nodes.get(ancestor)?.latest };
		const previous = nodes.get(uuid);
		if (previous) {
			// Native resume/compaction rewrites provenance and parent links, not logical identities.
			if (previous.first.row.type !== row.type || !["message", "content", "rendered"].every((field) => isDeepStrictEqual(previous.first.row[field], row[field]))) {
				throw new Error(`conflicting Claude transcript duplicate UUID: ${uuid}`);
			}
			previous.latest = version;
			continue;
		}
		const items = decode(row, nextSeq);
		nextSeq += items.length;
		nodes.set(uuid, { first: version, latest: version, items });
	}
	function ordinalOf(version: Version): number {
		// Persisted history is not limited to the host's newest 4096 inference rows.
		// Resolve long parent chains iteratively, not with the JavaScript call stack.
		const chain: Version[] = [], calculating = new Set<Version>();
		let cursor = version;
		while (cursor.ordinal === undefined) {
			// A notice can precede its parent on disk; use that parent's first eventual version.
			cursor.ancestor ??= cursor.ancestorUuid === undefined ? undefined : nodes.get(cursor.ancestorUuid)?.first;
			if (calculating.has(cursor)) throw new Error("cyclic Claude transcript ancestry");
			if (cursor.ancestorUuid !== undefined && cursor.ancestor === undefined) throw new Error(`missing Claude transcript ancestor: ${cursor.ancestorUuid}`);
			calculating.add(cursor);
			chain.push(cursor);
			if (cursor.ancestor === undefined) break;
			cursor = cursor.ancestor;
		}
		let before = cursor.ordinal ?? 0;
		for (const current of chain.reverse()) {
			const retained = current.row.isCompactSummary === true || (current.ancestor !== undefined && boundary(current.ancestor.row));
			const marked = bootOrdinal(current.row, source.sessionId, retained);
			current.ordinal = marked === undefined ? before + (boundary(current.row) ? 1 : 0) : Math.max(before, marked);
			before = current.ordinal;
		}
		return version.ordinal!;
	}
	if (!source.headUuid) throw new Error("Claude history has no confirmed active head yet; wait for a main-session append after startup/resume");
	if (!nodes.has(source.headUuid)) throw new Error("Claude history active head is not persisted yet; retry after the transcript write");

	// The inference tree uses the latest rewritten parents. At a compact boundary the logical
	// parent and preserved segments use ORIGINAL ancestry: the old context is still history.
	const selected = new Set<string>(), visited = new Set<string>(), visiting = new Set<string>();
	type Visit = { uuid: string; historical: boolean; exit?: boolean };
	const stack: Visit[] = [{ uuid: source.headUuid, historical: false }];
	while (stack.length > 0) {
		const step = stack.pop()!, { uuid, historical } = step;
		const key = `${historical ? "old" : "live"}:${uuid}`;
		if (step.exit) { visiting.delete(key); visited.add(key); continue; }
		if (visited.has(key)) continue;
		if (visiting.has(key)) throw new Error("cyclic Claude transcript ancestry");
		visiting.add(key);
		stack.push({ ...step, exit: true });
		const node = nodes.get(uuid);
		if (!node) throw new Error(`missing Claude transcript ancestor: ${uuid}`);
		selected.add(uuid);
		const row = (historical ? node.first : node.latest).row;
		const ancestor = parent(row);
		if (ancestor !== undefined) stack.push({ uuid: ancestor, historical });
		if (!boundary(row)) continue;
		if (row.logicalParentUuid != null) stack.push({ uuid: requiredString(row.logicalParentUuid, "logicalParentUuid"), historical: true });
		const meta = row.compactMetadata;
		if (!object(meta)) continue;
		if (object(meta.preservedSegment)) {
			for (const field of ["headUuid", "tailUuid"]) if (meta.preservedSegment[field] !== undefined) stack.push({ uuid: requiredString(meta.preservedSegment[field], field), historical: true });
		}
		if (object(meta.preservedMessages)) {
			const uuids = meta.preservedMessages.allUuids ?? meta.preservedMessages.uuids;
			if (uuids === undefined) continue;
			if (!Array.isArray(uuids)) throw new Error("invalid Claude preserved messages");
			for (const id of uuids) {
				const uuid = requiredString(id, "preserved UUID");
				// allUuids also names virtual/non-persisted attachments. It is auxiliary
				// evidence, not a reason to pretend the stored parent chain is missing.
				if (nodes.has(uuid)) stack.push({ uuid, historical: true });
			}
		}
	}

	let maxOrdinal = ordinalOf(nodes.get(source.headUuid)!.latest);
	for (const uuid of selected) maxOrdinal = Math.max(maxOrdinal, ordinalOf(nodes.get(uuid)!.first));
	const windows: DecodedHistoryWindow[] = Array.from({ length: maxOrdinal + 1 }, (_, index) => ({ windowId: `claude:${source.sessionId}:${index}`, items: [] }));
	const branchSeqs = new Set<number>();
	for (const [uuid, node] of nodes) {
		if (!selected.has(uuid)) continue;
		const window = windows[ordinalOf(node.first)]!;
		window.createdAt ??= node.items[0]?.createdAt;
		for (const item of node.items) { branchSeqs.add(item.seq); window.items.push({ ...item, windowId: window.windowId }); }
	}
	return projectHistory(windows, nextSeq - 1, branchSeqs);
}

export async function readClaudeHistory(source: ClaudeHistorySource): Promise<HistoryProjection> {
	if (!source || typeof source.transcriptPath !== "string" || !source.transcriptPath || typeof source.sessionId !== "string") throw new Error("Claude history transcript_path is unavailable");
	return claudeHistoryFromJsonl(await readFile(source.transcriptPath, "utf8"), source);
}
