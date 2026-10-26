/**
 * Host-neutral core entry.
 *
 * Everything under `src/` is independent of any host SDK: notes, boot, history, budget and the
 * shared operations know nothing about Pi, Claude Code or dsh. Each plugin under `plugins/`
 * composes these domains into that host's registration and owns that host's text, lifecycle and
 * SDK types. Nothing here imports a plugin.
 *
 * This is the deliberate embedding surface for a host adapter — a curated list, not a re-export
 * of every internal module. The notes family is also published as `notesoup/notes`; the Pi
 * extension is loaded through the Pi manifest; dsh uses `notesoup/dsh` and `notesoup/dsh/engine`.
 */

// Notes: the standalone filesystem library, addressed by an explicit identity.
export { createNotesStore, noteIdentity, projectKey, slugify, NoteError } from "./notes/index.js";
export type {
	NoteEditResult,
	NoteMatch,
	NoteMeta,
	NoteReadResult,
	NoteRenameResult,
	NoteRow,
	NoteSearchRow,
	NotesIdentity,
	NotesQuery,
	NotesStore,
	NoteWriteResult,
	Origin,
	Scope,
} from "./notes/index.js";

// Boot: five notebooks captured once, rendered from explicit logical tool names.
export { loadNotesSnapshot, unavailableNotesSnapshot } from "./boot/snapshot.js";
export type { NotesNamespace, NotesSnapshot } from "./boot/snapshot.js";
export { renderBootBlock } from "./boot/render.js";
export type { BootRenderData, BootWindowTree } from "./boot/render.js";
export { DEFAULT_BOOT_TOOL_NAMES, renderProtocolBlock } from "./boot/text.js";
export type { BootToolNames } from "./boot/text.js";

// Operations: the schemas and typed outcomes a host registers as its own tools, over a
// host-supplied notes tool context or decoded history projection.
export { notesList, notesRead, notesSearch, notesUpdate, notesWrite } from "./tools/notes.js";
export { notesIdentityForCall, notesToolContext, type NotesToolContext } from "./tools/notes-context.js";
export { historyList, historyRead, historyWindows } from "./tools/history.js";
export { projectHistory } from "./history/history.js";
export type { HistoryProjection } from "./history/history.js";
export type { Operation, OperationError, Outcome, Renderer, TextWindow } from "./tools/result.js";

// Budget: pure thresholds and the approved reset prose.
export { deriveThresholds, remainingBudget } from "./budget/policy.js";
export type { ResolvedThresholds } from "./budget/policy.js";
export { selectContinuation, tokenBudgetGuidance, warningPrompt, WARNING_BODY } from "./budget/text.js";
export type { ResetOrigin } from "./budget/text.js";
