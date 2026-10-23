import { describe, expect, it } from "vitest";

import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../../src/domain/settings/defaults";
import { createDragElement, createFreehandElement } from "../../../../../src/editor/tools/public";
import {
  createActiveEditorStyleControls,
  createSelectionStyleReplacement,
} from "../../../../../src/obsidian/embeds/active-editor/controller-styles";

const defaults = createBuiltInSettings().toolDefaults;
const paint = ["color", "width", "opacity"];
const outline = [...paint, "outline-style"];
const filled = [...outline, "fill-color", "fill-opacity"];
const capabilities = {
  draw: paint,
  highlighter: paint,
  "straight-highlighter": paint,
  line: outline,
  arrow: [...outline, "arrow-start-node", "arrow-end-node"],
  rectangle: filled,
  ellipse: filled,
  triangle: filled,
  octagon: filled,
  parallelogram: filled,
  diamond: filled,
  "coordinate-system": [...outline, "coordinate-dimension"],
  table: [...outline, "table-columns"],
};

function createElement(tool: keyof typeof capabilities, index: number): InkElementV1 {
  const identity = {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    createdAt: 0,
  };
  return tool === "draw" || tool === "highlighter"
    ? createFreehandElement({ identity, tool, samples: [10, 10, 0.5], defaults })
    : createDragElement({
        identity,
        tool,
        start: { x: 100, y: 100 },
        end: { x: 200, y: 200 },
        defaults,
      });
}

const fixtures = (Object.keys(capabilities) as (keyof typeof capabilities)[]).map(
  (tool, index) => ({
    tool,
    element: createElement(tool, index + 1),
    properties: capabilities[tool],
  }),
);

function semanticProperty(id: string): string {
  const aliases: Record<string, string> = {
    "outline-color": "color",
    "stroke-width": "width",
    "outline-width": "width",
    "outline-opacity": "opacity",
  };
  return aliases[id] ?? id;
}

function selectedProperties(selection: readonly InkElementV1[]): string[] {
  return createActiveEditorStyleControls({ defaults, selection, tool: "select" })
    .map(({ id }) => semanticProperty(id))
    .sort();
}

describe("maximum shared selection Style controls", () => {
  it("exposes the complete capability intersection for every ordered pair of tools", () => {
    for (const first of fixtures) {
      for (const second of fixtures) {
        const selection = [
          first.element,
          { ...second.element, id: "00000000-0000-4000-8000-000000000099" },
        ];
        const expected = first.properties.filter((property) =>
          second.properties.includes(property),
        );
        expect(selectedProperties(selection), `${first.tool} + ${second.tool}`).toEqual(
          expected.sort(),
        );
      }
    }
    expect(selectedProperties(fixtures.map(({ element }) => element))).toEqual([...paint].sort());
  });

  it("keeps mixed line styles editable across lines and arrows", () => {
    const line = fixtures.find(({ tool }) => tool === "line")!.element;
    const arrow = fixtures.find(({ tool }) => tool === "arrow")!.element;
    const dotted = createSelectionStyleReplacement([arrow], "outline-style", "dotted")!;
    const selection = [line, ...dotted.replacements];
    const controls = createActiveEditorStyleControls({ defaults, selection, tool: "select" });
    expect(controls.map(({ id }) => id)).toEqual([
      "outline-color",
      "outline-width",
      "outline-style",
      "outline-opacity",
    ]);
    expect(controls.find(({ id }) => id === "outline-style")).toMatchObject({
      mixed: true,
      value: null,
    });
    const changed = createSelectionStyleReplacement(selection, "outline-style", "dashed")!;
    for (const element of changed.replacements) {
      expect(element.style).toMatchObject({ outlineStyle: "dashed" });
    }
    expect(
      createActiveEditorStyleControls({
        defaults,
        selection: changed.replacements,
        tool: "select",
      }).find(({ id }) => id === "outline-style"),
    ).toMatchObject({ mixed: false, value: "dashed" });
  });
});
