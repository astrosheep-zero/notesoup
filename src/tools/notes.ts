import type { NotesIdentity } from "../notes/identity.js";
import { Type, type Static } from "typebox";
import { localIso } from "../notes/frontmatter.js";
import { isFilesystemError } from "../notes/fs-error.js";
import { createNotesStore, NoteError, noteIdentity, type NoteChange, type NoteMeta, type NoteQueryStatus, type NoteRow } from "../notes/index.js";
import { prefixFit, TOOL_OUTPUT_LIMIT } from "./output.js";
import { failure, fitsResult, resultSchema, readTextWindow, renderOutcome, renderTextWindow, structuredBytes, success, TextWindowRequestSchema, TextWindowSchema, type Outcome } from "./result.js";
import { nullableString, InvalidQueryError, searchQueries, searchQuery } from "./schema.js";

const ORIGIN_VALUES = [Type.Literal("user"), Type.Literal("self"), Type.Literal("external")] as const;
const ORIGIN = Type.Optional(Type.Union([...ORIGIN_VALUES], {
	description: "(optional, default self) Who wrote it: user, self, or external.",
}));
const CRUMPLED_PARAMETER = Type.Optional(Type.Boolean({ description: "(optional) true = crumple (hide from list and search, still readable); false = restore." }));
const CRUMPLED_LIST_PARAMETER = Type.Optional(Type.Boolean({ description: "(optional) true = list only crumpled notes." }));
const FILE_LIMIT_PARAMETER = Type.Optional(Type.Integer({ minimum: 1, description: "(optional, default as many as fit) Max notes." }));
const GLOB_PARAMETER = nullableString("(optional) Glob over full addresses.");
const ADDRESS_DESCRIPTION = "Addresses: a bare path is this session's note; `@project/`, `@human/`, `@self/`, `@model/` are durable homes; `@projects/<name>/<path>` reads a named project (discover with glob `@projects/*/**`). Not file paths: never pass them to file tools.";

/**
 * Typed refusal. Every fact a caller needs is already in the message; there is no separate context.
 * Convert expected refusals; unexpected errors propagate unchanged.
 */
function failureOf(error: unknown): Outcome<never> {
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
	project: Type.Optional(Type.String()),
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

const ProjectReceiptSchema = {
	project_root: Type.Optional(Type.String()),
	project_siblings: Type.Optional(Type.Array(Type.Object({ name: Type.String(), path: Type.String() }, { additionalProperties: false }))),
};

const ListedFileSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	...ProjectReceiptSchema,
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

const SnapshotSchema = {
	more: Type.Integer({ description: "How many more were left out." }),
	homes_unavailable: Type.Array(Type.String()),
};

export const NotesWriteDataSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	outcome: Type.Union([Type.Literal("created"), Type.Literal("overwrote"), Type.Literal("uncrumpled")]),
}, { additionalProperties: false });
export type NotesWriteData = Static<typeof NotesWriteDataSchema>;

export const NotesUpdateDataSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	change_kind: Type.Union([Type.Literal("none"), Type.Literal("body"), Type.Literal("metadata"), Type.Literal("moved")]),
	diff: Type.String(),
	rename_from: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type NotesUpdateData = Static<typeof NotesUpdateDataSchema>;

