import type { NotesIdentity } from "../notes/identity.js";
import { assertAddress } from "../notes/address.js";
import { noteFileName } from "../notes/paths.js";
import { effectiveNotePolicy, noteBudgetWarnings } from "../notes/policy.js";
import { Type, type Static } from "typebox";
import { localIso } from "../notes/frontmatter.js";
import { isFilesystemError } from "../notes/fs-error.js";
import { createNotesStore, NoteError, noteIdentity, type NoteChange, type NoteMeta, type NoteQueryStatus, type NoteRow } from "../notes/index.js";
import { TOOL_OUTPUT_LIMIT } from "./output.js";
import { failure, success, type Outcome } from "../result.js";
import { InvalidQueryError, prefixFit, searchQueries } from "../text-match.js";
import { fitsResult, resultSchema, readTextWindow, renderOutcome, renderTextWindow, structuredBytes, TextWindowRequestSchema, TextWindowSchema } from "./result.js";
import { searchQuery } from "./schema.js";
import { notesIdentityForCall, type NotesToolContext } from "./notes-context.js";

const ORIGIN_VALUES = [Type.Literal("user"), Type.Literal("self"), Type.Literal("external")] as const;
const ORIGIN = Type.Optional(Type.Union([...ORIGIN_VALUES], {
	description: "Whose handwriting: user, self, or external. Leave it out to keep what's there.",
}));
const DESCRIPTION_PARAMETER = Type.Optional(Type.String({ description: "One-line summary of what's inside and when to open it (max 160 chars). Empty string clears it." }));
const POLICY_PARAMETERS = {
	pinned: Type.Optional(Type.Boolean({ description: "Tape the page inside the cover: read whole at every wake-up. Five per notebook, CHEATSHEET included." })),
	budget: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "How much paper the page gets. Writing past it still saves, with a warning. A page over budget gets boiled down: stale lines out, repeats merged, the rest said shorter. More paper is for a page already boiled down that still needs the room." })),
	readonly: Type.Optional(Type.Boolean({ description: "A paperclip that keeps your own hands off. `false` takes it off — same call is fine." })),
};
const PolicySchema = {
	pinned: Type.Boolean(), budget: Type.Integer(), readonly: Type.Boolean(),
};
const WarningsSchema = { warnings: Type.Array(Type.String()) };
function policyAt(meta: NoteMeta, address: string) {
	return effectiveNotePolicy(meta, noteFileName(assertAddress(address).path));
}
function renderPolicy(policy: { pinned: boolean; budget: number; readonly: boolean }): string {
	return `pinned ${policy.pinned} | budget ${policy.budget} | readonly ${policy.readonly}`;
}
function withWarnings(text: string, data: { warnings: string[] }): string {
	return [text, ...data.warnings].join("\n");
}

const CRUMPLED_PARAMETER = Type.Optional(Type.Boolean({ description: "`true` balls the page up: gone from list and search, still readable. `false` smooths it flat again." }));
const CRUMPLED_LIST_PARAMETER = Type.Optional(Type.Boolean({ description: "Only the crumpled balls." }));
const FILE_LIMIT_PARAMETER = Type.Optional(Type.Integer({ minimum: 1, description: "How many pages at most." }));
const GLOB_PARAMETER = Type.Optional(Type.String({ minLength: 1, description: "Which drawers to open. Leave it out for this session and your current notebooks. `@project/**` one shelf · `CHEATSHEET.md` that page in every notebook · `**` everything · `@sessions/*/**` every session." }));
const CWD_PARAMETER = Type.Optional(Type.String({ minLength: 1, description: "Treat this directory's project as `@project/`." }));
const ADDRESS_PARAMETER = Type.String({ description: "Which drawer the page sits in. `plan.md` — this session's desk, cleared when it ends. `@project/` this project's shelf · `@human/` your human's file · `@self/` your own notebook · `@model/` your brain's. `@projects/<name>/`, `@sessions/<id>/`, `@agents/<name>/`, `@models/<name>/` — someone else's shelf: read only. Paper, not files: hand one to read/write/edit/bash and a real `@project` folder is born." });

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
const NORMALIZED_META_KEYS = new Set(["scope", "origin", "createdAt", "updatedAt", "lastAccessed", "accessCount", "crumpledAt", "project", "pinned", "budget", "readonly", "description"]);
/** One unrecognized entry, and the verbatim extras together, are bounded so `extra` cannot outgrow the read. */
const MAX_METADATA_ENTRY_BYTES = 1024;
const MAX_METADATA_VERBATIM_BYTES = 2048;
/** An extra value that cannot be carried is named in place, never silently dropped. */
const TOO_LARGE_EXTRA_VALUE = "[omitted: too large]";

