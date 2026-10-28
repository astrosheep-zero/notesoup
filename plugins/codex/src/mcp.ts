/** The portable stdio MCP server: shared notes/history operations over host-owned tool names. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { Check, Errors } from "typebox/value";
import type { TSchema } from "typebox";
import { notesList, notesRead, notesSearch, notesUpdate, notesWrite } from "../../../src/tools/notes.js";
import { historyList, historyRead } from "../../../src/tools/history.js";
import { wireResult, type Operation, type Outcome } from "../../../src/tools/result.js";
import { CodexIdentityError, notesIdentityFor, pluginDataRoot, readBinding, rootSessionIdOf, safeThreadId, turnModel, type ThreadBinding } from "./identity.js";
import { readCodexHistory } from "./history.js";
import { localHistoryCorpus } from "../../../src/history/local.js";
import { readStartState } from "./state.js";
import { notesToolContext } from "../../../src/tools/notes-context.js";

type Bound = {
	readonly operation: Operation<TSchema, unknown, readonly unknown[]>;
	readonly history: boolean;
};

const OPERATIONS: Record<string, Bound> = {
	notes_write: { operation: notesWrite as unknown as Bound["operation"], history: false },
	notes_update: { operation: notesUpdate as unknown as Bound["operation"], history: false },
	notes_read: { operation: notesRead as unknown as Bound["operation"], history: false },
	notes_list: { operation: notesList as unknown as Bound["operation"], history: false },
	notes_search: { operation: notesSearch as unknown as Bound["operation"], history: false },
	history_list: { operation: historyList as unknown as Bound["operation"], history: true },
	history_read: { operation: historyRead as unknown as Bound["operation"], history: true },
};

function shellFree(reason: unknown): string {
	const value = reason instanceof Error ? reason.message : String(reason);
	return value.replace(/[\r\n]+/g, " ").slice(0, 500);
}

function failure(code: string, message: string): CallToolResult {
	return {
		content: [{ type: "text", text: `error: ${code}: ${message}` }],
		structuredContent: { error: message, code },
		isError: true,
	};
}

function successFor(bound: Bound, outcome: Outcome<unknown>): CallToolResult {
	const wire = wireResult(outcome);
	return {
		content: [{ type: "text", text: bound.operation.render(outcome) }],
		structuredContent: wire as Record<string, unknown>,
		// A refusal stays a tool-level error so the model does not mistake it for data.
		...(outcome.ok ? {} : { isError: true }),
	};
}

/** The first schema violation, named by parameter so the model can fix that one field. */
function paramProblem(schema: TSchema, params: unknown): string {
	const first = Errors(schema, params).find((error) => error.keyword !== "boolean");
	if (!first) return "unrecognized shape";
	const extra = first.keyword === "additionalProperties" ? `: ${(first.params as { additionalProperties: string[] }).additionalProperties.join(", ")}` : "";
	const field = first.instancePath.replace(/^\//, "").replaceAll("/", ".");
	return `${field ? `${field} ` : ""}${first.message}${extra}`;
}

type NativeFacts = { threadId: string; rootSessionId: string; currentWindowId?: string };

/** MCP metadata is the caller's claim; it must agree with the hook binding before any read. */
function metaFacts(meta: Record<string, unknown>, binding: ThreadBinding): { rootSessionId: string } {
	const rootSessionId = rootSessionIdOf(meta);
	if (binding.rootSessionId !== rootSessionId) {
		throw new CodexIdentityError("stale_thread_binding", "This thread's hook binding disagrees with Codex's current root session. Resume the thread once so its hooks rebind it; notesoup will not read or write through stale identity.");
	}
	const windowId = typeof meta.windowId === "string" && meta.windowId !== "" ? meta.windowId : undefined;
	if (windowId === undefined) throw new CodexIdentityError("missing_window", "Codex did not supply the current native window in MCP metadata; refusing to use a possibly stale binding.");
	if (binding.windowId !== windowId) throw new CodexIdentityError("stale_thread_binding", "This thread's hook binding belongs to a different native window. Resume or compact once so the SessionStart hook rebinds it; notesoup will not read or write through stale identity.");
	return { rootSessionId };
}

async function identityFor(meta: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<{ binding: ThreadBinding; rootSessionId: string; model: string }> {
	const threadId = safeThreadId(meta.threadId, "MCP threadId");
	const binding = await readBinding(pluginDataRoot(env), threadId);
	const { rootSessionId } = metaFacts(meta, binding);
	return { binding, rootSessionId, model: turnModel(meta) };
}

/** The binding is only a cache: the transcript is the fact. Both notes and history must pass this. */
function verifyNativeFacts(binding: ThreadBinding, rootSessionId: string, native: NativeFacts): void {
	if (native.threadId !== binding.threadId) throw new CodexIdentityError("stale_native_state", "The native transcript belongs to a different thread than the hook binding; refusing to read or write through it.");
	if (native.rootSessionId !== binding.rootSessionId || native.rootSessionId !== rootSessionId) {
		throw new CodexIdentityError("stale_native_state", "The native transcript no longer matches this thread's root session; refusing to read or write mixed or stale identity.");
	}
	if (native.currentWindowId === undefined) throw new CodexIdentityError("missing_window", "The native transcript has no materialized current window; refusing to guess one.");
	if (native.currentWindowId !== binding.windowId) {
		throw new CodexIdentityError("stale_native_state", "The native transcript advanced to a different window. Resume or compact once so the SessionStart hook rebinds it; notesoup will not read or write through stale identity.");
	}
}

function sameBinding(left: ThreadBinding, right: ThreadBinding): boolean {
	return left.version === right.version
		&& left.threadId === right.threadId
		&& left.rootSessionId === right.rootSessionId
		&& left.cwd === right.cwd
		&& left.agent === right.agent
		&& left.home === right.home
		&& left.transcriptPath === right.transcriptPath
		&& left.windowId === right.windowId
		&& left.agentType === right.agentType;
}

async function readNative(binding: ThreadBinding, rootSessionId: string, history: boolean, meta: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<Awaited<ReturnType<typeof readCodexHistory>> | NativeFacts> {
	if (binding.transcriptPath === "") throw new CodexIdentityError("missing_transcript", "This thread's hook binding has no native transcript path; notes and history are unavailable until Codex materializes a transcript and the hook rebinds it.");
	const source = { transcriptPath: binding.transcriptPath, threadId: binding.threadId };
	const native = history ? await readCodexHistory(source) : (await readStartState(source)).state;
	verifyNativeFacts(binding, rootSessionId, native);
	// Native reads are asynchronous: a hook may have rebound this thread while we were
	// reading. Compare again before trusting either the cached binding or a mutation.
	const reread = await readBinding(pluginDataRoot(env), binding.threadId);
	if (!sameBinding(binding, reread)) {
		throw new CodexIdentityError("stale_thread_binding", "This thread's hook binding changed while notesoup was reading native facts; retry once the new native window is settled.");
	}
	// The caller's metadata and the fresh binding must still agree after the await.
	metaFacts(meta, reread);
	verifyNativeFacts(reread, rootSessionId, native);
	return native;
}

export async function callTool(name: string, args: unknown, meta: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<CallToolResult> {
	const bound = Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name]! : undefined;
	if (bound === undefined) return failure("unknown_tool", `No notesoup operation named ${JSON.stringify(name)}.`);
	const params = args ?? {};
	if (!Check(bound.operation.parameters, params)) return failure("invalid_params", `invalid ${name} parameters: ${paramProblem(bound.operation.parameters, params)}`);
	try {
		const { binding, rootSessionId, model } = await identityFor(meta, env);
		const targetedHistory = bound.history && (params as { session?: string }).session !== undefined;
		const native = await readNative(binding, rootSessionId, bound.history && !targetedHistory, meta, env);
		if (!bound.history) {
			const outcome = await bound.operation.execute(params, notesToolContext(notesIdentityFor(binding, model), binding.cwd)) as Outcome<unknown>;
			return successFor(bound, outcome);
		}
		const current = async () => (await readNative(binding, rootSessionId, true, meta, env) as Awaited<ReturnType<typeof readCodexHistory>>).projection;
		const context = targetedHistory ? { current, corpus: localHistoryCorpus({ env, current: { harness: "codex", id: binding.threadId, load: async () => ({ projection: await current() }) } }) } : (native as Awaited<ReturnType<typeof readCodexHistory>>).projection;
		const outcome = await bound.operation.execute(params, context) as Outcome<unknown>;
		return successFor(bound, outcome);
	} catch (error) {
		if (error instanceof CodexIdentityError) return failure(error.code, error.message);
		return failure("codex_error", shellFree(error));
	}
}

export function tools(): Tool[] {
	return Object.entries(OPERATIONS).map(([name, bound]) => ({
		name,
		description: bound.operation.description,
		inputSchema: JSON.parse(JSON.stringify(bound.operation.parameters)) as Tool["inputSchema"],
		// Every shared success and refusal is an object; the union stays the same
		// logical schema, wrapped in the object shape the MCP tool schema requires.
		outputSchema: { type: "object", ...JSON.parse(JSON.stringify(bound.operation.outputSchema)) } as NonNullable<Tool["outputSchema"]>,
	}));
}

export function createServer(env: NodeJS.ProcessEnv = process.env): Server {
	const server = new Server({ name: "notesoup", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const meta = (request.params._meta ?? {}) as Record<string, unknown>;
		return await callTool(request.params.name, request.params.arguments, meta, env);
	});
	return server;
}

export async function runMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const server = createServer(env);
	await server.connect(new StdioServerTransport());
}
