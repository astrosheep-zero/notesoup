import type { PluginClientContext } from "@getpaseo/plugin/client";
import { sourceRowTransformer } from "./client/source-row.ts";
import { StickyCard } from "./client/sticky-card.tsx";
import { CARD_KIND, lastWordSchema } from "./shared/last-word.ts";

export default function contribute(client: PluginClientContext) {
  const removeRenderer = client.addTimelineRenderer({ kind: CARD_KIND, version: 1, schema: lastWordSchema, Component: StickyCard });
  const removeTransformer = client.addTimelineTransformer(sourceRowTransformer);
  return () => { removeTransformer(); removeRenderer(); };
}
