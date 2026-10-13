export { createNotesStore, noteIdentity } from "./store.js";
export { NoteError, type NoteErrorCode } from "./errors.js";
export { projectKey } from "./project-home.js";
export { slugify } from "./paths.js";
export { snapshotNotesIdentity, type NotesIdentity } from "./identity.js";
export { isFilesystemError } from "./fs-error.js";
export type {
	EditOperation,
	EditOptions,
	NoteChange,
	NoteEditResult,
	NoteMatch,
	NoteMeta,
	NoteQueryResult,
	NoteQueryStatus,
	NoteReadResult,
	NoteRenameResult,
	NoteRow,
	NoteSearchRow,
	NoteWriteResult,
	NotesQuery,
	NotesStore,
	Origin,
	Scope,
	WriteOptions,
} from "./store.js";
