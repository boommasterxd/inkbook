// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";

import { createInkbookLockedPreview } from "../../../src/obsidian/embeds/locked-preview";
import { createHtmlElement, installObsidianDomHelpers } from "../../adapters/obsidian/dom";

afterEach(() => vi.restoreAllMocks());

it("coalesces hidden autosave previews without parsing or importing their SVG trees", async () => {
  installObsidianDomHelpers();
  vi.spyOn(window, "setTimeout").mockImplementation((callback) => {
    queueMicrotask(callback as () => void);
    return 1 as unknown as ReturnType<typeof window.setTimeout>;
  });
  const button = createHtmlElement("button");
  const safeSvg = `<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata>${'<path d="M0 0L1 1"/>'.repeat(10_000)}</svg>`;
  const parser = vi.spyOn(window.DOMParser.prototype, "parseFromString");
  const importer = vi.spyOn(document, "importNode");
  const descriptor = (revision: number) => ({
    safeSvg,
    aspectRatio: revision,
    contentIdentity: { revision, outputHash: "a".repeat(64) },
  });
  const preview = createInkbookLockedPreview(button, descriptor(1));
  const original = button.querySelector("svg");
  expect(parser).toHaveBeenCalledOnce();
  expect(importer).toHaveBeenCalledOnce();
  button.hidden = true;
  for (let revision = 2; revision <= 20; revision += 1) {
    preview.setDescriptor(descriptor(revision));
    preview.refresh();
  }
  expect(parser).toHaveBeenCalledOnce();
  expect(importer).toHaveBeenCalledOnce();
  expect(button.querySelector("svg")).toBe(original);
  await preview.ensureReady();
  button.hidden = false;
  preview.refresh();
  expect(parser).toHaveBeenCalledTimes(1);
  expect(importer).toHaveBeenCalledTimes(1);
  expect(button.querySelectorAll("path")).toHaveLength(10_000);
  expect(button.firstElementChild?.getAttribute("style")).toContain("20");
  const current = button.querySelector("svg");
  preview.refresh();
  preview.setDescriptor(descriptor(20));
  expect(button.querySelector("svg")).toBe(current);
  preview.dispose();
  preview.setDescriptor(descriptor(21));
  preview.refresh();
  expect(parser).toHaveBeenCalledTimes(1);
  expect(importer).toHaveBeenCalledTimes(1);
});
