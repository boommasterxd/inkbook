import { Localization } from "../../../../src/domain/localization";
// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { afterEach, beforeEach, expect, it } from "vitest";

import { renderPreviewFindings } from "../../../../src/obsidian/settings/import/import-review-findings";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);
afterEach(() => document.body.replaceChildren());

it("releases nested finding subscriptions on every page turn and all remaining ownership on disposal", () => {
  const container = document.body.createDiv();
  const subscriptions = new Set<() => void>();
  const disposers: Array<() => void> = [];
  renderPreviewFindings(
    container,
    Array.from({ length: 50 }, (_, index) => ({
      category: "warning" as const,
      message: `Source metadata warning ${index}`,
      sources: [],
      notes: Array.from({ length: 4 }, (_, note) => `notes/${index}-${note}.md`),
    })),
    {
      localization: new Localization(),
      mutate: (update) => update(),
      readMotion: () => "reduced",
      observeMotion: (listener) => {
        subscriptions.add(listener);
        return () => subscriptions.delete(listener);
      },
      own: (dispose) => disposers.push(dispose),
    },
  );
  const button = (name: string): HTMLButtonElement => {
    const match = [...container.querySelectorAll("button")].find(
      (element) =>
        element.querySelector(".inkbook-settings-tool-title")?.textContent === name ||
        element.getAttribute("aria-label") === name,
    );
    expect(match).toBeDefined();
    return match!;
  };
  const rootSubscriptions = new Set(subscriptions);
  try {
    button("Warnings (50)").click();
    const pageSubscriptions = subscriptions.size;
    expect(pageSubscriptions).toBeGreaterThan(rootSubscriptions.size);
    const repeatedOpen = (): void => {
      button("Affected notes (4)").click();
      button("Affected notes (4)").click();
      button("Warnings (50)").click();
      button("Warnings (50)").click();
      expect(subscriptions.size).toBe(pageSubscriptions);
    };
    repeatedOpen();
    for (const direction of ["Next", "Previous", "Next", "Previous"]) {
      const previous = new Set(subscriptions);
      button(`${direction} page: Warnings`).click();
      expect(subscriptions.size).toBe(pageSubscriptions);
      expect([...subscriptions].filter((listener) => previous.has(listener))).toEqual([
        ...rootSubscriptions,
      ]);
      expect(container.querySelectorAll('ul[aria-label="Warnings"] > li')).toHaveLength(25);
      repeatedOpen();
    }
  } finally {
    for (const dispose of disposers.splice(0)) dispose();
  }
  expect(subscriptions.size).toBe(0);
});
