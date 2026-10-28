import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  NOTES_OP_KIND,
  NOTES_OP_TOOLS,
  outputPreview,
  type NotesOp,
  type NotesOpTool,
} from "../shared/notes-op.ts";
import { isRecord, notesoupToolName, resultError, resultText } from "./tool-result.ts";

type Transformer = Extract<Parameters<PluginClientContext["addTimelineTransformer"]>[0], { query: { itemType: "tool_call" } }>;
type Source = Parameters<Transformer["transform"]>[0];
type ToolCallItem = Extract<Source["item"], { type: "tool_call" }>;

const OP_BY_TOOL: Record<NotesOpTool, NotesOp["op"]> = {
  notes_read: "read",
  notes_write: "write",
  notes_update: "update",
};

function editsDiff(input: unknown): string | undefined {
  if (!isRecord(input) || !Array.isArray(input.edits)) return undefined;
  const lines: string[] = [];
  for (const edit of input.edits) {
    if (!isRecord(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string" || edit.oldText === edit.newText) continue;
    for (const line of edit.oldText.split("\n")) lines.push(`- ${line}`);
    for (const line of edit.newText.split("\n")) lines.push(`+ ${line}`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function notesOpData(item: ToolCallItem, tool: NotesOpTool): NotesOp | undefined {
  const op = OP_BY_TOOL[tool];
  if (item.detail.type !== "unknown") return undefined;
  const { input, output } = item.detail;
  const address = isRecord(input) && typeof input.address === "string" ? input.address : undefined;
  if (!address) return undefined;
  const data: NotesOp = {
    op,
    address,
    status: item.status === "running" ? "running" : item.status === "failed" ? "failed" : "completed",
    ...(isRecord(input) && input.crumpled === true ? { crumpled: true } : {}),
  };
  if (data.status === "running") return data;

  if (data.status === "failed") return { ...data, error: resultError(output, item.error) };
  if (op === "write") return { ...data, ...(isRecord(input) && typeof input.content === "string" ? { preview: outputPreview(input.content) } : {}) };
  // One projection for Pi live/history and Claude; keep upstream continuation markers.
  const text = resultText(output);
  if (text === undefined) return data;
  if (op === "read") return { ...data, text: outputPreview(text.split("\n").slice(2).join("\n").replace(/^\n/, "")) };
  const detailsDiff = isRecord(output) && isRecord(output.details) && typeof output.details.diff === "string" && output.details.diff.length > 0
    ? output.details.diff
    : undefined;
  const diffStart = text.indexOf("\ndiff:\n");
  const rawDiff = detailsDiff ?? (diffStart >= 0 ? text.slice(diffStart + 7) : text.startsWith("unchanged ") ? undefined : editsDiff(input));
  return {
    ...data,
    ...(text.startsWith("moved ") && isRecord(input) && typeof input.rename_to === "string" ? { renamedFrom: data.address, address: input.rename_to } : {}),
    ...(rawDiff !== undefined ? { diff: outputPreview(rawDiff) } : {}),
  };
}

export const notesOpTransformer = {
  id: "notes-op-source",
  query: { itemType: "tool_call" },
  transform: ({ item }: Pick<Source, "item">) => {
    if (item.type !== "tool_call") return undefined;
    const tool = notesoupToolName(item.name) as NotesOpTool;
    if (!NOTES_OP_TOOLS.includes(tool)) return undefined;
    const data = notesOpData(item, tool);
    return data === undefined ? undefined : { items: [{ type: "plugin" as const, kind: NOTES_OP_KIND, version: 1, data }] };
  },
} satisfies Transformer;
