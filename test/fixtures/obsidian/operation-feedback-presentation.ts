import { vi } from "vitest";

import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";

export function createOperationFeedbackPresentation(): HTMLElement {
  installObsidianDomHelpers();
  const root = document.body.createDiv({ cls: "inkbook-root" });
  root.dataset.inkbookMotion = "full";
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 100));
  return root;
}

export function createOperationFeedbackObservers(ownerWindow: Window) {
  const observeStyle = vi.fn();
  const disconnectStyle = vi.fn();
  const disconnectCanvas = vi.fn();
  const disconnectResize = vi.fn();
  let syncStyle = () => undefined;
  Object.assign(ownerWindow, {
    MutationObserver: class {
      readonly #callback: () => undefined;
      #style = false;
      public constructor(callback: () => undefined) {
        this.#callback = callback;
      }
      public observe = (element: Element, options: MutationObserverInit) => {
        observeStyle(element, options);
        if (options.attributeFilter?.includes("data-inkbook-scheme")) {
          this.#style = true;
          syncStyle = this.#callback;
        }
      };
      public disconnect = (): void => {
        if (this.#style) disconnectStyle();
        else disconnectCanvas();
      };
    },
    ResizeObserver: class {
      public observe = vi.fn();
      public unobserve = vi.fn();
      public disconnect = disconnectResize;
    },
  });
  return {
    observeStyle,
    disconnectStyle,
    disconnectCanvas,
    disconnectResize,
    syncStyle: () => syncStyle(),
  };
}
