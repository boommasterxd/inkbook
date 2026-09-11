import { afterEach, beforeEach, vi } from "vitest";

import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";

export function installDialogTestLifecycle(): void {
  beforeEach(() => {
    installObsidianDomHelpers();
    document.body.replaceChildren();
  });
  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    vi.restoreAllMocks();
  });
}

export function dialogButton(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  );
  if (found === undefined) throw new Error(`Missing button: ${label}`);
  return found;
}
