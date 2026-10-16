import { z } from "zod";

export const NOTES_OP_KIND = "notes-op";
export const NOTES_OP_TOOLS = ["notes_read", "notes_write", "notes_update"] as const;
export type NotesOpTool = (typeof NOTES_OP_TOOLS)[number];

/** Card data stays small: the plugin timeline refuses payloads over 64 KB. */
export const READ_TEXT_MAX_CHARS = 4000;
export const DIFF_MAX_CHARS = 8000;
export const PREVIEW_MAX_CHARS = 4000;

export const notesOpSchema = z.object({
  op: z.enum(["read", "write", "update"]),
  address: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  error: z.string().optional(),
  // read
  text: z.string().optional(),
  totalChars: z.number().optional(),
  // write
  outcome: z.string().optional(),
  preview: z.string().optional(),
  // update
  changeKind: z.string().optional(),
  diff: z.string().optional(),
  renamedFrom: z.string().optional(),
  crumpled: z.boolean().optional(),
  truncated: z.boolean().optional(),
});
export type NotesOp = z.infer<typeof notesOpSchema>;
