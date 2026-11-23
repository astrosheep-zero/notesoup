import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";
import type { LastWord } from "../shared/last-word.ts";
import { PaperCard } from "./paper-card.tsx";
import { paperPalette } from "./paper-palette.ts";
import { typography } from "./typography.ts";

export function StickyCard({ item, layout, theme }: PluginTimelineItemProps<LastWord>) {
  const paper = paperPalette(theme);
  const text = item.data.text.replace(/^\*You peel a sticky note off your forehead\.\*\n/, "");
  return (
    <PaperCard paper={paper} compact={layout.compact}>
      <Text selectable style={{ ...typography(theme).body, color: paper.ink, flexShrink: 1 }}>{text}</Text>
    </PaperCard>
  );
}
