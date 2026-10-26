/** Dream operations: open one project's notes for consolidation, delete crumpled notes, close. */
import { Type, type Static } from "typebox";
import { createNotesStore, noteIdentity, type NoteRow, type NotesIdentity } from "../notes/index.js";
import { projectNamespaces } from "../notes/project-namespace.js";
import { gitCommit } from "../dream/git.js";
import { acquireDreamLock, dreamLockPath, releaseDreamLock, type DreamLock } from "../dream/lock.js";
import { failure, renderOutcome, resultSchema, success, type Outcome } from "./result.js";
import { failureOf, listedFile, NoteIdentitySchema, NotesListDataSchema, renderListData, snapshot } from "./notes.js";

/** The one open dream per session; the host owns where it lives. */
type DreamOpening = { project: string; lock: DreamLock; generation: number };
export type DreamState = { project?: string; lock?: DreamLock; pending?: DreamOpening; generation?: number };

function currentOpening(state: DreamState, opening: DreamOpening): boolean {
	return state.pending === opening && state.generation === opening.generation;
}

function nextGeneration(state: DreamState): number {
	const generation = (state.generation ?? 0) + 1;
	state.generation = generation;
	return generation;
}

/** Drop an open dream without an end commit, e.g. when its session shuts down. */
export function abandonDream(state: DreamState): void {
	const pending = state.pending;
	if (pending) releaseDreamLock(pending.lock);
	if (state.lock && state.lock !== pending?.lock) releaseDreamLock(state.lock);
	nextGeneration(state);
	delete state.project;
	delete state.lock;
	delete state.pending;
}

/** Release an opening without disturbing a newer opening in the same state. */
function releaseOpening(state: DreamState, opening: DreamOpening): void {
	releaseDreamLock(opening.lock);
	if (currentOpening(state, opening)) delete state.pending;
}

function cancelledOpening(state: DreamState, opening: DreamOpening): Outcome<never> {
	releaseOpening(state, opening);
	return failure("cancelled", "The dream opening was cancelled before it completed.");
}

/** The identity a store uses while `state` holds an open dream. */
export function dreamingIdentity(identity: NotesIdentity, state: DreamState): NotesIdentity {
	return state.project === undefined ? identity : { ...identity, dreaming: state.project };
}

const NOT_DREAMING = "No dream is open; call dream_begin first.";

export const dreamBeginParameters = Type.Object({
	project: Type.Optional(Type.String({ description: "(optional, default this project) Project name, as in @projects/<name>/." })),
}, { additionalProperties: false });

export const DreamBeginDataSchema = Type.Object({ project: Type.String(), baseline: Type.String(), ...NotesListDataSchema.properties }, { additionalProperties: false });
export type DreamBeginData = Static<typeof DreamBeginDataSchema>;

function renderBeginData(data: DreamBeginData): string {
	return `dreaming over ${data.project} (baseline ${data.baseline})\n${renderListData(data)}`;
}

