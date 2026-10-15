import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { LastWord } from "../shared/last-word.ts";

export function StickyCard({ item, theme, layout }: PluginTimelineItemProps<LastWord>) {
  const text = item.data.text.replace(/^\*You peel a sticky note off your forehead\.\*\n/, "");
  return (
    <View style={{
      padding: layout.compact ? 12 : 16,
      gap: 8,
      minWidth: 0,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontWeight: "600" }}>Last word</Text>
      <Text selectable style={{ color: theme.colors.foreground, flexShrink: 1 }}>{text}</Text>
    </View>
  );
}
