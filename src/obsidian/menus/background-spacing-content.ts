import type { BackgroundSpacing } from "../../rendering/ui/flyout-types";
import { menuDomWindow } from "./menu-dom";

export interface BackgroundSpacingContentOptions {
  readonly ownerDocument: Document;
  readonly spacing: BackgroundSpacing;
  readonly onChange: (spacing: BackgroundSpacing) => void;
  readonly onPreview: (spacing: BackgroundSpacing) => void;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

const SPACINGS = ["s", "m", "l", "xl"] as const satisfies readonly BackgroundSpacing[];
const SPACING_LABELS = ["Compact", "Medium", "Wide", "Extra wide"] as const;
const SPACING_SHORT_LABELS = ["S", "M", "L", "XL"] as const;

export function createBackgroundSpacingContent(
  options: BackgroundSpacingContentOptions,
): DocumentFragment {
  const win = menuDomWindow(options.ownerDocument, "background menu");
  const fragment = win.createFragment();
  const root = win.createEl("section", { cls: "inkbook-menu-spacing-control" });
  // Obsidian's Menu cancels bubbling mouse downs, which suppresses the range input's native drag.
  root.addEventListener("mousedown", stopPropagation);
  root.addEventListener("click", stopPropagation);

  const header = win.createDiv({ cls: "inkbook-menu-spacing-header" });
  const icon = win.createSpan({ cls: "inkbook-menu-control-icon" });
  options.renderIcon(icon, "move-horizontal");
  const title = win.createSpan({ text: "Spacing" });
  const output = win.createEl("output", { cls: "inkbook-menu-spacing-output" });
  header.append(icon, title, output);

  const range = win.createEl("input", { cls: "inkbook-menu-spacing-slider" });
  range.type = "range";
  range.min = "0";
  range.max = "3";
  range.step = "1";
  range.value = String(SPACINGS.indexOf(options.spacing));
  range.setAttribute("aria-label", "Background spacing");

  const labels = win.createDiv({ cls: "inkbook-menu-spacing-labels" });
  for (const label of SPACING_SHORT_LABELS) {
    const tick = win.createSpan({ text: label });
    labels.append(tick);
  }

  const updateLocalValue = () => {
    const index = spacingIndex(range.valueAsNumber);
    output.textContent = SPACING_SHORT_LABELS[index];
    range.setAttribute("aria-valuetext", SPACING_LABELS[index]);
  };
  range.addEventListener("input", () => {
    const index = spacingIndex(range.valueAsNumber);
    updateLocalValue();
    options.onPreview(SPACINGS[index]);
  });
  range.addEventListener("change", () => {
    const index = spacingIndex(range.valueAsNumber);
    updateLocalValue();
    options.onChange(SPACINGS[index]);
  });
  updateLocalValue();
  const sliderRow = win.createDiv({ cls: "inkbook-menu-spacing-slider-row" });
  sliderRow.append(range);
  root.append(header, sliderRow, labels);
  fragment.append(root);
  return fragment;
}

function spacingIndex(value: number): 0 | 1 | 2 | 3 {
  return Math.min(3, Math.max(0, Math.round(value))) as 0 | 1 | 2 | 3;
}

function stopPropagation(event: Event): void {
  event.stopPropagation();
}
