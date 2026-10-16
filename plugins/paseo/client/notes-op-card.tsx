import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { NotesOp } from "../shared/notes-op.ts";
import { MONO, PAPER, PaperCard } from "./paper-card.tsx";

const OP_LABEL: Record<NotesOp["op"], string> = { read: "read", write: "wrote", update: "edited" };
const OP_LABEL_RUNNING: Record<NotesOp["op"], string> = { read: "reading", write: "writing", update: "editing" };

/** First added line of an update diff, without its line-number prefix: the sentence the agent just wrote down. */
function addedLine(diff: string): string | undefined {
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+")) continue;
    return line.replace(/^\+\s*\d+\s+\+\s?/, "");
  }
  return undefined;
}

function DiffBody({ diff }: { diff: string }) {
  return (
    <View style={{ gap: 2 }}>
      {diff.split("\n").map((line, index) => {
        const color = line.startsWith("+") ? PAPER.added
          : line.startsWith("-") ? PAPER.removed
          : PAPER.inkMuted;
        return <Text key={index} selectable style={{ color, fontSize: 12, fontFamily: MONO }}>{line}</Text>;
      })}
    </View>
  );
}

export function NotesOpCard({ item, layout }: PluginTimelineItemProps<NotesOp>) {
  const [expanded, setExpanded] = useState(false);
  const data = item.data;
  const title = data.status === "running" ? OP_LABEL_RUNNING[data.op] : OP_LABEL[data.op];
  const showEllipsis = data.truncated && data.diff === undefined;
  const hasBody = Boolean(data.text || data.preview || data.diff);
  // Collapsed: one glance at what happened. Updates show the new sentence; writes the first of the content.
  const peek = expanded || data.crumpled ? undefined
    : data.diff !== undefined ? addedLine(data.diff)
    : data.preview;
  return (
    <PaperCard compact={layout.compact} crumpled={data.crumpled}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "收起" : "展开"} ${data.address}`}
        aria-expanded={expanded}
        onPress={hasBody ? () => setExpanded(value => !value) : undefined}
        disabled={!hasBody}
        style={({ pressed }) => ({ gap: 4, opacity: pressed && hasBody ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text style={{ color: PAPER.inkMuted, fontSize: 11.5 }}>
            {data.crumpled ? "crumpled" : title}{data.status === "running" ? " …" : ""}
          </Text>
          <Text style={{ color: data.crumpled ? PAPER.inkMuted : PAPER.ink, fontSize: 13, flexShrink: 1, textDecorationLine: data.crumpled ? "line-through" : "none" }}>
            {data.address}
          </Text>
          <View style={{ flex: 1 }} />
          {hasBody && <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={16} color={PAPER.inkMuted} />}
        </View>
        {peek !== undefined && (
          <Text numberOfLines={2} style={{ color: data.diff !== undefined ? PAPER.added : PAPER.ink, fontSize: 13, lineHeight: 19 }}>
            {data.diff !== undefined ? "+ " : ""}{peek}
          </Text>
        )}
        {data.error !== undefined && <Text selectable style={{ color: PAPER.removed, fontSize: 13, lineHeight: 19 }}>{data.error}</Text>}
      </Pressable>
      {expanded && hasBody && (
        <ScrollView style={{ maxHeight: layout.compact ? 280 : 400 }} contentContainerStyle={{ gap: 5 }} nestedScrollEnabled>
          {data.text !== undefined && <Text selectable style={{ color: PAPER.ink, fontSize: 13, lineHeight: 19 }}>{data.text}{showEllipsis && " …"}</Text>}
          {data.preview !== undefined && <Text selectable style={{ color: PAPER.inkMuted, fontSize: 13, lineHeight: 19 }}>{data.preview}{showEllipsis && " …"}</Text>}
          {data.diff !== undefined && <DiffBody diff={data.diff} />}
          {data.renamedFrom !== undefined && <Text style={{ color: PAPER.inkMuted, fontSize: 11 }}>renamed from {data.renamedFrom}</Text>}
          {data.truncated && <Text style={{ color: PAPER.inkMuted, fontSize: 11 }}>shortened for display</Text>}
        </ScrollView>
      )}
    </PaperCard>
  );
}
