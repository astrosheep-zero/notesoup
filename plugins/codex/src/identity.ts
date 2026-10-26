/** Hook-captured thread identity and the only mutable plugin state: per-thread bindings under PLUGIN_DATA. */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { projectKey, slugify, snapshotNotesIdentity, type NotesIdentity } from "../../../src/notes/index.js";

const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BINDINGS = "bindings";

/** A refusal the model can read and act on, not a crash. */
export class CodexIdentityError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "CodexIdentityError";
	}
}

export type ThreadBinding = Readonly<{
	version: 1;
	threadId: string;
	rootSessionId: string;
	cwd: string;
	/** Session-start model, used only to label this window's boot. */
	model: string;
	agent: string;
	home: string;
	transcriptPath: string;
	/** Native window at bind time; a later MCP call must name this same window. */
	windowId: string;
	agentType?: string;
	boundAt: string;
}>;

export function safeThreadId(value: unknown, field = "threadId"): string {
	if (typeof value !== "string" || !SAFE_THREAD_ID.test(value) || value === "." || value === "..") {
		throw new CodexIdentityError("invalid_thread", `Codex ${field} is missing or not a safe native thread id.`);
	}
	return value;
}

/** The portable server and the hook must share this root; Codex injects it into both. */
export function pluginDataRoot(env: NodeJS.ProcessEnv = process.env): string {
	const value = env.PLUGIN_DATA;
	if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
		throw new CodexIdentityError("missing_plugin_data", "PLUGIN_DATA is unavailable. Install notesoup as a Codex plugin (or set PLUGIN_DATA for a standalone test) so hook bindings have one mutable data directory.");
	}
	return resolve(value);
}

export function notesHome(env: NodeJS.ProcessEnv = process.env): string {
	const value = env.NOTESOUP_HOME;
	return value !== undefined && value.trim() !== "" ? resolve(value) : join(homedir(), ".agents", "notes");
}

/** Native ids arrive provider-prefixed; @model is the last segment, slugged like every other notebook. */
export function modelSlug(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const id = value.trim();
	if (id === "") return undefined;
	const slug = slugify(id.split("/").pop() ?? id);
	return slug === "root" ? undefined : slug;
}

function bindingPath(root: string, threadId: string): string {
	return join(root, BINDINGS, `${safeThreadId(threadId)}.json`);
}

function required(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new CodexIdentityError("invalid_binding", `Stored notesoup binding is missing ${field}; resume the Codex thread once so its hooks rebind it.`);
	return value;
}

/** Validate every field before it becomes an identity; a corrupt binding never half-applies. */
export async function readBinding(root: string, threadId: string): Promise<ThreadBinding> {
	let raw: string;
	try {
		raw = await readFile(bindingPath(root, threadId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new CodexIdentityError("unknown_thread", "notesoup has no hook binding for this Codex thread. Enable and trust the notesoup plugin hooks, then start or resume the thread; notesoup never guesses a project from the MCP server's own cwd.");
		}
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new CodexIdentityError("invalid_binding", "The stored notesoup binding is not valid JSON; resume the Codex thread once so its hooks rebind it.");
	}
	const row = value as Record<string, unknown>;
	if (row.version !== 1) throw new CodexIdentityError("invalid_binding", "The stored notesoup binding has an unsupported version; resume the Codex thread once so its hooks rebind it.");
	const storedThread = safeThreadId(row.threadId, "binding threadId");
	if (storedThread !== threadId) throw new CodexIdentityError("mismatched_thread", "The stored notesoup binding belongs to another thread; refuse to read or write with it.");
	const home = required(row.home, "home");
	const cwd = required(row.cwd, "cwd");
	const transcriptPath = required(row.transcriptPath, "transcriptPath");
	const windowId = required(row.windowId, "windowId");
	if (!isAbsolute(home) || !isAbsolute(cwd) || !isAbsolute(transcriptPath)) throw new CodexIdentityError("invalid_binding", "The stored notesoup binding contains a non-absolute path.");
	return {
		version: 1,
		threadId,
		rootSessionId: required(row.rootSessionId, "rootSessionId"),
		cwd,
		model: required(row.model, "model"),
		agent: required(row.agent, "agent"),
		home,
		transcriptPath,
		windowId,
		...(typeof row.agentType === "string" && row.agentType.length > 0 ? { agentType: row.agentType } : {}),
		boundAt: required(row.boundAt, "boundAt"),
	};
}

/** Atomic replace; a failed write never leaves a half binding behind. */
export async function writeBinding(root: string, binding: ThreadBinding): Promise<void> {
	const path = bindingPath(root, binding.threadId);
	await mkdir(join(root, BINDINGS), { recursive: true });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
	await rename(temp, path);
}

export function notesIdentityFor(binding: ThreadBinding, model: string): NotesIdentity {
	return snapshotNotesIdentity({
		home: binding.home,
		sessionId: binding.threadId,
		projectKey: projectKey(binding.cwd, binding.home),
		agent: binding.agent,
		model,
	});
}

/** The current turn's model, not the cached session-start model, chooses @model. */
export function turnModel(meta: Record<string, unknown>): string {
	let value: unknown = meta["x-codex-turn-metadata"];
	if (typeof value === "string") {
		try { value = JSON.parse(value); } catch { value = undefined; }
	}
	const model = typeof value === "object" && value !== null ? (value as Record<string, unknown>).model : undefined;
	const slug = modelSlug(model);
	if (slug === undefined) throw new CodexIdentityError("missing_model", "Codex did not supply this turn's model in MCP metadata, so notesoup cannot choose an @model notebook. Update Codex, or call notes from a model turn.");
	return slug;
}

export function rootSessionIdOf(meta: Record<string, unknown>): string {
	return required(meta.sessionId, "MCP sessionId");
}
