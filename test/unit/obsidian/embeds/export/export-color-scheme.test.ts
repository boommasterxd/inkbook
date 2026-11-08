// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { readExportColorScheme } from "../../../../../src/obsidian/embeds/export/export-color-scheme";
import { mountExportTargetScheme } from "../../../../fixtures/obsidian/markdown-export";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(["light", "dark"] as const)(
  "resolves a dual-scheme target against the %s browser preference",
  (scheme) => {
    const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    mountExportTargetScheme(root, "light dark");
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    vi.spyOn(preference, "matches", "get").mockReturnValue(scheme === "dark");
    const media = vi.spyOn(window, "matchMedia").mockReturnValue(preference);
    expect(readExportColorScheme(root)).toBe(scheme);
    expect(media).toHaveBeenCalledExactlyOnceWith("(prefers-color-scheme: dark)");
  },
);

it("uses portable light output for a windowless export document", () => {
  const target = document.implementation.createHTMLDocument("");
  const computed = vi.spyOn(window, "getComputedStyle");
  expect(target.defaultView).toBeNull();
  expect(readExportColorScheme(target.body)).toBe("light");
  expect(computed).not.toHaveBeenCalled();
});
