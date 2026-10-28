import type { NotesIdentity } from "../notes/identity.js";
import { Type, type Static } from "typebox";
import { localIso } from "../notes/frontmatter.js";
import { isFilesystemError } from "../notes/fs-error.js";
import { createNotesStore, NoteError, noteIdentity, type NoteChange, type NoteMeta, type NoteQueryStatus, type NoteRow } from "../notes/index.js";
import { prefixFit, TOOL_OUTPUT_LIMIT } from "./output.js";
import { failure, fitsResult, resultSchema, readTextWindow, renderOutcome, renderTextWindow, structuredBytes, success, TextWindowRequestSchema, TextWindowSchema, type Outcome } from "./result.js";
import { nullableString, InvalidQueryError, searchQueries, searchQuery } from "./schema.js";
import { notesIdentityForCall, type NotesToolContext } from "./notes-context.js";

const ORIGIN_VALUES = [Type.Literal("user"), Type.Literal("self"), Type.Literal("external")] as const;
const ORIGIN = Type.Optional(Type.Union([...ORIGIN_VALUES], {
	description: "(optional) Who wrote it: user, self, or external. Omit to keep the existing origin; new notes default to self.",
}));
const CRUMPLED_PARAMETER = Type.Optional(Type.Boolean({ description: "(optional) true = crumple (hide from list and search, still readable); false = restore." }));
const CRUMPLED_LIST_PARAMETER = Type.Optional(Type.Boolean({ description: "(optional) true = list only crumpled notes." }));
const FILE_LIMIT_PARAMETER = Type.Optional(Type.Integer({ minimum: 1, description: "(optional, default as many as fit) Max notes." }));
const GLOB_PARAMETER = nullableString("(optional) Glob over full addresses, or @default for the current notebooks.");
const CWD_PARAMETER = Type.Optional(Type.String({ minLength: 1, description: "(optional) Select the current project for this call. A relative path resolves against the host session cwd; the path must be an existing directory." }));
const QUERY_NAMESPACES_DESCRIPTION = "Omit `glob` or use `@default` for this session and current shared notebooks; `**` searches all notebooks, `@sessions/*/**` searches all sessions.";
const ADDRESS_DESCRIPTION = "Addresses: a bare path is this session's note; `@project/`, `@human/`, `@self/`, `@model/` are durable notebooks; `@projects/<name>/<path>` and `@sessions/<id>/<path>` read named project and session notes (read-only). Not file paths: never pass them to file tools.";

/**
 * Typed refusal. Every fact a caller needs is already in the message; there is no separate context.
 * Convert expected refusals; unexpected errors propagate unchanged.
 */
export function failureOf(error: unknown): Outcome<never> {
	if (error instanceof NoteError) return failure(error.code, error.message);
	// Address, glob, and query guards raise declared types; nothing else is converted.
	if (error instanceof InvalidQueryError) return failure("invalid_query", error.message);
	if (isFilesystemError(error)) return failure("io_error", "notes operation failed");
	throw error;
}

/** Metadata keys this layer normalizes; everything else is exposed verbatim under `extra`. */
const NORMALIZED_META_KEYS = new Set(["scope", "origin", "createdAt", "updatedAt", "lastAccessed", "accessCount", "crumpledAt", "project"]);
/** One unrecognized entry, and the verbatim extras together, are bounded so `extra` cannot outgrow the read. */
const MAX_METADATA_ENTRY_BYTES = 1024;
const MAX_METADATA_VERBATIM_BYTES = 2048;
/** An extra value that cannot be carried is named in place, never silently dropped. */
const TOO_LARGE_EXTRA_VALUE = "[omitted: too large]";

export const NoteMetadataSchema = Type.Object({
	origin: Type.Union([...ORIGIN_VALUES]),
	created_at: Type.String(),
	updated_at: Type.String(),
	crumpled_at: Type.Optional(Type.String()),
	project: Type.Optional(Type.String({ description: "The project this session note belongs to." })),
	extra: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });
export type NoteMetadata = Static<typeof NoteMetadataSchema>;

