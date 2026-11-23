// Manually mirrored between square and pi-context (notesoup):
// plugins/paseo/client/markdown-core.tsx. Keep both copies byte-identical.
// Mechanics only: palettes, attribution and preview controls belong to the adapters.
import type { ReactNode } from "react";
import { Linking, ScrollView, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { Lexer, type Token, type Tokens } from "marked";

export interface MarkdownStyles {
  text: TextStyle;
  strong: TextStyle;
  em: TextStyle;
  del: TextStyle;
  link: TextStyle;
  // Keep nested Text backgrounds square; rounded inline backgrounds are unreliable on iOS.
  inlineCode: TextStyle;
  heading: TextStyle;
  quoteText: TextStyle;
  codeText: TextStyle;
  bullet: TextStyle;
  tableCell: TextStyle;
  codeBlock: ViewStyle;
  codeContent: ViewStyle;
  quote: ViewStyle;
  separator: ViewStyle;
  list: ViewStyle;
  listRow: ViewStyle;
  listItem: ViewStyle;
  table: ViewStyle;
  tableHead: ViewStyle;
  tableRow: ViewStyle;
}

/** Children of a token, if it has any: `Token` is a union, so the optional field needs one cast. */
const children = (node: Token | { tokens?: Token[] }): Token[] => (node as { tokens?: Token[] }).tokens ?? [];

const ENTITIES: Record<string, string> = {
  lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", nbsp: "\u00a0", mdash: "—", ndash: "–",
};
const HTML_BR = /^<br\s*\/?>$/i;
const SAFE_LINK = /^(?:https?:|mailto:)/i;

function unescape(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z0-9]+));/g, (raw, dec?: string, hex?: string, named?: string) => {
    if (dec !== undefined || hex !== undefined) {
      const code = Number.parseInt((dec ?? hex)!, dec !== undefined ? 10 : 16);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : raw;
    }
    return ENTITIES[named!] ?? raw;
  });
}

function linkPress(href: string, openLinks: boolean): (() => void) | undefined {
  const url = unescape(href);
  return openLinks && SAFE_LINK.test(url) ? () => { void Promise.resolve(Linking.openURL(url)).catch(() => {}); } : undefined;
}

function inlinePlain(tokens: Token[]): string {
  return tokens.map(token => {
    switch (token.type) {
      case "checkbox": return "";
      case "br": return "\n";
      case "html": return HTML_BR.test(token.raw.trim()) ? "\n" : token.raw;
      case "codespan": return token.text;
      case "image": return inlinePlain(children(token)) || token.text || "[image]";
      default: {
        const inline = token as Tokens.Generic;
        return inline.tokens !== undefined ? inlinePlain(inline.tokens) : unescape(inline.text ?? inline.raw);
      }
    }
  }).join("");
}

function cellWidth(cell: Tokens.TableCell | undefined): number {
  if (!cell) return 56;
  const widest = Math.max(...inlinePlain(children(cell)).split("\n").map(line =>
    [...line].reduce((sum, ch) => sum + (ch.codePointAt(0)! > 0x2e7f ? 14 : 7.5), 16)));
  return Math.min(240, Math.max(56, widest));
}

