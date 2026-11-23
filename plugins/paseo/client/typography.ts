import type { PluginTheme } from "@getpaseo/plugin";
import { Platform } from "react-native";

type ThemeTypography = {
  fontSize?: Partial<Record<"sm" | "base" | "code", number>>;
  fontFamily?: Partial<Record<"ui" | "mono", string>>;
};

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });
const lineHeight = (size: number, ratio: number) => Math.round(size * ratio * 2) / 2;

export function typography(theme: PluginTheme) {
  // The host can supply these roles before the SDK exposes them (#6600).
  const { fontSize, fontFamily } = (theme as PluginTheme & { typography?: ThemeTypography }).typography ?? {};
  const text = (size: number) => ({ fontSize: size, lineHeight: lineHeight(size, 1.5), fontFamily: fontFamily?.ui });
  const size = fontSize?.code ?? 13;
  const inlineCode = { fontSize: size, fontFamily: fontFamily?.mono ?? MONO };
  return {
    sm: text(fontSize?.sm ?? 11.5), base: text(fontSize?.base ?? 13), body: text(size),
    inlineCode, code: { ...inlineCode, lineHeight: lineHeight(size, 1.4) },
  };
}

export type Typography = ReturnType<typeof typography>;
