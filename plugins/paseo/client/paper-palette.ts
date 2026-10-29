import type { PluginTheme } from "@getpaseo/plugin";

const LIGHT_PAPER = {
  background: "#faf7f0",
  edge: "#e2d9c8",
  ink: "#26221b",
  inkMuted: "#827866",
  added: "#2b6e3c",
  removed: "#ad3e34",
  crumpled: "#efeae0",
  tape: "rgba(224, 206, 148, 0.62)",
  tapeEdge: "rgba(165, 145, 86, 0.16)",
};

export type PaperPalette = typeof LIGHT_PAPER;

const DARK_PAPER: PaperPalette = {
  // Manila tape, not orange-brown: hue held near 50°, never the 30–40° brown that reads red.
  background: "#26231d",
  edge: "#463f31",
  ink: "#ece5d5",
  inkMuted: "#a89e86",
  added: "#8cbf98",
  removed: "#dc8f80",
  crumpled: "#1e1b16",
  tape: "rgba(182, 160, 104, 0.38)",
  tapeEdge: "rgba(218, 195, 134, 0.16)",
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
