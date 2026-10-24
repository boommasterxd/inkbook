import { expect } from "vitest";

/** Returns only the lifecycle-owned static SVG's isolated document. */
export function lockedPreviewRoot(button: HTMLElement): Document {
  const shadow = button.firstElementChild?.shadowRoot;
  const document = shadow?.querySelector<HTMLIFrameElement>("iframe")?.contentDocument;
  if (document === null || document === undefined)
    throw new Error("Missing locked preview document.");
  return document;
}

export function expectLockedPreviewPath(button: HTMLElement, expectedPath: string) {
  expect(lockedPreviewRoot(button).querySelector("path")?.getAttribute("d")).toBe(expectedPath);
}
