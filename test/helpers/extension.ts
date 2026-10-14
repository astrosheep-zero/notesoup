import { notesIdentityFromPi } from "../../plugins/pi/notes/adapter.js";
import { DEFAULT_BOOT_TOOL_NAMES, WINDOW_IDENTITY_CLOSE_TAG } from "../../src/boot/text.js";
import { PI_PRE_RESET_HINTS } from "../../plugins/pi/text.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage, AgentTool, AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionToolContext,
	type RegisteredCommand,
	SessionManager,
	SettingsManager,
	type SessionBoundaryDraft,
	type SessionBeforeCompactEvent,
	type ToolDefinition,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import notesoup, { createNotesoup } from "../../plugins/pi/extension.js";
import { loadNotesSnapshot } from "../../src/boot/snapshot.js";
import { renderBootBlock } from "../../src/boot/render.js";
import { agentSlug, modelSlug } from "../../plugins/pi/notes/adapter.js";
import type { HistoryProjection } from "../../src/history/history.js";
import { rootWindowId } from "../../plugins/pi/window.js";
import { TOOL_OUTPUT_MAX_BYTES } from "../../src/tools/output.js";
import { structuredBytes, type OperationError, type TextWindow } from "../../src/tools/result.js";

let defaultCwd = "/private/tmp/notesoup-test-cwd";
let registerTempPath: ((path: string) => void) | undefined;

export type ExtensionTestEnvironment = {
	readonly cwd: string;
	readonly agentDir: string;
	beforeEach(): void;
	afterEach(): void;
	newNotesRoot(): string;
	dispose(): void;
};

/**
 * Install the process-level settings and notes roots needed by one test file.
 * The caller owns the lifecycle hooks; this helper never registers tests or hooks.
 */
export function installExtensionTestEnvironment(prefix = "notesoup-test"): ExtensionTestEnvironment {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousNotesHome = process.env.PI_NOTES_HOME;
	const defaultAgentDir = mkdtempSync(join(tmpdir(), `${prefix}-agent-`));
	const cwd = mkdtempSync(join(tmpdir(), `${prefix}-cwd-`));
	defaultCwd = cwd;
	const notesRoots = new Set<string>();
	const tempPaths = new Set<string>();
	registerTempPath = (path: string): void => { tempPaths.add(path); };

	const newNotesRoot = (): string => {
		const root = mkdtempSync(join(tmpdir(), `${prefix}-notes-`));
		notesRoots.add(root);
		process.env.PI_NOTES_HOME = root;
		return root;
	};
	const beforeEach = (): void => {
		process.env.PI_CODING_AGENT_DIR = defaultAgentDir;
		newNotesRoot();
	};
	const afterEach = (): void => {
		process.env.PI_CODING_AGENT_DIR = defaultAgentDir;
		for (const root of notesRoots) rmSync(root, { recursive: true, force: true });
		notesRoots.clear();
		for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
		tempPaths.clear();
		if (previousNotesHome === undefined) delete process.env.PI_NOTES_HOME;
		else process.env.PI_NOTES_HOME = previousNotesHome;
	};
	const dispose = (): void => {
		afterEach();
		for (const root of notesRoots) rmSync(root, { recursive: true, force: true });
		rmSync(defaultAgentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
		registerTempPath = undefined;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousNotesHome === undefined) delete process.env.PI_NOTES_HOME;
		else process.env.PI_NOTES_HOME = previousNotesHome;
	};
	return { cwd, agentDir: defaultAgentDir, beforeEach, afterEach, newNotesRoot, dispose };
}

export type Notice = { message: string; type?: "info" | "warning" | "error" };

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

export type SettingsFixture = { cwd: string; agentDir: string };

/**
 * Materialize global (agentDir/settings.json) and project (cwd/.pi/settings.json)
 * settings in temp directories, then read them back through the same public
 * SettingsManager.create the extension uses. Never touches the real ~/.pi.
 */
