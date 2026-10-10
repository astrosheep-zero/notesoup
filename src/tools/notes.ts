import type { NotesIdentity } from "../notes/identity.js";
import { Type, type Static } from "typebox";
import { localIso } from "../notes/frontmatter.js";
import { isFilesystemError } from "../notes/fs-error.js";
import { createNotesStore, NoteError, noteIdentity, type NoteChange, type NoteMeta, type NoteQueryStatus, type NoteRow, type Scope } from "../notes/index.js";
import { DEFAULT_READ_WINDOW_CHARS, MAX_READ_WINDOW_CHARS, prefixFit } from "./output.js";
import { failure, fitsResult, resultSchema, readTextWindow, renderOutcome, renderTextWindow, structuredBytes, success, TextWindowSchema, type Outcome } from "./result.js";
import { nullableString, InvalidQueryError, searchQueries, searchQuery } from "./schema.js";

const ORIGIN_VALUES = [Type.Literal("user"), Type.Literal("self"), Type.Literal("external")] as const;
const ORIGIN = Type.Optional(Type.Union([...ORIGIN_VALUES], {
	description: "Content source: user, self (default), or external.",
}));
const CRUMPLED_PARAMETER = Type.Optional(Type.Boolean({ description: "true crumples (archives) the note: hidden from list/search, still readable by address; false restores it." }));
const WASTEBASKET_PARAMETER = Type.Optional(Type.Boolean({ description: "true lists only crumpled notes instead of live ones." }));
const FILE_LIMIT_PARAMETER = Type.Optional(Type.Integer({ minimum: 1, description: "Max files (default: as many as fit the output budget)." }));
const ADDRESS_DESCRIPTION = "Addresses: <path> with no @ for this session; @project/, @human/, @self/, @model/ for durable homes (see /skill:memory). Never pass them to filesystem tools.";

/** The one receipt field a caller cannot derive from the address itself. */
function projectKeyField(scope: Scope, projectKey: string): { project_key?: string } {
	return scope === "project" ? { project_key: projectKey } : {};
}

const MAX_ERROR_LINE_FACTS = 20;

/**
 * Typed refusal. Edit locations keep their precise line/edit facts in `details`.
 * Convert expected refusals; unexpected errors propagate unchanged.
 */
function failureOf(error: unknown): Outcome<never> {
	if (error instanceof NoteError) {
		const details: Record<string, unknown> = {};
		let message = error.message;
		if (error.lineNumbers) {
			if (error.lineNumbers.length > MAX_ERROR_LINE_FACTS) {
				details.line_numbers = error.lineNumbers.slice(0, MAX_ERROR_LINE_FACTS);
				details.line_numbers_total = error.lineNumbers.length;
				message = `${message} (this refusal names ${MAX_ERROR_LINE_FACTS} of ${error.lineNumbers.length} match lines; the note is unchanged)`;
			} else {
				details.line_numbers = error.lineNumbers;
			}
		}
		if (error.editIndex !== undefined) details.edit_index = error.editIndex;
		return failure(error.code, message, Object.keys(details).length > 0 ? details : undefined);
	}
	// Address, pattern, and query guards raise declared types; nothing else is converted.
	if (error instanceof InvalidQueryError) return failure("invalid_query", error.message);
	if (isFilesystemError(error)) return failure("io_error", "notes operation failed");
	throw error;
}

function byRecent<T extends { address: string; meta: { updatedAt: number } }>(a: T, b: T): number {
	return b.meta.updatedAt - a.meta.updatedAt || a.address.localeCompare(b.address);
}

/** Metadata keys this layer normalizes; everything else is exposed verbatim under `extra`. */
const NORMALIZED_META_KEYS = new Set(["scope", "origin", "createdAt", "updatedAt", "lastAccessed", "accessCount", "crumpledAt", "project"]);
/** One unrecognized entry, and all of them together, are bounded; omissions are counted, never listed. */
export const MAX_METADATA_ENTRY_BYTES = 1024;
const MAX_METADATA_EXTRA_BYTES = 2048;

/** Include the key: hand-written frontmatter can have arbitrarily long keys. */
function extraEntryBytes(key: string, value: unknown): number {
	return structuredBytes(key) + 1 + structuredBytes(value);
}

export const NoteMetadataSchema = Type.Object({
	origin: Type.Union([...ORIGIN_VALUES]),
	created_at: Type.String(),
	updated_at: Type.String(),
	crumpled_at: Type.Optional(Type.String()),
	project: Type.Optional(Type.String()),
	extra: Type.Record(Type.String(), Type.Unknown()),
	/** Values left in the file but too large to show, summarized so the summary cannot grow. */
	omitted_extra: Type.Optional(Type.Object({ keys: Type.Integer(), bytes: Type.Integer() })),
});
export type NoteMetadata = Static<typeof NoteMetadataSchema>;

