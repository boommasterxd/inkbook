import {
  menuTranslator,
  updateMenuText,
  type MenuLocalizationOptions,
} from "./localized-menu-text";
import type { BackgroundSpacing } from "./editor-menu-types";
import { menuDomWindow } from "./menu-dom";

export interface BackgroundSpacingContentOptions extends MenuLocalizationOptions {
  readonly describedBy?: string;
  readonly ownerDocument: Document;
  readonly spacing: BackgroundSpacing;
  readonly onChange: (spacing: BackgroundSpacing) => void;
  readonly onPreview: (spacing: BackgroundSpacing) => void;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly registerUpdate?: (update: (spacing: BackgroundSpacing) => void) => void;
}

const SPACINGS = ["s", "m", "l", "xl"] as const satisfies readonly BackgroundSpacing[];
const SPACING_SHORT_LABELS = ["S", "M", "L", "XL"] as const;

export function createBackgroundSpacingContent(
  options: BackgroundSpacingContentOptions,
): DocumentFragment {
  const win = menuDomWindow(options.ownerDocument, "background menu");
  const fragment = win.createFragment();
  const root = win.createEl("section", { cls: "inkbook-menu-spacing-control" });

  const header = win.createDiv({ cls: "inkbook-menu-spacing-header" });
  const icon = win.createSpan({ cls: "inkbook-menu-control-icon" });
  options.renderIcon(icon, "move-horizontal");
  const title = win.createSpan();
  updateMenuText(options, () => {
    title.textContent = menuTranslator(options)("editor.background.spacing");
  });
  const output = win.createEl("output", { cls: "inkbook-menu-spacing-output" });
  header.append(icon, title, output);

  const range = win.createEl("input", { cls: "inkbook-menu-spacing-slider" });
  range.type = "range";
  range.min = "0";
  range.max = "3";
  range.step = "1";
  range.value = String(SPACINGS.indexOf(options.spacing));
  updateMenuText(options, () =>
    range.setAttribute("aria-label", menuTranslator(options)("editor.background.spacing-label")),
  );
  if (options.describedBy !== undefined)
    range.setAttribute("aria-describedby", options.describedBy);

  const labels = win.createDiv({ cls: "inkbook-menu-spacing-labels" });
  for (const label of SPACING_SHORT_LABELS) {
    const tick = win.createSpan({ text: label });
    labels.append(tick);
  }

  const updateLocalValue = () => {
    const index = spacingIndex(range.valueAsNumber);
    output.textContent = SPACING_SHORT_LABELS[index];
    range.setAttribute(
      "aria-valuetext",
      menuTranslator(options)(`editor.background.${SPACINGS[index]}`),
    );
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
  updateMenuText(options, updateLocalValue);
  options.registerUpdate?.((spacing) => {
    range.value = String(SPACINGS.indexOf(spacing));
    updateLocalValue();
  });
  const sliderRow = win.createDiv({ cls: "inkbook-menu-spacing-slider-row" });
  sliderRow.append(range);
  root.append(header, sliderRow, labels);
  fragment.append(root);
  return fragment;
}

function spacingIndex(value: number): 0 | 1 | 2 | 3 {
  return Math.min(3, Math.max(0, Math.round(value))) as 0 | 1 | 2 | 3;
}
