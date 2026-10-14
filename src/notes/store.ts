import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { earliestMatchOffsetChars } from "../text-match.js";
import { assertAddress, assertGlobPattern, addressFor, canonicalAddressFor, globToRegExp, HOME_HEADS } from "./address.js";
import { isFilesystemError } from "./fs-error.js";
import { snapshotNotesIdentity, type NotesIdentity } from "./identity.js";
import { NoteError } from "./errors.js";
import { MAX_NOTE_BYTES, MAX_NOTE_PATH_BYTES } from "./constants.js";
import { isOrigin, localIso, parseNote, serializeNote, stripLeadingFrontmatter, type NoteMeta, type Origin } from "./frontmatter.js";
import { namespaceSlugs, noteFileName, physicalPath, scopeDir, SLUG_PATTERN, type Scope } from "./paths.js";
import { projectHomes, projectReceipt, type ProjectReceipt } from "./project-home.js";

export type { NoteMeta, Origin, Scope };

export type NoteRow = { address: string; scope: Scope; path: string; meta: NoteMeta; body: string; sizeBytes: number };

// Recency sorts tie-break by address, so two writes sharing one Date.now() tick would silently invert the recent-first contract. Write stamps are strictly increasing per process.
let lastWriteStamp = 0;
function writeStamp(): number {
	const now = Date.now();
	lastWriteStamp = now > lastWriteStamp ? now : lastWriteStamp + 1;
	return lastWriteStamp;
}
export type NoteMatch = { line: number; text: string; /** Code-point offset into the note body, not into the serialized file. */ offsetChars: number };
export type NoteSearchRow = { address: string; scope: Scope; path: string; meta: NoteMeta; matches: NoteMatch[] };
export type EditOperation = { oldText: string; newText: string };
export type WriteOptions = { origin?: Origin };
export type EditOptions = { origin?: Origin; crumpled?: boolean; replaceAll?: boolean; renameTo?: string };
export type NotesQuery = { glob?: string; crumpled?: boolean };
/** A read exposes metadata and the pure body; the serialized frontmatter is never part of the body. */
export type NoteReadResult = { meta: NoteMeta; body: string; resolvedScope: Scope };
export type NoteWriteResult = { meta: NoteMeta; outcome: "created" | "overwrote" | "uncrumpled" };
export type NoteChange =
	| { kind: "none"; before: ""; after: "" }
	| { kind: "body" | "metadata"; before: string; after: string };
export type NoteEditResult = { meta: NoteMeta; applied: number; resolvedScope: Scope; change: NoteChange; moved: boolean; replacedCrumpledTarget: boolean };
export type NoteRenameResult = { meta: NoteMeta; replacedCrumpledTarget: boolean };
/** A home, or one unreadable note inside it, that a status-reporting query could not read. */
export type NoteQueryStatus = { homesUnavailable: string[] };
export type NoteQueryResult<T> = { rows: T[]; status: NoteQueryStatus };

/** Public note identity; named projects also carry their display root and sibling hints. */
export function noteIdentity(identity: NotesIdentity, address: string): { address: string; project_key?: string } & ProjectReceipt {
	const resolved = assertAddress(address);
	return {
		address: addressFor(identity, resolved.scope, noteFileName(resolved.path), resolved.who),
		...(resolved.scope !== "project" ? {} : resolved.who === undefined ? { project_key: identity.projectKey } : projectReceipt(identity.home, resolved.who)),
	};
}

/** Host-neutral, filesystem-backed notes API. */
export interface NotesStore {
	write(address: string, content: string, options?: WriteOptions): Promise<NoteWriteResult>;
	read(address: string): Promise<NoteReadResult | undefined>;
	update(address: string, edits?: EditOperation[], options?: EditOptions): Promise<NoteEditResult>;
	rename(fromAddress: string, toAddress: string): Promise<NoteRenameResult>;
	list(options?: NotesQuery): Promise<NoteRow[]>;
	search(queries: string[], options?: NotesQuery): Promise<NoteSearchRow[]>;
	listWithStatus(options?: NotesQuery): Promise<NoteQueryResult<NoteRow>>;
	searchWithStatus(queries: string[], options?: NotesQuery): Promise<NoteQueryResult<NoteSearchRow>>;
}

const SCOPE_ORDER: readonly Scope[] = ["session", "project", "human", "agent", "model"];

/** Mutations and read-modify-write reads serialize by physical file across all store instances. */
const pathQueues = new Map<string, Promise<void>>();

function withPathQueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const key = resolve(path);
	const previous = pathQueues.get(key) ?? Promise.resolve();
	const result = previous.then(operation);
	const tail = result.then(() => undefined, () => undefined);
	pathQueues.set(key, tail);
	void tail.then(() => {
		if (pathQueues.get(key) === tail) pathQueues.delete(key);
	});
	return result;
}

function errno(error: unknown): string | undefined {
	return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

async function readFileIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (errno(error) === "ENOENT") return undefined;
		throw error;
	}
}

/** Recursively list `.md` files under `dir` as forward-slash virtual paths relative to `base`. */
async function walkMarkdown(dir: string, base = dir): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		// A home that has never been created is normal. Other failures must reach the
		// boot snapshot boundary instead of masquerading as an empty home.
		if (errno(error) === "ENOENT") return [];
		throw error;
	}
	const paths: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const child = join(dir, entry.name);
		if (entry.isDirectory()) paths.push(...await walkMarkdown(child, base));
		else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(child.slice(base.length + 1).split("\\").join("/"));
	}
	return paths;
}

/** Which homes one call iterates; reserved heads narrow traversal before any file is read. */
type HomeRef = { scope: Scope; who?: string };

async function homesForPattern(pattern: string | undefined, identity: NotesIdentity): Promise<HomeRef[] | undefined> {
	if (!pattern || !pattern.startsWith("@")) return undefined;
	const [rawHead, ...tail] = pattern.split("/");
	const head = tail.length === 0 ? undefined : HOME_HEADS.get(rawHead!.slice(1)); // a bare "@projects" names no homes
	if (head === undefined) return [];
	if (head.home === undefined) return [{ scope: head.scope }];
	const name = tail[0];
	if (name !== undefined && name.length > 0 && !/[*?]/.test(name)) return [{ scope: head.scope, who: assertWho(name) }];
	const names = head.home === "project" ? projectHomes(identity.home).map(home => home.name) : await namespaceSlugs(head.home, identity.home);
	return names.map((who) => ({ scope: head.scope, who }));
}

/** Relative pattern heads resolve to canonical names, so they match canonical addresses. */
function normalizePattern(pattern: string | undefined, identity: NotesIdentity): string | undefined {
	if (!pattern) return pattern;
	if (pattern.startsWith("@self/")) return `@agents/${identity.agent}/${pattern.slice("@self/".length)}`;
	if (pattern.startsWith("@model/")) return `@models/${identity.model}/${pattern.slice("@model/".length)}`;
	return pattern;
}

function assertOrigin(value: unknown): Origin {
	if (!isOrigin(value)) throw new NoteError("invalid_origin", `origin must be one of user, self, external (got ${JSON.stringify(value)})`);
	return value;
}

function assertWho(value: unknown): string {
	if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
		throw new NoteError("invalid_scope", "who must be a canonical lowercase slug");
	}
	return value;
}

/**
 * Line numbers (1-based) of every occurrence of `needle` in `body`. The scan walks forward
 * once, counting newlines as it goes, so a body that repeats one anchor thousands of times
 * costs one pass instead of one reslice per match.
 */
function matchLineNumbers(body: string, needle: string): number[] {
	const lines: number[] = [];
	let line = 1;
	let cursor = 0;
	let scanned = 0;
	for (;;) {
		const index = body.indexOf(needle, cursor);
		if (index === -1) break;
		for (; scanned < index; scanned++) {
			if (body.charCodeAt(scanned) === 10) line++;
		}
		lines.push(line);
		cursor = index + Math.max(needle.length, 1);
	}
	return lines;
}

/**
 * How many match lines a refusal names inline. A body can repeat one anchor thousands of
 * times, so the message carries a bounded sample plus the exact total; the typed error keeps
 * the complete list, and the wire bounds what it repeats of it.
 */
const MAX_ANCHOR_LINES = 8;

