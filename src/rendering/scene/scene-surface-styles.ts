// Only SVG presentation rules belong inside the isolated scene. Host layout and
// input remain in the plugin stylesheet; inherited tokens retain host appearance.
export const SCENE_SURFACE_STYLES = `
.inkbook-scene {
  block-size: 100%; box-sizing: border-box; contain: layout; display: block;
  inline-size: 100%; inset: 0; overflow: visible; pointer-events: none;
  position: absolute; transform-origin: top left;
}
.inkbook-theme-page { fill: var(--inkbook-page); }
.inkbook-theme-guide { stroke: var(--inkbook-guide); }
.inkbook-theme-stroke { stroke: var(--inkbook-text); }
.inkbook-theme-fill { fill: var(--inkbook-text); }
.inkbook-theme-stroke-fill { stroke: var(--inkbook-text); fill: var(--inkbook-text); }
.inkbook-text-editor {
  box-sizing: border-box; width: var(--inkbook-text-editor-width, 100%); height: var(--inkbook-text-editor-height, 100%);
  margin: 0; padding: 0; position: relative;
  top: calc(-1 * var(--inkbook-text-viewport-top, 0px));
  border: 0; overflow: visible; pointer-events: auto;
}
.inkbook-text-editor-viewport {
  box-sizing: border-box; width: 100%; position: relative;
  top: var(--inkbook-text-viewport-top, 0px);
  height: var(--inkbook-text-viewport-height, 0px);
  margin: 0; padding: 0; border: 0; overflow: clip;
}
:root[data-inkbook-text-handle-cursor],
:root[data-inkbook-text-handle-cursor] .inkbook-text-table-controls-layer,
:root[data-inkbook-text-handle-cursor] .inkbook-text-table-controls-layer *,
:root[data-inkbook-text-handle-cursor] .inkbook-text-editor,
:root[data-inkbook-text-handle-cursor] .inkbook-text-editor * {
  cursor: var(--inkbook-text-handle-cursor) !important;
}
/* Retain strict ancestor overflow when the last visible lines end at the clip edge. */
.inkbook-text-editor-viewport::after {
  content: ""; display: block; block-size: 1px; pointer-events: none;
}
.inkbook-scene[data-inkbook-text-editing] .inkbook-selection-overlay {
  fill: none;
}
.inkbook-scene[data-inkbook-text-editing] .inkbook-selection-traces {
  visibility: hidden;
}
.inkbook-native-text[data-inkbook-text-editor-ready] > path:first-child {
  visibility: hidden;
}
[data-inkbook-motion] { transform-box: fill-box; transform-origin: center; }
.inkbook-native-text[data-inkbook-motion] { transform-box: view-box; }
.inkbook-selection-center-trace {
  fill: none; stroke: var(--interactive-accent); stroke-linecap: round;
  stroke-linejoin: round; stroke-width: 1.5;
}
.inkbook-scene-overlays path {
  fill: color-mix(in srgb, var(--interactive-accent) 18%, transparent);
  stroke: var(--interactive-accent); stroke-width: 1.5;
}
.inkbook-scene-overlays .inkbook-selection-area-preview {
  stroke-dasharray: 3 3; stroke-linecap: round; stroke-linejoin: round;
}
.inkbook-scene-overlays .inkbook-selection-overlay[data-center-outline="true"] {
  stroke: none;
}
.inkbook-scene-overlays .inkbook-selection-overlay[data-selection-fill="none"] {
  fill: none;
}
.inkbook-scene-overlays .inkbook-selection-handles {
  fill: var(--interactive-accent); stroke: var(--interactive-accent);
}
.inkbook-scene-overlays .inkbook-snap-guide {
  fill: none;
  stroke: color-mix(in srgb, var(--interactive-accent) 82%, var(--text-normal));
  stroke-dasharray: 3 3; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.5;
}
`;
