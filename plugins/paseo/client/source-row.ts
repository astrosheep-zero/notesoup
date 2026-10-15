import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CARD_KIND, LAST_WORD_TYPE } from "../shared/last-word.ts";

type Transformer = Extract<Parameters<PluginClientContext["addTimelineTransformer"]>[0], { query: { itemType: "tool_call" } }>;
type Source = Parameters<Transformer["transform"]>[0];

export const sourceRowTransformer = {
  id: "last-word-source",
  query: { itemType: "tool_call" },
  transform: ({ item }: Pick<Source, "item">) => {
    if (item.type !== "tool_call" || item.metadata?.customType !== LAST_WORD_TYPE || item.detail?.type !== "plain_text" || typeof item.detail.text !== "string") return undefined;
    return { items: [{ type: "plugin" as const, kind: CARD_KIND, version: 1, data: { text: item.detail.text } }] };
  },
} satisfies Transformer;
