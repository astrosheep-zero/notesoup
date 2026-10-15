import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { NotesOp } from "../shared/notes-op.ts";

const OP_LABEL: Record<NotesOp["op"], string> = { read: "READ NOTE", write: "WROTE NOTE", update: "UPDATED NOTE" };
const OP_LABEL_RUNNING: Record<NotesOp["op"], string> = { read: "READING NOTE", write: "WRITING NOTE", update: "UPDATING NOTE" };
const CHANGE_LABEL: Record<string, string> = { body: "edited", metadata: "metadata", moved: "renamed", none: "unchanged" };

/** Paper palette: pale note paper, readable regardless of the host theme. */
const PAPER = {
  background: "#f7f2df",
  border: "#d9cdaa",
  tape: "#d8c98f",
  ink: "#33301f",
  inkMuted: "#867c63",
  added: "#357a44",
  removed: "#b0493e",
};

function DiffBody({ diff }: { diff: string }) {
  return (
    <View style={{ gap: 2 }}>
      {diff.split("\n").map((line, index) => {
        const color = line.startsWith("+") ? PAPER.added
          : line.startsWith("-") ? PAPER.removed
          : PAPER.inkMuted;
        return <Text key={index} selectable style={{ color, fontSize: 12, fontFamily: "Menlo" }}>{line}</Text>;
      })}
    </View>
  );
}

export function NotesOpCard({ item, layout }: PluginTimelineItemProps<NotesOp>) {
  const [expanded, setExpanded] = useState(false);
  const data = item.data;
  const title = data.status === "running" ? OP_LABEL_RUNNING[data.op] : OP_LABEL[data.op];
  const state = data.error !== undefined ? "failed"
    : data.op === "write" ? data.outcome
    : data.op === "update" ? CHANGE_LABEL[data.changeKind ?? ""] ?? data.changeKind
    : undefined;
  const footnotes: string[] = [];
  if (data.renamedFrom !== undefined) footnotes.push(`renamed from ${data.renamedFrom}`);
  if (data.diff !== undefined && data.truncated) footnotes.push("diff shortened for display");
  const showEllipsis = data.truncated && data.diff === undefined;
  const hasBody = Boolean(data.text || data.preview || data.diff || footnotes.length);
  return (
    <View style={{ paddingTop: 6 }}>
      <View style={{
        alignSelf: "flex-start", width: 84, height: 14, marginLeft: 28, marginBottom: -9, zIndex: 1,
        backgroundColor: PAPER.tape, opacity: 0.9, borderRadius: 2,
        transform: [{ rotate: "-2deg" }],
      }} />
      <View style={{
        padding: layout.compact ? 10 : 12,
        gap: 5,
        minWidth: 0,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: PAPER.border,
        backgroundColor: PAPER.background,
      }}>
        <View style={{ gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: PAPER.inkMuted, fontSize: 11, letterSpacing: 0.5 }}>
              {title}{data.status === "running" ? " …" : ""}
            </Text>
            {hasBody && !expanded && <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${expanded ? "收起" : "展开"} ${data.address}`}
              aria-expanded={expanded}
              onPress={() => setExpanded(value => !value)}
              hitSlop={6}
              style={({ pressed }) => ({ padding: 5, opacity: pressed ? 0.6 : 1 })}
            >
              <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={18} color={PAPER.inkMuted} />
            </Pressable>}
          </View>
          <Text style={{ color: PAPER.ink, fontSize: 13, flexShrink: 1 }}>
            {data.address}
            {state !== undefined && <Text style={{ color: PAPER.inkMuted, fontSize: 12, fontWeight: "400" }}>{"  "}{state}</Text>}
          </Text>
        </View>
        {data.error !== undefined && <Text selectable style={{ color: PAPER.removed, fontSize: 13, lineHeight: 19 }}>{data.error}</Text>}
        {expanded && hasBody && <ScrollView
          style={{ maxHeight: layout.compact ? 280 : 400 }}
          contentContainerStyle={{ gap: 5 }}
          nestedScrollEnabled
        >
          {data.text !== undefined && <Text selectable style={{ color: PAPER.ink, fontSize: 13, lineHeight: 19 }}>{data.text}{showEllipsis && " …"}</Text>}
          {data.preview !== undefined && <Text selectable style={{ color: PAPER.inkMuted, fontSize: 13, lineHeight: 19 }}>{data.preview}{showEllipsis && " …"}</Text>}
          {data.diff !== undefined && <DiffBody diff={data.diff} />}
          {footnotes.length > 0 && <Text style={{ color: PAPER.inkMuted, fontSize: 11 }}>{footnotes.join(" · ")}</Text>}
        </ScrollView>}
        {hasBody && expanded && <Pressable
          accessibilityRole="button"
          accessibilityLabel={`收起 ${data.address}`}
          aria-expanded={true}
          onPress={() => setExpanded(false)}
          hitSlop={6}
          style={({ pressed }) => ({ alignSelf: "flex-end", paddingHorizontal: 5, paddingVertical: 1, opacity: pressed ? 0.6 : 1 })}
        >
          <Icon name="ChevronUp" size={18} color={PAPER.inkMuted} />
        </Pressable>}
      </View>
    </View>
  );
}