function anchorLines(lines: number[]): string {
	const named = lines.slice(0, MAX_ANCHOR_LINES);
	const rest = lines.length - named.length;
	return `lines ${named.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
}

/** Every mutation uses a tmp file renamed into place in the same directory. */
async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, content);
		await rename(tmp, path);
	} catch (error) {
		try { await rm(tmp, { force: true }); } catch { /* Preserve the original write/rename failure. */ }
		throw error;
	}
}

/** The byte cap is a write-time boundary rule, never a path-jail rule. */
function assertWritablePath(vpath: string): void {
	const bytes = Buffer.byteLength(vpath, "utf8");
	if (bytes > MAX_NOTE_PATH_BYTES) throw new NoteError("too_large", `Path too long: ${bytes} bytes; the limit is ${MAX_NOTE_PATH_BYTES}.`);
}

/** Rounded up, so a note just over the limit never reads as exactly at it. */
function megabytes(bytes: number): string {
	return `${Math.ceil(bytes / 10_000) / 100} MB`;
}

function assertSerializedSize(content: string): void {
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_NOTE_BYTES) throw new NoteError("too_large", `This note would be ${megabytes(bytes)}, over the ${megabytes(MAX_NOTE_BYTES)} limit per note; split it into several notes.`);
}

/** Frontmatter block only (the body separator stripped), for metadata-only change inputs. */
function frontmatterOf(meta: NoteMeta): string {
	return serializeNote(meta, "").slice(0, -2);
}

/** Explicit project homes are always read-only; agent/model homes allow their owner. */
function assertWritableHome(scope: Scope, who: string | undefined, identity: NotesIdentity): void {
	if (who === undefined) return;
	if (scope === "project") throw new NoteError("invalid_scope", `@projects/${who}/ is read-only; use @project/ to write to your own project.`);
	const current = scope === "agent" ? identity.agent : identity.model;
	if (who === current) return;
	const home = scope === "agent" ? `@agents/${who}/` : `@models/${who}/`;
	throw new NoteError("invalid_scope", `${home} is someone else's home; you can write to this session, @project/, @human/, @self/, or @model/.`);
}