/** Normalize known metadata and bound extras without partially serializing their values. */
function noteMetadata(meta: NoteMeta): NoteMetadata {
	const extra: Record<string, unknown> = {};
	let extraBytes = 0;
	let omittedKeys = 0;
	let omittedBytes = 0;
	for (const [key, value] of Object.entries(meta)) {
		if (NORMALIZED_META_KEYS.has(key) || value === undefined) continue;
		const bytes = extraEntryBytes(key, value);
		if (bytes > MAX_METADATA_ENTRY_BYTES || extraBytes + bytes > MAX_METADATA_EXTRA_BYTES) {
			omittedKeys++;
			omittedBytes += bytes;
			continue;
		}
		extraBytes += bytes;
		// defineProperty keeps a hand-written `__proto__` key as ordinary data.
		Object.defineProperty(extra, key, { value, enumerable: true, writable: true, configurable: true });
	}
	return {
		origin: meta.origin,
		created_at: localIso(meta.createdAt),
		updated_at: localIso(meta.updatedAt),
		...(typeof meta.crumpledAt === "string" ? { crumpled_at: meta.crumpledAt } : {}),
		...(typeof meta.project === "string" ? { project: meta.project } : {}),
		extra,
		...(omittedKeys > 0 ? { omitted_extra: { keys: omittedKeys, bytes: omittedBytes } } : {}),
	};
}

function renderMetadata(metadata: NoteMetadata): string {
	const fields = [
		`origin ${metadata.origin}`,
		`created ${metadata.created_at}`,
		`updated ${metadata.updated_at}`,
		...(metadata.crumpled_at === undefined ? [] : [`crumpled ${metadata.crumpled_at}`]),
		...(metadata.project === undefined ? [] : [`project ${metadata.project}`]),
	];
	const extra = Object.keys(metadata.extra);
	if (extra.length > 0) fields.push(`extra ${JSON.stringify(metadata.extra)}`);
	if (metadata.omitted_extra !== undefined) fields.push(`${metadata.omitted_extra.keys} more metadata values (${metadata.omitted_extra.bytes} bytes) are in the note file but too large to show`);
	return fields.join(" | ");
}

/** Address plus project key in one line; the project key never replaces the address. */
function renderIdentity(identity: { address: string; project_key?: string }): string {
	return identity.project_key === undefined ? identity.address : `${identity.address} (project ${identity.project_key})`;
}

const ListedFileSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	updated_at: Type.String(),
	crumpled_at: Type.Optional(Type.String()),
});

const MatchSchema = Type.Object({
	line: Type.Integer(),
	text: Type.String(),
	truncated: Type.Boolean(),
	offset_chars: Type.Integer(),
});

const SearchedFileSchema = Type.Object({
	...ListedFileSchema.properties,
	matches_total: Type.Integer(),
	matches: Type.Array(MatchSchema),
});

const SnapshotSchema = {
	more: Type.Integer(),
	crumpled_excluded: Type.Integer(),
	homes_unavailable: Type.Array(Type.String()),
};

export const NotesWriteDataSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	outcome: Type.Union([Type.Literal("created"), Type.Literal("overwrote"), Type.Literal("uncrumpled")]),
});
export type NotesWriteData = Static<typeof NotesWriteDataSchema>;

export const NotesUpdateDataSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	applied: Type.Integer(),
	change_kind: Type.Union([Type.Literal("none"), Type.Literal("body"), Type.Literal("metadata"), Type.Literal("file")]),
	diff: Type.String(),
	diff_truncated: Type.Optional(Type.Literal(true)),
	rename_from: Type.Optional(Type.String()),
	replaced_crumpled_target: Type.Optional(Type.Boolean()),
});
export type NotesUpdateData = Static<typeof NotesUpdateDataSchema>;

export const NotesReadDataSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	metadata: NoteMetadataSchema,
	...TextWindowSchema.properties,
});
export type NotesReadData = Static<typeof NotesReadDataSchema>;

export const NotesListDataSchema = Type.Object({
	files: Type.Array(ListedFileSchema),
	...SnapshotSchema,
});
export type NotesListData = Static<typeof NotesListDataSchema>;

export const NotesSearchDataSchema = Type.Object({
	files: Type.Array(SearchedFileSchema),
	...SnapshotSchema,
});
export type NotesSearchData = Static<typeof NotesSearchDataSchema>;

