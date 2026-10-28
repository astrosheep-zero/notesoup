import { Lexer, lexer, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { MONO } from "./paper-card.tsx";
import type { PaperPalette } from "./paper-palette.ts";

type Styles = {
  block: ViewStyle;
  text: TextStyle; muted: TextStyle; strong: TextStyle; em: TextStyle; del: TextStyle;
  codespan: TextStyle; link: TextStyle; heading: TextStyle; quoteText: TextStyle;
  code: TextStyle; marker: TextStyle; tableCell: TextStyle;
  quote: ViewStyle; hr: ViewStyle; list: ViewStyle; listItem: ViewStyle;
  table: ViewStyle; tableRow: ViewStyle;
};

function markdownStyles(paper: PaperPalette): Styles {
  return {
    block: { gap: 6 },
    text: { color: paper.ink, fontSize: 13, lineHeight: 19 },
    muted: { color: paper.inkMuted, fontSize: 13, lineHeight: 19 },
    strong: { fontWeight: "500", color: paper.ink },
    em: { color: paper.inkMuted, fontStyle: "italic" },
    del: { color: paper.inkMuted, textDecorationLine: "line-through" },
    codespan: { fontFamily: MONO },
    link: { color: paper.added, textDecorationLine: "underline" },
    heading: { fontWeight: "500", color: paper.ink },
    quote: { borderLeftWidth: 2, borderLeftColor: paper.edge, paddingLeft: 8, gap: 4 },
    quoteText: { color: paper.inkMuted, fontSize: 13, lineHeight: 19 },
    code: {
      fontFamily: MONO, fontSize: 13, lineHeight: 19, color: paper.ink,
      backgroundColor: paper.crumpled, borderRadius: 3, paddingVertical: 6, paddingHorizontal: 8,
    },
    hr: { height: StyleSheet.hairlineWidth, backgroundColor: paper.edge },
    list: { gap: 3 },
    listItem: { flexDirection: "row", gap: 6 },
    marker: { color: paper.inkMuted, minWidth: 14 },
    table: { gap: 2 },
    tableRow: { flexDirection: "row", gap: 8 },
    tableCell: { flex: 1 },
  };
}

/** Inline tokens keep their nesting: strong/em/del/link hold the tokens they wrap. */
function renderInlines(tokens: Token[] | undefined, styles: Styles, keyPrefix: string): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((token, index) => {
    const key = `${keyPrefix}.${index}`;
    switch (token.type) {
      case "strong":
        return <Text key={key} style={styles.strong}>{renderInlines(token.tokens, styles, key)}</Text>;
      case "em":
        return <Text key={key} style={styles.em}>{renderInlines(token.tokens, styles, key)}</Text>;
      case "del":
        return <Text key={key} style={styles.del}>{renderInlines(token.tokens, styles, key)}</Text>;
      case "codespan":
        return <Text key={key} style={styles.codespan}>{token.text}</Text>;
      case "link":
        return <Text key={key} style={styles.link}>{renderInlines(token.tokens, styles, key)}</Text>;
      case "br":
        return "\n";
      case "image":
        return <Text key={key} style={styles.link}>{token.text}</Text>;
      default: {
        const nested = (token as Tokens.Generic).tokens;
        if (nested?.length) return <Text key={key}>{renderInlines(nested, styles, key)}</Text>;
        const { text } = token as Tokens.Text;
        return text ?? token.raw;
      }
    }
  });
}

function renderListItem(item: Tokens.ListItem, marker: string, key: string, styles: Styles, textStyle: TextStyle): ReactNode {
  return (
    <View key={key} style={styles.listItem}>
      <Text style={[styles.marker, textStyle]}>{item.task ? (item.checked ? "☑" : "☐") : marker}</Text>
      <View style={{ flex: 1, gap: 4 }}>{renderBlocks(item.tokens, styles, key, textStyle)}</View>
    </View>
  );
}

function renderBlocks(tokens: Token[] | undefined, styles: Styles, keyPrefix: string, textStyle: TextStyle): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((token, index) => {
    const key = `${keyPrefix}.${index}`;
    switch (token.type) {
      case "space":
      case "checkbox":
      case "def":
        return null;
      case "hr":
        return <View key={key} style={styles.hr} />;
      case "code":
        return <Text key={key} selectable style={styles.code}>{token.text}</Text>;
      case "heading":
        return <Text key={key} selectable style={[textStyle, styles.heading]}>{renderInlines(token.tokens, styles, key)}</Text>;
      case "blockquote":
        return <View key={key} style={styles.quote}>{renderBlocks(token.tokens, styles, key, styles.quoteText)}</View>;
      case "list": {
        const list = token as Tokens.List;
        const start = typeof list.start === "number" ? list.start : 1;
        return (
          <View key={key} style={styles.list}>
            {list.items.map((item, itemIndex) =>
              renderListItem(item, list.ordered ? `${start + itemIndex}.` : "•", `${key}.${itemIndex}`, styles, textStyle))}
          </View>
        );
      }
      case "table": {
        const table = token as Tokens.Table;
        return (
          <View key={key} style={styles.table}>
            {[table.header, ...table.rows].map((row, rowIndex) => (
              <View key={`${key}.${rowIndex}`} style={styles.tableRow}>
                {row.map((cell, cellIndex) => (
                  <Text
                    key={`${key}.${rowIndex}.${cellIndex}`}
                    selectable
                    style={[textStyle, styles.tableCell, { textAlign: cell.align ?? "left" }, cell.header && styles.strong]}
                  >
                    {renderInlines(cell.tokens, styles, `${key}.${rowIndex}.${cellIndex}`)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        );
      }
      default: {
        const generic = token as Tokens.Generic;
        return (
          <Text key={key} selectable style={textStyle}>
            {generic.tokens?.length ? renderInlines(generic.tokens, styles, key) : generic.text ?? generic.raw}
          </Text>
        );
      }
    }
  });
}

export function NoteInline({ text, paper, color, numberOfLines }: {
  text: string;
  paper: PaperPalette;
  color?: string;
  numberOfLines?: number;
}) {
  const styles = markdownStyles(paper);
  return (
    <Text numberOfLines={numberOfLines} style={{ ...styles.text, color: color ?? paper.ink }}>
      {renderInlines(Lexer.lexInline(text), styles, "inline")}
    </Text>
  );
}

export function NoteMarkdown({ text, paper, muted = false }: { text: string; paper: PaperPalette; muted?: boolean }) {
  const styles = markdownStyles(paper);
  const textStyle = muted ? styles.muted : styles.text;
  return <View style={styles.block}>{renderBlocks(lexer(text), styles, "block", textStyle)}</View>;
}