/** Inline runs nest inside their block's Text, so they carry only what differs from it. */
export function renderInlines(tokens: Token[], styles: MarkdownStyles, prefix: string, openLinks = false): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${prefix}-${index}`;
    const nested = (style?: TextStyle, onPress?: () => void): ReactNode => (
      <Text key={key} style={style} onPress={onPress}>{renderInlines(children(token), styles, key, openLinks)}</Text>
    );
    switch (token.type) {
      case "checkbox": return null;
      case "strong": return nested(styles.strong);
      case "em": return nested(styles.em);
      case "del": return nested(styles.del);
      case "link": return nested(styles.link, linkPress((token as Tokens.Link).href, openLinks));
      case "codespan": return <Text key={key} style={styles.inlineCode}>{token.text}</Text>;
      case "br": return "\n";
      case "html": return HTML_BR.test(token.raw.trim()) ? "\n" : token.raw;
      case "image": {
        const image = token as Tokens.Image;
        const label = inlinePlain(children(image)) || image.text || "[image]";
        return <Text key={key} style={styles.link} onPress={linkPress(image.href, openLinks)}>{label}</Text>;
      }
      default: {
        const inline = token as Tokens.Generic;
        if (inline.tokens !== undefined) return nested();
        return unescape(inline.text ?? inline.raw);
      }
    }
  });
}

export function renderBlocks(tokens: Token[], styles: MarkdownStyles, prefix: string, textStyle?: TextStyle, openLinks = true): ReactNode[] {
  const visible = tokens.filter(token =>
    token.type !== "space" && token.type !== "checkbox" && token.type !== "def"
    && !(token.type === "html" && HTML_BR.test(token.raw.trim())));
  return visible.map((token, index) => {
    const key = `${prefix}-${index}`;
    switch (token.type) {
      case "html":
        return <Text key={key} selectable style={[styles.text, textStyle]}>{token.raw}</Text>;
      case "hr":
        return <View key={key} style={styles.separator} />;
      case "code":
        return (
          <ScrollView key={key} horizontal style={styles.codeBlock} contentContainerStyle={styles.codeContent}>
            <Text selectable style={styles.codeText}>{token.text}</Text>
          </ScrollView>
        );
      case "heading": {
        // Headings sit closer to the section they introduce than to whatever preceded them.
        const rhythm = { marginTop: index > 0 ? 4 : 0, marginBottom: index < visible.length - 1 ? -2 : 0 };
        return (
          <Text key={key} selectable style={[styles.text, textStyle, styles.heading, rhythm]}>
            {renderInlines(children(token), styles, key, openLinks)}
          </Text>
        );
      }
      case "blockquote":
        return <View key={key} style={styles.quote}>{renderBlocks(children(token), styles, key, styles.quoteText, openLinks)}</View>;
      case "list": {
        const list = token as Tokens.List;
        const start = typeof list.start === "number" ? list.start : 1;
        return (
          <View key={key} style={styles.list}>
            {list.items.map((item, itemIndex) => (
              <View key={`${key}-${itemIndex}`} style={styles.listRow}>
                <Text style={styles.bullet}>
                  {item.task ? (item.checked === true ? "☑" : "☐") : list.ordered ? `${start + itemIndex}.` : "•"}
                </Text>
                <View style={styles.listItem}>{renderBlocks(children(item), styles, `${key}-${itemIndex}`, textStyle, openLinks)}</View>
              </View>
            ))}
          </View>
        );
      }
      case "table": {
        const table = token as Tokens.Table;
        const rows = [table.header, ...table.rows];
        // Columns size to their widest cell (within reason) and the table scrolls sideways
        // on narrow screens instead of crushing every cell to a sliver.
        const widths = table.header.map((_, column) => Math.max(...rows.map(cells => cellWidth(cells[column]))));
        return (
          <ScrollView key={key} horizontal>
            <View style={styles.table}>
              {rows.map((cells, rowIndex) => (
                <View key={`${key}-${rowIndex}`} style={rowIndex === 0 ? [styles.tableRow, styles.tableHead, { borderTopWidth: 0 }] : styles.tableRow}>
                  {cells.map((cell, cellIndex) => (
                    <Text
                      key={`${key}-${rowIndex}-${cellIndex}`}
                      selectable
                      style={[styles.text, textStyle, styles.tableCell, { width: widths[cellIndex], textAlign: table.align[cellIndex] ?? "left" },
                        rowIndex === 0 ? styles.strong : undefined]}
                    >{renderInlines(children(cell), styles, `${key}-${rowIndex}-${cellIndex}`, openLinks)}</Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        );
      }
      default: {
        const block = token as Tokens.Generic;
        return (
          <Text key={key} selectable style={[styles.text, textStyle]}>
            {renderInlines(block.tokens ?? Lexer.lexInline(block.text ?? block.raw), styles, key, openLinks)}
          </Text>
        );
      }
    }
  });
}
