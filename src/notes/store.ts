import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { earliestMatchOffsetChars } from "../text-match.js";
import { assertAddress, assertGlobPattern, addressFor, canonicalAddressFor, globToRegExp, NAMESPACE_HEADS } from "./address.js";
import { isFilesystemError } from "./fs-error.js";
import { snapshotNotesIdentity, type NotesIdentity } from "./identity.js";
import { NoteError } from "./errors.js";
import { MAX_NOTE_BYTES, MAX_NOTE_PATH_BYTES } from "./constants.js";
import { isOrigin, localIso, parseNote, serializeNote, stripLeadingFrontmatter, type NoteMeta, type Origin } from "./frontmatter.js";
import { namespaceSlugs, noteFileName, physicalPath, scopeDir, isSessionId, SLUG_PATTERN, type Scope } from "./paths.js";
import { projectReceipt, type ProjectReceipt } from "./project-namespace.js";

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
/** Omitted/null/empty glob or bare @default selects current notebooks; explicit globs match full addresses.
 * Only the current session also matches its bare-path alias (e.g. *.md or deep/**).
 */
export type NotesQuery = { glob?: string | null; crumpled?: boolean };
/** A read exposes metadata and the pure body; the serialized frontmatter is never part of the body. */
export type NoteReadResult = { meta: NoteMeta; body: string; resolvedScope: Scope };
export type NoteWriteResult = { meta: NoteMeta; outcome: "created" | "overwrote" | "uncrumpled" };
export type NoteChange =
	| { kind: "none"; before: ""; after: "" }
	| { kind: "body" | "metadata"; before: string; after: string };
export type NoteEditResult = { meta: NoteMeta; applied: number; resolvedScope: Scope; change: NoteChange; moved: boolean; replacedCrumpledTarget: boolean };
export type NoteRenameResult = { meta: NoteMeta; replacedCrumpledTarget: boolean };
/** A notebook, or one unreadable note inside it, that a status-reporting query could not read. */
export type NoteQueryStatus = { namespacesUnavailable: string[] };
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
	/** Physically delete one crumpled note; only a dreaming identity may call it. */
	forget(address: string): Promise<NoteMeta>;
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
		// A notebook that has never been created is normal. Other failures must reach the
		// boot snapshot boundary instead of masquerading as an empty notebook.
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

/** Which namespaces one call iterates; reserved heads narrow traversal before any file is read. */
type NamespaceRef = { scope: Scope; who?: string };

async function namespacesForPattern(pattern: string | undefined, identity: NotesIdentity, status?: NoteQueryStatus): Promise<NamespaceRef[]> {
	if (pattern === undefined) return SCOPE_ORDER.map((scope) => ({ scope }));

	const families = [
		{ scope: "session", dir: "sessions", current: identity.sessionId },
		{ scope: "project", dir: "project", current: identity.projectKey },
		{ scope: "agent", dir: "agents", current: identity.agent },
		{ scope: "model", dir: "models", current: identity.model },
	] as const;
	async function enumerate(family: typeof families[number], relative: boolean): Promise<NamespaceRef[]> {
		let names: string[];
		try {
			names = await namespaceSlugs(family.dir, identity.home);
		} catch (error) {
			if (!status || !isFilesystemError(error)) throw error;
			status.namespacesUnavailable.push(`@${family.dir === "project" ? "projects" : family.dir}`);
			return [];
		}
		// Include the current namespace even when missing or a non-directory, and only once.
		return [...new Set([family.current, ...names])].map((who) => ({
			scope: family.scope,
			who: relative && who === family.current ? undefined : who,
		}));
	}

	if (pattern.startsWith("@")) {
		const [rawHead, ...tail] = pattern.slice(1).split("/");
		if (!/[*?]/.test(rawHead!)) {
			const head = NAMESPACE_HEADS.get(rawHead!);
			if (head === undefined || tail.length === 0) return [];
			if (head.dir === undefined) return [{ scope: head.scope }];
			const name = tail[0];
			if (name && !/[*?]/.test(name)) return [{ scope: head.scope, who: assertWho(name, head.scope) }];
			return enumerate(families.find((family) => family.dir === head.dir)!, false);
		}
	}
	// Unreserved patterns see the full universe, not just the current identities.
	const namespaces: NamespaceRef[] = [];
	for (const scope of SCOPE_ORDER) {
		if (scope === "human") namespaces.push({ scope });
		else namespaces.push(...await enumerate(families.find((family) => family.scope === scope)!, true));
	}
	return namespaces;
}

