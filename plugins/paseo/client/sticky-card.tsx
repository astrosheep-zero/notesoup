import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { LastWord } from "../shared/last-word.ts";

export function StickyCard({ item, layout }: PluginTimelineItemProps<LastWord>) {
  const text = item.data.text.replace(/^\*You peel a sticky note off your forehead\.\*\n/, "");
  return (
    <View style={{ paddingTop: 6 }}>
      <View style={{
        alignSelf: "flex-start", width: 84, height: 14, marginLeft: 28, marginBottom: -9, zIndex: 1,
        backgroundColor: "#d8c98f", opacity: 0.9, borderRadius: 2,
        transform: [{ rotate: "-2deg" }],
      }} />
      <View style={{
        padding: layout.compact ? 10 : 12,
        gap: 5,
        minWidth: 0,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: "#d9cdaa",
        backgroundColor: "#f7f2df",
      }}>
        <Text style={{ color: "#867c63", fontSize: 11, letterSpacing: 0.5 }}>LAST WORD</Text>
        <Text selectable style={{ color: "#33301f", fontSize: 13, lineHeight: 19, flexShrink: 1 }}>{text}</Text>
      </View>
    </View>
  );
}