export function settingsFixture(options: {
	global?: Record<string, unknown>;
	project?: Record<string, unknown>;
	reserveTokens?: number;
} = {}): SettingsFixture {
	const cwd = mkdtempSync(join(tmpdir(), "notesoup-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "notesoup-agent-"));
	const global = { ...(options.global ?? {}) };
	if (options.reserveTokens !== undefined) global.compaction = { reserveTokens: options.reserveTokens };
	writeJson(join(agentDir, "settings.json"), global);
	if (options.project) writeJson(join(cwd, ".pi", "settings.json"), options.project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	registerTempPath?.(cwd);
	registerTempPath?.(agentDir);
	const fixtureManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const projectReserve = (options.project?.compaction as { reserveTokens?: number } | undefined)?.reserveTokens;
	assert.equal(fixtureManager.getCompactionSettings().reserveTokens, projectReserve ?? options.reserveTokens ?? 16_384, "fixture reserve reads back");
	return { cwd, agentDir };
}

export type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

type SendMessageArg = Parameters<ExtensionAPI["sendMessage"]>[0];

export type SentMessage = {
	message: SendMessageArg;
	options: { triggerTurn?: boolean } | undefined;
};

export type Captured = {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, EventHandler[]>;
	commands: Map<string, CommandOptions>;
	sent: SentMessage[];
	contextMessages: unknown[];
	flags: string[];
};

export type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export type CompactionHookResult =
	| { cancel: true }
	| { compaction: { summary: string; firstKeptEntryId: string | null; tokensBefore: number; details?: unknown } }
	| undefined;

/** TypeBox's TSchema does not expose `type`/`required` statically; read them structurally. */
export function objectSchema(tool: ToolDefinition | undefined): { type?: string; required?: string[] } | undefined {
	return tool?.parameters as { type?: string; required?: string[] } | undefined;
}

export function manager(persisted = false): SessionManager {
	if (!persisted) return SessionManager.inMemory("/private/tmp/notesoup-test");
	const dir = mkdtempSync(join(tmpdir(), "notesoup-session-"));
	return SessionManager.create("/private/tmp/notesoup-test", dir);
}

export function makeExtension(sessionManager: SessionManager, settingsManager?: SettingsManager): Captured {
	const captured: Captured = { tools: new Map(), handlers: new Map(), commands: new Map(), sent: [], contextMessages: [], flags: [] };
	const api = {
		registerFlag(name: string) {
			captured.flags.push(name);
		},
		registerTool(tool: ToolDefinition) {
			captured.tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: CommandOptions) {
			captured.commands.set(name, options);
		},
		on(name: string, handler: EventHandler) {
			const handlers = captured.handlers.get(name) ?? [];
			handlers.push(handler);
			captured.handlers.set(name, handlers);
		},
		appendEntry(customType: string, data?: unknown) {
			sessionManager.appendCustomEntry(customType, data);
		},
		sendMessage(message: SendMessageArg, options?: { triggerTurn?: boolean }) {
			captured.sent.push({ message, options });
			sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
	};
	// The harness implements only the ExtensionAPI members this extension uses.
	(settingsManager ? createNotesoup({ settingsManager }) : notesoup)(api as unknown as ExtensionAPI);
	return captured;
}

/** Compare boot addresses to the host projection, without freezing its prose. */
export function assertBootHistory(body: string, projection: HistoryProjection): void {
	const identity = body.split(WINDOW_IDENTITY_CLOSE_TAG)[0]!;
	const lines = [...identity.matchAll(/^([├└]─) (\S+)(?: +(\d+)–(\d*))?/gm)];
	// Only root, the previous window and the current one are shown, however many have existed.
	const shown = new Set([0, projection.windows.length - 2, projection.windows.length - 1]);
	const expected = projection.windows.filter((_window, index) => shown.has(index));
	assert.equal(lines.length, expected.length);
	assert.equal(new Set(lines.map((line) => line[0].indexOf(`${line[3]}–`))).size, 1, "range columns line up");
	const trunk = projection.windows[0]!.windowId.slice(0, projection.windows[0]!.windowId.lastIndexOf(":"));
	assert.ok(identity.split("\n").includes(trunk));
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const window = expected[index]!;
		assert.equal(`${trunk}:${line[2]}`, window.windowId);
		assert.equal(Number(line[3]), Math.min(...window.items.map((item) => item.seq)));
		if (index === lines.length - 1) {
			assert.equal(line[1], "└─");
			assert.equal(line[4], "");
		} else {
			assert.equal(line[1], "├─");
			assert.equal(Number(line[4]), Math.max(...window.items.map((item) => item.seq)));
		}
	}
}

export async function explicitBoot(ctx: ExtensionContext, currentWindowId: string, previousWindowId: string | undefined): Promise<string> {
	return renderBootBlock({
		tools: { ...DEFAULT_BOOT_TOOL_NAMES, preResetHints: PI_PRE_RESET_HINTS },
		agentName: agentSlug(),
		modelName: modelSlug(ctx),
		tree: {
			trunk: currentWindowId.slice(0, currentWindowId.lastIndexOf(":")),
			windows: [...new Set([rootWindowId(ctx.sessionManager.getSessionId()), ...(previousWindowId ? [previousWindowId] : []), currentWindowId])]
				.map((id) => ({ shortName: id.slice(id.lastIndexOf(":") + 1), isCurrent: id === currentWindowId })),
		},
		notes: await loadNotesSnapshot(notesIdentityFromPi(ctx), Date.now()),
	});
}

export function context(
	sessionManager: SessionManager,
	compact?: ExtensionContext["compact"],
	usage?: ContextUsage,
	idle = true,
	cwd = defaultCwd,
	projectTrusted = true,
	model?: string | { provider: string; id: string },
): ExtensionContext {
	const notices: Notice[] = [];
	const compactionRequests: Array<Parameters<ExtensionContext["compact"]>[0]> = [];
	const fake: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "compact" | "isIdle" | "hasPendingMessages" | "cwd" | "isProjectTrusted" | "ui" | "model"> = {
		sessionManager,
		model: typeof model === "string" ? ({ id: model } as unknown as ExtensionContext["model"]) : model as ExtensionContext["model"] | undefined,
		getContextUsage: () => usage,
		compact: (options) => { compactionRequests.push(options); compact?.(options); },
		isIdle: () => idle,
		hasPendingMessages: () => false,
		cwd,
		isProjectTrusted: () => projectTrusted,
		ui: { notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }) } as unknown as ExtensionContext["ui"],
	};
	// Only the members the extension reads; the rest of the ExtensionContext surface is unused.
	return Object.assign(fake as unknown as ExtensionContext, { notices, compactionRequests });
}

export function noticesOf(ctx: ExtensionContext): Notice[] {
	return (ctx as ExtensionContext & { notices: Notice[] }).notices;
}

export function sentOf(captured: Captured, customType: string): SentMessage[] {
	return captured.sent.filter((sent) => sent.message.customType === customType);
}

export async function call(
	captured: Captured,
	name: string,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const tool = captured.tools.get(name);
	assert.ok(tool, `registered ${name}`);
	return tool.execute("call-1", params, new AbortController().signal, () => {}, toolContext(ctx));
}

/**
 * The context Pi hands a registered tool: the session context plus the nested-call surface
 * (ExtensionToolContext). The registered notes/history tools never call another tool, so `tools`
 * is empty and `executeTool` refuses instead of pretending a runtime exists.
 */
export function toolContext(ctx: ExtensionContext, callable: readonly AgentTool[] = []): ExtensionToolContext {
	// The prototype keeps whatever the caller handed in reachable, including session methods on a
	// real manager, while the nested-call members stay local to this one tool invocation.
	return Object.assign(Object.create(ctx) as ExtensionContext, {
		tools: callable,
		executeTool: async (callerId: string, name: string): Promise<AgentToolCallOutcome> => ({
			toolCall: { type: "toolCall", id: `${callerId}/1`, name, arguments: {} },
			result: { content: [{ type: "text", text: `nested tool ${name} is unavailable in this harness` }], details: undefined, isError: true },
			isError: true,
		}),
	});
}

/** Decoded JSON of a tool that has not moved to structured outcomes: reset and budget tools only. */
export function resultJson<T>(result: AgentToolResult<unknown>): T {
	const text = result.content[0];
	assert.ok(text && text.type === "text", "tool result carries text");
	return JSON.parse(text.text) as T;
}

function outcomeOf(result: AgentToolResult<unknown>): Record<string, unknown> {
	const structured = result.structuredContent;
	assert.ok(typeof structured === "object" && structured !== null && !Array.isArray(structured), "tool result carries a structured outcome");
	return structured as Record<string, unknown>;
}

function isOperationError(value: unknown): value is OperationError {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { code?: unknown; message?: unknown };
	return typeof candidate.code === "string" && typeof candidate.message === "string";
}

function isTextWindow(value: unknown): value is TextWindow {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<TextWindow>;
	return typeof candidate.text === "string" && typeof candidate.total_chars === "number" &&
		(candidate.next_offset_chars === null || typeof candidate.next_offset_chars === "number");
}

/** Data of a successful outcome, asserting both the structured success and the non-error result. */
export function resultData<T>(result: AgentToolResult<unknown>): T {
	const outcome = outcomeOf(result);
	assert.equal("error" in outcome, false, `expected success, got refusal ${JSON.stringify(outcome)}`);
	assert.notEqual(result.isError, true, "a successful outcome is never delivered as an error result");
	return outcome as T;
}

/** The typed refusal of a failed outcome, asserting the error result and the refusal shape. */
export function resultError(result: AgentToolResult<unknown>): OperationError {
	const outcome = outcomeOf(result);
	assert.equal(result.isError, true, "a refusal is delivered as an error result");
	const error = { code: outcome.code, message: outcome.error };
	assert.ok(isOperationError(error), "refusal carries a code and an error message");
	return error;
}

/** Identity a read outcome carries next to its window; tests narrow it with an explicit type. */
export type ReadIdentity = { metadata?: Record<string, unknown>; address?: string; seq?: number; window_id?: string };

/** The structured data of a read outcome: the window plus whatever identity the operation adds. */
export type ReadOutcome<T extends object = ReadIdentity> = TextWindow & T;

/** A read as tests consume it: its window fields, plus `content` as a test-only alias for `text`. */
export type ReadWindowResult<T extends object = ReadIdentity> = TextWindow & { content: string } & T;

export function resultRead<T extends object = ReadIdentity>(result: AgentToolResult<unknown>): ReadWindowResult<T> {
	const data = resultData<ReadOutcome<T>>(result);
	assert.ok(isTextWindow(data), "read carries flat text and pagination fields");
	return { ...data, content: data.text };
}

/** Assert both surfaces of one result fit the wire budget: the model text and the structured payload. */
export function assertWithinBudget(result: AgentToolResult<unknown>, message: string): void {
	const text = result.content[0];
	const bytes = text && text.type === "text" ? Buffer.byteLength(text.text, "utf8") : 0;
	assert.ok(bytes <= TOOL_OUTPUT_MAX_BYTES, `${message}: model text is ${bytes} bytes over the ${TOOL_OUTPUT_MAX_BYTES}-byte budget`);
	if (result.structuredContent !== undefined) {
		const structured = structuredBytes(result.structuredContent);
		assert.ok(structured <= TOOL_OUTPUT_MAX_BYTES, `${message}: structured outcome is ${structured} bytes over the ${TOOL_OUTPUT_MAX_BYTES}-byte budget`);
	}
}

export async function runManualCompact(captured: Captured, ctx: ExtensionContext): Promise<CompactionHookResult> {
	const handler = captured.handlers.get("session_before_compact")?.[0];
	assert.ok(handler, "session_before_compact handler registered");
	const event: SessionBeforeCompactEvent = {
		type: "session_before_compact",
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		branchEntries: ctx.sessionManager.getBranch(),
		preparation: {
			firstKeptEntryId: "",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 0,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
		},
	};
	return (await handler(event as never, ctx)) as CompactionHookResult;
}

export async function runHandlers(captured: Captured, name: string, event: unknown, ctx: ExtensionContext): Promise<void> {
	const isIdle = ctx.isIdle;
	if (name === "agent_settled") ctx.isIdle = () => true;
	try {
		for (const handler of captured.handlers.get(name) ?? []) await handler(event as never, ctx);
	} finally { ctx.isIdle = isIdle; }
}

export async function runCommand(captured: Captured, name: string, args: string, ctx: ExtensionContext): Promise<Notice[]> {
	const command = captured.commands.get(name);
	assert.ok(command, `${name} command registered`);
	const notices: Notice[] = [];
	const cmdCtx = Object.assign({}, ctx, {
		waitForIdle: async () => {},
		ui: { notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }) },
	}) as unknown as ExtensionCommandContext;
	await command.handler(args, cmdCtx);
	return notices;
}

