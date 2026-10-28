import type { ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { PaperPalette } from "./paper-palette.ts";

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

function Crease({ paper }: { paper: PaperPalette }) {
  return (
    <View style={{
      position: "absolute", top: 0, right: 0, width: 14, height: 14,
      backgroundColor: paper.crease, borderBottomLeftRadius: 3,
      borderLeftWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: paper.edge,
    }} />
  );
}

export function PaperCard({ paper, compact, crumpled = false, children }: {
  paper: PaperPalette;
  compact: boolean;
  crumpled?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={{
      paddingVertical: compact ? 8 : 9,
      paddingHorizontal: 12,
      gap: 6,
      minWidth: 0,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: paper.edge,
      backgroundColor: crumpled ? paper.crumpled : paper.background,
      position: "relative",
      overflow: "hidden",
    }}>
      <Crease paper={paper} />
      {children}
    </View>
  );
}