export const NoteMetadataSchema = Type.Object({
	...PolicySchema,
	origin: Type.Union([...ORIGIN_VALUES]),
	created_at: Type.String(),
	updated_at: Type.String(),
	crumpled_at: Type.Optional(Type.String()),
	project: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	extra: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });
export type NoteMetadata = Static<typeof NoteMetadataSchema>;

/** Normalize known metadata and bound extras, naming an oversized value instead of hiding it. */
function noteMetadata(meta: NoteMeta, address: string): NoteMetadata {
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
		...policyAt(meta, address),
		origin: meta.origin,
		created_at: localIso(meta.createdAt),
		updated_at: localIso(meta.updatedAt),
		...(typeof meta.crumpledAt === "string" ? { crumpled_at: meta.crumpledAt } : {}),
		...(typeof meta.project === "string" ? { project: meta.project } : {}),
		...(typeof meta.description === "string" ? { description: meta.description } : {}),
		extra,
	};
}

function renderMetadata(metadata: NoteMetadata): string {
	const fields = [
		renderPolicy(metadata),
		`origin ${metadata.origin}`,
		`created ${metadata.created_at}`,
		`updated ${metadata.updated_at}`,
		...(metadata.crumpled_at === undefined ? [] : [`crumpled ${metadata.crumpled_at}`]),
		...(metadata.project === undefined ? [] : [`project ${metadata.project}`]),
		...(metadata.description === undefined ? [] : [`description ${metadata.description}`]),
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
	project_root: Type.Optional(Type.String()),
	project_siblings: Type.Optional(Type.Array(Type.Object({ name: Type.String(), path: Type.String() }, { additionalProperties: false }))),
};

/** One note identity, shared by every receipt: read/list/search rows and all mutations alike. */
export const NoteIdentitySchema = {
	address: Type.String(),
	project_key: Type.Optional(Type.String()),
	...ProjectReceiptSchema,
};

export const ListedFileSchema = Type.Object({
	...NoteIdentitySchema,
	...PolicySchema,
	...WarningsSchema,
	updated_at: Type.String(),
	crumpled_at: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
}, { additionalProperties: false });

const MatchSchema = Type.Object({
	line: Type.Integer(),
	text: Type.String(),
	offset_chars: Type.Integer(),
}, { additionalProperties: false });

export const SnapshotSchema = {
	more: Type.Integer({ description: "How many more were left out." }),
	namespaces_unavailable: Type.Array(Type.String(), { description: "Unreadable notebooks or notes." }),
};

export const NotesWriteDataSchema = Type.Object({
	...NoteIdentitySchema,
	...PolicySchema,
	...WarningsSchema,
	outcome: Type.Union([Type.Literal("created"), Type.Literal("overwrote"), Type.Literal("uncrumpled")]),
}, { additionalProperties: false });
export type NotesWriteData = Static<typeof NotesWriteDataSchema>;

export const NotesUpdateDataSchema = Type.Object({
	...NoteIdentitySchema,
	...PolicySchema,
	...WarningsSchema,
	change_kind: Type.Union([Type.Literal("none"), Type.Literal("body"), Type.Literal("metadata"), Type.Literal("moved")]),
	rename_from: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type NotesUpdateData = Static<typeof NotesUpdateDataSchema>;

export const NotesReadDataSchema = Type.Object({
	...NoteIdentitySchema,
	metadata: NoteMetadataSchema,
	...WarningsSchema,
	...TextWindowSchema.properties,
}, { additionalProperties: false });
export type NotesReadData = Static<typeof NotesReadDataSchema>;

export const NotesListDataSchema = Type.Object({
	files: Type.Array(Type.Object({
		...ListedFileSchema.properties,
		matches: Type.Optional(Type.Array(MatchSchema)), more_matches: Type.Optional(Type.Integer({ minimum: 1 })),
	}, { additionalProperties: false })),
	...SnapshotSchema,
}, { additionalProperties: false });
export type NotesListData = Static<typeof NotesListDataSchema>;
type ListedFile = Static<typeof ListedFileSchema>;
type SearchFile = ListedFile & { matches: Static<typeof MatchSchema>[]; more_matches?: number };

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

export function listedFile(row: Pick<NoteRow, "address" | "meta"> & { body?: string; warnings?: string[] }, identity: NotesIdentity): ListedFile {
	const policy = policyAt(row.meta, row.address);
	return { ...noteIdentity(identity, row.address), ...policy, warnings: row.warnings ?? (row.body === undefined ? [] : noteBudgetWarnings(row.body, policy)), updated_at: localIso(row.meta.updatedAt), ...(row.meta.crumpledAt === undefined ? {} : { crumpled_at: row.meta.crumpledAt }), ...(typeof row.meta.description === "string" ? { description: row.meta.description } : {}) };
}

export const notesWriteParameters = Type.Object({ address: ADDRESS_PARAMETER, content: Type.String({ description: "The whole page." }), origin: ORIGIN, description: DESCRIPTION_PARAMETER, ...POLICY_PARAMETERS, cwd: CWD_PARAMETER }, { additionalProperties: false });

function renderWriteData(data: NotesWriteData): string {
	return withWarnings(`${data.outcome} ${renderIdentity(data)} | ${renderPolicy(data)}`, data);
}

export const notesWrite = {
	name: "notes_write", label: "Notes write",
	description: "Take a fresh page and write it — or rip out the old one and write it again. Title it for what's inside and when you'll reach for it.",
	parameters: notesWriteParameters, outputSchema: resultSchema(NotesWriteDataSchema), executionMode: "sequential",
	async execute(params: Static<typeof notesWriteParameters>, context: NotesToolContext): Promise<Outcome<NotesWriteData>> {
		try {
			const identity = notesIdentityForCall(context, params.cwd);
			const { outcome, meta, warnings } = await createNotesStore(identity).write(params.address, params.content, { origin: params.origin, description: params.description, pinned: params.pinned, budget: params.budget, readonly: params.readonly });
			return success({ ...noteIdentity(identity, params.address), outcome, ...policyAt(meta, params.address), warnings });
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesWriteData>): string => renderOutcome(result, renderWriteData),
} as const;

export const notesUpdateParameters = Type.Object({
	address: ADDRESS_PARAMETER,
	edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String({ description: "The passage as it stands on the page." }), newText: Type.String({ description: "What goes in its place." }) }, { additionalProperties: false }), { description: "Pen strokes, in order. Each `oldText` is the exact passage — same case, found once — and `newText` is what goes in its place." })),
	origin: ORIGIN,
	description: DESCRIPTION_PARAMETER,
	...POLICY_PARAMETERS,
	crumpled: CRUMPLED_PARAMETER,
	replace_all: Type.Optional(Type.Boolean({ description: "Strike every copy of `oldText`, not just one." })),
	rename_to: Type.Optional(Type.String({ description: "Move the page to another address. Never lands on top of a live page; nothing pointing at it follows." })),
	cwd: CWD_PARAMETER,
}, { additionalProperties: false });

