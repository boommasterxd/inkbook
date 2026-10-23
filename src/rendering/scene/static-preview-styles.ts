import { PORTABLE_PALETTE_V1 } from "../../domain/schema/public";

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
`;

function schemeRules(scheme: keyof typeof PORTABLE_PALETTE_V1): string {
  const palette = PORTABLE_PALETTE_V1[scheme];
  const root = `html[data-inkbook-scheme="${scheme}"]`;
  return `
${root} .inkbook-theme-page { fill: ${palette.page}; }
${root} .inkbook-theme-guide { stroke: ${palette.guide}; }
${root} .inkbook-theme-stroke { stroke: ${palette.text}; }
${root} .inkbook-theme-fill { fill: ${palette.text}; }
${root} .inkbook-theme-stroke-fill { fill: ${palette.text}; stroke: ${palette.text}; }
`;
}