/** Normalize known metadata and bound extras, naming an oversized value instead of hiding it. */
function noteMetadata(meta: NoteMeta): NoteMetadata {
	const extra: Record<string, unknown> = {};
	let verbatimBytes = 0;
	const put = (key: string, value: unknown): void => {
		// defineProperty keeps a hand-written `__proto__` key as ordinary data.
		Object.defineProperty(extra, key, { value, enumerable: true, writable: true, configurable: true });
	};
	for (const [key, value] of Object.entries(meta)) {
		if (NORMALIZED_META_KEYS.has(key) || value === undefined) continue;
		// A key too large to carry cannot be named at all; an oversized value is named in place.
		if (structuredBytes(key) > MAX_METADATA_ENTRY_BYTES) continue;
		// The key counts too: hand-written frontmatter can have arbitrarily long keys.
		const entryBytes = structuredBytes(key) + 1 + structuredBytes(value);
		if (entryBytes > MAX_METADATA_ENTRY_BYTES || verbatimBytes + entryBytes > MAX_METADATA_VERBATIM_BYTES) {
			put(key, TOO_LARGE_EXTRA_VALUE);
			continue;
		}
		verbatimBytes += entryBytes;
		put(key, value);
	}
	return {
		origin: meta.origin,
		created_at: localIso(meta.createdAt),
		updated_at: localIso(meta.updatedAt),
		...(typeof meta.crumpledAt === "string" ? { crumpled_at: meta.crumpledAt } : {}),
		...(typeof meta.project === "string" ? { project: meta.project } : {}),
		extra,
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
	return fields.join(" | ");
}

/** Keep the address visible, with project context and at most one sibling hint line. */
function renderIdentity(identity: { address: string; project_key?: string; project_root?: string; project_siblings?: Array<{ name: string; path: string }> }): string {
	let text = identity.project_key === undefined ? identity.address : `${identity.address} (project ${identity.project_key})`;
	if (identity.project_root !== undefined) text += ` (project_root ${identity.project_root})`;
	if (identity.project_siblings !== undefined) text += `\n  Same-basename projects: ${identity.project_siblings.map(sibling => `${sibling.name} (${sibling.path})`).join(", ")}`;
	return text;
}

/** Display context a named project notebook adds to its receipts; ordinary notebooks omit both. */
export const ProjectReceiptSchema = {
	project_root: Type.Optional(Type.String({ description: "Where this project lives on disk." })),
	project_siblings: Type.Optional(Type.Array(Type.Object({ name: Type.String(), path: Type.String() }, { additionalProperties: false }), { description: "Other projects with a similar name; check you meant this one." })),
};

/** One note identity, shared by every receipt: read/list/search rows and all mutations alike. */
export const NoteIdentitySchema = {
	address: Type.String(),
	project_key: Type.Optional(Type.String({ description: "The project `@project/` meant here." })),
	...ProjectReceiptSchema,
};

export const ListedFileSchema = Type.Object({
	...NoteIdentitySchema,
	updated_at: Type.String(),
	crumpled_at: Type.Optional(Type.String()),
}, { additionalProperties: false });

const MatchSchema = Type.Object({
	line: Type.Integer(),
	text: Type.String(),
	offset_chars: Type.Integer(),
}, { additionalProperties: false });

const SearchedFileSchema = Type.Object({
	...ListedFileSchema.properties,
	matches: Type.Array(MatchSchema),
}, { additionalProperties: false });

export const SnapshotSchema = {
	more: Type.Integer({ description: "How many more were left out." }),
	namespaces_unavailable: Type.Array(Type.String(), { description: "Unreadable notebooks or notes; the results may be missing them." }),
};

export const NotesWriteDataSchema = Type.Object({
	...NoteIdentitySchema,
	outcome: Type.Union([Type.Literal("created"), Type.Literal("overwrote"), Type.Literal("uncrumpled")], { description: "`uncrumpled`: it was crumpled; this write brought it back." }),
}, { additionalProperties: false });
export type NotesWriteData = Static<typeof NotesWriteDataSchema>;

export const NotesUpdateDataSchema = Type.Object({
	...NoteIdentitySchema,
	change_kind: Type.Union([Type.Literal("none"), Type.Literal("body"), Type.Literal("metadata"), Type.Literal("moved")], { description: "`none`: the note already looked like that." }),
	rename_from: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type NotesUpdateData = Static<typeof NotesUpdateDataSchema>;

export const NotesReadDataSchema = Type.Object({
	...NoteIdentitySchema,
	metadata: NoteMetadataSchema,
	...TextWindowSchema.properties,
}, { additionalProperties: false });
export type NotesReadData = Static<typeof NotesReadDataSchema>;

export const NotesListDataSchema = Type.Object({
	files: Type.Array(ListedFileSchema),
	...SnapshotSchema,
}, { additionalProperties: false });
export type NotesListData = Static<typeof NotesListDataSchema>;

export const NotesSearchDataSchema = Type.Object({
	files: Type.Array(SearchedFileSchema),
	...SnapshotSchema,
}, { additionalProperties: false });
export type NotesSearchData = Static<typeof NotesSearchDataSchema>;

type Snapshot<T> = Omit<NotesListData, "files"> & { files: T[] };

/** Keep identities intact. Only search previews may shrink to make the first row fit. */
export function snapshot<T extends { address: string }>(
	rows: T[],
	limit: number | undefined,
	status: NoteQueryStatus,
	renderData: (data: Snapshot<T>) => string,
	shrink?: (item: T, fits: (candidate: T) => boolean) => T,
): Outcome<Snapshot<T>> {
	const files: T[] = [];
	const data = (selected: T[]): Snapshot<T> => ({ files: selected, more: rows.length - selected.length, namespaces_unavailable: status.namespacesUnavailable });
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
		if (files.length === 0) return failure("output_too_large", `\`${item.address}\` won't fit on the list (${TOOL_OUTPUT_LIMIT} per call); narrow \`glob\` to leave it out.`);
		break;
	}
	const outcome = success(data(files));
	return fitsResult(outcome, render) ? outcome : failure("output_too_large", `The list of unreachable notebooks is itself over ${TOOL_OUTPUT_LIMIT}; narrow \`glob\` to fewer notebooks.`);
}

export function listedFile(row: Pick<NoteRow, "address" | "meta">, identity: NotesIdentity): NotesListData["files"][number] {
	return { ...noteIdentity(identity, row.address), updated_at: localIso(row.meta.updatedAt), ...(row.meta.crumpledAt === undefined ? {} : { crumpled_at: row.meta.crumpledAt }) };
}

export const notesWriteParameters = Type.Object({ address: Type.String(), content: Type.String(), origin: ORIGIN, cwd: CWD_PARAMETER }, { additionalProperties: false });

function renderWriteData(data: NotesWriteData): string {
	return `${data.outcome} ${renderIdentity(data)}`;
}

export const notesWrite = {
	name: "notes_write", label: "Notes write",
	description: `Create a note, or overwrite its whole body. Name it for what it holds and when to use it. ${ADDRESS_DESCRIPTION}`,
	parameters: notesWriteParameters, outputSchema: resultSchema(NotesWriteDataSchema), executionMode: "sequential",
	async execute(params: Static<typeof notesWriteParameters>, context: NotesToolContext): Promise<Outcome<NotesWriteData>> {
		try {
			const identity = notesIdentityForCall(context, params.cwd);
			const { outcome } = await createNotesStore(identity).write(params.address, params.content, { origin: params.origin });
			return success({ ...noteIdentity(identity, params.address), outcome });
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesWriteData>): string => renderOutcome(result, renderWriteData),
} as const;

export const notesUpdateParameters = Type.Object({
	address: Type.String(),
	edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }, { additionalProperties: false }))),
	origin: ORIGIN,
	crumpled: CRUMPLED_PARAMETER,
	replace_all: Type.Optional(Type.Boolean({ description: "(optional) true = replace every match of `oldText`." })),
	rename_to: Type.Optional(Type.String({ description: "(optional) Move to this address, optionally with edits or metadata changes. Won't overwrite a live note; references aren't updated." })),
	cwd: CWD_PARAMETER,
}, { additionalProperties: false });

