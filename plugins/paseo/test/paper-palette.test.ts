import assert from "node:assert/strict";
import test from "node:test";
import type { PluginTheme } from "@getpaseo/plugin";
import { paperPalette } from "../client/paper-palette.ts";

function theme(surface0: string, foreground: string): PluginTheme {
  return { colors: {
    surface0, foreground,
    surface1: surface0, surface2: surface0, border: foreground,
    foregroundMuted: foreground, accent: foreground, accentForeground: surface0,
    statusSuccess: foreground, statusWarning: foreground, statusDanger: foreground,
  } };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(index => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

test("paper follows the host theme and preserves the light palette when switching back", () => {
  const light = theme("#ffffff", "#18181b");
  const dark = theme("#18181b", "#fafafa");
  const paper = paperPalette(light);
  assert.equal(paper.background, "#faf6eb");
  assert.equal(paper.ink, "#2c281e");
  assert.ok(luminance(paperPalette(dark).background) < 0.05);
  assert.notDeepEqual(paperPalette(dark), paper);
  assert.deepEqual(paperPalette(light), paper);
});

test("host hex shorthand and alpha colors select the same dark paper", () => {
  const paper = paperPalette(theme("#000000", "#ffffff"));
  assert.deepEqual(paperPalette(theme("#000", "#fff")), paper);
  assert.deepEqual(paperPalette(theme("#000000ff", "#ffffffff")), paper);
  assert.equal(paperPalette(theme("#fff", "#000")).background, "#faf6eb");
});

test("dark text, muted labels, additions and errors remain readable on normal and crumpled paper", () => {
  const paper = paperPalette(theme("#18181b", "#fafafa"));
  for (const background of [paper.background, paper.crumpled]) {
    for (const ink of [paper.ink, paper.inkMuted, paper.added, paper.removed]) {
      assert.ok(contrast(ink, background) >= 4.5, `${ink} on ${background} must meet WCAG AA text contrast`);
    }
  }
});
