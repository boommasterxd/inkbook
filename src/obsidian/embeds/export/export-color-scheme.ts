import type { InkbookColorScheme } from "../../theme/color-scheme";

/** The renderer's target may use a different scheme from the source editor. */
export function readExportColorScheme(root: HTMLElement): InkbookColorScheme {
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) return "light";
  const schemes = ownerWindow.getComputedStyle(root).colorScheme.split(/\s+/u);
  if (!schemes.includes("dark")) return "light";
  if (!schemes.includes("light")) return "dark";
  return ownerWindow.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
