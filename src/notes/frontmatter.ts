import type { Scope } from "./paths.js";

export type Origin = "user" | "self" | "external";

/**
 * Harness-owned note metadata. The eight required keys are always written; the four optional
 * sleep-shift keys survive this layer untouched when present. `[key: string]: unknown` carries
 * any frontmatter key this layer does not know, preserved verbatim across rewrites.
 */
export type NoteMeta = {
	scope: Scope;
	origin: Origin;
	/** Present only while the note is in the wastebasket; serialized as an ISO timestamp. */
	crumpledAt?: string;
	createdAt: number;
	updatedAt: number;
	lastAccessed: number;
	accessCount: number;
	sourceWindow?: string;
	supersedes?: string;
	recurrenceCount?: number;
	recurrenceWindows?: string[];
	/** Project ownership on newly-created session notes; legacy/invalid values are preserved as-is. */
	project?: unknown;
	[key: string]: unknown;
};

const SCOPES: readonly Scope[] = ["session", "project", "human", "agent", "model"];
const ORIGINS: readonly Origin[] = ["user", "self", "external"];
const TIMESTAMP_KEYS = ["createdAt", "updatedAt", "lastAccessed"] as const;
/** Emission order, exactly the Design's key list. */
const KNOWN_KEYS = ["origin", "crumpledAt", "createdAt", "updatedAt", "lastAccessed", "accessCount", "sourceWindow", "supersedes", "recurrenceCount", "recurrenceWindows"] as const;

const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * Format epoch milliseconds as an ISO 8601 string in the host's local time zone with an
 * explicit numeric offset (e.g. 2026-09-15T17:31:45.392+08:00). A UTC host renders
 * "+00:00"; the "Z" designator is never used, and Date.parse round-trips the value.
 */
export function localIso(epochMs: number): string {
	const date = new Date(epochMs);
	const offsetMinutes = -date.getTimezoneOffset();
	const absOffset = Math.abs(offsetMinutes);
	const offset = `${offsetMinutes < 0 ? "-" : "+"}${pad2(Math.floor(absOffset / 60))}:${pad2(absOffset % 60)}`;
	const wallClock = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
	return `${wallClock}${offset}`;
}

export function isScope(value: unknown): value is Scope {
	return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

export function isOrigin(value: unknown): value is Origin {
	return typeof value === "string" && (ORIGINS as readonly string[]).includes(value);
}

function toEpoch(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

/** A frontmatter scalar encoded as JSON, falling back to a plain string for hand-written YAML. */
function parseScalar(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed === "") return "";
	try {
		return JSON.parse(trimmed);
	} catch {
		if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
		return trimmed;
	}
}

/**
 * Split raw file text into its frontmatter fields and body. When the file does not open with
 * a closed `---` block, the whole text is body and the field map is empty.
 */
function parseFrontmatter(raw: string): { fields: Record<string, unknown>; body: string } {
	const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
	const lines = stripped.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (lines[0]?.trim() !== "---") return { fields: {}, body: raw };
	let close = -1;
	for (let index = 1; index < lines.length; index++) {
		if (lines[index]?.trim() === "---") {
			close = index;
			break;
		}
	}
	if (close === -1) return { fields: {}, body: raw };
	const fields = Object.create(null) as Record<string, unknown>;
	for (let index = 1; index < close; index++) {
		const line = lines[index]!;
		const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1]!;
		const rest = match[2]!;
		if (rest.trim() === "") {
			// A bare key opens a block sequence of `- item` lines, the only multi-line shape we parse.
			const items: unknown[] = [];
			while (index + 1 < close && /^\s*-\s+/.test(lines[index + 1]!)) {
				index++;
				items.push(parseScalar(lines[index]!.replace(/^\s*-\s+/, "")));
			}
			fields[key] = items;
		} else {
			fields[key] = parseScalar(rest);
		}
	}
	const rest = lines.slice(close + 1);
	if (rest[0] === "") rest.shift();
	return { fields, body: rest.join("\n") };
}

/**
 * Parse a note file. Missing known keys take the defaults (accessCount 0, timestamps now);
 * crumpledAt stays absent until explicitly set, and unknown keys survive untouched.
 */
export function parseNote(raw: string, now = Date.now()): { meta: NoteMeta; body: string } {
	const { fields, body } = parseFrontmatter(raw);
	const meta = { ...fields } as Record<string, unknown>;
	// scope is a legacy on-disk field: store callers derive it from the file's notebook and
	// overwrite it after parsing, so an absent or outdated value just falls back.
	meta.scope = isScope(meta.scope) ? meta.scope : "session";
	meta.origin = isOrigin(meta.origin) ? meta.origin : "self";
	for (const key of TIMESTAMP_KEYS) meta[key] = toEpoch(meta[key], now);
	meta.accessCount = typeof meta.accessCount === "number" && Number.isFinite(meta.accessCount) ? meta.accessCount : 0;
	return { meta: meta as NoteMeta, body };
}

/**
 * Emit a YAML scalar: bare for safe strings and JSON literals, JSON-quoted otherwise.
 * A quoted string must not come back as another type: a value that `JSON.parse` reads as a
 * non-string (`"1"`, `"1e5"`) is always emitted quoted, so an unknown key survives a rewrite
 * with its type intact.
 */
function yamlScalar(value: unknown): string {
	if (typeof value === "string") {
		const reserved = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);
		if (/^[A-Za-z0-9_.+\-:/]+$/.test(value) && !reserved.has(value.toLowerCase()) && !parsesAsNonString(value)) return value;
	}
	return JSON.stringify(value);
}

/** True when a bare scalar would be read back as a number, boolean or null instead of text. */
function parsesAsNonString(text: string): boolean {
	try { return typeof JSON.parse(text) !== "string"; } catch { return false; }
}

/** Serialize frontmatter + blank line + body. Known keys emit in Design order, extras after. */
export function serializeNote(meta: NoteMeta, body: string): string {
	const lines: string[] = [];
	for (const key of KNOWN_KEYS) {
		const value = meta[key];
		if (value === undefined) continue;
		if ((TIMESTAMP_KEYS as readonly string[]).includes(key)) lines.push(`${key}: ${yamlScalar(localIso(value as number))}`);
		else lines.push(`${key}: ${yamlScalar(value)}`);
	}
	for (const key of Object.keys(meta)) {
		// scope is a legacy on-disk field. Store callers derive it from the notebook's location,
		// but serialization intentionally drops it on the next write.
		if (key === "scope" || (KNOWN_KEYS as readonly string[]).includes(key)) continue;
		if (meta[key] === undefined) continue;
		lines.push(`${key}: ${yamlScalar(meta[key])}`);
	}
	return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

/** Strip a leading frontmatter block from user content, so a note body is pure content. */
export function stripLeadingFrontmatter(content: string): string {
	return parseFrontmatter(content).body;
}