export const NotesReadDataSchema = Type.Object({
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	...ProjectReceiptSchema,
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
function snapshot<T extends { address: string }>(
	rows: T[],
	limit: number | undefined,
	status: NoteQueryStatus,
	renderData: (data: Snapshot<T>) => string,
	shrink?: (item: T, fits: (candidate: T) => boolean) => T,
): Outcome<Snapshot<T>> {
	const files: T[] = [];
	const data = (selected: T[]): Snapshot<T> => ({ files: selected, more: rows.length - selected.length, homes_unavailable: status.homesUnavailable });
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
	return fitsResult(outcome, render) ? outcome : failure("output_too_large", `The list of unreachable homes is itself over ${TOOL_OUTPUT_LIMIT}; narrow \`glob\` to fewer homes.`);
}

function listedFile(row: Pick<NoteRow, "address" | "meta">, identity: NotesIdentity): NotesListData["files"][number] {
	return { ...noteIdentity(identity, row.address), updated_at: localIso(row.meta.updatedAt), ...(row.meta.crumpledAt === undefined ? {} : { crumpled_at: row.meta.crumpledAt }) };
}

export const notesWriteParameters = Type.Object({ address: Type.String(), content: Type.String(), origin: ORIGIN }, { additionalProperties: false });

function renderWriteData(data: NotesWriteData): string {
	return `${data.outcome} ${renderIdentity(data)}`;
}

export const notesWrite = {
	name: "notes_write", label: "Notes write",
	description: `Create or replace a note. Name it for what it holds and when to use it. Store what git and history can't recover. ${ADDRESS_DESCRIPTION}`,
	parameters: notesWriteParameters, outputSchema: resultSchema(NotesWriteDataSchema), executionMode: "sequential",
	async execute(params: Static<typeof notesWriteParameters>, identity: NotesIdentity): Promise<Outcome<NotesWriteData>> {
		try {
			const { outcome } = await createNotesStore(identity).write(params.address, params.content, { origin: params.origin ?? "self" });
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
	rename_to: Type.Optional(Type.String({ description: "(optional) Move to this address, keeping metadata. Use alone. Won't overwrite a live note; references aren't updated." })),
}, { additionalProperties: false });

function renderUpdateData(data: NotesUpdateData): string {
	const head = data.rename_from === undefined
		? `${data.change_kind === "none" ? "unchanged" : "updated"} ${renderIdentity(data)}`
		: `moved ${data.rename_from} -> ${data.address}`;
	const lines = [head];
	if (data.diff.length > 0) lines.push("diff:", data.diff);
	return lines.join("\n");
}

function renderUpdate(result: Outcome<NotesUpdateData>): string {
	return renderOutcome(result, renderUpdateData);
}

/** A shortened diff still says so in the receipt's own text, on both surfaces. */
export const DIFF_SHORTENED_MARKER = "[diff truncated; update applied]";

const RECEIPT_TOO_LONG = `Saved, but the receipt is too long to hand back (${TOOL_OUTPUT_LIMIT} per call). Check the note with \`notes_read\`.`;

/** Bound a mutation receipt on both surfaces; a huge diff is cut to the longest fitting prefix and marked. */
function boundedUpdate(data: NotesUpdateData): Outcome<NotesUpdateData> {
	if (fitsResult(success(data), renderUpdate)) return success(data);
	if (data.diff === "") return failure("output_too_large", RECEIPT_TOO_LONG);
	const diff = prefixFit(data.diff, (candidate) => fitsResult(success({ ...data, diff: `${candidate}\n${DIFF_SHORTENED_MARKER}` }), renderUpdate));
	const result = success({ ...data, diff: `${diff}\n${DIFF_SHORTENED_MARKER}` });
	return fitsResult(result, renderUpdate) ? result : failure("output_too_large", RECEIPT_TOO_LONG);
}

export const notesUpdate = {
	name: "notes_update", label: "Notes update",
	description: `Edit a note, change its origin or crumpled state, or move it. Each \`oldText\` must match exactly once unless \`replace_all\` is true. ${ADDRESS_DESCRIPTION}`,
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
				await store.rename(params.address, renameTo);
				const from = noteIdentity(identity, params.address).address;
				const to = noteIdentity(identity, renameTo);
				return boundedUpdate({ ...to, rename_from: from, change_kind: "moved", diff: `rename ${from} -> ${to.address}` });
			}
			const { change } = await store.update(params.address, params.edits, { origin: params.origin, crumpled: params.crumpled, replaceAll: params.replace_all });
			return boundedUpdate({ ...noteIdentity(identity, params.address), change_kind: change.kind, diff: renderDiff(change) });
		} catch (error) { return failureOf(error); }
	},
	render: renderUpdate,
} as const;

