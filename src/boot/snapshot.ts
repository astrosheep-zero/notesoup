import type { NotesIdentity } from "../notes/identity.js";
import { isFilesystemError } from "../notes/fs-error.js";
import { createNotesStore, type NoteRow, type Scope } from "../notes/index.js";

const NOTES_NAMESPACES = [
	{ scope: "session", label: "this session" },
	{ scope: "project", label: "@project" },
	{ scope: "human", label: "@human" },
	{ scope: "agent", label: "@self" },
	{ scope: "model", label: "@model" },
] as const satisfies ReadonlyArray<{ scope: Scope; label: string }>;

export type NotesNamespace = (typeof NOTES_NAMESPACES)[number];
export type NotesLoader = (scope: Scope) => NoteRow[] | Promise<NoteRow[]>;
export type NotesSnapshot = {
	/** Wall-clock instant captured when this boot began; rendering never consults Date.now(). */
	readonly openedAt: number;
	readonly namespaces: ReadonlyMap<Scope, readonly NoteRow[]>;
	readonly unavailable: readonly NotesNamespace[];
};

/** Identity resolution failed before any notebook could be loaded; boot can still explain the failure. */
export function unavailableNotesSnapshot(openedAt: number): NotesSnapshot {
	return { openedAt, namespaces: new Map(), unavailable: NOTES_NAMESPACES };
}

/**
 * Acquire the five notebooks once for one boot. Only filesystem-style errno failures are isolated;
 * malformed note data and unrelated construction errors remain visible to the caller.
 */
export async function loadNotesSnapshot(identity: NotesIdentity, openedAt: number, loadNamespace?: NotesLoader): Promise<NotesSnapshot> {
	const namespaces = new Map<Scope, readonly NoteRow[]>();
	const unavailable: NotesNamespace[] = [];
	if (!loadNamespace) {
		const { rows, status } = await createNotesStore(identity).listWithStatus();
		for (const namespace of NOTES_NAMESPACES) {
			namespaces.set(namespace.scope, rows.filter(row => row.scope === namespace.scope));
			if (status.namespacesUnavailable.some(address => namespace.scope === "session" ? !address.startsWith("@") : address === namespace.label || address.startsWith(`${namespace.label}/`))) unavailable.push(namespace);
		}
		return { openedAt, namespaces, unavailable };
	}
	for (const namespace of NOTES_NAMESPACES) {
		try {
			namespaces.set(namespace.scope, await loadNamespace(namespace.scope));
		} catch (error) {
			if (!isFilesystemError(error)) throw error;
			namespaces.set(namespace.scope, []);
			unavailable.push(namespace);
		}
	}
	return { openedAt, namespaces, unavailable };
}
