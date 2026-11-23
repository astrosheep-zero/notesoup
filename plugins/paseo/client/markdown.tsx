import { useMemo } from "react";
import { Lexer, lexer } from "marked";
import { renderBlocks, renderInlines, type MarkdownStyles } from "./markdown-core.tsx";
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import type { PaperPalette } from "./paper-palette.ts";
import type { Typography } from "./typography.ts";

type Styles = MarkdownStyles & { block: ViewStyle; muted: TextStyle };

function markdownStyles(paper: PaperPalette, type: Typography): Styles {
  const hairline = { borderWidth: StyleSheet.hairlineWidth, borderColor: paper.edge };
  return {
    block: { gap: 8 },
    text: { ...type.body, color: paper.ink },
    muted: { ...type.body, color: paper.inkMuted },
    strong: { fontWeight: "600" },
    em: { fontStyle: "italic" },
    del: { color: paper.inkMuted, textDecorationLine: "line-through" },
    // No borderRadius here: nested rounded Text backgrounds paint a wrapped slab on iOS Fabric.
    // A faint ink wash keeps flush glyph edges gentle and stays visible on crumpled paper too.
    inlineCode: { ...type.inlineCode, backgroundColor: `${paper.ink}10` },
    link: { color: paper.added, textDecorationLine: "underline" },
    heading: { ...type.base, fontWeight: "600", color: paper.ink, letterSpacing: -0.1 },
    quote: { borderLeftWidth: 2, borderLeftColor: paper.edge, paddingLeft: 10, gap: 4 },
    quoteText: { color: paper.inkMuted },
    codeBlock: { ...hairline, backgroundColor: paper.crumpled, borderRadius: 4 },
    codeContent: { paddingVertical: 6, paddingHorizontal: 8 },
    codeText: { ...type.code, color: paper.ink },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: paper.edge, marginVertical: 2 },
    list: { gap: 4 },
    listRow: { flexDirection: "row" },
    listItem: { flex: 1, gap: 4 },
    bullet: { ...type.body, color: paper.inkMuted, minWidth: 18, paddingRight: 6,
      textAlign: "right", fontVariant: ["tabular-nums"] },
    table: { ...hairline, borderRadius: 4, overflow: "hidden" },
    tableHead: { backgroundColor: paper.crumpled },
    tableRow: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: paper.edge },
    tableCell: { paddingVertical: 4, paddingHorizontal: 8 },
  };
}

export function NoteInline({ text, paper, type, color, numberOfLines }: {
  text: string;
  paper: PaperPalette;
  type: Typography;
  color?: string;
  numberOfLines?: number;
}) {
  const styles = useMemo(() => markdownStyles(paper, type), [paper, type]);
  const tokens = useMemo(() => Lexer.lexInline(text), [text]);
  return (
    <Text numberOfLines={numberOfLines} style={{ ...styles.text, color: color ?? paper.ink }}>
      {renderInlines(tokens, styles, "inline")}
    </Text>
  );
}

export function NoteMarkdown({ text, paper, type, muted = false }: { text: string; paper: PaperPalette; type: Typography; muted?: boolean }) {
  const styles = useMemo(() => markdownStyles(paper, type), [paper, type]);
  const tokens = useMemo(() => lexer(text), [text]);
  const textStyle = muted ? styles.muted : styles.text;
  return <View style={styles.block}>{renderBlocks(tokens, styles, "block", textStyle)}</View>;
}
