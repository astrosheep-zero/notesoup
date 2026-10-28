import type { PluginTheme } from "@getpaseo/plugin";

const LIGHT_PAPER = {
  background: "#faf6eb",
  edge: "#dcd0b4",
  tape: "rgba(224, 206, 148, 0.62)",
  tapeEdge: "rgba(165, 145, 86, 0.16)",
  ink: "#2c281e",
  inkMuted: "#7d735d",
  added: "#2f743e",
  removed: "#b3463b",
  crumpled: "#f1ead8",
};

export type PaperPalette = typeof LIGHT_PAPER;

const DARK_PAPER: PaperPalette = {
  background: "#26231d",
  edge: "#463f31",
  tape: "rgba(182, 160, 104, 0.38)",
  tapeEdge: "rgba(218, 195, 134, 0.16)",
  ink: "#ece5d5",
  inkMuted: "#a89e86",
  added: "#8cc494",
  removed: "#e29488",
  crumpled: "#1e1b16",
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
