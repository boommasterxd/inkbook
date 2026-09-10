import { vi } from "vitest";
import { Keymap } from "obsidian";

import {
  AdaptivePanelSession,
  type AdaptivePanelContentLifecycle,
} from "../../../src/obsidian/menus/adaptive-panel";
import { createHtmlElement } from "./dom";

export function createAdaptivePanelFixture(
  kind: "background" | "style",
  options: {
    readonly anchorRect?: DOMRect;
    readonly createContent?: (lifecycle: AdaptivePanelContentLifecycle) => DocumentFragment;
    readonly motion?: "full" | "reduced";
    readonly keyboard?: boolean;
    readonly onBack?: () => void;
  } = {},
) {
  const root = createHtmlElement("div");
  root.className = "inkbook-root";
  root.dataset.inkbookMotion = options.motion ?? "reduced";
  root.dataset.inkbookKeyboardNavigation = String(options.keyboard ?? false);
  const anchor = createHtmlElement("button");
  const canvas = createHtmlElement("div");
  const control = createHtmlElement("button");
  control.textContent = "First";
  root.append(anchor, canvas);
  document.body.append(root);
  const anchorFocus = vi.spyOn(anchor, "focus");
  const canvasFocus = vi.spyOn(canvas, "focus");
  anchor.getBoundingClientRect = () => options.anchorRect ?? new DOMRect(300, 100, 44, 44);
  const keymap = new Keymap() as Keymap & {
    readonly scopes: Array<{
      readonly handlers: Array<{
        readonly callback: (event: KeyboardEvent) => unknown;
        readonly key: string | null;
      }>;
    }>;
  };
  const onClosed = vi.fn();
  const session = new AdaptivePanelSession({
    anchor,
    canvasInputSurface: canvas,
    createContent:
      options.createContent ??
      (() => {
        const fragment = window.createFragment();
        fragment.append(control);
        return fragment;
      }),
    keymap,
    kind,
    label: kind === "style" ? "Style" : "Background",
    ...(options.onBack === undefined ? {} : { onBack: options.onBack }),
    onClosed,
    ownerDocument: document,
    ownerWindow: window,
    renderIcon: (element, icon) => element.setAttribute("data-icon", icon),
  });
  return { anchor, anchorFocus, canvas, canvasFocus, control, keymap, onClosed, session };
}
