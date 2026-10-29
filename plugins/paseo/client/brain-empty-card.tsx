import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
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
  const [lastWordOpen, setLastWordOpen] = useState(false);
  const data = item.data;
  const refused = data.error !== undefined || data.status === "failed";
  const color = refused ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  const hasLastWord = data.outcome === "rollover_requested" && data.lastWord !== undefined;
  return (
    <View style={{ paddingVertical: 6 }}>
      <Pressable
        accessibilityRole={hasLastWord ? "button" : undefined}
        accessibilityLabel={hasLastWord ? "Show last word" : undefined}
        disabled={!hasLastWord}
        onPress={hasLastWord ? () => setLastWordOpen(true) : undefined}
        style={({ pressed }) => ({ gap: 3, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <CutLine color={color} />
          <Text style={{ color, fontSize: 11.5, letterSpacing: 0.3 }}>{label(data)}</Text>
          <CutLine color={color} />
        </View>
        {data.error !== undefined && (
          <Text selectable style={{ color: theme.colors.statusDanger, fontSize: 12, textAlign: "center" }}>{data.error}</Text>
        )}
      </Pressable>
      {hasLastWord && (
        <Modal title="Last word" open={lastWordOpen} onOpenChange={setLastWordOpen}>
          <Modal.Content style={{ backgroundColor: theme.colors.surface2 }}>
            <Text selectable style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 21 }}>{data.lastWord}</Text>
          </Modal.Content>
        </Modal>
      )}
    </View>
  );
}
