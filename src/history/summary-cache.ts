/** Strict offline overview summaries, never projections or search indexes. Cache failures are misses. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { sessionIdentity, type HistorySession, type HistorySessionData, type HistorySessionRepresentative } from "./corpus.js";
import { HistoryRoleSchema, ToolCallStatusSchema } from "./history.js";
import { sessionRepresentative } from "./query.js";
import { validateCodexLineageSources, type CodexLineageSource } from "./codex-transcript.js";

// Bump whenever strict decoding, representative selection, or cached event presentation changes.
const VERSION = "strict-representative-v1";
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const FingerprintSchema = Type.Object({
	path: Type.String(), dev: Type.String(), ino: Type.String(), size: Type.String(), mtimeNs: Type.String(), ctimeNs: Type.String(),
}, { additionalProperties: false });
type Fingerprint = Static<typeof FingerprintSchema>;
const EventSchema = Type.Object({
	seq: Type.Integer({ minimum: 1 }), windowId: Type.String(), role: HistoryRoleSchema,
	createdAt: Type.Optional(Type.String()), text: Type.String(),
	execution: Type.Optional(Type.Object({
		name: Type.String(), status: ToolCallStatusSchema,
		arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		outputTruncated: Type.Optional(Type.Boolean()), fullOutputPath: Type.Optional(Type.String()),
		nestedCalls: Type.Optional(Type.Object({ complete: Type.Boolean(), calls: Type.Array(Type.Object({
			id: Type.String(), name: Type.String(), status: ToolCallStatusSchema,
			arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())), argumentsBytes: Type.Optional(Type.Number()),
			durationMs: Type.Optional(Type.Number()), error: Type.Optional(Type.String()),
		}, { additionalProperties: false })) }, { additionalProperties: false })),
	}, { additionalProperties: false })),
}, { additionalProperties: false });
const EntrySchema = Type.Object({
	version: Type.Literal(VERSION), path: Type.String(), session: Type.String(),
	event: Type.Union([EventSchema, Type.Null()]), notice: Type.Optional(Type.String()),
	fingerprints: Type.Array(FingerprintSchema, { minItems: 1, maxItems: 64 }),
	lineageSources: Type.Array(Type.Object({ home: Type.String(), rolloutId: Type.String(), path: Type.String() }, { additionalProperties: false }), { maxItems: 63 }),
}, { additionalProperties: false });

/** Internal root selection; the host's home/env seams also keep filesystem tests hermetic. */
export function historySummaryCacheRoot(home = homedir(), env = process.env, platform = process.platform): string {
	return platform === "darwin" ? join(home, "Library/Caches/notesoup/history") : join(env.XDG_CACHE_HOME || join(home, ".cache"), "notesoup/history");
}

async function fingerprint(path: string): Promise<Fingerprint> {
	const info = await stat(path, { bigint: true });
	if (!info.isFile()) throw new Error("Not a regular transcript file");
	return { path, dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) };
}
async function unchanged(sources: Fingerprint[]): Promise<boolean> {
	for (const source of sources) if (JSON.stringify(await fingerprint(source.path)) !== JSON.stringify(source)) return false;
	return true;
}

/** One fingerprint per actual decoder read, in root-to-ancestor order; no untracked witnesses. */
function completeDependencies(path: string, harness: HistorySession["harness"], sources: Fingerprint[], lineage: CodexLineageSource[]): boolean {
	if (harness !== "codex" && lineage.length !== 0) return false;
	const expected = [path, ...lineage.map((source) => source.path)];
	return sources.length === expected.length && new Set(expected).size === expected.length && sources.every((source, index) => source.path === expected[index]);
}

async function readEntry(path: string): Promise<unknown> {
	const file = await open(path, "r");
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > MAX_ENTRY_BYTES) return undefined;
		const buffer = Buffer.alloc(info.size + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_ENTRY_BYTES || (await file.stat()).size > MAX_ENTRY_BYTES) return undefined;
		return JSON.parse(buffer.toString("utf8", 0, bytesRead));
	} finally { await file.close(); }
}

export type RepresentativeLoad = (track: (path: string) => Promise<void>) => Promise<{ data: HistorySessionData; lineageSources?: CodexLineageSource[] }>;

/** The loader always runs the strict decoder on misses; transcript errors deliberately escape. */
export async function cachedSessionRepresentative(
	session: Pick<HistorySession, "harness" | "id">, transcriptPath: string, cacheRoot: string, load: RepresentativeLoad,
): Promise<HistorySessionRepresentative> {
	let canonical: string | undefined, cachePath: string | undefined;
	const identity = sessionIdentity(session);
	try {
		canonical = await realpath(transcriptPath);
		cachePath = join(cacheRoot, createHash("sha256").update(JSON.stringify([VERSION, canonical, session.harness, session.id])).digest("hex") + ".json");
		const entry = await readEntry(cachePath);
		if (Check(EntrySchema, entry) && entry.path === canonical && entry.session === identity
			&& completeDependencies(canonical, session.harness, entry.fingerprints, entry.lineageSources)
			&& await validateCodexLineageSources(entry.lineageSources) && await unchanged(entry.fingerprints)
			&& await realpath(transcriptPath) === canonical) {
			return { event: entry.event === null ? undefined : { ...entry.event, createdAt: entry.event.createdAt }, notice: entry.notice };
		}
	} catch { /* Absent/corrupt/unwritable cache or changed source: strict load below. */ }

	const fingerprints = new Map<string, Fingerprint>();
	let stable = canonical !== undefined;
	const track = async (path: string) => {
		try { if (!fingerprints.has(path)) fingerprints.set(path, await fingerprint(path)); }
		catch { stable = false; }
	};
	if (canonical) await track(canonical);
	const { data, lineageSources = [] } = await load(track);
	const event = sessionRepresentative(data.projection, {});
	const result = { event, notice: data.notice };
	try {
		const sources = [...fingerprints.values()];
		if (!stable || !canonical || !cachePath || !completeDependencies(canonical, session.harness, sources, lineageSources)
			|| !await validateCodexLineageSources(lineageSources) || !await unchanged(sources) || await realpath(transcriptPath) !== canonical) return result;
		const entry = JSON.stringify({ version: VERSION, path: canonical, session: identity, event: event ?? null, notice: data.notice, fingerprints: sources, lineageSources });
		if (Buffer.byteLength(entry) > MAX_ENTRY_BYTES) return result;
		await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
		const temporary = `${cachePath}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, entry, { flag: "wx", mode: 0o600 });
			await rename(temporary, cachePath);
		} finally { await unlink(temporary).catch(() => {}); }
	} catch { /* The cache cannot turn readable history into a refusal. */ }
	return result;
}