/** Create a store over one validated, immutable snapshot of the supplied explicit identity. */
export function createNotesStore(input: NotesIdentity): NotesStore {
	const identity = snapshotNotesIdentity(input);

	async function write(address: string, content: string, options: WriteOptions = {}): Promise<NoteWriteResult> {
		const stableOptions = { ...options };
		const destination = assertAddress(address);
		assertWritablePath(destination.path);
		const scope = destination.scope;
		assertWritableHome(scope, destination.who, identity);
		// Absent means "keep whatever the note already says": replacing a note must not silently
		// re-attribute a user-written note to the agent that happened to rewrite it.
		const origin = stableOptions.origin === undefined ? undefined : assertOrigin(stableOptions.origin);
		const path = physicalPath(scope, destination.path, identity, destination.who);
		return withPathQueue(path, async () => {
			const now = writeStamp();
			const cleanBody = stripLeadingFrontmatter(content);
			const existingRaw = await readFileIfExists(path);
			const existing = existingRaw === undefined ? undefined : parseNote(existingRaw, now).meta;
			const outcome = existing === undefined ? "created" : existing.crumpledAt === undefined ? "overwrote" : "uncrumpled";
			const meta: NoteMeta = existing ?? {
				scope,
				origin: origin ?? "self",
				createdAt: now,
				updatedAt: now,
				lastAccessed: now,
				accessCount: 0,
				...(scope === "session" ? { project: identity.projectKey } : {}),
			};
			meta.scope = scope;
			if (origin !== undefined) meta.origin = origin;
			delete meta.crumpledAt;
			meta.updatedAt = now;
			const serialized = serializeNote(meta, cleanBody);
			assertSerializedSize(serialized);
			await atomicWrite(path, serialized);
			return { meta, outcome };
		});
	}

	async function read(address: string): Promise<NoteReadResult | undefined> {
		const destination = assertAddress(address);
		const scope = destination.scope;
		const path = physicalPath(scope, destination.path, identity, destination.who);
		return withPathQueue(path, async () => {
			const raw = await readFileIfExists(path);
			if (raw === undefined) return undefined;
			const now = Date.now();
			const parsed = parseNote(raw, now);
			if (scope === "project" && destination.who !== undefined) return { meta: { ...parsed.meta, scope }, body: parsed.body, resolvedScope: scope };
			// A read records its own access, exactly as a write records an edit.
			const meta: NoteMeta = { ...parsed.meta, scope, lastAccessed: now, accessCount: (typeof parsed.meta.accessCount === "number" ? parsed.meta.accessCount : 0) + 1 };
			await atomicWrite(path, serializeNote(meta, parsed.body));
			return { meta, body: parsed.body, resolvedScope: scope };
		});
	}

	async function update(address: string, edits?: EditOperation[], options: EditOptions = {}): Promise<NoteEditResult> {
		const operations = edits === undefined ? [] : edits.map((operation) => ({ ...operation }));
		const stableOptions = { ...options };
		const from = assertAddress(address);
		const destination = stableOptions.renameTo === undefined ? from : assertAddress(stableOptions.renameTo);
		assertWritablePath(destination.path);
		const scope = destination.scope;
		assertWritableHome(from.scope, from.who, identity);
		assertWritableHome(scope, destination.who, identity);
		if (operations.length === 0 && stableOptions.origin === undefined && stableOptions.crumpled === undefined && stableOptions.renameTo === undefined) {
			throw new NoteError("nothing_to_do", "Nothing to change: pass edits, origin, crumpled, or renameTo.");
		}
		const fromPath = physicalPath(from.scope, from.path, identity, from.who);
		const path = physicalPath(scope, destination.path, identity, destination.who);
		const moved = resolve(fromPath) !== resolve(path);
		const mutate = async (): Promise<NoteEditResult> => {
			const raw = await readFileIfExists(fromPath);
			if (raw === undefined) throw new NoteError("not_found", `No note at ${noteIdentity(identity, address).address}.`);
			const targetRaw = moved ? await readFileIfExists(path) : undefined;
			if (targetRaw !== undefined && parseNote(targetRaw).meta.crumpledAt === undefined) {
				throw new NoteError("already_exists", `${noteIdentity(identity, stableOptions.renameTo!).address} already holds a note; crumple it first or pick another address.`);
			}
			const { meta, body } = parseNote(raw);
			const beforeMeta: NoteMeta = { ...meta };
			meta.scope = scope;
			if (from.scope !== "session" && scope === "session") meta.project = identity.projectKey;
			if (from.scope === "session" && scope !== "session") delete meta.project;
			let next = body;
			let applied = 0;
			operations.forEach((operation, index) => {
				const oldText = operation?.oldText;
				const newText = operation?.newText;
				if (typeof oldText !== "string" || oldText.length === 0) throw new NoteError("invalid_edit", `edits[${index}].oldText must be a non-empty string.`, { editIndex: index });
				if (typeof newText !== "string") throw new NoteError("invalid_edit", `edits[${index}].newText must be a string.`, { editIndex: index });
				const lines = matchLineNumbers(next, oldText);
				if (lines.length === 0) throw new NoteError("no_match", `edits[${index}].oldText isn't in the note${index > 0 ? " (after the earlier edits)" : ""}. Nothing was saved.`, { editIndex: index });
				if (lines.length > 1 && !stableOptions.replaceAll) {
					throw new NoteError("ambiguous_edit", `edits[${index}].oldText appears ${lines.length} times (${anchorLines(lines)}); add surrounding text to pick one, or set replace_all. Nothing was saved.`, { lineNumbers: lines, editIndex: index });
				}
				if (oldText !== newText) applied++;
				// Positional splicing preserves user replacement text byte-for-byte.
				if (stableOptions.replaceAll) next = next.split(oldText).join(newText);
				else {
					const matchIndex = next.indexOf(oldText);
					next = next.substring(0, matchIndex) + newText + next.substring(matchIndex + oldText.length);
				}
			});
			if (stableOptions.origin !== undefined) meta.origin = assertOrigin(stableOptions.origin);
			if (stableOptions.crumpled === true && meta.crumpledAt === undefined) meta.crumpledAt = localIso(Date.now());
			if (stableOptions.crumpled === false) delete meta.crumpledAt;
			const bodyChanged = body !== next;
			const originChanged = beforeMeta.origin !== meta.origin;
			if (bodyChanged || originChanged || moved) meta.updatedAt = writeStamp();
			const serialized = serializeNote(meta, next);
			assertSerializedSize(serialized);
			const metadataChanged = originChanged || beforeMeta.crumpledAt !== meta.crumpledAt;
			let change: NoteChange;
			// A body edit that also rewrites frontmatter is still a body change; its diff inputs span the
			// whole serialized file, so the frontmatter part stays visible in the diff.
			if (bodyChanged && (metadataChanged || moved)) change = { kind: "body", before: raw, after: serialized };
			else if (bodyChanged) change = { kind: "body", before: body, after: next };
			else if (metadataChanged) change = { kind: "metadata", before: frontmatterOf(beforeMeta), after: frontmatterOf(meta) };
			else change = { kind: "none", before: "", after: "" };
			await atomicWrite(path, serialized);
			if (moved) await rm(fromPath, { force: true });
			return { meta, applied, resolvedScope: scope, change, moved, replacedCrumpledTarget: targetRaw !== undefined };
		};
		// One lock for aliases of the same file; otherwise take both in stable order.
		if (!moved) return withPathQueue(path, mutate);
		const [first, second] = [fromPath, path].sort();
		return withPathQueue(first!, () => withPathQueue(second!, mutate));
	}

	/** Moving alone shares validation and persistence with a combined edit-and-move. */
	async function rename(fromAddress: string, toAddress: string): Promise<NoteRenameResult> {
		const { meta, replacedCrumpledTarget } = await update(fromAddress, undefined, { renameTo: toAddress });
		return { meta, replacedCrumpledTarget };
	}

	async function* scan(options: NotesQuery, status?: NoteQueryStatus): AsyncGenerator<Omit<NoteRow, "sizeBytes">> {
		const pattern = normalizePattern(options.glob, identity);
		const normalized = assertGlobPattern(pattern);
		const matcher = normalized === undefined ? undefined : globToRegExp(normalized);
		let homes: HomeRef[];
		try {
			homes = await homesForPattern(normalized, identity) ?? SCOPE_ORDER.map((scope) => ({ scope }));
		} catch (error) {
			if (!status || !isFilesystemError(error) || !/^@(projects|agents|models)\//.test(options.glob ?? "")) throw error;
			status.homesUnavailable.push(options.glob!.split("/")[0]!);
			return;
		}
		for (const home of homes) {
			const scope = home.scope;
			const root = scopeDir(scope, identity, home.who);
			let paths: string[];
			try {
				paths = await walkMarkdown(root);
			} catch (error) {
				if (!status || !isFilesystemError(error)) throw error;
				status.homesUnavailable.push(addressFor(identity, scope, "", home.who).replace(/\/$/, "") || "session");
				continue;
			}
			for (const path of paths) {
				if (matcher && !matcher.test(canonicalAddressFor(identity, scope, path, home.who))) continue;
				const address = addressFor(identity, scope, path, home.who);
				const fullPath = join(root, path);
				let raw: string;
				try {
					raw = await withPathQueue(fullPath, () => readFile(fullPath, "utf8"));
				} catch (error) {
					// One unreadable note is named on its own; its home's readable notes still list.
					if (!status || !isFilesystemError(error)) throw error;
					status.homesUnavailable.push(address);
					continue;
				}
				const { meta, body } = parseNote(raw);
				meta.scope = scope;
				if ((meta.crumpledAt !== undefined) !== (options.crumpled === true)) continue;
				yield { address, scope, path, meta, body };
			}
		}
	}

	async function list(options: NotesQuery = {}): Promise<NoteRow[]> {
		return (await listRows(options)).rows;
	}

	async function listRows(options: NotesQuery, status?: NoteQueryStatus): Promise<NoteQueryResult<NoteRow>> {
		const stableOptions = { ...options } as NotesQuery;
		const rows: NoteRow[] = [];
		for await (const row of scan(stableOptions, status)) {
			rows.push({ ...row, sizeBytes: Buffer.byteLength(row.body, "utf8") });
		}
		rows.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt || a.address.localeCompare(b.address));
		return { rows, status: status ?? { homesUnavailable: [] } };
	}

	function listWithStatus(options: NotesQuery = {}): Promise<NoteQueryResult<NoteRow>> {
		return listRows(options, { homesUnavailable: [] });
	}

	async function search(queries: string[], options: NotesQuery = {}): Promise<NoteSearchRow[]> {
		return (await searchRows(queries, options)).rows;
	}

	async function searchRows(queries: string[], options: NotesQuery, status?: NoteQueryStatus): Promise<NoteQueryResult<NoteSearchRow>> {
		const stableQueries = [...queries];
		const stableOptions = { ...options } as NotesQuery;
		const rows: NoteSearchRow[] = [];
		for await (const note of scan(stableOptions, status)) {
			const { address, path, scope, meta, body } = note;
			if (stableQueries.length === 0) {
				rows.push({ address, path, scope, meta, matches: [] });
				continue;
			}
			// Offsets address the note body alone: no frontmatter length is predicted, so an
			// access-counter rewrite cannot move a match out from under the caller.
			let baseChars = 0;
			const matches: NoteMatch[] = [];
			for (const [index, line] of body.split("\n").entries()) {
				const offset = earliestMatchOffsetChars(line, stableQueries);
				if (offset >= 0) {
					matches.push({ line: index + 1, text: line, offsetChars: baseChars + offset });
				}
				baseChars += Array.from(line).length + 1;
			}
			if (matches.length > 0) rows.push({ address, path, scope, meta, matches });
		}
		rows.sort((a, b) => a.address.localeCompare(b.address));
		return { rows, status: status ?? { homesUnavailable: [] } };
	}

	function searchWithStatus(queries: string[], options: NotesQuery = {}): Promise<NoteQueryResult<NoteSearchRow>> {
		return searchRows(queries, options, { homesUnavailable: [] });
	}

	return { write, read, update, rename, list, search, listWithStatus, searchWithStatus };
}