export const dreamBegin = {
	name: "dream_begin", label: "Dream begin",
	description: "Dream: open one project's notes for consolidation, one project at a time. Lists its @projects/<name>/ notes and every session note born in it, crumpled ones included. Until dream_end, notes_write/notes_update can edit those addresses and reads leave no access stamp. Holds the notes home's dream lock through dream_end so Git audits cannot interleave, and commits a baseline of the notes home.",
	parameters: dreamBeginParameters, outputSchema: resultSchema(DreamBeginDataSchema),
	async execute(params: Static<typeof dreamBeginParameters>, identity: NotesIdentity, state: DreamState): Promise<Outcome<DreamBeginData>> {
		if (state.project !== undefined || state.pending !== undefined) {
			const project = state.project ?? state.pending?.project;
			return failure("already_dreaming", `Already dreaming over ${project}; call dream_end before opening another project.`);
		}
		const project = params.project ?? identity.projectKey;
		if (project !== identity.projectKey && !projectNamespaces(identity.home).some(namespace => namespace.name === project)) {
			return failure("not_found", `No project named ${JSON.stringify(project)}; notes_list with glob @projects/*/** shows the names.`);
		}
		const lock = acquireDreamLock(dreamLockPath(identity.home));
		if (!lock) return failure("already_dreaming", `Another dream holds ${dreamLockPath(identity.home)}. If none is running, delete that file by hand.`);
		// Publish ownership before the first await. Shutdown can therefore release this exact token.
		const opening: DreamOpening = { project, lock, generation: nextGeneration(state) };
		state.pending = opening;
		try {
			const store = createNotesStore({ ...identity, dreaming: project });
			const rows: NoteRow[] = [];
			const unavailable: string[] = [];
			for (const crumpled of [false, true]) {
				for (const glob of [`@projects/${project}/**`, "@sessions/*/**"]) {
					const result = await store.listWithStatus({ glob, crumpled });
					if (!currentOpening(state, opening)) return cancelledOpening(state, opening);
					rows.push(...result.rows.filter(row => row.scope === "project" || row.meta.project === project));
					unavailable.push(...result.status.namespacesUnavailable);
				}
			}
			rows.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt || a.address.localeCompare(b.address));
			const listed = snapshot(rows.map(row => listedFile(row, identity)), undefined, { namespacesUnavailable: unavailable }, renderListData);
			if (!listed.ok) {
				releaseOpening(state, opening);
				return listed;
			}
			if (!currentOpening(state, opening)) return cancelledOpening(state, opening);
			const baseline = gitCommit(identity.home, `dream baseline ${project}`);
			if (!baseline.ok) {
				releaseOpening(state, opening);
				return failure("audit_failed", `Couldn't commit the Git baseline, so nothing could be rolled back; no dream was opened: ${baseline.error}`);
			}
			if (!currentOpening(state, opening)) return cancelledOpening(state, opening);
			state.project = opening.project;
			state.lock = opening.lock;
			delete state.pending;
			return success({ project, baseline: baseline.commit, ...listed.data });
		} catch (error) {
			if (!currentOpening(state, opening)) return cancelledOpening(state, opening);
			releaseOpening(state, opening);
			return failureOf(error);
		}
	},
	render: (result: Outcome<DreamBeginData>): string => renderOutcome(result, renderBeginData),
} as const;

export const dreamForgetParameters = Type.Object({ address: Type.String() }, { additionalProperties: false });
export const DreamForgetDataSchema = Type.Object({ ...NoteIdentitySchema }, { additionalProperties: false });
export type DreamForgetData = Static<typeof DreamForgetDataSchema>;

export const dreamForget = {
	name: "dream_forget", label: "Dream forget",
	description: "Dream: permanently delete one crumpled note in the project being dreamed over, or in @human/, @self/, @model/. Crumple it first; live notes refuse.",
	parameters: dreamForgetParameters, outputSchema: resultSchema(DreamForgetDataSchema),
	async execute(params: Static<typeof dreamForgetParameters>, identity: NotesIdentity, state: DreamState): Promise<Outcome<DreamForgetData>> {
		if (state.project === undefined) return failure("not_dreaming", NOT_DREAMING);
		try {
			const dreaming = dreamingIdentity(identity, state);
			await createNotesStore(dreaming).forget(params.address);
			return success(noteIdentity(dreaming, params.address));
		} catch (error) { return failureOf(error); }
	},
	render: (result: Outcome<DreamForgetData>): string => renderOutcome(result, data => `forgot ${data.address}`),
} as const;

export const dreamEndParameters = Type.Object({}, { additionalProperties: false });
export const DreamEndDataSchema = Type.Object({ project: Type.String(), commit: Type.Optional(Type.String()), audit_error: Type.Optional(Type.String()) }, { additionalProperties: false });
export type DreamEndData = Static<typeof DreamEndDataSchema>;

export const dreamEnd = {
	name: "dream_end", label: "Dream end",
	description: "Dream: close the open dream. Commits the dream's changes to the notes home's Git and releases the lock; the project's notes are read-only again and reads stamp access again.",
	parameters: dreamEndParameters, outputSchema: resultSchema(DreamEndDataSchema),
	async execute(_params: Static<typeof dreamEndParameters>, identity: NotesIdentity, state: DreamState): Promise<Outcome<DreamEndData>> {
		const project = state.project;
		if (project === undefined) return failure("not_dreaming", NOT_DREAMING);
		// The dream closes even when the audit commit fails; the uncommitted changes stay in the work tree.
		const audit = gitCommit(identity.home, `dream ${project}`);
		abandonDream(state);
		return success(audit.ok ? { project, commit: audit.commit } : { project, audit_error: audit.error });
	},
	render: (result: Outcome<DreamEndData>): string => renderOutcome(result, data => data.commit !== undefined
		? `woke from ${data.project} (commit ${data.commit})`
		: `woke from ${data.project}; the Git commit failed, changes are uncommitted: ${data.audit_error}`),
} as const;

