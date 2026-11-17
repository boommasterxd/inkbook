import { Localization } from "../../../../src/domain/localization";
// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { afterEach, beforeEach, expect, it } from "vitest";

import { renderPreviewFindings } from "../../../../src/obsidian/settings/import/import-review-findings";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);
afterEach(() => document.body.replaceChildren());

it("opens affected paths together and pages files independently of notes", () => {
  const container = document.body.createDiv();
  const disposers: Array<() => void> = [];
  const sources = Array.from({ length: 26 }, (_, index) => `file-${index}.svg`);
  const notes = Array.from({ length: 26 }, (_, index) => `note-${index}.md`);
  renderPreviewFindings(
    container,
    [{ category: "difference", message: "Brush difference", sources, notes }],
    {
      localization: new Localization(),
      mutate: (update) => update(),
      readMotion: () => "reduced",
      own: (dispose) => disposers.push(dispose),
    },
  );
  try {
    container.querySelector("button")!.click();
    expect(container.textContent).not.toContain(sources[0]);
    const origins = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("26 handwriting files · 26 notes"),
    );
    expect(origins).toBeDefined();
    origins!.click();
    expect(container.textContent).toContain(sources[0]);
    expect(container.textContent).toContain(notes[0]);
    container
      .querySelector<HTMLButtonElement>('[aria-label="Next page: Affected handwriting files"]')!
      .click();
    expect(container.textContent).toContain(sources[25]);
    expect(container.textContent).not.toContain(sources[0]);
    expect(container.textContent).toContain(notes[0]);
    expect(container.textContent).not.toContain(notes[25]);
  } finally {
    for (const dispose of disposers) dispose();
  }
});

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
      button("4 notes").click();
      button("4 notes").click();
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
