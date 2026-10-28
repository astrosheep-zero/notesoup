import type { PluginTheme } from "@getpaseo/plugin";

const LIGHT_PAPER = {
  background: "#faf7f0",
  edge: "#e2d9c8",
  crease: "#ede5d5",
  ink: "#26221b",
  inkMuted: "#827866",
  added: "#2b6e3c",
  removed: "#ad3e34",
  crumpled: "#efeae0",
};

export type PaperPalette = typeof LIGHT_PAPER;

const DARK_PAPER: PaperPalette = {
  background: "#201d18",
  edge: "#383228",
  crease: "#2d2820",
  ink: "#ede6da",
  inkMuted: "#968c7a",
  added: "#84c294",
  removed: "#de877e",
  crumpled: "#171511",
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
