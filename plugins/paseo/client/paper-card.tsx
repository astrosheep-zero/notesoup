import type { ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { PaperPalette } from "./paper-palette.ts";

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

function Tape({ paper }: { paper: PaperPalette }) {
  return (
    <View style={{
      alignSelf: "flex-start", width: 76, height: 15, marginLeft: 28, marginBottom: -9, zIndex: 1,
      backgroundColor: paper.tape, borderLeftWidth: 1, borderRightWidth: 1, borderColor: paper.tapeEdge,
      transform: [{ rotate: "-2deg" }],
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
    <View style={{ paddingTop: 7 }}>
      <Tape paper={paper} />
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
        {children}
      </View>
    </View>
  );
}
