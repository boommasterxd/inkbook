import { addIcon, removeIcon } from "obsidian";

import { STRAIGHT_HIGHLIGHTER_ICON_ID } from "../../rendering/ui/icon-ids";

const STRAIGHT_HIGHLIGHTER_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/><path d="M18 16l-4-4m6 2-4-4" data-inkbook-ruler-marks="true"/></svg>';

export function registerInkbookIcons(): () => void {
  addIcon(STRAIGHT_HIGHLIGHTER_ICON_ID, STRAIGHT_HIGHLIGHTER_SVG);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    removeIcon(STRAIGHT_HIGHLIGHTER_ICON_ID);
  };
}