type Snapshot<T> = Omit<NotesListData, "files"> & { files: T[] };

/** Keep identities intact. Only search previews may shrink to make the first row fit. */
function snapshot<T>(
	rows: T[],
	limit: number | undefined,
	status: NoteQueryStatus,
	renderData: (data: Snapshot<T>) => string,
	shrink?: (item: T, fits: (candidate: T) => boolean) => T,
): Outcome<Snapshot<T>> {
	const files: T[] = [];
	const data = (selected: T[]): Snapshot<T> => ({ files: selected, more: rows.length - selected.length, crumpled_excluded: status.crumpledExcluded, homes_unavailable: status.homesUnavailable });
	const render = (outcome: Outcome<Snapshot<T>>) => renderOutcome(outcome, renderData);
	const fits = (item: T) => fitsResult(success(data([...files, item])), render);
	for (const item of rows.slice(0, limit)) {
		if (fits(item)) {
			files.push(item);
			continue;
		}
		if (files.length === 0 && shrink) {
			const reduced = shrink(item, fits);
			if (fits(reduced)) files.push(reduced);
		}
		if (files.length === 0) return failure("output_too_large", "The first matching note cannot fit in a response without losing its identity.");
		break;
	}
	const outcome = success(data(files));
	return fitsResult(outcome, render) ? outcome : failure("output_too_large", "The notes snapshot metadata exceeds the response budget.");
}

function listedFile(row: Pick<NoteRow, "address" | "scope" | "meta">, identity: NotesIdentity): NotesListData["files"][number] {
	return { address: row.address, ...projectKeyField(row.scope, identity.projectKey), updated_at: localIso(row.meta.updatedAt), ...(row.meta.crumpledAt === undefined ? {} : { crumpled_at: row.meta.crumpledAt }) };
}

export const notesWriteParameters = Type.Object({ address: Type.String(), content: Type.String(), origin: ORIGIN }, { additionalProperties: false });

function renderWriteData(data: NotesWriteData): string {
	return `${data.outcome} ${renderIdentity(data)}`;
}

export const notesWrite = {
	name: "notes_write", label: "Notes write",
	description: `Create or replace a note body, preserving metadata; uncrumples a crumpled note. Name it for its contents and when to use it. Store what git/history cannot recover. ${ADDRESS_DESCRIPTION}`,
	parameters: notesWriteParameters, outputSchema: resultSchema(NotesWriteDataSchema), executionMode: "sequential",
	async execute(params: Static<typeof notesWriteParameters>, identity: NotesIdentity): Promise<Outcome<NotesWriteData>> {
		try {
			const { outcome } = await createNotesStore(identity).write(params.address, params.content, { origin: params.origin ?? "self" });
			return success({ ...noteIdentity(identity, params.address), outcome });
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesWriteData>): string => renderOutcome(result, renderWriteData),
} as const;

export const notesUpdateParameters = Type.Object({ address: Type.String(), edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }, { additionalProperties: false }))), origin: ORIGIN, crumpled: CRUMPLED_PARAMETER, replace_all: Type.Optional(Type.Boolean()), rename_to: Type.Optional(Type.String({ description: "Move, preserving metadata. Use alone. Refuses live targets; may replace crumpled targets. References are not updated. Empty string is ignored." })) }, { additionalProperties: false });

function renderUpdateData(data: NotesUpdateData): string {
	const head = data.rename_from === undefined
		? `${data.change_kind === "none" ? "unchanged" : "updated"} ${renderIdentity(data)}: ${data.applied} ${data.applied === 1 ? "edit" : "edits"}`
		: `moved ${data.rename_from} -> ${data.address}${data.replaced_crumpled_target === true ? " (replaced a crumpled note)" : ""}`;
	const lines = [head];
	if (data.diff_truncated === true) lines.push("diff (this receipt's diff was shortened to fit the output budget; the update itself was applied):");
	else if (data.diff.length > 0) lines.push("diff:");
	if (data.diff.length > 0) lines.push(data.diff);
	return lines.join("\n");
}

function renderUpdate(result: Outcome<NotesUpdateData>): string {
	return renderOutcome(result, renderUpdateData);
}

/** Bound a mutation receipt on both surfaces; a huge diff is cut to the longest fitting prefix. */
function boundedUpdate(data: NotesUpdateData): Outcome<NotesUpdateData> {
	if (fitsResult(success(data), renderUpdate)) return success(data);
	const shortened: NotesUpdateData = { ...data, diff_truncated: true };
	const diff = prefixFit(data.diff, (candidate) => fitsResult(success({ ...shortened, diff: candidate }), renderUpdate));
	const result = success({ ...shortened, diff });
	return fitsResult(result, renderUpdate) ? result : failure("output_too_large", "The update was applied, but its receipt metadata exceeds the response budget.");
}