function renderUpdateData(data: NotesUpdateData): string {
	return data.rename_from === undefined
		? `${data.change_kind === "none" ? "unchanged" : "updated"} ${renderIdentity(data)}`
		: `moved ${data.rename_from} -> ${data.address}`;
}

export const notesUpdate = {
	name: "notes_update", label: "Notes update",
	description: `Change part of a note's body, its origin or crumpled state, or its address. When things change, replace the stale part in place; don't just tack an update onto the bottom. Each \`oldText\` must match exactly once unless \`replace_all\` is true. ${ADDRESS_DESCRIPTION}`,
	parameters: notesUpdateParameters, outputSchema: resultSchema(NotesUpdateDataSchema), executionMode: "sequential",
	async execute(params: Static<typeof notesUpdateParameters>, context: NotesToolContext, onChange?: (change: NoteChange) => void): Promise<Outcome<NotesUpdateData>> {
		try {
			const identity = notesIdentityForCall(context, params.cwd);
			const store = createNotesStore(identity);
			// Empty filler is not a request: models that pass every parameter get the edit path.
			const renameTo = params.rename_to === "" ? undefined : params.rename_to;
			const { change, moved } = await store.update(params.address, params.edits, { origin: params.origin, crumpled: params.crumpled, replaceAll: params.replace_all, renameTo });
			onChange?.(change);
			const from = noteIdentity(identity, params.address).address;
			const to = noteIdentity(identity, renameTo ?? params.address);
			return success({ ...to, ...(moved ? { rename_from: from } : {}), change_kind: moved ? "moved" : change.kind });
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesUpdateData>): string => renderOutcome(result, renderUpdateData),
} as const;

export const notesReadParameters = Type.Object({ address: Type.String(), ...TextWindowRequestSchema, cwd: CWD_PARAMETER }, { additionalProperties: false });

function renderReadData(data: NotesReadData): string {
	return `${renderIdentity(data)}\n${renderMetadata(data.metadata)}\n\n${renderTextWindow(data)}`;
}

export const notesRead = {
	name: "notes_read", label: "Notes read",
	description: `Read a note. ${ADDRESS_DESCRIPTION}`,
	parameters: notesReadParameters, outputSchema: resultSchema(NotesReadDataSchema),
	async execute(params: Static<typeof notesReadParameters>, context: NotesToolContext): Promise<Outcome<NotesReadData>> {
		try {
			const identity = notesIdentityForCall(context, params.cwd);
			const note = await createNotesStore(identity).read(params.address);
			const resolved = noteIdentity(identity, params.address);
			if (!note) return failure("not_found", `No note at ${resolved.address}.`);
			const totalChars = Array.from(note.body).length;
			if (params.offset_chars !== undefined && params.offset_chars > totalChars) return failure("invalid_offset", `This note ends at char ${totalChars}; offset_chars ${params.offset_chars} is past the last word.`);
			const metadata = noteMetadata(note.meta);
			return readTextWindow(note.body, params.offset_chars, params.max_chars, (window) => ({ ...resolved, metadata, ...window }), (result) => renderOutcome(result, renderReadData));
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesReadData>): string => renderOutcome(result, renderReadData),
} as const;

export const notesListParameters = Type.Object({ glob: GLOB_PARAMETER, limit: FILE_LIMIT_PARAMETER, crumpled: CRUMPLED_LIST_PARAMETER, cwd: CWD_PARAMETER }, { additionalProperties: false });

export function renderListData(data: Snapshot<NotesListData["files"][number] & { last_accessed?: string }>): string {
	const lines = [`${data.files.length} ${data.files.length === 1 ? "note" : "notes"}`];
	for (const file of data.files) {
		lines.push(`- ${renderIdentity(file)} | updated ${file.updated_at}${file.last_accessed === undefined ? "" : ` | accessed ${file.last_accessed}`}${file.crumpled_at === undefined ? "" : ` | crumpled ${file.crumpled_at}`}`);
	}
	if (data.more > 0) lines.push(`${data.more} more matching notes omitted; narrow with glob`);
	for (const namespace of data.namespaces_unavailable) lines.push(`${namespace} could not be read`);
	return lines.join("\n");
}

export const notesList = {
	name: "notes_list", label: "Notes list",
	description: `List notes, newest first. Not pageable; \`more\` counts the rest. ${QUERY_NAMESPACES_DESCRIPTION} ${ADDRESS_DESCRIPTION}`,
	parameters: notesListParameters, outputSchema: resultSchema(NotesListDataSchema),
	async execute(params: Static<typeof notesListParameters>, context: NotesToolContext): Promise<Outcome<NotesListData>> {
		try {
			const identity = notesIdentityForCall(context, params.cwd);
			const { rows, status } = await createNotesStore(identity).listWithStatus({ glob: params.glob ?? undefined, crumpled: params.crumpled });
			return snapshot(rows.map(row => listedFile(row, identity)), params.limit, status, renderListData);
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesListData>): string => renderOutcome(result, renderListData),
} as const;

export const notesSearchParameters = Type.Object({ query: Type.Optional(searchQuery()), glob: GLOB_PARAMETER, limit: FILE_LIMIT_PARAMETER, max_matches_per_file: Type.Optional(Type.Integer({ minimum: 1, description: "(optional, default all) Max matching lines per note." })), crumpled: CRUMPLED_LIST_PARAMETER, cwd: CWD_PARAMETER }, { additionalProperties: false });

function renderSearchData(data: NotesSearchData): string {
	const lines = [`${data.files.length} ${data.files.length === 1 ? "note" : "notes"}`];
	for (const file of data.files) {
		lines.push(`- ${renderIdentity(file)} | updated ${file.updated_at} | ${file.matches.length} ${file.matches.length === 1 ? "match" : "matches"}`);
		for (const match of file.matches) lines.push(`  line ${match.line} at offset_chars ${match.offset_chars}: ${match.text}`);
	}
	if (data.more > 0) lines.push(`${data.more} more matching notes omitted; narrow with glob`);
	for (const namespace of data.namespaces_unavailable) lines.push(`${namespace} could not be read`);
	return lines.join("\n");
}

type SearchFile = NotesSearchData["files"][number];

/** A shortened match line still ends with a marker, so its own text says it was cut. */
export const MATCH_SHORTENED_MARKER = " [truncated]";

/** Prefer whole match lines; shorten the first line only if no whole line fits, and mark it. */
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
	const withText = (text: string): SearchFile => ({ ...file, matches: [{ ...first, text: `${text}${MATCH_SHORTENED_MARKER}` }] });
	return withText(prefixFit(first.text, text => fits(withText(text))));
}

export const notesSearch = {
	name: "notes_search", label: "Notes search",
	description: `Search note bodies for literal text, case-insensitive. Without a query, lists notes with no match lines. Returns matching lines with offsets for \`notes_read\`. Not pageable; \`more\` counts the rest. ${QUERY_NAMESPACES_DESCRIPTION} ${ADDRESS_DESCRIPTION}`,
	parameters: notesSearchParameters, outputSchema: resultSchema(NotesSearchDataSchema),
	async execute(params: Static<typeof notesSearchParameters>, context: NotesToolContext): Promise<Outcome<NotesSearchData>> {
		try {
			const identity = notesIdentityForCall(context, params.cwd);
			const { rows, status } = await createNotesStore(identity).searchWithStatus(searchQueries(params.query), { glob: params.glob ?? undefined, crumpled: params.crumpled });
			const files: NotesSearchData["files"] = rows.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt || a.address.localeCompare(b.address)).map(row => ({
				...listedFile(row, identity),
				matches: row.matches.slice(0, params.max_matches_per_file).map(match => ({ line: match.line, text: match.text, offset_chars: match.offsetChars })),
			}));
			return snapshot(files, params.limit, status, renderSearchData, fitSearchFile);
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesSearchData>): string => renderOutcome(result, renderSearchData),
} as const;
