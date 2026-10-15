import { z } from "zod";

export const LAST_WORD_TYPE = "notesoup/reset-last-word";
export const CARD_KIND = "last-word";
export const lastWordSchema = z.object({ text: z.string() });
export type LastWord = z.infer<typeof lastWordSchema>;