export const notesReadParameters = Type.Object({ address: Type.String(), ...TextWindowRequestSchema }, { additionalProperties: false });

function renderReadData(data: NotesReadData): string {
	return `${renderIdentity(data)}\n${renderMetadata(data.metadata)}\n\n${renderTextWindow(data)}`;
}

export const notesRead = {
	name: "notes_read", label: "Notes read",
	description: `Read a note. ${ADDRESS_DESCRIPTION}`,
	parameters: notesReadParameters, outputSchema: resultSchema(NotesReadDataSchema),
	async execute(params: Static<typeof notesReadParameters>, identity: NotesIdentity): Promise<Outcome<NotesReadData>> {
		try {
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

export const notesListParameters = Type.Object({ glob: GLOB_PARAMETER, limit: FILE_LIMIT_PARAMETER, crumpled: CRUMPLED_LIST_PARAMETER }, { additionalProperties: false });

function renderListData(data: NotesListData): string {
	const lines = [`${data.files.length} ${data.files.length === 1 ? "note" : "notes"}`];
	for (const file of data.files) {
		lines.push(`- ${renderIdentity(file)} | updated ${file.updated_at}${file.crumpled_at === undefined ? "" : ` | crumpled ${file.crumpled_at}`}`);
	}
	if (data.more > 0) lines.push(`${data.more} more matching notes omitted; narrow with glob`);
	for (const home of data.homes_unavailable) lines.push(`${home} could not be read`);
	return lines.join("\n");
}

export const notesList = {
	name: "notes_list", label: "Notes list",
	description: `List notes in this session and the four @ homes, newest first. Not pageable; \`more\` counts the rest. ${ADDRESS_DESCRIPTION}`,
	parameters: notesListParameters, outputSchema: resultSchema(NotesListDataSchema),
	async execute(params: Static<typeof notesListParameters>, identity: NotesIdentity): Promise<Outcome<NotesListData>> {
		try {
			const { rows, status } = await createNotesStore(identity).listWithStatus({ glob: params.glob ?? undefined, crumpled: params.crumpled });
			return snapshot(rows.map(row => listedFile(row, identity)), params.limit, status, renderListData);
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesListData>): string => renderOutcome(result, renderListData),
} as const;

export const notesSearchParameters = Type.Object({ query: searchQuery(), glob: GLOB_PARAMETER, limit: FILE_LIMIT_PARAMETER, max_matches_per_file: Type.Optional(Type.Integer({ minimum: 1, description: "(optional, default all) Max matching lines per note." })), crumpled: CRUMPLED_LIST_PARAMETER }, { additionalProperties: false });

function renderSearchData(data: NotesSearchData): string {
	const lines = [`${data.files.length} ${data.files.length === 1 ? "note" : "notes"}`];
	for (const file of data.files) {
		lines.push(`- ${renderIdentity(file)} | updated ${file.updated_at} | ${file.matches.length} ${file.matches.length === 1 ? "match" : "matches"}`);
		for (const match of file.matches) lines.push(`  line ${match.line} at offset_chars ${match.offset_chars}: ${match.text}`);
	}
	if (data.more > 0) lines.push(`${data.more} more matching notes omitted; narrow with glob`);
	for (const home of data.homes_unavailable) lines.push(`${home} could not be read`);
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
	description: `Search note bodies for literal text, case-insensitive. Returns matching lines with offsets for \`notes_read\`. Not pageable; \`more\` counts the rest. ${ADDRESS_DESCRIPTION}`,
	parameters: notesSearchParameters, outputSchema: resultSchema(NotesSearchDataSchema),
	async execute(params: Static<typeof notesSearchParameters>, identity: NotesIdentity): Promise<Outcome<NotesSearchData>> {
		try {
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
