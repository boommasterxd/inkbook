import { expect, it } from "vitest";
import { ToolbarResizeObservation } from "../../../../../../src/obsidian/embeds/active-editor/layout/toolbar-resize-observation";

it("uses legacy content rectangles and reacquires width after a hidden root", () => {
  const root = {} as HTMLElement;
  const observation = new ToolbarResizeObservation();
  const entries = (width: number) => [
    { target: root, contentRect: { width } } as unknown as ResizeObserverEntry,
  ];
  expect(observation.affectsToolbar(entries(700), root)).toBe(true);
  expect(observation.affectsToolbar(entries(700), root)).toBe(false);
  expect(observation.affectsToolbar(entries(0), root)).toBe(true);
  expect(observation.affectsToolbar(entries(700), root)).toBe(true);
});

it("retains the root width when the toolbar notification comes first in a mixed batch", () => {
  const root = {} as HTMLElement;
  const toolbar = {} as HTMLElement;
  const observation = new ToolbarResizeObservation();
  const entry = {
    target: root,
    contentBoxSize: [{ inlineSize: 700 }],
  } as unknown as ResizeObserverEntry;
  expect(
    observation.affectsToolbar(
      [{ target: toolbar } as unknown as ResizeObserverEntry, entry],
      root,
    ),
  ).toBe(true);
  expect(observation.affectsToolbar([entry], root)).toBe(false);
});