/** Relative pattern heads resolve to canonical names, so they match canonical addresses. */
function normalizePattern(pattern: string | undefined, identity: NotesIdentity): string | undefined {
	if (!pattern) return pattern;
	if (pattern.startsWith("@project/")) return `@projects/${identity.projectKey}/${pattern.slice("@project/".length)}`;
	if (pattern.startsWith("@self/")) return `@agents/${identity.agent}/${pattern.slice("@self/".length)}`;
	if (pattern.startsWith("@model/")) return `@models/${identity.model}/${pattern.slice("@model/".length)}`;
	return pattern;
}

function assertOrigin(value: unknown): Origin {
	if (!isOrigin(value)) throw new NoteError("invalid_origin", `origin must be one of user, self, external (got ${JSON.stringify(value)})`);
	return value;
}

function assertWho(value: unknown, scope: Scope): string {
	if (typeof value !== "string" || !(scope === "session" ? isSessionId(value) : SLUG_PATTERN.test(value))) {
		throw new NoteError("invalid_scope", scope === "session" ? "session id must be a safe single directory component" : "who must be a canonical lowercase slug");
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

/** Explicit session/project namespaces are read-only unless dreamed over; agent/model namespaces allow their owner. */
function assertWritableNamespace(scope: Scope, who: string | undefined, identity: NotesIdentity): void {
	if (who === undefined) return;
	// A dreamed project is writable whole; project and session ownership is checked per note by assertDreamNote.
	if (identity.dreaming !== undefined && (scope === "session" || (scope === "project" && who === identity.dreaming))) return;
	if (scope === "session") throw new NoteError("invalid_scope", `@sessions/${who}/ is read-only; use a bare path to write to this session.`);
	if (scope === "project") throw new NoteError("invalid_scope", `@projects/${who}/ is read-only; use @project/ to write to your own project.`);
	const current = scope === "agent" ? identity.agent : identity.model;
	if (who === current) return;
	const address = scope === "agent" ? `@agents/${who}/` : `@models/${who}/`;
	throw new NoteError("invalid_scope", `${address} is someone else's notebook; you can write to this session, @project/, @human/, @self/, or @model/.`);
}

/** Resolve aliases before checking that a dreamed note belongs to the open project. */
function assertDreamNote(scope: Scope, who: string | undefined, identity: NotesIdentity, raw: string | undefined, address: string): void {
	if (identity.dreaming === undefined || (scope !== "session" && scope !== "project")) return;
	const project = scope === "project" ? who ?? identity.projectKey
		: raw !== undefined ? parseNote(raw).meta.project
		: who === undefined ? identity.projectKey : undefined;
	if (project === identity.dreaming) return;
	throw new NoteError("invalid_scope", raw === undefined && scope === "session" && who !== undefined
		? `${address}: a dream edits other sessions' existing notes, it doesn't create new ones there.`
		: `${address} belongs to another project, not the one being dreamed over (${identity.dreaming}).`);
}

/** Create a store over one validated, immutable snapshot of the supplied explicit identity. */
export function createNotesStore(input: NotesIdentity): NotesStore {
	const identity = snapshotNotesIdentity(input);

	async function write(address: string, content: string, options: WriteOptions = {}): Promise<NoteWriteResult> {
		const stableOptions = { ...options };
		const destination = assertAddress(address);
		assertWritablePath(destination.path);
		const scope = destination.scope;
		assertWritableNamespace(scope, destination.who, identity);
		// Absent means "keep whatever the note already says": replacing a note must not silently
		// re-attribute a user-written note to the agent that happened to rewrite it.
		const origin = stableOptions.origin === undefined ? undefined : assertOrigin(stableOptions.origin);
		const path = physicalPath(scope, destination.path, identity, destination.who);
		return withPathQueue(path, async () => {
			const now = writeStamp();
			const cleanBody = stripLeadingFrontmatter(content);
			const existingRaw = await readFileIfExists(path);
			assertDreamNote(scope, destination.who, identity, existingRaw, address);
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
			// Named notebooks, and every read during a dream, leave no access stamp.
			if (identity.dreaming !== undefined || ((scope === "project" || scope === "session") && destination.who !== undefined)) return { meta: { ...parsed.meta, scope }, body: parsed.body, resolvedScope: scope };
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
		assertWritableNamespace(from.scope, from.who, identity);
		assertWritableNamespace(scope, destination.who, identity);
		if (operations.length === 0 && stableOptions.origin === undefined && stableOptions.crumpled === undefined && stableOptions.renameTo === undefined) {
			throw new NoteError("nothing_to_do", "Nothing to change: provide edits, an origin, a crumpled state, or a new address.");
		}
		const fromPath = physicalPath(from.scope, from.path, identity, from.who);
		const path = physicalPath(scope, destination.path, identity, destination.who);
		const differentPaths = resolve(fromPath) !== resolve(path);
		const mutate = async (): Promise<NoteEditResult> => {
			const raw = await readFileIfExists(fromPath);
			if (raw === undefined) throw new NoteError("not_found", `No note at ${noteIdentity(identity, address).address}.`);
			const targetRaw = differentPaths ? await readFileIfExists(path) : undefined;
			assertDreamNote(from.scope, from.who, identity, raw, address);
			if (differentPaths) assertDreamNote(scope, destination.who, identity, targetRaw, stableOptions.renameTo!);
			// Case and symlink aliases must not turn write-then-remove into deleting the result.
			const sourceReal = targetRaw === undefined ? undefined : await realpath(fromPath);
			const sameFile = sourceReal !== undefined && sourceReal === await realpath(path);
			const moved = differentPaths && !sameFile;
			if (moved && targetRaw !== undefined && parseNote(targetRaw).meta.crumpledAt === undefined) {
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
			await atomicWrite(sameFile ? sourceReal! : path, serialized);
			if (moved) await rm(fromPath, { force: true });
			return { meta, applied, resolvedScope: scope, change, moved, replacedCrumpledTarget: moved && targetRaw !== undefined };
		};
		// Exact aliases share one queue; other spellings lock both paths in stable order.
		if (!differentPaths) return withPathQueue(path, mutate);
		const [first, second] = [fromPath, path].sort();
		return withPathQueue(first!, () => withPathQueue(second!, mutate));
	}

	/** Moving alone shares validation and persistence with a combined edit-and-move. */
	async function rename(fromAddress: string, toAddress: string): Promise<NoteRenameResult> {
		const { meta, replacedCrumpledTarget } = await update(fromAddress, undefined, { renameTo: toAddress });
		return { meta, replacedCrumpledTarget };
	}

	async function forget(address: string): Promise<NoteMeta> {
		if (identity.dreaming === undefined) throw new NoteError("invalid_scope", "Only a dream can delete notes; begin one first.");
		const target = assertAddress(address);
		assertWritableNamespace(target.scope, target.who, identity);
		const path = physicalPath(target.scope, target.path, identity, target.who);
		return withPathQueue(path, async () => {
			const raw = await readFileIfExists(path);
			if (raw === undefined) throw new NoteError("not_found", `No note at ${noteIdentity(identity, address).address}.`);
			assertDreamNote(target.scope, target.who, identity, raw, address);
			const { meta } = parseNote(raw);
			if (meta.crumpledAt === undefined) throw new NoteError("not_crumpled", `${noteIdentity(identity, address).address} isn't crumpled; crumple it before deleting.`);
			await unlink(path);
			return { ...meta, scope: target.scope };
		});
	}

	async function* scan(options: NotesQuery, status?: NoteQueryStatus): AsyncGenerator<Omit<NoteRow, "sizeBytes">> {
		const glob = assertGlobPattern(options.glob);
		const pattern = glob === "@default" ? undefined : glob;
		const normalized = normalizePattern(pattern, identity);
		const matcher = normalized === undefined ? undefined : globToRegExp(normalized);
		const namespaces = await namespacesForPattern(pattern, identity, status);
		for (const namespace of namespaces) {
			const scope = namespace.scope;
			const root = scopeDir(scope, identity, namespace.who);
			let paths: string[];
			try {
				paths = await walkMarkdown(root);
			} catch (error) {
				if (!status || !isFilesystemError(error)) throw error;
				status.namespacesUnavailable.push(addressFor(identity, scope, "", namespace.who).replace(/\/$/, "") || "session");
				continue;
			}
			for (const path of paths) {
				if (matcher && !matcher.test(canonicalAddressFor(identity, scope, path, namespace.who))
					&& !(scope === "session" && namespace.who === undefined && !pattern!.startsWith("@") && matcher.test(path))) continue;
				const address = addressFor(identity, scope, path, namespace.who);
				const fullPath = join(root, path);
				let raw: string;
				try {
					raw = await withPathQueue(fullPath, () => readFile(fullPath, "utf8"));
				} catch (error) {
					// One unreadable note is named on its own; its notebook's readable notes still list.
					if (!status || !isFilesystemError(error)) throw error;
					status.namespacesUnavailable.push(address);
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
		return { rows, status: status ?? { namespacesUnavailable: [] } };
	}

	function listWithStatus(options: NotesQuery = {}): Promise<NoteQueryResult<NoteRow>> {
		return listRows(options, { namespacesUnavailable: [] });
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
		return { rows, status: status ?? { namespacesUnavailable: [] } };
	}

	function searchWithStatus(queries: string[], options: NotesQuery = {}): Promise<NoteQueryResult<NoteSearchRow>> {
		return searchRows(queries, options, { namespacesUnavailable: [] });
	}

	return { write, read, update, rename, forget, list, search, listWithStatus, searchWithStatus };
}
