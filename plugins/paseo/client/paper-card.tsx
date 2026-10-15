import type { ReactNode } from "react";
import { View } from "react-native";

/** Shared paper palette, independent of the host theme. */
export const PAPER = {
  background: "#f7f2df",
  border: "#d9cdaa",
  tape: "#d8c98f",
  ink: "#33301f",
  inkMuted: "#867c63",
  added: "#357a44",
  removed: "#b0493e",
};

export function PaperCard({ compact, children }: { compact: boolean; children: ReactNode }) {
  return (
    <View style={{ paddingTop: 6 }}>
      <View style={{
        alignSelf: "flex-start", width: 84, height: 14, marginLeft: 28, marginBottom: -9, zIndex: 1,
        backgroundColor: PAPER.tape, opacity: 0.9, borderRadius: 2,
        transform: [{ rotate: "-2deg" }],
      }} />
      <View style={{
        padding: compact ? 10 : 12,
        gap: 5,
        minWidth: 0,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: PAPER.border,
        backgroundColor: PAPER.background,
      }}>
        {children}
      </View>
    </View>
  );
}
