export const DOCUMENT_PALETTE = {
  dark: {
    guide: "#99999940",
    page: "#282828FF",
    text: "#DADADAFF",
  },
  light: {
    guide: "#70707040",
    page: "#F6F6F6FF",
    text: "#222222FF",
  },
} as const;

export const THEME_CLASSES = [
  "inkbook-theme-page",
  "inkbook-theme-guide",
  "inkbook-theme-stroke",
  "inkbook-theme-fill",
  "inkbook-theme-stroke-fill",
] as const;

export type ThemeClass = (typeof THEME_CLASSES)[number];

export const CANONICAL_THEME_STYLESHEET =
  ":root{color-scheme:light dark;--inkbook-page:#F6F6F6FF;--inkbook-text:#222222FF;--inkbook-guide:#70707040}" +
  "@media(prefers-color-scheme:dark){:root{--inkbook-page:#282828FF;--inkbook-text:#DADADAFF;--inkbook-guide:#99999940}}" +
  "@media print{:root{--inkbook-page:#F6F6F6FF;--inkbook-text:#222222FF;--inkbook-guide:#70707040}}" +
  ".inkbook-theme-page{fill:var(--inkbook-page)}" +
  ".inkbook-theme-guide{stroke:var(--inkbook-guide)}" +
  ".inkbook-theme-stroke{stroke:var(--inkbook-text)}" +
  ".inkbook-theme-fill{fill:var(--inkbook-text)}" +
  ".inkbook-theme-stroke-fill{stroke:var(--inkbook-text);fill:var(--inkbook-text)}";