export type ContextHookResult = { messages: unknown[] } | undefined;

export async function runContextHook(captured: Captured, ctx: ExtensionContext, eventOverride: Record<string, unknown> = {}): Promise<ContextHookResult> {
	const handlers = captured.handlers.get("context") ?? [];
	assert.ok(handlers.length > 0, "context handler registered");
	// Pi invokes every registered context handler in order; budget and warning each own one.
	let result: ContextHookResult;
	for (const handler of handlers) {
		const returned = (await handler({ type: "context", messages: [], ...eventOverride } as never, ctx)) as ContextHookResult;
		if (returned !== undefined) {
			captured.contextMessages.push(...returned.messages);
			result = result ? { messages: [...result.messages, ...returned.messages] } : returned;
		}
	}
	return result;
}

export async function runContextWithSystemHook(
	captured: Captured,
	ctx: ExtensionContext,
	messages: unknown[],
): Promise<ContextHookResult> {
	const handlers = captured.handlers.get("context_with_system") ?? [];
	assert.ok(handlers.length > 0, "context_with_system handler registered");
	let result: ContextHookResult;
	for (const handler of handlers) {
		const returned = (await handler({ type: "context_with_system", messages } as never, ctx)) as ContextHookResult;
		if (returned !== undefined) {
			captured.contextMessages.push(...returned.messages);
			result = result ? { messages: [...result.messages, ...returned.messages] } : returned;
		}
	}
	return result;
}

