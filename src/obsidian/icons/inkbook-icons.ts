import { addIcon, removeIcon } from "obsidian";

import { ARROW_NODES } from "../../domain/settings/types";
import type { ArrowNodeV1 } from "../../domain/schema/public";
import {
  arrowShapeIconId,
  BACKGROUND_SQUARES_ICON_ID,
  CAUTION_ERASER_ICON_ID,
  coordinateSystemIconId,
  OPACITY_ICON_ID,
  PRESSURE_SENSITIVITY_ICON_ID,
  SHAPE_ICON_IDS,
  STRAIGHT_HIGHLIGHTER_ICON_ID,
} from "../../rendering/ui/icon-ids";

const STRAIGHT_HIGHLIGHTER_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/><path d="M18 16l-4-4m6 2-4-4" data-inkbook-ruler-marks="true"/></svg>';

const CAUTION_ERASER_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="var(--color-orange)" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m7 21-4.3-4.3a2.3 2.3 0 0 1 0-3.2L13.4 2.8a2.3 2.3 0 0 1 3.2 0l4.6 4.6a2.3 2.3 0 0 1 0 3.2L11 21Z"/><path d="m5 11 9 9"/><path d="M22 21H7"/></svg>';

const OPACITY_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="none"><circle cx="4.5" cy="12" r="2.25" opacity="0.22"/><circle cx="9.5" cy="12" r="2.25" opacity="0.45"/><circle cx="14.5" cy="12" r="2.25" opacity="0.7"/><circle cx="19.5" cy="12" r="2.25"/></svg>';

const PRESSURE_SENSITIVITY_SVG = `<svg viewBox="-16 -16 386 384" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="none"><g transform="translate(-39.149142 397) scale(.1 -.1)"><path d="M3480 3952c0-30-33-52-78-52-42 0-71-19-143-94-75-78-356-83-549-8-101 39-345 59-465 38-91-17-275-177-275-241 0-9-6-31-14-48-58-133-59-162-12-327 9-30 20-79 26-108 5-29 18-65 29-80 10-15 28-52 39-82 10-30 31-73 46-94 14-22 29-51 33-65 3-14 16-37 29-50 13-12 26-33 30-45 6-20 15-33 109-162 25-34 45-66 45-71 0-10 23-40 113-151 20-26 37-52 37-59 0-7 4-13 9-13 4 0 18-22 29-49 24-57 7-79-32-42-12 11-41 23-66 27-25 3-67 18-95 33-27 15-77 35-110 46-33 10-67 24-75 30-26 20-87 45-110 45-11 0-45 14-75 30-30 17-62 30-72 30-23 0-116 32-135 47-16 12-137 43-170 43-13 0-32 6-43 14-98 67-627 69-705 2-8-7-30-16-49-20-19-3-58-24-87-46-29-22-56-40-59-40-10 0-105-96-105-107 0-5-13-22-30-36-16-15-30-35-30-45 0-9-7-26-15-36-8-11-15-26-15-35 0-8-6-22-13-30-47-56-47-483 0-543 6-7 18-44 27-83 10-38 30-97 46-130 15-33 36-85 45-115 10-30 22-61 29-69 44-53 36-92-36-172-87-97-101-233-32-313 19-22 39-45 43-51 20-23 110-95 120-95 13 0 81-31 101-45 60-45 363-45 420 0 8 6 35 20 60 30 25 10 57 31 72 47 15 15 31 28 36 28 15 0 105 105 124 145 11 22 29 58 41 80 42 80 31 467-15 522-17 21-28 85-17 106 15 26 122 3 149-32 3-4 30-13 60-19 30-7 82-26 116-42 33-15 85-33 115-38 30-6 74-22 99-36 25-14 56-26 70-26 32 0 133-32 151-47 8-6 57-20 110-31 53-11 104-25 115-31 35-20 114-41 153-41 37 0 191-29 261-50 79-23 356-13 418 16 31 14 73 28 92 31 38 6 100 39 100 54 0 5 9 9 19 9 11 0 26 7 35 15 8 8 17 15 20 15 5 0 42 32 104 92 17 17 32 37 32 44 0 8 4 14 9 14 13 0 43 49 52 84 4 17 17 56 28 86 29 76 22 174-18 249-6 11-11 32-11 48 0 15-9 42-20 58-33 49-37 58-56 105-10 25-31 58-46 74-15 17-28 35-28 41 0 6-13 24-30 40-16 16-30 33-30 38 0 10-304 317-313 317-4 0-22 15-41 33-19 17-68 62-108 99-40 37-111 104-158 148-46 44-88 80-92 80-5 0-8 4-8 10 0 15-33 50-47 50-7 0-13 4-13 8 0 5-34 44-75 86-41 42-75 81-75 85 0 4-10 16-21 27-12 10-37 42-54 69-18 28-42 60-54 72-12 12-21 29-21 38 0 9-7 30-16 46-17 34-8 76 23 111 28 31 156 23 303-19 216-62 530-5 626 115 21 26 41 49 44 52 9 8 40 104 40 123 0 12 18 26 58 44 31 15 59 29 62 32 10 12 81 41 99 41 10 0 37 14 59 30 23 17 49 30 57 30 37 0 95 35 95 57 0 23 0 23-225 23-212 0-225-1-225-18Z"/></g></svg>`;

