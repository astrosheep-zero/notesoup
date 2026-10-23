import type { PluginTheme } from "@getpaseo/plugin";

const LIGHT_PAPER = {
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

export type PaperPalette = typeof LIGHT_PAPER;

const DARK_PAPER: PaperPalette = {
  background: "#302e27",
  edge: "#58513e",
  tape: "rgba(139, 122, 70, 0.55)",
  tapeEdge: "rgba(194, 170, 100, 0.18)",
  ink: "#e8e1cc",
  inkMuted: "#b5aa8e",
  added: "#91c79a",
  removed: "#e69a8f",
  crumpled: "#292824",
};

/** Paseo theme colors are hex (#RGB, #RRGGBB or #RRGGBBAA). */
function brightness(hex: string): number {
  const rgb = hex.length === 4 ? hex.slice(1).replace(/./g, digit => digit + digit) : hex.slice(1, 7);
  return 0.299 * parseInt(rgb.slice(0, 2), 16)
    + 0.587 * parseInt(rgb.slice(2, 4), 16)
    + 0.114 * parseInt(rgb.slice(4, 6), 16);
}

export function paperPalette(theme: PluginTheme): PaperPalette {
  // The SDK exposes colors, not appearance. Use the host theme, never the OS color scheme.
  return brightness(theme.colors.foreground) > brightness(theme.colors.surface0) ? DARK_PAPER : LIGHT_PAPER;
}
