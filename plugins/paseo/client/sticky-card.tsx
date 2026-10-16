import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";
import type { LastWord } from "../shared/last-word.ts";
import { PAPER, PaperCard } from "./paper-card.tsx";

export function StickyCard({ item, layout }: PluginTimelineItemProps<LastWord>) {
  const text = item.data.text.replace(/^\*You peel a sticky note off your forehead\.\*\n/, "");
  return (
    <PaperCard compact={layout.compact}>
      <Text selectable style={{ color: PAPER.ink, fontSize: 13, lineHeight: 19, flexShrink: 1 }}>{text}</Text>
    </PaperCard>
  );
}
