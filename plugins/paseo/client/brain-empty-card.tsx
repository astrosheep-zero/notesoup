import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { BrainEmpty } from "../shared/brain-empty.ts";
import { PAPER } from "./paper-card.tsx";

function label(data: BrainEmpty): string {
  if (data.status === "running") return "EMPTYING BRAIN …";
  if (data.error !== undefined) return "BRAIN REFUSED TO EMPTY";
  if (data.outcome === "rollover_already_pending") return "BRAIN ALREADY BEING EMPTIED";
  return "✂ BRAIN EMPTIED";
}

export function BrainEmptyDivider({ item }: PluginTimelineItemProps<BrainEmpty>) {
  const data = item.data;
  const refused = data.error !== undefined || data.status === "failed";
  const color = refused ? PAPER.removed : PAPER.inkMuted;
  const line = { flex: 1, height: 1, backgroundColor: color, opacity: 0.6 };
  return (
    <View style={{ paddingVertical: 6, gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={line} />
        <Text style={{ color, fontSize: 11, letterSpacing: 1 }}>{label(data)}</Text>
        <View style={line} />
      </View>
      {data.error !== undefined && (
        <Text selectable style={{ color: PAPER.removed, fontSize: 12, textAlign: "center" }}>{data.error}</Text>
      )}
    </View>
  );
}
