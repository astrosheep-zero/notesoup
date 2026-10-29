import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BRAIN_EMPTY_KIND, BRAIN_EMPTY_TOOL, type BrainEmpty } from "../shared/brain-empty.ts";
import { isRecord, notesoupToolName, resultError, resultText } from "./tool-result.ts";

type Transformer = Extract<Parameters<PluginClientContext["addTimelineTransformer"]>[0], { query: { itemType: "tool_call" } }>;
type Source = Parameters<Transformer["transform"]>[0];
type ToolCallItem = Extract<Source["item"], { type: "tool_call" }>;

/** Pi answers in JSON text; Claude normally returns a plain acknowledgement. */
function resultJson(output: unknown): Record<string, unknown> | undefined {
  const text = resultText(output);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brainEmptyData(item: ToolCallItem): BrainEmpty | undefined {
  if (item.detail.type !== "unknown") return undefined;
  const input = isRecord(item.detail.input) ? item.detail.input : undefined;
  const rawLastWord = input?.last_word;
  const lastWord = typeof rawLastWord === "string" ? rawLastWord.trim() : "";
  const base = lastWord ? { lastWord } : {};
  if (item.status === "running") return { status: "running" };
  const wire = resultJson(item.detail.output);
  if (wire && typeof wire.error === "string") return { status: item.status === "failed" ? "failed" : "completed", error: wire.error };
  if (item.status === "failed") return { status: "failed", error: resultError(item.detail.output, item.error) };
  if (wire && typeof wire.status === "string") return { status: "completed", outcome: wire.status, ...(wire.status === "rollover_requested" ? base : {}) };
  return { status: "completed" };
}

export const brainEmptyTransformer = {
  id: "brain-empty-source",
  query: { itemType: "tool_call" },
  transform: ({ item }: Pick<Source, "item">) => {
    if (item.type !== "tool_call" || notesoupToolName(item.name) !== BRAIN_EMPTY_TOOL) return undefined;
    const data = brainEmptyData(item);
    return data === undefined ? undefined : { items: [{ type: "plugin" as const, kind: BRAIN_EMPTY_KIND, version: 1, data }] };
  },
} satisfies Transformer;
