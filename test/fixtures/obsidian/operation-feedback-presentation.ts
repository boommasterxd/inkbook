import { vi } from "vitest";

import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";

export function createOperationFeedbackPresentation(): HTMLElement {
  installObsidianDomHelpers();
  const root = document.body.createDiv({ cls: "inkbook-root" });
  root.dataset.inkbookMotion = "full";
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 100));
  return root;
}