function renderUpdateData(data: NotesUpdateData): string {
	const receipt = data.rename_from === undefined
		? `${data.change_kind === "none" ? "unchanged" : "updated"} ${renderIdentity(data)}`
		: `moved ${data.rename_from} -> ${data.address}`;
	return withWarnings(`${receipt} | ${renderPolicy(data)}`, data);
}

export const notesUpdate = {
	name: "notes_update", label: "Notes update",
	description: "Work on a page you already have: cross out and rewrite lines, move it, pin it, lock it, give it more paper, crumple it. Keep every page true to now: wrong, stale, or no-longer-mattering lines get rewritten or struck where they stand. The page stays one page.",
	parameters: notesUpdateParameters, outputSchema: resultSchema(NotesUpdateDataSchema), executionMode: "sequential",
	async execute(params: Static<typeof notesUpdateParameters>, context: NotesToolContext, onChange?: (change: NoteChange) => void): Promise<Outcome<NotesUpdateData>> {
		try {
			const identity = notesIdentityForCall(context, params.cwd);
			const store = createNotesStore(identity);
			// Empty filler is not a request: models that pass every parameter get the edit path.
			const renameTo = params.rename_to === "" ? undefined : params.rename_to;
			const { change, moved, meta, warnings } = await store.update(params.address, params.edits, { origin: params.origin, description: params.description, pinned: params.pinned, budget: params.budget, readonly: params.readonly, crumpled: params.crumpled, replaceAll: params.replace_all, renameTo });
			onChange?.(change);
			const from = noteIdentity(identity, params.address).address;
			const to = noteIdentity(identity, renameTo ?? params.address);
			return success({ ...to, ...policyAt(meta, to.address), warnings, ...(moved ? { rename_from: from } : {}), change_kind: moved ? "moved" : change.kind });
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesUpdateData>): string => renderOutcome(result, renderUpdateData),
} as const;

export const notesReadParameters = Type.Object({ address: ADDRESS_PARAMETER, ...TextWindowRequestSchema, cwd: CWD_PARAMETER }, { additionalProperties: false });

function renderReadData(data: NotesReadData): string {
	return withWarnings(`${renderIdentity(data)}\n${renderMetadata(data.metadata)}`, data) + `\n\n${renderTextWindow(data)}`;
}

export const notesRead = {
	name: "notes_read", label: "Notes read",
	description: "Read a page. Long ones come a stretch at a time; follow `next_offset_chars`.",
	parameters: notesReadParameters, outputSchema: resultSchema(NotesReadDataSchema),
	async execute(params: Static<typeof notesReadParameters>, context: NotesToolContext): Promise<Outcome<NotesReadData>> {
		try {
			const identity = notesIdentityForCall(context, params.cwd);
			const note = await createNotesStore(identity).read(params.address);
			const resolved = noteIdentity(identity, params.address);
			if (!note) return failure("not_found", `No note at ${resolved.address}.`);
			const totalChars = Array.from(note.body).length;
			if (params.offset_chars !== undefined && params.offset_chars > totalChars) return failure("invalid_offset", `This note ends at char ${totalChars}; offset_chars ${params.offset_chars} is past the last word.`);
			const metadata = noteMetadata(note.meta, resolved.address);
			const warnings = noteBudgetWarnings(note.body, metadata);
			return readTextWindow(note.body, params.offset_chars, params.max_chars, (window) => ({ ...resolved, metadata, warnings, ...window }), (result) => renderOutcome(result, renderReadData));
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesReadData>): string => renderOutcome(result, renderReadData),
} as const;

export const notesListParameters = Type.Object({
	glob: GLOB_PARAMETER,
	query: Type.Optional(searchQuery()),
	max_matches_per_file: Type.Optional(Type.Integer({ minimum: 1, description: "How many hit lines per note at most; requires a query." })),
	crumpled: CRUMPLED_LIST_PARAMETER,
	limit: FILE_LIMIT_PARAMETER,
	cwd: CWD_PARAMETER,
}, { additionalProperties: false });

export function renderListData(data: Snapshot<NotesListData["files"][number] & { last_accessed?: string }>): string {
	const lines = [`${data.files.length} ${data.files.length === 1 ? "note" : "notes"}`];
	for (const file of data.files) {
		const fields = [file.description === undefined ? `- ${renderIdentity(file)}` : `- ${renderIdentity(file)} — ${file.description}`, renderPolicy(file), `updated ${file.updated_at}`];
		if (file.last_accessed !== undefined) fields.push(`accessed ${file.last_accessed}`);
		if (file.crumpled_at !== undefined) fields.push(`crumpled ${file.crumpled_at}`);
		if (file.matches) fields.push(`${file.matches.length} ${file.matches.length === 1 ? "match" : "matches"}${file.more_matches ? `, ${file.more_matches} more lines` : ""}`);
		lines.push(fields.join(" | "));
		lines.push(...file.warnings.map(warning => `  ${warning}`));
		for (const match of file.matches ?? []) lines.push(`  line ${match.line} at offset_chars ${match.offset_chars}: ${match.text}`);
	}
	if (data.more > 0) lines.push(`${data.more} more matching notes omitted; narrow with glob`);
	for (const namespace of data.namespaces_unavailable) lines.push(`${namespace} could not be read`);
	return lines.join("\n");
}

function keepMatches(file: SearchFile, count = file.matches.length): SearchFile {
	const more = (file.more_matches ?? 0) + Math.max(0, file.matches.length - count);
	return { ...file, matches: file.matches.slice(0, count), ...(more ? { more_matches: more } : {}) };
}

/** A shortened match line still ends with a marker, so its own text says it was cut. */
export const MATCH_SHORTENED_MARKER = " [truncated]";

/** Prefer whole match lines; shorten the first line only if no whole line fits, and mark it. */
function fitSearchFile(file: SearchFile, fits: (candidate: SearchFile) => boolean): SearchFile {
	let low = 0;
	let high = file.matches.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(keepMatches(file, mid))) low = mid;
		else high = mid - 1;
	}
	if (low > 0 || file.matches.length === 0) return keepMatches(file, low);
	const first = file.matches[0]!;
	const withText = (text: string): SearchFile => ({ ...keepMatches(file, 1), matches: [{ ...first, text: `${text}${MATCH_SHORTENED_MARKER}` }] });
	return withText(prefixFit(first.text, text => fits(withText(text))));
}

