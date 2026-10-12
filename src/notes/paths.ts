import { readdir } from "node:fs/promises";
import { join } from "node:path";
export { projectKey } from "./project-home.js";
import { NoteError, shown } from "./errors.js";
import type { NotesIdentity } from "./identity.js";

export type Scope = "session" | "project" | "human" | "agent" | "model";

/** The one legal home-name shape: lowercase [a-z0-9-] runs separated by single dashes. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Slugify a caller-declared identity; identity is never inferred from note content. */
export function slugify(value: string): string {
	const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "root";
}

/**
 * The one virtual-path grammar: a relative, `/`-separated path with no empty, `.` or `..`
 * segment. Both the address decoder and the physical-path builder enforce it here, so a
 * caller that reaches a path without going through an address still cannot escape a home.
 */
export function assertVirtualPath(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new NoteError("invalid_address", "The address is empty; give the note a path.");
	if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) throw new NoteError("invalid_address", `${shown(value)}: a note path can't start with "/" or contain "\\" or NUL.`);
	const parts = value.split("/");
	if (parts.some((part) => part.length === 0 || part === "." || part === "..")) throw new NoteError("invalid_address", `${shown(value)}: a note path can't have empty, ".", or ".." folder names.`);
	return value;
}

/** Absolute directory holding the per-session note homes. */
export function sessionHomesRoot(home: string): string {
	return join(home, "pi", "session");
}

/** Absolute directory holding one scope's notes. The identity's home is already resolved. */
export function scopeDir(scope: Scope, identity: NotesIdentity, who?: string): string {
	if (!["session", "project", "human", "agent", "model"].includes(scope)) throw new TypeError("invalid notes scope");
	if (who !== undefined && (scope !== "project" && scope !== "agent" && scope !== "model" || !SLUG_PATTERN.test(who))) throw new TypeError("who must be a canonical project/agent/model slug");
	if (scope === "human") return join(identity.home, "human");
	if (scope === "project") return join(identity.home, "project", who ?? identity.projectKey);
	if (scope === "agent") return join(identity.home, "agents", who ?? identity.agent);
	if (scope === "model") return join(identity.home, "models", who ?? identity.model);
	return join(sessionHomesRoot(identity.home), identity.sessionId);
}

/** Every existing home directory of the agents/ or models/ namespace, as names. */
export async function namespaceSlugs(namespace: "agents" | "models", home: string): Promise<string[]> {
	try {
		return (await readdir(join(home, namespace), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/**
 * Notes are markdown files: a virtual path without an `.md` suffix gains one, an explicit
 * `.md` is kept as-is, so `a/b` and `a/b.md` name the same physical file.
 */
export function noteFileName(vpath: string): string {
	return vpath.endsWith(".md") ? vpath : `${vpath}.md`;
}

/** Absolute file path for a virtual path in a scope. Callers validate the vpath first. */
export function physicalPath(scope: Scope, vpath: string, identity: NotesIdentity, who?: string): string {
	return join(scopeDir(scope, identity, who), ...noteFileName(vpath).split("/"));
}
