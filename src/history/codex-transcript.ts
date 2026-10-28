/** Read-only local rollout decoder for official Codex 0.160.1 (d27764b82f71).
 * Wire owners: history/src/{lib,rollout_payload}.rs, rollout/src/ordinal.rs,
 * thread-store/src/local/rollout_lineage.rs. Not an app-server history client.
 * Native .jsonl.zst reads require Node >=22.15 (node:zlib zstdDecompressSync).
 */
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import * as zlib from "node:zlib";

export type CodexTranscriptSource = { transcriptPath: string; threadId: string };
export type CodexTranscriptState = {
	threadId: string;
	rootSessionId: string;
	cliVersion: string;
	cwd: string;
	model?: string;
	/** Native, UNPREFIXED identities, also used by MCP _meta.windowId. */
	currentWindowId?: string;
	currentWindowNumber?: number;
	firstWindowId?: string;
	previousWindowId?: string;
};
export type NativeObject = Record<string, unknown>;
export type CodexRecord = {
	type: string;
	payload: NativeObject;
	metadata?: NativeObject;
	timestamp: string;
	/** One record owns one seq, including records omitted from presentation. */
	seq: number;
	/** Metadata belongs to its physical segment, not the root-scoped session_id. */
	owner: string;
	/** Native window at this point, absent only when the producer did not persist it. */
	windowId?: string;
};
type Position = { thread_id: string; end_ordinal_exclusive: number; end_byte_offset: number };
type Segment = { meta: NativeObject; records: CodexRecord[] };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`);
const FILE_RE = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_(${UUID}))?\\.jsonl(?:\\.zst)?$`);
const RECORD_TYPES = new Set(["session_meta", "response_item", "compacted", "turn_context", "event_msg", "token_usage_record", "world_state", "retained_context", "security_risk_score", "inter_agent_communication", "inter_agent_communication_metadata", "realtime_item"]);
const RESPONSE_TYPES = new Set(["message", "agent_message", "reasoning", "local_shell_call", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "tool_search_call", "tool_search_output", "web_search_call", "image_generation_call", "compaction", "compaction_summary", "configuration_update", "context_compaction"]);
// Explicit resource limits, not guessed sequence offsets or partial successful history.
const MAX_BYTES = 128 * 1024 * 1024, MAX_SEGMENTS = 64, MAX_DIRECTORY_ENTRIES = 100_000;
export function nativeObject(value: unknown, field: string): NativeObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid Codex ${field}: expected an object`);
	return value as NativeObject;
}
export function nativeString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`Invalid Codex ${field}: expected a string`);
	return value;
}
function responseShape(value: unknown): void {
	const type = nativeString(nativeObject(value, "response_item").type, "response_item.type");
	if (!RESPONSE_TYPES.has(type)) throw new Error(`Unsupported Codex response item: ${type}`);
}
function id(value: unknown, field: string): string {
	const result = nativeString(value, field);
	if (!UUID_RE.test(result)) throw new Error(`Invalid Codex ${field}: expected a canonical UUID`);
	return result;
}
function integer(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new Error(`Invalid Codex ${field}: unsafe or negative integer`);
	return value;
}
function position(value: unknown): Position | undefined {
	if (value == null) return undefined;
	const p = nativeObject(value, "history_base");
	return { thread_id: id(p.thread_id, "history_base.thread_id (rollout ID)"), end_ordinal_exclusive: integer(p.end_ordinal_exclusive, "history_base ordinal"), end_byte_offset: integer(p.end_byte_offset, "history_base byte offset") };
}
function initialWindow(meta: NativeObject): string | undefined {
	return meta.context_window == null ? undefined : id(nativeObject(meta.context_window, "context_window").window_id, "context_window.window_id");
}
function checkMeta(meta: NativeObject): void {
	id(meta.id, "session_meta.id");
	if (meta.session_id != null) id(meta.session_id, "session_meta.session_id");
	if (meta.cli_version !== "0.160.1") throw new Error(`Unsupported Codex producer ${String(meta.cli_version)}; this decoder supports official 0.160.1 only`);
	nativeString(meta.cwd, "session_meta.cwd");
	if (meta.history_mode !== undefined && meta.history_mode !== "legacy" && meta.history_mode !== "paginated") throw new Error(`Unsupported Codex history_mode: ${String(meta.history_mode)}`);
	for (const field of ["forked_from_id", "parent_thread_id"]) if (meta[field] != null) id(meta[field], field);
	for (const field of ["forked_from_ordinal_exclusive", "subagent_history_start_ordinal"]) if (meta[field] != null) integer(meta[field], field);
	initialWindow(meta);
}

/** Only newline-committed records count. A valid JSON value without its newline is still an append tail. */
function segmentFromBytes(bytes: Buffer, cutoff?: Position): Segment {
	const limit = cutoff?.end_byte_offset ?? bytes.length;
	if (limit > bytes.length || (cutoff && (limit === 0 || bytes[limit - 1] !== 10))) throw new Error("Unavailable Codex lineage: cutoff is not a complete decoded JSONL boundary");
	const records: CodexRecord[] = [];
	let meta: NativeObject | undefined, previous = -1, lineNumber = 0;
	for (let offset = 0; offset < limit;) {
		const newline = bytes.indexOf(10, offset);
		if (newline < 0 || newline >= limit) break;
		lineNumber++;
		let row: NativeObject;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, newline));
			row = nativeObject(JSON.parse(text), "record");
		} catch { throw new Error(`Malformed committed Codex JSONL record at line ${lineNumber}`); }
		offset = newline + 1;
		const type = nativeString(row.type, "record.type");
		if (!RECORD_TYPES.has(type)) throw new Error(`Unsupported Codex rollout record: ${type}`);
		const payload = nativeObject(row.payload, `${type}.payload`);
		if (!meta) {
			if (type !== "session_meta") throw new Error("Invalid Codex transcript: first record must be session_meta");
			meta = payload;
			checkMeta(meta);
		} else if (type === "session_meta") {
			// Legacy copied forks can contain replayed metadata with no provable original
			// coordinates. Do not relabel a copied tree as independently spoken events.
			throw new Error("Unavailable Codex history: copied session_meta ancestry has no proved source addresses");
		}
		const paginated = meta.history_mode === "paginated";
		const ordinal = paginated ? integer(row.ordinal, "paginated record ordinal") : lineNumber - 1;
		if (!paginated && row.ordinal != null) throw new Error("Invalid Codex legacy transcript: unexpected ordinal");
		if (ordinal <= previous) throw new Error("Invalid Codex transcript: non-increasing record ordinals");
		if (records.length === 0 && ordinal !== (position(meta.history_base)?.end_ordinal_exclusive ?? 0)) throw new Error("Invalid Codex transcript: metadata ordinal does not match history_base");
		previous = ordinal;
		if (cutoff && ordinal >= cutoff.end_ordinal_exclusive) throw new Error("Unavailable Codex lineage: byte and ordinal cutoffs disagree");
		if (type === "event_msg" && payload.type === "thread_rolled_back") throw new Error("Unavailable Codex history: thread_rolled_back selection is not supported");
		if (type === "response_item") responseShape(payload);
		records.push({ type, payload, timestamp: nativeString(row.timestamp, "record.timestamp"), seq: ordinal + 1, owner: meta.id as string, ...(row.metadata == null ? {} : { metadata: nativeObject(row.metadata, "response metadata") }) });
	}
	if (!meta) throw new Error("Unavailable Codex transcript: no committed session_meta yet");
	const base = position(meta.history_base);
	if (base && meta.history_mode !== "paginated") throw new Error("Invalid Codex history_base on a non-paginated transcript");
	if (cutoff && meta.history_mode !== "paginated") throw new Error("Unavailable Codex lineage: referenced source is not paginated");
	// A cutoff is a native coordinate pair, not permission to approximate an ordinal
	// inside a gap. Usually the included prefix already proves its exclusive end.
	if (cutoff && previous + 1 !== cutoff.end_ordinal_exclusive) {
		const nextNewline = bytes.indexOf(10, limit);
		if (nextNewline < 0) throw new Error("Unavailable Codex lineage: ordinal cutoff is beyond the proved prefix");
		let next: NativeObject;
		try { next = nativeObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(limit, nextNewline))), "cutoff successor"); }
		catch { throw new Error("Unavailable Codex lineage: cannot prove ordinal cutoff successor"); }
		if (integer(next.ordinal, "cutoff successor ordinal") !== cutoff.end_ordinal_exclusive) throw new Error("Unavailable Codex lineage: byte and ordinal cutoffs disagree");
	}
	const start = meta.subagent_history_start_ordinal;
	if (start != null && (meta.history_mode !== "paginated" || previous < integer(start, "subagent history start") - 1)) throw new Error("Unavailable Codex history: incomplete inherited subagent prefix");
	return { meta, records };
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`);
}
/** Infer storage roots only from the supplied native path, never $HOME or a private DB. */
function storageHome(path: string): string {
	for (let cursor = dirname(path); dirname(cursor) !== cursor; cursor = dirname(cursor)) {
		if (basename(cursor) === "sessions" || basename(cursor) === "archived_sessions") return dirname(cursor);
	}
	throw new Error("Unavailable Codex lineage: transcript must be under native sessions/ or archived_sessions/ to resolve history_base");
}
async function referencedPath(home: string, rolloutId: string): Promise<string> {
	const matches: string[] = [], directories = [join(home, "sessions"), join(home, "archived_sessions")];
	let entriesSeen = 0;
	while (directories.length) {
		const directory = directories.pop()!;
		let entries;
		try { entries = await readdir(directory, { withFileTypes: true }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
		for (const entry of entries) {
			if (++entriesSeen > MAX_DIRECTORY_ENTRIES) throw new Error("Unavailable Codex lineage: native directory discovery limit exceeded");
			const path = join(directory, entry.name);
			if (entry.isDirectory()) directories.push(path);
			else if (entry.isFile()) {
				const name = FILE_RE.exec(entry.name);
				if (name && (name[2] ?? name[1]) === rolloutId) matches.push(path);
			}
		}
	}
	if (matches.length !== 1) throw new Error(`Unavailable Codex lineage: rollout ${rolloutId} has ${matches.length ? "ambiguous native files" : "no local source file"}`);
	return matches[0]!;
}
async function decodedBytes(path: string, remaining: number): Promise<Buffer> {
	const info = await stat(path);
	if (!info.isFile() || info.size > remaining) throw new Error("Unavailable Codex transcript: read size limit exceeded or not a regular file");
	const bytes = await readFile(path);
	// 0.160.1 compression.rs uses zstd, NOT gzip. No decoded file is materialized.
	if (path.endsWith(".jsonl.zst") && typeof zlib.zstdDecompressSync !== "function") throw new Error("Compressed Codex rollouts require Node >=22.15 (zstdDecompressSync)");
	const decoded = path.endsWith(".jsonl.zst") ? zlib.zstdDecompressSync(bytes, { maxOutputLength: remaining }) : bytes;
	if (decoded.length > remaining) throw new Error("Unavailable Codex transcript: decoded size limit exceeded");
	return decoded;
}

/** Internal shared read: both boot facts and history use exactly this lineage and window owner. */
export async function readCodexTranscript(source: CodexTranscriptSource): Promise<{ state: CodexTranscriptState; records: CodexRecord[]; highestSeq: number }> {
	if (!source || typeof source.transcriptPath !== "string" || !source.transcriptPath) throw new Error("Codex transcript_path is unavailable");
	id(source.threadId, "requested threadId");
	try {
		let path = await realpath(source.transcriptPath), cutoff: Position | undefined, home: string | undefined;
		let remaining = MAX_BYTES;
		const segments: Segment[] = [], seen = new Set<string>();
		while (true) {
			if (segments.length >= MAX_SEGMENTS || seen.has(path)) throw new Error("Unavailable Codex lineage: cycle or ancestry depth limit exceeded");
			seen.add(path);
			const bytes = await decodedBytes(path, remaining);
			remaining -= bytes.length;
			const segment = segmentFromBytes(bytes, cutoff);
			if (segments.length === 0 && segment.meta.id !== source.threadId) throw new Error(`Codex transcript belongs to thread ${String(segment.meta.id)}, not requested threadId ${source.threadId} (session_id is root-scoped)`);
			if (cutoff) {
				const name = FILE_RE.exec(basename(path));
				if (!name || (name[2] ?? name[1]) !== cutoff.thread_id || name[1] !== segment.meta.id) throw new Error("Unavailable Codex lineage: native filename/rollout/metadata identity mismatch");
			}
			segments.unshift(segment);
			const base = position(segment.meta.history_base);
			if (!base) break;
			if (base.end_ordinal_exclusive === 0) throw new Error("Invalid Codex lineage: history_base must include source metadata");
			home ??= storageHome(path);
			path = await realpath(await referencedPath(home, base.thread_id));
			if (![join(home, "sessions"), join(home, "archived_sessions")].some((root) => within(root, path))) throw new Error("Unsafe Codex lineage: referenced path escapes native storage roots");
			cutoff = base;
		}
		// history_base is physical; forked_from_ordinal_exclusive is the logical
		// parent boundary (protocol.rs HistoryPosition, revert_thread.rs). A revert
		// may retain this thread's own later delta, but cannot grow inherited history.
		for (let index = 0; index < segments.length; index++) {
			const meta = segments[index]!.meta, end = meta.forked_from_ordinal_exclusive;
			if (end != null && meta.forked_from_id != null) {
				for (const ancestor of segments.slice(0, index)) {
					if (ancestor.meta.id !== meta.id && ancestor.records.some((record) => record.seq - 1 >= (end as number))) throw new Error("Unavailable Codex lineage: physical ancestry exceeds the logical fork cutoff");
				}
			}
		}
		const selected = segments.at(-1)!.meta;
		const state: CodexTranscriptState = { threadId: source.threadId, rootSessionId: (selected.session_id ?? selected.id) as string, cliVersion: selected.cli_version as string, cwd: selected.cwd as string };
		const records: CodexRecord[] = [];
		let window: string | undefined, first: string | undefined, previousWindow: string | undefined, number: number | undefined, sawCompacted = false, lastSeq = 0;
		let contextModel: string | undefined, settingsModel: string | undefined;
		for (const segment of segments) {
			// Native reconstruction uses the requested header's initial identity unless
			// an inherited checkpoint supplies the effective window (rollout_reconstruction.rs).
			if (!sawCompacted) { window = initialWindow(segment.meta); first = window; previousWindow = undefined; number = window ? 0 : undefined; }
			for (const record of segment.records) {
				if (record.seq <= lastSeq) throw new Error("Unavailable Codex lineage: overlapping source coordinates");
				lastSeq = record.seq;
				if (record.type === "compacted") {
					sawCompacted = true;
					const p = record.payload;
					nativeString(p.message, "compacted.message");
					if (p.replacement_history != null && !Array.isArray(p.replacement_history)) throw new Error("Invalid Codex replacement_history");
					if (Array.isArray(p.replacement_history)) p.replacement_history.forEach(responseShape);
					if (p.replacement_history_metadata != null && (!Array.isArray(p.replacement_history_metadata) || !Array.isArray(p.replacement_history) || p.replacement_history_metadata.length !== p.replacement_history.length)) throw new Error("Invalid Codex replacement_history_metadata alignment");
					// Numeric legacy window_id has no usable native identity; don't turn it
					// into a UUID, or silently assign subsequent records to the old window.
					window = p.window_id == null || typeof p.window_id === "number" ? undefined : id(p.window_id, "compacted.window_id");
					number = p.window_number == null ? (typeof p.window_id === "number" ? integer(p.window_id, "legacy window number") : undefined) : integer(p.window_number, "window_number");
					first = p.first_window_id == null ? undefined : id(p.first_window_id, "first_window_id");
					previousWindow = p.previous_window_id == null ? undefined : id(p.previous_window_id, "previous_window_id");
				}
				record.windowId = window;
				// Explicitly copied subagent inference context isn't child-local history.
				// Preserve its coordinates as holes, not invented parent event addresses.
				const start = segment.meta.subagent_history_start_ordinal;
				if (start != null && record.type !== "session_meta" && record.seq - 1 < (start as number)) continue;
				if (record.owner === source.threadId && record.type === "turn_context") contextModel = nativeString(record.payload.model, "turn_context.model");
				if (record.type === "event_msg" && record.payload.type === "thread_settings_applied" && record.payload.thread_id === source.threadId) {
					settingsModel = nativeString(nativeObject(record.payload.thread_settings, "thread_settings").model, "thread_settings.model");
				}
				records.push(record);
			}
		}
		Object.assign(state, { currentWindowId: window, currentWindowNumber: number, firstWindowId: first, previousWindowId: previousWindow });
		// Native latest model settings win over a frozen companion TurnContext after
		// compaction (history/src/lib.rs latest_disabled_plugin_ids has same ownership).
		if (settingsModel ?? contextModel) state.model = settingsModel ?? contextModel;
		return { state, records, highestSeq: lastSeq };
	} catch (error) {
		throw new Error(`Cannot read Codex history at ${source.transcriptPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

/** Same decoder and ownership as history; no independently guessed boot window. */
export async function readCodexTranscriptState(source: CodexTranscriptSource): Promise<CodexTranscriptState> {
	return (await readCodexTranscript(source)).state;
}
