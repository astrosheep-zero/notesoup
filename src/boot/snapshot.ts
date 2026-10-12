import type { NotesIdentity } from "../notes/identity.js";
import { isFilesystemError } from "../notes/fs-error.js";
import { createNotesStore, type NoteRow, type Scope } from "../notes/index.js";

const NOTES_HOMES = [
	{ scope: "session", label: "this session" },
	{ scope: "project", label: "@project" },
	{ scope: "human", label: "@human" },
	{ scope: "agent", label: "@self" },
	{ scope: "model", label: "@model" },
] as const satisfies ReadonlyArray<{ scope: Scope; label: string }>;

export type NotesHome = (typeof NOTES_HOMES)[number];
export type NotesLoader = (scope: Scope) => NoteRow[] | Promise<NoteRow[]>;
export type NotesSnapshot = {
	/** Wall-clock instant captured when this boot began; rendering never consults Date.now(). */
	readonly openedAt: number;
	readonly homes: ReadonlyMap<Scope, readonly NoteRow[]>;
	readonly unavailable: readonly NotesHome[];
};

/** Identity resolution failed before any home could be loaded; boot can still explain the failure. */
export function unavailableNotesSnapshot(openedAt: number): NotesSnapshot {
	return { openedAt, homes: new Map(), unavailable: NOTES_HOMES };
}

/**
 * Acquire the five homes once for one boot. Only filesystem-style errno failures are isolated;
 * malformed note data and unrelated construction errors remain visible to the caller.
 */
export async function loadNotesSnapshot(identity: NotesIdentity, openedAt: number, loadHome?: NotesLoader): Promise<NotesSnapshot> {
	const store = createNotesStore(identity);
	const load = loadHome ?? ((scope: Scope) => store.list({ scope }));
	const homes = new Map<Scope, readonly NoteRow[]>();
	const unavailable: NotesHome[] = [];
	for (const home of NOTES_HOMES) {
		try {
			homes.set(home.scope, await load(home.scope));
		} catch (error) {
			if (!isFilesystemError(error)) throw error;
			homes.set(home.scope, []);
			unavailable.push(home);
		}
	}
	return { openedAt, homes, unavailable };
}
