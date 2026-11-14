import {
  arrowNodeIconId,
  coordinateSystemIconId,
  selectionAreaIconId,
} from "../../rendering/ui/icon-ids";
import { createOutlineStylePreview } from "./style-outline-preview";
import { menuDomWindow } from "./menu-dom";

const WIDTH_PREVIEW_PIXELS: Readonly<Record<string, number>> = {
  "1": 0.5,
  "2": 1,
  "4": 2.5,
  "8": 4,
  "12": 5.5,
  "14": 6,
  "22": 8,
};

export function createChoicePreview(
  options: {
    readonly ownerDocument: Document;
    readonly renderIcon: (element: HTMLElement, icon: string) => void;
  },
  controlId: string,
  value: string,
): HTMLElement | null {
  const preview = menuDomWindow(options.ownerDocument, "style menu").createSpan({
    cls: "inkbook-menu-choice-preview",
  });
  if (controlId.endsWith("color")) {
    preview.classList.add("inkbook-menu-color-swatch");
    preview.dataset.empty = value === "none" ? "true" : undefined;
    preview.style.setProperty(
      "--inkbook-menu-color",
      value === "theme-text" ? "var(--text-normal)" : value,
    );
    return preview;
  }
  if (controlId.endsWith("width")) {
    preview.classList.add("inkbook-menu-line-preview");
    preview.style.setProperty("--inkbook-menu-line-width", `${String(widthPreview(value))}px`);
    return preview;
  }
  if (controlId === "outline-style") {
    preview.classList.add("inkbook-menu-line-preview");
    preview.append(createOutlineStylePreview(options.ownerDocument, value));
    return preview;
  }
  const iconId = choiceIconId(controlId, value);
  if (iconId === null) return null;
  preview.classList.add("inkbook-menu-option-icon");
  options.renderIcon(preview, iconId);
  return preview;
}

function choiceIconId(controlId: string, value: string): string | null {
  if (controlId === "text-alignment")
    return value === "justify" ? "align-justify" : `align-${value}`;
  if (controlId === "arrow-start-node")
    return arrowNodeIconId(value as Parameters<typeof arrowNodeIconId>[0], "start");
  if (controlId === "arrow-end-node")
    return arrowNodeIconId(value as Parameters<typeof arrowNodeIconId>[0], "end");
  if (controlId === "coordinate-dimension" && (value === "2d" || value === "3d"))
    return coordinateSystemIconId(value);
  if (controlId === "selection-area" && (value === "rectangle" || value === "lasso"))
    return selectionAreaIconId(value);
  return null;
}

function widthPreview(value: string): number {
  return WIDTH_PREVIEW_PIXELS[value] ?? Math.min(8, Math.max(1, Math.log2(Number(value))));
}
