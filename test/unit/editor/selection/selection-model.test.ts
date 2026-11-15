import { describe, expect, it } from "vitest";

import { selectElement } from "../../../../src/editor/selection/public";
import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import {
  createLassoSelectionArea,
  createRectangleSelectionArea,
} from "../../../../src/editor/selection/query/selection-area";
import { selectBySelectionAreaQuery } from "../../../fixtures/editor/selection-query";
import { imageElement } from "../../../fixtures/domain/images";
import { rectangle, stroke } from "../../domain/schema/fixtures";

describe("selection model", () => {
  it("replaces, preserves, and adds element selections", () => {
    const initial = new Set(["a", "b"]);
    expect(selectElement(initial, "a", "preserve-or-replace")).toBe(initial);
    expect([...selectElement(initial, "c", "replace")]).toEqual(["c"]);
    expect([...selectElement(initial, "c", "add")]).toEqual(["a", "b", "c"]);
  });

  it.each(["lasso", "rectangle"] as const)(
    "ignores locked elements in %s areas while preserving explicit additive selection",
    (kind) => {
      const image = { ...imageElement(), locked: true };
      const lockedShape = { ...rectangle(), locked: true };
      const lockedStroke = { ...stroke(2), locked: true };
      const writing = stroke(1);
      const elements = [image, lockedShape, lockedStroke, writing];
      const area =
        kind === "lasso"
          ? createLassoSelectionArea([
              { x: 0, y: 0 },
              { x: 400, y: 0 },
              { x: 400, y: 400 },
              { x: 0, y: 400 },
            ])
          : createRectangleSelectionArea({ x: 0, y: 0 }, { x: 400, y: 400 });
      const explicit = selectElement(new Set(), image.id, "replace");
      for (const inclusion of ["touched", "fully-enclosed"] as const) {
        const select = (additive: boolean) =>
          selectBySelectionAreaQuery(explicit, area, inclusion, additive, (_bounds, sink) => {
            for (const element of elements)
              sink.add(element.id, calculateElementBounds(element), element);
          });
        expect(select(false)).toEqual(new Set([writing.id]));
        expect(select(true)).toEqual(new Set([image.id, writing.id]));
      }
    },
  );
});
