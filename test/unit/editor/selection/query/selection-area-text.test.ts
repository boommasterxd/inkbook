import { describe, expect, it } from "vitest";
import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import { prepareTextPaintGeometrySteps } from "../../../../../src/domain/geometry/text-paint-geometry";
import type { TextElementV2 } from "../../../../../src/domain/schema/public";
import {
  createLassoSelectionArea,
  createRectangleSelectionArea,
  elementMatchesSelectionAreaSteps,
  type SelectionArea,
  type SelectionAreaInclusion,
} from "../../../../../src/editor/selection/query/selection-area";
import { textElement } from "../../../domain/schema/fixtures";
import { finishGeometrySteps as complete } from "../../../../fixtures/domain/geometry-steps";

describe("text paint area selection", () => {
  it("ignores transparent box space and encloses all ink without enclosing the box", () => {
    const element = textElement();
    const blank = rectangle(170, 125, 190, 145);
    const text = rectangle(99, 99, 141, 121);

    expect(matches(blank, element, "touched")).toBe(false);
    expect(matches(text, element, "touched")).toBe(true);
    expect(matches(text, element, "fully-enclosed")).toBe(true);
    expect(matches(rectangle(99, 99, 120, 121), element, "fully-enclosed")).toBe(false);
  });

  it("tests visible paint against the lasso rather than its bounding rectangle", () => {
    const element = textElement();
    const blank = createLassoSelectionArea([
      { x: 155, y: 125 },
      { x: 195, y: 125 },
      { x: 175, y: 145 },
    ]);
    const ink = createLassoSelectionArea([
      { x: 95, y: 95 },
      { x: 145, y: 95 },
      { x: 145, y: 125 },
      { x: 95, y: 125 },
    ]);

    expect(matches(blank, element, "touched")).toBe(false);
    expect(matches(ink, element, "fully-enclosed")).toBe(true);
  });

  it("includes formula paint and actual table lines without filling transparent cells", () => {
    const source = "Hello $x$\n| A | B |\n| --- | --- |\n| C | D |";
    const element: TextElementV2 = {
      ...textElement(),
      height: 140,
      source,
      layout: {
        ...textElement().layout,
        math: [
          {
            start: 6,
            end: 9,
            display: false,
            x: 50,
            y: 25,
            width: 20,
            height: 20,
            paths: [{ d: "M0 0L20 20" }],
          },
        ],
        tables: [
          {
            start: 10,
            end: source.length,
            x: 0,
            y: 60,
            width: 100,
            height: 50,
            columns: 2,
            rowHeights: [25, 25],
            borderWidth: 1,
          },
        ],
      },
    };

    expect(matches(rectangle(155, 130, 165, 140), element, "touched")).toBe(true);
    expect(matches(rectangle(170, 155, 180, 158), element, "touched")).toBe(false);
    expect(matches(rectangle(148, 170, 152, 175), element, "touched")).toBe(true);
    expect(matches(rectangle(110, 165, 120, 175), element, "touched")).toBe(false);
    expect(matches(rectangle(99, 99, 141, 121), element, "fully-enclosed")).toBe(false);
  });
});

describe("text background area selection", () => {
  it("includes a field background and excludes its rounded transparent corners", () => {
    const element = {
      ...textElement(),
      backgroundColor: { type: "rgba" as const, value: "#FF0000FF" as const },
      backgroundOpacity: 0.5,
      layout: { version: 1 as const, lines: [] },
    };

    expect(matches(rectangle(170, 125, 190, 145), element, "touched")).toBe(true);
    expect(matches(rectangle(99.5, 99.5, 100.1, 100.1), element, "touched")).toBe(false);
    expect(matches(rectangle(99, 99, 201, 151), element, "fully-enclosed")).toBe(true);
  });

  it("retains transparent background cutouts and separately painted whitespace", () => {
    const base = textElement();
    const cutout: TextElementV2 = {
      ...base,
      backgroundColor: { type: "rgba", value: "#FF0000FF" },
      backgroundOpacity: 1,
      ranges: [{ start: 0, end: 5, style: { opacity: 0, backgroundColor: null } }],
      layout: {
        ...base.layout,
        lines: [
          {
            ...base.layout.lines[0]!,
            runs: [
              { ...base.layout.lines[0]!.runs[0]!, style: { opacity: 0, backgroundColor: null } },
            ],
          },
        ],
      },
    };
    expect(matches(rectangle(110, 105, 120, 115), cutout, "touched")).toBe(false);
    expect(matches(rectangle(150, 105, 160, 115), cutout, "touched")).toBe(true);
    const highlightedSpace: TextElementV2 = {
      ...base,
      source: "     ",
      ranges: [
        {
          start: 0,
          end: 5,
          style: { backgroundColor: { type: "rgba", value: "#FFFF00FF" }, backgroundOpacity: 1 },
        },
      ],
      layout: {
        ...base.layout,
        lines: [
          {
            ...base.layout.lines[0]!,
            runs: [
              {
                ...base.layout.lines[0]!.runs[0]!,
                text: "     ",
                style: {
                  backgroundColor: { type: "rgba", value: "#FFFF00FF" },
                  backgroundOpacity: 1,
                },
              },
            ],
          },
        ],
      },
    };
    expect(matches(rectangle(110, 105, 120, 115), highlightedSpace, "touched")).toBe(true);
  });

  it("queries rotated local paint without reintroducing the rotated empty field", () => {
    const element = { ...textElement(), rotation: 90, pivot: { x: 100, y: 100 } };
    expect(matches(rectangle(81, 101, 99, 139), element, "touched")).toBe(true);
    expect(matches(rectangle(61, 165, 79, 185), element, "touched")).toBe(false);
    expect(matches(rectangle(79, 99, 101, 141), element, "fully-enclosed")).toBe(true);
  });

  it("does not select a field with no visible paint even when its box is enclosed", () => {
    const element = { ...textElement(), style: { ...textElement().style, opacity: 0 } };
    const area = rectangle(99, 99, 201, 151);
    expect(matches(area, element, "touched")).toBe(false);
    expect(matches(area, element, "fully-enclosed")).toBe(false);
  });
});

function rectangle(left: number, top: number, right: number, bottom: number): SelectionArea {
  return createRectangleSelectionArea({ x: left, y: top }, { x: right, y: bottom });
}

function matches(
  area: SelectionArea,
  element: TextElementV2,
  inclusion: SelectionAreaInclusion,
): boolean {
  return complete(
    elementMatchesSelectionAreaSteps(
      area,
      element,
      inclusion,
      calculateElementBounds(element),
      undefined,
      complete(prepareTextPaintGeometrySteps(element)),
    ),
  );
}
