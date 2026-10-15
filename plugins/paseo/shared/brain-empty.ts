import { z } from "zod";

export const BRAIN_EMPTY_KIND = "brain-empty";
export const BRAIN_EMPTY_TOOL = "empty_brain";

export const brainEmptySchema = z.object({
  status: z.enum(["running", "completed", "failed"]),
  // completed: rollover_requested | rollover_already_pending
  outcome: z.string().optional(),
  error: z.string().optional(),
});
export type BrainEmpty = z.infer<typeof brainEmptySchema>;
