import type { PluginClientContext } from "@getpaseo/plugin/client";
import { sourceRowTransformer } from "./client/source-row.ts";
import { notesOpTransformer } from "./client/notes-op-transformer.ts";
import { StickyCard } from "./client/sticky-card.tsx";
import { NotesOpCard } from "./client/notes-op-card.tsx";
import { CARD_KIND, lastWordSchema } from "./shared/last-word.ts";
import { NOTES_OP_KIND, notesOpSchema } from "./shared/notes-op.ts";

export default function contribute(client: PluginClientContext) {
  const removals = [
    client.addTimelineRenderer({ kind: CARD_KIND, version: 1, schema: lastWordSchema, Component: StickyCard }),
    client.addTimelineRenderer({ kind: NOTES_OP_KIND, version: 1, schema: notesOpSchema, Component: NotesOpCard }),
    client.addTimelineTransformer(sourceRowTransformer),
    client.addTimelineTransformer(notesOpTransformer),
  ];
  return () => { for (const remove of removals) remove(); };
}
