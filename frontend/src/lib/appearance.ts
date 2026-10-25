export type ThemeMode = "light" | "dark" | "system";
export type PaletteId = "ink" | "sage" | "ocean" | "violet" | "rose" | "sand";
export type FontPairing = "mixed" | "sans";

export type Appearance = {
  theme: ThemeMode;
  palette: PaletteId;
  fontPairing: FontPairing;
  readingScale: number;
};

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "light",
  palette: "ink",
  fontPairing: "mixed",
  readingScale: 1,
};

export const PALETTES = [
  {
    id: "ink",
    name: "暖白墨黑",
    note: "温暖纸白，沉静墨色",
    background: "#f2f1ee",
    accent: "#343d38",
  },
  {
    id: "sage",
    name: "鼠尾草绿",
    note: "清浅草木，柔和绿意",
    background: "#f3f5f2",
    accent: "#3f6b50",
  },
  {
    id: "ocean",
    name: "海盐蓝",
    note: "清透蓝灰，专注而轻盈",
    background: "#eff4f8",
    accent: "#356784",
  },
  {
    id: "violet",
    name: "暮山紫",
    note: "雾紫与纸白，安静柔和",
    background: "#f3f0f7",
    accent: "#735b92",
  },
  {
    id: "rose",
    name: "蔷薇粉",
    note: "浅玫瑰色，温柔明亮",
    background: "#f8f0f1",
    accent: "#895264",
  },
  {
    id: "sand",
    name: "麦穗金",
    note: "暖沙与琥珀，适合长时间阅读",
    background: "#f7f3eb",
    accent: "#7e5e2b",
  },
] as const;

export const FONT_PAIRINGS = [
  { id: "mixed", name: "宋黑搭配", note: "宋体标题，黑体正文与界面" },
  { id: "sans", name: "清晰黑体", note: "标题与正文统一使用黑体" },
] as const;

export function normalizeAppearance(value: Partial<Appearance>): Appearance {
  return {
    theme: ["light", "dark", "system"].includes(value.theme || "")
      ? (value.theme as ThemeMode)
      : DEFAULT_APPEARANCE.theme,
    palette: PALETTES.some((palette) => palette.id === value.palette)
      ? (value.palette as PaletteId)
      : DEFAULT_APPEARANCE.palette,
    fontPairing: value.fontPairing === "sans" ? "sans" : "mixed",
    readingScale:
      typeof value.readingScale === "number" &&
      Number.isFinite(value.readingScale)
        ? Math.min(1.2, Math.max(0.9, value.readingScale))
        : 1,
  };
}

export function applyAppearance(appearance: Appearance, darkSystem: boolean) {
  const root = document.documentElement;
  const theme =
    appearance.theme === "system"
      ? darkSystem
        ? "dark"
        : "light"
      : appearance.theme;
  root.dataset.theme = theme;
  root.dataset.palette = appearance.palette;
  root.dataset.fontPairing = appearance.fontPairing;
  root.style.colorScheme = theme;
  root.style.setProperty("--reading-scale", String(appearance.readingScale));
}