export async function commitTurnEndBoundary(captured: Captured, sessionManager: SessionManager, ctx: ExtensionContext): Promise<{ entries: SessionBoundaryDraft[]; continue: boolean }> {
	let entries: SessionBoundaryDraft[] = [];
	let shouldContinue = false;
	const event: TurnEndEvent = {
		type: "turn_end",
		entries,
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
		outcome: "completed",
		turnIndex: 0,
		message: { role: "assistant", content: [], stopReason: "stop", timestamp: Date.now() } as unknown as AgentMessage,
		toolResults: [],
		messageEntryId: "assistant-entry",
		toolResultEntryIds: [],
	};
	for (const handler of captured.handlers.get("turn_end") ?? []) {
		event.entries = entries;
		const result = (await handler(event as never, ctx)) as { entries?: SessionBoundaryDraft[]; continue?: boolean } | undefined;
		if (result?.entries !== undefined) entries = result.entries;
		if (result?.continue !== undefined) shouldContinue = result.continue;
	}
	for (const entry of entries) {
		switch (entry.type) {
			case "custom":
				sessionManager.appendCustomEntry(entry.customType, entry.data);
				break;
			case "custom_message":
				sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
				break;
			case "compaction":
				sessionManager.appendCompaction(entry.summary, entry.firstKeptEntryId, 0, entry.details, true, entry.usage);
				break;
			case "context_edit":
				sessionManager.appendContextEdit(entry.targetId, entry.replacement);
				break;
		}
	}
	return { entries, continue: shouldContinue };
}

export function appendText(sessionManager: SessionManager, role: "user" | "assistant" | "toolResult", text: string, toolName = "bash"): string {
	const base = {
		role,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
		...(role === "assistant" ? { stopReason: "stop" } : {}),
		...(role === "toolResult" ? { toolCallId: "call-1", toolName, isError: false } : {}),
	};
	// Assistant/toolResult messages carry provider metadata (usage, stopReason, ids)
	// that SessionManager persists opaquely and the extension never reads, so the
	// harness stores the minimal shape.
	type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];
	return sessionManager.appendMessage(base as unknown as AppendableMessage);
}