export const notesList = {
	name: "notes_list", label: "Notes list",
	description: "List or search notes, newest pages on top. A query matches literal text (ignoring case) and returns hit lines and read offsets. One pass; `more` counts pages left on the pile — narrow `glob`.",
	parameters: notesListParameters, outputSchema: resultSchema(NotesListDataSchema),
	async execute(params: Static<typeof notesListParameters>, context: NotesToolContext): Promise<Outcome<NotesListData>> {
		try {
			const queries = searchQueries(params.query);
			const { glob, crumpled, limit } = params;
			if (!queries.length && params.max_matches_per_file !== undefined) return failure("invalid_params", "`max_matches_per_file` requires a non-empty `query`.");
			const identity = notesIdentityForCall(context, params.cwd);
			const store = createNotesStore(identity);
			if (!queries.length) {
				const { rows, status } = await store.listWithStatus({ glob, crumpled });
				return snapshot(rows.map(row => listedFile(row, identity)), limit, status, renderListData);
			}
			const { rows, status } = await store.searchWithStatus(queries, { glob, crumpled });
			const files = rows.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt || a.address.localeCompare(b.address)).map(row => keepMatches({
				...listedFile(row, identity),
				matches: row.matches.map(match => ({ line: match.line, text: match.text, offset_chars: match.offsetChars })),
			}, params.max_matches_per_file));
			return snapshot(files, limit, status, renderListData, fitSearchFile);
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<NotesListData>): string => renderOutcome(result, renderListData),
} as const;