export const notesUpdate = {
	name: "notes_update", label: "Notes update",
	description: `Edit body text, change origin or crumpled state, or move a note. Each oldText must match once unless replace_all is true; edits cannot change frontmatter. Metadata-only updates need origin or crumpled. Returns applied changes and a bounded diff. ${ADDRESS_DESCRIPTION}`,
	parameters: notesUpdateParameters, outputSchema: resultSchema(NotesUpdateDataSchema), executionMode: "sequential",
	async execute(params: Static<typeof notesUpdateParameters>, identity: NotesIdentity, renderDiff: (change: NoteChange) => string): Promise<Outcome<NotesUpdateData>> {
		try {
			const store = createNotesStore(identity);
			// Empty filler is not a request: models that pass every parameter get the edit path.
			const renameTo = params.rename_to === "" ? undefined : params.rename_to;
			if (renameTo !== undefined) {
				if ((params.edits?.length ?? 0) > 0 || params.origin !== undefined || params.crumpled !== undefined || params.replace_all === true) {
					return failureOf(new NoteError("invalid_scope", "rename_to is used alone: do not combine it with edits, origin, crumpled, or replace_all"));
				}
				const { replacedCrumpledTarget } = await store.rename(params.address, renameTo);
				const from = noteIdentity(identity, params.address).address;
				const to = noteIdentity(identity, renameTo);
				return boundedUpdate({ ...to, rename_from: from, applied: 0, change_kind: "file", diff: `rename ${from} -> ${to.address}`, replaced_crumpled_target: replacedCrumpledTarget });
			}
			const { applied, change } = await store.update(params.address, params.edits, { origin: params.origin, crumpled: params.crumpled, replaceAll: params.replace_all });
			return boundedUpdate({ ...noteIdentity(identity, params.address), applied, change_kind: change.kind, diff: renderDiff(change) });
		} catch (error) { return failureOf(error); }
	},
	render: renderUpdate,
} as const;

export const notesReadParameters = Type.Object({ address: Type.String(), offset_chars: Type.Optional(Type.Integer({ description: "Body code-point offset (default 0); negative counts from EOF." })), limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_WINDOW_CHARS, description: `Max code points (default ${DEFAULT_READ_WINDOW_CHARS}); also bounded by output bytes.` })) }, { additionalProperties: false });

function renderReadData(data: NotesReadData): string {
	return `${renderIdentity(data)}\n${renderMetadata(data.metadata)}\n\n${renderTextWindow(data)}`;
}

