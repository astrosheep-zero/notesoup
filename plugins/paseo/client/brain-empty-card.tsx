import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { BrainEmpty } from "../shared/brain-empty.ts";

function label(data: BrainEmpty): string {
  if (data.status === "running") return "✂ emptying brain …";
  if (data.error !== undefined) return "✂ brain refused to empty";
  if (data.outcome === "rollover_already_pending") return "✂ already emptying";
  if (data.outcome === "rollover_requested") return "✂ brain emptied";
  // A completed tool call (including Claude's acknowledgement) does not prove a reset committed.
  return "✂ empty_brain completed";
}

/** Single-side dashed borders are unreliable on iOS, so the cut line is a row of dash segments. */
function CutLine({ color }: { color: string }) {
  return (
    <View style={{ flex: 1, height: 1.5, overflow: "hidden", opacity: 0.55, flexDirection: "row", gap: 5 }}>
      {Array.from({ length: 60 }, (_, index) => (
        <View key={index} style={{ width: 6, height: 1.5, borderRadius: 0.75, backgroundColor: color }} />
      ))}
    </View>
  );
}

export function BrainEmptyDivider({ item, theme }: PluginTimelineItemProps<BrainEmpty>) {
  const data = item.data;
  const refused = data.error !== undefined || data.status === "failed";
  const color = refused ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  return (
    <View style={{ paddingVertical: 6, gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <CutLine color={color} />
        <Text style={{ color, fontSize: 11.5, letterSpacing: 0.3 }}>{label(data)}</Text>
        <CutLine color={color} />
      </View>
      {data.error !== undefined && (
        <Text selectable style={{ color: theme.colors.statusDanger, fontSize: 12, textAlign: "center" }}>{data.error}</Text>
      )}
    </View>
  );
}
