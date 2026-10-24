import type { Agent } from "@deepseek-ai/dsh-agent";
import { appendPluginRecord, pluginRecordOf, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import { isCompactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadNotesSnapshot } from "../../src/boot/snapshot.js";
import { renderBootBlock } from "../../src/boot/render.js";
import { DEFAULT_BOOT_TOOL_NAMES } from "../../src/boot/text.js";
import { contentText } from "../../src/history/history.js";
import { projectKey, slugify, snapshotNotesIdentity, type NotesIdentity } from "../../src/notes/index.js";

export const WINDOW_RECORD = "plugin:notesoup/window";
export const BOOT_SECTION = "notesoup:boot";
const BOOT_OPEN = "<notesoup-boot>\n";
const BOOT_CLOSE = "\n</notesoup-boot>";
const CHECKPOINT_END = "\n\n<notesoup-continuation>\n";
export type WindowSnapshot = Readonly<{ version: 1; window: number; windowId: string; openedAt: number; boot: string; notesDigest: string }>;
export type WindowState = { snapshot: WindowSnapshot; pendingReset: boolean; warned: boolean; reminded: boolean; continuation?: string };
export type NotesConfig = { notesHome?: string; agentName?: string };

export function restoreWarnings(state: WindowState, events: readonly SessionEvent[]): void {
	state.warned = false;
	state.reminded = false;
	for (const event of events) {
		if (event.type === "user/message" && event.data.source.kind === "notesoup-budget" && event.data.source.windowId === state.snapshot.windowId) {
			if (event.data.source.phase === "warning") state.warned = true;
			else state.reminded = true;
		}
	}
}

declare module "@deepseek-ai/dsh-session/types" {
	interface PluginRecordMap { "plugin:notesoup/window": WindowSnapshot }
}

export function windowId(sessionId: string, window: number): string { return `dsh:${sessionId}:${window}`; }
function digest(boot: string): string { return createHash("sha256").update(boot).digest("hex"); }
export function checkpointText(snapshot: WindowSnapshot, continuation: string): string { return snapshot.boot + CHECKPOINT_END + continuation + "\n</notesoup-continuation>"; }

export function recordSnapshot(event: SessionEvent): WindowSnapshot | undefined {
	const record = pluginRecordOf(event);
	if (record?.type !== WINDOW_RECORD || typeof record.data !== "object" || record.data === null) return undefined;
	const value = record.data as Partial<WindowSnapshot>;
	if (value.version !== 1 || !Number.isSafeInteger(value.window) || value.window! < 0 || typeof value.windowId !== "string" || typeof value.openedAt !== "number" || typeof value.boot !== "string" || value.notesDigest !== digest(value.boot)) return undefined;
	return Object.freeze(value as WindowSnapshot);
}

/** The checkpoint is authoritative when an ignorable record was lost or the transaction's close failed. */
export function checkpointSnapshot(event: SessionEvent): WindowSnapshot | undefined {
	if (event.type !== "user/message" || !isCompactCheckpointSource(event.data.source)) return undefined;
	const text = contentText(event.data.content);
	const end = text.lastIndexOf(CHECKPOINT_END);
	if (end < 0 || !text.startsWith(BOOT_OPEN)) return undefined;
	return snapshotFromBoot(text.slice(0, end), event.time);
}

function systemSnapshot(event: SessionEvent): WindowSnapshot | undefined {
	if (event.type !== "system/message") return undefined;
	const text = contentText(event.data.message.content);
	const start = text.indexOf(BOOT_OPEN);
	const end = text.lastIndexOf(BOOT_CLOSE);
	if (start < 0 || end < 0) return undefined;
	return snapshotFromBoot(text.slice(start, end + BOOT_CLOSE.length), event.time);
}

/**
 * Read the window identity out of a persisted boot. The `context_window` spelling is what boots
 * written before the rename carry, so both spellings still yield their ordinal and window id.
 */
function snapshotFromBoot(boot: string, openedAt: number): WindowSnapshot | undefined {
	const identity = /<(?:context_window|notesoup:window_identity)>\n[\s\S]*?\n(dsh:[^\n]+)\n[\s\S]*?└─ (\d+)(?: +[^\n]*)?\n<\/(?:context_window|notesoup:window_identity)>/.exec(boot);
	const legacy = /^Current context window id: (dsh:.*:(\d+))$/m.exec(boot);
	const shortName = identity?.[2] ?? legacy?.[2];
	const id = identity ? `${identity[1]}:${shortName}` : legacy?.[1];
	if (!id || shortName === undefined || !Number.isSafeInteger(Number(shortName))) return undefined;
	return Object.freeze({ version: 1, window: Number(shortName), windowId: id, openedAt, boot, notesDigest: digest(boot) });
}

export function recoverSnapshot(events: readonly SessionEvent[]): WindowSnapshot | undefined {
	let latest: WindowSnapshot | undefined;
	for (const event of events) {
		const candidate = checkpointSnapshot(event) ?? recordSnapshot(event) ?? systemSnapshot(event);
		if (candidate && (!latest || candidate.window >= latest.window)) latest = candidate;
	}
	return latest;
}

export function notesCwd(agent: Pick<Agent, "session" | "options">): string {
	return agent.session.header.cwd ?? process.cwd();
}

/** Identity is extracted here, never in the filesystem domain. */
export function notesIdentity(agent: Pick<Agent, "session" | "options">, config: NotesConfig): NotesIdentity {
	const home = config.notesHome ?? join(homedir(), ".agents", "notes");
	return snapshotNotesIdentity({
		home,
		sessionId: agent.session.id,
		projectKey: projectKey(notesCwd(agent), home),
		agent: slugify(config.agentName ?? "dsh"),
		model: slugify(agent.session.requestHeader()?.config.model ?? agent.options.model ?? "unknown"),
	});
}

/** Engine-owned, per-session state; prompt reads are synchronous and never read notes again. */
export class Windows {
	private states = new WeakMap<Session, WindowState>();
	constructor(readonly config: NotesConfig) {}
	get(session: Session): WindowState {
		const state = this.states.get(session);
		if (!state) throw Object.assign(new Error("notesoup: window missing; initialize at agent/created before sending a request."), { code: "WINDOW_MISSING" });
		return state;
	}
	async adopt(agent: Agent, signal?: AbortSignal): Promise<WindowState> {
		const existing = this.states.get(agent.session);
		if (existing) return existing;
		const restored = recoverSnapshot(agent.session.snapshotEvents());
		const sameSession = restored !== undefined && restored.windowId === windowId(agent.session.id, restored.window);
		const snapshot = sameSession ? restored : await this.mint(agent, restored?.window ?? 0, agent.session.header.createdAt);
		signal?.throwIfAborted();
		if (!sameSession) appendPluginRecord(agent.session, WINDOW_RECORD, snapshot);
		const state = { snapshot, pendingReset: false, warned: false, reminded: false };
		restoreWarnings(state, agent.session.snapshotEvents());
		this.states.set(agent.session, state);
		return state;
	}
	async mint(agent: Pick<Agent, "session" | "options">, window: number, openedAt: number): Promise<WindowSnapshot> {
		const identity = notesIdentity(agent, this.config);
		const notes = await loadNotesSnapshot(identity, openedAt);
		const trunk = `dsh:${agent.session.id}`;
		const tree = { trunk, windows: Array.from({ length: window + 1 }, (_, index) => ({ shortName: String(index), isCurrent: index === window })) };
		const boot = BOOT_OPEN + renderBootBlock({ agentName: identity.agent, modelName: identity.model, tree, notes, tools: DEFAULT_BOOT_TOOL_NAMES }) + BOOT_CLOSE;
		return Object.freeze({ version: 1, window, windowId: windowId(agent.session.id, window), openedAt, boot, notesDigest: digest(boot) });
	}
}
