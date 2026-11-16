import { PORTABLE_PALETTE_V1 } from "../../domain/schema/public";
import { CANONICAL_PAINT_STYLES } from "./scene-surface-styles";

/** Only canonical document paint enters the inert preview document. */
export const STATIC_PREVIEW_STYLES = `
html, body {
  inline-size: 100%;
  block-size: 100%;
}
.inkbook-locked-preview-svg {
  display: block;
  inline-size: 100%;
  block-size: 100%;
  overflow: hidden;
  pointer-events: none;
}
.inkbook-theme-guide {
  vector-effect: non-scaling-stroke;
}
${schemeRules("light")}
${schemeRules("dark")}
${CANONICAL_PAINT_STYLES}
`;

function schemeRules(scheme: keyof typeof PORTABLE_PALETTE_V1): string {
  const palette = PORTABLE_PALETTE_V1[scheme];
  const root = `html[data-inkbook-scheme="${scheme}"]`;
  return `
${root} {
  --inkbook-page: ${palette.page};
  --inkbook-text: ${palette.text};
  --inkbook-guide: ${palette.guide};
}
`;
}
