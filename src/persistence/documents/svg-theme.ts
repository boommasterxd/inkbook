export const DOCUMENT_PALETTE = {
  dark: {
    guide: "#383838FF",
    page: "#212121FF",
    text: "#DADADAFF",
  },
  light: {
    guide: "#DCDCDCFF",
    page: "#F6F6F6FF",
    text: "#222222FF",
  },
} as const;

export const DOCUMENT_THEME_FALLBACK = {
  guide: "#70707040",
} as const;

export const THEME_CLASSES = [
  "inkbook-theme-page",
  "inkbook-theme-guide",
  "inkbook-theme-stroke",
  "inkbook-theme-fill",
  "inkbook-theme-stroke-fill",
] as const;

export type ThemeClass = (typeof THEME_CLASSES)[number];

const CURRENT_GUIDE_RULE =
  ".inkbook-theme-guide{stroke:var(--inkbook-guide);shape-rendering:crispEdges;vector-effect:non-scaling-stroke}";
const PREVIOUS_GUIDE_RULE =
  ".inkbook-theme-guide{stroke:var(--inkbook-guide);shape-rendering:crispEdges}";

export const CANONICAL_THEME_STYLESHEET =
  ":root{color-scheme:light dark;--inkbook-page:#F6F6F6FF;--inkbook-text:#222222FF;--inkbook-guide:#DCDCDCFF}" +
  "@media(prefers-color-scheme:dark){:root{--inkbook-page:#212121FF;--inkbook-text:#DADADAFF;--inkbook-guide:#383838FF}}" +
  "@media print{:root{--inkbook-page:#F6F6F6FF;--inkbook-text:#222222FF;--inkbook-guide:#DCDCDCFF}}" +
  ".inkbook-theme-page{fill:var(--inkbook-page)}" +
  CURRENT_GUIDE_RULE +
  ".inkbook-theme-stroke{stroke:var(--inkbook-text)}" +
  ".inkbook-theme-fill{fill:var(--inkbook-text)}" +
  ".inkbook-theme-stroke-fill{stroke:var(--inkbook-text);fill:var(--inkbook-text)}";

const RECENT_THEME_STYLESHEET_V1 = legacyThemeStylesheet("#212121FF");
export const LEGACY_THEME_STYLESHEET_V1 = legacyThemeStylesheet("#282828FF");
const PREVIOUS_THEME_STYLESHEET_V1 = CANONICAL_THEME_STYLESHEET.replace(
  CURRENT_GUIDE_RULE,
  PREVIOUS_GUIDE_RULE,
);

export function isSupportedThemeStylesheet(stylesheet: string): boolean {
  return (
    stylesheet === CANONICAL_THEME_STYLESHEET ||
    stylesheet === PREVIOUS_THEME_STYLESHEET_V1 ||
    stylesheet === RECENT_THEME_STYLESHEET_V1 ||
    stylesheet === LEGACY_THEME_STYLESHEET_V1
  );
}

function legacyThemeStylesheet(darkPage: "#212121FF" | "#282828FF"): string {
  return CANONICAL_THEME_STYLESHEET.replaceAll(
    "--inkbook-guide:#DCDCDCFF",
    "--inkbook-guide:#70707040",
  )
    .replace("--inkbook-guide:#383838FF", "--inkbook-guide:#99999940")
    .replace("--inkbook-page:#212121FF", `--inkbook-page:${darkPage}`)
    .replace(CURRENT_GUIDE_RULE, ".inkbook-theme-guide{stroke:var(--inkbook-guide)}");
}