const BACKGROUND_SQUARES_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-linecap="butt" stroke-linejoin="miter" stroke-width="1.5"><path d="M3 3h18v18H3zM9 3v18m6-18v18M3 9h18m-18 6h18"/></svg>';

const MENU_ICONS: readonly (readonly [string, string])[] = [
  [OPACITY_ICON_ID, OPACITY_SVG],
  [PRESSURE_SENSITIVITY_ICON_ID, PRESSURE_SENSITIVITY_SVG],
  [BACKGROUND_SQUARES_ICON_ID, BACKGROUND_SQUARES_SVG],
];

const SHAPE_ICONS: readonly (readonly [string, string])[] = [
  [SHAPE_ICON_IDS.line, '<path d="M4 12h16"/>'],
  [SHAPE_ICON_IDS.arrow, '<path d="M4 12h16m-4-4 4 4-4 4"/>'],
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
  [SHAPE_ICON_IDS.table, '<path d="M4 9h16M12 4v16"/>'],
];

const DYNAMIC_SHAPE_ICONS: readonly (readonly [string, string])[] = [
  ...ARROW_NODES.flatMap((start) =>
    ARROW_NODES.map((end) => [arrowShapeIconId(start, end), arrowIconContent(start, end)] as const),
  ),
  [coordinateSystemIconId("2d"), '<path d="M4 19h16M6 21V4m0 0-2 3m2-3 2 3m12 12-3-2m3 2-3 2"/>'],
  [
    coordinateSystemIconId("3d"),
    '<path d="M6 18h14m-14 0V4m0 14 10-9M6 4 4 7m2-3 2 3m12 11-3-2m3 2-3 2m-1-11-4 1m4-1-1 4"/>',
  ],
];

function arrowIconContent(start: ArrowNodeV1, end: ArrowNodeV1): string {
  return `<path d="M4 12h16"/>${arrowNodeContent(start, "start")}${arrowNodeContent(end, "end")}`;
}

function arrowNodeContent(node: ArrowNodeV1, side: "start" | "end"): string {
  if (node === "none") return "";
  const start = side === "start";
  if (node === "arrow") return start ? '<path d="m8 8-4 4 4 4"/>' : '<path d="m16 8 4 4-4 4"/>';
  if (node === "triangle") return start ? '<path d="m4 12 6-4v8Z"/>' : '<path d="m20 12-6-4v8Z"/>';
  if (node === "diamond")
    return start ? '<path d="m4 12 4-4 4 4-4 4Z"/>' : '<path d="m20 12-4-4-4 4 4 4Z"/>';
  return start ? '<circle cx="5" cy="12" r="3"/>' : '<circle cx="19" cy="12" r="3"/>';
}

function shapeIconSvg(content: string): string {
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">${content}</svg>`;
}

export function registerInkbookIcons(): () => void {
  addIcon(STRAIGHT_HIGHLIGHTER_ICON_ID, STRAIGHT_HIGHLIGHTER_SVG);
  addIcon(CAUTION_ERASER_ICON_ID, CAUTION_ERASER_SVG);
  for (const [id, svg] of MENU_ICONS) addIcon(id, svg);
  for (const [id, content] of SHAPE_ICONS) addIcon(id, shapeIconSvg(content));
  for (const [id, content] of DYNAMIC_SHAPE_ICONS) addIcon(id, shapeIconSvg(content));
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    removeIcon(STRAIGHT_HIGHLIGHTER_ICON_ID);
    removeIcon(CAUTION_ERASER_ICON_ID);
    for (const [id] of MENU_ICONS) removeIcon(id);
    for (const [id] of SHAPE_ICONS) removeIcon(id);
    for (const [id] of DYNAMIC_SHAPE_ICONS) removeIcon(id);
  };
}
