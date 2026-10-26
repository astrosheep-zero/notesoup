/** Codex command hooks: bind verified native thread identity, then render or refuse a native-window boot. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadNotesSnapshot, unavailableNotesSnapshot, type NotesSnapshot } from "../../../src/boot/snapshot.js";
import { isFilesystemError, slugify } from "../../../src/notes/index.js";
import { CodexIdentityError, modelSlug, notesHome, notesIdentityFor, pluginDataRoot, readBinding, safeThreadId, writeBinding, type ThreadBinding } from "./identity.js";
import { findRecordedBoot, readStartState, recheckStartState, renderCodexBoot } from "./state.js";
import { CODEX_SETUP_HINT, missingNativeFacts, notesFailureBoot, unsupportedChildCompaction } from "./text.js";

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
/** additionalContextLimit:0 disables host spilling, so this local cap is the only truncation guard. */
export const MAX_BOOT_BYTES = 128 * 1024;

type HookPayload = Record<string, unknown>;

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function shellFree(reason: unknown): string {
	const value = reason instanceof Error ? reason.message : String(reason);
	return value.replace(/[\r\n]+/g, " ").slice(0, 500);
}

export function warningOutput(message: string): string {
	return JSON.stringify({ systemMessage: message });
}

export function contextOutput(event: "SessionStart" | "SubagentStart", text: string): string {
	return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** An oversized boot is refused rather than silently truncated or spilled by the host. */
export function bootWithinCap(boot: string): string | undefined {
	const bytes = Buffer.byteLength(boot, "utf8");
	return bytes <= MAX_BOOT_BYTES
		? undefined
		: `notesoup: this window's boot is ${bytes} bytes, over the ${MAX_BOOT_BYTES}-byte cap. No truncated or spilled boot was injected; slim the notebook MAPs and restart/resume the thread.`;
}

export async function readHookInput(stream: NodeJS.ReadableStream): Promise<string> {
	return await new Promise((resolveInput, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer | string) => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.length;
			if (size > MAX_HOOK_INPUT_BYTES) {
				stream.pause();
				reject(new Error("hook input exceeds 1 MiB"));
				return;
			}
			chunks.push(bytes);
		});
		stream.on("end", () => resolveInput(Buffer.concat(chunks).toString("utf8")));
		stream.on("error", reject);
	});
}

type StartTarget = { threadId: string; rootSessionId: string; cwd: string; agent: string; model: string; agentType?: string };

