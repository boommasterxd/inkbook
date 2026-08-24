export const DOCUMENT_PALETTE = {
  dark: {
    guide: "#66666640",
    page: "#212121FF",
    text: "#DADADAFF",
  },
  light: {
    guide: "#ABABAB40",
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
  ".inkbook-theme-guide{stroke:var(--inkbook-guide);vector-effect:non-scaling-stroke}";
const OPAQUE_GUIDE_RULE =
  ".inkbook-theme-guide{stroke:var(--inkbook-guide);shape-rendering:crispEdges;vector-effect:non-scaling-stroke}";
const PREVIOUS_OPAQUE_GUIDE_RULE =
  ".inkbook-theme-guide{stroke:var(--inkbook-guide);shape-rendering:crispEdges}";
const VIEWPORT_CLIP_RULE = "svg{overflow:hidden}";

export const CANONICAL_THEME_STYLESHEET =
  ":root{color-scheme:light dark;--inkbook-page:#F6F6F6FF;--inkbook-text:#222222FF;--inkbook-guide:#ABABAB40}" +
  "@media(prefers-color-scheme:dark){:root{--inkbook-page:#212121FF;--inkbook-text:#DADADAFF;--inkbook-guide:#66666640}}" +
  "@media print{:root{--inkbook-page:#F6F6F6FF;--inkbook-text:#222222FF;--inkbook-guide:#ABABAB40}}" +
  VIEWPORT_CLIP_RULE +
  ".inkbook-theme-page{fill:var(--inkbook-page)}" +
  CURRENT_GUIDE_RULE +
  ".inkbook-theme-stroke{stroke:var(--inkbook-text)}" +
  ".inkbook-theme-fill{fill:var(--inkbook-text)}" +
  ".inkbook-theme-stroke-fill{stroke:var(--inkbook-text);fill:var(--inkbook-text)}";

const OPAQUE_THEME_STYLESHEET_V1 = replaceGuidePresentation(
  CANONICAL_THEME_STYLESHEET,
  "#DCDCDCFF",
  "#383838FF",
  OPAQUE_GUIDE_RULE,
);
const PREVIOUS_OPAQUE_THEME_STYLESHEET_V1 = OPAQUE_THEME_STYLESHEET_V1.replace(
  OPAQUE_GUIDE_RULE,
  PREVIOUS_OPAQUE_GUIDE_RULE,
);
const PREVIOUS_THEME_STYLESHEET_V1 = CANONICAL_THEME_STYLESHEET.replace(
  CURRENT_GUIDE_RULE,
  ".inkbook-theme-guide{stroke:var(--inkbook-guide)}",
);
const RECENT_THEME_STYLESHEET_V1 = legacyThemeStylesheet("#212121FF");
export const LEGACY_THEME_STYLESHEET_V1 = legacyThemeStylesheet("#282828FF");
const SUPPORTED_THEME_STYLESHEETS = new Set([
  CANONICAL_THEME_STYLESHEET,
  PREVIOUS_THEME_STYLESHEET_V1,
  OPAQUE_THEME_STYLESHEET_V1,
  PREVIOUS_OPAQUE_THEME_STYLESHEET_V1,
  RECENT_THEME_STYLESHEET_V1,
  LEGACY_THEME_STYLESHEET_V1,
  withoutViewportClip(CANONICAL_THEME_STYLESHEET),
  withoutViewportClip(PREVIOUS_THEME_STYLESHEET_V1),
  withoutViewportClip(OPAQUE_THEME_STYLESHEET_V1),
  withoutViewportClip(PREVIOUS_OPAQUE_THEME_STYLESHEET_V1),
  withoutViewportClip(RECENT_THEME_STYLESHEET_V1),
  withoutViewportClip(LEGACY_THEME_STYLESHEET_V1),
]);

export function isSupportedThemeStylesheet(stylesheet: string): boolean {
  return SUPPORTED_THEME_STYLESHEETS.has(stylesheet);
}

function legacyThemeStylesheet(darkPage: "#212121FF" | "#282828FF"): string {
  return replaceGuidePresentation(
    CANONICAL_THEME_STYLESHEET,
    "#70707040",
    "#99999940",
    ".inkbook-theme-guide{stroke:var(--inkbook-guide)}",
  ).replace("--inkbook-page:#212121FF", `--inkbook-page:${darkPage}`);
}

function replaceGuidePresentation(
  stylesheet: string,
  lightGuide: string,
  darkGuide: string,
  guideRule: string,
): string {
  return stylesheet
    .replaceAll("--inkbook-guide:#ABABAB40", `--inkbook-guide:${lightGuide}`)
    .replace("--inkbook-guide:#66666640", `--inkbook-guide:${darkGuide}`)
    .replace(CURRENT_GUIDE_RULE, guideRule);
}

function withoutViewportClip(stylesheet: string): string {
  return stylesheet.replace(VIEWPORT_CLIP_RULE, "");
}
