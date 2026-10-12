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
[data-inkbook-motion] { transform-box: fill-box; transform-origin: center; }
.inkbook-scene-foreground {
  visibility: var(--inkbook-scene-foreground-visibility, visible);
}
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
@keyframes inkbook-element-opacity-exit {
  to { opacity: 0; }
}
@keyframes inkbook-element-fill-exit {
  to { fill-opacity: 0; }
}
@keyframes inkbook-element-stroke-exit {
  to { stroke-opacity: 0; }
}
@keyframes inkbook-element-opacity-enter {
  to { opacity: 0; }
}
@keyframes inkbook-element-fill-enter {
  to { fill-opacity: 0; }
}
@keyframes inkbook-element-stroke-enter {
  to { stroke-opacity: 0; }
}
`;
