import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { COLLAPSED_PREVIEW_MAX_CHARS, outputPreview, type NotesOp } from "../shared/notes-op.ts";
import { NoteInline, NoteMarkdown } from "./markdown.tsx";
import { MONO, PaperCard } from "./paper-card.tsx";
import { paperPalette, type PaperPalette } from "./paper-palette.ts";

const OP_LABEL: Record<NotesOp["op"], string> = { read: "read", write: "wrote", update: "edited" };
const OP_LABEL_RUNNING: Record<NotesOp["op"], string> = { read: "reading", write: "writing", update: "editing" };

/** First added line of an update diff, without its line-number prefix: the sentence the agent just wrote down. */
function addedLine(diff: string): string | undefined {
  return /^\+.*/m.exec(diff)?.[0].replace(/^\+(?:\s*\d+\s+\+|\s*\d+)?\s?/, "");
}

function DiffBody({ diff, paper }: { diff: string; paper: PaperPalette }) {
  const runs: { color: string; lines: string[] }[] = [];
  for (const line of diff.split("\n")) {
    const color = line.startsWith("+") ? paper.added : line.startsWith("-") ? paper.removed : paper.inkMuted;
    const last = runs[runs.length - 1];
    if (last?.color === color) last.lines.push(line);
    else runs.push({ color, lines: [line] });
  }
  return (
    <Text selectable style={{ fontSize: 12, lineHeight: 18, fontFamily: MONO }}>
      {runs.map((run, index) => <Text key={index} style={{ color: run.color }}>{index > 0 ? "\n" : ""}{run.lines.join("\n")}</Text>)}
    </Text>
  );
}

export function NotesOpCard({ item, layout, theme }: PluginTimelineItemProps<NotesOp>) {
  const [expanded, setExpanded] = useState(false);
  const paper = paperPalette(theme);
  const data = item.data;
  const title = data.status === "running" ? OP_LABEL_RUNNING[data.op] : OP_LABEL[data.op];
  const hasBody = Boolean(data.text || data.preview || data.diff);
  // Collapsed: one glance at what happened. Updates show the new sentence; writes the first of the content.
  const peek = expanded || data.crumpled ? undefined
    : data.diff !== undefined ? addedLine(data.diff)
    : data.preview;
  return (
    <PaperCard paper={paper} compact={layout.compact} crumpled={data.crumpled}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "收起" : "展开"} ${data.address}`}
        aria-expanded={expanded}
        onPress={hasBody ? () => setExpanded(value => !value) : undefined}
        disabled={!hasBody}
        style={({ pressed }) => ({ gap: 4, opacity: pressed && hasBody ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: paper.inkMuted, fontSize: 12 }}>
            {data.crumpled ? "crumpled" : title}{data.status === "running" ? " …" : ""}
          </Text>
          <Text numberOfLines={1} style={{ color: data.crumpled ? paper.inkMuted : paper.ink, fontSize: 12, flex: 1, textDecorationLine: data.crumpled ? "line-through" : "none" }}>
            {data.address}
          </Text>
          {hasBody && <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={16} color={paper.inkMuted} />}
        </View>
        {peek !== undefined && (
          <NoteInline
            text={`${data.diff !== undefined ? "+ " : ""}${outputPreview(peek, COLLAPSED_PREVIEW_MAX_CHARS).replace(/\s+/g, " ")}`}
            paper={paper}
            color={data.diff !== undefined ? paper.added : paper.ink}
            numberOfLines={2}
          />
        )}
        {data.error !== undefined && <Text selectable style={{ color: paper.removed, fontSize: 12, lineHeight: 18 }}>{data.error}</Text>}
      </Pressable>
      {expanded && hasBody && (
        <ScrollView style={{ maxHeight: layout.compact ? 280 : 400, marginTop: 2, borderTopWidth: 1, borderTopColor: paper.edge }} contentContainerStyle={{ gap: 5, paddingTop: 8 }} nestedScrollEnabled>
          {data.text !== undefined && <NoteMarkdown text={outputPreview(data.text)} paper={paper} />}
          {data.preview !== undefined && <NoteMarkdown text={outputPreview(data.preview)} paper={paper} />}
          {data.diff !== undefined && <DiffBody diff={outputPreview(data.diff)} paper={paper} />}
          {data.renamedFrom !== undefined && <Text style={{ color: paper.inkMuted, fontSize: 12 }}>renamed from {data.renamedFrom}</Text>}
        </ScrollView>
      )}
    </PaperCard>
  );
}
