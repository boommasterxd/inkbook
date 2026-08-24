import { addIcon, removeIcon } from "obsidian";

import { SHAPE_ICON_IDS, STRAIGHT_HIGHLIGHTER_ICON_ID } from "../../rendering/ui/icon-ids";

const STRAIGHT_HIGHLIGHTER_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/><path d="M18 16l-4-4m6 2-4-4" data-inkbook-ruler-marks="true"/></svg>';

const SHAPE_ICONS: readonly (readonly [string, string])[] = [
  [SHAPE_ICON_IDS.line, '<path d="M4 12h16"/>'],
  [SHAPE_ICON_IDS.arrow, '<path d="M5 19 19 5m-8 0h8v8"/>'],
  [SHAPE_ICON_IDS.rectangle, '<rect x="4" y="5" width="16" height="14" rx="1"/>'],
  [SHAPE_ICON_IDS.ellipse, '<ellipse cx="12" cy="12" rx="8" ry="6"/>'],
  [SHAPE_ICON_IDS.triangle, '<path d="m12 4 8 15H4Z"/>'],
  [SHAPE_ICON_IDS.octagon, '<path d="m8 3 8 0 5 5v8l-5 5H8l-5-5V8Z"/>'],
  [SHAPE_ICON_IDS.parallelogram, '<path d="M8 5h13l-5 14H3Z"/>'],
  [SHAPE_ICON_IDS.diamond, '<path d="m12 3 9 9-9 9-9-9Z"/>'],
  [
    SHAPE_ICON_IDS["coordinate-system"],
    '<path d="M4 19h16M6 21V4m0 0-2 3m2-3 2 3m12 12-3-2m3 2-3 2"/>',
  ],
  [SHAPE_ICON_IDS.table, '<rect x="4" y="4" width="16" height="16" rx="1"/>'],
];

function shapeIconSvg(content: string): string {
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">${content}</svg>`;
}

export function registerInkbookIcons(): () => void {
  addIcon(STRAIGHT_HIGHLIGHTER_ICON_ID, STRAIGHT_HIGHLIGHTER_SVG);
  for (const [id, content] of SHAPE_ICONS) addIcon(id, shapeIconSvg(content));
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    removeIcon(STRAIGHT_HIGHLIGHTER_ICON_ID);
    for (const [id] of SHAPE_ICONS) removeIcon(id);
  };
}