export const notesRead = {
	name: "notes_read", label: "Notes read",
	description: `Read note metadata and a verbatim body slice, excluding frontmatter. Pass next_offset_chars as offset_chars until null. ${ADDRESS_DESCRIPTION}`,
	parameters: notesReadParameters, outputSchema: resultSchema(NotesReadDataSchema),
	async execute(params: Static<typeof notesReadParameters>, identity: NotesIdentity): Promise<Outcome<NotesReadData>> {
		try {
			const note = await createNotesStore(identity).read(params.address);
			if (!note) return failure("not_found", "note not found");
			const totalChars = Array.from(note.body).length;
			if (params.offset_chars !== undefined && params.offset_chars > totalChars) return failure("invalid_offset", `offset_chars ${params.offset_chars} is past the end of the body: the note has ${totalChars} body chars; the largest legal offset is ${totalChars} (an empty end-read)`);
			const resolved = noteIdentity(identity, params.address);
			const metadata = noteMetadata(note.meta);
			return readTextWindow(note.body, params.offset_chars, params.limit_chars, (window) => ({ ...resolved, metadata, ...window }), (result) => renderOutcome(result, renderReadData));
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesReadData>): string => renderOutcome(result, renderReadData),
} as const;

export const notesListParameters = Type.Object({ pattern: nullableString(), limit: FILE_LIMIT_PARAMETER, wastebasket: WASTEBASKET_PARAMETER }, { additionalProperties: false });

function renderListData(data: NotesListData): string {
	const lines = [`${data.files.length} ${data.files.length === 1 ? "note" : "notes"}`];
	for (const file of data.files) {
		lines.push(`- ${renderIdentity(file)} | updated ${file.updated_at}${file.crumpled_at === undefined ? "" : ` | crumpled ${file.crumpled_at}`}`);
	}
	if (data.more > 0) lines.push(`${data.more} more matching notes omitted; narrow with pattern`);
	if (data.crumpled_excluded > 0) lines.push(`${data.crumpled_excluded} crumpled notes hidden; pass wastebasket to list them`);
	for (const home of data.homes_unavailable) lines.push(`${home} could not be read`);
	return lines.join("\n");
}

export const notesList = {
	name: "notes_list", label: "Notes list",
	description: `List notes in the session and the four @ homes, newest first. Snapshot, not pageable: more counts omitted files; pattern globs full addresses. Reports unavailable homes and how many crumpled notes were excluded. ${ADDRESS_DESCRIPTION}`,
	parameters: notesListParameters, outputSchema: resultSchema(NotesListDataSchema),
	async execute(params: Static<typeof notesListParameters>, identity: NotesIdentity): Promise<Outcome<NotesListData>> {
		try {
			const { rows, status } = await createNotesStore(identity).listWithStatus({ pattern: params.pattern ?? undefined, wastebasket: params.wastebasket });
			return snapshot(rows.map(row => listedFile(row, identity)), params.limit, status, renderListData);
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesListData>): string => renderOutcome(result, renderListData),
} as const;

export const notesSearchParameters = Type.Object({ query: searchQuery(), pattern: nullableString(), limit: FILE_LIMIT_PARAMETER, max_matches_per_file: Type.Optional(Type.Integer({ minimum: 1, description: "Max matches shown per file (default: no cap); matches_total still counts all." })), wastebasket: WASTEBASKET_PARAMETER }, { additionalProperties: false });

function renderSearchData(data: NotesSearchData): string {
	const lines = [`${data.files.length} ${data.files.length === 1 ? "file" : "files"}`];
	for (const file of data.files) {
		lines.push(`- ${renderIdentity(file)} | updated ${file.updated_at} | ${file.matches_total} ${file.matches_total === 1 ? "match" : "matches"}${file.matches.length < file.matches_total ? ` (${file.matches.length} shown)` : ""}`);
		for (const match of file.matches) lines.push(`  line ${match.line} at offset_chars ${match.offset_chars}: ${match.text}${match.truncated ? " [line shortened]" : ""}`);
	}
	if (data.more > 0) lines.push(`${data.more} more matching files omitted; narrow with pattern`);
	if (data.crumpled_excluded > 0) lines.push(`${data.crumpled_excluded} crumpled notes hidden; pass wastebasket to search them`);
	for (const home of data.homes_unavailable) lines.push(`${home} could not be read`);
	return lines.join("\n");
}

type SearchFile = NotesSearchData["files"][number];

/** Prefer whole match lines; shorten the first line only if no whole line fits. */
function fitSearchFile(file: SearchFile, fits: (candidate: SearchFile) => boolean): SearchFile {
	let low = 0;
	let high = file.matches.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits({ ...file, matches: file.matches.slice(0, mid) })) low = mid;
		else high = mid - 1;
	}
	if (low > 0) return { ...file, matches: file.matches.slice(0, low) };
	const first = file.matches[0];
	if (!first) return file;
	const withText = (text: string): SearchFile => ({ ...file, matches: [{ ...first, text, truncated: true }] });
	return withText(prefixFit(first.text, text => fits(withText(text))));
}

export const notesSearch = {
	name: "notes_search", label: "Notes search",
	description: `Search note bodies for case-insensitive literal queries (OR). Returns matching lines and body code-point offsets for \`notes_read\`. Snapshot, not pageable: more counts omitted files; matches_total is before per-file capping. pattern globs full addresses across the session and the four @ homes. ${ADDRESS_DESCRIPTION}`,
	parameters: notesSearchParameters, outputSchema: resultSchema(NotesSearchDataSchema),
	async execute(params: Static<typeof notesSearchParameters>, identity: NotesIdentity): Promise<Outcome<NotesSearchData>> {
		try {
			const { rows, status } = await createNotesStore(identity).searchWithStatus(searchQueries(params.query), { pattern: params.pattern ?? undefined, wastebasket: params.wastebasket });
			const files: NotesSearchData["files"] = rows.sort(byRecent).map(row => ({
				...listedFile(row, identity),
				matches_total: row.matches.length,
				matches: row.matches.slice(0, params.max_matches_per_file).map(match => ({ line: match.line, text: match.text, truncated: false, offset_chars: match.offsetChars })),
			}));
			return snapshot(files, params.limit, status, renderSearchData, fitSearchFile);
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesSearchData>): string => renderOutcome(result, renderSearchData),
} as const;
