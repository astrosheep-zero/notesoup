import { z } from "zod";

/** Client display budget, including the omission line; source history stays unchanged. */
export const OUTPUT_DISPLAY_MAX_CHARS = 32_000;
export const COLLAPSED_PREVIEW_MAX_CHARS = 1_000;
export function outputPreview(text: string, maxChars = OUTPUT_DISPLAY_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const middle = "\n\n… Showing the beginning and end; the middle is hidden in this preview. …\n\n";
  const headChars = Math.floor((maxChars - middle.length) / 2);
  // Budget in UTF-16 units, but never split a surrogate pair.
  const head = text.slice(0, headChars).replace(/[\uD800-\uDBFF]$/, "");
  const tail = text.slice(-(maxChars - middle.length - headChars)).replace(/^[\uDC00-\uDFFF]/, "");
  return head + middle + tail;
}

export const NOTES_OP_KIND = "notes-op";
export const NOTES_OP_TOOLS = ["notes_read", "notes_write", "notes_update"] as const;
export type NotesOpTool = (typeof NOTES_OP_TOOLS)[number];

export const notesOpSchema = z.object({
  op: z.enum(["read", "write", "update"]),
  address: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  error: z.string().optional(),
  // read
  text: z.string().optional(),
  // write
  preview: z.string().optional(),
  // update
  diff: z.string().optional(),
  renamedFrom: z.string().optional(),
  crumpled: z.boolean().optional(),
});
export type NotesOp = z.infer<typeof notesOpSchema>;
