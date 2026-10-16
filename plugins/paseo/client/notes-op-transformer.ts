import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  DIFF_MAX_CHARS,
  NOTES_OP_KIND,
  NOTES_OP_TOOLS,
  PREVIEW_MAX_CHARS,
  READ_TEXT_MAX_CHARS,
  type NotesOp,
  type NotesOpTool,
} from "../shared/notes-op.ts";

type Transformer = Extract<Parameters<PluginClientContext["addTimelineTransformer"]>[0], { query: { itemType: "tool_call" } }>;
type Source = Parameters<Transformer["transform"]>[0];
type ToolCallItem = Extract<Source["item"], { type: "tool_call" }>;

const OP_BY_TOOL: Record<NotesOpTool, NotesOp["op"]> = {
  notes_read: "read",
  notes_write: "write",
  notes_update: "update",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  return chars.length <= maxChars
    ? { text, truncated: false }
    : { text: chars.slice(0, maxChars).join(""), truncated: true };
}

/** Prefer the structured payload; fall back to the rendered text blocks. */
function resultText(output: unknown): string | undefined {
  if (!isRecord(output) || !Array.isArray(output.content)) return undefined;
  const parts = output.content.filter(isRecord).filter((block) => block.type === "text" && typeof block.text === "string");
  return parts.length > 0 ? parts.map((block) => block.text as string).join("\n") : undefined;
}

function baseData(item: ToolCallItem, op: NotesOp["op"], input: unknown): NotesOp | undefined {
  const address = isRecord(input) && typeof input.address === "string" ? input.address : undefined;
  if (!address) return undefined;
  const status = item.status === "running" ? "running" : item.status === "failed" ? "failed" : "completed";
  const crumpled = isRecord(input) && input.crumpled === true ? true : undefined;
  return { op, address, status, ...(crumpled ? { crumpled } : {}) };
}

function notesOpData(item: ToolCallItem): NotesOp | undefined {
  const op = OP_BY_TOOL[item.name as NotesOpTool];
  if (!op || item.detail.type !== "unknown") return undefined;
  const { input, output } = item.detail;
  const data = baseData(item, op, input);
  if (!data) return undefined;
  if (data.status === "running") return data;

  const wire = isRecord(output) && isRecord(output.structuredContent) ? output.structuredContent : undefined;
  if (wire && typeof wire.error === "string") return { ...data, error: wire.error };
  if (data.status === "failed" && !wire) return { ...data, error: resultText(output) ?? "failed" };
  if (!wire) {
    // History replay reconstructs results without the structured payload; parse the rendered text.
    const text = resultText(output);
    if (text === undefined) return data;
    if (op === "read") {
      const clipped = clip(text.split("\n").slice(2).join("\n").replace(/^\n/, ""), READ_TEXT_MAX_CHARS);
      return { ...data, text: clipped.text, ...(clipped.truncated ? { truncated: true } : {}) };
    }
    if (op === "write") {
      const outcome = text.split(" ")[0];
      // Replay still carries the call arguments; the preview comes from input on every path.
      const preview = isRecord(input) && typeof input.content === "string" ? clip(input.content, PREVIEW_MAX_CHARS) : undefined;
      return { ...data, ...(["created", "overwrote", "uncrumpled"].includes(outcome) ? { outcome } : {}), ...(preview ? { preview: preview.text, ...(preview.truncated ? { truncated: true } : {}) } : {}) };
    }
    const head = text.split("\n")[0] ?? "";
    const changeKind = head.startsWith("moved ") ? "moved" : head.startsWith("updated ") ? "body" : head.startsWith("unchanged ") ? "none" : undefined;
    const diffStart = text.indexOf("\ndiff:\n");
    const clippedDiff = diffStart >= 0 ? clip(text.slice(diffStart + 7), DIFF_MAX_CHARS) : undefined;
    return {
      ...data,
      ...(changeKind ? { changeKind } : {}),
      ...(clippedDiff && clippedDiff.text.length > 0 ? { diff: clippedDiff.text, ...(clippedDiff.truncated ? { truncated: true } : {}) } : {}),
    };
  }

  if (op === "read" && typeof wire.text === "string") {
    const clipped = clip(wire.text, READ_TEXT_MAX_CHARS);
    return {
      ...data,
      text: clipped.text,
      truncated: clipped.truncated || wire.next_offset_chars !== null,
      ...(typeof wire.total_chars === "number" ? { totalChars: wire.total_chars } : {}),
    };
  }
  if (op === "write") {
    const preview = isRecord(input) && typeof input.content === "string" ? clip(input.content, PREVIEW_MAX_CHARS) : undefined;
    return {
      ...data,
      ...(typeof wire.outcome === "string" ? { outcome: wire.outcome } : {}),
      ...(preview ? { preview: preview.text, ...(preview.truncated ? { truncated: true } : {}) } : {}),
    };
  }
  const clippedDiff = typeof wire.diff === "string" && wire.diff.length > 0 ? clip(wire.diff, DIFF_MAX_CHARS) : undefined;
  return {
    ...data,
    ...(typeof wire.change_kind === "string" ? { changeKind: wire.change_kind } : {}),
    ...(typeof wire.rename_from === "string" ? { renamedFrom: wire.rename_from } : {}),
    ...(clippedDiff ? { diff: clippedDiff.text, ...(clippedDiff.truncated ? { truncated: true } : {}) } : {}),
  };
}

export const notesOpTransformer = {
  id: "notes-op-source",
  query: { itemType: "tool_call" },
  transform: ({ item }: Pick<Source, "item">) => {
    if (item.type !== "tool_call" || !NOTES_OP_TOOLS.includes(item.name as NotesOpTool)) return undefined;
    const data = notesOpData(item);
    return data === undefined ? undefined : { items: [{ type: "plugin" as const, kind: NOTES_OP_KIND, version: 1, data }] };
  },
} satisfies Transformer;