function samePath(left: string, right: string): boolean {
	const a = resolve(left), b = resolve(right);
	if (a === b) return true;
	try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

async function snapshotFor(binding: ThreadBinding, model: string): Promise<{ notes: NotesSnapshot; failure?: string }> {
	const openedAt = Date.now();
	try {
		return { notes: await loadNotesSnapshot(notesIdentityFor(binding, model), openedAt) };
	} catch (error) {
		if (isFilesystemError(error)) return { notes: unavailableNotesSnapshot(openedAt) };
		return { notes: unavailableNotesSnapshot(openedAt), failure: shellFree(error) };
	}
}

async function startHook(event: "SessionStart" | "SubagentStart", payload: HookPayload, env: NodeJS.ProcessEnv): Promise<string> {
	let root: string;
	try {
		root = pluginDataRoot(env);
	} catch (error) {
		return warningOutput(shellFree(error));
	}
	const rootSession = text(payload.session_id);
	const childThread = text(payload.agent_id);
	const threadId = event === "SubagentStart" ? childThread : rootSession;
	const cwd = text(payload.cwd);
	const model = modelSlug(payload.model);
	if (threadId === undefined || rootSession === undefined || cwd === undefined || model === undefined) {
		return warningOutput(`notesoup: the ${event} payload is missing a native thread, cwd, or model fact. ${CODEX_SETUP_HINT}`);
	}
	const agentType = event === "SubagentStart" ? text(payload.agent_type) : undefined;
	const agent = event === "SubagentStart"
		? (agentType === undefined ? "anonymous" : slugify(agentType))
		: slugify(env.NOTESOUP_AGENT ?? "anonymous");
	let target: StartTarget;
	try {
		target = { threadId: safeThreadId(threadId), rootSessionId: rootSession, cwd, agent, model, ...(agentType === undefined ? {} : { agentType }) };
	} catch (error) {
		return warningOutput(shellFree(error));
	}
	const transcriptPath = text(payload.transcript_path);
	if (transcriptPath === undefined) return warningOutput(missingNativeFacts("the hook supplied no transcript_path"));
	let native: Awaited<ReturnType<typeof readStartState>>;
	try {
		native = await readStartState({ transcriptPath, threadId: target.threadId });
		if (native.state.rootSessionId !== target.rootSessionId) throw new CodexIdentityError("mismatched_root", "The native transcript's root session does not match the hook's session_id.");
		if (!samePath(native.state.cwd, target.cwd)) throw new CodexIdentityError("mismatched_cwd", "The native transcript's cwd does not match the hook's cwd; refusing to bind a guessed project.");
		if (native.state.currentWindowId === undefined) throw new CodexIdentityError("missing_window", "The native transcript has no materialized context window yet.");
	} catch (error) {
		return warningOutput(missingNativeFacts(shellFree(error)));
	}
	const binding: ThreadBinding = {
		version: 1,
		threadId: target.threadId,
		rootSessionId: native.state.rootSessionId,
		cwd: target.cwd,
		model: target.model,
		agent: target.agent,
		home: notesHome(env),
		transcriptPath,
		windowId: native.state.currentWindowId,
		...(target.agentType === undefined ? {} : { agentType: target.agentType }),
		boundAt: new Date().toISOString(),
	};
	let existing: ThreadBinding | undefined;
	try {
		existing = await readBinding(root, target.threadId);
	} catch (error) {
		if (!(error instanceof CodexIdentityError && error.code === "unknown_thread")) return warningOutput(`notesoup: ${shellFree(error)}`);
	}
	if (existing !== undefined && existing.rootSessionId !== binding.rootSessionId) {
		return warningOutput("notesoup: a previous binding for this thread disagrees on its native root session; refusing to clobber it. Resume the thread once so its hooks rebind it.");
	}
	try {
		await writeBinding(root, binding);
	} catch (error) {
		return warningOutput(`notesoup: could not store this thread's binding (${shellFree(error)}). No boot was injected.`);
	}
	if (findRecordedBoot(native.records, target.threadId, binding.windowId)) {
		// This exact native window already has this thread's own host-injected boot.
		return "";
	}
	const snapshot = await snapshotFor(binding, target.model);
	try {
		await recheckStartState({ transcriptPath, threadId: target.threadId }, native.state);
	} catch (error) {
		return warningOutput(`notesoup: ${shellFree(error)}`);
	}
	const boot = renderCodexBoot({
		threadId: target.threadId,
		agent: target.agent,
		model: target.model,
		state: native.state,
		records: native.records,
		notes: snapshot.notes,
	});
	const withFailure = snapshot.failure === undefined ? boot : `${boot}\n\n${notesFailureBoot(snapshot.failure)}`;
	const tooLarge = bootWithinCap(withFailure);
	if (tooLarge !== undefined) return warningOutput(tooLarge);
	return contextOutput(event, withFailure);
}

function preCompactHook(payload: HookPayload): string {
	// A child rollover has no supported post-compact boot in this native version; stop before history is cut.
	return text(payload.agent_id) === undefined ? "" : JSON.stringify({ continue: false, stopReason: unsupportedChildCompaction() });
}

/** One hook event in, one stdout body out; an unrecognized event is transparent. */
export async function runHook(event: string | undefined, input: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	let payload: HookPayload;
	try {
		const value: unknown = JSON.parse(input);
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("hook input is not an object");
		payload = value as HookPayload;
	} catch (error) {
		return warningOutput(`notesoup: could not read its hook input (${shellFree(error)}). ${CODEX_SETUP_HINT}`);
	}
	// The payload's own event name is advisory; the configured command names the event.
	switch (event) {
		case "SessionStart":
		case "SubagentStart":
			return await startHook(event, payload, env);
		case "PreCompact":
			return preCompactHook(payload);
		default:
			return "";
	}
}
