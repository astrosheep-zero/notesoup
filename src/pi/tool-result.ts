/** Pi transport for host-neutral operations. */
import { defineTool, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { wireResult, type Operation, type Outcome, type Renderer } from "../tools/result.js";

/** Pi's JSON envelope for reset and budget tools; details carry only log/UI metadata. */
export function output(value: unknown, details?: unknown, terminate = false) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details, terminate };
}

/** Operation data is schema-derived JSON; only the unresolved generic needs a JsonValue assertion. */
function piOperationResult<TData>(render: Renderer<TData>, outcome: Outcome<TData>): AgentToolResult<undefined> {
	return {
		content: [{ type: "text", text: render(outcome) }],
		structuredContent: wireResult(outcome) as unknown as JsonValue,
		isError: !outcome.ok,
		details: undefined,
	};
}

export type ToolNamespace = { name: string; description: string };
export const NOTES_NAMESPACE: ToolNamespace = { name: "notes", description: "Notes you choose to keep across context windows. See the memory skill." };
export const HISTORY_NAMESPACE: ToolNamespace = { name: "history", description: "What happened in this session, read-only. See the memory skill." };

/** Register `operation` as a Pi tool; `run` supplies only the host context it needs. */
export function registerOperation<TParams extends TSchema, TData, TRest extends readonly unknown[]>(
	pi: ExtensionAPI,
	operation: Operation<TParams, TData, TRest>,
	run: (params: Static<TParams>, ctx: ExtensionToolContext) => Promise<Outcome<TData>>,
	namespace?: ToolNamespace,
): void {
	pi.registerTool(defineTool<TParams, undefined>({
		name: operation.name,
		label: operation.label,
		description: operation.description,
		parameters: operation.parameters,
		outputSchema: operation.outputSchema,
		executionMode: operation.executionMode,
		...(namespace ? { namespace } : {}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return piOperationResult(operation.render, await run(params, ctx));
		},
	}));
}
