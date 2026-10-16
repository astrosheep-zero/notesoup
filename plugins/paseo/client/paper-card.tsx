import type { ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";

/** Shared paper palette, independent of the host theme. */
export const PAPER = {
  background: "#f8f3e1",
  edge: "#cbbd94",
  tape: "rgba(222, 205, 140, 0.72)",
  tapeEdge: "rgba(160, 140, 80, 0.18)",
  ink: "#33301f",
  inkMuted: "#867c63",
  added: "#357a44",
  removed: "#b0493e",
  crumpled: "#ece6d1",
};

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

export function Tape() {
  return (
    <View style={{
      alignSelf: "flex-start", width: 76, height: 15, marginLeft: 28, marginBottom: -9, zIndex: 1,
      backgroundColor: PAPER.tape, borderLeftWidth: 1, borderRightWidth: 1, borderColor: PAPER.tapeEdge,
      transform: [{ rotate: "-2deg" }],
    }} />
  );
}

export function PaperCard({ compact, crumpled = false, children }: {
  compact: boolean;
  crumpled?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={{ paddingTop: 7 }}>
      <Tape />
      <View style={{
        paddingVertical: compact ? 8 : 9,
        paddingHorizontal: 10,
        gap: 4,
        minWidth: 0,
        borderRadius: 3,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: PAPER.edge,
        backgroundColor: crumpled ? PAPER.crumpled : PAPER.background,
      }}>
        {children}
      </View>
    </View>
  );
}
