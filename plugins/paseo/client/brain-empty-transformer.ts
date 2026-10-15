import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BRAIN_EMPTY_KIND, BRAIN_EMPTY_TOOL, type BrainEmpty } from "../shared/brain-empty.ts";

type Transformer = Extract<Parameters<PluginClientContext["addTimelineTransformer"]>[0], { query: { itemType: "tool_call" } }>;
type Source = Parameters<Transformer["transform"]>[0];
type ToolCallItem = Extract<Source["item"], { type: "tool_call" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** empty_brain answers in a plain JSON text block; there is no structured payload. */
function resultJson(output: unknown): Record<string, unknown> | undefined {
  if (!isRecord(output) || !Array.isArray(output.content)) return undefined;
  const part = output.content.filter(isRecord).find((block) => block.type === "text" && typeof block.text === "string");
  if (!part) return undefined;
  try {
    const parsed: unknown = JSON.parse(part.text as string);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brainEmptyData(item: ToolCallItem): BrainEmpty | undefined {
  if (item.detail.type !== "unknown") return undefined;
  if (item.status === "running") return { status: "running" };
  const wire = resultJson(item.detail.output);
  if (wire && typeof wire.error === "string") return { status: item.status === "failed" ? "failed" : "completed", error: wire.error };
  if (item.status === "failed") return { status: "failed", error: wire === undefined ? "failed" : undefined };
  if (wire && typeof wire.status === "string") return { status: "completed", outcome: wire.status };
  return { status: "completed" };
}

export const brainEmptyTransformer = {
  id: "brain-empty-source",
  query: { itemType: "tool_call" },
  transform: ({ item }: Pick<Source, "item">) => {
    if (item.type !== "tool_call" || item.name !== BRAIN_EMPTY_TOOL) return undefined;
    const data = brainEmptyData(item);
    return data === undefined ? undefined : { items: [{ type: "plugin" as const, kind: BRAIN_EMPTY_KIND, version: 1, data }] };
  },
} satisfies Transformer;
