/** Dream operations: open one project's notes for consolidation, delete crumpled notes, close. */
import { Type, type Static } from "typebox";
import { createNotesStore, noteIdentity, type NoteRow, type NotesIdentity } from "../notes/index.js";
import { projectHomes } from "../notes/project-home.js";
import { gitCommit } from "../dream/git.js";
import { acquireDreamLock, dreamLockPath, releaseDreamLock, type DreamLock } from "../dream/lock.js";
import { failure, renderOutcome, resultSchema, success, type Outcome } from "./result.js";
import { failureOf, listedFile, NotesListDataSchema, renderListData, snapshot } from "./notes.js";

/** The one open dream per session; the host owns where it lives. */
export type DreamState = { project?: string; lock?: DreamLock };

/** Drop an open dream without an end commit, e.g. when its session shuts down. */
export function abandonDream(state: DreamState): void {
	if (state.lock) releaseDreamLock(state.lock);
	delete state.project;
	delete state.lock;
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
	description: "Dream: open one project's notes for consolidation, one project at a time. Lists its @projects/<name>/ notes and every session note born in it, crumpled ones included. Until dream_end, notes_write/notes_update can edit those addresses and reads leave no access stamp. Takes the project's dream lock and commits a Git baseline of the notes home.",
	parameters: dreamBeginParameters, outputSchema: resultSchema(DreamBeginDataSchema),
	async execute(params: Static<typeof dreamBeginParameters>, identity: NotesIdentity, state: DreamState): Promise<Outcome<DreamBeginData>> {
		if (state.project !== undefined) return failure("already_dreaming", `Already dreaming over ${state.project}; call dream_end before opening another project.`);
		const project = params.project ?? identity.projectKey;
		if (project !== identity.projectKey && !projectHomes(identity.home).some(home => home.name === project)) {
			return failure("not_found", `No project named ${JSON.stringify(project)}; notes_list with glob @projects/*/** shows the names.`);
		}
		const lock = acquireDreamLock(dreamLockPath(identity.home, project));
		if (!lock) return failure("already_dreaming", `Another dream holds ${dreamLockPath(identity.home, project)}. If none is running, delete that file by hand.`);
		try {
			const store = createNotesStore({ ...identity, dreaming: project });
			const rows: NoteRow[] = [];
			const unavailable: string[] = [];
			for (const crumpled of [false, true]) {
				for (const glob of [`@projects/${project}/**`, "@sessions/*/**"]) {
					const result = await store.listWithStatus({ glob, crumpled });
					rows.push(...result.rows.filter(row => row.scope === "project" || row.meta.project === project));
					unavailable.push(...result.status.homesUnavailable);
				}
			}
			rows.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt || a.address.localeCompare(b.address));
			const listed = snapshot(rows.map(row => listedFile(row, identity)), undefined, { homesUnavailable: unavailable }, renderListData);
			if (!listed.ok) { releaseDreamLock(lock); return listed; }
			const baseline = gitCommit(identity.home, `dream baseline ${project}`);
			if (!baseline.ok) { releaseDreamLock(lock); return failure("audit_failed", `Couldn't commit the Git baseline, so nothing could be rolled back; no dream was opened: ${baseline.error}`); }
			Object.assign(state, { project, lock });
			return success({ project, baseline: baseline.commit, ...listed.data });
		} catch (error) { releaseDreamLock(lock); return failureOf(error); }
	},
	render: (result: Outcome<DreamBeginData>): string => renderOutcome(result, renderBeginData),
} as const;

export const dreamForgetParameters = Type.Object({ address: Type.String() }, { additionalProperties: false });
export const DreamForgetDataSchema = Type.Object({ address: Type.String(), project_key: Type.Optional(Type.String()) }, { additionalProperties: false });
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

