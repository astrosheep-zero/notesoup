/** Pi transport for host-neutral operations. */
import { defineTool, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition, type ToolExposure } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { wireResult, type Operation, type Outcome, type Renderer } from "../../src/tools/result.js";

/** Pi's JSON envelope for reset and budget tools; details carry only log/UI metadata. */
export function output(value: unknown, details?: unknown, terminate = false) {
	// A refusal is a failed tool call, not a successful answer carrying an error string: the host UI only flags isError.
	const refused = typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string";
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details, terminate, ...(refused ? { isError: true } : {}) };
}

/** Operation data is schema-derived JSON; only the unresolved generic needs a JsonValue assertion. */
function piOperationResult<TData, TDetails = undefined>(render: Renderer<TData>, outcome: Outcome<TData>, details?: TDetails): AgentToolResult<TDetails> {
	return {
		content: [{ type: "text", text: render(outcome) }],
		structuredContent: wireResult(outcome) as unknown as JsonValue,
		isError: !outcome.ok,
		details: details as TDetails,
	};
}

export type ToolNamespace = { name: string; description: string };
export const NOTES_NAMESPACE: ToolNamespace = { name: "notes", description: "Notes you choose to keep across context windows. See the memory skill." };
export const DREAM_NAMESPACE: ToolNamespace = { name: "dream", description: "Consolidate one project's notes: begin, edit with notes_*, forget crumpled notes, end." };
export const HISTORY_NAMESPACE: ToolNamespace = { name: "history", description: "What happened in this session, read-only. See the memory skill." };

/** Optional TUI renderers; without them the host draws its default call line and receipt text. */
export type OperationRenderers<TParams extends TSchema, TDetails = undefined> = Pick<ToolDefinition<TParams, TDetails>, "renderCall" | "renderResult">;

/** Register `operation` as a Pi tool; `run` supplies only the host context it needs. */
export function registerOperation<TParams extends TSchema, TData, TRest extends readonly unknown[], TDetails = undefined>(
	pi: ExtensionAPI,
	operation: Operation<TParams, TData, TRest>,
	run: (params: Static<TParams>, ctx: ExtensionToolContext) => Promise<Outcome<TData> & { details?: TDetails }>,
	namespace?: ToolNamespace,
	renderers?: OperationRenderers<TParams, TDetails>,
	exposure?: ToolExposure,
): void {
	pi.registerTool(defineTool<TParams, TDetails>({
		name: operation.name,
		label: operation.label,
		description: operation.description,
		parameters: operation.parameters,
		outputSchema: operation.outputSchema,
		executionMode: operation.executionMode,
		...(namespace ? { namespace } : {}),
		...(exposure ? { exposure } : {}),
		...renderers,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await run(params, ctx);
			return piOperationResult(operation.render, result, result.details);
		},
	}));
}
