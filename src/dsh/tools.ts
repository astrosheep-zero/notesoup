import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { defineTool, type JsonSchemaNode, type ObjectJsonSchema, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { notesList, notesRead, notesSearch, notesUpdate, notesWrite } from "../tools/notes.js";
import { historyList, historyRead, historyWindows } from "../tools/history.js";
import { success, type Operation } from "../tools/result.js";
import { historyProjection } from "./history.js";
import { notesIdentity } from "./window.js";
import { measureBudget } from "./budget.js";
import { preflight, type NotesoupCompactionEngine } from "./engine.js";

/** dsh enforces a small schema subset; TypeBox remains the full validator at execution. */
function hostSchema(schema: TSchema): JsonSchemaNode {
	const value = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of ["type", "required", "additionalProperties", "enum", "const", "description", "title", "default", "examples"]) if (value[key] !== undefined) result[key] = value[key];
	const bounds = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"].filter((key) => value[key] !== undefined).map((key) => `${key}=${value[key]}`);
	if (bounds.length) result.description = [value.description, bounds.join(", ")].filter(Boolean).join("; ");
	if (Array.isArray(value.anyOf)) result.oneOf = value.anyOf.map((branch) => hostSchema(branch as TSchema));
	if (value.properties) result.properties = Object.fromEntries(Object.entries(value.properties as Record<string, TSchema>).map(([key, child]) => [key, hostSchema(child)]));
	if (value.items) result.items = hostSchema(value.items as TSchema);
	return result as JsonSchemaNode;
}
function requireAgent(exec: ToolRunContext): Agent {
	if (!exec.agent) throw new HarnessError("notesoup: this tool needs an agent session; call it from a dsh agent.", "AGENT_REQUIRED");
	exec.signal.throwIfAborted();
	return exec.agent;
}

function register<P extends TSchema, D, R extends readonly unknown[]>(ctx: Context, operation: Operation<P, D, R>, inputs: (agent: Agent) => Readonly<R> | Promise<Readonly<R>>): void {
	ctx.tools.register({
		name: operation.name,
		description: operation.description,
		parameters: hostSchema(operation.parameters) as ObjectJsonSchema & Record<string, unknown>,
		output: {
			schema: hostSchema(operation.outputSchema),
			render: (_args, value) => [{ type: "text", text: operation.render(success(value as D)) }],
		},
		async execute(args, exec) {
			const agent = requireAgent(exec);
			preflight(ctx);
			if (!Check(operation.parameters, args)) {
				const error = Errors(operation.parameters, args).find((problem) => problem.keyword !== "boolean");
				throw new HarnessError(`notesoup: invalid ${operation.name} parameter ${error?.instancePath || "/"}: ${error?.message ?? "invalid value"}; use the tool schema's bounds.`, "INVALID_PARAMS");
			}
			const rest = await inputs(agent);
			exec.signal.throwIfAborted();
			const result = await operation.execute(args as Static<P>, ...rest);
			if (!result.ok) throw new HarnessError(operation.render(result), result.error.code);
			return result.data;
		},
	});
}

export function registerTools(ctx: Context, engine: NotesoupCompactionEngine): void {
	const nestedResets = new WeakMap<Agent, Set<string>>();
	ctx.on("tools/result", (exec, result) => {
		if (!exec.agent) return;
		const state = engine.windows.get(exec.agent.session);
		if (exec.name === "empty_brain" && !result.isError && (result.value as { window_id?: string }).window_id === state.snapshot.windowId) {
			if (!exec.parent) state.pendingReset = true;
			else {
				const roots = nestedResets.get(exec.agent) ?? new Set<string>();
				roots.add(exec.rootCallId);
				nestedResets.set(exec.agent, roots);
			}
		}
		if (!exec.parent && nestedResets.get(exec.agent)?.delete(exec.rootCallId) && !result.isError) state.pendingReset = true;
	});
	const identity = (agent: Agent) => notesIdentity(agent, engine.config);
	register(ctx, notesWrite, (agent) => [identity(agent)] as const);
	register(ctx, notesUpdate, (agent) => [identity(agent)] as const);
	register(ctx, notesRead, (agent) => [identity(agent)] as const);
	register(ctx, notesList, (agent) => [identity(agent)] as const);
	register(ctx, notesSearch, (agent) => [identity(agent)] as const);
	register(ctx, historyList, async (agent) => [await historyProjection(ctx, agent.session.id)] as const);
	register(ctx, historyRead, async (agent) => [await historyProjection(ctx, agent.session.id)] as const);
	register(ctx, historyWindows, async (agent) => [await historyProjection(ctx, agent.session.id), agent.session.id] as const);
	ctx.tools.register(defineTool({
		name: "empty_brain",
		description: "Open a fresh context window after this tool batch. Write recovery notes first; notes and raw history stay on disk.",
		parameters: {},
		output: { schema: { type: "object", properties: { window_id: { type: "string", required: true }, reset_requested: { type: "boolean", required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: "text", text: `notesoup: reset requested for ${value.window_id}; finish this tool batch, then recover from your notes.` }] },
		async execute(_args, exec) {
			const agent = requireAgent(exec);
			preflight(ctx);
			const state = engine.windows.get(agent.session);
			return { window_id: state.snapshot.windowId, reset_requested: true };
		},
	}));
	ctx.tools.register(defineTool({
		name: "get_context_remaining",
		description: "Estimated tokens left before the notes close-out warning; null when dsh has no model contextWindow.",
		parameters: {},
		output: { schema: { type: "object", properties: { remaining_tokens: { oneOf: [{ type: "integer" }, { type: "null" }], required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
		async execute(_args, exec) {
			const agent = requireAgent(exec);
			preflight(ctx);
			const budget = await measureBudget(ctx, agent, engine.config, exec.signal);
			return { remaining_tokens: budget?.countdown ?? null };
		},
	}));
}
